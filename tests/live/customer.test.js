// Needs the dev database. Customers sign in on the staff sign-in with their email and land on the kiosk; their session
// is separate from staff sessions in both directions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, admin, creds } = require("./env");
const { hashSecret } = require("../../server/auth");

let env;
const AVA = { email: "ava@example.com", password: "ava-dev-pass" };
const login = (c, body) => c.call("/login", body);

test.before(async () => { env = await start(); });
test.after(async () => { env.server.close(); await pool.end(); await admin.end(); });

test("a customer signs in with their email and lands on the kiosk; email case doesn't matter", async () => {
  const c = client(env.base);
  const r = await login(c, AVA);
  assert.deepEqual([r.status, r.body.redirect], [200, "/kiosk.html"]);
  assert.equal((await c.call("/customer/me")).body.firstName, "Ava");
  assert.equal((await login(client(env.base), { ...AVA, email: "AVA@Example.COM" })).status, 200);
  assert.equal((await c.call("/customer/logout", {})).status, 200);
  assert.equal((await c.call("/customer/me")).status, 401, "signed out");
});

test("the sign-in page's branding is the business's name, public; a staff session carries it too", async () => {
  assert.deepEqual((await client(env.base).call("/brand")).body, { name: "Brewbean Coffee" });
  const staff = client(env.base);
  await login(staff, creds("10420001"));
  assert.equal((await staff.call("/session")).body.businessName, "Brewbean Coffee");
});

test("a wrong password, an unknown email and a customer without a password all get the same answer", async () => {
  const answers = [];
  for (const body of [{ ...AVA, password: "not-her-password" }, { email: "nobody@example.com", password: "whatever-1" }, { email: "ben@example.com", password: "whatever-1" }])
    answers.push(await login(client(env.base), body));
  for (const a of answers) assert.deepEqual([a.status, a.body.error], [401, "Incorrect email or password."]);
});

test("five wrong passwords lock the account for a while, even against the right one", async () => {
  const chloe = { email: "chloe@example.com", password: "chloe-dev-pass" };
  try {
    for (let i = 0; i < 4; i++) assert.equal((await login(client(env.base), { ...chloe, password: "wrong-pass-1" })).status, 401);
    const fifth = await login(client(env.base), { ...chloe, password: "wrong-pass-1" });
    assert.deepEqual([fifth.status, fifth.body.locked], [423, true]);
    assert.equal((await login(client(env.base), chloe)).status, 423, "the right password waits too");
  } finally {
    await admin.query("UPDATE CustomerCredential SET FailedAttempts = 0, LockedUntil = NULL WHERE CustomerID = 'cus-chloe'");
  }
  assert.equal((await login(client(env.base), chloe)).status, 200);
});

test("a customer session opens nothing on the staff side, and a staff session nothing on the customer side", async () => {
  const customer = client(env.base), staff = client(env.base);
  await login(customer, AVA);
  for (const path of ["/session", "/orders", "/inventory", "/attention", "/rewards/members"]) assert.equal((await customer.call(path)).status, 401, path);
  assert.equal((await customer.call("/session/touch", {})).status, 401);

  assert.equal((await login(staff, creds("10420001"))).body.redirect, "/attention.html");
  assert.equal((await staff.call("/customer/me")).status, 401);
});

test("signing in as the other kind ends the first session on that browser", async () => {
  const c = client(env.base);
  await login(c, creds("10420001"));
  assert.equal((await c.call("/session")).status, 200);
  await login(c, AVA);
  assert.equal((await c.call("/session")).status, 401, "the staff session is gone");
  assert.equal((await c.call("/customer/me")).status, 200);
  await login(c, creds("10420001"));
  assert.equal((await c.call("/customer/me")).status, 401, "and so is the customer one");
  assert.equal((await c.call("/session")).status, 200);
});

test("an email is unique across customers, and an employee's email always signs in as the employee", async () => {
  await assert.rejects(admin.query("INSERT INTO Customer (CustomerID, BusinessID, Email) VALUES ('cus-dup', 'biz-brewbean', 'AVA@EXAMPLE.COM')"), { code: "ER_DUP_ENTRY" });

  const id = `cus-test-${Date.now()}`;
  await admin.query("INSERT INTO Customer (CustomerID, BusinessID, FirstName, Email) VALUES (?, 'biz-brewbean', 'Imposter', 'maya@brewbean.example.com')", [id]);
  await admin.query("INSERT INTO CustomerCredential (CustomerID, PasswordHash) VALUES (?, ?)", [id, hashSecret("customer-pass-1")]);
  try {
    assert.equal((await login(client(env.base), creds("10420001"))).body.redirect, "/attention.html");
    assert.equal((await login(client(env.base), { email: "maya@brewbean.example.com", password: "customer-pass-1" })).status, 401, "her customer password doesn't work");
  } finally {
    await admin.query("DELETE FROM CustomerCredential WHERE CustomerID = ?", [id]);
    await admin.query("DELETE FROM Customer WHERE CustomerID = ?", [id]);
  }
});
