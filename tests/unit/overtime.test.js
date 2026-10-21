const test = require("node:test");
const assert = require("node:assert/strict");
const { mondayOf, splitOvertime, shiftPay } = require("../../server/overtime");

const shift = (day, hours, employeeId = "a", time = "09:00") => ({ employeeId, day, clockInAt: `${day}T${time}:00Z`, minutes: hours * 60 });

test("weeks run Monday to Sunday", () => {
  assert.equal(mondayOf("2026-10-19"), "2026-10-19"); // a Monday
  assert.equal(mondayOf("2026-10-25"), "2026-10-19"); // the Sunday after
  assert.equal(mondayOf("2026-10-26"), "2026-10-26");
  assert.equal(mondayOf("2026-11-01"), "2026-10-26"); // across a month end
});

test("40 hours or less is all regular", () => {
  const out = splitOvertime(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"].map((d) => shift(d, 8)));
  assert.ok(out.every((s) => s.regular === 480 && s.overtime === 0));
});

test("the shift that crosses 40 hours is split, and every later one is overtime", () => {
  const days = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"];
  const out = splitOvertime(days.map((d) => shift(d, 9)).reverse()); // given out of order
  assert.deepEqual(out.map((s) => s.day), days, "worked through in clock-in order");
  assert.deepEqual(out.map((s) => [s.regular / 60, s.overtime / 60]), [[9, 0], [9, 0], [9, 0], [9, 0], [4, 5], [0, 9]]);
});

test("each week and each employee starts again at zero", () => {
  const out = splitOvertime([shift("2026-10-24", 45), shift("2026-10-26", 8), shift("2026-10-24", 8, "b")]);
  const of = (e, d) => out.find((s) => s.employeeId === e && s.day === d);
  assert.deepEqual([of("a", "2026-10-24").regular, of("a", "2026-10-24").overtime], [2400, 300]);
  assert.equal(of("a", "2026-10-26").overtime, 0, "a new week");
  assert.equal(of("b", "2026-10-24").overtime, 0, "someone else");
});

test("overtime is paid at time and a half", () => {
  assert.equal(shiftPay({ regular: 480, overtime: 0 }, 2000), 16000);
  assert.equal(shiftPay({ regular: 240, overtime: 60 }, 2000), 8000 + 3000);
  assert.equal(shiftPay({ regular: 0, overtime: 1 }, 1725), 43, "rounded to the cent");
});
