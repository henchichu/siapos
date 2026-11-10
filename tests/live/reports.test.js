// Needs the dev database. Adds one real test sale and refunds it (orders can't be deleted).
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, admin, pickUp, TEST_CARD, creds } = require("./env");
const { mondayOf, shiftPay } = require("../../server/overtime");

let env, maya, leo, sam, priya;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login", creds(number)); assert.equal(r.status, 200); return c; };
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });
// History: a day per row between From and To
const report = async (c, q) => { const r = await c.call(`/reports/revenue?${new URLSearchParams({ by: "day", ...q })}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const rowFor = (body, day) => body.rows.find((r) => r.key === day) || { orders: 0, gross: 0, discounts: 0, refunds: 0, net: 0 };

test.before(async () => {
  env = await start();
  maya = await signIn("10420001", "111111");
  leo = await signIn("10420002", "222222");
  sam = await signIn("10420003", "333333");
  priya = await signIn("10420004", "444444");
});
test.after(async () => { env.server.close(); await pool.end(); await admin.end(); });

test("owners and managers open Reports, for the one location they signed in to", async () => {
  assert.equal((await page(maya, "/reports.html")).status, 200);
  assert.equal((await page(leo, "/reports.html")).status, 200);
  assert.equal((await page(sam, "/reports.html")).headers.get("location"), "/register.html");
  assert.equal((await sam.call("/reports/options")).status, 403);
  assert.equal((await sam.call("/reports/revenue")).status, 403);

  for (const who of [maya, leo]) {
    const opts = (await who.call("/reports/options")).body;
    assert.equal(opts.canPickAll, undefined);
    assert.deepEqual(opts.locations.map((l) => l.id), [opts.location], "only the location they signed in to");
    const other = "loc-elsewhere";
    assert.equal((await who.call(`/reports/revenue?location=${other}`)).status, 403);
    assert.equal((await who.call("/reports/revenue?location=all")).status, 403);
    assert.equal((await live(who, {})).location, opts.locations[0].name);
  }
});

test("the dates are checked", async () => {
  const bad = async (q, msg) => { const r = await maya.call(`/reports/revenue?${new URLSearchParams(q)}`); assert.equal(r.status, 400); assert.match(r.body.error, msg); };
  await bad({ from: "nope", to: "2026-10-01" }, /From and a To/);
  await bad({ from: "2026-10-05", to: "2026-10-01" }, /on or before/);
  await bad({ from: "2010-01-01", to: "2026-10-01" }, /3660 days or fewer/);
});

test("every day in the range has a row, and the rows and cards agree", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 864e5).toISOString().slice(0, 10);
  const all = await report(maya, { from, to: today, location: "loc-downtown" });
  assert.equal(all.rows.length, 14);
  assert.equal(all.rows[0].key, from);
  assert.equal(all.rows.at(-1).key, today);
  assert.equal(all.rows.reduce((a, d) => a + d.net, 0), all.total.net);
  for (const r of all.rows) assert.equal(r.net, r.gross - r.discounts - r.refunds);
  assert.equal(all.rows.reduce((a, r) => a + r.orders, 0), all.total.orders);
  assert.equal(all.cards.net, all.total.net);
  assert.equal(all.rows.at(-1).runningNet, all.total.net);
});

test("every breakdown panel adds up to its card, to the cent", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 864e5).toISOString().slice(0, 10);
  for (const body of [await report(maya, { from, to: today }), await live(maya, { day: today })]) {
    const { cards: c, breakdown: b } = body;
    const sum = (list, k = "value") => list.reduce((a, x) => a + x[k], 0);
    assert.equal(sum(b.channels), c.net, "net by channel");
    assert.equal(sum(b.payments), c.net, "net by payment method");
    assert.equal(sum(b.categories), c.gross, "gross by category");
    assert.equal(sum(b.categories, "base") + sum(b.categories, "addons"), c.gross, "base plus add-ons");
    assert.equal(sum(b.discounts), c.discounts, "discounts by promotion");
    assert.equal(sum(b.refunds), c.refunds, "refunds by reason");
    assert.equal(sum(b.ingredients), c.cost, "cost by ingredient");
    assert.equal(sum(b.profit), c.profit, "profit by category");
    assert.equal(sum(b.profit, "net"), c.net, "net by category");
    assert.equal(c.avgOrder, c.orders ? Math.round(c.net / c.orders) : 0);
    assert.ok(body.previous.cards && "net" in body.previous.cards, "the last period's cards");
  }
});

const top = async (c, q) => { const r = await c.call(`/reports/top-sellers?${new URLSearchParams(q)}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test("Top sellers: one ranking by units sold, matching what was sold", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10);
  const all = await top(maya, { from, to: today, location: "loc-downtown" });
  assert.ok(all.rows.length > 3);
  assert.deepEqual(all.rows.map((r) => r.rank), all.rows.map((_, i) => i + 1));
  for (let i = 1; i < all.rows.length; i++) assert.ok(all.rows[i - 1].units >= all.rows[i].units, "most units first");
  for (const r of all.rows) assert.equal(r.margin, r.revenue - r.cost);
  assert.equal(all.cards.revenue, all.total.revenue);
  assert.equal(all.cards.marginPct, Math.round((all.total.margin / all.total.revenue) * 1000) / 10);

  // the same sales, counted straight from the order lines
  const [[sold]] = await pool.query(
    `SELECT SUM(oi.Quantity) AS units, SUM(oi.NetAmount) AS revenue, SUM(oi.LineCost) AS cost
       FROM Orders o JOIN Location l USING (LocationID) JOIN OrderItem oi USING (OrderID) JOIN ProductVariant v USING (VariantID) JOIN Product p ON p.ProductID = v.ProductID
      WHERE o.LocationID = 'loc-downtown' AND o.OrderStatusCode IN (2, 3, 4, 5, 7) AND DATE(CONVERT_TZ(o.OrderDateTime, '+00:00', l.TimeZone)) BETWEEN ? AND ?`, [from, today]);
  assert.equal(all.total.units, Number(sold.units));
  assert.equal(all.total.revenue, Math.round(Number(sold.revenue) * 100));
  assert.ok(Math.abs(all.total.cost - Number(sold.cost) * 100) <= all.rows.length, "cost, give or take a cent a row");

  const coffee = await top(maya, { from, to: today, location: "loc-downtown", category: "cat-coffee" });
  assert.ok(coffee.rows.length && coffee.rows.every((r) => r.category === "Coffee") && coffee.rows[0].rank === 1);
  assert.equal(coffee.category, "Coffee");
  assert.equal((await top(maya, { from, to: today, location: "loc-downtown", category: "none" })).rows.length, 0, "every demo product has a category");
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
    const daily = await live(leo, { by: "day" });
    assert.ok(daily.rows.every((r) => r.orderDetails.every((o) => !("cost" in o) && !("profit" in o) && !("rawCost" in o))));
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
  const all = await losses(maya, { from, to: today, location: "loc-downtown" });
  assert.ok(all.rows.length > 0);
  assert.ok(all.rows.every((r) => ["Broken or spilled", "Spoiled or expired", "Stolen"].includes(r.reason)), "count corrections aren't losses");
  assert.equal(all.total.reports, all.rows.reduce((a, r) => a + r.reports, 0));
  assert.equal(all.total.cost, all.rows.reduce((a, r) => a + r.cost, 0));
  assert.equal(all.cards.lost, all.total.cost);
  assert.equal(all.cards.reports, all.total.reports);

  // the same losses, and the stock that left the shelves, straight from the ledger
  const [[lost]] = await pool.query(
    `SELECT COUNT(*) AS n, SUM(-t.QuantityChange * t.UnitCost) AS cost, (SELECT SUM(-x.QuantityChange * x.UnitCost) FROM InventoryTransaction x JOIN Location y USING (LocationID)
             WHERE x.LocationID = 'loc-downtown' AND x.TransactionTypeCode IN (2, 5, 6, 7) AND DATE(CONVERT_TZ(x.TransactionDateTime, '+00:00', y.TimeZone)) BETWEEN ? AND ?) AS used
       FROM InventoryTransaction t JOIN Location l USING (LocationID)
      WHERE t.LocationID = 'loc-downtown' AND t.TransactionTypeCode IN (5, 6, 7) AND DATE(CONVERT_TZ(t.TransactionDateTime, '+00:00', l.TimeZone)) BETWEEN ? AND ?`, [from, today, from, today]);
  assert.equal(all.total.reports, Number(lost.n));
  assert.ok(Math.abs(all.total.cost - Number(lost.cost) * 100) <= all.rows.length, "cost, give or take a cent a row");
  assert.ok(Math.abs(all.cards.lostPct - (Number(lost.cost) / Number(lost.used)) * 100) < 0.1);

  const spoiled = await losses(maya, { from, to: today, location: "loc-downtown", reason: "spoiled" });
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

  // Priya got a raise when the current period started
  assert.deepEqual(person(await labor(maya, { period: "pp-prev", location: "loc-downtown" }), "Priya Shah").rates, [1650]);
  assert.deepEqual(person(await labor(maya, { period: "pp-curr", location: "loc-downtown" }), "Priya Shah").rates, [1725]);

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

  // Net sales are Revenue history's for the same dates
  const now = await labor(maya, { period: "pp-curr", location: "loc-downtown" });
  const sales = await report(maya, { from: now.period.start, to: now.period.end, location: "loc-downtown" });
  assert.equal(now.cards.net, sales.total.net);
  assert.equal(now.cards.laborPct, Math.round((now.cards.cost / now.cards.net) * 1000) / 10);
});

test("hours past 40 in a Monday to Sunday week are overtime at 1.5x", async () => {
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
  assert.ok(await week("") >= 2400, "Leo already has 40 hours this week");

  const q = { period: "pp-curr", location: "loc-downtown" };
  const before = person(await labor(maya, q), "Leo Brandt");
  const id = `te-test-ot-${Date.now()}`;
  await admin.query(
    `INSERT INTO TimeEntry (TimeEntryID, EmployeeID, LocationID, BusinessID, PayPeriodID, ClockInAt, ClockOutAt, TimeEntryStatusCode)
     VALUES (?, 'emp-leo', 'loc-downtown', 'biz-brewbean', 'pp-curr', CONVERT_TZ(TIMESTAMP(?, '20:00'), 'America/Chicago', '+00:00'),
             CONVERT_TZ(TIMESTAMP(?, '22:00'), 'America/Chicago', '+00:00'), 2)`, [id, sunday, sunday]);
  try {
    const after = person(await labor(maya, q), "Leo Brandt");
    assert.equal(after.shifts - before.shifts, 1);
    assert.equal(after.overtimeHours - before.overtimeHours, 2, "all of it past 40");
    assert.equal(after.regularHours - before.regularHours, 0);
    assert.equal(after.pay - before.pay, shiftPay({ regular: 0, overtime: 120 }, 2400), "2 hours at $36");
  } finally {
    await admin.query("DELETE FROM TimeEntry WHERE TimeEntryID = ?", [id]);
  }
});

const live = async (c, q) => { const r = await c.call(`/reports/revenue?${new URLSearchParams(q)}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test("Revenue: live today hour by hour, or Monday to today, and history by day, month and year, all agreeing", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const hours = await live(maya, { location: "loc-downtown" });
  assert.deepEqual([hours.day, hours.by, hours.isToday], [today, "hour", true]);
  assert.ok(hours.rows.length > 0);
  hours.rows.forEach((r, i) => i && assert.equal(r.key, hours.rows[i - 1].key + 1, "every hour from the first sale to the last"));
  let running = 0;
  for (const r of hours.rows) { running += r.net; assert.equal(r.runningNet, running); assert.equal(r.profit, r.net - r.cost); }
  const same = await report(maya, { from: today, to: today, location: "loc-downtown" });
  for (const k of ["orders", "gross", "discounts", "refunds", "net"]) assert.equal(hours.total[k], same.total[k], k);
  assert.equal(hours.cards.net, hours.total.net);

  const week = await live(maya, { location: "loc-downtown", by: "day" });
  assert.equal(week.rows[0].key, mondayOf(today));
  assert.equal(week.rows.at(-1).key, today);
  const sameWeek = await report(maya, { from: mondayOf(today), to: today, location: "loc-downtown" });
  assert.equal(week.total.net, sameWeek.total.net);
  assert.equal(week.total.orders, sameWeek.total.orders);
  // History by month and by year adds up to the same dates by day
  const y = Number(today.slice(0, 4));
  const daily = await report(maya, { from: `${y - 1}-01-01`, to: today, location: "loc-downtown" });
  const monthly = await report(maya, { from: `${y - 1}-01-01`, to: today, by: "month", location: "loc-downtown" });
  assert.equal(monthly.rows.length, 12 + Number(today.slice(5, 7)), "every month, the quiet ones too");
  assert.equal(monthly.rows[0].key, `${y - 1}-01`);
  assert.equal(monthly.rows.at(-1).key, today.slice(0, 7));
  assert.equal(monthly.total.net, daily.total.net, "By month adds up to By day over the same dates");
  assert.equal(monthly.total.orders, daily.total.orders);
  const yearly = await report(maya, { from: `${y - 1}-01-01`, to: today, by: "year", location: "loc-downtown" });
  assert.deepEqual(yearly.rows.map((r) => r.key), [String(y - 1), String(y)]);
  assert.equal(yearly.total.net, daily.total.net, "By year adds up to By day over the same dates");
  assert.equal(yearly.cards.tips, daily.cards.tips);

  const earlier = await live(maya, { location: "loc-downtown", day: "2026-01-05" });
  assert.equal(earlier.isToday, false);
  assert.equal((await maya.call("/reports/revenue?day=nope")).status, 400);
  assert.equal((await leo.call("/reports/revenue?location=all")).status, 403);
});

test("Revenue period order details reconcile with every day, month and year", async () => {
  const options = await maya.call("/reports/options");
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const { today } = options.body;
  for (const by of ["day", "month", "year"]) {
    const body = await report(maya, { from: `${today.slice(0, 4)}-01-01`, to: today, by });
    assert.ok(body.rows.some((r) => r.orderDetails.length));
    for (const row of body.rows) {
      assert.equal(new Set(row.orderDetails.map((o) => o.id)).size, row.orderDetails.length);
      for (const key of ["orders", "gross", "discounts", "refunds", "net", "cost", "profit"])
        assert.equal(row.orderDetails.reduce((sum, o) => sum + o[key], 0), row[key], `${by} ${row.key}: ${key}`);
      for (const order of row.orderDetails) {
        assert.ok(order.id && Number.isInteger(order.number));
        assert.equal(order.net, order.gross - order.discounts - order.refunds);
        assert.equal(order.profit, order.net - order.cost);
        assert.equal("rawCost" in order, false);
      }
    }
  }
  const week = await live(maya, { day: today, by: "day" });
  assert.ok(week.rows.every((r) => Array.isArray(r.orderDetails)));
  const hours = await live(maya, { day: today });
  assert.ok(hours.rows.every((r) => !("orderDetails" in r)));
});
test("a sale counts today, and its refund comes off today", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const q = { from: today, to: today, location: "loc-downtown" };
  const before = rowFor(await report(maya, q), today);
  const latte = async () => (await top(maya, q)).rows.find((r) => r.product === "Latte") || { units: 0, revenue: 0 };
  const latteBefore = await latte();
  const tipsBefore = (await live(maya, { location: "loc-downtown" })).cards.tips;

  const sale = await priya.call("/register/orders", { items: [{ key: "a", variantId: "var-latte-l", quantity: 1 }], payment: { method: "card", card: TEST_CARD, tip: "1.00" } });
  assert.equal(sale.status, 200);
  assert.equal(sale.body.totalCents, 579, "a large latte: $5.25 and $0.54 tax");
  const sold = await report(maya, q);
  const after = rowFor(sold, today);
  assert.deepEqual([after.orders - before.orders, after.gross - before.gross, after.net - before.net], [1, 525, 525], "the tip isn't a sale");
  const latteAfter = await latte();
  assert.equal((await live(maya, { location: "loc-downtown" })).cards.tips - tipsBefore, 100, "the $1.00 tip is in Revenue's Tips");
  assert.deepEqual([latteAfter.units - latteBefore.units, latteAfter.revenue - latteBefore.revenue], [1, 525], "and one more latte in Top sellers");

  await pickUp(sale.body.orderNumber);
  const found = (await priya.call(`/refunds/order?q=${sale.body.orderNumber}`)).body;
  const refund = await priya.call("/refunds", { managerNumber: "10420002", managerPin: "222222", reason: "test", orderId: found.orderId,
    lines: [{ orderItemId: found.lines[0].orderItemId, qty: 1, restock: false }] });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  const back = await report(maya, q);
  const end = rowFor(back, today);
  assert.deepEqual([end.orders - before.orders, end.refunds - before.refunds, end.net - before.net], [1, 525, 0], "still an order, but the money went back");
  assert.equal((await live(maya, { location: "loc-downtown" })).cards.tips - tipsBefore, 100, "a refund never takes the tip back");
  const detail = end.orderDetails.find((o) => o.id === found.orderId);
  assert.deepEqual([detail.orders, detail.gross, detail.refunds, detail.net], [1, 525, 525, 0]);
  const [[original]] = await pool.query("SELECT OrderDateTime FROM Orders WHERE OrderID = ?", [found.orderId]);
  try {
    await pool.query("UPDATE Orders SET OrderDateTime = UTC_TIMESTAMP() - INTERVAL 1 YEAR WHERE OrderID = ?", [found.orderId]);
    const later = rowFor(await report(maya, q), today).orderDetails.find((o) => o.id === found.orderId);
    assert.deepEqual([later.orders, later.gross, later.discounts, later.refunds, later.net, later.cost], [0, 0, 0, 525, -525, 0]);
  } finally {
    await pool.query("UPDATE Orders SET OrderDateTime = ? WHERE OrderID = ?", [original.OrderDateTime, found.orderId]);
  }
});

const customers = async (c, q) => { const r = await c.call(`/reports/customers?${new URLSearchParams(q)}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

test("Customers: who may see it, and the figures agree with the orders", async () => {
  assert.equal((await sam.call("/reports/customers")).status, 403);
  assert.equal((await leo.call("/reports/customers?location=loc-campus")).status, 403, "only the location signed in to");
  const { today } = (await maya.call("/reports/options")).body;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 89 * 864e5).toISOString().slice(0, 10);
  const q = { from, to: today };
  const all = await customers(maya, q);
  assert.ok(all.rows.length > 0);
  assert.equal(new Set(all.rows.map((r) => r.id)).size, all.rows.length, "each customer once");
  assert.equal(all.cards.customers, all.rows.length);
  assert.equal(all.total.spend, all.rows.reduce((a, r) => a + r.spend, 0));
  assert.equal(all.cards.averageSpend, Math.round(all.total.spend / all.rows.length));
  for (const r of all.rows) {
    for (const k of ["r", "f", "m"]) assert.ok(r[k] >= 1 && r[k] <= 5, k);
    assert.ok(r.lastOrder <= today && r.daysSince >= 0 && r.segment);
    assert.ok(!("email" in r) && !("phone" in r), "no contact details");
  }

  // the same customer's orders, counted one by one
  const who = all.rows[0];
  const [orders] = await pool.query(
    `SELECT o.OrderID, (SELECT SUM(oi.NetAmount) FROM OrderItem oi WHERE oi.OrderID = o.OrderID) AS sold,
            (SELECT COALESCE(SUM(r.Amount - r.TaxAmount), 0) FROM Refund r WHERE r.OrderID = o.OrderID AND r.RefundStatusCode = 2) AS back
       FROM Orders o JOIN Location l USING (LocationID)
      WHERE o.CustomerID = ? AND o.OrderStatusCode IN (2, 3, 4, 5) AND DATE(CONVERT_TZ(o.OrderDateTime, '+00:00', l.TimeZone)) BETWEEN ? AND ?`, [who.id, from, today]);
  const counted = orders.filter((o) => o.sold !== null);
  assert.equal(who.orders, counted.length);
  assert.equal(who.spend, counted.reduce((a, o) => a + Math.round((Number(o.sold) - Number(o.back)) * 100), 0));

});

test("Customers: grouped by membership tier, each customer once", async () => {
  const { today, tiers } = (await maya.call("/reports/options")).body;
  assert.deepEqual(tiers.map((t) => t.name), ["Bean", "Gold", "No membership"]);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 89 * 864e5).toISOString().slice(0, 10);
  const q = { from, to: today };
  const all = await customers(maya, q);
  const [accounts] = await pool.query("SELECT la.CustomerID AS id, t.Name AS name FROM LoyaltyAccount la JOIN MembershipTier t USING (TierID) WHERE la.Active");
  for (const r of all.rows) assert.equal(r.membership, accounts.find((a) => a.id === r.id)?.name || "No membership", r.customer);

  assert.deepEqual(all.byMembership.map((g) => g.name), ["Bean", "Gold", "No membership"]);
  assert.equal(all.byMembership.reduce((a, g) => a + g.customers, 0), all.cards.customers, "the groups add up to the customers");
  for (const g of all.byMembership) {
    const members = all.rows.filter((r) => r.membership === g.name);
    assert.equal(g.customers, members.length);
    assert.equal(g.averageSpend, members.length ? Math.round(members.reduce((a, r) => a + r.spend, 0) / members.length) : null);
    const one = await customers(maya, { ...q, tier: g.id });
    assert.deepEqual(one.rows, members, "filtering keeps the same customers, scores and segments");
    assert.deepEqual(one.byMembership.map((x) => x.name), [g.name]);
    assert.equal(one.membership, g.name);
  }
  assert.equal(all.membership, "All memberships");
  assert.deepEqual(all.minDays, { atRisk: 30, lapsed: 60 });
  assert.equal((await maya.call(`/reports/customers?${new URLSearchParams({ ...q, tier: "nope" })}`)).status, 400);

  // a closed account is no membership
  const [[{ id }]] = await pool.query("SELECT la.CustomerID AS id FROM LoyaltyAccount la WHERE la.Active AND la.CustomerID IN (?) LIMIT 1", [all.rows.map((r) => r.id)]);
  await pool.query("UPDATE LoyaltyAccount SET Active = FALSE WHERE CustomerID = ?", [id]);
  try {
    assert.equal((await customers(maya, q)).rows.find((r) => r.id === id).membership, "No membership");
  } finally {
    await pool.query("UPDATE LoyaltyAccount SET Active = TRUE WHERE CustomerID = ?", [id]);
  }
});

test("Customers: a partial refund lowers spend; refunded in full, the order stops counting", async () => {
  const { today } = (await maya.call("/reports/options")).body;
  const q = { from: today, to: today, location: "loc-downtown" };
  const ava = async () => (await customers(maya, q)).rows.find((r) => r.id === "cus-ava") || { orders: 0, spend: 0 };
  const before = await ava();

  const sale = await priya.call("/register/orders", { customerId: "cus-ava", items: [{ key: "a", variantId: "var-latte-l", quantity: 1 }, { key: "b", variantId: "var-latte-l", quantity: 1 }], payment: { method: "card", card: TEST_CARD } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const sold = await ava();
  assert.deepEqual([sold.orders - before.orders, sold.spend - before.spend], [1, 1050], "two lattes, before tax");

  await pickUp(sale.body.orderNumber);
  const found = (await priya.call(`/refunds/order?q=${sale.body.orderNumber}`)).body;
  const back = async (line) => {
    const r = await priya.call("/refunds", { managerNumber: "10420002", managerPin: "222222", reason: "test", orderId: found.orderId, lines: [{ orderItemId: line.orderItemId, qty: 1, restock: false }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  await back(found.lines[0]);
  const part = await ava();
  assert.deepEqual([part.orders - before.orders, part.spend - before.spend], [1, 525], "one latte back");
  // with a partial refund in it, her breakdowns and her drill-down still come to her row
  const report = await customers(maya, q);
  const bar = report.breakdown.byCustomer.find((c) => c.key === "cus-ava");
  assert.equal(bar.value, part.spend);
  assert.equal(bar.parts.reduce((a, p) => a + p.value, 0), part.spend, "her spend by category, the refund taken off");
  const detail = (await maya.call(`/reports/customers/cus-ava?${new URLSearchParams(q)}`)).body;
  assert.deepEqual([detail.totals.orders, detail.totals.spend], [part.orders, part.spend]);
  assert.equal(detail.byCategory.reduce((a, c) => a + c.value, 0), part.spend);
  assert.equal(detail.orders.find((o) => o.number === sale.body.orderNumber).refunded, 525);
  await back(found.lines[1]);
  const none = await ava();
  assert.deepEqual([none.orders, none.spend], [before.orders, before.spend], "as if it never happened");
});

test("a report date must be a real day", async () => {
  const r = await maya.call("/reports/revenue?from=2026-02-31&to=2026-03-05");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /From and a To/);
});
