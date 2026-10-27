// Needs the dev database. Sells croissants as Sam (Downtown) and asks for refunds on them; every request ends approved or rejected.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, pickUp, topUp } = require("./env");

let env, leo, sam, jordan, maya;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });
const MGR = { managerNumber: "10420002", managerPin: "222222" };
const attention = async () => (await leo.call("/attention")).body;
const waiting = async () => (await leo.call("/refunds/waiting")).body.refunds;

// A completed sale of n croissants; the first line of its refund lookup is what a request needs
async function sale(n = 2, variantId = "var-croissant") {
  const made = await sam.call("/register/orders", { items: [{ key: "a", variantId, quantity: n }], payment: { method: "cash" } });
  assert.equal(made.status, 200);
  await pickUp(made.body.orderNumber);
  const found = (await sam.call(`/refunds/order?q=${made.body.orderNumber}`)).body;
  return { number: made.body.orderNumber, orderId: found.orderId, line: found.lines[0] };
}
const ask = (s, who = sam, extra = {}) => who.call("/refunds/request", { orderId: s.orderId, reason: "Wrong order", lines: [{ orderItemId: s.line.orderItemId, qty: s.line.bought, restock: false }], ...extra });

test.before(async () => { env = await start(); await topUp("stk-croissant", 60, "loc-downtown"); leo = await signIn("10420002", "222222"); sam = await signIn("10420003", "333333"); jordan = await signIn("10420005", "555555"); maya = await signIn("10420001", "111111"); });
test.after(async () => { env.server.close(); await pool.end(); });

test("only roles with something to act on see Needs attention", async () => {
  assert.equal((await sam.call("/attention")).status, 403);
  assert.equal((await jordan.call("/attention")).status, 403);
  assert.equal((await page(sam, "/attention.html")).headers.get("location"), "/register.html");
  assert.equal((await page(jordan, "/attention.html")).headers.get("location"), "/kitchen.html");
  assert.equal((await page(leo, "/attention.html")).status, 200);

  const data = await attention();
  assert.equal(data.location, "Brewbean Campus");
  for (const k of ["losses", "pendingDeliveries", "timecards", "refunds"]) assert.ok(data[k] && Number.isInteger(data[k].count) && Array.isArray(data[k].rows) && data[k].rows.length <= 8, k);
  assert.ok(data.pendingDeliveries.rows.every((r) => /^PO-\d+$/.test(r.orderNumber) && r.quantity > 0 && ["Ordered", "Needs supplier"].includes(r.status)));
  const inventory = (await leo.call("/inventory")).body;
  assert.equal(data.pendingDeliveries.count, inventory.pendingDeliveries.length);
  assert.deepEqual(data.pendingDeliveries.rows.map((r) => r.id), inventory.pendingDeliveries.slice(0, 8).map((r) => r.id));
});

test("pending purchase orders and losses reported today", async () => {
  const cup = async () => (await leo.call("/inventory")).body.rows.find((r) => r.id === "stk-cup-12");
  const before = await cup();
  try {
    assert.equal((await leo.call("/inventory/change", { stockItemId: "stk-cup-12", threshold: String(before.onHand + 1) })).status, 200);
    const inventory = (await leo.call("/inventory")).body;
    const pending = (await attention()).pendingDeliveries;
    assert.ok(inventory.pendingDeliveries.some((p) => p.stockItemId === "stk-cup-12"));
    assert.equal(pending.count, inventory.pendingDeliveries.length, "attention counts unreceived purchase orders");
    assert.deepEqual(pending.rows.map((p) => p.id), inventory.pendingDeliveries.slice(0, 8).map((p) => p.id));
  } finally {
    await leo.call("/inventory/change", { stockItemId: "stk-cup-12", threshold: String(before.reorderAt) });
  }

  // a loss reported in the kitchen and a theft adjusted from Inventory both show, with their reasons
  const milk = (await jordan.call("/kitchen/losses")).body.stock.find((s) => s.name === "Whole milk");
  assert.equal((await jordan.call("/kitchen/losses", { stockItemId: milk.id, reason: "spoiled", amount: "100" })).status, 200);
  assert.equal((await leo.call("/inventory/change", { stockItemId: "stk-cup-12", type: "adjust", reason: "stolen", quantity: "1" })).status, 200);
  const losses = (await attention()).losses;
  assert.ok(losses.rows.some((l) => l.item === "Whole milk" && l.amount === 100 && l.unit === "ml" && l.reason === "Spoiled or expired" && l.by === "Jordan"));
  assert.ok(losses.rows.some((l) => l.item === "12 oz cup" && l.amount === 1 && l.reason === "Stolen" && l.by === "Leo"));
  assert.ok(losses.count >= 2);
  assert.equal((await leo.call("/inventory/count", { counts: [{ stockItemId: "stk-cup-12", counted: String(before.onHand) }] })).status, 200); // the cup back
});

test("timecards waiting match what the team page would approve", async () => {
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) AS n FROM TimeEntry WHERE TimeEntryStatusCode = 2 AND LocationID IN (SELECT LocationID FROM EmployeeLocation WHERE EmployeeID = 'emp-leo' AND Active)");
  const { timecards } = await attention();
  assert.equal(timecards.count, n);
  if (n) assert.ok(timecards.periodId && timecards.rows[0].employee && /^\d{4}-\d\d-\d\d$/.test(timecards.rows[0].date) && typeof timecards.rows[0].hours === "number");
});

test("a refund asked for waits, and a manager approves it", async () => {
  const s = await sale(2);
  const before = (await attention()).refunds.count;
  assert.equal((await ask(s, sam, { lines: [{ orderItemId: s.line.orderItemId, qty: 0, restock: false }] })).status, 400);
  assert.equal((await ask(s, sam, { reason: " " })).status, 400);
  const asked = await ask(s);
  assert.equal(asked.status, 200);
  assert.equal((await attention()).refunds.count, before + 1);

  // asking changes nothing yet: the order is still completed and the payment still counts
  const [[o]] = await pool.query("SELECT OrderStatusCode AS status FROM Orders WHERE OrderID = ?", [s.orderId]);
  const [[p]] = await pool.query("SELECT PaymentStatusCode AS status FROM Payment WHERE OrderID = ?", [s.orderId]);
  assert.deepEqual([o.status, p.status], [5, 3]);
  const again = await ask(s);
  assert.equal(again.status, 409, "the items are already asked for");
  assert.match(again.body.error, /waiting for a manager/);
  assert.equal((await sam.call("/refunds/waiting")).status, 403);

  const mine = (await waiting()).find((r) => r.orderNumber === s.number);
  assert.deepEqual([mine.askedBy, mine.why, mine.reason, mine.lines], ["Sam", "Needs a manager's approval", "Wrong order", [{ name: "Butter croissant", qty: 2, restocked: 0 }]]);

  assert.equal((await sam.call(`/refunds/${mine.id}/approve`, MGR)).status, 403, "a server can't approve");
  assert.equal((await leo.call(`/refunds/${mine.id}/approve`, { ...MGR, managerPin: "000000" })).status, 403, "a wrong PIN");
  const done = await leo.call(`/refunds/${mine.id}/approve`, MGR);
  assert.equal(done.status, 200);
  assert.equal(done.body.orderRefunded, true);
  assert.equal(done.body.method, "Cash");
  const [[after]] = await pool.query("SELECT o.OrderStatusCode AS o, p.PaymentStatusCode AS p, r.RefundStatusCode AS r, r.ApprovedByEmployeeID AS signedBy FROM Orders o JOIN Payment p ON p.OrderID = o.OrderID JOIN Refund r ON r.OrderID = o.OrderID WHERE o.OrderID = ?", [s.orderId]);
  assert.deepEqual([after.o, after.p, after.r, after.signedBy], [7, 5, 2, "emp-leo"], "refunded in full, signed by the approver");
  assert.ok(!(await waiting()).some((r) => r.id === mine.id));
  assert.equal((await leo.call(`/refunds/${mine.id}/approve`, MGR)).status, 409, "it isn't waiting any more");
});

test("two managers approving the same refund pay it once", async () => {
  const s = await sale(1);
  assert.equal((await ask(s)).status, 200);
  const mine = (await waiting()).find((r) => r.orderNumber === s.number);
  const answers = await Promise.all([leo.call(`/refunds/${mine.id}/approve`, MGR), maya.call(`/refunds/${mine.id}/approve`, { managerNumber: "10420001", managerPin: "111111" })]);
  assert.deepEqual(answers.map((a) => a.status).sort(), [200, 409]);
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM Refund WHERE OrderID = ? AND RefundStatusCode = 2", [s.orderId]);
  assert.equal(n.n, 1);
});

test("a rejected refund frees its items, and the rule broken is named", async () => {
  const s = await sale(1);
  assert.equal((await ask(s)).status, 200);
  const first = (await waiting()).find((r) => r.orderNumber === s.number);
  assert.equal((await sam.call(`/refunds/${first.id}/reject`, {})).status, 403);
  assert.equal((await leo.call(`/refunds/${first.id}/reject`, {})).status, 200);
  assert.equal((await leo.call(`/refunds/${first.id}/reject`, {})).status, 409);
  assert.equal((await sam.call(`/refunds/order?q=${s.number}`)).body.lines[0].returned, 0, "nothing is counted as returned");

  assert.equal((await ask(s)).status, 200, "so it can be asked for again");
  await pool.query("UPDATE Orders SET CompletedAt = CompletedAt - INTERVAL 30 DAY WHERE OrderID = ?", [s.orderId]);
  const old = (await waiting()).find((r) => r.orderNumber === s.number);
  assert.match(old.why, /^Order older than \d+ days$/);
  await leo.call(`/refunds/${old.id}/reject`, {});

  const big = await sale(8); // 8 x $3.50 plus tax is over the $25 limit
  assert.equal((await ask(big)).status, 200);
  const over = (await waiting()).find((r) => r.orderNumber === big.number);
  assert.match(over.why, /^Over the \$25\.00 limit$/);
  await leo.call(`/refunds/${over.id}/reject`, {});
});

test("stock goes back when a refund is approved, not when it is asked for", async () => {
  const bags = async () => (await leo.call("/inventory?locationId=loc-downtown")).body.rows.find((r) => r.id === "stk-bag").onHand;
  const s = await sale(1, "var-bag"); // bags are resale goods, so they can go back on the shelf
  const afterSale = await bags();
  assert.equal((await ask(s, sam, { lines: [{ orderItemId: s.line.orderItemId, qty: 1, restock: true }] })).status, 200);
  assert.equal(await bags(), afterSale, "asking leaves the shelf alone");
  const mine = (await waiting()).find((r) => r.orderNumber === s.number);
  assert.deepEqual(mine.lines, [{ name: "House blend, whole bean", qty: 1, restocked: 1 }]);
  assert.equal((await leo.call(`/refunds/${mine.id}/approve`, MGR)).status, 200);
  assert.equal(await bags(), afterSale + 1, "approving puts the bag back");
});

test("an order that sold a gift card can't be asked for", async () => {
  const gift = await ask({ orderId: "ord-dt-gift-sale", line: { orderItemId: "ord-dt-gift-sale-0", bought: 1 } });
  assert.equal(gift.status, 409);
  assert.match(gift.body.error, /gift card/);
});

test("only an owner can switch location, among their own locations", async () => {
  const me = async () => (await maya.call("/session")).body;
  for (const who of [leo, sam]) {
    assert.equal((await who.call("/locations")).status, 403);
    assert.equal((await who.call("/locations/switch", { locationId: "loc-downtown" })).status, 403);
  }
  assert.equal((await leo.call("/session")).body.canSwitch, false, "the switch is offered from the session (81ef1f8 moved it there)");
  const places = (await maya.call("/locations")).body;
  assert.deepEqual(places.locations.map((l) => l.id), ["loc-campus", "loc-downtown"]);
  assert.equal((await maya.call("/session")).body.canSwitch, true);
  assert.equal((await maya.call("/locations/switch", { locationId: "nope" })).status, 403);
  try {
    assert.equal((await maya.call("/locations/switch", { locationId: "loc-downtown" })).status, 200);
    assert.equal((await me()).locationName, "Brewbean Downtown");
    assert.equal((await maya.call("/attention")).body.location, "Brewbean Downtown");
    assert.equal((await maya.call("/locations")).body.current, "loc-downtown");
  } finally {
    await maya.call("/locations/switch", { locationId: "loc-campus" });
  }
  assert.equal((await maya.call("/attention")).body.location, "Brewbean Campus");
});

test("nothing is left waiting", async () => {
  assert.deepEqual((await waiting()).filter((r) => r.askedBy === "Sam"), []);
});
