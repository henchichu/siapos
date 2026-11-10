// Needs the dev database. The rules a shift must keep, now enforced by the backend (server/shift.js checkShift): an open pay
// period, a clock-in inside it by the café's local date, no overlap with the person's other shifts, one request at a time per person.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, admin, creds } = require("./env");

let env, maya;
const periods = [], cards = [];
const login = async (number) => { const c = client(env.base); assert.equal((await c.call("/login", creds(number))).status, 200); return c; };

test.before(async () => { env = await start(); maya = await login("10420001"); });
test.after(async () => {
  for (const id of cards) await admin.query("DELETE FROM TimeEntry WHERE TimeEntryID = ?", [id]);
  for (const id of periods) { await admin.query("DELETE FROM TimeEntry WHERE PayPeriodID = ?", [id]); await admin.query("DELETE FROM PayPeriod WHERE PayPeriodID = ?", [id]); }
  env.server.close(); await pool.end(); await admin.end();
});

// A two-week period of its own, long ago, with two submitted shifts for Sam: 08:00-12:00 and 13:00-17:00 on its second day
async function setup() {
  const [[{ start }]] = await pool.query("SELECT COALESCE(DATE_FORMAT(MAX(EndDate) + INTERVAL 1 DAY, '%Y-%m-%d'), '2020-01-01') AS start FROM PayPeriod WHERE EndDate < '2026-01-01'");
  const id = `pp-r-${start}`;
  await admin.query("INSERT INTO PayPeriod (PayPeriodID, BusinessID, StartDate, EndDate) VALUES (?, 'biz-brewbean', ?, ? + INTERVAL 13 DAY)", [id, start, start]);
  periods.push(id);
  const card = async (n, from, to) => {
    const tid = `te-r-${start}-${n}`;
    await admin.query(
      `INSERT INTO TimeEntry (TimeEntryID, EmployeeID, LocationID, BusinessID, PayPeriodID, ClockInAt, ClockOutAt, TimeEntryStatusCode)
       VALUES (?, 'emp-sam', 'loc-downtown', 'biz-brewbean', ?, CONVERT_TZ(? + INTERVAL ? HOUR, 'America/Chicago', '+00:00'), CONVERT_TZ(? + INTERVAL ? HOUR, 'America/Chicago', '+00:00'), 2)`,
      [tid, id, start, 24 + from, start, 24 + to]);
    return tid;
  };
  return { start, id, a: await card(1, 8, 12), b: await card(2, 13, 17) };
}
const edit = (c, id, body) => c.call(`/team/timecards/${id}/edit`, body);

test("a corrected shift can't overlap the person's other shifts, but may touch one", async () => {
  const { start, a, b } = await setup();
  const day = (n) => new Date(Date.parse(`${start}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const r = await edit(maya, b, { clockIn: `${day(1)}T11:00`, clockOut: `${day(1)}T14:00`, breakMinutes: 0 });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /overlaps/);
  assert.equal((await edit(maya, b, { clockIn: `${day(1)}T12:00`, clockOut: `${day(1)}T14:00`, breakMinutes: 0 })).status, 200, "starting when the other ends is fine");
  const [[row]] = await pool.query("SELECT TimeEntryStatusCode AS s FROM TimeEntry WHERE TimeEntryID = ?", [a]);
  assert.equal(row.s, 2, "the other shift is untouched");
});

test("a corrected shift's clock-in must fall in its pay period, and a closed period refuses it", async () => {
  const { start, id, b } = await setup();
  const day = (n) => new Date(Date.parse(`${start}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const outside = await edit(maya, b, { clockIn: `${day(20)}T09:00`, clockOut: `${day(20)}T10:00`, breakMinutes: 0 });
  assert.equal(outside.status, 409);
  assert.match(outside.body.error, /outside the pay period/);
  assert.equal((await edit(maya, b, { clockIn: `${day(13)}T09:00`, clockOut: `${day(13)}T10:00`, breakMinutes: 0 })).status, 200, "the last day counts");
  await admin.query("UPDATE PayPeriod SET Closed = 1 WHERE PayPeriodID = ?", [id]);
  const closed = await edit(maya, b, { clockIn: `${day(2)}T09:00`, clockOut: `${day(2)}T10:00`, breakMinutes: 0 });
  assert.deepEqual([closed.status, closed.body.error], [409, "That pay period is closed."]);
});

test("two clock-ins at once make one open shift; a closed period takes none", async () => {
  const ana = await login("10420006");
  await admin.query("DELETE FROM TimeEntry WHERE EmployeeID = 'emp-ana' AND TimeEntryStatusCode = 1");
  try {
    const both = await Promise.all([ana.call("/shift/clock-in", {}), ana.call("/shift/clock-in", {})]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.body)));
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM TimeEntry WHERE EmployeeID = 'emp-ana' AND TimeEntryStatusCode = 1");
    assert.equal(n, 1, "one open shift");
    await new Promise((r) => setTimeout(r, 1200)); // a shift must be a second old to clock out
    assert.equal((await ana.call("/shift/clock-out", {})).status, 200);
    await admin.query("DELETE FROM TimeEntry WHERE EmployeeID = 'emp-ana' AND TimeEntryStatusCode = 2 AND ClockOutAt > UTC_TIMESTAMP() - INTERVAL 1 MINUTE");
    await admin.query("UPDATE PayPeriod SET Closed = 1 WHERE PayPeriodID = 'pp-curr'");
    const r = await ana.call("/shift/clock-in", {});
    assert.deepEqual([r.status, r.body.error], [409, "That pay period is closed."]);
  } finally {
    await admin.query("UPDATE PayPeriod SET Closed = 0 WHERE PayPeriodID = 'pp-curr'");
    await admin.query("DELETE FROM TimeEntry WHERE EmployeeID = 'emp-ana' AND ClockInAt > UTC_TIMESTAMP() - INTERVAL 5 MINUTE");
  }
});
