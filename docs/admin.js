/* 管理模式：時段設定、指派/清空任何一格、成員管理、操作紀錄 */
(function () {
    "use strict";

    const VP = window.VP;
    const { state, t, esc } = VP;
    const $ = (sel, root = document) => root.querySelector(sel);

    let members = [];
    let log = [];

    const adminApi = (method, path, body) => VP.api(method, path, body, { admin: true });

    function setMode(on) {
        document.body.classList.toggle("is-admin", on);
        $("#adminBar").hidden = !on;
        VP.renderSchedule();
    }

    async function verifyAndEnter(key) {
        state.adminKey = key;
        await adminApi("GET", "/api/admin/check");
        VP.store.set("vp_admin_key", key);
        setMode(true);
        await refresh();
    }

    function exit() {
        state.adminKey = null;
        VP.store.del("vp_admin_key");
        setMode(false);
        if (state.week < 0) {
            state.week = 0;
            VP.reload();
        }
    }

    function openLogin() {
        const body = VP.openModal(`
            <h3>${esc(t("adminLoginTitle"))}</h3>
            <form class="form" id="adminForm">
                <label>${esc(t("adminKey"))}<input type="password" name="key" required autocomplete="off"></label>
                <p class="err" id="adminErr"></p>
                <div class="row"><button type="submit" class="btn gold">${esc(t("enter"))}</button></div>
            </form>`);
        $("#adminForm", body).addEventListener("submit", async (e) => {
            e.preventDefault();
            try {
                await verifyAndEnter(e.target.key.value);
                VP.closeModal();
            } catch (err) {
                state.adminKey = null;
                $("#adminErr", body).textContent = VP.errText(err);
            }
        });
    }

    async function refresh() {
        try {
            const [m, l] = await Promise.all([
                adminApi("GET", "/api/admin/members"),
                adminApi("GET", "/api/admin/log?limit=200"),
            ]);
            members = m.members;
            log = l.log;
        } catch (err) {
            if (err.code === "wrong_admin_key") exit();
            VP.toast(VP.errText(err), "bad");
        }
        renderPanel();
    }

    // ---------- 面板 ----------

    function settingsHtml() {
        const on = new Set(state.config?.hours || []);
        const boxes = [];
        for (let h = 0; h < 24; h += 1) {
            const vn = (h + 23) % 24;
            boxes.push(`<label><input type="checkbox" name="hour" value="${h}" ${on.has(h) ? "checked" : ""}>
                ${VP.pad(h)}:00 <small>${VP.pad(vn)}:00</small></label>`);
        }
        return `<h3>${esc(t("adminSettings"))}</h3>
            <form class="form" id="settingsForm">
                <p class="hint">${esc(t("adminSettingsHint"))}</p>
                <div class="hour-grid">${boxes.join("")}</div>
                <label>${esc(t("bookingDays"))}
                    <input type="number" name="bookingDays" min="1" max="62" value="${state.config?.bookingDays || 14}" style="max-width:120px"></label>
                <div class="row"><button type="submit" class="btn gold">${esc(t("save"))}</button></div>
            </form>`;
    }

    function membersHtml() {
        const rows = members.map((m) => {
            let status = t("statusOk");
            if (m.disabled) status = t("statusDisabled");
            else if (!m.has_password) status = t("statusNoPw");
            return `<tr>
                <td><span class="holder"><span class="dot" style="${VP.hueStyle(m.id)}"></span><span class="nm">${esc(m.nickname)}</span></span></td>
                <td>${m.hours}</td>
                <td>${m.done}</td>
                <td class="${m.disabled || !m.has_password ? "muted" : ""}">${esc(status)}</td>
                <td><div class="acts">
                    <button type="button" class="btn ghost small" data-m-rename="${m.id}">${esc(t("rename"))}</button>
                    <button type="button" class="btn ghost small" data-m-pw="${m.id}">${esc(t("resetPw"))}</button>
                    <button type="button" class="btn ${m.disabled ? "ghost" : "danger"} small" data-m-toggle="${m.id}">${esc(m.disabled ? t("enable") : t("disable"))}</button>
                </div></td>
            </tr>`;
        }).join("");
        return `<h3>${esc(t("adminMembers"))} (${members.length})</h3>
            <p class="hint muted" style="font-size:.78rem;margin:0 0 8px">${esc(t("addMemberHint"))}</p>
            <div class="row" style="margin-bottom:8px"><button type="button" class="btn small" id="addMember">${esc(t("addMember"))}</button></div>
            <div class="table-wrap"><table class="list">
                <thead><tr><th>${esc(t("colName"))}</th><th>${esc(t("colHours"))}</th><th>${esc(t("colDone"))}</th>
                    <th>${esc(t("colStatus"))}</th><th>${esc(t("colActions"))}</th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>`;
    }

    function logHtml() {
        const rows = log.map((row) => {
            const when = new Date((row.at + VP.TW) * 1000).toISOString().slice(5, 16).replace("T", " ");
            const actor = row.actor === "admin" ? t("actorAdmin") : (row.nickname || row.actor);
            const slot = row.slot_start ? VP.slotText(row.slot_start) : "";
            let detail = "";
            if (row.action === "assign" || row.action === "claim" || row.action === "unclaim") detail = row.nickname || "";
            if (row.action === "settings" || row.action === "member") {
                try {
                    const d = JSON.parse(row.detail || "{}");
                    if (d.hours) d.hours = d.hours.map((h) => `${VP.pad(h)}:00`).join(" ");
                    detail = [row.action === "member" ? row.nickname : "", Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(", ")]
                        .filter(Boolean).join(" — ");
                } catch { /* 舊資料格式不對就不顯示 */ }
            }
            return `<tr><td class="muted">${esc(when)}</td><td>${esc(actor)}</td><td>${esc(t(`act_${row.action}`))}</td>
                <td>${esc(slot)}</td><td>${esc(detail)}</td></tr>`;
        }).join("");
        return `<details><summary><h3 style="display:inline-block">${esc(t("adminLog"))}</h3></summary>
            <div class="table-wrap"><table class="list"><tbody>${rows}</tbody></table></div></details>`;
    }

    function renderPanel() {
        const panel = $("#adminPanel");
        if (!document.body.classList.contains("is-admin")) {
            panel.innerHTML = "";
            return;
        }
        panel.innerHTML = `<div class="panel-head"><h2>${esc(t("admin"))}</h2></div>
            ${settingsHtml()}${membersHtml()}${logHtml()}`;
    }

    // ---------- 動作 ----------

    async function run(promise, okText = t("assignedOk")) {
        try {
            await promise;
            VP.toast(okText, "good");
        } catch (err) {
            VP.toast(VP.errText(err), "bad");
        }
        await VP.reload();
        await refresh();
    }

    async function onPanelClick(e) {
        const el = e.target.closest("button");
        if (!el) return;
        const id = Number(el.dataset.mRename || el.dataset.mPw || el.dataset.mToggle);
        const member = members.find((m) => m.id === id);

        if (el.id === "addMember") {
            const nickname = prompt(t("promptNewMember"));
            if (nickname) await run(adminApi("POST", "/api/admin/members", { nickname }));
        } else if (el.dataset.mRename && member) {
            const nickname = prompt(t("promptRename"), member.nickname);
            if (nickname && nickname !== member.nickname) await run(adminApi("POST", `/api/admin/members/${id}`, { nickname }));
        } else if (el.dataset.mPw && member) {
            const password = prompt(t("promptResetPw", { name: member.nickname }));
            if (password) await run(adminApi("POST", `/api/admin/members/${id}`, { password }));
        } else if (el.dataset.mToggle && member) {
            if (!member.disabled && !confirm(t("confirmDisable", { name: member.nickname }))) return;
            await run(adminApi("POST", `/api/admin/members/${id}`, { disabled: !member.disabled }));
        }
    }

    async function onSettingsSubmit(e) {
        if (e.target.id !== "settingsForm") return;
        e.preventDefault();
        const form = e.target;
        const hours = [...form.querySelectorAll("input[name=hour]:checked")].map((i) => Number(i.value));
        const bookingDays = Number(form.bookingDays.value);
        await run(adminApi("PUT", "/api/admin/settings", { hours, bookingDays }), t("saved"));
    }

    function openAssign(start) {
        const slot = state.schedule?.slots.find((s) => s.start === start);
        const options = members
            .filter((m) => !m.disabled || m.id === slot?.member_id)
            .map((m) => `<option value="${m.id}" ${m.id === slot?.member_id ? "selected" : ""}>${esc(m.nickname)}</option>`)
            .join("");
        const body = VP.openModal(`
            <h3>${esc(t("assignTitle", { time: VP.slotText(start) }))}</h3>
            <form class="form" id="assignForm">
                <label>${esc(t("chooseMember"))}<select name="member">${options}</select></label>
                <div class="row">
                    <button type="button" class="btn danger" id="assignClear">${esc(t("clearSlot"))}</button>
                    <button type="submit" class="btn gold">${esc(t("assign"))}</button>
                </div>
            </form>`);
        $("#assignForm", body).addEventListener("submit", async (e) => {
            e.preventDefault();
            VP.closeModal();
            await run(adminApi("POST", "/api/admin/assign", { slot_start: start, member_id: Number(e.target.member.value) }));
        });
        $("#assignClear", body).addEventListener("click", async () => {
            VP.closeModal();
            await run(adminApi("POST", "/api/admin/assign", { slot_start: start, member_id: null }));
        });
    }

    async function init() {
        $("#adminEnter").addEventListener("click", () => {
            if (document.body.classList.contains("is-admin")) return;
            openLogin();
        });
        $("#adminExit").addEventListener("click", exit);
        $("#adminPanel").addEventListener("click", onPanelClick);
        $("#adminPanel").addEventListener("submit", onSettingsSubmit);

        if (state.adminKey) {
            try {
                await verifyAndEnter(state.adminKey);
            } catch {
                exit();
            }
        }
    }

    window.VPAdmin = { init, openAssign, renderPanel };
})();
