// Needs the dev database. Checks who may see Reports, and that each report's figures add up: a sale and its refund,
// a loss reported in the kitchen, and a 45-hour week that pays overtime (its shifts are removed afterwards).
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, pickUp } = require("./env");

let env, leo, sam, jordan, maya;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });
const get = async (c, path) => { const r = await c.call(path); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`); return r.body; };
const qs = (o) => new URLSearchParams(o).toString();

test.before(async () => { env = await start(); leo = await signIn("10420002", "222222"); sam = await signIn("10420003", "333333"); jordan = await signIn("10420005", "555555"); maya = await signIn("10420001", "111111"); });
test.after(async () => { env.server.close(); await pool.end(); });

test("only roles that may see reports open them", async () => {
  assert.equal((await sam.call("/reports/options")).status, 403);
  assert.equal((await jordan.call("/reports/sales")).status, 403);
  assert.equal((await page(sam, "/reports.html")).headers.get("location"), "/register.html");
  assert.equal((await page(jordan, "/reports.html")).headers.get("location"), "/kitchen.html");
  assert.equal((await page(leo, "/reports.html")).status, 200);
});

test("Live sales: a manager sees their own location, an owner every location", async () => {
  const opts = await get(leo, "/reports/options");
  assert.deepEqual(opts.liveLocations.map((l) => l.name), ["Brewbean Campus"]);
  assert.equal(opts.locations.length, 2, "the date-range reports cover every location Leo works at");
  assert.equal((await leo.call("/reports/live?locationId=loc-downtown")).status, 403);
  assert.equal((await get(leo, "/reports/live?locationId=all")).location, "Brewbean Campus", "All means only their own");

  const owner = await get(maya, "/reports/options");
  assert.equal(owner.liveLocations.length, 2);
  const all = await get(maya, "/reports/live?locationId=all&view=day");
  assert.equal(all.location, "All locations");
  // By day runs Monday to the chosen day, one row each
  const monday = new Date(`${all.day}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  assert.equal(all.rows[0].key, monday.toISOString().slice(0, 10));
  assert.equal(all.rows.at(-1).key, all.day);
  assert.equal(all.rows.at(-1).runningNetCents, all.totals.netCents);
});

test("a sale and its refund: gross and refunds go up, net and tax stay the same", async () => {
  const today = (await get(maya, "/reports/options")).today;
  const where = { from: today, to: today, locationId: "loc-downtown" };
  const sales = () => get(maya, `/reports/sales?${qs(where)}`).then((d) => d.totals);
  const live = () => get(maya, `/reports/live?${qs({ day: today, locationId: "loc-downtown" })}`).then((d) => d.totals);
  const before = await sales();

  const made = await sam.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: 2 }], payment: { method: "cash" } });
  assert.equal(made.status, 200);
  await pickUp(made.body.orderNumber);
  const sold = await sales();
  assert.equal(sold.orders, before.orders + 1);
  const saleCents = sold.salesCents - before.salesCents;
  assert.ok(saleCents > 0);
  assert.equal(sold.netCents, before.netCents + saleCents);

  const found = (await sam.call(`/refunds/order?q=${made.body.orderNumber}`)).body;
  const refund = await sam.call("/refunds", { orderId: found.orderId, reason: "Report test", managerNumber: "10420002", managerPin: "222222",
    lines: [{ orderItemId: found.lines[0].orderItemId, qty: 2, restock: false }] });
  assert.equal(refund.status, 200);
  const after = await sales();
  assert.equal(after.grossCents, sold.grossCents, "a refund doesn't change gross");
  assert.equal(after.refundCents, before.refundCents + refund.body.itemsCents);
  assert.equal(after.netCents, before.netCents, "the whole order came back the same day");
  assert.equal(after.taxCents, before.taxCents);

  // Live sales for the same day and place says the same
  const now = await live();
  for (const k of ["orders", "grossCents", "discountCents", "refundCents", "netCents", "taxCents"]) assert.equal(now[k], after[k], k);
  assert.equal(now.profitCents, now.netCents - now.costCents);
});

test("Top sellers: one ranking, narrowed by category", async () => {
  const opts = await get(leo, "/reports/options");
  const range = { from: "2000-01-01", to: opts.today };
  assert.equal((await leo.call(`/reports/top-sellers?${qs(range)}`)).status, 400, "longer than a year");
  range.from = (() => { const d = new Date(`${opts.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString().slice(0, 10); })();

  const all = await get(leo, `/reports/top-sellers?${qs(range)}`);
  assert.ok(all.rows.length > 3);
  assert.ok(!all.rows.some((r) => r.product === "Gift card"), "selling a gift card isn't a sale");
  assert.deepEqual(all.rows.map((r) => r.rank), all.rows.map((_, i) => i + 1));
  assert.ok(all.rows.every((r, i) => i === 0 || all.rows[i - 1].units >= r.units), "most units first");
  assert.equal(all.totals.revenueCents, all.rows.reduce((a, r) => a + r.revenueCents, 0));
  assert.equal(all.totals.marginCents, all.totals.revenueCents - all.totals.costCents);

  const bakery = opts.categories.find((c) => c.name === "Bakery");
  const some = await get(leo, `/reports/top-sellers?${qs({ ...range, categoryId: bakery.id })}`);
  assert.ok(some.rows.length > 0 && some.rows.every((r) => r.category === "Bakery"));
  assert.equal(some.rows[0].rank, 1);
});

test("Stock losses: a loss reported in the kitchen shows under its reason", async () => {
  const today = (await get(leo, "/reports/options")).today;
  const where = { from: today, to: today, locationId: "loc-campus" };
  const before = await get(leo, `/reports/losses?${qs(where)}`);
  const milk = (await jordan.call("/kitchen/losses")).body.stock.find((s) => s.name === "Whole milk");
  assert.equal((await jordan.call("/kitchen/losses", { stockItemId: milk.id, reason: "spoiled", amount: "100" })).status, 200);

  const after = await get(leo, `/reports/losses?${qs(where)}`);
  assert.equal(after.totals.reports, before.totals.reports + 1);
  assert.ok(after.totals.costCents > before.totals.costCents);
  assert.ok(after.rows.some((r) => r.item === "Whole milk" && r.reason === "Spoiled or expired" && r.unit === "ml"));
  assert.ok(after.totals.lossPct > 0 && after.totals.lossPct <= 1);

  const spoiled = await get(leo, `/reports/losses?${qs({ ...where, reason: "6" })}`);
  assert.ok(spoiled.rows.length && spoiled.rows.every((r) => r.reason === "Spoiled or expired"));
  assert.equal(spoiled.totals.commonReason, "Spoiled or expired");
  assert.equal((await leo.call(`/reports/losses?${qs({ ...where, reason: "8" })}`)).status, 400, "count corrections aren't losses");
});

test("Labor cost: hours past 40 in a week are overtime at 1.5 times the rate", async () => {
  const [[next]] = await pool.query("SELECT PayPeriodID AS id, DATE_FORMAT(StartDate, '%Y-%m-%d') AS start FROM PayPeriod WHERE PayPeriodID = 'pp-next'");
  const monday = new Date(`${next.start}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7)); // the period's first Monday; Mon-Fri fits in its 14 days
  const ids = [0, 1, 2, 3, 4].map((i) => `te-report-test-${i}`);
  const [[{ rate }]] = await pool.query("SELECT HourlyRate AS rate FROM EmployeePayRate WHERE EmployeeID = 'emp-jordan' AND EffectiveTo IS NULL");
  const [[already]] = await pool.query("SELECT COUNT(*) AS n FROM TimeEntry WHERE EmployeeID = 'emp-jordan' AND PayPeriodID = 'pp-next'");
  assert.equal(already.n, 0, "the test week needs Jordan's next pay period empty");
  try {
    for (const [i, id] of ids.entries()) {
      const day = new Date(monday); day.setUTCDate(day.getUTCDate() + i);
      const d = day.toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO TimeEntry (TimeEntryID, EmployeeID, LocationID, BusinessID, PayPeriodID, ClockInAt, ClockOutAt, UnpaidBreakMinutes, TimeEntryStatusCode)
         VALUES (?, 'emp-jordan', 'loc-campus', 'biz-brewbean', 'pp-next', CONVERT_TZ(?, 'America/Chicago', '+00:00'), CONVERT_TZ(?, 'America/Chicago', '+00:00'), 30, 2)`,
        [id, `${d} 07:00`, `${d} 16:30`] // 9 paid hours a day
      );
    }
    const report = await get(leo, `/reports/labor?${qs({ payPeriodId: "pp-next", locationId: "loc-campus" })}`);
    const row = report.rows.find((r) => r.employee === "Jordan Lee");
    assert.deepEqual([row.shifts, row.regularHours, row.overtimeHours], [5, 40, 5]);
    assert.equal(row.payCents, Math.round((40 * Number(rate) + 5 * Number(rate) * 1.5) * 100));
    assert.equal(report.totals.payCents, report.rows.reduce((a, r) => a + r.payCents, 0));
    assert.equal(report.totals.hoursWorked, report.totals.regularHours + report.totals.overtimeHours);

    // Downtown has none of these shifts
    const downtown = await get(leo, `/reports/labor?${qs({ payPeriodId: "pp-next", locationId: "loc-downtown" })}`);
    assert.ok(!downtown.rows.some((r) => r.employee === "Jordan Lee"));
  } finally {
    await pool.query("DELETE FROM TimeEntry WHERE TimeEntryID IN (?)", [ids]);
  }
});
