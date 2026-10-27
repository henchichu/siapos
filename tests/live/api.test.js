// Needs the dev database. Each run adds a few real test sales to it (orders can't be deleted).
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, unlock, pickUp, topUp, TEST_CARD } = require("./env");

const DENIED = "Unauthorized. Supervisor or Owner credentials required to override.";
let env, sam;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const croissant = { key: "a", variantId: "var-croissant", quantity: 1 };

test.before(async () => { env = await start(); await topUp("stk-croissant", 60, "loc-downtown"); sam = await signIn("10420003", "333333"); });
test.after(async () => { env.server.close(); await pool.end(); });

test("a server's own PIN can't approve a discount; a manager's can", async () => {
  const discount = { applyTo: "order", type: "percent", value: 10, reason: "Complaint" };
  const own = await sam.call("/register/discount/authorize", { discount, managerNumber: "10420003", managerPin: "333333", items: [croissant] });
  assert.equal(own.status, 403);
  assert.equal(own.body.error, DENIED);
  const mgr = await sam.call("/register/discount/authorize", { discount, managerNumber: "10420002", managerPin: "222222", items: [croissant] });
  assert.equal(mgr.status, 200);
});

test("staff discount: no manager under the limit, a manager over it", async () => {
  const staff = (value) => ({ discount: { applyTo: "order", type: "percent", value, reason: "Employee" }, employeeNumber: "10420004", items: [croissant] });
  assert.equal((await sam.call("/register/discount/authorize", staff(15))).status, 200);
  const over = await sam.call("/register/discount/authorize", staff(50));
  assert.equal(over.status, 403);
  const signed = await sam.call("/register/discount/authorize", { ...staff(50), managerNumber: "10420002", managerPin: "222222" });
  assert.equal(signed.status, 200);
  const unknown = await sam.call("/register/discount/authorize", { ...staff(10), employeeNumber: "99999999" });
  assert.equal(unknown.body.error, "Employee Number does not exist.");
});

test("a tip is separate from the sale and is never refunded", async () => {
  const sale = await sam.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: 2 }], payment: { method: "card", card: TEST_CARD, tip: "1.25" } });
  assert.equal(sale.status, 200);
  assert.equal(sale.body.totalCents, 772); // 7.00 + 10.25% tax, no tip in it
  assert.equal(sale.body.tipCents, 125);
  await pickUp(sale.body.orderNumber);
  const found = await sam.call(`/refunds/order?q=${sale.body.orderNumber}`);
  assert.equal(found.body.paidCents, 772);
  assert.equal(found.body.tipCents, 125);
  const mgr = { managerNumber: "10420002", managerPin: "222222", reason: "test" };
  const line = found.body.lines[0];
  const refund = await sam.call("/refunds", { ...mgr, orderId: found.body.orderId, lines: [{ orderItemId: line.orderItemId, qty: 2, restock: false }] });
  assert.equal(refund.status, 200);
  assert.equal(refund.body.totalCents, 772);
  const again = await sam.call("/refunds", { ...mgr, orderId: found.body.orderId, lines: [{ orderItemId: line.orderItemId, qty: 1, restock: false }] });
  assert.equal(again.status, 409);
});

test("a server can't sign their own refund", async () => {
  const sale = await sam.call("/register/orders", { items: [croissant], payment: { method: "cash" } });
  await pickUp(sale.body.orderNumber);
  const found = await sam.call(`/refunds/order?q=${sale.body.orderNumber}`);
  const r = await sam.call("/refunds", { orderId: found.body.orderId, reason: "x", managerNumber: "10420003", managerPin: "333333",
    lines: [{ orderItemId: found.body.lines[0].orderItemId, qty: 1, restock: false }] });
  assert.equal(r.status, 403);
});

test("wrong override PINs lock the cashier, not the manager", async () => {
  const priya = await signIn("10420004", "444444");
  const discount = { applyTo: "order", type: "percent", value: 5, reason: "Regular" };
  for (let i = 0; i < 5; i++) await priya.call("/register/discount/authorize", { discount, managerNumber: "10420002", managerPin: "000000", items: [croissant] });
  assert.equal((await client(env.base).call("/login/pin", { employeeNumber: "10420002", pin: "222222" })).status, 200); // Leo still signs in
  assert.equal((await client(env.base).call("/login/pin", { employeeNumber: "10420004", pin: "444444" })).status, 423); // Priya is locked
  await unlock("emp-priya");
});

test("a manager can't approve their own discount, an owner can", async () => {
  const discount = { applyTo: "order", type: "percent", value: 10, reason: "Complaint" };
  const ask = async (who, managerNumber, managerPin) => (await signIn(who[0], who[1])).call("/register/discount/authorize", { discount, managerNumber, managerPin, items: [croissant] });
  const leo = await ask(["10420002", "222222"], "10420002", "222222");
  assert.equal(leo.status, 403);
  assert.match(leo.body.error, /Another manager has to approve this/);
  assert.equal((await ask(["10420001", "111111"], "10420001", "111111")).status, 200, "an owner has no one above them");
  assert.equal((await ask(["10420001", "111111"], "10420002", "222222")).status, 200, "and a manager can sign for someone else");
});

test("five wrong gift card codes stop further guesses", async () => {
  const jordanLike = await signIn("10420001", "111111");
  const pay = (code) => jordanLike.call("/register/orders", { items: [croissant], payment: { method: "gift", giftCardCode: code } });
  for (let i = 0; i < 5; i++) assert.equal((await pay("wrong-code-" + i)).status, 400);
  assert.equal((await pay("wrong-code-5")).status, 429);
});

test("a $0 sale can't carry a tip", async () => {
  const discount = { applyTo: "order", type: "percent", value: 100, reason: "Complaint" };
  const auth = await sam.call("/register/discount/authorize", { discount, managerNumber: "10420002", managerPin: "222222", items: [croissant] });
  const r = await sam.call("/register/orders", { items: [croissant], discount, approvalToken: auth.body.approvalToken, payment: { method: "card", card: TEST_CARD, tip: "1.00" } });
  assert.equal(r.status, 400);
});

test("pressing Complete sale again after a lost reply gives the first receipt, not a second sale", async () => {
  const sale = { saleId: `t-${Date.now()}`, items: [croissant], payment: { method: "cash" } };
  const count = async () => (await pool.query("SELECT COUNT(*) AS n FROM Orders WHERE EmployeeID = 'emp-sam'"))[0][0].n;
  const before = await count();
  const [first, second] = await Promise.all([sam.call("/register/orders", sale), sam.call("/register/orders", sale)]); // the second while the first is still running
  const third = await sam.call("/register/orders", sale);
  assert.deepEqual([first.status, second.status, third.status], [200, 200, 200]);
  assert.equal(second.body.orderNumber, first.body.orderNumber);
  assert.equal(third.body.orderNumber, first.body.orderNumber);
  assert.equal(await count(), before + 1, "one order was made");

  const changed = await sam.call("/register/orders", { ...sale, items: [{ ...croissant, quantity: 2 }] });
  assert.notEqual(changed.body.orderNumber, first.body.orderNumber, "a different cart under the same id is a new sale");
  assert.equal(await count(), before + 2);
});

test("a sale that failed can be tried again with the same id", async () => {
  const sale = { saleId: `f-${Date.now()}`, items: [croissant], payment: { method: "gift", giftCardCode: "no-such-card" } };
  assert.equal((await sam.call("/register/orders", sale)).status, 400);
  assert.equal((await sam.call("/register/orders", sale)).status, 400, "answered again, not remembered as a receipt");
  const paid = await sam.call("/register/orders", { ...sale, payment: { method: "cash" } });
  assert.equal(paid.status, 200);
});

test("card, Apple Pay and Google Pay are mock-paid at the register, with a tip", async () => {
  for (const [method, code, card] of [["card", 2, TEST_CARD], ["apple", 5], ["google", 6]]) {
    const sale = await sam.call("/register/orders", { items: [croissant], payment: { method, card, tip: "0.75" } });
    assert.equal(sale.status, 200, `${method} ${JSON.stringify(sale.body)}`);
    assert.equal(sale.body.tipCents, 75, method);
    const [[p]] = await pool.query(
      "SELECT p.PaymentMethodCode AS method, p.PaymentStatusCode AS status, p.TipAmount AS tip FROM Payment p JOIN Orders o ON o.OrderID = p.OrderID WHERE o.OrderNumber = ? AND o.BusinessID = 'biz-brewbean'", [sale.body.orderNumber]);
    assert.deepEqual([p.method, p.status, Number(p.tip)], [code, 3, 0.75], method);
  }
});

test("a declined or bad card at the register makes no sale", async () => {
  const count = async () => (await pool.query("SELECT COUNT(*) AS n FROM Orders WHERE EmployeeID = 'emp-sam'"))[0][0].n;
  const before = await count();
  const pay = (card) => sam.call("/register/orders", { items: [croissant], payment: { method: "card", card } });
  const declined = await pay({ ...TEST_CARD, number: "4000 0000 0000 9995" });
  assert.deepEqual([declined.status, declined.body.error], [402, "Your card has insufficient funds."]);
  assert.equal((await pay({ ...TEST_CARD, number: "5555 5555 5555 4444" })).status, 400, "a real card number is refused");
  assert.equal((await pay(undefined)).status, 400, "no card details");
  assert.equal(await count(), before);
  assert.equal((await sam.call("/register/orders", { items: [croissant], payment: { method: "cash" } })).status, 200, "cash needs no card");
});

test("configured shops send visitors to sign-in and signed-in staff Home; old scaffold pages are gone", async () => {
  const at = (path, headers = {}) => fetch(env.base + path, { redirect: "manual", headers });
  const root = await at("/");
  assert.deepEqual([root.status, root.headers.get("location")], [302, "/login.html"], "a configured shop sends visitors to sign-in");
  const sam = await signIn("10420003", "333333");
  const home = await at("/", { cookie: sam.cookie() });
  assert.deepEqual([home.status, home.headers.get("location")], [302, "/home.html"], "signed in: straight to Home");
  assert.equal((await at("/login.html")).status, 200);
  for (const path of ["/index.html", "/customers.html", "/css/styles.css"]) assert.equal((await at(path)).status, 404, path);
});
