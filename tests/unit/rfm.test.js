const test = require("node:test");
const assert = require("node:assert/strict");
const { AT_RISK_MIN_DAYS, LAPSED_MIN_DAYS, scores, segmentOf, rfm } = require("../../server/rfm");

test("five different values get one score each", () => {
  assert.deepEqual(scores([10, 50, 30, 20, 40]), [1, 5, 3, 2, 4]);
});

test("ties share a score, and nobody stands out when everyone is the same", () => {
  assert.deepEqual(scores([7, 7, 7, 7]), [3, 3, 3, 3]);
  assert.deepEqual(scores([7]), [3]);
  const [a, b, c] = scores([1, 1, 9]);
  assert.equal(a, b);
  assert.ok(c > a);
});

test("no customers, no scores", () => {
  assert.deepEqual(scores([]), []);
  assert.deepEqual(rfm([]), []);
});

test("each segment", () => {
  assert.equal(segmentOf(5, 5, 5, 0), "Champion");
  assert.equal(segmentOf(3, 4, 1, 0), "Loyal");
  assert.equal(segmentOf(5, 1, 1, 0), "Recent");
  assert.equal(segmentOf(1, 4, 1, 90), "At risk");
  assert.equal(segmentOf(2, 1, 5, 90), "At risk");
  assert.equal(segmentOf(1, 1, 1, 90), "Lapsed");
  assert.equal(segmentOf(3, 3, 3, 90), "Steady");
});

test("nobody is At risk or Lapsed until the minimum days have passed", () => {
  assert.equal(AT_RISK_MIN_DAYS, 30);
  assert.equal(LAPSED_MIN_DAYS, 60);
  assert.equal(segmentOf(1, 4, 1, AT_RISK_MIN_DAYS - 1), "Steady");
  assert.equal(segmentOf(1, 4, 1, AT_RISK_MIN_DAYS), "At risk");
  assert.equal(segmentOf(1, 1, 1, LAPSED_MIN_DAYS - 1), "Steady");
  assert.equal(segmentOf(1, 1, 1, LAPSED_MIN_DAYS), "Lapsed");
  const yesterday = rfm([
    { customer: "A", daysSince: 0, orders: 9, spend: 100 },
    { customer: "B", daysSince: 0, orders: 8, spend: 90 },
    { customer: "C", daysSince: 0, orders: 7, spend: 80 },
    { customer: "Yesterday", daysSince: 1, orders: 7, spend: 900 },
  ]).find((c) => c.customer === "Yesterday");
  assert.ok(yesterday.r <= 2 && yesterday.m >= 4, "scores as a quiet big spender");
  assert.equal(yesterday.segment, "Steady", "but came in yesterday, so isn't At risk");
});

test("fewer days since the last order scores higher, and the best customers come first", () => {
  const out = rfm([
    { customer: "Quiet", daysSince: 60, orders: 1, spend: 500 },
    { customer: "Regular", daysSince: 1, orders: 9, spend: 9000 },
  ]);
  assert.deepEqual(out.map((c) => c.customer), ["Regular", "Quiet"]);
  assert.ok(out[0].r > out[1].r && out[0].f > out[1].f && out[0].m > out[1].m);
});
