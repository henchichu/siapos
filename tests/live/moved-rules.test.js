// Needs the dev database. Rules the backend now enforces on its own (the database triggers for them were removed):
// a variant with no recipe can't be sold, and a tax-inclusive business's lines carry its convention.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { start, client, pool, admin, creds, pickUp, topUp } = require("./env");

let env, sam;
const sale = (items) => sam.call("/register/orders", { saleId: crypto.randomUUID(), items, payment: { method: "cash" } });

test.before(async () => {
  env = await start();
  sam = client(env.base);
  assert.equal((await sam.call("/login", creds("10420003"))).status, 200);
  await topUp("stk-croissant", 500);
});
test.after(async () => { env.server.close(); await pool.end(); await admin.end(); });

test("a variant with no recipe can't be sold at the register or the kiosk, and nothing is saved", async () => {
  const id = `prd-test-${Date.now().toString(36)}`;
  await admin.query("INSERT INTO Product (ProductID, BusinessID, CategoryID, Name) VALUES (?, 'biz-brewbean', 'cat-coffee', 'Mystery')", [id]);
  await admin.query("INSERT INTO ProductVariant (VariantID, ProductID, BusinessID, Name, SKU, Price, TaxCategoryID) VALUES (?, ?, 'biz-brewbean', 'Regular', ?, 1.00, 'tax-prepared')", [`${id}-v`, id, id.toUpperCase()]);
  try {
    const [[{ before }]] = await pool.query("SELECT COUNT(*) AS `before` FROM Orders");
    const r = await sale([{ key: "a", variantId: `${id}-v`, quantity: 1 }]);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /no recipe/);
    assert.equal((await sam.call("/register/price", { items: [{ key: "a", variantId: `${id}-v`, quantity: 1 }] })).status, 409);
    const ava = client(env.base);
    await ava.call("/login", { email: "ava@example.com", password: "ava-dev-pass" });
    assert.equal((await ava.call("/customer/price", { items: [{ key: "a", variantId: `${id}-v`, quantity: 1 }] })).status, 409);
    assert.equal((await pool.query("SELECT COUNT(*) AS n FROM Orders"))[0][0].n, before, "no order was made");
  } finally {
    await admin.query("DELETE FROM ProductVariant WHERE ProductID = ?", [id]);
    await admin.query("DELETE FROM Product WHERE ProductID = ?", [id]);
  }
});

// The database no longer cross-checks this at completion, so the one code path that writes both sides is tested here.
test("a sale's SALE ledger rows equal minus the components its lines used, per stock item", async () => {
  const r = await sale([{ key: "a", variantId: "var-croissant", quantity: 2 }, { key: "b", variantId: "var-croissant", quantity: 1 }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [[o]] = await pool.query("SELECT OrderID AS id FROM Orders WHERE OrderNumber = ? AND BusinessID = 'biz-brewbean'", [r.body.orderNumber]);
  const [rows] = await admin.query(
    `SELECT x.StockItemID FROM (
       SELECT c.StockItemID, c.QuantityUsed q FROM OrderItemComponent c JOIN OrderItem oi ON oi.OrderItemID = c.OrderItemID WHERE oi.OrderID = ?
       UNION ALL
       SELECT StockItemID, QuantityChange FROM InventoryTransaction WHERE OrderID = ? AND TransactionTypeCode = 2) x
      GROUP BY x.StockItemID HAVING SUM(x.q) <> 0`, [o.id, o.id]);
  assert.deepEqual(rows, [], "every stock item nets to zero");
  const [[{ n }]] = await admin.query("SELECT COUNT(*) AS n FROM InventoryTransaction WHERE OrderID = ? AND TransactionTypeCode = 2", [o.id]);
  assert.ok(n > 0, "the sale did write ledger rows");
  await pickUp(r.body.orderNumber);
});

test("on a tax-inclusive business, a sale's lines carry the order's convention and the price is the total", async () => {
  await admin.query("UPDATE Business SET PricesIncludeTax = 1 WHERE BusinessID = 'biz-brewbean'");
  try {
    const r = await sale([{ key: "a", variantId: "var-croissant", quantity: 2 }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [[o]] = await pool.query("SELECT OrderID AS id, PricesIncludeTax AS inc, Total AS total, Subtotal AS subtotal FROM Orders WHERE OrderNumber = ? AND BusinessID = 'biz-brewbean'", [r.body.orderNumber]);
    const [lines] = await pool.query("SELECT PricesIncludeTax AS inc, LineTotal AS lt, TaxAmount AS tax FROM OrderItem WHERE OrderID = ?", [o.id]);
    assert.deepEqual([o.inc, lines.map((l) => l.inc)], [1, [1]]);
    assert.equal(Number(o.total), Number(o.subtotal), "tax is inside the price: the total is the subtotal");
    assert.ok(Number(lines[0].tax) > 0 && Number(lines[0].tax) < Number(lines[0].lt));
    await pickUp(r.body.orderNumber);
  } finally {
    await admin.query("UPDATE Business SET PricesIncludeTax = 0 WHERE BusinessID = 'biz-brewbean'");
  }
});
