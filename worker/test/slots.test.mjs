import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dayDiff,
  hoursForDay,
  isClaimable,
  isDay,
  isOnTheHour,
  isRegularSlot,
  normalizeHours,
  regularSlots,
  shiftDay,
  slotStart,
  twDay,
  twHour,
} from "../src/slots.js";

const iso = (sec) => new Date(sec * 1000).toISOString();

test("台灣 12:00 = UTC 04:00，越南 11:00", () => {
  const start = slotStart("2026-10-24", 12);
  assert.equal(iso(start), "2026-10-24T04:00:00.000Z");
  assert.equal(twDay(start), "2026-10-24");
  assert.equal(twHour(start), 12);
});

test("台灣 00:00 在 UTC 是前一天 16:00，台灣日期仍算當天", () => {
  const start = slotStart("2026-10-24", 0);
  assert.equal(iso(start), "2026-10-23T16:00:00.000Z");
  assert.equal(twDay(start), "2026-10-24");
  assert.equal(twHour(start), 0);
});

test("台灣 23:00 不跨到隔天", () => {
  const start = slotStart("2026-10-24", 23);
  assert.equal(twDay(start), "2026-10-24");
  assert.equal(twHour(start), 23);
});

test("日期工具：跨月、跨年、閏年", () => {
  assert.equal(shiftDay("2026-10-31", 1), "2026-11-01");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDay("2028-02-28", 1), "2028-02-29");
  assert.equal(dayDiff("2026-10-24", "2026-11-07"), 14);
  assert.ok(isDay("2026-10-24"));
  assert.ok(!isDay("2026-02-30"));
  assert.ok(!isDay("2026-1-5"));
  assert.ok(!isDay(undefined));
});

test("時段規則依生效日切換，改時段不影響過去", () => {
  const rules = [
    { effective_from: "2026-10-30", hours: [12, 20] },
    { effective_from: "2026-10-20", hours: [12, 21, 22] },
  ];
  const sorted = [...rules].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  assert.deepEqual(hoursForDay(sorted, "2026-10-19"), []);
  assert.deepEqual(hoursForDay(sorted, "2026-10-20"), [12, 21, 22]);
  assert.deepEqual(hoursForDay(sorted, "2026-10-29"), [12, 21, 22]);
  assert.deepEqual(hoursForDay(sorted, "2026-10-30"), [12, 20]);

  const slots = regularSlots(rules, "2026-10-29", "2026-10-30");
  assert.deepEqual(
    slots.map((s) => `${s.day} ${s.hour}`),
    ["2026-10-29 12", "2026-10-29 21", "2026-10-29 22", "2026-10-30 12", "2026-10-30 20"],
  );
  assert.ok(isRegularSlot(rules, slotStart("2026-10-29", 22)));
  assert.ok(!isRegularSlot(rules, slotStart("2026-10-30", 22)));
});

test("兩週預設三格 = 42 格", () => {
  const rules = [{ effective_from: "2026-10-01", hours: [12, 21, 22] }];
  assert.equal(regularSlots(rules, "2026-10-24", shiftDay("2026-10-24", 13)).length, 42);
});

test("時段清單驗證", () => {
  assert.deepEqual(normalizeHours([22, 12, 21]), [12, 21, 22]);
  assert.equal(normalizeHours([]), null);
  assert.equal(normalizeHours([12, 12]), null);
  assert.equal(normalizeHours([24]), null);
  assert.equal(normalizeHours([1.5]), null);
  assert.equal(normalizeHours("12"), null);
});

test("可認領範圍：還沒開始、在 14 天內", () => {
  const now = slotStart("2026-10-24", 12) + 600; // 台灣 10/24 12:10
  assert.ok(!isClaimable(slotStart("2026-10-24", 12), now, 14), "進行中的不能認領");
  assert.ok(isClaimable(slotStart("2026-10-24", 21), now, 14));
  assert.ok(isClaimable(slotStart("2026-11-06", 22), now, 14), "第 13 天後可以");
  assert.ok(!isClaimable(slotStart("2026-11-07", 12), now, 14), "第 14 天後不行");
});

test("整點檢查", () => {
  assert.ok(isOnTheHour(slotStart("2026-10-24", 12)));
  assert.ok(!isOnTheHour(slotStart("2026-10-24", 12) + 60));
  assert.ok(!isOnTheHour("123"));
});
