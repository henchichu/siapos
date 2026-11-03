// Needs the dev database. Self sign-up makes a customer and signs them in; it refuses emails already used by a customer or an
// employee, checks its fields, and is rate-limited.
process.env.RATE_LIMIT_SCALE = "50"; // this file signs up a dozen accounts from one address in a minute
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, admin, creds } = require("./env");

let env;
const made = [];
const email = (n) => `signup-${Date.now().toString(36)}-${n}@example.com`;
const body = (o = {}) => ({ firstName: "Nia", email: email(made.length), password: "a-long-pass-1", confirm: "a-long-pass-1", ...o });
const signup = (c, o) => c.call("/signup", body(o));

test.before(async () => { env = await start(); });
test.after(async () => {
  for (const e of made) {
    await admin.query("DELETE FROM CustomerCredential WHERE CustomerID IN (SELECT CustomerID FROM Customer WHERE Email = ?)", [e]);
    await admin.query("DELETE FROM Customer WHERE Email = ?", [e]);
  }
  env.server.close(); await pool.end(); await admin.end();
});

test("a new customer is created, signed in, and sent to the kiosk; they can sign in again later", async () => {
  const c = client(env.base), b = body({ email: email("a").toUpperCase() });
  made.push(b.email.toLowerCase());
  const r = await c.call("/signup", b);
  assert.deepEqual([r.status, r.body.redirect], [200, "/kiosk.html"], JSON.stringify(r.body));
  assert.equal((await c.call("/customer/me")).body.firstName, "Nia");
  const [[row]] = await pool.query("SELECT BusinessID AS biz, Email AS email, Active AS active FROM Customer WHERE Email = ?", [b.email.toLowerCase()]);
  assert.deepEqual([row.biz, row.email, row.active], ["biz-brewbean", b.email.toLowerCase(), 1], "stored lower-case, in the business");
  assert.equal((await client(env.base).call("/login", { email: b.email, password: b.password })).body.redirect, "/kiosk.html");
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM LoyaltyAccount la JOIN Customer c ON c.CustomerID = la.CustomerID WHERE c.Email = ?", [b.email.toLowerCase()]);
  assert.equal(n, 0, "not enrolled in rewards: staff do that");
});

test("an email already used by a customer (with or without a password) or an employee is refused", async () => {
  const taken = "That email is already registered. Sign in instead.";
  const staffEntered = email("walkin");
  await admin.query("INSERT INTO Customer (CustomerID, BusinessID, FirstName, Email) VALUES (?, 'biz-brewbean', 'Walk', ?)", [`cus-${staffEntered}`.slice(0, 36), staffEntered]);
  made.push(staffEntered);
  for (const e of ["ava@example.com", "AVA@example.com", staffEntered, "maya@brewbean.example.com"]) {
    const r = await signup(client(env.base), { email: e });
    assert.deepEqual([r.status, r.body.error], [409, taken], e);
  }
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM CustomerCredential WHERE CustomerID = ?", [`cus-${staffEntered}`.slice(0, 36)]);
  assert.equal(n, 0, "and a staff-entered customer was not given a password");
});

test("each field is checked: name, email, password length, and the two passwords must match", async () => {
  const bad = async (o, pattern) => { const r = await signup(client(env.base), o); assert.equal(r.status, 400, JSON.stringify(o)); assert.match(r.body.error, pattern); };
  await bad({ firstName: "" }, /first name/);
  await bad({ firstName: "R2-D2!" }, /first name/);
  await bad({ email: "not-an-email" }, /valid email/);
  await bad({ email: "" }, /valid email/);
  await bad({ password: "short", confirm: "short" }, /8 to 200/);
  await bad({ password: "x".repeat(201), confirm: "x".repeat(201) }, /8 to 200/);
  await bad({ confirm: "a-different-pass" }, /don't match/);
  await bad({ password: undefined, confirm: undefined }, /8 to 200/);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM Customer WHERE FirstName = 'R2-D2!'"))[0][0].n, 0);
});

test("signing up replaces a staff session on that browser, and the new customer opens nothing on the staff side", async () => {
  const c = client(env.base);
  await c.call("/login", creds("10420001"));
  assert.equal((await c.call("/session")).status, 200);
  const b = body(); made.push(b.email);
  assert.equal((await c.call("/signup", b)).status, 200);
  assert.equal((await c.call("/session")).status, 401, "the staff session is gone");
  assert.equal((await c.call("/orders")).status, 401);
  assert.equal((await c.call("/customer/me")).status, 200);
});

test("the page is public and the sign-in page links to it", async () => {
  assert.equal((await fetch(`${env.base}/signup.html`)).status, 200);
  assert.match(await (await fetch(`${env.base}/js/login.js`)).text(), /href="\/signup\.html"/);
});
