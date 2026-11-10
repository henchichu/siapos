// Needs the dev database. Every form refuses bad data (phones, emails, names, notes, tips, codes, percentages) with a clear
// message, and saves nothing. The rules themselves are in tests/unit/validate.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, TEST_CARD, creds, unlock } = require("./env");

let env, maya, sam;
const signIn = async (number, pin) => { const c = client(env.base); assert.equal((await c.call("/login", creds(number))).status, 200); return c; };
const refused = (r, pattern) => { assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, pattern); };

test.before(async () => { env = await start(); maya = await signIn("10420001", "111111"); sam = await signIn("10420003", "333333"); });
test.after(async () => { env.server.close(); await pool.end(); });

test("login: missing or oversize entries are refused, and a wrong email and a wrong password get the same answer", async () => {
  const c = client(env.base);
  for (const body of [{}, { email: "", password: "x" }, { email: "leo@brewbean.example.com" }, { email: "leo@brewbean.example.com", password: "" },
    { email: "x".repeat(256), password: "x" }, { email: "leo@brewbean.example.com", password: "x".repeat(201) }, { email: ["a"], password: "x" }])
    refused(await c.call("/login", body), /email and password/);
  const wrongPassword = await c.call("/login", { ...creds("10420002"), password: "wrong-password" });
  const wrongEmail = await c.call("/login", { email: "nobody@brewbean.example.com", password: "wrong-password" });
  assert.deepEqual([wrongPassword.status, wrongPassword.body], [401, { error: "Incorrect email or password." }]);
  assert.deepEqual([wrongEmail.status, wrongEmail.body], [401, { error: "Incorrect email or password." }]);
  await unlock("emp-leo");
});

test("login: the email is trimmed and not case-sensitive; the employee number and PIN do not sign in", async () => {
  const ok = await client(env.base).call("/login", { email: "  LEO@Brewbean.Example.com ", password: creds("10420002").password });
  assert.equal(ok.status, 200);
  assert.equal((await client(env.base).call("/login", { employeeNumber: "10420002", pin: "222222" })).status, 400);
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

test("register: tips, payment methods and card numbers are checked", async () => {
  const sale = (payment) => sam.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], payment });
  for (const tip of ["1e2", "-5", "2.555", "abc"]) refused(await sale({ method: "card", card: TEST_CARD, tip }), /valid tip/);
  refused(await sale({ method: "gift" }), /payment method/);
  refused(await sale({ method: "card", card: { ...TEST_CARD, number: "4242 4242 4242 4241" } }), /card number isn't valid/);
});

test("a refund reason and stock notes can't hold invisible characters", async () => {
  refused(await maya.call("/refunds", { orderId: "x", reason: "bad​reason", lines: [{ orderItemId: "x", qty: 1 }] }), /reason/);
});
