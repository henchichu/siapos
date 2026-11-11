// Needs the dev database. Each role opens to a page by what it holds: Manager's To-Do if it can see it, else the page its
// OpensTo names; the menu lists Manager's To-Do first; and the menu's counts match the pages they stand for.
process.env.RATE_LIMIT_SCALE = "50";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { start, client, pool, creds, topUp } = require("./env");
const { expireStale } = require("../../server/kioskorders");

let env;
const signIn = async (number) => { const c = client(env.base); const r = await c.call("/login", creds(number)); assert.equal(r.status, 200); c.redirect = r.body.redirect; return c; };
const at = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });

test.before(async () => { env = await start(); });
test.after(async () => { env.server.close(); await pool.end(); });

test("managers open to Manager's To-Do; servers to Register; baristas to Kitchen; the Home page is gone", async () => {
  const expect = { "10420001": "/attention.html", "10420002": "/attention.html", "10420006": "/attention.html", "10420003": "/register.html", "10420004": "/register.html", "10420005": "/kitchen.html" };
  for (const [number, page] of Object.entries(expect)) {
    const c = await signIn(number);
    const me = (await c.call("/session")).body;
    assert.deepEqual([c.redirect, me.home], [page, page], number);
    assert.equal((await at(c, "/")).headers.get("location"), page, "the root goes there too");
    if (me.nav.includes("Manager's To-Do")) assert.equal(me.nav[0], "Manager's To-Do", "and it is first in the menu");
  }
  assert.equal((await at(await signIn("10420001"), "/home.html")).status, 404);
});

test("the menu's counts match what the pages list, and a role only gets the counts for its pages", async () => {
  // a pending kiosk order (unpaid cash), so the register has something to count
  await topUp("stk-caramel", 2000);
  const ava = client(env.base);
  await ava.call("/login", { email: "ava@example.com", password: "ava-dev-pass" });
  await pool.query("UPDATE Orders SET OrderDateTime = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE CustomerID = 'cus-ava' AND ChannelCode = 3 AND OrderStatusCode = 1");
  while (await expireStale()) {}
  await pool.query("UPDATE Orders SET OrderStatusCode = 5, CompletedAt = UTC_TIMESTAMP() WHERE CustomerID = 'cus-ava' AND ChannelCode = 3 AND OrderStatusCode IN (2, 3, 4)");
  const placed = await ava.call("/customer/orders", { idempotencyKey: crypto.randomUUID(), paymentMethod: "Cash", items: [{ key: "a", variantId: "var-amer-s", quantity: 1, modifierIds: [] }] });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  try {
    const maya = await signIn("10420001"), sam = await signIn("10420003"), jordan = await signIn("10420005");

    const m = (await maya.call("/nav-counts")).body;
    const pending = (await maya.call("/register/kiosk-orders")).body.orders.length;
    assert.ok(pending >= 1);
    assert.equal(m.register, pending, "Register: kiosk orders waiting for the cashier");
    const q = (await maya.call("/kitchen/tickets")).body.queues;
    assert.equal(m.kitchen, q.new.length + q.preparing.length + q.ready.length, "Kitchen: every ticket not yet picked up");
    const a = (await maya.call("/attention")).body;
    assert.equal(m.attention, ["losses", "reorder", "timecards", "refunds"].reduce((n, k) => n + (a[k]?.count || 0), 0), "Manager's To-Do: the sum of its panels");

    const s = (await sam.call("/nav-counts")).body;
    assert.equal(s.register, pending);
    assert.equal("attention" in s, false, "a server has no Manager's To-Do");
    const j = (await jordan.call("/nav-counts")).body;
    assert.equal("register" in j, false, "a barista has no Register");
    assert.equal(typeof j.kitchen, "number");

    // paying the order moves it from the register's count to the kitchen's
    const id = placed.body.orderId;
    await sam.call(`/register/kiosk-orders/${id}/pay`, {});
    const after = (await maya.call("/nav-counts")).body;
    assert.deepEqual([after.register, after.kitchen], [m.register - 1, m.kitchen + 1]);
    assert.equal((await client(env.base).call("/nav-counts")).status, 401, "signed out: nothing");
  } finally {
    await pool.query("UPDATE Orders SET OrderStatusCode = 5, CompletedAt = UTC_TIMESTAMP() WHERE CustomerID = 'cus-ava' AND ChannelCode = 3 AND OrderStatusCode IN (2, 3, 4)");
  }
});
