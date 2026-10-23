const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { start, client, pool } = require("./env");

let env, wasOpen;
const LINE = { key: "a", variantId: "var-amer-s", quantity: 2, modifierIds: ["mod-caramel"] };
const order = (c, extra = {}) => c.call("/customer/orders", { idempotencyKey: crypto.randomUUID(), paymentMethod: "Card", guestName: "Test", items: [LINE], ...extra });
const row = async (id) => (await pool.query("SELECT OrderStatusCode AS status, ChannelCode AS channel, CustomerID AS customer, Total AS total FROM Orders WHERE OrderID = ?", [id]))[0][0];

test.before(async () => {
  env = await start();
  [[{ wasOpen }]] = await pool.query("SELECT AcceptsOnlineOrders AS wasOpen FROM Location WHERE LocationID = 'loc-campus'");
  await pool.query("UPDATE Location SET AcceptsOnlineOrders = FALSE WHERE LocationID = 'loc-campus'");
});
test.after(async () => {
  await pool.query("UPDATE Location SET AcceptsOnlineOrders = ? WHERE LocationID = 'loc-campus'", [wasOpen]);
  env.server.close();
  await pool.end();
});

test("a guest order is saved as pending payment, with no payment taken", async () => {
  const r = await order(client(env.base));
  assert.equal(r.status, 200);
  const o = await row(r.body.orderId);
  assert.deepEqual([o.status, o.channel, o.customer], [1, 3, null]);
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM Payment WHERE OrderID = ?", [r.body.orderId]);
  assert.equal(n, 0, "choosing Card must not record a payment");
  const [[cost]] = await pool.query(
    `SELECT oi.UnitCost, oi.LineCost, oi.Quantity, SUM(c.QuantityUsed * c.UnitCost) AS components
       FROM OrderItem oi JOIN OrderItemComponent c ON c.OrderItemID = oi.OrderItemID
      WHERE oi.OrderID = ? GROUP BY oi.OrderItemID`, [r.body.orderId]);
  assert.ok(Number(cost.UnitCost) > 0);
  assert.equal(Number(cost.LineCost), Number(Number(cost.components).toFixed(6)));
});

test("prices come from the server; a customer can't send their own discount", async () => {
  const c = client(env.base);
  const plain = await c.call("/customer/price", { items: [LINE] });
  const r = await order(c, { discount: { applyTo: "order", type: "percent", value: 100, reason: "Regular" }, promotionId: "anything" });
  assert.equal(r.status, 200);
  assert.equal(r.body.totalCents, plain.body.totalCents);
  assert.equal(Math.round(Number((await row(r.body.orderId)).total) * 100), plain.body.totalCents);
});

test("pressing Place order twice makes one order", async () => {
  const c = client(env.base);
  const body = { idempotencyKey: crypto.randomUUID(), paymentMethod: "Cash", guestName: "Twice", items: [LINE] };
  const [a, b] = await Promise.all([c.call("/customer/orders", body), c.call("/customer/orders", body)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(a.body.orderId, b.body.orderId);
  const [used] = await pool.query(
    `SELECT c.StockItemID, SUM(c.QuantityUsed) AS qty FROM OrderItemComponent c
       JOIN OrderItem oi ON oi.OrderItemID = c.OrderItemID WHERE oi.OrderID = ? GROUP BY c.StockItemID`, [a.body.orderId]);
  const [moved] = await pool.query(
    "SELECT StockItemID, QuantityChange FROM InventoryTransaction WHERE OrderID = ? AND TransactionTypeCode = 2", [a.body.orderId]);
  assert.ok(used.length > 0);
  assert.equal(moved.length, used.length, "one stock movement per component, even on retry");
  for (const u of used) assert.equal(Number(moved.find((m) => m.StockItemID === u.StockItemID).QuantityChange), -Number(u.qty));
});

test("bad checkouts are refused", async () => {
  const c = client(env.base);
  assert.equal((await order(c, { paymentMethod: "Bitcoin" })).status, 400);
  assert.equal((await order(c, { guestName: " " })).status, 400);
  assert.equal((await order(c, { items: [] })).status, 400);
  assert.equal((await order(c, { items: [{ ...LINE, quantity: 0 }] })).status, 400);
  assert.equal((await order(c, { items: [{ ...LINE, modifierIds: ["mod-not-offered"] }] })).status, 400);
  assert.equal((await c.call("/customer/login", { phone: "123" })).status, 400);
  assert.equal((await c.call("/customer/login", { phone: "2025550199" })).status, 404);
});

test("customers see only their own orders, and staff pages stay closed to them", async () => {
  const ben = client(env.base);
  assert.equal((await ben.call("/customer/login", { phone: "(312) 555-0142" })).status, 200);
  const mine = await order(ben, { guestName: undefined });
  assert.equal((await row(mine.body.orderId)).customer !== null, true);
  const legacy = { OrderID: crypto.randomUUID() };
  await pool.query(
    "INSERT INTO Orders (OrderID, LocationID, BusinessID, ChannelCode, CustomerID) VALUES (?, 'loc-downtown', 'biz-brewbean', 2, ?)",
    [legacy.OrderID, (await row(mine.body.orderId)).customer]);
  assert.ok((await ben.call("/customer/my-orders")).body.orders.some((o) => o.id === legacy.OrderID));
  assert.equal((await ben.call(`/customer/orders/${legacy.OrderID}`)).status, 200, "existing online history remains accessible to its owner");
  assert.equal((await client(env.base).call(`/customer/orders/${legacy.OrderID}`)).status, 404);
  const guest = await order(client(env.base));

  assert.equal((await ben.call(`/customer/orders/${mine.body.orderId}`)).status, 200);
  assert.equal((await ben.call(`/customer/orders/${guest.body.orderId}`)).status, 404, "a guest's order");
  assert.equal((await client(env.base).call(`/customer/orders/${mine.body.orderId}`)).status, 404, "a member's order, signed out");
  assert.ok((await ben.call("/customer/my-orders")).body.orders.some((o) => o.id === mine.body.orderId));
  assert.equal((await client(env.base).call("/customer/my-orders")).status, 401);
  assert.equal((await ben.call("/session")).status, 401, "a customer sign-in is not a staff sign-in");

  await ben.call("/customer/logout", {});
  assert.equal((await ben.call("/customer/session")).body.signedIn, false);
  assert.equal((await ben.call("/customer/my-orders")).status, 401);
});

test("genuine online orders remain blocked while counter checkout works", async () => {
  await assert.rejects(pool.tx((conn) => conn.query(
    "INSERT INTO Orders (OrderID, LocationID, BusinessID, ChannelCode) VALUES (?, 'loc-campus', 'biz-brewbean', 2)",
    [crypto.randomUUID()])), /not taking online orders/);
  const r = await order(client(env.base), { channelCode: 2, locationId: "loc-downtown", businessId: "other" });
  assert.equal(r.status, 200);
  const [[saved]] = await pool.query("SELECT ChannelCode, LocationID, BusinessID FROM Orders WHERE OrderID = ?", [r.body.orderId]);
  assert.deepEqual(saved, { ChannelCode: 3, LocationID: "loc-campus", BusinessID: "biz-brewbean" });
});

test("customer sessions cannot use the employee register", async () => {
  const c = client(env.base);
  assert.equal((await c.call("/customer/login", { phone: "(312) 555-0142" })).status, 200);
  assert.equal((await c.call("/register/orders", { items: [LINE], payment: { method: "cash" } })).status, 401);
  assert.equal((await c.call("/register/catalog")).status, 401);
});

test("failed stock deduction rolls the entire checkout back", async () => {
  const [[before]] = await pool.query("SELECT COUNT(*) AS n FROM Orders");
  const r = await order(client(env.base), { items: [{ ...LINE, quantity: 99 }] });
  assert.notEqual(r.status, 200);
  const [[after]] = await pool.query("SELECT COUNT(*) AS n FROM Orders");
  assert.equal(after.n, before.n);
});