/**
 * 時段計算（純函式，不碰資料庫，方便用 node --test 測）
 *
 * 時間一律用 UTC 運算，只在「換成台灣日期／台灣幾點」時加 8 小時。
 * 台灣、越南都沒有日光節約，所以固定位移就是正確答案。
 *
 * 一格的身分是「開始時間的 UTC 秒數」，資料庫也這樣存。
 * 這樣管理員日後改時段，過去的紀錄不會跟著變。
 */

export const TW_OFFSET_SEC = 8 * 3600;
export const VN_OFFSET_SEC = 7 * 3600;
export const SLOT_SEC = 3600;
export const DAY_SEC = 86400;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value) {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// UTC 秒數 → 台灣日期 'YYYY-MM-DD'
export function twDay(sec) {
  return new Date((sec + TW_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
}

// UTC 秒數 → 台灣時間幾點（0–23）
export function twHour(sec) {
  return Math.floor((((sec + TW_OFFSET_SEC) % DAY_SEC) + DAY_SEC) % DAY_SEC / 3600);
}

export function shiftDay(day, days) {
  const shifted = new Date(`${day}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

// 兩個日期之間差幾天（to - from）
export function dayDiff(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (DAY_SEC * 1000));
}

// 台灣日期＋台灣幾點 → 那一格開始的 UTC 秒數
export function slotStart(day, hour) {
  return Date.parse(`${day}T00:00:00Z`) / 1000 + hour * 3600 - TW_OFFSET_SEC;
}

// 一格的開始時間必須落在整點
export function isOnTheHour(sec) {
  return Number.isInteger(sec) && sec % SLOT_SEC === 0;
}

/**
 * 時段規則的歷史：[{ effective_from: 'YYYY-MM-DD', hours: [12, 21, 22] }, …]
 * 某一天適用「生效日 <= 那一天」裡最新的一條；比第一條還早的日子沒有時段。
 */
export function hoursForDay(rules, day) {
  let hours = [];
  for (const rule of rules) {
    if (rule.effective_from <= day) hours = rule.hours;
    else break;
  }
  return hours;
}

export function sortRules(rules) {
  return [...rules].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
}

// from、to 都含在內。回傳依時間排序的 [{ start, day, hour }]
export function regularSlots(rules, from, to) {
  const sorted = sortRules(rules);
  const slots = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    for (const hour of hoursForDay(sorted, day)) {
      slots.push({ start: slotStart(day, hour), day, hour });
    }
  }
  return slots;
}

export function isRegularSlot(rules, sec) {
  return hoursForDay(sortRules(rules), twDay(sec)).includes(twHour(sec));
}

// 管理員送來的時段清單：0–23 的整數、不重複、至少一格；回傳排序好的陣列，不合法回 null
export function normalizeHours(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) return null;
  const hours = [...new Set(value)];
  if (hours.length !== value.length) return null;
  if (!hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 23)) return null;
  return hours.sort((a, b) => a - b);
}

/**
 * 可以認領的範圍：還沒開始，而且台灣日期在「今天起算 bookingDays 天內」。
 * bookingDays = 14 代表今天到第 13 天後（跟畫面上的「未來 14 天」一致）。
 */
export function isClaimable(sec, nowSec, bookingDays) {
  if (sec <= nowSec) return false;
  return dayDiff(twDay(nowSec), twDay(sec)) < bookingDays;
}
