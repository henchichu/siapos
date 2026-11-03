// What the dev assistant manager (Ana, 10420006 / PIN 666666, Brewbean Downtown only) may and may not do.
// Needs the dev database. Sells croissants at both cafés; every refund asked for here is rejected again.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, pickUp, creds } = require("./env");

let env, ana, manager, priya, sam, priyas, downtown;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login", creds(number)); assert.equal(r.status, 200); return c; };
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
  for (const r of (await manager.call("/refunds/waiting")).body.refunds) await manager.call(`/refunds/${r.id}/reject`, {});
};

test.before(async () => {
  env = await start();
  [ana, manager, priya, sam] = await Promise.all([["10420006", "666666"], ["10420001", "111111"], ["10420004", "444444"], ["10420003", "333333"]].map(([n, p]) => signIn(n, p)));
  priyas = await sale(priya); downtown = await sale(sam);
});
test.after(async () => { await reject(); env.server.close(); await pool.end(); });

test("Ana signs in as an assistant manager with the manager menu", async () => {
  const me = (await ana.call("/session")).body;
  assert.deepEqual([me.employeeName, me.roleName, me.locationName], ["Ana Torres", "Assistant manager", "Brewbean Downtown"]);
  assert.deepEqual(me.nav, ["Needs attention", "Register", "Kitchen", "Orders", "Rewards", "Products", "Inventory", "My shift"], "the manager menu without Reports and Employees");
});

test("her menu has Orders, a server's doesn't", async () => {
  assert.ok((await ana.call("/session")).body.nav.includes("Orders"));
  assert.ok(!(await sam.call("/session")).body.nav.includes("Orders"));
});

test("Reports are closed to her: no menu item, the page goes home, the API says 403", async () => {
  const me = (await ana.call("/session")).body;
  assert.ok(!me.nav.includes("Reports"));
  assert.equal((await page(ana, "/reports.html")).headers.get("location"), "/attention.html", "she opens to Needs attention");
  assert.equal((await ana.call("/reports/options")).status, 403);
  assert.equal((await ana.call("/reports/sales-by-day")).status, 403);
});

test("every page on her menu opens", async () => {
  for (const p of ["/register.html", "/kitchen.html", "/attention.html", "/orders.html", "/order.html", "/products.html", "/inventory.html", "/shift.html"])
    assert.equal((await page(ana, p)).status, 200, p);
});

test("Orders: her café, with details and the refund button", async () => {
  const r = await ana.call("/orders");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.filters.locations.map((l) => l.id), ["loc-downtown"]);
  assert.ok(r.body.orders.some((o) => o.orderNumber === priyas.number));
  assert.ok(r.body.orders.some((o) => o.orderNumber === downtown.number));
  const d = await ana.call(`/orders/${priyas.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.canRefund, true);
  assert.equal((await ana.call(`/orders/${downtown.id}`)).status, 200);
});

test("a café she no longer works at can't be searched, refunded or stocked from here", async () => {
  assert.equal((await ana.call(`/refunds/order?q=${priyas.number}`)).status, 200);
  await pool.query("UPDATE EmployeeLocation SET Active = FALSE WHERE EmployeeID = 'emp-ana'");
  try {
    assert.equal((await ana.call(`/refunds/order?q=${downtown.number}`)).status, 404);
    const direct = await ana.call("/refunds", { orderId: downtown.id, reason: "x", ...ANA, lines: lineOf(downtown) });
    assert.equal(direct.status, 403, "even with the order id in hand");
    assert.equal((await ana.call("/refunds/request", { orderId: downtown.id, reason: "x", lines: lineOf(downtown) })).status, 403);
    assert.equal((await ana.call("/inventory")).status, 403);
  } finally {
    await pool.query("UPDATE EmployeeLocation SET Active = TRUE WHERE EmployeeID = 'emp-ana'");
  }
});

test("Needs attention: stock and timecards, but not refunds waiting for an override", async () => {
  const r = await ana.call("/attention");
  assert.equal(r.status, 200);
  for (const k of ["losses", "reorder", "timecards"]) assert.ok(r.body[k] && Array.isArray(r.body[k].rows), k);
  assert.equal(r.body.refunds, null);
  assert.equal((await ana.call("/refunds/waiting")).status, 403);
});

test("refunds: she can ask for one, but cannot answer one", async () => {
  const asked = await ana.call("/refunds/request", { orderId: priyas.id, reason: "Wrong order", lines: lineOf(priyas) });
  assert.equal(asked.status, 200);
  const waiting = (await manager.call("/refunds/waiting")).body.refunds.find((r) => r.orderNumber === priyas.number);
  assert.ok(waiting, "it waits on a manager's list");
  assert.equal((await ana.call(`/refunds/${waiting.id}/approve`, { managerNumber: "10420002", managerPin: "222222" })).status, 403, "approve needs the override permission");
  assert.equal((await ana.call(`/refunds/${waiting.id}/reject`, {})).status, 403);
  assert.equal((await manager.call(`/refunds/${waiting.id}/reject`, {})).status, 200);
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

test("inventory and products: she can see and change them", async () => {
  assert.equal((await ana.call("/inventory")).status, 200);
  assert.equal((await ana.call("/products/list")).status, 200);
  const cup = (await ana.call("/inventory")).body.rows.find((r) => r.id === "stk-cup-12");
  assert.equal((await ana.call("/inventory/change", { stockItemId: "stk-cup-12", threshold: String(cup.reorderAt) })).status, 200);
});

test("a wrong password is refused and a server's number can't sign for her", async () => {
  const bad = client(env.base);
  assert.equal((await bad.call("/login", { ...creds("10420006"), password: "not-her-password" })).status, 401);
  await pool.query("UPDATE EmployeeCredential SET FailedPinAttempts = 0, LockedUntil = NULL WHERE EmployeeID = 'emp-ana'");
  assert.equal((await ana.call("/refunds", { orderId: priyas.id, reason: "x", managerNumber: "10420003", managerPin: "333333", lines: lineOf(priyas) })).status, 403);
});

test("the one who asked for a refund may approve it themselves, or someone else may", async () => {
  const asked = await sale(sam);
  assert.equal((await manager.call("/refunds/request", { orderId: asked.id, lines: lineOf(asked), reason: "own request" })).status, 200);
  const [waiting] = (await manager.call("/refunds/waiting")).body.refunds.filter((r) => r.orderNumber === asked.number);
  assert.equal((await manager.call(`/refunds/${waiting.id}/approve`, { managerNumber: "10420002", managerPin: "222222" })).status, 200, "self-approval is allowed");
});
