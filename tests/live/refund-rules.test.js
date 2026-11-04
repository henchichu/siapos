// Needs the dev database. The refund rules the backend now enforces itself (their database triggers were removed): a refund over the
// limit, or on an old order, must be signed by someone holding the override permission (Leo has it, Ana can only approve discounts),
// and a request can't return more of an item than was bought, even by listing it twice.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, pickUp, topUp, creds } = require("./env");

let env, sam, maya;
const LEO = { managerNumber: "10420002", managerPin: "222222" };
const ANA = { managerNumber: "10420006", managerPin: "666666" };
const signIn = async (number) => { const c = client(env.base); assert.equal((await c.call("/login", creds(number))).status, 200); return c; };

async function sale(n) {
  const made = await sam.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: n }], payment: { method: "cash" } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  await pickUp(made.body.orderNumber);
  const found = (await sam.call(`/refunds/order?q=${made.body.orderNumber}`)).body;
  return { number: made.body.orderNumber, orderId: found.orderId, itemId: found.lines[0].orderItemId, bought: found.lines[0].bought };
}
const refund = (s, who, qty = s.bought) => sam.call("/refunds", { orderId: s.orderId, reason: "test", ...who, lines: [{ orderItemId: s.itemId, qty, restock: false }] });
const rows = async (s) => (await pool.query("SELECT (SELECT COUNT(*) FROM Refund WHERE OrderID = ?) AS refunds, (SELECT COUNT(*) FROM ReturnItem WHERE OrderID = ?) AS items", [s.orderId, s.orderId]))[0][0];

test.before(async () => { env = await start(); await topUp("stk-croissant", 200); sam = await signIn("10420003"); maya = await signIn("10420001"); });
test.after(async () => { env.server.close(); await pool.end(); });

test("a refund within the limit and on a recent order may be signed by anyone who approves discounts", async () => {
  const s = await sale(1);
  const r = await refund(s, ANA);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("a refund over the limit needs the override permission, and a refused one leaves nothing behind", async () => {
  const s = await sale(8); // 8 x $3.50 plus tax is over the $25 limit
  const refused = await refund(s, ANA);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /breaks a refund rule/);
  assert.deepEqual(await rows(s), { refunds: 0, items: 0 }, "no refund and no returned items");
  assert.equal((await refund(s, LEO)).status, 200, "the manager who holds the permission signs it");
});

test("a refund on an old order needs the override permission too", async () => {
  const s = await sale(1);
  await pool.query("UPDATE Orders SET CompletedAt = CompletedAt - INTERVAL 30 DAY WHERE OrderID = ?", [s.orderId]);
  assert.equal((await refund(s, ANA)).status, 409);
  assert.equal((await refund(s, LEO)).status, 200);
});

test("approving a waiting refund holds the signer to the same rule", async () => {
  const s = await sale(8);
  assert.equal((await sam.call("/refunds/request", { orderId: s.orderId, reason: "test", lines: [{ orderItemId: s.itemId, qty: 8, restock: false }] })).status, 200);
  const mine = (await maya.call("/refunds/waiting")).body.refunds.find((r) => r.orderNumber === s.number);
  const refused = await maya.call(`/refunds/${mine.id}/approve`, ANA);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /breaks a refund rule/);
  const [[still]] = await pool.query("SELECT RefundStatusCode AS code FROM Refund WHERE RefundID = ?", [mine.id]);
  assert.equal(still.code, 1, "still waiting");
  assert.equal((await maya.call(`/refunds/${mine.id}/approve`, LEO)).status, 200);
});

test("a request can't return more than was bought by listing the item twice", async () => {
  const s = await sale(2);
  const r = await sam.call("/refunds", { orderId: s.orderId, reason: "test", ...LEO, lines: [{ orderItemId: s.itemId, qty: 2, restock: false }, { orderItemId: s.itemId, qty: 2, restock: false }] });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /More items than are left/, "a clear answer (a unique key would also refuse it, but with a confusing one)");
  assert.deepEqual(await rows(s), { refunds: 0, items: 0 });
  assert.equal((await refund(s, LEO, 1)).status, 200, "one of two");
  assert.equal((await refund(s, LEO, 2)).status, 409, "then two more is too many");
  assert.equal((await refund(s, LEO, 1)).status, 200, "the last one");
});
