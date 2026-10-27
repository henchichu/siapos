const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { start, startKiosk, client, phone, pool, topUp, TEST_CARD } = require("./env");

process.env.KIOSK_PHONE_SIGNIN = "1"; // phone sign-in is a demo switch on the public server
const customers = require("../../server/customers");
let env, pub, wasOpen; // env: the staff server, pub: the public order page (its own server)
const LINE = { key: "a", variantId: "var-amer-s", quantity: 2, modifierIds: ["mod-caramel"] };
const order = (c, extra = {}) => c.call("/customer/orders", { idempotencyKey: crypto.randomUUID(), paymentMethod: "Cash", guestName: "Test", items: [LINE], ...extra });
const row = async (id) => (await pool.query("SELECT OrderStatusCode AS status, ChannelCode AS channel, CustomerID AS customer, Total AS total FROM Orders WHERE OrderID = ?", [id]))[0][0];

test.beforeEach(() => customers.resetOrderLimit()); // the limit is per minute; each test starts clear
test.before(async () => {
  env = await start();
  pub = await startKiosk();
  await topUp("stk-caramel", 2000); // the test order's caramel americano takes 15 syrup a cup, so a few runs empty the shelf
  [[{ wasOpen }]] = await pool.query("SELECT AcceptsOnlineOrders AS wasOpen FROM Location WHERE LocationID = 'loc-campus'");
  await pool.query("UPDATE Location SET AcceptsOnlineOrders = FALSE WHERE LocationID = 'loc-campus'");
});
test.after(async () => {
  await pool.query("UPDATE Location SET AcceptsOnlineOrders = ? WHERE LocationID = 'loc-campus'", [wasOpen]);
  env.server.close();
  pub.server.close();
  await pool.end();
});

test("a cash order is saved as pending payment, with no payment taken", async () => {
  const r = await order(phone(pub.base));
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
  const c = phone(pub.base);
  const plain = await c.call("/customer/price", { items: [LINE] });
  const r = await order(c, { discount: { applyTo: "order", type: "percent", value: 100, reason: "Regular" }, promotionId: "anything" });
  assert.equal(r.status, 200);
  assert.equal(r.body.totalCents, plain.body.totalCents);
  assert.equal(Math.round(Number((await row(r.body.orderId)).total) * 100), plain.body.totalCents);
});

test("pressing Place order twice makes one order", async () => {
  const c = phone(pub.base);
  await c.call("/customer/context"); // loading the page is what gives the phone its device cookie
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
  const c = phone(pub.base);
  assert.equal((await order(c, { paymentMethod: "Bitcoin" })).status, 400);
  assert.equal((await order(c, { guestName: " " })).status, 400);
  assert.equal((await order(c, { items: [] })).status, 400);
  assert.equal((await order(c, { items: [{ ...LINE, quantity: 0 }] })).status, 400);
  assert.equal((await order(c, { items: [{ ...LINE, modifierIds: ["mod-not-offered"] }] })).status, 400);
  for (const phone of ["123", "000-000-0000", "123-123-1234", "(312) 055-0142", "99999 312 555 0142", "21 312 555 0142", "abc"])
    assert.equal((await c.call("/customer/login", { phone })).status, 400, phone);
  assert.equal((await c.call("/customer/login", { phone: "1 (312) 555-0142" })).status, 200, "a leading 1 is fine");
  assert.equal((await c.call("/customer/login", { phone: "2025550199" })).status, 404);
});

test("customers see only their own orders, and staff pages stay closed to them", async () => {
  const ben = phone(pub.base);
  assert.equal((await ben.call("/customer/login", { phone: "(312) 555-0142" })).status, 200);
  const mine = await order(ben, { guestName: undefined });
  assert.equal((await row(mine.body.orderId)).customer !== null, true);
  const legacy = { OrderID: crypto.randomUUID() };
  await pool.query(
    "INSERT INTO Orders (OrderID, LocationID, BusinessID, ChannelCode, CustomerID) VALUES (?, 'loc-downtown', 'biz-brewbean', 2, ?)",
    [legacy.OrderID, (await row(mine.body.orderId)).customer]);
  assert.ok((await ben.call("/customer/my-orders")).body.orders.some((o) => o.id === legacy.OrderID));
  assert.equal((await ben.call(`/customer/orders/${legacy.OrderID}`)).status, 200, "existing online history remains accessible to its owner");
  assert.equal((await phone(pub.base).call(`/customer/orders/${legacy.OrderID}`)).status, 404);
  const guest = await order(phone(pub.base));

  assert.equal((await ben.call(`/customer/orders/${mine.body.orderId}`)).status, 200);
  assert.equal((await ben.call(`/customer/orders/${guest.body.orderId}`)).status, 404, "a guest's order");
  assert.equal((await phone(pub.base).call(`/customer/orders/${mine.body.orderId}`)).status, 404, "a member's order, signed out");
  assert.ok((await ben.call("/customer/my-orders")).body.orders.some((o) => o.id === mine.body.orderId));
  assert.equal((await phone(pub.base).call("/customer/my-orders")).status, 401);
  assert.equal((await fetch(env.base + "/api/session", { headers: { cookie: ben.cookie() } })).status, 401, "a customer sign-in is not a staff sign-in");

  await ben.call("/customer/logout", {});
  assert.equal((await ben.call("/customer/session")).body.signedIn, false);
  assert.equal((await ben.call("/customer/my-orders")).status, 401);
});

const paidOf = async (orderId) => (await pool.query(
  "SELECT PaymentMethodCode AS method, Amount AS amount, PaymentStatusCode AS status, TipAmount AS tip FROM Payment WHERE OrderID = ?", [orderId]))[0];
const history = async (orderId) => (await pool.query("SELECT OrderStatusCode AS s FROM OrderStatusHistory WHERE OrderID = ? ORDER BY ChangedAt, OrderStatusCode", [orderId]))[0].map((r) => r.s);

test("without MOCK_PAY the public side offers Cash only and refuses card and wallet orders", async () => {
  delete process.env.MOCK_PAY;
  try {
    const c = phone(pub.base);
    assert.equal((await c.call("/customer/context")).body.payHere, false);
    for (const paymentMethod of ["Card", "Apple Pay", "Google Pay"])
      assert.equal((await order(c, { paymentMethod, card: TEST_CARD })).status, 400, paymentMethod);
  } finally {
    process.env.MOCK_PAY = "1";
  }
});

test("a card or wallet order is mock-paid on the kiosk and confirmed for the kitchen", async () => {
  for (const [paymentMethod, code, card] of [["Card", 2, TEST_CARD], ["Apple Pay", 5], ["Google Pay", 6]]) {
    const r = await order(phone(pub.base), { paymentMethod, card });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.paid, true);
    const o = await row(r.body.orderId);
    assert.equal(o.status, 2, "confirmed, so the kitchen sees it");
    const [p] = await paidOf(r.body.orderId);
    assert.deepEqual([p.method, p.status, Number(p.amount), Number(p.tip)], [code, 3, Number(o.total), 0], paymentMethod);
    assert.deepEqual(await history(r.body.orderId), [1, 2]);
  }
});

test("a declined or bad card leaves no order behind, and the same order can be tried again", async () => {
  const [{ n: before }] = (await pool.query("SELECT COUNT(*) AS n FROM Orders"))[0];
  const c = phone(pub.base);
  const key = crypto.randomUUID();
  const declined = await order(c, { idempotencyKey: key, paymentMethod: "Card", card: { ...TEST_CARD, number: "4000000000000002" } });
  assert.deepEqual([declined.status, declined.body.error], [402, "Your card was declined."]);
  assert.equal((await order(c, { paymentMethod: "Card", card: { ...TEST_CARD, number: "5555555555554444" } })).status, 400, "not a test card");
  assert.equal((await order(c, { paymentMethod: "Card" })).status, 400, "no card details");
  assert.equal((await order(c, { paymentMethod: "Card", card: { ...TEST_CARD, expiry: "01/20" } })).status, 400, "expired");
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM Orders"))[0][0].n, before, "nothing was created");
  const retry = await order(c, { idempotencyKey: key, paymentMethod: "Card", card: TEST_CARD });
  assert.equal(retry.status, 200, "the same order with a good card");
});

test("genuine online orders remain blocked while counter checkout works", async () => {
  await assert.rejects(pool.tx((conn) => conn.query(
    "INSERT INTO Orders (OrderID, LocationID, BusinessID, ChannelCode) VALUES (?, 'loc-campus', 'biz-brewbean', 2)",
    [crypto.randomUUID()])), /not taking online orders/);
  const r = await order(phone(pub.base), { channelCode: 2, locationId: "loc-downtown", businessId: "other" });
  assert.equal(r.status, 200);
  const [[saved]] = await pool.query("SELECT ChannelCode, LocationID, BusinessID FROM Orders WHERE OrderID = ?", [r.body.orderId]);
  assert.deepEqual(saved, { ChannelCode: 3, LocationID: "loc-campus", BusinessID: "biz-brewbean" });
});

test("customer sessions cannot use the employee register", async () => {
  const c = phone(pub.base);
  assert.equal((await c.call("/customer/login", { phone: "(312) 555-0142" })).status, 200);
  const staff = (path, body) => fetch(env.base + "/api" + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", cookie: c.cookie() }, body: body && JSON.stringify(body) });
  assert.equal((await staff("/register/orders", { items: [LINE], payment: { method: "cash" } })).status, 401, "the staff server doesn't know a customer's cookie");
  assert.equal((await staff("/register/catalog")).status, 401);
  assert.equal((await c.call("/register/catalog")).status, 404, "and the public server has no register at all");
});

test("failed stock deduction rolls the entire checkout back", async () => {
  const [[before]] = await pool.query("SELECT COUNT(*) AS n FROM Orders");
  // more caramel americanos than any shelf holds (50 lines of 99), so the stock check fails whatever the test top-ups left
  // paid by card: a cash order that big is refused by the item cap before it reaches the stock
  const r = await order(phone(pub.base), { paymentMethod: "Card", card: TEST_CARD, items: Array.from({ length: 50 }, (_, i) => ({ ...LINE, key: `k${i}`, quantity: 99 })) });
  assert.notEqual(r.status, 200);
  const [[after]] = await pool.query("SELECT COUNT(*) AS n FROM Orders");
  assert.equal(after.n, before.n);
});

test("unpaid orders can hold at most half of a stock item, and a cash order at most 20 items", async () => {
  assert.equal((await order(phone(pub.base), { items: [{ ...LINE, quantity: 21 }] })).status, 400);
  // Leave caramel at exactly what waiting orders hold plus 610: 20 cups (300) may wait, one more cup (15) tips past half
  const held = async () => Number((await pool.query(
    `SELECT -COALESCE(SUM(t.QuantityChange), 0) AS h FROM InventoryTransaction t JOIN Orders o ON o.OrderID = t.OrderID
      WHERE o.LocationID = 'loc-campus' AND o.ChannelCode = 3 AND o.OrderStatusCode = 1 AND t.TransactionTypeCode = 2 AND t.StockItemID = 'stk-caramel'`))[0][0].h);
  const [[{ qty, cost }]] = await pool.query("SELECT Quantity AS qty, AverageUnitCost AS cost FROM Inventory WHERE LocationID = 'loc-campus' AND StockItemID = 'stk-caramel'");
  await pool.query(
    `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID, QuantityChange, UnitCost, TransactionTypeCode, Note)
     VALUES (UUID(), 'biz-brewbean', 'stk-caramel', 'loc-campus', 'emp-leo', ?, ?, 4, 'test: half-share limit')`,
    [(await held()) + 610 - Number(qty), cost]);
  try {
    assert.equal((await order(phone(pub.base), { items: [{ ...LINE, quantity: 20 }] })).status, 200);
    const r = await order(phone(pub.base), { items: [{ ...LINE, quantity: 1 }] });
    assert.equal(r.status, 409, "the shelf would have less left than waiting orders hold");
    assert.equal((await order(phone(pub.base), { paymentMethod: "Card", card: TEST_CARD, items: [{ ...LINE, quantity: 1 }] })).status, 200, "a paid order still gets the other half");
  } finally {
    await topUp("stk-caramel", 2000);
  }
});
test("on a shared screen a customer is signed out after 5 idle minutes, and a touch restarts the clock", async () => {
  const MIN = 60 * 1000, real = Date.now, base = real();
  const at = (m) => { Date.now = () => base + m * MIN; };
  process.env.KIOSK_SHARED_DEVICE = "1";
  try {
    assert.equal((await phone(pub.base).call("/customer/context")).body.sharedDevice, true);
    const ben = phone(pub.base);
    assert.equal((await ben.call("/customer/login", { phone: "(312) 555-0142" })).status, 200);
    at(4); assert.equal((await ben.call("/customer/session")).body.signedIn, true);
    assert.equal((await ben.call("/customer/touch", {})).status, 200);
    at(8); assert.equal((await ben.call("/customer/session")).body.signedIn, true, "4 minutes after the touch");
    at(14); assert.equal((await ben.call("/customer/session")).body.signedIn, false, "6 minutes after it");
    assert.equal((await ben.call("/customer/my-orders")).status, 401);
  } finally { Date.now = real; delete process.env.KIOSK_SHARED_DEVICE; }
});

test("on a customer's own phone nobody is signed out while waiting, until the session's 2 hours end", async () => {
  const MIN = 60 * 1000, real = Date.now, base = real();
  const at = (m) => { Date.now = () => base + m * MIN; };
  try {
    assert.equal((await phone(pub.base).call("/customer/context")).body.sharedDevice, false);
    const ben = phone(pub.base);
    assert.equal((await ben.call("/customer/login", { phone: "(312) 555-0142" })).status, 200);
    at(90); assert.equal((await ben.call("/customer/session")).body.signedIn, true, "90 minutes with no touch");
    at(125); assert.equal((await ben.call("/customer/session")).body.signedIn, false, "the session's own limit");
  } finally { Date.now = real; }
});

test("the café comes from the link: a wrong, missing or closed café is refused, and another one works", async () => {
  const ctx = (c) => c.call("/customer/context");
  assert.deepEqual([(await ctx(phone(pub.base))).status, (await ctx(phone(pub.base))).body.locationName], [200, "Brewbean Campus"]);
  assert.equal((await ctx(phone(pub.base, "loc-downtown"))).body.locationName, "Brewbean Downtown", "another café of the same business");
  assert.equal((await ctx(phone(pub.base, "loc-nowhere"))).status, 404);
  assert.equal((await ctx(client(pub.base))).status, 404, "no café given");
  assert.match((await ctx(phone(pub.base, "loc-nowhere"))).body.error, /link isn't valid/);
  const reset = customers.resetCaches;
  await pool.query("INSERT INTO Location (LocationID, BusinessID, Name, TimeZone, Active) VALUES ('loc-test-closed', 'biz-brewbean', 'Closed café', 'America/Chicago', FALSE)");
  try {
    reset();
    assert.equal((await ctx(phone(pub.base, "loc-test-closed"))).status, 404, "a closed café takes no orders");
    assert.equal((await phone(pub.base, "loc-test-closed").call("/customer/catalog")).status, 404);
    assert.equal((await order(phone(pub.base, "loc-test-closed"))).status, 404);
  } finally { await pool.query("DELETE FROM Location WHERE LocationID = 'loc-test-closed'"); reset(); }
});

test("several businesses: the café link decides the business, and a sign-in stays with its own business", async () => {
  await pool.query("INSERT INTO Business (BusinessID, Name) VALUES ('biz-test-other', 'Other Co')");
  await pool.query("INSERT INTO Location (LocationID, BusinessID, Name, TimeZone) VALUES ('loc-test-other', 'biz-test-other', 'Other Café', 'America/Denver')");
  try {
    customers.resetCaches();
    const there = await phone(pub.base, "loc-test-other").call("/customer/context");
    assert.deepEqual([there.status, there.body.businessName, there.body.locationName], [200, "Other Co", "Other Café"]);
    const here = await phone(pub.base).call("/customer/context");
    assert.deepEqual([here.status, here.body.businessName], [200, "Brewbean Coffee"], "Brewbean still serves with a second business");
    const none = await phone(pub.base, "").call("/customer/context");
    assert.deepEqual([none.status, none.body.error], [404, "Scan your café's QR code to order."]);

    const ben = phone(pub.base);
    assert.equal((await ben.call("/customer/login", { phone: "(312) 555-0142" })).status, 200);
    const away = client(pub.base, { "x-location-id": "loc-test-other", cookie: ben.cookie() });
    assert.equal((await away.call("/customer/session")).body.signedIn, false, "a Brewbean sign-in is a guest at another business");
    assert.equal((await away.call("/customer/my-orders")).status, 401);
    assert.equal((await away.call("/customer/login", { phone: "(312) 555-0142" })).status, 404, "Brewbean's members aren't another business's");
    assert.equal((await ben.call("/customer/session")).body.signedIn, true, "and still signed in at Brewbean");

    await pool.query("UPDATE Business SET Active = FALSE WHERE BusinessID = 'biz-test-other'");
    customers.resetCaches();
    assert.equal((await phone(pub.base, "loc-test-other").call("/customer/context")).status, 404, "a closed business takes no orders");
  } finally {
    await pool.query("DELETE FROM Location WHERE LocationID = 'loc-test-other'");
    await pool.query("DELETE FROM Business WHERE BusinessID = 'biz-test-other'");
    customers.resetCaches();
  }
});

test("the menu is kept for 5 seconds, then shows changes", async () => {
  const real = Date.now, base = real();
  customers.resetCaches();
  const seen = async () => (await phone(pub.base).call("/customer/catalog")).body.products.find((p) => p.id === pid)?.name;
  const [[{ pid, name }]] = await pool.query("SELECT ProductID AS pid, Name AS name FROM Product WHERE BusinessID = 'biz-brewbean' AND Active AND NOT IsGiftCard ORDER BY Name LIMIT 1");
  try {
    assert.equal(await seen(), name);
    await pool.query("UPDATE Product SET Name = ? WHERE ProductID = ?", [`${name} X`, pid]);
    assert.equal(await seen(), name, "a second phone within 5 seconds is served the kept menu");
    Date.now = () => base + 6000;
    assert.equal(await seen(), `${name} X`, "after 5 seconds it is read again");
  } finally { Date.now = real; await pool.query("UPDATE Product SET Name = ? WHERE ProductID = ?", [name, pid]); customers.resetCaches(); }
});

test("an order in progress blocks the next one until it is picked up", async () => {
  const c = phone(pub.base);
  const first = await order(c);
  assert.equal(first.status, 200);
  const second = await order(c);
  assert.equal(second.status, 409);
  assert.match(second.body.error, new RegExp(`#${first.body.orderNumber} is still in progress`));
  assert.equal((await c.call("/customer/active-order")).body.order.id, first.body.orderId, "the island shows it");
  assert.equal((await order(phone(pub.base))).status, 200, "another phone is not held up");
  await pool.query("UPDATE Orders SET OrderStatusCode = 5 WHERE OrderID = ?", [first.body.orderId]); // picked up
  assert.equal((await c.call("/customer/active-order")).body.order, null);
  assert.equal((await order(c)).status, 200, "once picked up, this phone can order again");
});

test("a member enrolled with only an email signs in by that email", async () => {
  const [[{ b }]] = await pool.query("SELECT BusinessID AS b FROM Location WHERE LocationID = 'loc-campus'");
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO Customer (CustomerID, BusinessID, FirstName, Email) VALUES (?, ?, 'Eli', 'eli.only@example.com')", [id, b]);
  try {
    const r = await phone(pub.base).call("/customer/login", { email: " Eli.Only@Example.com " });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.firstName, r.body.maskedPhone, r.body.maskedEmail], ["Eli", null, "e***@example.com"]);
    const none = await phone(pub.base).call("/customer/login", { email: "nobody@example.com" });
    assert.equal(none.status, 404);
    assert.match(none.body.error, /that email/);
    assert.equal((await phone(pub.base).call("/customer/login", { email: "not an email" })).status, 400);
  } finally { await pool.query("DELETE FROM Customer WHERE CustomerID = ?", [id]); }
});

// last, because it uses up this address's orders for a minute
test("order spam is slowed down: one phone is capped, and so is a script with no cookie", async () => {
  const c = phone(pub.base);
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await c.call("/customer/orders", { items: [] })).status);
  assert.deepEqual(codes, [400, 400, 400, 400, 400, 429, 429, 429], "a bad order is refused as before, until this phone's 5 a minute");
  assert.equal((await phone(pub.base).call("/customer/orders", { items: [] })).status, 400, "another phone on the same wifi isn't held up");
  let blocked = 0; // no cookie kept, so only the address limit (60 a minute) can stop it
  for (let i = 0; i < 70; i++) if ((await fetch(pub.base + "/api/customer/orders", { method: "POST", headers: { "content-type": "application/json" }, body: '{"items":[]}' })).status === 429) blocked++;
  assert.ok(blocked > 0, "the address limit stops it");
});
