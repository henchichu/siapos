const test = require("node:test");
const assert = require("node:assert/strict");
const { splitOvertime, shiftPay } = require("../../server/overtime");

const shift = (employeeId, week, hours) => ({ employeeId, week, minutes: hours * 60 });

test("hours past 40 in a week are overtime, and the shift that crosses 40 is split", () => {
  const week = ["2026-10-12", "2026-10-12", "2026-10-12", "2026-10-12", "2026-10-12"].map((w) => shift("sam", w, 9)); // 45 hours
  const split = splitOvertime(week);
  assert.deepEqual(split.map((s) => s.regular / 60), [9, 9, 9, 9, 4]);
  assert.deepEqual(split.map((s) => s.overtime / 60), [0, 0, 0, 0, 5]);
  assert.deepEqual(splitOvertime([...week, shift("sam", "2026-10-12", 3)]).at(-1), { regular: 0, overtime: 180 });
});

test("each employee and each week starts again at zero", () => {
  const split = splitOvertime([shift("sam", "2026-10-12", 40), shift("priya", "2026-10-12", 8), shift("sam", "2026-10-19", 8), shift("sam", "2026-10-12", 2)]);
  assert.deepEqual(split, [{ regular: 2400, overtime: 0 }, { regular: 480, overtime: 0 }, { regular: 480, overtime: 0 }, { regular: 0, overtime: 120 }]);
});

test("overtime pays 1.5 times the rate", () => {
  assert.equal(shiftPay({ regular: 240, overtime: 300 }, 20), 4 * 20 + 5 * 30);
  assert.equal(shiftPay({ regular: 0, overtime: 0 }, 20), 0);
});
