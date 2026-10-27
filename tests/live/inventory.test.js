// Needs the dev database. Restocks, adjusts, receives a delivery and counts, always returning the quantities to where they were.
// The ledger can't be edited, so each run leaves its movements, one delivery and one count behind.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, removeCatalog } = require("./env");
const madeSuppliers = [];
const madeProducts = []; // switched-off products that use a test ingredient; removed before the ingredient
const madeItems = []; // stock items created here, removed again (never stocked, so they have no ledger rows and can go)

let env, leo, sam, jordan, stamp;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });
const ITEM = "stk-cup-12"; // 12 oz cup: counted in whole units ("each")
const row = async (id = ITEM, where = "") => (await leo.call(`/inventory${where}`)).body.rows.find((r) => r.id === id);
const change = (body) => leo.call("/inventory/change", { stockItemId: ITEM, ...body });

test.before(async () => { env = await start(); leo = await signIn("10420002", "222222"); sam = await signIn("10420003", "333333"); jordan = await signIn("10420005", "555555"); stamp = Date.now().toString(36); });
test.after(async () => {
  try { // never stocked or delivered to, so they have no ledger rows and can go
    await removeCatalog({ products: madeProducts });
    if (madeSuppliers.length) await pool.query("DELETE FROM Supplier WHERE SupplierID IN (?)", [madeSuppliers]);
    if (madeItems.length) for (const sql of ["DELETE FROM StockItemSupplier WHERE StockItemID IN (?)", "DELETE FROM Inventory WHERE StockItemID IN (?)", "DELETE FROM StockItem WHERE StockItemID IN (?)"]) await pool.query(sql, [madeItems]);
  } finally { env.server.close(); await pool.end(); }
});

test("only managers reach Inventory", async () => {
  assert.equal((await sam.call("/inventory")).status, 403);
  assert.equal((await jordan.call("/inventory")).status, 403);
  assert.equal((await sam.call("/inventory/change", { stockItemId: ITEM, type: "restock", quantity: "1", unitCost: "0.1" })).status, 403);
  assert.equal((await page(sam, "/inventory.html")).headers.get("location"), "/register.html");
  assert.equal((await page(jordan, "/inventory.html")).headers.get("location"), "/kitchen.html");
  assert.equal((await page(leo, "/inventory.html")).status, 200);

  const data = (await leo.call("/inventory")).body;
  assert.equal(data.canChange, true);
  assert.ok(data.locations.length >= 1 && data.suppliers.length >= 4 && data.items.length >= 10);
  const milk = data.rows.find((r) => r.name === "Whole milk");
  assert.equal(milk.unit, "ml");
  assert.ok(milk.onHand > 0 && milk.reorderAt > 0 && milk.avgCost > 0 && milk.supplierIds.length === 1);
  assert.ok(Array.isArray(data.movements) && Array.isArray(data.deliveries));
  assert.equal((await leo.call("/inventory?locationId=loc-nowhere")).status, 403, "only the manager's own locations");
});

test("restock, adjust and reorder threshold", async () => {
  const before = await row();
  const avg = before.avgCost; // restocking at the current average leaves the average cost alone
  assert.equal((await change({ type: "restock", quantity: "10" })).status, 400, "a restock needs what was paid");
  assert.equal((await change({ type: "restock", quantity: "0", total: "1.10" })).status, 400);
  assert.equal((await change({ type: "restock", quantity: "1.5", total: "1.10" })).status, 400, "cups are whole units");
  assert.equal((await change({ type: "restock", quantity: "10", total: "-1" })).status, 400);
  assert.equal((await change({ type: "adjust", quantity: "2" })).status, 400, "an adjustment needs a reason");
  assert.equal((await change({ type: "", quantity: "2" })).status, 400);
  assert.equal((await change({})).status, 400, "nothing to save");

  assert.equal((await change({ type: "restock", quantity: "10", total: String(Math.round(10 * avg * 100) / 100), note: "test" })).status, 200); // paid exactly the average, so the average stays
  assert.equal((await row()).onHand, before.onHand + 10);
  assert.equal((await row()).avgCost, avg);
  assert.equal((await change({ type: "adjust", reason: "broken", quantity: "3" })).status, 200, "a loss is entered as how much was lost");
  assert.equal((await row()).onHand, before.onHand + 7);
  assert.equal((await change({ type: "adjust", reason: "correction", quantity: "-7" })).status, 200, "a count correction goes either way");
  assert.equal((await row()).onHand, before.onHand);

  const moves = (await leo.call("/inventory")).body.movements;
  // the log is newest first; movements in the same second have no fixed order, so look for the three in the latest few
  const latest = moves.slice(0, 8).map((m) => `${m.type} ${m.delta}`);
  for (const expected of ["ADJUSTMENT · Broken or spilled -3", "ADJUSTMENT · Count correction -7", "RESTOCK 10"]) assert.ok(latest.includes(expected), `${expected} in ${latest}`);
  assert.equal((await change({ type: "adjust", reason: "spoiled", quantity: "9000000" })).status, 409, "more than is on hand is refused by the database");

  assert.equal((await change({ threshold: "250" })).status, 200, "a threshold can change on its own");
  assert.equal((await row()).reorderAt, 250);
  assert.equal((await change({ threshold: String(before.reorderAt) })).status, 200);
  assert.equal((await row()).reorderAt, before.reorderAt);
});

test("receive a delivery", async () => {
  const data = (await leo.call("/inventory")).body;
  const before = await row();
  const avg = before.avgCost;
  const delivery = (body) => leo.call("/inventory/delivery", { supplierId: "sup-supply", deliveredOn: data.location.today, invoice: `T-${stamp}`, lines: [{ stockItemId: ITEM, quantity: "5", total: String(Math.round(5 * avg * 100) / 100) }], ...body });

  assert.equal((await delivery({ lines: [] })).status, 400);
  assert.equal((await delivery({ supplierId: "nope" })).status, 400);
  assert.equal((await delivery({ deliveredOn: "yesterday" })).status, 400);
  assert.equal((await delivery({ lines: [{ stockItemId: ITEM, quantity: "0", total: "1" }] })).status, 400);
  assert.equal((await delivery({ lines: [{ stockItemId: ITEM, quantity: "1", total: "1" }, { stockItemId: ITEM, quantity: "1", total: "1" }] })).status, 400, "one line per item");
  assert.equal((await sam.call("/inventory/delivery", { supplierId: "sup-supply", deliveredOn: data.location.today, lines: [] })).status, 403);

  const done = await delivery({});
  assert.equal(done.status, 200);
  assert.equal(done.body.lines, 1);
  assert.equal(done.body.total, Math.round(5 * avg * 100) / 100);
  assert.equal((await delivery({ invoice: `T2-${stamp}`, lines: [{ stockItemId: ITEM, quantity: "5" }] })).status, 400, "each line needs what was paid");
  assert.equal((await row()).onHand, before.onHand + 5);
  assert.equal((await delivery({})).status, 409, "the same invoice can't be received twice");

  const recent = (await leo.call("/inventory")).body.deliveries[0];
  assert.deepEqual([recent.supplier, recent.lines], ["Counter Supply Co.", 1]);
  assert.equal((await change({ type: "adjust", reason: "correction", quantity: "-5" })).status, 200); // put the cups back
  assert.equal((await row()).onHand, before.onHand);
});

test("stock count: only differences are corrected, against what is on hand now", async () => {
  const before = await row();
  const count = (counts, extra = {}) => leo.call("/inventory/count", { counts, ...extra });
  assert.equal((await count([])).status, 400);
  assert.equal((await count([{ stockItemId: ITEM, counted: "-1" }])).status, 400);
  assert.equal((await count([{ stockItemId: ITEM, counted: "2.5" }])).status, 400, "whole units");
  assert.equal((await count([{ stockItemId: ITEM, counted: "1" }, { stockItemId: ITEM, counted: "2" }])).status, 400);
  assert.equal((await sam.call("/inventory/count", { counts: [{ stockItemId: ITEM, counted: "1" }] })).status, 403);

  const same = await count([{ stockItemId: ITEM, counted: String(before.onHand) }], { note: "no change" });
  assert.deepEqual(same.body, { counted: 1, differ: 0, value: 0 });

  const off = await count([{ stockItemId: ITEM, counted: String(before.onHand + 4) }, { stockItemId: "stk-muffin", counted: String((await row("stk-muffin")).onHand) }]);
  assert.equal(off.status, 200);
  assert.deepEqual([off.body.counted, off.body.differ, off.body.value], [2, 1, Math.round(4 * before.avgCost * 100) / 100]);
  assert.equal((await row()).onHand, before.onHand + 4);
  assert.ok((await leo.call("/inventory")).body.movements.slice(0, 8).some((m) => m.type === "ADJUSTMENT · Count correction" && m.delta === 4));
  assert.equal((await count([{ stockItemId: ITEM, counted: String(before.onHand) }])).body.differ, 1); // and back
  assert.equal((await row()).onHand, before.onHand);
});

test("add a stock item", async () => {
  const unit = (await leo.call("/inventory")).body.units.find((u) => u.symbol === "ml");
  assert.ok(unit, "units come with the page");
  const add = (body) => leo.call("/inventory/item", { name: `Test syrup ${stamp}`, unitCode: unit.code, threshold: "300", supplierId: "sup-supply", ...body });
  assert.equal((await add({ name: "  " })).status, 400);
  assert.equal((await add({ unitCode: 9999 })).status, 400);
  assert.equal((await add({ supplierId: "nope" })).status, 400);
  assert.equal((await add({ threshold: "-1" })).status, 400);
  assert.equal((await sam.call("/inventory/item", { name: "x", unitCode: unit.code })).status, 403);

  const made = await add({});
  assert.equal(made.status, 200);
  madeItems.push(made.body.id);
  const item = await row(made.body.id);
  assert.deepEqual([item.name, item.unit, item.onHand, item.reorderAt, item.avgCost, item.supplierIds], [`Test syrup ${stamp}`, "ml", 0, 300, null, ["sup-supply"]]);
  assert.equal((await add({})).status, 409, "names are unique");
  assert.ok((await leo.call("/inventory")).body.items.some((i) => i.id === made.body.id), "it can be restocked and delivered straight away");
});

test("the unit cost is worked out from the total paid", async () => {
  // One fixture item serves every run (a stocked item can't be deleted), so expectations are worked from where it starts
  const unit = (await leo.call("/inventory")).body.units.find((u) => u.symbol === "ml");
  const [[found]] = await pool.query("SELECT StockItemID AS id FROM StockItem WHERE Name = 'Test cost fixture'");
  const id = found ? found.id : (await leo.call("/inventory/item", { name: "Test cost fixture", unitCode: unit.code })).body.id;
  assert.equal((await leo.call(`/inventory/item/${id}/active`, { active: true })).status, 200);
  const weighted = (q0, avg0, q, cost) => (q0 > 0 && avg0 != null ? Math.round(((q0 * avg0 + q * cost) / (q0 + q)) * 1e6) / 1e6 : cost);
  try {
    const restock = (quantity, total) => leo.call("/inventory/change", { stockItemId: id, type: "restock", quantity, total });
    let now = await row(id);
    assert.equal((await restock("1000", "1.15")).status, 200);
    let next = await row(id);
    assert.equal(next.onHand, now.onHand + 1000);
    assert.equal(next.avgCost, weighted(now.onHand, now.avgCost, 1000, 0.00115), "$1.15 for 1000 ml is $0.00115 a ml");
    now = next;
    assert.equal((await restock("1000", "3.00")).status, 200);
    assert.equal((await row(id)).avgCost, weighted(now.onHand, now.avgCost, 1000, 0.003), "$3.00 for 1000 ml is $0.003 a ml");
    assert.equal((await restock("3", "0")).status, 200, "a free restock is fine");
  } finally { await leo.call(`/inventory/item/${id}/active`, { active: false }); }
});

test("add a supplier", async () => {
  const add = (body) => leo.call("/inventory/supplier", { name: `Test dairy ${stamp}`, email: "orders@test.example", phone: "312-555-0199", ...body });
  assert.equal((await add({ name: " " })).status, 400);
  assert.equal((await add({ email: "not an email" })).status, 400);
  assert.equal((await add({ phone: "1".repeat(31) })).status, 400);
  assert.equal((await sam.call("/inventory/supplier", { name: "x" })).status, 403);
  const made = await add({});
  assert.equal(made.status, 200);
  madeSuppliers.push(made.body.id);
  assert.ok((await leo.call("/inventory")).body.suppliers.some((s) => s.id === made.body.id && s.name === `Test dairy ${stamp}`));
  assert.equal((await add({})).status, 409, "supplier names are unique");
  assert.equal((await leo.call("/inventory/supplier", { name: "Only a name" + stamp })).status, 200, "email and phone are optional");
  const [[extra]] = await pool.query("SELECT SupplierID AS id FROM Supplier WHERE Name = ?", ["Only a name" + stamp]);
  madeSuppliers.push(extra.id);
});

test("deactivate and reactivate stock items", async () => {
  const unit = (await leo.call("/inventory")).body.units.find((u) => u.symbol === "g");
  const name = `Test off ${stamp}`;
  const made = await leo.call("/inventory/item", { name, unitCode: unit.code, threshold: "5" });
  madeItems.push(made.body.id);
  const toggle = (id, active, who = leo) => who.call(`/inventory/item/${id}/active`, { active });
  const state = async () => { const d = (await leo.call("/inventory")).body; return [d.rows.find((r) => r.id === made.body.id)?.active, d.items.some((i) => i.id === made.body.id)]; };
  assert.deepEqual(await state(), [true, true]);

  assert.equal((await toggle(made.body.id, false, sam)).status, 403);
  assert.equal((await toggle("nope", false)).status, 404);
  assert.equal((await toggle(made.body.id, false)).status, 200);
  assert.deepEqual(await state(), [false, false], "still listed (for the toggle), but not offered for restocks, deliveries or counts");
  assert.equal((await leo.call("/inventory/change", { stockItemId: made.body.id, type: "restock", quantity: "1", total: "1" })).status, 404, "a deactivated item can't be changed");
  assert.equal((await leo.call("/inventory/count", { counts: [{ stockItemId: made.body.id, counted: "1" }] })).status, 404);
  const again = await leo.call("/inventory/item", { name, unitCode: unit.code });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /deactivated stock item has that name/);

  assert.equal((await toggle(made.body.id, true)).status, 200);
  assert.deepEqual(await state(), [true, true]);
  assert.equal((await leo.call("/inventory/change", { stockItemId: made.body.id, threshold: "9" })).status, 200, "and works again once reactivated");

  const used = await toggle("stk-milk", false);
  assert.equal(used.status, 409, "an ingredient that recipes use can't be switched off");
  assert.match(used.body.error, /product recipe/);
  assert.equal((await row("stk-milk")).active, true);
});

test("deactivate and reactivate suppliers", async () => {
  const made = await leo.call("/inventory/supplier", { name: `Test off supplier ${stamp}` });
  madeSuppliers.push(made.body.id);
  const toggle = (active, who = leo) => who.call(`/inventory/supplier/${made.body.id}/active`, { active });
  const listed = async () => (await leo.call("/inventory")).body.suppliers.find((x) => x.id === made.body.id);
  const delivery = async () => leo.call("/inventory/delivery", { supplierId: made.body.id, deliveredOn: (await leo.call("/inventory")).body.location.today, lines: [{ stockItemId: ITEM, quantity: "1", total: "0.11" }] });
  assert.equal((await listed()).active, true);

  assert.equal((await toggle(false, sam)).status, 403);
  assert.equal((await leo.call("/inventory/supplier/nope/active", { active: false })).status, 404);
  assert.equal((await toggle(false)).status, 200);
  assert.equal((await listed()).active, false, "still in the list, marked off");
  assert.equal((await delivery()).status, 400, "no deliveries from a deactivated supplier");
  const again = await leo.call("/inventory/supplier", { name: `Test off supplier ${stamp}` });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /deactivated supplier has that name/);

  assert.equal((await toggle(true)).status, 200);
  assert.equal((await listed()).active, true);
});

test("deliveries and counts that touch the same items at once don't deadlock", async () => {
  const [a, b] = ["stk-cup-12", "stk-cup-16"];
  const before = { a: (await row(a)).onHand, b: (await row(b)).onHand };
  const avg = { a: (await row(a)).avgCost, b: (await row(b)).avgCost };
  const today = (await leo.call("/inventory")).body.location.today;
  const line = (id, n) => ({ stockItemId: id, quantity: "1", total: (Math.round(avg[id === a ? "a" : "b"] * 100) / 100).toFixed(2) });
  const calls = [];
  for (let i = 0; i < 2; i++) { // the same two items, in opposite order, in two requests at the same moment
    calls.push(leo.call("/inventory/delivery", { supplierId: "sup-supply", deliveredOn: today, invoice: `D${i}a-${stamp}`, lines: [line(a), line(b)] }));
    calls.push(leo.call("/inventory/delivery", { supplierId: "sup-supply", deliveredOn: today, invoice: `D${i}b-${stamp}`, lines: [line(b), line(a)] }));
  }
  const results = await Promise.all(calls);
  assert.deepEqual(results.map((r) => r.status), results.map(() => 200), JSON.stringify(results.filter((r) => r.status !== 200).map((r) => r.body)));
  const counts = [];
  for (let i = 0; i < 3; i++) {
    counts.push(leo.call("/inventory/count", { counts: [{ stockItemId: a, counted: String(before.a + 4) }, { stockItemId: b, counted: String(before.b + 4) }] }));
    counts.push(leo.call("/inventory/count", { counts: [{ stockItemId: b, counted: String(before.b + 4) }, { stockItemId: a, counted: String(before.a + 4) }] }));
  }
  assert.ok((await Promise.all(counts)).every((r) => r.status === 200));
  assert.equal((await leo.call("/inventory/count", { counts: [{ stockItemId: a, counted: String(before.a) }, { stockItemId: b, counted: String(before.b) }] })).status, 200); // put the cups back
});

test("a delivery date can't be in the future or years ago", async () => {
  const today = (await leo.call("/inventory")).body.location.today;
  const shift = async (days) => (await pool.query("SELECT DATE_FORMAT(? + INTERVAL ? DAY, '%Y-%m-%d') AS d", [today, days]))[0][0].d;
  const send = async (deliveredOn) => leo.call("/inventory/delivery", { supplierId: "sup-supply", deliveredOn, invoice: `W${deliveredOn}-${stamp}`, lines: [{ stockItemId: ITEM, quantity: "1", total: "0.11" }] });
  assert.match((await send(await shift(1))).body.error, /in the future/);
  assert.match((await send("2062-01-01")).body.error, /in the future/);
  assert.match((await send(await shift(-400))).body.error, /more than a year ago/);
  assert.equal((await send(await shift(-30))).status, 200, "last month is fine (a late invoice)");
  assert.equal((await leo.call("/inventory/count", { counts: [{ stockItemId: ITEM, counted: String((await row()).onHand - 1) }] })).status, 200); // put the cup back
});

test("an ingredient that only a deactivated product uses can't be deactivated either", async () => {
  const unit = (await leo.call("/inventory")).body.units.find((u) => u.symbol === "g");
  const item = await leo.call("/inventory/item", { name: `Test salt ${stamp}`, unitCode: unit.code });
  madeItems.push(item.body.id);
  const product = await leo.call("/products", { name: `Test salty ${stamp}`, active: false });
  madeProducts.push(product.body.id);
  const size = await leo.call(`/products/${product.body.id}/sizes`, { name: "Regular", sku: `SALT-${stamp}`, price: "1.00", taxCategoryId: "tax-prepared" });
  assert.equal((await leo.call(`/sizes/${size.body.id}/recipe`, { lines: [{ stockItemId: item.body.id, quantity: "2" }] })).status, 200);

  const blocked = await leo.call(`/inventory/item/${item.body.id}/active`, { active: false });
  assert.equal(blocked.status, 409, "the product is switched off, but could come back");
  assert.match(blocked.body.error, /1 product recipe/);
});

test("pending receipts are location scoped, atomic, and cannot be received twice", async () => {
  const original = await row();
  const [originalPending] = await pool.query("SELECT p.* FROM PurchaseOrder p JOIN Inventory i ON i.InventoryID=p.InventoryID WHERE i.LocationID='loc-campus' AND i.StockItemID=?", [ITEM]);
  try {
    await change({ threshold: String(original.onHand + 1) });
    const data = (await leo.call("/inventory")).body;
    const pending = data.pendingDeliveries.find((p) => p.stockItemId === ITEM);
    assert.ok(pending);
    assert.ok(pending.quantity > 0);
    assert.match(pending.orderNumber, /^PO-\d{6,}$/);
    assert.equal(pending.status, "Ordered");
    assert.equal(pending.supplierId, "sup-supply");
    assert.equal((await leo.call("/inventory?locationId=loc-downtown")).body.pendingDeliveries?.some((p) => p.id === pending.id), false);
    const body = { supplierId: "sup-supply", deliveredOn: data.location.today, purchaseOrderId: pending.id,
      lines: [{ stockItemId: ITEM, quantity: "1", total: "0.11" }] };
    assert.equal((await sam.call("/inventory/delivery", body)).status, 403);
    const missing = await leo.call("/inventory/delivery", { ...body, lines: [{ stockItemId: "stk-cup-16", quantity: "1", total: "0.11" }] });
    assert.equal(missing.status, 400);
    assert.equal((await row()).onHand, original.onHand);
    assert.equal((await leo.call("/inventory/delivery", { ...body, supplierId: "sup-bakery" })).status, 409, "the order supplier is fixed");
    const results = await Promise.all([leo.call("/inventory/delivery", body), leo.call("/inventory/delivery", body)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await row()).onHand, original.onHand + 1);
    const received = (await leo.call("/inventory")).body.deliveries.find((d) => d.id === results.find((r) => r.status === 200).body.id);
    assert.equal(received.orderNumber, pending.orderNumber);
    assert.equal(received.status, "Received");
    const [[saved]] = await pool.query("SELECT Status FROM PurchaseOrder WHERE PurchaseOrderID = ?", [pending.id]);
    assert.equal(saved.Status, "Received");
    const remaining = (await leo.call("/inventory")).body.pendingDeliveries.filter((p) => p.stockItemId === ITEM);
    assert.equal(remaining.length, 1, "partial receipt below threshold creates one follow-up");
    assert.notEqual(remaining[0].id, pending.id);
  } finally {
    await change({ threshold: String(original.reorderAt) });
    await leo.call("/inventory/count", { counts: [{ stockItemId: ITEM, counted: String(original.onHand) }] });
    const ids = originalPending.map((p) => p.PurchaseOrderID);
    const [current] = await pool.query("SELECT p.PurchaseOrderID AS id FROM PurchaseOrder p JOIN Inventory i ON i.InventoryID=p.InventoryID WHERE i.LocationID='loc-campus' AND i.StockItemID=?", [ITEM]);
    const added = current.filter((p) => !ids.includes(p.id)).map((p) => p.id);
    if (added.length) await pool.query("DELETE FROM PurchaseOrder WHERE PurchaseOrderID IN (?)", [added]);
    for (const p of originalPending) await pool.query("UPDATE PurchaseOrder SET ReceivedDeliveryID=? WHERE PurchaseOrderID=?", [p.ReceivedDeliveryID, p.PurchaseOrderID]);
  }
});

test("supplierless orders require assignment before receiving", async () => {
  const data = (await leo.call("/inventory")).body;
  const made = await leo.call("/inventory/item", { name: `Test purchase order ${stamp}`, unitCode: data.units.find((u) => u.symbol === "g").code, threshold: "5" });
  assert.equal(made.status, 200);
  madeItems.push(made.body.id);
  const draft = (await leo.call("/inventory")).body.pendingDeliveries.find((p) => p.stockItemId === made.body.id);
  assert.equal(draft.status, "Needs supplier");
  const receive = await leo.call("/inventory/delivery", { supplierId: "sup-supply", deliveredOn: data.location.today, purchaseOrderId: draft.id, lines: [{ stockItemId: made.body.id, quantity: "1", total: "1" }] });
  assert.equal(receive.status, 409);
  const path = `/inventory/purchase-order/${draft.id}/supplier`;
  assert.equal((await sam.call(path, { supplierId: "sup-supply" })).status, 403);
  assert.equal((await leo.call(path, { supplierId: "sup-supply", locationId: "loc-downtown" })).status, 409);
  assert.equal((await leo.call(path, { supplierId: "nope" })).status, 400);
  assert.equal((await leo.call(path, { supplierId: "sup-supply" })).status, 200);
  const placed = (await leo.call("/inventory")).body.pendingDeliveries.find((p) => p.id === draft.id);
  assert.equal(placed.status, "Ordered");
  assert.equal(placed.orderNumber, draft.orderNumber);
  assert.equal(placed.supplierId, "sup-supply");
  assert.ok((await row(made.body.id)).supplierIds.includes("sup-supply"), "the supplier is retained for future automatic orders");
  assert.equal((await leo.call("/inventory/change", { locationId: "loc-downtown", stockItemId: made.body.id, threshold: "5" })).status, 200);
  const nextOrder = (await leo.call("/inventory?locationId=loc-downtown")).body.pendingDeliveries.find((p) => p.stockItemId === made.body.id);
  assert.equal(nextOrder.supplierId, "sup-supply", "future automatic orders use the assigned supplier");
  assert.equal(nextOrder.status, "Ordered");
  assert.equal((await leo.call(path, { supplierId: "sup-bakery" })).status, 409);
});
