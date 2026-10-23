/**
 * 副總統輪值排班表 — API
 *
 * 公開（不用登入）：
 *   GET  /api/config                      目前時段、可預約天數、伺服器時間
 *   GET  /api/schedule?from=&to=          這段期間每一格與認領人
 *   GET  /api/stats?from=&to=&hours=      每人小時數、空缺
 * 盟友（Authorization: Bearer <登入憑證>）：
 *   POST /api/register {nickname, password}
 *   POST /api/login    {password}
 *   POST /api/logout
 *   GET  /api/me
 *   POST /api/claim    {slot_start}
 *   POST /api/unclaim  {slot_start}
 * 管理員（Authorization: Bearer <ADMIN_KEY>）：
 *   GET  /api/admin/check
 *   PUT  /api/admin/settings {hours, bookingDays}
 *   POST /api/admin/assign   {slot_start, member_id | null}
 *   GET  /api/admin/members
 *   POST /api/admin/members         {nickname}           代建成員（還沒有密碼）
 *   POST /api/admin/members/:id     {nickname?, password?, disabled?}
 *   GET  /api/admin/log?limit=
 *
 * 錯誤一律回 { error: "<代碼>" }，前台依代碼顯示三種語言的訊息。
 */

import {
  isClaimable,
  isDay,
  isOnTheHour,
  isRegularSlot,
  hoursForDay,
  normalizeHours,
  regularSlots,
  shiftDay,
  slotStart,
  sortRules,
  twDay,
  twHour,
  dayDiff,
  SLOT_SEC,
} from "./slots.js";

const SESSION_DAYS = 180;
const FAIL_WINDOW_SEC = 600;
const FAIL_LIMIT = 10;
const MAX_SCHEDULE_DAYS = 62;
const MAX_STATS_DAYS = 3700;
const NICKNAME_MAX = 16;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 64;

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ---------- CORS / 回應 ----------

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (origin && allowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function json(body, request, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
    },
  });
}

async function readBody(request) {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {
    // 落到下面
  }
  throw new HttpError(400, "bad_request");
}

// ---------- 雜湊 ----------

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pepper(env) {
  if (!env.PW_PEPPER) throw new HttpError(500, "server_not_configured");
  return env.PW_PEPPER;
}

const passwordHash = (env, password) => hmacHex(pepper(env), `pw|${password}`);

// ---------- 猜密碼限制 ----------

async function ipHash(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  return (await hmacHex(pepper(env), `ip|${ip}`)).slice(0, 32);
}

async function assertNotLocked(env, hash) {
  const window = Math.floor(nowSec() / FAIL_WINDOW_SEC) * FAIL_WINDOW_SEC;
  const row = await env.DB.prepare(
    "SELECT count FROM login_fail WHERE ip_hash = ? AND window_start = ?",
  )
    .bind(hash, window)
    .first();
  if (row && row.count >= FAIL_LIMIT) {
    throw new HttpError(429, "too_many_attempts", { retryAfter: window + FAIL_WINDOW_SEC - nowSec() });
  }
}

async function recordFail(env, hash) {
  const window = Math.floor(nowSec() / FAIL_WINDOW_SEC) * FAIL_WINDOW_SEC;
  await env.DB.prepare(
    `INSERT INTO login_fail (ip_hash, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(ip_hash, window_start) DO UPDATE SET count = count + 1`,
  )
    .bind(hash, window)
    .run();
}

// ---------- 身分 ----------

function bearer(request) {
  const auth = request.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

async function currentMember(request, env) {
  const token = bearer(request);
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const now = nowSec();
  const row = await env.DB.prepare(
    `SELECT m.id, m.nickname, s.last_seen
     FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.token_hash = ? AND m.disabled = 0 AND s.last_seen > ?`,
  )
    .bind(tokenHash, now - SESSION_DAYS * 86400)
    .first();
  if (!row) return null;

  // 一天最多更新一次，免得每次輪詢都寫資料庫
  if (now - row.last_seen > 86400) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").bind(now, tokenHash).run();
  }

  return { id: row.id, nickname: row.nickname };
}

async function requireMember(request, env) {
  const member = await currentMember(request, env);
  if (!member) throw new HttpError(401, "login_required");
  return member;
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_KEY) throw new HttpError(500, "server_not_configured");
  const hash = await ipHash(request, env);
  await assertNotLocked(env, hash);
  if (bearer(request) !== env.ADMIN_KEY) {
    await recordFail(env, hash);
    throw new HttpError(401, "wrong_admin_key");
  }
}

async function createSession(env, memberId) {
  const token = randomToken();
  const now = nowSec();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, member_id, created_at, last_seen) VALUES (?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), memberId, now, now)
    .run();
  return token;
}

function cleanNickname(value) {
  if (typeof value !== "string") throw new HttpError(400, "nickname_invalid");
  const nickname = value.trim().replace(/\s+/g, " ");
  const length = [...nickname].length;
  // 擋掉控制字元，避免畫面被奇怪字元弄亂
  if (length < 1 || length > NICKNAME_MAX || /[\u0000-\u001f\u007f]/.test(nickname)) {
    throw new HttpError(400, "nickname_invalid");
  }
  return nickname;
}

function checkPassword(value) {
  if (typeof value !== "string" || value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    throw new HttpError(400, "password_too_short");
  }
  return value;
}

// ---------- 設定 ----------

async function loadRules(env) {
  const { results } = await env.DB.prepare("SELECT effective_from, hours FROM slot_rules").all();
  return sortRules(results.map((row) => ({ effective_from: row.effective_from, hours: JSON.parse(row.hours) })));
}

async function loadBookingDays(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'booking_days'").first();
  const days = Number(row?.value);
  return Number.isInteger(days) && days > 0 ? days : 14;
}

async function audit(env, actor, action, slot, memberId, detail) {
  await env.DB.prepare(
    "INSERT INTO audit_log (at, actor, action, slot_start, member_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(nowSec(), actor, action, slot ?? null, memberId ?? null, detail ? JSON.stringify(detail) : null)
    .run();
}

function readRange(url, maxDays) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isDay(from) || !isDay(to) || to < from || dayDiff(from, to) >= maxDays) {
    throw new HttpError(400, "bad_range");
  }
  return { from, to };
}

// 這段期間（台灣日期 from～to，含）裡的認領
async function claimsBetween(env, from, to) {
  const { results } = await env.DB.prepare(
    `SELECT c.slot_start, c.member_id, c.by_admin, m.nickname
     FROM claims c JOIN members m ON m.id = c.member_id
     WHERE c.slot_start >= ? AND c.slot_start < ?
     ORDER BY c.slot_start`,
  )
    .bind(slotStart(from, 0), slotStart(shiftDay(to, 1), 0))
    .all();
  return results;
}

// 常規時段＋落在常規時段外的認領（管理員指派、或改時段前就認領的）
function mergeSlots(rules, from, to, claims) {
  const byStart = new Map();
  for (const slot of regularSlots(rules, from, to)) {
    byStart.set(slot.start, { ...slot, regular: true, member_id: null, nickname: null });
  }
  for (const claim of claims) {
    const slot = byStart.get(claim.slot_start) ?? {
      start: claim.slot_start,
      day: twDay(claim.slot_start),
      hour: twHour(claim.slot_start),
      regular: false,
    };
    byStart.set(claim.slot_start, {
      ...slot,
      member_id: claim.member_id,
      nickname: claim.nickname,
      by_admin: claim.by_admin === 1,
    });
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

// ---------- 公開 ----------

async function handleConfig(request, env) {
  const [rules, bookingDays] = await Promise.all([loadRules(env), loadBookingDays(env)]);
  const now = nowSec();
  const today = twDay(now);
  return json(
    {
      now,
      today,
      hours: hoursForDay(rules, today),
      bookingDays,
      firstDay: rules[0]?.effective_from ?? today,
    },
    request,
    env,
  );
}

async function handleSchedule(request, env) {
  const { from, to } = readRange(new URL(request.url), MAX_SCHEDULE_DAYS);
  const [rules, claims] = await Promise.all([loadRules(env), claimsBetween(env, from, to)]);
  return json({ now: nowSec(), from, to, slots: mergeSlots(rules, from, to, claims) }, request, env);
}

async function handleStats(request, env) {
  const url = new URL(request.url);
  const { from, to } = readRange(url, MAX_STATS_DAYS);

  const hoursParam = url.searchParams.get("hours");
  const hourFilter = hoursParam
    ? new Set(hoursParam.split(",").map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))
    : null;

  const [rules, claims] = await Promise.all([loadRules(env), claimsBetween(env, from, to)]);
  const now = nowSec();
  const slots = mergeSlots(rules, from, to, claims).filter((slot) => !hourFilter || hourFilter.has(slot.hour));

  const members = new Map();
  let claimedSlots = 0;
  let openPast = 0;
  let openFuture = 0;

  for (const slot of slots) {
    const ended = slot.start + SLOT_SEC <= now;
    if (slot.member_id == null) {
      if (ended) openPast += 1;
      else openFuture += 1;
      continue;
    }
    claimedSlots += 1;
    if (!members.has(slot.member_id)) {
      members.set(slot.member_id, { id: slot.member_id, nickname: slot.nickname, hours: 0, done: 0, upcoming: 0 });
    }
    const entry = members.get(slot.member_id);
    entry.hours += 1;
    if (ended) entry.done += 1;
    else entry.upcoming += 1;
  }

  return json(
    {
      now,
      from,
      to,
      totalSlots: slots.length,
      claimedSlots,
      openPast,
      openFuture,
      members: [...members.values()].sort((a, b) => b.hours - a.hours || a.nickname.localeCompare(b.nickname)),
    },
    request,
    env,
  );
}

// ---------- 盟友 ----------

async function handleRegister(request, env) {
  const body = await readBody(request);
  const nickname = cleanNickname(body.nickname);
  const password = checkPassword(body.password);

  const ip = await ipHash(request, env);
  await assertNotLocked(env, ip);

  const hash = await passwordHash(env, password);
  const samePassword = await env.DB.prepare("SELECT 1 FROM members WHERE pw_hash = ?").bind(hash).first();
  if (samePassword) {
    // 不說「已被使用」，而且算一次失敗 —— 不然註冊就成了猜別人密碼的捷徑
    await recordFail(env, ip);
    throw new HttpError(409, "password_unusable");
  }

  const sameName = await env.DB.prepare("SELECT 1 FROM members WHERE nickname = ?").bind(nickname).first();
  if (sameName) throw new HttpError(409, "nickname_taken");

  let inserted;
  try {
    inserted = await env.DB.prepare(
      "INSERT INTO members (nickname, pw_hash, created_at) VALUES (?, ?, ?) RETURNING id",
    )
      .bind(nickname, hash, nowSec())
      .first();
  } catch {
    // 兩人同時用同一個暱稱或密碼註冊，唯一鍵擋下來
    throw new HttpError(409, "nickname_taken");
  }

  await audit(env, `member:${inserted.id}`, "register", null, inserted.id, { nickname });
  const token = await createSession(env, inserted.id);
  return json({ token, member: { id: inserted.id, nickname } }, request, env);
}

async function handleLogin(request, env) {
  const body = await readBody(request);
  if (typeof body.password !== "string" || !body.password) throw new HttpError(400, "wrong_password");

  const ip = await ipHash(request, env);
  await assertNotLocked(env, ip);

  const member = await env.DB.prepare("SELECT id, nickname FROM members WHERE pw_hash = ? AND disabled = 0")
    .bind(await passwordHash(env, body.password))
    .first();
  if (!member) {
    await recordFail(env, ip);
    throw new HttpError(401, "wrong_password");
  }

  const token = await createSession(env, member.id);
  return json({ token, member }, request, env);
}

async function handleLogout(request, env) {
  const token = bearer(request);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, request, env);
}

async function handleMe(request, env) {
  return json({ member: await requireMember(request, env) }, request, env);
}

function readSlot(body) {
  const slot = body.slot_start;
  if (!isOnTheHour(slot)) throw new HttpError(400, "bad_slot");
  return slot;
}

async function handleClaim(request, env) {
  const member = await requireMember(request, env);
  const slot = readSlot(await readBody(request));

  const [rules, bookingDays] = await Promise.all([loadRules(env), loadBookingDays(env)]);
  if (!isRegularSlot(rules, slot) || !isClaimable(slot, nowSec(), bookingDays)) {
    throw new HttpError(400, "slot_not_claimable");
  }

  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO claims (slot_start, member_id, created_at) VALUES (?, ?, ?)",
  )
    .bind(slot, member.id, nowSec())
    .run();

  if (result.meta.changes === 0) {
    const holder = await env.DB.prepare(
      "SELECT m.id, m.nickname FROM claims c JOIN members m ON m.id = c.member_id WHERE c.slot_start = ?",
    )
      .bind(slot)
      .first();
    if (holder?.id === member.id) return json({ ok: true }, request, env);
    throw new HttpError(409, "slot_taken", { by: holder?.nickname ?? "" });
  }

  await audit(env, `member:${member.id}`, "claim", slot, member.id);
  return json({ ok: true }, request, env);
}

async function handleUnclaim(request, env) {
  const member = await requireMember(request, env);
  const slot = readSlot(await readBody(request));

  const result = await env.DB.prepare(
    "DELETE FROM claims WHERE slot_start = ? AND member_id = ? AND slot_start > ?",
  )
    .bind(slot, member.id, nowSec())
    .run();

  if (result.meta.changes === 0) throw new HttpError(400, "cannot_unclaim");

  await audit(env, `member:${member.id}`, "unclaim", slot, member.id);
  return json({ ok: true }, request, env);
}

// ---------- 管理員 ----------

async function handleAdminSettings(request, env) {
  const body = await readBody(request);
  const today = twDay(nowSec());
  const statements = [];
  const detail = {};

  if (body.hours !== undefined) {
    const hours = normalizeHours(body.hours);
    if (!hours) throw new HttpError(400, "bad_hours");
    // 從今天起生效；今天之前的日子仍照舊規則計算
    statements.push(
      env.DB.prepare(
        `INSERT INTO slot_rules (effective_from, hours) VALUES (?, ?)
         ON CONFLICT(effective_from) DO UPDATE SET hours = excluded.hours`,
      ).bind(today, JSON.stringify(hours)),
    );
    detail.hours = hours;
  }

  if (body.bookingDays !== undefined) {
    const days = body.bookingDays;
    if (!Number.isInteger(days) || days < 1 || days > MAX_SCHEDULE_DAYS) throw new HttpError(400, "bad_booking_days");
    statements.push(
      env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES ('booking_days', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).bind(String(days)),
    );
    detail.bookingDays = days;
  }

  if (statements.length === 0) throw new HttpError(400, "bad_request");
  await env.DB.batch(statements);
  await audit(env, "admin", "settings", null, null, detail);
  return handleConfig(request, env);
}

async function handleAdminAssign(request, env) {
  const body = await readBody(request);
  const slot = readSlot(body);
  const memberId = body.member_id;

  const previous = await env.DB.prepare("SELECT member_id FROM claims WHERE slot_start = ?").bind(slot).first();

  if (memberId === null) {
    await env.DB.prepare("DELETE FROM claims WHERE slot_start = ?").bind(slot).run();
    await audit(env, "admin", "clear", slot, null, { previous: previous?.member_id ?? null });
    return json({ ok: true }, request, env);
  }

  if (!Number.isInteger(memberId)) throw new HttpError(400, "bad_request");
  const member = await env.DB.prepare("SELECT id FROM members WHERE id = ?").bind(memberId).first();
  if (!member) throw new HttpError(404, "member_not_found");

  await env.DB.prepare(
    `INSERT INTO claims (slot_start, member_id, created_at, by_admin) VALUES (?, ?, ?, 1)
     ON CONFLICT(slot_start) DO UPDATE SET member_id = excluded.member_id,
       created_at = excluded.created_at, by_admin = 1`,
  )
    .bind(slot, memberId, nowSec())
    .run();
  await audit(env, "admin", "assign", slot, memberId, { previous: previous?.member_id ?? null });
  return json({ ok: true }, request, env);
}

async function handleAdminMembers(request, env) {
  const now = nowSec();
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.nickname, m.created_at, m.disabled,
            m.pw_hash IS NOT NULL AS has_password,
            COUNT(c.slot_start) AS hours,
            COALESCE(SUM(c.slot_start + ? <= ?), 0) AS done
     FROM members m LEFT JOIN claims c ON c.member_id = m.id
     GROUP BY m.id
     ORDER BY m.nickname COLLATE NOCASE`,
  )
    .bind(SLOT_SEC, now)
    .all();
  return json({ members: results }, request, env);
}

async function handleAdminCreateMember(request, env) {
  const nickname = cleanNickname((await readBody(request)).nickname);
  let inserted;
  try {
    inserted = await env.DB.prepare("INSERT INTO members (nickname, created_at) VALUES (?, ?) RETURNING id")
      .bind(nickname, nowSec())
      .first();
  } catch {
    throw new HttpError(409, "nickname_taken");
  }
  await audit(env, "admin", "member", null, inserted.id, { created: nickname });
  return json({ member: { id: inserted.id, nickname } }, request, env);
}

async function handleAdminUpdateMember(request, env, id) {
  const body = await readBody(request);
  const member = await env.DB.prepare("SELECT id FROM members WHERE id = ?").bind(id).first();
  if (!member) throw new HttpError(404, "member_not_found");

  const detail = {};
  let dropSessions = false;

  if (body.nickname !== undefined) {
    const nickname = cleanNickname(body.nickname);
    const taken = await env.DB.prepare("SELECT 1 FROM members WHERE nickname = ? AND id <> ?").bind(nickname, id).first();
    if (taken) throw new HttpError(409, "nickname_taken");
    await env.DB.prepare("UPDATE members SET nickname = ? WHERE id = ?").bind(nickname, id).run();
    detail.nickname = nickname;
  }

  if (body.password !== undefined) {
    const hash = await passwordHash(env, checkPassword(body.password));
    const taken = await env.DB.prepare("SELECT 1 FROM members WHERE pw_hash = ? AND id <> ?").bind(hash, id).first();
    if (taken) throw new HttpError(409, "password_unusable");
    await env.DB.prepare("UPDATE members SET pw_hash = ? WHERE id = ?").bind(hash, id).run();
    detail.password = "reset";
    dropSessions = true; // 重設密碼代表舊的可能外流，舊手機要重新登入
  }

  if (body.disabled !== undefined) {
    const disabled = body.disabled ? 1 : 0;
    await env.DB.prepare("UPDATE members SET disabled = ? WHERE id = ?").bind(disabled, id).run();
    detail.disabled = disabled;
    if (disabled) dropSessions = true;
  }

  if (dropSessions) await env.DB.prepare("DELETE FROM sessions WHERE member_id = ?").bind(id).run();
  await audit(env, "admin", "member", null, id, detail);
  return json({ ok: true }, request, env);
}

async function handleAdminLog(request, env) {
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 200, 1), 1000);
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.at, l.actor, l.action, l.slot_start, l.member_id, l.detail, m.nickname
     FROM audit_log l LEFT JOIN members m ON m.id = l.member_id
     ORDER BY l.id DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return json({ log: results }, request, env);
}

// ---------- 路由 ----------

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  // 會改資料的請求只接受列在 ALLOWED_ORIGINS 的來源
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (!origin || !allowedOrigins(env).includes(origin)) throw new HttpError(403, "origin_not_allowed");
  }

  if (method === "GET" && pathname === "/api/config") return handleConfig(request, env);
  if (method === "GET" && pathname === "/api/schedule") return handleSchedule(request, env);
  if (method === "GET" && pathname === "/api/stats") return handleStats(request, env);

  if (method === "POST" && pathname === "/api/register") return handleRegister(request, env);
  if (method === "POST" && pathname === "/api/login") return handleLogin(request, env);
  if (method === "POST" && pathname === "/api/logout") return handleLogout(request, env);
  if (method === "GET" && pathname === "/api/me") return handleMe(request, env);
  if (method === "POST" && pathname === "/api/claim") return handleClaim(request, env);
  if (method === "POST" && pathname === "/api/unclaim") return handleUnclaim(request, env);

  if (pathname.startsWith("/api/admin/")) {
    await requireAdmin(request, env);
    if (method === "GET" && pathname === "/api/admin/check") return json({ ok: true }, request, env);
    if (method === "PUT" && pathname === "/api/admin/settings") return handleAdminSettings(request, env);
    if (method === "POST" && pathname === "/api/admin/assign") return handleAdminAssign(request, env);
    if (method === "GET" && pathname === "/api/admin/members") return handleAdminMembers(request, env);
    if (method === "POST" && pathname === "/api/admin/members") return handleAdminCreateMember(request, env);
    if (method === "GET" && pathname === "/api/admin/log") return handleAdminLog(request, env);

    const match = pathname.match(/^\/api\/admin\/members\/(\d+)$/);
    if (method === "POST" && match) return handleAdminUpdateMember(request, env, Number(match[1]));
  }

  throw new HttpError(404, "not_found");
}

async function cleanup(env) {
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE last_seen < ?").bind(now - SESSION_DAYS * 86400),
    env.DB.prepare("DELETE FROM login_fail WHERE window_start < ?").bind(now - 86400),
  ]);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.code, ...error.extra }, request, env, error.status);
      }
      console.error(error);
      return json({ error: "server_error" }, request, env, 500);
    }
  },

  // wrangler.toml 的 cron 每天叫一次
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
