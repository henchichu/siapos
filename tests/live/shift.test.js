// Needs the dev database. Clocks Jordan in and out today and builds its own old pay period for the manager tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool } = require("./env");

let env;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });

test.before(async () => { env = await start(); });
test.after(async () => { env.server.close(); await pool.end(); });

test("the menu and the pages a role may open follow its role, fixed at sign-in", async () => {
  const menus = {
    jordan: ["Kitchen", "My shift"],
    sam: ["Register", "Kitchen", "Rewards", "Products", "My shift"],
    leo: ["Register", "Kitchen", "Needs attention", "Orders", "Rewards", "Products", "Inventory", "Reports", "Employees", "My shift"],
  };
  const jordan = await signIn("10420005", "555555"), sam = await signIn("10420003", "333333"), leo = await signIn("10420002", "222222"), maya = await signIn("10420001", "111111");
  assert.deepEqual((await jordan.call("/session")).body.nav, menus.jordan);
  assert.deepEqual((await sam.call("/session")).body.nav, menus.sam);
  assert.deepEqual((await leo.call("/session")).body.nav, menus.leo);
  assert.deepEqual((await maya.call("/session")).body.nav, menus.leo);

  const blocked = await page(jordan, "/register.html");
  assert.equal(blocked.status, 302);
  assert.equal(blocked.headers.get("location"), "/kitchen.html");
  assert.equal((await page(jordan, "/kitchen.html")).status, 200);
  assert.equal((await page(jordan, "/shift.html")).status, 200);
  assert.equal((await page(sam, "/register.html")).status, 200);
  assert.equal((await page(leo, "/register.html")).status, 200);
  assert.equal((await page(client(env.base), "/shift.html")).headers.get("location"), "/login.html");

  assert.equal((await jordan.call("/team/timecards")).status, 403, "a barista has no team timecards");
  assert.equal((await sam.call("/team/timecards")).status, 403, "neither has a server");
  assert.equal((await jordan.call("/access-violation", { page: "Register" })).status, 200);
});

test("time clock: each button works only in the right state, and Clock out submits the shift", async () => {
  const jordan = await signIn("10420005", "555555");
  const state = async () => (await jordan.call("/shift")).body;
  const before = await state();
  assert.equal(before.open, null);
  assert.equal((await jordan.call("/shift/break-start", {})).status, 409, "no break before clocking in");
  assert.equal((await jordan.call("/shift/clock-out", {})).status, 409, "no clock out before clocking in");

  assert.equal((await jordan.call("/shift/clock-in", {})).status, 200);
  assert.equal((await jordan.call("/shift/clock-in", {})).status, 409, "can't clock in twice");
  assert.equal((await state()).entries.find((e) => e.status === "OPEN").hours, null);
  assert.equal((await jordan.call("/shift/break-end", {})).status, 409, "no break to end");
  assert.equal((await jordan.call("/shift/break-start", {})).status, 200);
  assert.equal((await state()).open.onBreak, true);
  assert.equal((await jordan.call("/shift/break-start", {})).status, 409, "already on a break");
  await sleep(1100);
  assert.equal((await jordan.call("/shift/clock-out", {})).status, 200, "clocking out during a break ends the break");

  const after = await state();
  assert.equal(after.open, null);
  assert.equal(after.entries[0].status, "SUBMITTED");
  assert.equal(after.entries[0].onBreak, false);
  assert.equal(after.entries.length, before.entries.length + 1);
  assert.equal(after.sales.items >= 0, true);
  assert.equal(after.rate, 16);
});

test("team timecards: filters, approve, reject, edit, approve all, close", async () => {
  const leo = await signIn("10420002", "222222");
  const priya = await signIn("10420004", "444444");
  const [[{ start }]] = await pool.query("SELECT COALESCE(DATE_FORMAT(MAX(EndDate) + INTERVAL 1 DAY, '%Y-%m-%d'), '2020-01-01') AS start FROM PayPeriod WHERE EndDate < '2026-01-01'");
  const id = `pp-t-${start}`;
  await pool.query("INSERT INTO PayPeriod (PayPeriodID, BusinessID, StartDate, EndDate) VALUES (?, 'biz-brewbean', ?, ? + INTERVAL 13 DAY)", [id, start, start]);
  const shift = (who, place, n) => pool.query(
    `INSERT INTO TimeEntry (TimeEntryID, EmployeeID, LocationID, BusinessID, PayPeriodID, ClockInAt, ClockOutAt, UnpaidBreakMinutes, TimeEntryStatusCode)
     VALUES (?, ?, ?, 'biz-brewbean', ?, CONVERT_TZ(? + INTERVAL 1 DAY + INTERVAL 13 HOUR, '+00:00', '+00:00'), ? + INTERVAL 1 DAY + INTERVAL 21 HOUR, 30, 2)`,
    [`te-t-${start}-${n}`, who, place, id, start, start]);
  await shift("emp-priya", "loc-campus", 1); await shift("emp-jordan", "loc-campus", 2); await shift("emp-sam", "loc-downtown", 3);
  const get = (q) => leo.call(`/team/timecards?payPeriodId=${id}&${q}`);

  let t = await get("status=SUBMITTED");
  assert.equal(t.body.rows.length, 3);
  assert.equal(t.body.waiting, 3);
  assert.equal(t.body.rows[0].hours, 7.5, "8h on the clock less a 30 minute break");
  t = await get("status=SUBMITTED&locationId=loc-campus");
  assert.equal(t.body.rows.length, 2);
  assert.equal(t.body.waiting, 2, "the count follows period and location, not the status filter");

  assert.equal((await priya.call("/team/timecards/x/approve", {})).status, 403, "a server can't approve");
  const close = () => leo.call(`/team/pay-periods/${id}/close`, {});
  assert.match((await close()).body.error, /3 timecards are still open or waiting/);

  const sam = (await get("status=SUBMITTED&locationId=loc-downtown")).body.rows[0];
  assert.equal((await leo.call(`/team/timecards/${sam.id}/reject`, {})).status, 200);
  assert.equal((await leo.call(`/team/timecards/${sam.id}/approve`, {})).status, 409, "a rejected card can't be approved");
  assert.equal((await get("status=REJECTED")).body.rows.length, 1);

  const edit = (body) => leo.call(`/team/timecards/${sam.id}/edit`, body);
  assert.equal((await edit({ clockIn: `${start}T09:00`, clockOut: `${start}T08:00`, breakMinutes: 0 })).status, 400, "out before in");
  assert.equal((await edit({ clockIn: `${start}T08:00`, clockOut: `${start}T09:00`, breakMinutes: 90 })).status, 400, "break longer than the shift");
  assert.equal((await edit({ clockIn: `${start}T08:00`, clockOut: `${start}T16:30`, breakMinutes: 30 })).status, 200);
  const fixed = (await get("locationId=loc-downtown")).body.rows[0];
  assert.deepEqual([fixed.status, fixed.hours, fixed.breakMinutes], ["SUBMITTED", 8, 30], "an edited card goes back to Submitted");

  const all = await leo.call("/team/timecards/approve-all", { payPeriodId: id, locationId: "all" });
  assert.equal(all.body.approved, 3);
  t = await get("status=APPROVED");
  assert.equal(t.body.rows.length, 3);
  assert.match(t.body.rows[0].approvedBy, /^Leo /);
  assert.equal(t.body.waiting, 0);

  const done = await close();
  assert.equal(done.status, 200);
  assert.equal(done.body.finalized, 3);
  assert.equal(done.body.message, "Success: Pay period successfully finalized and closed");
  assert.equal((await edit({ clockIn: `${start}T08:00`, clockOut: `${start}T16:00`, breakMinutes: 0 })).status, 409, "closed periods are locked");
  assert.equal((await close()).status, 409);
  assert.equal((await leo.call("/team/pay-periods/pp-next/close", {})).status, 409, "the running period can't be closed");
});
