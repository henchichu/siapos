// Needs the dev database. Enrolls test members (last name "Member <run number>") and removes them afterwards; a test sale made for
// one stays in the database as a walk-in sale, as the other tests' sales do. Diego is enrolled and then put back as he was.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, pickUp, topUp, TEST_CARD } = require("./env");

let env, maya, leo, ana, sam, jordan;
let enrolled = 0;
let chloe; // her membership as it was before the run
const tag = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });
const search = async (c, q, inactive = false) => (await c.call(`/rewards/members?q=${encodeURIComponent(q)}&inactive=${inactive ? 1 : 0}`)).body;
// a phone nobody has: 555 numbers with this run's digits
const phoneOf = (n) => `(773) 555-${String((Number(tag) + n) % 10000).padStart(4, "0")}`;
async function enroll(extra = {}) {
  const body = { firstName: "Test", lastName: `Member ${tag}`, email: `rt-${tag}-${++enrolled}@example.com`, phone: "", ...extra };
  return leo.call("/rewards/members", body);
}

test.before(async () => {
  env = await start();
  maya = await signIn("10420001", "111111");
  leo = await signIn("10420002", "222222");
  ana = await signIn("10420006", "666666");
  sam = await signIn("10420003", "333333");
  jordan = await signIn("10420005", "555555");
  await topUp("stk-croissant", 20, "loc-downtown"); // the test sales are at Sam's café
  // the tests find Chloe as an active member; whatever she was before is put back afterwards
  [[chloe]] = await pool.query("SELECT Active AS active FROM LoyaltyAccount WHERE CustomerID = 'cus-chloe'");
  await pool.query("UPDATE LoyaltyAccount SET Active = TRUE WHERE CustomerID = 'cus-chloe'");
});
// Everything this run enrolled goes, found by its last name; Ben and Diego go back to being customers without accounts
test.after(async () => {
  try {
    const [rows] = await pool.query("SELECT CustomerID AS id FROM Customer WHERE LastName = ? AND BusinessID = 'biz-brewbean'", [`Member ${tag}`]);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      // redemptions first, so a balance never dips below zero on the way; then the sales become walk-ins
      await pool.query("DELETE FROM LoyaltyTransaction WHERE CustomerID IN (?) ORDER BY PointsChange", [ids]);
      await pool.query("UPDATE Orders SET CustomerID = NULL WHERE CustomerID IN (?)", [ids]);
      await pool.query("DELETE FROM LoyaltyAccount WHERE CustomerID IN (?)", [ids]);
      await pool.query("DELETE FROM Customer WHERE CustomerID IN (?)", [ids]);
    }
    await pool.query("DELETE FROM LoyaltyAccount WHERE CustomerID IN ('cus-ben', 'cus-diego')");
    await pool.query("UPDATE Customer SET Email = NULL, Phone = '312-555-0142' WHERE CustomerID = 'cus-ben'");
    await pool.query("UPDATE Customer SET Email = 'diego@example.com', Phone = NULL WHERE CustomerID = 'cus-diego'");
    if (chloe) await pool.query("UPDATE LoyaltyAccount SET Active = ? WHERE CustomerID = 'cus-chloe'", [chloe.active]);
  } finally {
    env.server.close(); await pool.end();
  }
});

test("Rewards follows permission 9 in the menu, on Home, on the page and in the API; Edit and Deactivate follow 10", async () => {
  for (const [c, canEdit] of [[maya, true], [leo, true], [ana, true], [sam, false]]) {
    const s = (await c.call("/session")).body;
    assert.ok(s.nav.includes("Rewards") && s.tiles.includes("Rewards"), s.nav.join());
    assert.equal((await page(c, "/rewards.html")).status, 200);
    const list = await c.call("/rewards/members");
    assert.equal(list.status, 200);
    assert.equal(list.body.canEdit, canEdit);
  }
  const s = (await jordan.call("/session")).body;
  assert.ok(!s.nav.includes("Rewards") && !s.tiles.includes("Rewards"));
  assert.equal((await jordan.call("/rewards/members")).status, 403);
  assert.equal((await page(jordan, "/rewards.html")).headers.get("location"), "/kitchen.html");
  // the assistant manager sees neither Reports nor Employees
  const n = (await ana.call("/session")).body;
  assert.ok(!["Reports", "Employees"].some((x) => n.nav.includes(x) || n.tiles.includes(x)), n.nav.join());
  assert.equal(n.roleName, "Assistant manager");
});

test("search: by name, email or phone digits; members only", async () => {
  assert.deepEqual((await search(leo, "ava")).members.map((m) => m.firstName), ["Ava"]);
  assert.deepEqual((await search(leo, "CHLOE@example")).members.map((m) => m.firstName), ["Chloe"]);
  assert.deepEqual((await search(leo, "(312) 555-0177")).members.map((m) => m.firstName), ["Chloe"]);
  assert.equal((await search(leo, "ben")).members.length, 0); // a customer, not a member
  assert.equal((await search(leo, "%")).members.length, 0); // typed text, not a wildcard
  const ava = (await search(leo, "ava")).members[0];
  assert.equal(ava.tier, "Gold");
  const [[{ pts }]] = await pool.query("SELECT COALESCE(SUM(PointsChange), 0) AS pts FROM LoyaltyTransaction WHERE CustomerID = 'cus-ava'");
  assert.equal(ava.points, Number(pts));
});

test("enroll: checks the form, saves email in lowercase and phone as 312-555-0142, starts in the lowest tier", async () => {
  const empty = await leo.call("/rewards/members", {});
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /first name/);
  assert.match(empty.body.error, /email or a phone/);
  assert.match((await enroll({ email: "not-an-email" })).body.error, /valid email/);
  assert.match((await enroll({ phone: "555-0142" })).body.error, /10 digits/);
  assert.match((await enroll({ phone: "(012) 555-0142" })).body.error, /10 digits/);

  const email = `RT-${tag}-Upper@Example.com`;
  const r = await enroll({ email, phone: `1 ${phoneOf(1)}` });
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.message, /^Enrolled Test Member/);
  const [m] = (await search(leo, email)).members;
  assert.equal(m.email, email.toLowerCase());
  assert.equal(m.phone, phoneOf(1).replace(/[()]/g, "").replace(" ", "-"));
  assert.equal(m.tier, "Bean");
  assert.equal(m.points, 0);
  assert.equal(m.active, true);

  // phone only is fine
  assert.equal((await enroll({ email: "", phone: phoneOf(2) })).status, 200);
});

test("email and phone are unique: a clear error names who has them", async () => {
  const email = await enroll({ email: "AVA@example.com" });
  assert.equal(email.status, 409);
  assert.equal(email.body.error, "That email is already used by member Ava Nguyen.");
  const phone = await enroll({ phone: "+1 312.555.0177" });
  assert.equal(phone.status, 409);
  assert.equal(phone.body.error, "That phone number is already used by member Chloe Moreau.");
  // an email of one person and a phone of another
  assert.equal((await enroll({ email: "chloe@example.com", phone: "312-555-0142" })).body.error,
    "That email belongs to Chloe Moreau and that phone to Ben Carter. Check the details.");
});

test("enrolling an existing customer makes them a member and keeps their details", async () => {
  const r = await enroll({ firstName: "Diego", lastName: "Ruiz", email: "Diego@Example.com", phone: phoneOf(3) });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.id, "cus-diego");
  assert.equal(r.body.message, "Diego Ramos is already a customer; enrolled as a member.");
  const [d] = (await search(leo, "diego")).members;
  assert.equal(d.lastName, "Ramos");
  assert.equal(d.phone, phoneOf(3).replace(/[()]/g, "").replace(" ", "-")); // the missing phone is filled in
  assert.equal(d.tier, "Bean");
  // a second time, he's a member already
  assert.equal((await enroll({ email: "diego@example.com" })).body.error, "That email is already used by member Diego Ramos.");
});

test("edit needs permission 10, and keeps contacts unique", async () => {
  const r = await enroll({ phone: phoneOf(4) });
  const id = r.body.id;
  const body = { firstName: "Edited", lastName: `Member ${tag}`, email: `rt-${tag}-edited@example.com`, phone: phoneOf(4) };
  assert.equal((await sam.call(`/rewards/members/${id}`, body)).status, 403);
  const ok = await ana.call(`/rewards/members/${id}`, body);
  assert.equal(ok.status, 200, ok.body.error);
  assert.equal(ok.body.message, `Saved Edited Member ${tag}.`);
  assert.equal((await search(leo, `rt-${tag}-edited`)).members[0].firstName, "Edited");
  assert.equal((await ana.call(`/rewards/members/${id}`, { ...body, email: "chloe@example.com" })).body.error, "That email is already used by member Chloe Moreau.");
  assert.equal((await ana.call(`/rewards/members/${id}`, { ...body, email: "", phone: "" })).status, 400);
  assert.equal((await ana.call("/rewards/members/cus-nobody", body)).status, 404);
});

test("a deactivated member is hidden, can't be found or used at the register, and keeps their points", async () => {
  const email = `rt-${tag}-off@example.com`;
  const id = (await enroll({ email, phone: phoneOf(5) })).body.id;
  assert.equal((await sam.call(`/rewards/members/${id}/active`, { active: false })).status, 403);
  const off = await leo.call(`/rewards/members/${id}/active`, { active: false });
  assert.match(off.body.message, /^Deactivated .* Their points and history are kept\.$/);
  assert.equal((await search(leo, email)).members.length, 0);
  const [m] = (await search(leo, email, true)).members;
  assert.equal(m.active, false);
  assert.equal((await sam.call(`/register/member?q=${email}`)).status, 404);
  const sale = await sam.call("/register/orders", { customerId: id, items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], payment: { method: "cash" } });
  assert.equal(sale.status, 400);
  assert.equal(sale.body.error, "That rewards member isn't available.");

  assert.match((await leo.call(`/rewards/members/${id}/active`, { active: true })).body.message, /^Reactivated/);
  assert.equal((await sam.call(`/register/member?q=${email}`)).status, 200);
});

test("history: paid orders, total spent less refunds, points per order, adjustments, and the order's details", async () => {
  const r = await enroll({ phone: phoneOf(6) });
  const id = r.body.id;
  const [[acct]] = await pool.query("SELECT LoyaltyAccountID AS id FROM LoyaltyAccount WHERE CustomerID = ?", [id]);
  const sale = await sam.call("/register/orders", { customerId: id, items: [{ key: "a", variantId: "var-croissant", quantity: 2 }], payment: { method: "card", card: TEST_CARD } });
  assert.equal(sale.status, 200, sale.body.error);
  await pickUp(sale.body.orderNumber);
  const found = await sam.call(`/refunds/order?q=${sale.body.orderNumber}`);
  const refund = await sam.call("/refunds", { managerNumber: "10420002", managerPin: "222222", reason: "test", orderId: found.body.orderId,
    lines: [{ orderItemId: found.body.lines[0].orderItemId, qty: 1, restock: false }] });
  assert.equal(refund.status, 200, refund.body.error);
  // points don't come from sales yet, so the test writes them: an adjustment, and a redemption on the order
  await pool.query("INSERT INTO LoyaltyTransaction (LoyaltyTransactionID, LoyaltyAccountID, CustomerID, LoyaltyTransactionTypeCode, PointsChange) VALUES (UUID(), ?, ?, 3, 10)", [acct.id, id]);
  await pool.query("INSERT INTO LoyaltyTransaction (LoyaltyTransactionID, LoyaltyAccountID, OrderID, CustomerID, LoyaltyTransactionTypeCode, PointsChange) VALUES (UUID(), ?, ?, ?, 2, -4)", [acct.id, found.body.orderId, id]);

  assert.equal((await jordan.call(`/rewards/members/${id}`)).status, 403);
  const h = (await sam.call(`/rewards/members/${id}`)).body;
  assert.equal(h.member.points, 6);
  assert.equal(h.member.tier, "Bean");
  assert.equal(h.orders, 1);
  assert.equal(h.spentCents, sale.body.totalCents - refund.body.totalCents);
  const order = h.rows.find((x) => x.kind === "order");
  assert.equal(order.number, sale.body.orderNumber);
  assert.equal(order.source, "Register");
  assert.equal(order.items, 2);
  assert.equal(order.totalCents, sale.body.totalCents);
  assert.equal(order.refundedCents, refund.body.totalCents);
  assert.equal(order.state, "Partly refunded");
  assert.deepEqual([order.earned, order.redeemed], [0, 4]);
  const adjust = h.rows.find((x) => x.kind === "adjust");
  assert.deepEqual([adjust.earned, adjust.redeemed], [10, 0]);

  const o = (await sam.call(`/rewards/orders/${order.id}`)).body;
  assert.equal(o.number, sale.body.orderNumber);
  assert.deepEqual(o.lines.map((l) => [l.qty, l.name]), [[2, "Butter croissant"]]);
  assert.equal(o.totalCents, sale.body.totalCents);
  assert.equal(o.payments[0].method, "Card");
  assert.equal(o.refunds[0].amountCents, refund.body.totalCents);
  assert.deepEqual(o.points, [{ type: "Redeem", points: -4 }]);

  // a walk-in's order isn't shown here
  const walkIn = await sam.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], payment: { method: "cash" } });
  const [[w]] = await pool.query("SELECT OrderID AS id FROM Orders WHERE OrderNumber = ?", [walkIn.body.orderNumber]);
  assert.equal((await sam.call(`/rewards/orders/${w.id}`)).status, 404);
});

test("Ava's history matches the database: cancelled and unpaid orders aren't counted", async () => {
  const h = (await leo.call("/rewards/members/cus-ava")).body;
  const [[db]] = await pool.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(o.Total - COALESCE((SELECT SUM(Amount) FROM Refund r WHERE r.OrderID = o.OrderID AND r.RefundStatusCode = 2), 0)), 0) AS spent
       FROM Orders o WHERE o.CustomerID = 'cus-ava' AND o.OrderStatusCode NOT IN (1, 6)`);
  assert.equal(h.orders, Number(db.n));
  assert.equal(h.spentCents, Math.round(Number(db.spent) * 100));
  const earned = h.rows.reduce((a, r) => a + r.earned - r.redeemed, 0);
  assert.equal(earned, h.member.points);
  assert.equal(h.member.email, "ava@example.com");
  assert.ok(h.member.since);
});
