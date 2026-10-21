const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../../server/database/connection");

// A stand-in connection that records what happened to it
function fake() {
  const log = [];
  const conn = { beginTransaction: async () => log.push("begin"), commit: async () => log.push("commit"), rollback: async () => log.push("rollback"), release: () => log.push("release") };
  pool.getConnection = async () => conn;
  return log;
}
const deadlock = () => Object.assign(new Error("Deadlock found"), { code: "ER_LOCK_DEADLOCK" });

test("a deadlock rolls back and runs the work again", async () => {
  const log = fake();
  let runs = 0, undone = 0;
  const out = await pool.tx(async () => { if (++runs === 1) throw deadlock(); return "paid"; }, () => undone++);
  assert.deepEqual([out, runs, undone], ["paid", 2, 1]);
  assert.deepEqual(log, ["begin", "rollback", "release", "begin", "commit", "release"]);
});

test("any other error is thrown at once, after a rollback", async () => {
  const log = fake();
  let runs = 0;
  await assert.rejects(pool.tx(async () => { runs++; throw new Error("boom"); }), /boom/);
  assert.deepEqual([runs, log.join()], [1, "begin,rollback,release"]);
});

test("a deadlock three times in a row is given up on", async () => {
  fake();
  let runs = 0;
  await assert.rejects(pool.tx(async () => { runs++; throw deadlock(); }), /Deadlock/);
  assert.equal(runs, 3);
});
