// What the dev assistant manager (Ana, 10420006 / PIN 666666, Brewbean Campus only) may and may not do.
// Needs the dev database. Sells croissants at both cafés; every refund asked for here is rejected again.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, pickUp } = require("./env");

let env, ana, leo, priya, sam, campus, downtown;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });
const ANA = { managerNumber: "10420006", managerPin: "666666" };

async function sale(who, n = 1) {
  const made = await who.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: n }], payment: { method: "cash" } });
  assert.equal(made.status, 200);
  await pickUp(made.body.orderNumber);
  const [[row]] = await pool.query("SELECT OrderID AS id FROM Orders WHERE OrderNumber = ?", [made.body.orderNumber]);
  const line = (await who.call(`/refunds/order?q=${made.body.orderNumber}`)).body.lines[0];
  return { number: made.body.orderNumber, id: row.id, line };
}
const lineOf = (s, qty = 1) => [{ orderItemId: s.line.orderItemId, qty, restock: false }];
const reject = async () => {
  for (const r of (await leo.call("/refunds/waiting")).body.refunds) await leo.call(`/refunds/${r.id}/reject`, {});
};

test.before(async () => {
  env = await start();
  [ana, leo, priya, sam] = await Promise.all([["10420006", "666666"], ["10420002", "222222"], ["10420004", "444444"], ["10420003", "333333"]].map(([n, p]) => signIn(n, p)));
  campus = await sale(priya); downtown = await sale(sam);
});
test.after(async () => { await reject(); env.server.close(); await pool.end(); });

test("Ana signs in as an assistant manager with the manager menu", async () => {
  const me = (await ana.call("/session")).body;
  assert.deepEqual([me.employeeName, me.roleName, me.locationName], ["Ana Torres", "Assistant manager", "Brewbean Campus"]);
  assert.deepEqual(me.nav, ["Register", "Kitchen", "Needs attention", "Orders", "Rewards", "Products", "Inventory", "My shift"], "the manager menu without Reports and Employees");
});

test("her Home has the Orders tile, a server's doesn't", async () => {
  assert.ok((await ana.call("/session")).body.tiles.includes("Orders"));
  assert.ok(!(await sam.call("/session")).body.tiles.includes("Orders"));
});

test("Reports and Employees are closed to her: no menu item or tile, the pages go home, the API says 403", async () => {
  const me = (await ana.call("/session")).body;
  assert.ok(!me.nav.includes("Reports") && !me.nav.includes("Employees") && !me.tiles.includes("Reports") && !me.tiles.includes("Employees"));
  for (const p of ["/reports.html", "/employees.html"]) assert.equal((await page(ana, p)).headers.get("location"), "/register.html", p);
  assert.equal((await ana.call("/reports/options")).status, 403);
  assert.equal((await ana.call("/reports/sales-by-day")).status, 403);
  assert.equal((await ana.call("/employees")).status, 403);
});

test("every page on her menu opens", async () => {
  for (const p of ["/home.html", "/register.html", "/kitchen.html", "/attention.html", "/orders.html", "/order.html", "/products.html", "/inventory.html", "/shift.html"])
    assert.equal((await page(ana, p)).status, 200, p);
});

test("Orders: only her café, with details and the refund button", async () => {
  const r = await ana.call("/orders");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.filters.locations.map((l) => l.id), ["loc-campus"]);
  assert.ok(r.body.orders.some((o) => o.orderNumber === campus.number));
  assert.ok(!r.body.orders.some((o) => o.orderNumber === downtown.number), "Downtown's sale is not listed");
  const d = await ana.call(`/orders/${campus.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.canRefund, true);
  assert.equal((await ana.call(`/orders/${downtown.id}`)).status, 404);
  assert.equal((await ana.call("/orders?locationId=loc-downtown")).status, 403);
});

test("an order at another café can't be found or refunded from here", async () => {
  assert.equal((await ana.call(`/refunds/order?q=${downtown.number}`)).status, 404);
  assert.equal((await priya.call(`/refunds/order?q=${downtown.number}`)).status, 404, "a Campus server, too");
  assert.equal((await ana.call(`/refunds/order?q=${campus.number}`)).status, 200);
  const direct = await ana.call("/refunds", { orderId: downtown.id, reason: "x", ...ANA, lines: lineOf(downtown) });
  assert.equal(direct.status, 403, "even with the order id in hand");
});

test("Needs attention: stock and timecards, but not refunds waiting for an override", async () => {
  const r = await ana.call("/attention");
  assert.equal(r.status, 200);
  for (const k of ["losses", "pendingDeliveries", "timecards"]) assert.ok(r.body[k] && Array.isArray(r.body[k].rows), k);
  assert.equal(r.body.refunds, null);
  assert.equal((await ana.call("/session")).body.canSwitch, false);
  assert.equal((await ana.call("/refunds/waiting")).status, 403);
});

test("refunds: she can ask for one at her café, but not at Downtown, and cannot answer one", async () => {
  assert.equal((await ana.call("/refunds/request", { orderId: downtown.id, reason: "x", lines: lineOf(downtown) })).status, 403);
  const asked = await ana.call("/refunds/request", { orderId: campus.id, reason: "Wrong order", lines: lineOf(campus) });
  assert.equal(asked.status, 200);
  const waiting = (await leo.call("/refunds/waiting")).body.refunds.find((r) => r.orderNumber === campus.number);
  assert.ok(waiting, "it waits on a manager's list");
  assert.equal((await ana.call(`/refunds/${waiting.id}/approve`, { managerNumber: "10420002", managerPin: "222222" })).status, 403, "approve needs the override permission");
  assert.equal((await ana.call(`/refunds/${waiting.id}/reject`, {})).status, 403);
  assert.equal((await leo.call(`/refunds/${waiting.id}/reject`, {})).status, 200);
});

test("refunds: her own number signs only what no override is needed for", async () => {
  const small = await sale(priya, 1);
  const ok = await priya.call("/refunds", { orderId: small.id, reason: "Test", ...ANA, lines: lineOf(small) });
  assert.equal(ok.status, 200, "within the limit, her approval is enough");
  const big = await sale(priya, 8); // over the refund limit, which needs permission 3
  const over = await priya.call("/refunds", { orderId: big.id, reason: "Test", ...ANA, lines: lineOf(big, 8) });
  assert.equal(over.status, 409, "over the limit, the database wants a manager with permission 3");
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM Refund WHERE OrderID = ? AND RefundStatusCode = 2", [big.id]);
  assert.equal(n.n, 0);
});

test("timecards: she sees the team but approves nothing", async () => {
  const t = await ana.call("/team/timecards");
  assert.equal(t.status, 200);
  assert.equal(t.body.canApprove, false);
  const id = t.body.rows[0]?.id ?? "x";
  for (const path of [`/team/timecards/${id}/approve`, `/team/timecards/${id}/reject`, `/team/timecards/${id}/edit`, "/team/timecards/approve-all", "/team/pay-periods/x/close"])
    assert.equal((await ana.call(path, {})).status, 403, path);
});

test("inventory and products: she can see and change them, at her café only", async () => {
  assert.equal((await ana.call("/inventory")).status, 200);
  assert.equal((await ana.call("/products/list")).status, 200);
  const cup = (await ana.call("/inventory")).body.rows.find((r) => r.id === "stk-cup-12");
  assert.equal((await ana.call("/inventory/change", { stockItemId: "stk-cup-12", threshold: String(cup.reorderAt) })).status, 200);
  assert.equal((await ana.call("/inventory?locationId=loc-downtown")).status, 403);
});

test("only an owner switches location", async () => {
  assert.equal((await ana.call("/locations")).status, 403);
  assert.equal((await ana.call("/locations/switch", { locationId: "loc-downtown" })).status, 403);
});

test("a wrong PIN is refused and a server's number can't sign for her", async () => {
  const bad = client(env.base);
  assert.equal((await bad.call("/login/pin", { employeeNumber: "10420006", pin: "000000" })).status, 401);
  await pool.query("UPDATE EmployeeCredential SET FailedPinAttempts = 0, LockedUntil = NULL WHERE EmployeeID = 'emp-ana'");
  assert.equal((await ana.call("/refunds", { orderId: campus.id, reason: "x", managerNumber: "10420003", managerPin: "333333", lines: lineOf(campus) })).status, 403);
});

test("the one who asked for a refund can't be the one who approves it, unless an owner", async () => {
  const asked = await sale(sam);
  assert.equal((await leo.call("/refunds/request", { orderId: asked.id, lines: lineOf(asked), reason: "own request" })).status, 200);
  const [waiting] = (await leo.call("/refunds/waiting")).body.refunds.filter((r) => r.orderNumber === asked.number);
  const own = await leo.call(`/refunds/${waiting.id}/approve`, { managerNumber: "10420002", managerPin: "222222" });
  assert.deepEqual([own.status, /Another manager/.test(own.body.error)], [403, true]);
  assert.equal((await leo.call(`/refunds/${waiting.id}/approve`, { managerNumber: "10420001", managerPin: "111111" })).status, 200, "another manager's or an owner's PIN works");
});
