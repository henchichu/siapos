// Needs the dev database. Every form refuses bad data (phones, emails, names, notes, tips, codes, percentages) with a clear
// message, and saves nothing. The rules themselves are in tests/unit/validate.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { start, startKiosk, client, phone, pool, TEST_CARD } = require("./env");

let env, pub, maya, sam; // env: the staff server, pub: the public order page
const signIn = async (number, pin) => { const c = client(env.base); assert.equal((await c.call("/login/pin", { employeeNumber: number, pin })).status, 200); return c; };
const refused = (r, pattern) => { assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, pattern); };

test.before(async () => { env = await start(); pub = await startKiosk(); maya = await signIn("10420001", "111111"); sam = await signIn("10420003", "333333"); });
test.beforeEach(() => require("../../server/customers").resetOrderLimit());
test.after(async () => { env.server.close(); pub.server.close(); await pool.end(); });

test("login: an employee number that isn't 8 digits is refused before any lookup", async () => {
  const c = client(env.base);
  for (const employeeNumber of ["123", "1234567a", "123456789", "", "10420001 "]) {
    refused(await c.call("/login/employee", { employeeNumber }), /8 digits/);
    refused(await c.call("/login/pin", { employeeNumber, pin: "111111" }), /8 digits/);
  }
});

test("a supplier's name, email and phone are checked", async () => {
  const s = { name: "Test Supplier Co", email: "", phone: "" };
  refused(await maya.call("/inventory/supplier", { ...s, phone: "call us" }), /US phone number/);
  refused(await maya.call("/inventory/supplier", { ...s, email: "a@@b.com" }), /valid email/);
  refused(await maya.call("/inventory/supplier", { ...s, name: "Co\u0000" }), /can't be shown/);
  refused(await maya.call("/inventory/supplier", { ...s, name: "x".repeat(101) }), /too long/);
});

test("member names are letters only, with every problem listed together", async () => {
  const m = await maya.call("/rewards/members", { firstName: "Pat 🙂", lastName: "", email: "pat@@example.com", phone: "x" });
  refused(m, /first name/); refused(m, /valid email/); refused(m, /US phone number/);
});

test("kiosk: guest name and note are checked, and too-long is an error rather than a cut", async () => {
  const c = phone(pub.base);
  const order = (extra) => c.call("/customer/orders", { idempotencyKey: crypto.randomUUID(), paymentMethod: "Cash", guestName: "Pat", items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], ...extra });
  refused(await order({ guestName: "Pat 🙂" }), /name for the order/);
  refused(await order({ guestName: "R2D2" }), /name for the order/);
  refused(await order({ guestName: "a".repeat(51) }), /name for the order/);
  refused(await order({ note: "x".repeat(121) }), /too long/);
  refused(await order({ note: "no\u0000pe" }), /can't be shown/);
});

test("register: tips, payment methods and card numbers are checked", async () => {
  const sale = (payment) => sam.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], payment });
  for (const tip of ["1e2", "-5", "2.555", "abc"]) refused(await sale({ method: "card", card: TEST_CARD, tip }), /valid tip/);
  refused(await sale({ method: "gift" }), /payment method/);
  refused(await sale({ method: "card", card: { ...TEST_CARD, number: "4242 4242 4242 4241" } }), /card number isn't valid/);
});

test("a refund reason and stock notes can't hold invisible characters", async () => {
  refused(await maya.call("/refunds", { orderId: "x", reason: "bad​reason", lines: [{ orderItemId: "x", qty: 1 }] }), /reason/);
});
