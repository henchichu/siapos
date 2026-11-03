// Needs the dev database. A signed-in customer orders at the kiosk; cash orders wait for the register, which takes the cash or
// cancels; unpaid ones expire. Customers see only their own orders.
process.env.RATE_LIMIT_SCALE = "50"; // this file places dozens of orders from one address in a minute
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { start, client, pool, admin, topUp, creds } = require("./env");
const { expireStale } = require("../../server/kioskorders");

let env;
const AVA = { email: "ava@example.com", password: "ava-dev-pass" };
const CHLOE = { email: "chloe@example.com", password: "chloe-dev-pass" };
const LINE = { key: "a", variantId: "var-amer-s", quantity: 2, modifierIds: ["mod-caramel"] };
const order = (c, extra = {}) => c.call("/customer/orders", { idempotencyKey: crypto.randomUUID(), paymentMethod: "Cash", items: [LINE], ...extra });
const signInCustomer = async (who) => { const c = client(env.base); assert.equal((await c.call("/login", who)).status, 200); return c; };
const signInStaff = async (number) => { const c = client(env.base); assert.equal((await c.call("/login", creds(number))).status, 200); return c; };
const row = async (id) => (await pool.query("SELECT OrderStatusCode AS status, ChannelCode AS channel, CustomerID AS customer, Total AS total, CustomerNote AS note FROM Orders WHERE OrderID = ?", [id]))[0][0];
const caramel = async () => Number((await pool.query("SELECT Quantity AS q FROM Inventory WHERE LocationID = 'loc-downtown' AND StockItemID = 'stk-caramel'"))[0][0].q);
const settle = async () => { while (await expireStale()) {} };

// Each test starts with these two customers having nothing in progress: unpaid orders are aged out, paid ones picked up
const reset = async () => {
  await pool.query("UPDATE Orders SET OrderDateTime = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE CustomerID IN ('cus-ava', 'cus-chloe') AND ChannelCode = 3 AND OrderStatusCode = 1");
  await settle();
  await pool.query("UPDATE Orders SET OrderStatusCode = 5, CompletedAt = UTC_TIMESTAMP() WHERE CustomerID IN ('cus-ava', 'cus-chloe') AND ChannelCode = 3 AND OrderStatusCode IN (2, 3, 4)");
};

test.before(async () => { env = await start(); await topUp("stk-caramel", 2000); });
test.beforeEach(reset);
test.after(async () => { await reset(); env.server.close(); await pool.end(); await admin.end(); });

test("a cash order is saved as pending payment, with the customer's note and no payment taken", async () => {
  const r = await order(await signInCustomer(AVA), { note: "Extra hot" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = await row(r.body.orderId);
  assert.deepEqual([o.status, o.channel, o.customer, o.note], [1, 3, "cus-ava", "Extra hot"]);
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM Payment WHERE OrderID = ?", [r.body.orderId]);
  assert.equal(n, 0);
  const [[cost]] = await pool.query(
    `SELECT oi.LineCost, SUM(c.QuantityUsed * c.UnitCost) AS components FROM OrderItem oi JOIN OrderItemComponent c ON c.OrderItemID = oi.OrderItemID
      WHERE oi.OrderID = ? GROUP BY oi.OrderItemID`, [r.body.orderId]);
  assert.equal(Number(cost.LineCost), Number(Number(cost.components).toFixed(6)));
});

test("prices come from the server; a customer can't send their own discount", async () => {
  const c = await signInCustomer(AVA);
  const plain = await c.call("/customer/price", { items: [LINE] });
  const r = await order(c, { discount: { applyTo: "order", type: "percent", value: 100, reason: "Regular" }, promotionId: "anything" });
  assert.equal(r.status, 200);
  assert.equal(Math.round(Number((await row(r.body.orderId)).total) * 100), plain.body.totalCents);
});

test("pressing Place order twice makes one order, and only one order can be in progress", async () => {
  const c = await signInCustomer(AVA);
  const body = { idempotencyKey: crypto.randomUUID(), paymentMethod: "Cash", items: [LINE] };
  const [a, b] = await Promise.all([c.call("/customer/orders", body), c.call("/customer/orders", body)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(a.body.orderId, b.body.orderId);
  const again = await order(c);
  assert.equal(again.status, 409);
  assert.match(again.body.error, /still in progress/);
  assert.equal((await order(await signInCustomer(CHLOE))).status, 200, "someone else can order");
});

test("the register takes the cash and the order goes to the kitchen; it is the customer's own", async () => {
  const sam = await signInStaff("10420003");
  const ava = await signInCustomer(AVA);
  const r = await order(ava, { note: "No sugar" });
  const listed = (await sam.call("/register/kiosk-orders")).body.orders.find((o) => o.id === r.body.orderId);
  assert.deepEqual([listed.name, listed.totalCents, listed.orderNumber], ["Ava", r.body.totalCents, r.body.orderNumber]);
  assert.equal((await ava.call("/customer/active-order")).body.order.id, r.body.orderId);

  assert.equal((await sam.call(`/register/kiosk-orders/${r.body.orderId}/pay`, {})).status, 200);
  assert.equal((await row(r.body.orderId)).status, 2);
  const [[p]] = await pool.query("SELECT PaymentMethodCode AS m, PaymentStatusCode AS s, Amount AS a FROM Payment WHERE OrderID = ?", [r.body.orderId]);
  assert.deepEqual([p.m, p.s, Math.round(Number(p.a) * 100)], [1, 3, r.body.totalCents]);
  assert.equal((await sam.call(`/register/kiosk-orders/${r.body.orderId}/pay`, {})).status, 409, "paid once");
  assert.equal((await sam.call(`/register/kiosk-orders/${r.body.orderId}/cancel`, {})).status, 409, "a paid order can't be cancelled here");

  const jordan = await signInStaff("10420005");
  const ticket = (await jordan.call("/kitchen/tickets")).body.queues.new.find((t) => t.number === r.body.orderNumber);
  assert.deepEqual([ticket.kiosk, ticket.note, ticket.customer], [true, "No sugar", "Ava Nguyen"]);

  assert.deepEqual((await ava.call(`/customer/orders/${r.body.orderId}`)).body.items.map((i) => i.qty), [2]);
  assert.ok((await ava.call("/customer/my-orders")).body.orders.some((o) => o.id === r.body.orderId));
  const chloe = await signInCustomer(CHLOE);
  assert.equal((await chloe.call(`/customer/orders/${r.body.orderId}`)).status, 404, "not hers");
  assert.ok(!(await chloe.call("/customer/my-orders")).body.orders.some((o) => o.id === r.body.orderId));
});

test("cancelling an unpaid order puts its stock back, and its customer may order again", async () => {
  const sam = await signInStaff("10420003");
  const ava = await signInCustomer(AVA);
  const before = await caramel();
  const r = await order(ava);
  assert.equal(await caramel(), before - 30, "the order holds 2 cups x 15 syrup");
  assert.equal((await sam.call(`/register/kiosk-orders/${r.body.orderId}/cancel`, {})).status, 200);
  assert.equal((await row(r.body.orderId)).status, 6);
  assert.equal(await caramel(), before);
  assert.equal((await sam.call(`/register/kiosk-orders/${r.body.orderId}/pay`, {})).status, 409, "a cancelled order can't be paid");
  assert.equal((await order(ava)).status, 200);
});

test("an order nobody pays for expires and gives its stock back; a paid one is left alone", async () => {
  const sam = await signInStaff("10420003");
  const before = await caramel();
  const unpaid = await order(await signInCustomer(AVA));
  const paid = await order(await signInCustomer(CHLOE));
  await sam.call(`/register/kiosk-orders/${paid.body.orderId}/pay`, {});
  await expireStale(60);
  assert.equal((await row(unpaid.body.orderId)).status, 1, "not old enough yet");
  await pool.query("UPDATE Orders SET OrderDateTime = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE OrderID = ?", [unpaid.body.orderId]);
  await settle();
  assert.equal((await row(unpaid.body.orderId)).status, 6);
  assert.equal((await row(paid.body.orderId)).status, 2);
  assert.equal(await caramel(), before - 30, "only the paid order's stock is gone");
});

test("only someone who can use the register may take payment", async () => {
  const r = await order(await signInCustomer(AVA));
  const jordan = await signInStaff("10420005");
  assert.equal((await jordan.call("/register/kiosk-orders")).status, 403);
  assert.equal((await jordan.call(`/register/kiosk-orders/${r.body.orderId}/pay`, {})).status, 403);
  assert.equal((await row(r.body.orderId)).status, 1);
});

test("a test card pays at once; a declined card leaves no order; the stock is checked before the card", async () => {
  const c = await signInCustomer(AVA);
  const paid = await order(c, { paymentMethod: "Card", card: { number: "4242 4242 4242 4242", expiry: "12/49", cvc: "123" } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.deepEqual([paid.body.paid, (await row(paid.body.orderId)).status], [true, 2]);
  await reset();

  const before = await caramel();
  const declined = await order(c, { paymentMethod: "Card", card: { number: "4000 0000 0000 0002", expiry: "12/49", cvc: "123" } });
  assert.equal(declined.status, 402);
  assert.equal(await caramel(), before, "the declined order took no stock");
  assert.equal((await c.call("/customer/active-order")).body.order, null);

  const [[{ cost }]] = await pool.query("SELECT AverageUnitCost AS cost FROM Inventory WHERE LocationID = 'loc-downtown' AND StockItemID = 'stk-caramel'");
  await pool.query(
    `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID, QuantityChange, UnitCost, TransactionTypeCode, Note)
     VALUES (UUID(), 'biz-brewbean', 'stk-caramel', 'loc-downtown', 'emp-leo', ?, ?, 4, 'test: leave 5')`, [5 - before, cost]);
  try {
    // a charge made first would answer 402; the stock failing first answers 409
    const short = await order(c, { paymentMethod: "Card", card: { number: "4000 0000 0000 0002", expiry: "12/49", cvc: "123" } });
    assert.equal(short.status, 409);
  } finally { await topUp("stk-caramel", 2000); }
});

test("an unpaid order is capped at 20 items, and a payment method is required", async () => {
  const c = await signInCustomer(AVA);
  const big = await order(c, { items: [{ ...LINE, modifierIds: [], quantity: 21 }] });
  assert.equal(big.status, 400);
  assert.match(big.body.error, /up to 20 items/);
  assert.equal((await order(c, { paymentMethod: "Bitcoin" })).status, 400);
  assert.equal((await order(c, { paymentMethod: "" })).status, 400);
});

test("only a signed-in customer reaches the kiosk: no session, a staff session, and a signed-out customer are all refused", async () => {
  const paths = ["/customer/context", "/customer/catalog", "/customer/active-order", "/customer/my-orders", "/customer/orders/x"];
  const nobody = client(env.base), staff = await signInStaff("10420003");
  for (const c of [nobody, staff]) {
    for (const p of paths) assert.equal((await c.call(p)).status, 401, p);
    assert.equal((await c.call("/customer/orders", { paymentMethod: "Cash", items: [LINE] })).status, 401);
  }
  const ava = await signInCustomer(AVA);
  assert.equal((await ava.call("/customer/context")).status, 200);
  await ava.call("/customer/logout", {});
  assert.equal((await ava.call("/customer/context")).status, 401);
  // and a customer opens no staff-side kiosk list
  assert.equal((await (await signInCustomer(AVA)).call("/register/kiosk-orders")).status, 401);
});

test("the page opens for a signed-in customer and sends everyone else to sign in", async () => {
  const page = (cookie) => fetch(`${env.base}/kiosk.html`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  const anon = await page();
  assert.deepEqual([anon.status, anon.headers.get("location")], [302, "/login.html"]);
  const staff = await signInStaff("10420003");
  assert.equal((await page(staff.cookie())).status, 302, "a staff session isn't a customer's");
  const ava = await signInCustomer(AVA);
  assert.equal((await page(ava.cookie())).status, 200);
  const root = await fetch(`${env.base}/`, { headers: { cookie: ava.cookie() }, redirect: "manual" });
  assert.equal(root.headers.get("location"), "/kiosk.html");
});

test("the catalog lists what is on sale here and the context names the café", async () => {
  const c = await signInCustomer(AVA);
  const ctx = (await c.call("/customer/context")).body;
  assert.deepEqual([ctx.businessName, ctx.locationName, ctx.payHere], ["Brewbean Coffee", "Brewbean Downtown", true]);
  const cat = (await c.call("/customer/catalog")).body;
  const latte = cat.products.find((p) => p.name.includes("Latte"));
  assert.ok(latte && latte.variants.every((v) => typeof v.priceCents === "number") && cat.categories.length);
  const me = (await c.call("/customer/me")).body;
  assert.deepEqual([me.firstName, me.maskedEmail, me.member], ["Ava", "a***@example.com", true]);
});
