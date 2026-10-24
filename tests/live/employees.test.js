// Needs the dev database. Adds test employees (numbers 9999xxxx) and removes them, their shifts, rates and PINs afterwards.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool } = require("./env");

let env, maya, leo, sam, jordan;
const made = []; // employee ids to remove
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); return { c, r }; };
const owner = async () => { const { c, r } = await signIn("10420001", "111111"); assert.equal(r.status, 200); return c; };
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });
const list = async () => (await maya.call("/employees")).body;
const byNumber = async (n) => (await list()).employees.find((e) => e.number === n);
const number = () => `9999${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;

// A complete, valid new employee
async function person(extra = {}) {
  const n = extra.number || number();
  const body = { firstName: "Test", lastName: `Person ${n.replace(/\d/g, (d) => "abcdefghij"[d])}`, number: n, email: `t${n}@example.com`, roleId: "role-server",
    locationIds: ["loc-campus"], rate: "15.00", startsOn: (await list()).today, pin: "246810", ...extra };
  const r = await maya.call("/employees", body);
  if (r.status === 200) made.push(r.body.id);
  return { r, body };
}

test.before(async () => {
  env = await start();
  maya = await owner();
  leo = (await signIn("10420002", "222222")).c;
  sam = (await signIn("10420003", "333333")).c;
  jordan = (await signIn("10420005", "555555")).c;
});
test.after(async () => {
  if (made.length) {
    await pool.query("DELETE FROM TimeEntry WHERE EmployeeID IN (?)", [made]);
    for (const t of ["EmployeeCredential", "EmployeePayRate", "EmployeeLocation", "Employee"]) await pool.query(`DELETE FROM ${t} WHERE EmployeeID IN (?)`, [made]);
  }
  env.server.close(); await pool.end();
});

test("owners and managers get Reports and Employees in the menu and on Home; nobody else gets either", async () => {
  for (const c of [maya, leo]) {
    assert.equal((await c.call("/employees")).status, 200);
    assert.equal((await page(c, "/employees.html")).status, 200);
    assert.equal((await page(c, "/reports.html")).status, 200);
    const s = (await c.call("/session")).body;
    assert.ok(["Reports", "Employees"].every((n) => s.nav.includes(n) && s.tiles.includes(n)), s.nav.join());
  }
  for (const [c, home] of [[sam, "/register.html"], [jordan, "/kitchen.html"]]) {
    assert.equal((await c.call("/employees")).status, 403);
    assert.equal((await c.call("/reports/options")).status, 403);
    assert.equal((await page(c, "/employees.html")).headers.get("location"), home);
    assert.equal((await page(c, "/reports.html")).headers.get("location"), home);
    const s = (await c.call("/session")).body;
    assert.ok(!["Reports", "Employees"].some((n) => s.nav.includes(n) || s.tiles.includes(n)), s.nav.join());
  }
  // a manager still has the team timecards, under My shift
  assert.equal((await leo.call("/team/timecards")).status, 200);
});

test("a manager: only their own locations' staff, nobody senior, and pay is read-only", async () => {
  const boss = await person({ roleId: "role-manager", locationIds: ["loc-campus"], pin: "112233" }); // a manager at Campus only
  const mgr = (await signIn(boss.body.number, "112233")).c;
  const view = (await mgr.call("/employees")).body;
  assert.equal(view.canPay, false);
  assert.deepEqual(view.locations.map((l) => l.id), ["loc-campus"]);
  const shown = (n) => view.employees.find((e) => e.number === n);
  assert.ok(!shown("10420003"), "Sam works only at Downtown");
  assert.equal(shown("10420004").rate, 16.75, "Priya's rate, to read");
  assert.deepEqual(["10420004", "10420005", "10420001", "10420002", boss.body.number].map((n) => shown(n).manageable), [true, true, false, false, false]);
  assert.ok(!view.assignable.includes("role-owner") && !view.assignable.includes("role-manager") && view.assignable.includes("role-server"));

  // adding: their own location, a junior role, and no pay
  const hire = (extra) => ({ firstName: "Mgr", lastName: "Hire", number: number(), email: `m${Date.now()}@example.com`, roleId: "role-server",
    locationIds: ["loc-campus"], rate: "", startsOn: "", pin: "246810", ...extra });
  assert.equal((await mgr.call("/employees", hire({ rate: "20.00", startsOn: view.today }))).body.error, "Only an owner can set or change pay rates.");
  assert.equal((await mgr.call("/employees", hire({ roleId: "role-manager" }))).status, 403);
  assert.equal((await mgr.call("/employees", hire({ roleId: "role-owner" }))).status, 403);
  assert.equal((await mgr.call("/employees", hire({ locationIds: ["loc-downtown"] }))).status, 403);
  const body = hire();
  const added = await mgr.call("/employees", body);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  made.push(added.body.id);
  assert.match(added.body.message, /An owner sets their pay rate/);
  const row = (await mgr.call("/employees")).body.employees.find((e) => e.id === added.body.id);
  assert.deepEqual([row.rate, row.latest, row.manageable], [null, null, true], "no rate until an owner sets one");

  // editing: details yes, pay no; the owner sets the rate
  assert.equal((await mgr.call(`/employees/${row.id}`, { ...body, firstName: "Renamed" })).status, 200);
  assert.equal((await mgr.call(`/employees/${row.id}`, { ...body, rate: "20.00", startsOn: view.today })).status, 403);
  assert.equal((await mgr.call(`/employees/${row.id}`, { ...body, roleId: "role-manager" })).status, 403);
  assert.equal((await maya.call(`/employees/${row.id}`, { ...body, rate: "18.00", startsOn: view.today })).status, 200);
  assert.equal((await mgr.call(`/employees/${row.id}`, { ...body, rate: "18.00" })).status, 200, "the rate sent back unchanged is fine");
  assert.equal((await mgr.call(`/employees/${row.id}`, { ...body, rate: "19.00" })).status, 403);
  const [rates] = await pool.query("SELECT HourlyRate AS r FROM EmployeePayRate WHERE EmployeeID = ?", [row.id]);
  assert.deepEqual(rates.map((r) => Number(r.r)), [18], "only the owner's rate");

  // nobody senior, nobody elsewhere
  const sam1 = (await list()).employees.find((e) => e.number === "10420003");
  assert.equal((await mgr.call(`/employees/${sam1.id}`, { ...body, number: sam1.number })).status, 404);
  assert.equal((await mgr.call("/employees/emp-maya/active", { active: false })).status, 403);
  assert.equal((await mgr.call("/employees/emp-leo/unlock", {})).status, 403);
  assert.equal((await mgr.call("/employees/emp-leo", { ...body, number: "10420002" })).status, 403);

  // someone at both cafés keeps the location the manager doesn't run
  const both = await person({ locationIds: ["loc-campus", "loc-downtown"] });
  const bothRow = await byNumber(both.body.number);
  assert.equal((await mgr.call(`/employees/${bothRow.id}`, { ...both.body, rate: "", startsOn: "", pin: "", firstName: "Kept" })).status, 200);
  assert.deepEqual((await byNumber(both.body.number)).locations.map((l) => l.id).sort(), ["loc-campus", "loc-downtown"]);
  assert.equal((await mgr.call(`/employees/${bothRow.id}/active`, { active: false })).status, 200, "and can deactivate them");
});

test("the list carries roles, locations, rates and status, and never a PIN", async () => {
  const raw = await (await fetch(env.base + "/api/employees", { headers: { cookie: maya.cookie() } })).text();
  assert.ok(!/scrypt|PinHash|"pin"/i.test(raw), "nothing about PINs is sent");
  const data = JSON.parse(raw);
  const sam1 = data.employees.find((e) => e.number === "10420003");
  assert.equal(sam1.role, "Server");
  assert.deepEqual(sam1.locations.map((l) => l.name), ["Brewbean Downtown"]);
  assert.equal(sam1.rate, 17.25, "his current rate, not the one before his raise");
  assert.equal(sam1.status, "Active");
  assert.ok(data.roles.length >= 5 && data.locations.length === 2 && data.me === "emp-maya");
});

test("adding: every problem at once, then a new employee who can sign in with their PIN", async () => {
  const bad = await maya.call("/employees", { firstName: "", number: "12", email: "nope", locationIds: [], rate: "abc", pin: "12" });
  assert.equal(bad.status, 400);
  for (const part of ["first name", "last name", "8 digits", "valid email", "role", "location", "hourly rate", "pay rate starts", "PIN must be 6"])
    assert.ok(bad.body.error.includes(part), `mentions ${part}: ${bad.body.error}`);

  const { r, body } = await person({ locationIds: ["loc-campus", "loc-downtown"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.message, /^Added Test Person [a-j]+ \(No\. 9999\d{4}\)\.$/);
  const row = await byNumber(body.number);
  assert.deepEqual([row.status, row.rate, row.locations.length, row.role], ["Active", 15, 2, "Server"]);

  const [[cred]] = await pool.query("SELECT PinHash FROM EmployeeCredential WHERE EmployeeID = ?", [row.id]);
  assert.match(cred.PinHash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/, "stored like every other PIN");
  assert.equal((await signIn(body.number, "246810")).r.status, 200);
});

test("employee numbers and emails must be free", async () => {
  const taken = await person({ number: "10420003" });
  assert.equal(taken.r.status, 409);
  assert.equal(taken.r.body.error, "Employee number 10420003 is already in use. Choose another.");
  const email = await person({ email: "sam@brewbean.example.com" });
  assert.equal(email.r.status, 409);
  assert.match(email.r.body.error, /email/);
});

test("a pay rate can't start inside a closed pay period", async () => {
  const [[closed]] = await pool.query("SELECT DATE_FORMAT(StartDate, '%Y-%m-%d') AS d FROM PayPeriod WHERE BusinessID = 'biz-brewbean' AND Closed LIMIT 1");
  const { r } = await person({ startsOn: closed.d });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already closed/);
});

test("editing: a blank PIN keeps it, a new one resets it; a new pay rate keeps the old one in history", async () => {
  const { body } = await person();
  const row = await byNumber(body.number);
  const edit = (extra) => maya.call(`/employees/${row.id}`, { ...body, startsOn: row.latest.startsOn, pin: "", ...extra });

  assert.equal((await edit({ firstName: "Renamed" })).status, 200);
  assert.equal((await byNumber(body.number)).firstName, "Renamed");
  assert.equal((await signIn(body.number, "246810")).r.status, 200, "blank PIN kept the old one");

  assert.equal((await edit({ pin: "135790" })).status, 200);
  assert.equal((await signIn(body.number, "246810")).r.status, 401);
  assert.equal((await signIn(body.number, "135790")).r.status, 200);

  // A new rate must start after the current one and outside a closed pay period
  const same = await edit({ rate: "16.00" });
  assert.equal(same.status, 409);
  assert.match(same.body.error, /must start after the current one/);
  const [[closed]] = await pool.query("SELECT DATE_FORMAT(EndDate, '%Y-%m-%d') AS d FROM PayPeriod WHERE BusinessID = 'biz-brewbean' AND Closed ORDER BY EndDate DESC LIMIT 1");
  if (closed && closed.d > row.latest.startsOn) assert.equal((await edit({ rate: "16.00", startsOn: closed.d })).status, 409);
  const later = new Date(Date.parse(`${row.latest.startsOn}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10);
  const raised = await edit({ rate: "16.00", startsOn: later });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  assert.match(raised.body.message, /New rate \$16\.00 from/);

  const [rates] = await pool.query("SELECT HourlyRate AS rate, EffectiveFrom AS f, EffectiveTo AS t FROM EmployeePayRate WHERE EmployeeID = ? ORDER BY EffectiveFrom", [row.id]);
  assert.equal(rates.length, 2, "the old rate is kept");
  assert.equal(Number(rates[0].rate), 15);
  assert.equal(rates[0].t.getTime(), rates[1].f.getTime(), "the old rate ends where the new one starts");
  assert.equal(rates[1].t, null);
  const after = await byNumber(body.number);
  assert.deepEqual([after.rate, after.next.rate, after.next.startsOn], [15, 16, later], "today's rate until the raise starts");

  // Taking a location away switches it off rather than deleting it
  assert.equal((await edit({ rate: "16.00", startsOn: later, locationIds: ["loc-downtown"] })).status, 200);
  const [links] = await pool.query("SELECT LocationID AS id, Active AS active FROM EmployeeLocation WHERE EmployeeID = ? ORDER BY LocationID", [row.id]);
  assert.deepEqual(links.map((l) => [l.id, !!l.active]), [["loc-campus", false], ["loc-downtown", true]]);
});

test("taking someone off a café signs them out, but adding one doesn't", async () => {
  const { r, body } = await person({ locationIds: ["loc-campus"] });
  assert.equal(r.status, 200);
  const worker = await signIn(body.number, "246810");
  assert.equal((await maya.call(`/employees/${r.body.id}`, { ...body, locationIds: ["loc-campus", "loc-downtown"], pin: "" })).status, 200);
  assert.equal((await worker.c.call("/session")).status, 200, "an added café leaves them signed in");
  assert.equal((await maya.call(`/employees/${r.body.id}`, { ...body, locationIds: ["loc-downtown"], pin: "" })).status, 200);
  assert.equal((await worker.c.call("/session")).status, 401, "their session was fixed to the café they no longer work at");
});

test("nobody changes their own role or deactivates themselves", async () => {
  const me = (await list()).employees.find((e) => e.id === "emp-maya");
  const body = { firstName: me.firstName, lastName: me.lastName, number: me.number, email: me.email, roleId: "role-manager",
    locationIds: me.locations.map((l) => l.id), rate: me.latest ? String(me.latest.rate) : "0", startsOn: me.latest?.startsOn || "", pin: "" };
  const role = await maya.call("/employees/emp-maya", body);
  assert.equal(role.status, 409);
  assert.equal(role.body.error, "You can't change your own role.");
  const off = await maya.call("/employees/emp-maya/active", { active: false });
  assert.equal(off.status, 409);
  assert.equal(off.body.error, "You can't deactivate yourself.");
});

test("deactivating waits for clock-out, signs them out, and Reactivate brings them back", async () => {
  const { body } = await person();
  const row = await byNumber(body.number);
  const them = (await signIn(body.number, body.pin)).c;
  assert.equal((await them.call("/shift/clock-in", {})).status, 200);
  const busy = await maya.call(`/employees/${row.id}/active`, { active: false });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /clocked in/);
  await pool.query("UPDATE TimeEntry SET ClockInAt = ClockInAt - INTERVAL 1 MINUTE WHERE EmployeeID = ? AND TimeEntryStatusCode = 1", [row.id]);
  assert.equal((await them.call("/shift/clock-out", {})).status, 200);

  assert.equal((await maya.call(`/employees/${row.id}/active`, { active: false })).status, 200);
  assert.equal((await them.call("/session")).status, 401, "signed out everywhere");
  assert.equal((await signIn(body.number, body.pin)).r.status, 404, "can't sign in while inactive");
  assert.equal((await byNumber(body.number)).status, "Inactive");

  assert.equal((await maya.call(`/employees/${row.id}/active`, { active: true })).status, 200);
  assert.equal((await signIn(body.number, body.pin)).r.status, 200);
});

test("Unlock lifts a PIN lockout", async () => {
  const { body } = await person();
  for (let i = 0; i < 5; i++) await signIn(body.number, "000000");
  assert.equal((await signIn(body.number, body.pin)).r.status, 423);
  const row = await byNumber(body.number);
  assert.equal(row.status, "Locked");
  const out = await maya.call(`/employees/${row.id}/unlock`, {});
  assert.equal(out.status, 200);
  assert.equal((await byNumber(body.number)).status, "Active");
  assert.equal((await signIn(body.number, body.pin)).r.status, 200);
});

test("a pay-rate start date must be a real day", async () => {
  const { r } = await person({ startsOn: "2026-02-31" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /date the pay rate starts/);
});

test("changing someone's role signs them out; someone with no café can't sign in", async () => {
  const { r, body } = await person();
  assert.equal(r.status, 200);
  const worker = await signIn(body.number, "246810");
  assert.equal(worker.r.status, 200);
  assert.equal((await worker.c.call("/session")).status, 200);

  assert.equal((await maya.call(`/employees/${r.body.id}`, { ...body, pin: "" })).status, 200);
  assert.equal((await worker.c.call("/session")).status, 200, "an edit that keeps the role leaves them signed in");
  assert.equal((await maya.call(`/employees/${r.body.id}`, { ...body, roleId: "role-barista", pin: "" })).status, 200);
  assert.equal((await worker.c.call("/session")).status, 401, "a new role ends their sessions");
  assert.equal((await signIn(body.number, "246810")).r.status, 200, "and they sign in again with it");

  await pool.query("UPDATE EmployeeLocation SET Active = FALSE WHERE EmployeeID = ?", [r.body.id]);
  const none = await signIn(body.number, "246810");
  assert.equal(none.r.status, 403);
  assert.match(none.r.body.error, /aren't assigned to a café/);
});
