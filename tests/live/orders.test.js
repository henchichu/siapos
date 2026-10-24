// Needs the dev database. Sells croissants as Sam (Downtown) so there is an order from today to find; it is refunded in one test and left otherwise.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, pickUp } = require("./env");

let env, leo, maya, sam, jordan, mine;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });
const MGR = { managerNumber: "10420002", managerPin: "222222" };
const search = (q = {}) => leo.call(`/orders?${new URLSearchParams(q)}`);
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Chicago" }); // the demo cafés' day, not UTC's

async function sale(n = 2) {
  const made = await sam.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: n }], payment: { method: "cash" } });
  assert.equal(made.status, 200);
  await pickUp(made.body.orderNumber);
  const [[row]] = await pool.query("SELECT OrderID AS id FROM Orders WHERE OrderNumber = ?", [made.body.orderNumber]);
  return { number: made.body.orderNumber, id: row.id };
}

test.before(async () => {
  env = await start();
  [leo, maya, sam, jordan] = await Promise.all([["10420002", "222222"], ["10420001", "111111"], ["10420003", "333333"], ["10420005", "555555"]].map(([n, p]) => signIn(n, p)));
});
test.after(async () => { env.server.close(); await pool.end(); });

test("only roles that may search orders get the pages and the API", async () => {
  for (const who of [sam, jordan]) {
    assert.equal((await who.call("/orders")).status, 403);
    assert.equal((await who.call("/orders/anything")).status, 403);
  }
  assert.equal((await page(sam, "/orders.html")).headers.get("location"), "/register.html");
  assert.equal((await page(sam, "/order.html?id=x")).headers.get("location"), "/register.html");
  assert.equal((await page(jordan, "/orders.html")).headers.get("location"), "/kitchen.html");
  for (const who of [leo, maya]) {
    assert.equal((await who.call("/orders")).status, 200);
    assert.equal((await page(who, "/orders.html")).status, 200);
    assert.equal((await page(who, "/order.html")).status, 200);
  }
  assert.equal((await fetch(`${env.base}/api/orders`)).status, 401, "signed out");
});

test("a search defaults to today and finds a fresh sale with the fields the page lists", async () => {
  const s = await sale();
  const r = await search();
  assert.equal(r.status, 200);
  assert.equal(r.body.from, today); assert.equal(r.body.to, today);
  const row = r.body.orders.find((o) => o.orderNumber === s.number);
  assert.ok(row, "the sale is listed");
  assert.deepEqual([row.employee, row.member, row.status], ["Sam Rivera", "Walk-in", "Completed"]);
  assert.ok(row.source && row.source !== "Online" && row.total > 0 && row.timeZone);
  assert.ok(r.body.orders.every((o, i, a) => i === 0 || a[i - 1].placedAt >= o.placedAt), "newest first");
  const f = r.body.filters;
  assert.deepEqual(f.locations.map((l) => l.id), mine = ["loc-campus", "loc-downtown"]);
  assert.ok(f.employees.some((e) => e.name === "Sam Rivera") && f.statuses.length === 7 && f.statuses[4].name === "Completed");
});

test("filters combine, and bad input is refused", async () => {
  const s = await sale();
  const found = async (q) => (await search({ from: today, to: today, ...q })).body.orders?.some((o) => o.orderNumber === s.number);
  assert.equal(await found({ employeeId: "emp-sam", status: "5", locationId: "loc-downtown" }), true);
  assert.equal(await found({ employeeId: "all", status: "any", locationId: "all" }), true);
  assert.equal(await found({ employeeId: "emp-priya" }), false, "another employee");
  assert.equal(await found({ status: "6" }), false, "another status");
  assert.equal(await found({ locationId: "loc-campus" }), false, "another location");
  assert.equal(await found({ from: "2020-01-01", to: "2020-01-31" }), false, "another month");

  for (const bad of [{ from: "yesterday" }, { to: "2026-02-31" }, { from: "2026-13-01" }, { to: "2026-10-32" }, { from: "2026-10-02", to: "2026-10-01" }, { from: "2020-01-01", to: "2026-01-01" }, { status: "9" }, { status: "1 OR 1=1" }])
    assert.equal((await search(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await search({ locationId: "loc-nowhere" })).status, 403);
  const injected = await search({ employeeId: "' OR '1'='1" });
  assert.equal(injected.body.count, 0, "an id is only ever a value");
});

test("a search lists at most 200 rows but counts them all", async () => {
  const r = await search({ from: "2026-01-01", to: "2026-12-31" });
  assert.equal(r.status, 200);
  assert.equal(r.body.shown, 200);
  assert.equal(r.body.orders.length, Math.min(r.body.count, 200));
});

test("details reconcile, and a refund shows up in payments and status", async () => {
  const s = await sale(2);
  const d = (await leo.call(`/orders/${s.id}`)).body;
  assert.equal(d.orderNumber, s.number);
  assert.equal(d.status, "Completed");
  assert.equal(d.canRefund, true);
  assert.equal(d.items.length, 1);
  assert.deepEqual([d.items[0].name, d.items[0].qty, d.items[0].options], ["Butter croissant", 2, []]);
  assert.equal(d.items.reduce((a, i) => a + i.lineTotal, 0), d.totals.subtotal);
  const sum = d.totals.subtotal - d.totals.discount + (d.totals.taxIncluded ? 0 : d.totals.tax);
  assert.equal(Math.round(sum * 100), Math.round(d.totals.total * 100), "items - discount + tax = total");
  assert.deepEqual(d.payments.map((p) => [p.type, p.method, p.amount]), [["Payment", "Cash", d.total]]);
  assert.deepEqual(d.where.location, "Brewbean Downtown");
  assert.deepEqual([d.where.rungUpBy, d.where.customer, d.where.pickup], ["Sam Rivera", "Walk-in", null]);
  assert.ok(d.history.every((h) => h.status && h.at));

  const lookup = (await sam.call(`/refunds/order?q=${s.number}`)).body;
  const done = await sam.call("/refunds", { orderId: s.id, reason: "Test", ...MGR, lines: [{ orderItemId: lookup.lines[0].orderItemId, qty: 2, restock: false }] });
  assert.equal(done.status, 200);
  const after = (await leo.call(`/orders/${s.id}`)).body;
  assert.equal(after.status, "Refunded");
  assert.deepEqual(after.payments.map((p) => [p.type, p.status]), [["Payment", "Refunded"], ["Refund", "Completed"]]);
  assert.equal(after.payments[1].amount, -d.total);
  assert.equal(after.canRefund, true);
});

test("an order that isn't completed can't be refunded; an online one has no register and a pickup", async () => {
  const [[pending]] = await pool.query("SELECT OrderID AS id FROM Orders WHERE OrderStatusCode = 1 LIMIT 1");
  if (pending) assert.equal((await leo.call(`/orders/${pending.id}`)).body.canRefund, false);
  const [[online]] = await pool.query("SELECT OrderID AS id FROM Orders WHERE ChannelCode = 2 LIMIT 1");
  const d = (await leo.call(`/orders/${online.id}`)).body;
  assert.equal(d.source, "Online");
  assert.deepEqual([d.where.register, d.where.rungUpBy], [null, "Online"]);
  assert.ok(d.where.pickup && "at" in d.where.pickup);
  const listed = (await search({ from: "2026-01-01", to: "2026-12-31", status: "any" })).body.orders.find((o) => o.id === online.id);
  if (listed) assert.equal(listed.source, "Online");
});

test("a missing order is a 404, and an order outside my locations isn't visible", async () => {
  assert.equal((await leo.call("/orders/no-such-order")).status, 404);
  const s = await sale();
  assert.equal((await leo.call(`/orders/${s.id}`)).status, 200);
  await pool.query("UPDATE EmployeeLocation SET Active = FALSE WHERE EmployeeID = 'emp-leo' AND LocationID = 'loc-downtown'");
  try {
    assert.equal((await leo.call(`/orders/${s.id}`)).status, 404, "Downtown is no longer Leo's");
    const r = await search({ from: today, to: today });
    assert.ok(!r.body.orders.some((o) => o.orderNumber === s.number));
    assert.deepEqual(r.body.filters.locations.map((l) => l.id), ["loc-campus"]);
    assert.equal((await search({ locationId: "loc-downtown" })).status, 403);
  } finally {
    await pool.query("UPDATE EmployeeLocation SET Active = TRUE WHERE EmployeeID = 'emp-leo' AND LocationID = 'loc-downtown'");
  }
  assert.equal((await leo.call(`/orders/${s.id}`)).status, 200);
});
