const test = require("node:test");
const assert = require("node:assert/strict");
const { isDate } = require("../../server/dates");

test("only real calendar days pass", () => {
  for (const d of ["2026-10-21", "2024-02-29", "2026-12-31"]) assert.equal(isDate(d), true, d);
  for (const d of ["2026-02-31", "2026-04-31", "2025-02-29", "2026-13-01", "2026-00-10", "2026-1-5", "", null, undefined, ["2026-10-21"]]) assert.equal(isDate(d), false, String(d));
});
