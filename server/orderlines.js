// What a counter sale and a kiosk order share: the lines, their options, the stock each takes with its cost, and the ledger.
// The database checks that a line's cost equals its components' cost, so both are written here, the same way every time.
const crypto = require("crypto");
const { HttpError } = require("./errors");
const { dollars } = require("./pricing");

const thousandths = (s) => Math.round(parseFloat(s) * 1000);

// Stock a line uses per unit sold: its recipe, minus what substitutions swap out, plus additions (thousandths)
async function components(conn, line) {
  const [recipe] = await conn.query("SELECT StockItemID, QuantityPerUnit FROM VariantRecipe WHERE VariantID = ?", [line.variantId]);
  const used = new Map(recipe.map((r) => [r.StockItemID, thousandths(r.QuantityPerUnit)]));
  const modIds = line.modifiers.map((m) => m.id);
  if (modIds.length) {
    const [subs] = await conn.query("SELECT FromStockItemID, ToStockItemID FROM ModifierSubstitution WHERE ModifierID IN (?)", [modIds]);
    for (const s of subs) {
      if (!used.has(s.FromStockItemID)) continue;
      const amount = used.get(s.FromStockItemID);
      used.delete(s.FromStockItemID);
      if (s.ToStockItemID) used.set(s.ToStockItemID, (used.get(s.ToStockItemID) || 0) + amount);
    }
    const [adds] = await conn.query("SELECT StockItemID, Quantity FROM ModifierAddition WHERE ModifierID IN (?)", [modIds]);
    for (const a of adds) used.set(a.StockItemID, (used.get(a.StockItemID) || 0) + thousandths(a.Quantity));
  }
  return [...used].map(([stockItemId, perUnit]) => [stockItemId, perUnit * line.quantity]);
}

// priced is what priceCart returned. employeeId is null for a kiosk order. unavailable(line) words the error for a line
// whose stock has no cost recorded here.
async function addOrderLines(conn, { orderId, businessId, locationId, employeeId, priced, unavailable }) {
  const sale = new Map(); // stock item -> thousandths used across the whole order
  for (const l of priced.lines) {
    const itemId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO OrderItem (OrderItemID, OrderID, VariantID, BusinessID, Quantity, UnitPrice, LineTotal,
                              DiscountAmount, TaxCategoryID, TaxRate, TaxAmount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [itemId, orderId, l.variantId, businessId, l.quantity, dollars(l.unitCents), dollars(l.lineCents),
       dollars(l.lineDiscountCents), l.taxCategoryId, l.rate, dollars(l.taxCents)]
    );
    for (const m of l.modifiers)
      await conn.query("INSERT INTO OrderItemModifier (OrderItemID, ModifierID, BusinessID, PriceDelta) VALUES (?, ?, ?, ?)",
        [itemId, m.id, businessId, dollars(m.deltaCents)]);

    const used = await components(conn, l);
    if (!used.length) continue;
    const [costs] = await conn.query(
      `SELECT i.StockItemID, i.AverageUnitCost, s.StockUnitCode, s.Name
         FROM Inventory i JOIN StockItem s ON s.StockItemID = i.StockItemID
        WHERE i.LocationID = ? AND i.StockItemID IN (?)`,
      [locationId, used.map(([id]) => id)]
    );
    for (const [stockItemId, t] of used) {
      const c = costs.find((x) => x.StockItemID === stockItemId);
      if (!c || c.AverageUnitCost == null) throw new HttpError(409, unavailable(l));
      await conn.query(
        `INSERT INTO OrderItemComponent (OrderItemID, StockItemID, BusinessID, QuantityUsed, StockUnitCode, UnitCost)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [itemId, stockItemId, businessId, (t / 1000).toFixed(3), c.StockUnitCode, c.AverageUnitCost]
      );
      sale.set(stockItemId, { t: (sale.get(stockItemId)?.t || 0) + t, cost: c.AverageUnitCost });
    }
    await conn.query(
      `UPDATE OrderItem oi
          SET oi.UnitCost = (SELECT ROUND(SUM(c.QuantityUsed * c.UnitCost) / oi.Quantity, 6)
                               FROM OrderItemComponent c WHERE c.OrderItemID = oi.OrderItemID),
              oi.LineCost = ROUND(oi.Quantity * oi.UnitCost, 6)
        WHERE oi.OrderItemID = ?`,
      [itemId]
    );
  }
  for (const [stockItemId, { t, cost }] of sale)
    await conn.query(
      `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                         QuantityChange, UnitCost, TransactionTypeCode, OrderID)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, 2, ?)`,
      [businessId, stockItemId, locationId, employeeId, (-t / 1000).toFixed(3), cost, orderId]
    );
}

// What a repeated order request is compared by: a hash, so the remembered request holds no card details
const fingerprint = (body) => crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");

module.exports = { addOrderLines, fingerprint };
