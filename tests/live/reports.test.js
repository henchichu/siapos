// Needs the dev database. Adds one real test sale and refunds it (orders can't be deleted).
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, pickUp } = require("./env");
const { mondayOf, shiftPay } = require("../../server/overtime");

let env, maya, leo, sam;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });
const report = async (c, q) => { const r = await c.call(`/reports/sales-by-day?${new URLSearchParams(q)}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const rowFor = (body, day, location) => body.rows.find((r) => r.day === day && r.location === location) || { orders: 0, gross: 0, discounts: 0, refunds: 0, net: 0 };

test.before(async () => {
  env = await start();
  maya = await signIn("10420001", "111111");
  leo = await signIn("10420002", "222222");
  sam = await signIn("10420003", "333333");
});
test.after(async () => { env.server.close(); await pool.end(); });

test("owners and managers open Reports; only an owner adds up every location", async () => {
  assert.equal((await page(maya, "/reports.html")).status, 200);
  assert.equal((await page(leo, "/reports.html")).status, 200);
  assert.equal((await page(sam, "/reports.html")).headers.get("location"), "/register.html");
  assert.equal((await sam.call("/reports/options")).status, 403);
  assert.equal((await sam.call("/reports/sales-by-day")).status, 403);

  const owner = (await maya.call("/reports/options")).body;
  assert.equal(owner.canPickAll, true);
  assert.equal(owner.location, "all");
  assert.deepEqual(owner.locations.map((l) => l.name), ["Brewbean Campus", "Brewbean Downtown"]);

  const manager = (await leo.call("/reports/options")).body;
  assert.equal(manager.canPickAll, false);
  assert.deepEqual(manager.locations.map((l) => l.id), [manager.location], "only the location he signed in to");
  const other = owner.locations.find((l) => l.id !== manager.location).id;
  assert.equal((await leo.call(`/reports/sales-by-day?location=${other}`)).status, 403);
  assert.equal((await leo.call("/reports/sales-by-day?location=all")).status, 403);
  assert.equal((await report(leo, {})).location, manager.locations[0].name);
});

test("the dates are checked", async () => {
  const bad = async (q, msg) => { const r = await maya.call(`/reports/sales-by-day?${new URLSearchParams(q)}`); assert.equal(r.status, 400); assert.match(r.body.error, msg); };
  await bad({ from: "nope", to: "2026-10-01" }, /From and a To/);
  await bad({ from: "2026-10-05", to: "2026-10-01" }, /on or before/);
  await bad({ from: "2025-01-01", to: "2026-10-01" }, /366 days or fewer/);
});

test("every day in the range has a bar, and the bars, rows and cards agree", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 864e5).toISOString().slice(0, 10);
  const all = await report(maya, { from, to: today, location: "all" });
  assert.equal(all.days.length, 14);
  assert.equal(all.days[0].day, from);
  assert.equal(all.days.at(-1).day, today);
  assert.equal(all.days.reduce((a, d) => a + d.net, 0), all.total.net);
  for (const r of all.rows) assert.equal(r.net, r.gross - r.discounts - r.refunds);
  assert.equal(all.rows.reduce((a, r) => a + r.orders, 0), all.total.orders);
  assert.equal(all.cards.net, all.total.net);
  assert.equal(all.cards.orders, all.total.orders);
  assert.equal(all.cards.average, Math.round((all.total.gross - all.total.discounts) / all.total.orders));

  // All locations is the two locations added up
  const one = await Promise.all(["loc-campus", "loc-downtown"].map((location) => report(maya, { from, to: today, location })));
  assert.equal(one.reduce((a, b) => a + b.total.net, 0), all.total.net);
  assert.equal(one.reduce((a, b) => a + b.cards.tax, 0), all.cards.tax);
});

test("selling a gift card isn't a sale", async () => {
  const [[gift]] = await pool.query(
    `SELECT DATE_FORMAT(CONVERT_TZ(o.OrderDateTime, '+00:00', l.TimeZone), '%Y-%m-%d') AS day, o.LocationID AS loc, l.Name AS name
       FROM Orders o JOIN Location l USING (LocationID) WHERE o.OrderID = 'ord-dt-gift-sale'`);
  const [[every]] = await pool.query(
    `SELECT SUM(oi.NetAmount + oi.DiscountAmount) AS gross FROM Orders o JOIN Location l USING (LocationID) JOIN OrderItem oi ON oi.OrderID = o.OrderID
      WHERE o.LocationID = ? AND o.OrderStatusCode IN (2, 3, 4, 5, 7) AND DATE(CONVERT_TZ(o.OrderDateTime, '+00:00', l.TimeZone)) = ?`, [gift.loc, gift.day]);
  const body = await report(maya, { from: gift.day, to: gift.day, location: gift.loc });
  assert.equal(rowFor(body, gift.day, gift.name).gross, Math.round(Number(every.gross) * 100) - 2500, "the $25 card is left out");
});

const top = async (c, q) => { const r = await c.call(`/reports/top-sellers?${new URLSearchParams(q)}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test("Top sellers: one ranking by units sold, matching what was sold", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10);
  const all = await top(maya, { from, to: today, location: "all" });
  assert.ok(all.rows.length > 3);
  assert.deepEqual(all.rows.map((r) => r.rank), all.rows.map((_, i) => i + 1));
  for (let i = 1; i < all.rows.length; i++) assert.ok(all.rows[i - 1].units >= all.rows[i].units, "most units first");
  for (const r of all.rows) assert.equal(r.margin, r.revenue - r.cost);
  assert.ok(!all.rows.some((r) => /gift/i.test(r.product)), "gift cards aren't listed");
  assert.equal(all.cards.revenue, all.total.revenue);
  assert.equal(all.cards.marginPct, Math.round((all.total.margin / all.total.revenue) * 1000) / 10);

  // the same sales, counted straight from the order lines
  const [[sold]] = await pool.query(
    `SELECT SUM(oi.Quantity) AS units, SUM(oi.NetAmount) AS revenue, SUM(oi.LineCost) AS cost
       FROM Orders o JOIN Location l USING (LocationID) JOIN OrderItem oi USING (OrderID) JOIN ProductVariant v USING (VariantID) JOIN Product p ON p.ProductID = v.ProductID
      WHERE NOT p.IsGiftCard AND o.OrderStatusCode IN (2, 3, 4, 5, 7) AND DATE(CONVERT_TZ(o.OrderDateTime, '+00:00', l.TimeZone)) BETWEEN ? AND ?`, [from, today]);
  assert.equal(all.total.units, Number(sold.units));
  assert.equal(all.total.revenue, Math.round(Number(sold.revenue) * 100));
  assert.ok(Math.abs(all.total.cost - Number(sold.cost) * 100) <= all.rows.length, "cost, give or take a cent a row");

  const coffee = await top(maya, { from, to: today, location: "all", category: "cat-coffee" });
  assert.ok(coffee.rows.length && coffee.rows.every((r) => r.category === "Coffee") && coffee.rows[0].rank === 1);
  assert.equal(coffee.category, "Coffee");
  assert.equal((await top(maya, { from, to: today, location: "all", category: "none" })).rows.length, 0, "every demo product has a category");
  assert.equal((await maya.call("/reports/top-sellers?category=nope")).status, 400);
});

test("Top sellers and Stock losses leave out costs for a role that can't see them", async () => {
  await pool.query("DELETE FROM RolePermission WHERE RoleID = 'role-manager' AND PermissionCode = 13");
  try {
    assert.equal((await leo.call("/reports/options")).body.seesCosts, false);
    const raw = await top(leo, {});
    assert.equal(raw.seesCosts, false);
    assert.equal(raw.cards.cost, null);
    assert.ok(raw.rows.every((r) => !("cost" in r) && !("margin" in r)) && !("cost" in raw.total));
    const now = await live(leo, {});
    assert.deepEqual([now.cards.cost, now.cards.profit], [null, null]);
    assert.ok(now.rows.every((r) => !("cost" in r) && !("profit" in r)));
    const lost = await losses(leo, {});
    assert.deepEqual([lost.seesCosts, lost.cards.lost, lost.cards.lostPct], [false, null, null]);
    assert.ok(lost.rows.every((r) => !("cost" in r)) && !("cost" in lost.total));
  } finally {
    await pool.query("INSERT INTO RolePermission (RoleID, BusinessID, PermissionCode) VALUES ('role-manager', 'biz-brewbean', 13)");
  }
});

const losses = async (c, q) => { const r = await c.call(`/reports/losses?${new URLSearchParams(q)}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test("Stock losses: by item and reason, at cost, against the stock used", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 864e5).toISOString().slice(0, 10);
  const all = await losses(maya, { from, to: today, location: "all" });
  assert.ok(all.rows.length > 0);
  assert.ok(all.rows.every((r) => ["Broken or spilled", "Spoiled or expired", "Stolen"].includes(r.reason)), "count corrections aren't losses");
  assert.equal(all.total.reports, all.rows.reduce((a, r) => a + r.reports, 0));
  assert.equal(all.total.cost, all.rows.reduce((a, r) => a + r.cost, 0));
  assert.equal(all.cards.lost, all.total.cost);
  assert.equal(all.cards.reports, all.total.reports);

  // the same losses, and the stock that left the shelves, straight from the ledger
  const [[lost]] = await pool.query(
    `SELECT COUNT(*) AS n, SUM(-t.QuantityChange * t.UnitCost) AS cost, (SELECT SUM(-x.QuantityChange * x.UnitCost) FROM InventoryTransaction x JOIN Location y USING (LocationID)
             WHERE x.TransactionTypeCode IN (2, 5, 6, 7) AND DATE(CONVERT_TZ(x.TransactionDateTime, '+00:00', y.TimeZone)) BETWEEN ? AND ?) AS used
       FROM InventoryTransaction t JOIN Location l USING (LocationID)
      WHERE t.TransactionTypeCode IN (5, 6, 7) AND DATE(CONVERT_TZ(t.TransactionDateTime, '+00:00', l.TimeZone)) BETWEEN ? AND ?`, [from, today, from, today]);
  assert.equal(all.total.reports, Number(lost.n));
  assert.ok(Math.abs(all.total.cost - Number(lost.cost) * 100) <= all.rows.length, "cost, give or take a cent a row");
  assert.ok(Math.abs(all.cards.lostPct - (Number(lost.cost) / Number(lost.used)) * 100) < 0.1);

  const spoiled = await losses(maya, { from, to: today, location: "all", reason: "spoiled" });
  assert.ok(spoiled.rows.length && spoiled.rows.every((r) => r.reason === "Spoiled or expired"));
  assert.equal(spoiled.cards.commonReason, "Spoiled or expired");
  assert.equal(spoiled.reason, "Spoiled or expired");
  assert.equal((await maya.call("/reports/losses?reason=nope")).status, 400);
});

test("a loss reported in Inventory shows up today; a count correction doesn't", async () => {
  const { today, location } = (await leo.call("/reports/options")).body;
  const q = { from: today, to: today, location, reason: "stolen" };
  const cups = (b) => b.rows.find((r) => r.item === "12 oz cup") || { reports: 0, amount: 0, cost: 0 };
  const before = await losses(leo, q);
  const change = (body) => leo.call("/inventory/change", { locationId: location, stockItemId: "stk-cup-12", ...body });
  assert.equal((await change({ type: "adjust", reason: "stolen", quantity: "2" })).status, 200);
  assert.equal((await change({ type: "adjust", reason: "correction", quantity: "-1" })).status, 200);
  const after = await losses(leo, q);
  assert.deepEqual([cups(after).reports - cups(before).reports, cups(after).amount - cups(before).amount, after.cards.reports - before.cards.reports], [1, 2, 1]);
  assert.equal(cups(after).unit, "each");
  assert.ok(cups(after).cost > cups(before).cost);
  assert.equal((await change({ type: "restock", quantity: "3", total: "0.33" })).status, 200, "put the cups back");
});

const labor = async (c, q) => { const r = await c.call(`/reports/labor?${new URLSearchParams(q)}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const person = (b, name) => b.rows.find((r) => r.employee === name) || { shifts: 0, regularHours: 0, overtimeHours: 0, pay: 0 };

test("Labor cost: a pay period's shifts at the rate of the day, against that period's sales", async () => {
  const opts = (await maya.call("/reports/options")).body;
  assert.ok(opts.seesLabor);
  const current = opts.payPeriods.find((p) => p.id === opts.payPeriod);
  assert.ok(current.start <= opts.today && opts.today <= current.end, "opens on the period holding today");
  assert.equal((await sam.call("/reports/labor")).status, 403);
  assert.equal((await maya.call("/reports/labor?period=nope")).status, 400);

  // Sam got a raise when the current period started
  assert.deepEqual(person(await labor(maya, { period: "pp-prev", location: "all" }), "Sam Rivera").rates, [1650]);
  assert.deepEqual(person(await labor(maya, { period: "pp-curr", location: "all" }), "Sam Rivera").rates, [1725]);

  // A closed period with no overtime: pay is each shift's paid minutes at its rate, straight from the timecards
  const prev = await labor(maya, { period: "pp-prev", location: "loc-downtown" });
  const [[sum]] = await pool.query(
    `SELECT COUNT(*) AS n, SUM(m) AS minutes, SUM(ROUND(m * rate * 100 / 60)) AS pay FROM (
       SELECT GREATEST(0, TIMESTAMPDIFF(MINUTE, te.ClockInAt, te.ClockOutAt) - te.UnpaidBreakMinutes) AS m,
              (SELECT r.HourlyRate FROM EmployeePayRate r WHERE r.EmployeeID = te.EmployeeID AND r.EffectiveFrom <= te.ClockInAt
                  AND (r.EffectiveTo IS NULL OR r.EffectiveTo > te.ClockInAt) LIMIT 1) AS rate
         FROM TimeEntry te WHERE te.PayPeriodID = 'pp-prev' AND te.LocationID = 'loc-downtown' AND te.TimeEntryStatusCode IN (2, 3)) x`);
  assert.equal(prev.total.overtimeHours, 0);
  assert.equal(prev.total.shifts, Number(sum.n));
  assert.equal(prev.cards.hours, Number(sum.minutes) / 60);
  assert.equal(prev.total.pay, Number(sum.pay));
  assert.equal(prev.cards.cost, prev.rows.reduce((a, r) => a + r.pay, 0));

  // Net sales are Sales by day's for the same dates
  const now = await labor(maya, { period: "pp-curr", location: "all" });
  const sales = await report(maya, { from: now.period.start, to: now.period.end, location: "all" });
  assert.equal(now.cards.net, sales.total.net);
  assert.equal(now.cards.laborPct, Math.round((now.cards.cost / now.cards.net) * 1000) / 10);
});

test("hours past 40 in a Monday to Sunday week are overtime at 1.5x, counting every location", async () => {
  const { payPeriods } = (await maya.call("/reports/options")).body;
  const period = payPeriods.find((p) => p.id === "pp-curr");
  const monday = mondayOf(period.start) === period.start ? period.start : mondayOf(new Date(Date.parse(`${period.start}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10));
  const sunday = new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * 864e5).toISOString().slice(0, 10);
  assert.ok(sunday <= period.end, "a whole week inside the period");
  const week = async (where) => Number((await pool.query(
    `SELECT COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(MINUTE, te.ClockInAt, te.ClockOutAt) - te.UnpaidBreakMinutes)), 0) AS m
       FROM TimeEntry te JOIN Location l USING (LocationID)
      WHERE te.EmployeeID = 'emp-leo' AND te.TimeEntryStatusCode IN (2, 3) ${where}
        AND DATE(CONVERT_TZ(te.ClockInAt, '+00:00', l.TimeZone)) BETWEEN ? AND ?`, [monday, sunday]))[0][0].m);
  const everywhere = await week(""), campus = await week("AND te.LocationID = 'loc-campus'");
  assert.ok(everywhere >= 2400 && campus < 2400, "Leo's 40 hours are split between the two cafés");

  const q = { period: "pp-curr", location: "loc-campus" };
  const before = person(await labor(maya, q), "Leo Brandt");
  const id = `te-test-ot-${Date.now()}`;
  await pool.query(
    `INSERT INTO TimeEntry (TimeEntryID, EmployeeID, LocationID, BusinessID, PayPeriodID, ClockInAt, ClockOutAt, TimeEntryStatusCode)
     VALUES (?, 'emp-leo', 'loc-campus', 'biz-brewbean', 'pp-curr', CONVERT_TZ(TIMESTAMP(?, '20:00'), 'America/Chicago', '+00:00'),
             CONVERT_TZ(TIMESTAMP(?, '22:00'), 'America/Chicago', '+00:00'), 2)`, [id, sunday, sunday]);
  try {
    const after = person(await labor(maya, q), "Leo Brandt");
    assert.equal(after.shifts - before.shifts, 1);
    assert.equal(after.overtimeHours - before.overtimeHours, 2, "all of it past 40, though his Campus hours alone are under 40");
    assert.equal(after.regularHours - before.regularHours, 0);
    assert.equal(after.pay - before.pay, shiftPay({ regular: 0, overtime: 120 }, 2400), "2 hours at $36");
  } finally {
    await pool.query("DELETE FROM TimeEntry WHERE TimeEntryID = ?", [id]);
  }
});

const live = async (c, q) => { const r = await c.call(`/reports/live?${new URLSearchParams(q)}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test("Live sales: today hour by hour, or Monday to today, agreeing with Sales by day", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const hours = await live(maya, { location: "all" });
  assert.deepEqual([hours.day, hours.by, hours.isToday], [today, "hour", true]);
  assert.ok(hours.rows.length > 0);
  hours.rows.forEach((r, i) => i && assert.equal(r.key, hours.rows[i - 1].key + 1, "every hour from the first sale to the last"));
  let running = 0;
  for (const r of hours.rows) { running += r.net; assert.equal(r.runningNet, running); assert.equal(r.profit, r.net - r.cost); }
  const same = await report(maya, { from: today, to: today, location: "all" });
  for (const k of ["orders", "gross", "discounts", "refunds", "net"]) assert.equal(hours.total[k], same.total[k], k);
  assert.equal(hours.cards.net, hours.total.net);

  const week = await live(maya, { location: "all", by: "day" });
  assert.equal(week.rows[0].key, mondayOf(today));
  assert.equal(week.rows.at(-1).key, today);
  const sameWeek = await report(maya, { from: mondayOf(today), to: today, location: "all" });
  assert.equal(week.total.net, sameWeek.total.net);
  assert.equal(week.total.orders, sameWeek.total.orders);

  const earlier = await live(maya, { location: "loc-campus", day: "2026-01-05" });
  assert.equal(earlier.isToday, false);
  assert.equal((await maya.call("/reports/live?day=nope")).status, 400);
  assert.equal((await leo.call("/reports/live?location=all")).status, 403);
});

test("a sale counts today, and its refund comes off today", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const q = { from: today, to: today, location: "loc-downtown" };
  const before = rowFor(await report(maya, q), today, "Brewbean Downtown");
  const beforeTax = (await report(maya, q)).cards.tax;
  const latte = async () => (await top(maya, q)).rows.find((r) => r.product === "Latte") || { units: 0, revenue: 0 };
  const latteBefore = await latte();
  const tipsBefore = (await live(maya, { location: "loc-downtown" })).cards.tips;

  const sale = await sam.call("/register/orders", { items: [{ key: "a", variantId: "var-latte-l", quantity: 1 }], payment: { method: "card", tip: "1.00" } });
  assert.equal(sale.status, 200);
  assert.equal(sale.body.totalCents, 579, "a large latte: $5.25 and $0.54 tax");
  const sold = await report(maya, q);
  const after = rowFor(sold, today, "Brewbean Downtown");
  assert.deepEqual([after.orders - before.orders, after.gross - before.gross, after.net - before.net, sold.cards.tax - beforeTax], [1, 525, 525, 54], "the tip isn't a sale");
  const latteAfter = await latte();
  assert.equal((await live(maya, { location: "loc-downtown" })).cards.tips - tipsBefore, 100, "the $1.00 tip is in Live sales' Tips");
  assert.deepEqual([latteAfter.units - latteBefore.units, latteAfter.revenue - latteBefore.revenue], [1, 525], "and one more latte in Top sellers");

  await pickUp(sale.body.orderNumber);
  const found = (await sam.call(`/refunds/order?q=${sale.body.orderNumber}`)).body;
  const refund = await sam.call("/refunds", { managerNumber: "10420002", managerPin: "222222", reason: "test", orderId: found.orderId,
    lines: [{ orderItemId: found.lines[0].orderItemId, qty: 1, restock: false }] });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  const back = await report(maya, q);
  const end = rowFor(back, today, "Brewbean Downtown");
  assert.deepEqual([end.orders - before.orders, end.refunds - before.refunds, end.net - before.net, back.cards.tax - beforeTax], [1, 525, 0, 0], "still an order, but the money went back");
  assert.equal((await live(maya, { location: "loc-downtown" })).cards.tips - tipsBefore, 100, "a refund never takes the tip back");
});

test("a report date must be a real day", async () => {
  const r = await maya.call("/reports/sales-by-day?from=2026-02-31&to=2026-03-05");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /From and a To/);
});
