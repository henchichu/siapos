// Needs the dev database. Kiosk cash orders wait for the register, which takes the cash or cancels; unpaid ones expire.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { start, client, pool, topUp } = require("./env");
const { expireStale } = require("../../server/kioskorders");

process.env.KIOSK_LOCATION_ID = "loc-campus";
let env, wasOpen;
const LINE = { key: "a", variantId: "var-amer-s", quantity: 2, modifierIds: ["mod-caramel"] };
const kiosk = (c, extra = {}) => c.call("/customer/orders", { idempotencyKey: crypto.randomUUID(), paymentMethod: "Cash", guestName: "Pat", items: [LINE], ...extra });
const signIn = async (number, pin) => { const c = client(env.base); assert.equal((await c.call("/login/pin", { employeeNumber: number, pin })).status, 200); return c; };
const status = async (id) => (await pool.query("SELECT OrderStatusCode AS s FROM Orders WHERE OrderID = ?", [id]))[0][0].s;
const caramel = async () => Number((await pool.query("SELECT Quantity AS q FROM Inventory WHERE LocationID = 'loc-campus' AND StockItemID = 'stk-caramel'"))[0][0].q);
// A register user who signs in at Campus (the kiosk's café), or with elsewhere = true, at another café
const cashier = async (elsewhere = false) => {
  const [[{ Name }]] = await pool.query("SELECT Name FROM Location WHERE LocationID = 'loc-campus'");
  for (const [n, p] of [["10420003", "333333"], ["10420002", "222222"], ["10420001", "111111"]]) {
    const c = await signIn(n, p);
    if (((await c.call("/session")).body.locationName === Name) !== elsewhere) return c;
  }
  throw new Error("no such cashier");
};
const settle = async () => { while (await expireStale()) {} }; // dev data holds old unpaid orders from earlier runs; they would move the stock counts

test.beforeEach(() => require("../../server/customers").resetOrderLimit());
test.before(async () => {
  env = await start();
  await topUp("stk-caramel", 2000);
  [[{ wasOpen }]] = await pool.query("SELECT AcceptsOnlineOrders AS wasOpen FROM Location WHERE LocationID = 'loc-campus'");
  await pool.query("UPDATE Location SET AcceptsOnlineOrders = FALSE WHERE LocationID = 'loc-campus'");
});
test.after(async () => {
  await pool.query("UPDATE Location SET AcceptsOnlineOrders = ? WHERE LocationID = 'loc-campus'", [wasOpen]);
  env.server.close();
  await pool.end();
});

test("the register takes the cash for a kiosk order and it goes to the kitchen", async () => {
  const c = await cashier();
  const r = await kiosk(client(env.base));
  const listed = (await c.call("/register/kiosk-orders")).body.orders.find((o) => o.id === r.body.orderId);
  assert.deepEqual([listed.name, listed.totalCents, listed.orderNumber], ["Pat", r.body.totalCents, r.body.orderNumber]);
  assert.equal((await c.call(`/register/kiosk-orders/${r.body.orderId}/pay`, {})).status, 200);
  assert.equal(await status(r.body.orderId), 2);
  const [[p]] = await pool.query("SELECT PaymentMethodCode AS m, PaymentStatusCode AS s, Amount AS a FROM Payment WHERE OrderID = ?", [r.body.orderId]);
  assert.deepEqual([p.m, p.s, Math.round(Number(p.a) * 100)], [1, 3, r.body.totalCents]);
  assert.equal((await c.call(`/register/kiosk-orders/${r.body.orderId}/pay`, {})).status, 409, "paid once");
  assert.equal((await c.call(`/register/kiosk-orders/${r.body.orderId}/cancel`, {})).status, 409, "and a paid order can't be cancelled here");
});

test("cancelling an unpaid order puts its stock back", async () => {
  const c = await cashier();
  const before = await caramel();
  const r = await kiosk(client(env.base));
  assert.equal(await caramel(), before - 30, "the order holds 2 cups x 15 syrup");
  assert.equal((await c.call(`/register/kiosk-orders/${r.body.orderId}/cancel`, {})).status, 200);
  assert.equal(await status(r.body.orderId), 6);
  assert.equal(await caramel(), before);
  assert.equal((await c.call(`/register/kiosk-orders/${r.body.orderId}/pay`, {})).status, 409, "a cancelled order can't be paid");
});

test("an order nobody pays for expires and gives its stock back; a paid one is left alone", async () => {
  const c = await cashier();
  await settle();
  const before = await caramel();
  const unpaid = await kiosk(client(env.base));
  const paid = await kiosk(client(env.base));
  await c.call(`/register/kiosk-orders/${paid.body.orderId}/pay`, {});
  await expireStale(60);
  assert.equal(await status(unpaid.body.orderId), 1, "not old enough yet");
  await pool.query("UPDATE Orders SET OrderDateTime = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE OrderID = ?", [unpaid.body.orderId]);
  await settle();
  assert.equal(await status(unpaid.body.orderId), 6);
  assert.equal(await status(paid.body.orderId), 2);
  assert.equal(await caramel(), before - 30, "only the paid order's stock is gone");
});

test("only someone who can use the register may take payment, and only at their own café", async () => {
  const jordan = await signIn("10420005", "555555");
  const r = await kiosk(client(env.base));
  assert.equal((await jordan.call("/register/kiosk-orders")).status, 403);
  assert.equal((await jordan.call(`/register/kiosk-orders/${r.body.orderId}/pay`, {})).status, 403);
  assert.equal(await status(r.body.orderId), 1);
  const away = await cashier(true);
  assert.equal((await away.call(`/register/kiosk-orders/${r.body.orderId}/pay`, {})).status, 409, "an order at another café isn't theirs");
  assert.equal((await away.call("/register/kiosk-orders")).body.orders.some((o) => o.id === r.body.orderId), false);
  await (await cashier()).call(`/register/kiosk-orders/${r.body.orderId}/cancel`, {});
});

test("a card order that can't get its stock is not charged: stock is checked before the card", async () => {
  const left = await caramel();
  const [[{ cost }]] = await pool.query("SELECT AverageUnitCost AS cost FROM Inventory WHERE LocationID = 'loc-campus' AND StockItemID = 'stk-caramel'");
  await pool.query(
    `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID, QuantityChange, UnitCost, TransactionTypeCode, Note)
     VALUES (UUID(), 'biz-brewbean', 'stk-caramel', 'loc-campus', 'emp-leo', ?, ?, 4, 'test: leave 5')`, [5 - left, cost]);
  try {
    // 4000 0000 0000 0002 is declined: a charge made first would answer 402, the stock failing first answers 409
    const r = await kiosk(client(env.base), { paymentMethod: "Card", card: { number: "4000 0000 0000 0002", expiry: "12/49", cvc: "123" } });
    assert.equal(r.status, 409);
  } finally { await topUp("stk-caramel", 2000); }
});
