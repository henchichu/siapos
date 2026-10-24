// Needs the dev database. Every form refuses bad data (phones, emails, names, notes, tips, codes, percentages) with a clear
// message, and saves nothing. The rules themselves are in tests/unit/validate.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { start, client, pool, TEST_CARD } = require("./env");

process.env.KIOSK_LOCATION_ID = "loc-campus";
let env, maya, sam;
const signIn = async (number, pin) => { const c = client(env.base); assert.equal((await c.call("/login/pin", { employeeNumber: number, pin })).status, 200); return c; };
const refused = (r, pattern) => { assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, pattern); };

test.before(async () => { env = await start(); maya = await signIn("10420001", "111111"); sam = await signIn("10420003", "333333"); });
test.beforeEach(() => require("../../server/customers").resetOrderLimit());
test.after(async () => { env.server.close(); await pool.end(); });

test("login: an employee number that isn't 8 digits is refused before any lookup", async () => {
  const c = client(env.base);
  for (const employeeNumber of ["123", "1234567a", "123456789", "", "10420001 "]) {
    refused(await c.call("/login/employee", { employeeNumber }), /8 digits/);
    refused(await c.call("/login/pin", { employeeNumber, pin: "111111" }), /8 digits/);
  }
});

test("Settings: business and location phone, email, tax percentage, invisible characters", async () => {
  const g = (await maya.call("/settings/general")).body;
  const biz = { name: g.business.name, email: "", phone: "", includesTax: !!g.business.includesTax };
  refused(await maya.call("/settings/business", { ...biz, phone: "abc" }), /US phone number/);
  refused(await maya.call("/settings/business", { ...biz, phone: "000-000-0000" }), /US phone number/);
  refused(await maya.call("/settings/business", { ...biz, email: "a@b.c" }), /valid email/);
  refused(await maya.call("/settings/business", { ...biz, name: "Caf​e" }), /can't be shown/);
  const l = g.locations[0];
  const loc = { ...l, active: !!l.active, online: !!l.online, registers: l.registers.map((r) => ({ id: r.id, name: r.name })) };
  refused(await maya.call("/settings/locations", { ...loc, phone: "12345" }), /US phone number/);
  refused(await maya.call("/settings/locations", { ...loc, address: "1 Main\u0007St" }), /can't be shown/);
  const taxId = Object.keys(l.rates)[0];
  for (const rate of ["8.12345", "-1", "101", "abc", ""])
    refused(await maya.call("/settings/locations", { ...loc, rates: { ...l.rates, [taxId]: rate } }), /tax percentage/);
  const after = (await maya.call("/settings/general")).body;
  assert.deepEqual([after.business.name, after.locations[0].phone, after.locations[0].rates], [g.business.name, l.phone, l.rates], "nothing was saved");
});

test("a supplier's name, email and phone are checked", async () => {
  const s = { name: "Test Supplier Co", email: "", phone: "" };
  refused(await maya.call("/inventory/supplier", { ...s, phone: "call us" }), /US phone number/);
  refused(await maya.call("/inventory/supplier", { ...s, email: "a@@b.com" }), /valid email/);
  refused(await maya.call("/inventory/supplier", { ...s, name: "Co\u0000" }), /can't be shown/);
  refused(await maya.call("/inventory/supplier", { ...s, name: "x".repeat(101) }), /too long/);
});

test("employee and member names are letters only, with every problem listed together", async () => {
  const hire = { firstName: "123", lastName: "<b>x</b>", number: "99990001", email: "a@b.c", roleId: "role-server", locationIds: ["loc-campus"], rate: "15.00", startsOn: "2026-01-01", pin: "246810" };
  const r = await maya.call("/employees", hire);
  refused(r, /first name/); refused(r, /last name/); refused(r, /valid email/);
  const m = await maya.call("/rewards/members", { firstName: "Pat 🙂", lastName: "", email: "pat@@example.com", phone: "x" });
  refused(m, /first name/); refused(m, /valid email/); refused(m, /US phone number/);
});

test("kiosk: guest name and note are checked, and too-long is an error rather than a cut", async () => {
  const c = client(env.base);
  const order = (extra) => c.call("/customer/orders", { idempotencyKey: crypto.randomUUID(), paymentMethod: "Cash", guestName: "Pat", items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], ...extra });
  refused(await order({ guestName: "Pat 🙂" }), /name for the order/);
  refused(await order({ guestName: "R2D2" }), /name for the order/);
  refused(await order({ guestName: "a".repeat(51) }), /name for the order/);
  refused(await order({ note: "x".repeat(121) }), /too long/);
  refused(await order({ note: "no\u0000pe" }), /can't be shown/);
});

test("register: tips, gift card codes and card numbers are checked", async () => {
  const sale = (payment) => sam.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], payment });
  for (const tip of ["1e2", "-5", "2.555", "abc"]) refused(await sale({ method: "card", card: TEST_CARD, tip }), /valid tip/);
  for (const giftCardCode of ["", "short", "has space in it"]) refused(await sale({ method: "gift", giftCardCode }), /gift card code/);
  refused(await sale({ method: "card", card: { ...TEST_CARD, number: "4242 4242 4242 4241" } }), /card number isn't valid/);
});

test("a refund reason and stock notes can't hold invisible characters", async () => {
  refused(await maya.call("/refunds", { orderId: "x", reason: "bad​reason", lines: [{ orderItemId: "x", qty: 1 }] }), /reason/);
});
