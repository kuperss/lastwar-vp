/* 副總統輪值表 — 前台主程式（不用建置工具，直接給 GitHub Pages） */
(function () {
    "use strict";

    // 網頁和 API 由同一個 Worker 提供（mahuvp.kupers.cc），所以用相對路徑；
    // 只有本機用 python 開前台（8792）時，API 在另一個埠的 wrangler dev
    const API = location.port === "8792" ? "http://127.0.0.1:8787" : "";
    const POLL_MS = 20000;
    const TW = 8 * 3600;
    const VN = 7 * 3600;

    // ---------- 瀏覽器儲存（無痕模式可能丟例外，一律包起來） ----------

    const store = {
        get(key) { try { return localStorage.getItem(key); } catch { return null; } },
        set(key, value) { try { localStorage.setItem(key, value); } catch { /* 忽略 */ } },
        del(key) { try { localStorage.removeItem(key); } catch { /* 忽略 */ } },
    };

    function readJSON(key) {
        try { return JSON.parse(store.get(key)); } catch { return null; }
    }

    // ---------- 狀態 ----------

    const state = {
        lang: pickLang(),
        token: store.get("vp_token"),
        me: readJSON("vp_me"),
        adminKey: store.get("vp_admin_key"),
        offset: 0,                 // 伺服器時間 − 本機時間（秒）
        config: null,
        view: store.get("vp_view") === "list" ? "list" : "week",
        week: 0,                   // 0 = 今天起 7 天，1 = 再下 7 天，-1 = 過去 7 天（只有管理員）
        onlyOpen: false,
        hours: new Set(),          // 排班表的時段篩選（空 = 全部）
        schedule: null,
        statsRange: store.get("vp_stats_range") || "next14",
        statsFrom: "",
        statsTo: "",
        statsHours: new Set(),
        stats: null,
        loadedAt: 0,
    };

    function pickLang() {
        const saved = store.get("vp_lang");
        if (saved && window.I18N[saved]) return saved;
        const nav = (navigator.language || "").toLowerCase();
        if (nav.startsWith("vi")) return "vi";
        if (nav.startsWith("zh")) return "zh";
        return "en";
    }

    // ---------- 小工具 ----------

    const $ = (sel, root = document) => root.querySelector(sel);

    function t(key, vars) {
        const dict = window.I18N[state.lang] || window.I18N.zh;
        let text = dict[key] ?? window.I18N.zh[key] ?? key;
        if (vars && typeof text === "string") {
            text = text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? ""));
        }
        return text;
    }

    function esc(value) {
        return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[ch]));
    }

    const now = () => Math.floor(Date.now() / 1000) + state.offset;

    const pad = (n) => String(n).padStart(2, "0");

    // UTC 秒數＋時區位移 → 'HH:MM'
    function hm(sec, offset) {
        const d = new Date((sec + offset) * 1000);
        return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }

    function dayOf(sec, offset) {
        return new Date((sec + offset) * 1000).toISOString().slice(0, 10);
    }

    function shiftDay(day, n) {
        const d = new Date(`${day}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
    }

    function dayLabel(day) {
        const d = new Date(`${day}T00:00:00Z`);
        return t("dayFormat", { m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: t("weekdays")[d.getUTCDay()] });
    }

    // 時間以哪個時區為主：中文、英文以台灣時間為主、越南時間為輔；越南文反過來
    const primaryOffset = () => (state.lang === "vi" ? VN : TW);
    const secondaryOffset = () => (state.lang === "vi" ? TW : VN);
    const tzName = (offset) => t(offset === TW ? "tzTW" : "tzVN");

    // 給提示訊息用的一格描述：「10/24（六） 12:00–13:00」（用主要時區）
    function slotText(start) {
        const off = primaryOffset();
        return `${dayLabel(dayOf(start, off))} ${hm(start, off)}–${hm(start + 3600, off)}`;
    }

    // 每個人固定一個色相（黃金角分散）；彩度、亮度由主題的 CSS 決定，深色淺色主題都好看
    function hueStyle(id) {
        return `--h:${Math.round((id * 137.508) % 360)}`;
    }

    // hour 是台灣時間的整點（資料和篩選都用它）；顯示時換成指定時區，預設是主要時區
    function hourChipLabel(hour, offset = primaryOffset()) {
        const h = (hour + (offset - TW) / 3600 + 24) % 24;
        return `${pad(h)}–${pad((h + 1) % 24)}`;
    }

    // ---------- API ----------

    class ApiError extends Error {
        constructor(code, extra = {}) {
            super(code);
            this.code = code;
            this.extra = extra;
        }
    }

    async function api(method, path, body, opts = {}) {
        const headers = {};
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const key = opts.admin ? state.adminKey : state.token;
        if (key) headers.Authorization = `Bearer ${key}`;

        let res;
        try {
            res = await fetch(API + path, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
        } catch {
            throw new ApiError("network");
        }

        let data = {};
        try { data = await res.json(); } catch { /* 空內容 */ }
        if (!res.ok) {
            const { error, ...extra } = data;
            throw new ApiError(error || "server", extra);
        }
        if (typeof data.now === "number") state.offset = data.now - Math.floor(Date.now() / 1000);
        return data;
    }

    function errText(err) {
        const code = err instanceof ApiError ? err.code : "server";
        const vars = { ...(err.extra || {}) };
        if (vars.retryAfter) vars.min = Math.max(1, Math.ceil(vars.retryAfter / 60));
        const key = `err_${code}`;
        const dict = window.I18N[state.lang] || window.I18N.zh;
        return dict[key] || window.I18N.zh[key] ? t(key, vars) : t("err_server");
    }

    // ---------- 提示、對話框 ----------

    let toastTimer = 0;
    function toast(text, kind = "") {
        const el = $("#toast");
        el.textContent = text;
        el.className = `toast ${kind}`;
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
    }

    function openModal(html) {
        $("#modalBody").innerHTML = html;
        $("#modal").hidden = false;
        const first = $("#modalBody input, #modalBody select");
        if (first) setTimeout(() => first.focus(), 30);
        return $("#modalBody");
    }

    function closeModal() {
        $("#modal").hidden = true;
        $("#modalBody").innerHTML = "";
    }

    // ---------- 日期範圍 ----------

    function today() {
        return state.config?.today || dayOf(now(), TW);
    }

    // 排班表一次看 7 天（從今天起算，不是週日到週六），用上一週／下一週切換
    function scheduleRange() {
        const from = shiftDay(today(), state.week * 7);
        return { from, to: shiftDay(from, 6) };
    }

    function weekBounds() {
        const bookingDays = state.config?.bookingDays || 14;
        return { min: isAdmin() ? -1 : 0, max: Math.max(0, Math.ceil(bookingDays / 7) - 1) };
    }

    function statsRange() {
        const d = today();
        const [y, m] = d.split("-").map(Number);
        const monthStart = (yy, mm) => `${yy}-${pad(mm)}-01`;
        switch (state.statsRange) {
            case "next7": return { from: d, to: shiftDay(d, 6) };
            case "past7": return { from: shiftDay(d, -7), to: shiftDay(d, -1) };
            case "past30": return { from: shiftDay(d, -30), to: shiftDay(d, -1) };
            case "thisMonth": {
                const next = m === 12 ? monthStart(y + 1, 1) : monthStart(y, m + 1);
                return { from: monthStart(y, m), to: shiftDay(next, -1) };
            }
            case "lastMonth": {
                const first = m === 1 ? monthStart(y - 1, 12) : monthStart(y, m - 1);
                return { from: first, to: shiftDay(monthStart(y, m), -1) };
            }
            case "all": {
                const from = state.config?.firstDay || d;
                return { from: from < d ? from : d, to: shiftDay(d, (state.config?.bookingDays || 14) - 1) };
            }
            case "custom": {
                if (state.statsFrom && state.statsTo && state.statsFrom <= state.statsTo) {
                    return { from: state.statsFrom, to: state.statsTo };
                }
                return { from: d, to: shiftDay(d, 13) };
            }
            default: return { from: d, to: shiftDay(d, 13) };
        }
    }

    // ---------- 讀資料 ----------

    async function loadConfig() {
        state.config = await api("GET", "/api/config");
    }

    async function loadSchedule() {
        const { from, to } = scheduleRange();
        state.schedule = await api("GET", `/api/schedule?from=${from}&to=${to}`);
        renderSchedule();
    }

    async function loadStats() {
        const { from, to } = statsRange();
        const hours = state.statsHours.size ? `&hours=${[...state.statsHours].join(",")}` : "";
        state.stats = await api("GET", `/api/stats?from=${from}&to=${to}${hours}`);
        renderStats();
    }

    let loading = null;
    async function reload() {
        if (loading) return loading;
        loading = (async () => {
            try {
                await loadConfig();
                await Promise.all([loadSchedule(), loadStats()]);
                state.loadedAt = Date.now();
            } catch (err) {
                toast(errText(err), "bad");
            } finally {
                loading = null;
            }
        })();
        return loading;
    }

    // ---------- 畫面：頂部 ----------

    function applyLang() {
        document.documentElement.lang = { zh: "zh-Hant", vi: "vi", en: "en" }[state.lang];
        document.title = t("title");
        document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
        document.querySelectorAll("[data-lang]").forEach((btn) => btn.classList.toggle("on", btn.dataset.lang === state.lang));
        renderWho();
        renderSchedule();
        renderStats();
        if (window.VPAdmin && isAdmin()) window.VPAdmin.renderPanel();
    }

    function renderWho() {
        const el = $("#who");
        if (state.me) {
            el.innerHTML = `<span class="dot" style="${hueStyle(state.me.id)}"></span>
                <span>${esc(t("hello"))}<span class="name">${esc(state.me.nickname)}</span></span>
                <button type="button" class="btn ghost small" id="logoutBtn">${esc(t("logout"))}</button>`;
        } else {
            el.innerHTML = `<button type="button" class="btn gold" id="loginBtn">${esc(t("login"))}</button>`;
        }
    }

    // ---------- 畫面：排班表 ----------

    function hourSetOf(slots) {
        return [...new Set(slots.map((s) => s.hour))].sort((a, b) => a - b);
    }

    function renderHourChips(container, hours, selected) {
        const all = `<button type="button" class="chip ${selected.size ? "" : "on"}" data-hour="all">${esc(t("allHours"))}</button>`;
        container.innerHTML = all + hours.map((h) =>
            `<button type="button" class="chip ${selected.has(h) ? "on" : ""}" data-hour="${h}">${hourChipLabel(h)}</button>`,
        ).join("");
    }

    function kpiHtml(label, value, cls = "", sub = "") {
        return `<div class="kpi ${cls}"><div class="label">${esc(label)}</div>
            <div class="value">${esc(value)}<small>${esc(t("hoursUnit"))}</small></div>
            ${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}</div>`;
    }

    function fillHtml(claimed, total) {
        const pct = total ? Math.round((claimed / total) * 100) : 0;
        return `<div class="fill"><div class="bar"><span style="width:${pct}%"></span></div>
            <span>${esc(t("fillRate", { pct }))}</span></div>`;
    }

    function isAdmin() {
        return document.body.classList.contains("is-admin");
    }

    // 一格現在是什麼狀態（清單和週檢視共用）
    function slotStatus(slot, n) {
        const end = slot.start + 3600;
        const ended = end <= n;
        const live = slot.start <= n && n < end;
        const mine = !!state.me && slot.member_id === state.me.id;
        const bookingDays = state.config?.bookingDays || 14;
        const within = Math.round((Date.parse(`${slot.day}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400000) < bookingDays;
        return {
            ended,
            live,
            mine,
            open: slot.member_id == null,
            claimable: slot.member_id == null && !ended && !live && slot.regular && within,
            cancellable: mine && !ended && !live,
        };
    }

    function slotHtml(slot, n) {
        const st = slotStatus(slot, n);
        const end = slot.start + 3600;
        const cls = ["slot"];
        if (st.ended) cls.push("past");
        if (st.live) cls.push("live");
        if (st.open) cls.push("open");
        if (st.mine) cls.push("mine");

        // 該時區的日期跟這一天（台灣日期）不同時，註明「前一天」
        const timeLine = (cls, off) => {
            const prev = dayOf(slot.start, off) !== slot.day ? ` (${esc(t("prevDay"))})` : "";
            return `<div class="${cls}"><span class="tz">${esc(tzName(off))}</span>${hm(slot.start, off)}–${hm(end, off)}${prev}</div>`;
        };
        const times = `<div class="times">${timeLine("time-main", primaryOffset())}${timeLine("time-sub", secondaryOffset())}</div>`;

        const badges = [];
        if (st.live) badges.push(`<span class="badge live">${esc(t("live"))}</span>`);
        if (!slot.regular) badges.push(`<span class="badge odd">${esc(t("irregular"))}</span>`);

        let main;
        if (!st.open) {
            main = `<span class="holder" title="${slot.by_admin ? esc(t("byAdmin")) : ""}">
                <span class="dot" style="${hueStyle(slot.member_id)}"></span>
                <span class="nm">${esc(slot.nickname)}</span></span>`;
            if (st.cancellable) {
                main += `<button type="button" class="btn ghost small" data-unclaim="${slot.start}">${esc(t("cancel"))}</button>`;
            }
        } else if (st.ended || st.live) {
            main = `<span class="empty-past">${esc(t("noOne"))}</span>`;
        } else {
            main = st.claimable
                ? `<button type="button" class="claim" data-claim="${slot.start}">${esc(t("claim"))}</button>`
                : `<span class="empty-past">${esc(t("notOpenYet"))}</span>`;
        }

        const adminBtn = isAdmin()
            ? `<button type="button" class="btn ghost small" data-assign="${slot.start}">${esc(t("assign"))}</button>`
            : "";

        return `<div class="${cls.join(" ")}">${times}<div class="state">${badges.join("")}${main}${adminBtn}</div></div>`;
    }

    // 週檢視的一格：整格就是按鈕，點了依狀態認領／取消／看詳情
    function cellHtml(slot, n) {
        if (!slot) return `<div class="cell blank"></div>`;
        const st = slotStatus(slot, n);
        const cls = ["cell"];
        if (st.ended) cls.push("past");
        if (st.live) cls.push("live");
        if (!slot.regular) cls.push("odd");

        const end = slot.start + 3600;
        const sec = secondaryOffset();
        const tip = `${slotText(slot.start)} · ${tzName(sec)} ${hm(slot.start, sec)}–${hm(end, sec)}`;
        let body;
        let style = "";
        if (!st.open) {
            cls.push("taken");
            if (st.mine) cls.push("mine");
            style = ` style="${hueStyle(slot.member_id)}"`;
            body = `<span class="nm">${esc(slot.nickname)}</span>`;
        } else if (st.claimable) {
            cls.push("open");
            body = "＋";
        } else {
            body = st.ended || st.live ? "—" : "·";
        }
        const title = st.open ? tip : `${slot.nickname} · ${tip}`;
        return `<button type="button" class="${cls.join(" ")}"${style} data-cell="${slot.start}" title="${esc(title)}">${body}</button>`;
    }

    // 排班區夠寬（電腦、手機橫拿）就一天一直欄（A），窄的時候一天一橫列（B）
    const WIDE_MIN = 520;
    let lastWide = null;

    function renderWeek(slots, n) {
        const { from } = scheduleRange();
        const days = Array.from({ length: 7 }, (_, i) => shiftDay(from, i));
        const hours = hourSetOf(slots);
        if (!hours.length) return `<div class="none">${esc(t("noSlots"))}</div>`;

        const byKey = new Map(slots.map((s) => [`${s.day}|${s.hour}`, s]));
        const d0 = today();
        const wide = $("#days").clientWidth >= WIDE_MIN;
        lastWide = wide;

        const dayHead = (day) => {
            const d = new Date(`${day}T00:00:00Z`);
            return { w: t("weekdays")[d.getUTCDay()], md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, dd: d.getUTCDate() };
        };
        const secHour = (h) => hourChipLabel(h, secondaryOffset());
        const secName = esc(tzName(secondaryOffset()));

        const html = [];
        if (wide) {
            html.push(`<div class="wk wide" style="grid-template-columns:56px repeat(7,minmax(0,1fr))"><div></div>`);
            for (const day of days) {
                const h = dayHead(day);
                html.push(`<div class="wk-hd ${day === d0 ? "today" : ""}">${esc(h.w)}<b>${h.dd}</b></div>`);
            }
            for (const hour of hours) {
                html.push(`<div class="wk-lbl"><b>${hourChipLabel(hour)}</b><span>${secName} ${secHour(hour)}</span></div>`);
                for (const day of days) html.push(cellHtml(byKey.get(`${day}|${hour}`), n));
            }
        } else {
            html.push(`<div class="wk" style="grid-template-columns:60px repeat(${hours.length},minmax(0,1fr))"><div></div>`);
            for (const hour of hours) {
                html.push(`<div class="wk-hd"><b class="tm">${hourChipLabel(hour)}</b>${secName} ${secHour(hour)}</div>`);
            }
            for (const day of days) {
                const h = dayHead(day);
                const tag = day === d0 ? ` · ${t("today")}` : "";
                html.push(`<div class="wk-lbl ${day === d0 ? "today" : ""}"><b>${h.md}</b><span>${esc(h.w + tag)}</span></div>`);
                for (const hour of hours) html.push(cellHtml(byKey.get(`${day}|${hour}`), n));
            }
        }
        html.push(`</div><p class="wk-legend">${esc(t("weekLegend"))}</p>`);
        return html.join("");
    }

    function renderList(slots, n) {
        const visible = slots
            .filter((s) => !state.hours.size || state.hours.has(s.hour))
            .filter((s) => !state.onlyOpen || s.member_id == null);
        const days = new Map();
        for (const slot of visible) {
            if (!days.has(slot.day)) days.set(slot.day, []);
            days.get(slot.day).push(slot);
        }
        if (!days.size) return `<div class="none">${esc(t("noSlots"))}</div>`;

        const d0 = today();
        const html = [];
        for (const [day, daySlots] of days) {
            const all = slots.filter((s) => s.day === day && (!state.hours.size || state.hours.has(s.hour)));
            const taken = all.filter((s) => s.member_id != null).length;
            let tag = "";
            if (day === d0) tag = `<span class="tag">${esc(t("today"))}</span>`;
            else if (day === shiftDay(d0, 1)) tag = `<span class="tag">${esc(t("tomorrow"))}</span>`;
            html.push(`<div class="day ${day === d0 ? "today" : ""}">
                <div class="day-head">${esc(dayLabel(day))}${tag}
                    <span class="count">${esc(t("dayCount", { claimed: taken, total: all.length }))}</span></div>
                ${daySlots.map((s) => slotHtml(s, n)).join("")}
            </div>`);
        }
        return html.join("");
    }

    function renderSchedule() {
        document.querySelectorAll("#viewSeg [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
        $("#listFilters").hidden = state.view !== "list";
        $("#onlyOpen").checked = state.onlyOpen;

        const { min, max } = weekBounds();
        $("#weekPrev").disabled = state.week <= min;
        $("#weekNext").disabled = state.week >= max;
        const { from, to } = scheduleRange();
        const md = (day) => { const d = new Date(`${day}T00:00:00Z`); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
        $("#weekTitle").textContent = `${md(from)} – ${md(to)}`;

        const data = state.schedule;
        if (!data) return;
        const n = now();
        const past = state.week < 0;

        // 數字卡：過去那週看全部；未來看還沒結束的格。清單模式才套用時段篩選
        const inView = state.view === "list"
            ? data.slots.filter((s) => !state.hours.size || state.hours.has(s.hour))
            : data.slots;
        const counted = past ? inView : inView.filter((s) => s.start + 3600 > n);
        const claimed = counted.filter((s) => s.member_id != null).length;
        const mine = state.me ? counted.filter((s) => s.member_id === state.me.id).length : 0;
        $("#kpis").innerHTML =
            kpiHtml(t("kpiClaimed"), `${claimed}/${counted.length}`, "done") +
            kpiHtml(past ? t("kpiUnfilled") : t("kpiOpen"), counted.length - claimed, "open") +
            kpiHtml(t("kpiMine"), mine) +
            fillHtml(claimed, counted.length);

        const label = past ? t("past7") : state.week === 0 ? t("weekThis") : t("weekNext");
        $("#weekSub").textContent = `${label} · ${t(past ? "kpiUnfilled" : "kpiOpen")} ${counted.length - claimed} ${t("hoursUnit")}`;

        // 主視覺那句話：「這 7 天還有 18 小時 沒人認領。」數字另外上色
        const openHours = counted.length - claimed;
        $("#heroOpen").innerHTML = openHours
            ? t("heroOpen").split("{n}").map(esc).join(`<b>${openHours} ${esc(t("hoursUnit"))}</b>`)
            : esc(t("heroFull"));

        if (state.view === "list") {
            renderHourChips($("#hourChips"), hourSetOf(data.slots), state.hours);
            $("#days").innerHTML = renderList(data.slots, n);
        } else {
            $("#days").innerHTML = renderWeek(data.slots, n);
        }
    }

    function showDetail(slot) {
        const st = slotStatus(slot, now());
        const end = slot.start + 3600;
        const status = st.open
            ? esc(st.ended || st.live ? t("noOne") : t("notOpenYet"))
            : `<span class="holder"><span class="dot" style="${hueStyle(slot.member_id)}"></span><span class="nm">${esc(slot.nickname)}</span></span>`;
        const notes = [];
        if (st.live) notes.push(t("live"));
        if (!slot.regular) notes.push(t("irregular"));
        if (slot.by_admin) notes.push(t("byAdmin"));
        const body = openModal(`
            <h3>${esc(slotText(slot.start))}</h3>
            <div class="detail">
                ${[primaryOffset(), secondaryOffset()].map((off) => `<div class="line"><span>${esc(tzName(off))}</span><span>${hm(slot.start, off)}–${hm(end, off)}</span></div>`).join("")}
                <div class="line"><span>VP</span><span>${status}</span></div>
                ${notes.length ? `<div class="muted">${esc(notes.join(" · "))}</div>` : ""}
                ${st.cancellable ? `<div class="row"><button type="button" class="btn danger" id="detailCancel">${esc(t("cancel"))}</button></div>` : ""}
            </div>`);
        const cancel = $("#detailCancel", body);
        if (cancel) cancel.addEventListener("click", () => { closeModal(); unclaim(slot.start); });
    }

    function onCell(start) {
        const slot = state.schedule?.slots.find((s) => s.start === start);
        if (!slot) return;
        if (isAdmin() && window.VPAdmin) {
            window.VPAdmin.openAssign(start);
            return;
        }
        const st = slotStatus(slot, now());
        if (st.claimable) claim(start);
        else if (st.cancellable) unclaim(start);
        else showDetail(slot);
    }

    // ---------- 畫面：統計 ----------

    function renderStats() {
        $("#statsRange").value = state.statsRange;
        $("#customRange").hidden = state.statsRange !== "custom";

        const data = state.stats;
        if (!data) return;

        const hours = state.config?.hours || [];
        const known = [...new Set([...hours, ...(state.schedule ? hourSetOf(state.schedule.slots) : []), ...state.statsHours])].sort((a, b) => a - b);
        renderHourChips($("#statsHourChips"), known, state.statsHours);

        $("#statsNote").textContent = t("rangeNote", { from: data.from, to: data.to });

        // 範圍跨過現在時：主數字是未來的空缺，過去沒人當的放在下面小字
        let openKpi;
        if (data.openPast === 0) openKpi = kpiHtml(t("kpiOpen"), data.openFuture, "open");
        else if (data.openFuture === 0) openKpi = kpiHtml(t("kpiUnfilled"), data.openPast, "open");
        else openKpi = kpiHtml(t("kpiOpen"), data.openFuture, "open", `${t("kpiUnfilled")} ${data.openPast} ${t("hoursUnit")}`);

        $("#statsKpis").innerHTML =
            kpiHtml(t("kpiTotal"), data.totalSlots) +
            kpiHtml(t("kpiClaimed"), data.claimedSlots, "done") +
            openKpi +
            fillHtml(data.claimedSlots, data.totalSlots);

        if (!data.members.length) {
            $("#statsTable").innerHTML = `<div class="none">${esc(t("noClaims"))}</div>`;
            return;
        }

        const max = data.members[0].hours || 1;
        $("#statsTable").innerHTML = `<div class="rank">${data.members.map((m, i) => {
            const parts = [];
            if (m.done) parts.push(t("statsDone", { n: m.done }));
            if (m.upcoming) parts.push(t("statsUpcoming", { n: m.upcoming }));
            const me = state.me && state.me.id === m.id ? "me" : "";
            return `<div class="rank-row ${me}">
                <span class="no">${i + 1}</span>
                <span class="holder"><span class="dot" style="${hueStyle(m.id)}"></span><span class="nm">${esc(m.nickname)}</span></span>
                <span class="hrs">${m.hours}<small>${esc(t("hoursUnit"))}</small></span>
                <div class="split"><div class="bar"><span style="width:${Math.round((m.hours / max) * 100)}%"></span></div>
                    <span>${esc(parts.join(" · "))}</span></div>
            </div>`;
        }).join("")}</div>`;
    }

    // ---------- 登入、註冊 ----------

    let afterLogin = null;

    function openAuth(mode = "login", then = null) {
        afterLogin = then;
        const isReg = mode === "register";
        const body = openModal(`
            <div class="tabs">
                <button type="button" class="btn ${isReg ? "ghost" : ""}" data-auth-tab="login">${esc(t("tabLogin"))}</button>
                <button type="button" class="btn ${isReg ? "" : "ghost"}" data-auth-tab="register">${esc(t("tabRegister"))}</button>
            </div>
            <form class="form" id="authForm" autocomplete="on">
                <p class="hint">${esc(isReg ? t("registerHint") : t("loginHint"))}</p>
                ${isReg ? `<label>${esc(t("nickname"))}<input type="text" name="nickname" maxlength="16" required autocomplete="nickname"></label>` : ""}
                <label>${esc(t("password"))}<input type="password" name="password" minlength="${isReg ? 8 : 1}" required autocomplete="${isReg ? "new-password" : "current-password"}"></label>
                ${isReg ? `<label>${esc(t("passwordConfirm"))}<input type="password" name="password2" required autocomplete="new-password"></label>` : ""}
                <label class="switch"><input type="checkbox" id="showPw"><span>${esc(t("showPassword"))}</span></label>
                <p class="err" id="authErr"></p>
                <div class="row"><button type="submit" class="btn gold">${esc(isReg ? t("submitRegister") : t("submitLogin"))}</button></div>
            </form>`);

        body.querySelectorAll("[data-auth-tab]").forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.authTab, afterLogin)));
        $("#showPw", body).addEventListener("change", (e) => {
            body.querySelectorAll("input[name^=password]").forEach((i) => { i.type = e.target.checked ? "text" : "password"; });
        });

        $("#authForm", body).addEventListener("submit", async (e) => {
            e.preventDefault();
            const form = e.target;
            const err = $("#authErr", body);
            const submit = form.querySelector("button[type=submit]");
            err.textContent = "";

            const password = form.password.value;
            if (isReg) {
                if (password.length < 8) { err.textContent = t("err_password_too_short"); return; }
                if (password !== form.password2.value) { err.textContent = t("pwMismatch"); return; }
            }

            submit.disabled = true;
            try {
                const data = isReg
                    ? await api("POST", "/api/register", { nickname: form.nickname.value, password })
                    : await api("POST", "/api/login", { password });
                setSession(data.token, data.member);
                closeModal();
                toast(t("welcome", { name: data.member.nickname }), "good");
                const next = afterLogin;
                afterLogin = null;
                if (next) await next();
                else await reload();
            } catch (ex) {
                err.textContent = errText(ex);
            } finally {
                submit.disabled = false;
            }
        });
    }

    function setSession(token, member) {
        state.token = token;
        state.me = member;
        if (token) {
            store.set("vp_token", token);
            store.set("vp_me", JSON.stringify(member));
        } else {
            store.del("vp_token");
            store.del("vp_me");
        }
        renderWho();
        renderSchedule();
        renderStats();
    }

    async function logout() {
        try { await api("POST", "/api/logout"); } catch { /* 伺服器沒回應也照樣登出 */ }
        setSession(null, null);
    }

    async function verifySession() {
        if (!state.token) return;
        try {
            const data = await api("GET", "/api/me");
            state.me = data.member;
            store.set("vp_me", JSON.stringify(data.member));
            renderWho();
        } catch (err) {
            if (err.code === "login_required") setSession(null, null);
        }
    }

    // ---------- 認領、取消 ----------

    async function claim(start) {
        if (!state.me) {
            openAuth("login", () => claim(start));
            return;
        }
        try {
            await api("POST", "/api/claim", { slot_start: start });
            toast(t("claimedOk", { time: slotText(start) }), "good");
        } catch (err) {
            if (err.code === "login_required") {
                setSession(null, null);
                openAuth("login", () => claim(start));
                return;
            }
            toast(errText(err), "bad");
        }
        await reload();
    }

    async function unclaim(start) {
        if (!confirm(t("confirmCancel", { time: slotText(start) }))) return;
        try {
            await api("POST", "/api/unclaim", { slot_start: start });
            toast(t("cancelledOk", { time: slotText(start) }), "good");
        } catch (err) {
            toast(errText(err), "bad");
        }
        await reload();
    }

    // ---------- 事件 ----------

    function toggleHour(set, value) {
        if (value === "all") set.clear();
        else {
            const h = Number(value);
            if (set.has(h)) set.delete(h);
            else set.add(h);
        }
    }

    function bind() {
        document.addEventListener("click", (e) => {
            const el = e.target.closest("button");
            if (!el) return;

            if (el.dataset.lang) {
                state.lang = el.dataset.lang;
                store.set("vp_lang", state.lang);
                applyLang();
            } else if (el.id === "loginBtn") {
                openAuth("login");
            } else if (el.id === "logoutBtn") {
                logout();
            } else if (el.dataset.claim) {
                claim(Number(el.dataset.claim));
            } else if (el.dataset.unclaim) {
                unclaim(Number(el.dataset.unclaim));
            } else if (el.dataset.assign && window.VPAdmin) {
                window.VPAdmin.openAssign(Number(el.dataset.assign));
            } else if (el.dataset.cell) {
                onCell(Number(el.dataset.cell));
            } else if (el.dataset.view) {
                state.view = el.dataset.view;
                store.set("vp_view", state.view);
                renderSchedule();
            } else if (el.id === "weekPrev" || el.id === "weekNext") {
                const { min, max } = weekBounds();
                state.week = Math.min(max, Math.max(min, state.week + (el.id === "weekNext" ? 1 : -1)));
                loadSchedule().catch((err) => toast(errText(err), "bad"));
            } else if (el.dataset.hour && el.closest("#hourChips")) {
                toggleHour(state.hours, el.dataset.hour);
                renderSchedule();
            } else if (el.dataset.hour && el.closest("#statsHourChips")) {
                toggleHour(state.statsHours, el.dataset.hour);
                loadStats().catch((err) => toast(errText(err), "bad"));
            } else if (el.id === "modalClose") {
                closeModal();
            }
        });

        $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });

        $("#onlyOpen").addEventListener("change", (e) => {
            state.onlyOpen = e.target.checked;
            renderSchedule();
        });

        $("#statsRange").addEventListener("change", (e) => {
            state.statsRange = e.target.value;
            store.set("vp_stats_range", state.statsRange);
            if (state.statsRange === "custom" && !state.statsFrom) {
                const r = statsRange();
                state.statsFrom = r.from;
                state.statsTo = r.to;
                $("#statsFrom").value = r.from;
                $("#statsTo").value = r.to;
            }
            loadStats().catch((err) => toast(errText(err), "bad"));
        });

        for (const id of ["statsFrom", "statsTo"]) {
            $(`#${id}`).addEventListener("change", () => {
                state.statsFrom = $("#statsFrom").value;
                state.statsTo = $("#statsTo").value;
                if (state.statsFrom && state.statsTo && state.statsFrom <= state.statsTo) {
                    loadStats().catch((err) => toast(errText(err), "bad"));
                }
            });
        }

        // 手機轉向、視窗拉寬拉窄時，跨過門檻才重畫週檢視（A／B 互換）
        if (window.ResizeObserver) {
            new ResizeObserver(() => {
                if (state.view !== "week" || lastWide === null) return;
                if (($("#days").clientWidth >= WIDE_MIN) !== lastWide) renderSchedule();
            }).observe($("#days"));
        }

        // 開著就每 20 秒更新；切回這個分頁時立刻更新
        setInterval(() => { if (!document.hidden) reload(); }, POLL_MS);
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden && Date.now() - state.loadedAt > 3000) reload();
        });
    }

    // 給 admin.js 用
    window.VP = {
        state, api, t, esc, toast, openModal, closeModal, reload, errText,
        slotText, hm, dayOf, hueStyle, TW, VN, pad, applyLang, renderSchedule, store,
    };

    async function start() {
        bind();
        applyLang();
        await Promise.all([verifySession(), reload()]);
        if (window.VPAdmin) window.VPAdmin.init();
    }

    start();
})();
