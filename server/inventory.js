const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const check = require("./validate");
const { hasPermission } = require("./pin");
const { requirePermission } = require("./session");
const { myLocations } = require("./locations");

const PERM_SEE = 14;    // See inventory
const PERM_CHANGE = 15; // Restock and adjust stock
const RESTOCK = 1, COUNT_CORRECTION = 8;
const REASONS = { broken: 5, spoiled: 6, stolen: 7, correction: COUNT_CORRECTION }; // the ledger's DAMAGED, EXPIRED, THEFT, COUNT_CORRECTION
const LABELS = { 1: "RESTOCK", 2: "SALE", 3: "RETURN", 4: "ADJUSTMENT", 5: "ADJUSTMENT · Broken or spilled", 6: "ADJUSTMENT · Spoiled or expired", 7: "ADJUSTMENT · Stolen", 8: "ADJUSTMENT · Count correction" };

const router = express.Router();
const see = requirePermission(PERM_SEE);
const change = requirePermission(PERM_CHANGE);
const uuid = () => crypto.randomUUID();

// ---- helpers ----------------------------------------------------------------------------------------------------

// Stock is only read and changed at locations the employee works at
async function placeOf(req, id) {
  const place = String(id || req.session.locationId);
  if (!(await myLocations(req.session.employeeId)).includes(place)) throw new HttpError(403, "You don't work at that location.");
  return place;
}

const blank = (v) => v === "" || v == null;
const decimals = (v, places, label, { allowZero = false } = {}) => {
  const n = Number(v);
  const scale = 10 ** places;
  if (blank(v) || !Number.isFinite(n) || Math.round(n * scale) / scale !== n || n > 10000000) throw new HttpError(400, `Enter a valid ${label}.`);
  if (n < 0 || (n === 0 && !allowZero)) throw new HttpError(400, `Enter a ${label} above zero.`);
  return n;
};

async function stockItem(db, businessId, id) {
  const [[item]] = await db.query(
    `SELECT s.StockItemID AS id, u.AllowsFraction AS fraction FROM StockItem s JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
      WHERE s.StockItemID = ? AND s.BusinessID = ? AND s.Active`,
    [String(id), businessId]
  );
  if (!item) throw new HttpError(404, "Choose a stock item from the list.");
  return item;
}
// What was paid for a quantity gives the unit cost the ledger keeps (six places, like its column)
// shortcut: the ledger keeps a six-decimal unit cost, so a very large quantity can drift a line's value by a cent; widen the column if cent-exact totals matter
const unitCostOf = (total, qty) => Math.round((total / qty) * 1e6) / 1e6;
const wholeIfEach = (item, n) => { if (!item.fraction && !Number.isInteger(n)) throw new HttpError(400, "This item is counted in whole units."); };

// A location starts with no row for an item it has never held; the ledger needs one to post to.
// The row is locked for writing first: INSERT IGNORE alone takes a shared lock on an existing row, and two requests that
// each hold one while waiting to write deadlock.
async function ensureRow(conn, businessId, locationId, stockItemId) {
  const [[row]] = await conn.query("SELECT 1 AS found FROM Inventory WHERE LocationID = ? AND StockItemID = ? FOR UPDATE", [locationId, stockItemId]);
  if (!row) await conn.query("INSERT IGNORE INTO Inventory (InventoryID, LocationID, StockItemID, BusinessID) VALUES (?, ?, ?, ?)", [uuid(), locationId, stockItemId, businessId]);
}

// Plain VALUES: the ledger trigger updates Inventory, which an INSERT ... SELECT from it can't also read
const post = (conn, { businessId, locationId, employeeId, stockItemId, qty, cost, type, note = null, deliveryId = null, countId = null }) =>
  conn.query(
    `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID, QuantityChange, UnitCost,
                                       TransactionTypeCode, DeliveryID, StockCountID, Note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), businessId, stockItemId, locationId, employeeId, qty.toFixed(3), cost, type, deliveryId, countId, note]
  );

// ---- Stock ------------------------------------------------------------------------------------------------------

router.get("/inventory", see, async (req, res) => {
  const { businessId, employeeId } = req.session;
  const locationId = await placeOf(req, req.query.locationId);
  const mine = await myLocations(employeeId);
  const [locations] = await pool.query("SELECT LocationID AS id, Name AS name FROM Location WHERE LocationID IN (?) ORDER BY Name", [mine]);
  const [[where]] = await pool.query(
    "SELECT Name AS name, DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', TimeZone), '%Y-%m-%d') AS today, TimeZone AS timeZone FROM Location WHERE LocationID = ?", [locationId]);
  const [suppliers] = await pool.query("SELECT SupplierID AS id, Name AS name, Active AS active FROM Supplier WHERE BusinessID = ? ORDER BY Name", [businessId]);
  const [units] = await pool.query("SELECT UnitCode AS code, Symbol AS symbol, Description AS description FROM UnitOfMeasure WHERE Active ORDER BY Description");
  const [quotes] = await pool.query("SELECT StockItemID AS stockItemId, SupplierID AS supplierId, UnitCost AS unitCost FROM StockItemSupplier WHERE BusinessID = ?", [businessId]);
  const [items] = await pool.query(
    `SELECT s.StockItemID AS id, s.Name AS name, u.Symbol AS unit, u.AllowsFraction AS fraction FROM StockItem s JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
      WHERE s.BusinessID = ? AND s.Active ORDER BY s.Name`, [businessId]);
  const [rows] = await pool.query(
    `SELECT i.StockItemID AS id, s.Name AS name, s.Active AS active, u.Symbol AS unit, i.Quantity AS onHand, i.ReorderThreshold AS reorderAt, i.AverageUnitCost AS avgCost
       FROM Inventory i JOIN StockItem s ON s.StockItemID = i.StockItemID JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
      WHERE i.LocationID = ? ORDER BY s.Name`, [locationId]);
  const [moves] = await pool.query(
    `SELECT t.TransactionDateTime AS at, s.Name AS item, u.Symbol AS unit, t.TransactionTypeCode AS type, t.QuantityChange AS delta,
            e.FirstName AS byName, o.OrderNumber AS orderNumber
       FROM InventoryTransaction t JOIN StockItem s ON s.StockItemID = t.StockItemID JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
       LEFT JOIN Employee e ON e.EmployeeID = t.EmployeeID LEFT JOIN Orders o ON o.OrderID = t.OrderID
      WHERE t.LocationID = ? ORDER BY t.TransactionDateTime DESC, t.InventoryTransactionID LIMIT 15`, [locationId]);
  const [deliveries] = await pool.query(
    `SELECT d.DeliveryID AS id, DATE_FORMAT(d.DeliveredOn, '%Y-%m-%d') AS date, sp.Name AS supplier, COUNT(t.InventoryTransactionID) AS lineCount,
            COALESCE(SUM(t.QuantityChange * t.UnitCost), 0) AS total,
            (SELECT CONCAT('PO-', LPAD(po.OrderNumber, GREATEST(6, LENGTH(po.OrderNumber)), '0'))
               FROM PurchaseOrder po WHERE po.ReceivedDeliveryID = d.DeliveryID LIMIT 1) AS orderNumber
       FROM Delivery d JOIN Supplier sp ON sp.SupplierID = d.SupplierID LEFT JOIN InventoryTransaction t ON t.DeliveryID = d.DeliveryID
      WHERE d.LocationID = ? GROUP BY d.DeliveryID, d.DeliveredOn, d.CreatedAt, sp.Name ORDER BY d.DeliveredOn DESC, d.CreatedAt DESC LIMIT 8`, [locationId]);

  const [pending] = await pool.query(
    `SELECT p.PurchaseOrderID AS id, CONCAT('PO-', LPAD(p.OrderNumber, GREATEST(6, LENGTH(p.OrderNumber)), '0')) AS orderNumber,
            p.Status AS status, p.CreatedAt AS createdAt, i.StockItemID AS stockItemId,
            s.Name AS item, s.Active AS active, u.Symbol AS unit, i.Quantity AS onHand, i.ReorderThreshold AS reorderAt,
            p.Quantity AS quantity, p.SupplierID AS supplierId, sp.Name AS supplier, sp.Active AS supplierActive, p.UnitCost AS unitCost
       FROM PurchaseOrder p JOIN Inventory i ON i.InventoryID = p.InventoryID
       JOIN StockItem s ON s.StockItemID = i.StockItemID JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
       LEFT JOIN Supplier sp ON sp.SupplierID = p.SupplierID
      WHERE i.LocationID = ? AND p.ReceivedDeliveryID IS NULL ORDER BY p.CreatedAt, p.OrderNumber`, [locationId]);

  const supplierIds = (id) => quotes.filter((q) => q.stockItemId === id).map((q) => q.supplierId);
  res.json({
    canChange: await hasPermission(pool, employeeId, PERM_CHANGE),
    locations, location: { id: locationId, ...where }, suppliers: suppliers.map((x) => ({ ...x, active: !!x.active })), units,
    quotes: quotes.map((q) => ({ ...q, unitCost: q.unitCost == null ? null : Number(q.unitCost) })),
    items: items.map((i) => ({ ...i, fraction: !!i.fraction })),
    rows: rows.map((r) => ({ ...r, active: !!r.active, onHand: Number(r.onHand), reorderAt: Number(r.reorderAt), avgCost: r.avgCost == null ? null : Number(r.avgCost), supplierIds: supplierIds(r.id) })),
    movements: moves.map((m) => ({ at: m.at, item: m.item, unit: m.unit, type: LABELS[m.type], delta: Number(m.delta), by: m.byName, orderNumber: m.orderNumber })),
    pendingDeliveries: pending.map((p) => ({ ...p, active: !!p.active, supplierActive: !!p.supplierActive, onHand: Number(p.onHand), reorderAt: Number(p.reorderAt),
      quantity: Number(p.quantity), unitCost: p.unitCost == null ? null : Number(p.unitCost) })),
    deliveries: deliveries.map(({ lineCount, ...d }) => ({ ...d, status: "Received", lines: lineCount, total: Number(d.total) })),
  });
});

// One form: a restock, an adjustment, a new reorder threshold, or both a quantity and a threshold
router.post("/inventory/change", change, async (req, res) => {
  const { businessId, employeeId } = req.session;
  const b = req.body;
  const locationId = await placeOf(req, b.locationId);
  const item = await stockItem(pool, businessId, b.stockItemId);
  const hasQty = !blank(b.quantity), hasThreshold = !blank(b.threshold);
  if (!hasQty && !hasThreshold) throw new HttpError(400, "Enter a quantity or a new reorder threshold.");
  const threshold = hasThreshold ? decimals(b.threshold, 3, "reorder threshold", { allowZero: true }) : null;
  const note = check.note(b.note, "note", 255) || null;

  let entry = null; // what goes in the ledger
  if (hasQty && b.type === "restock") {
    const qty = decimals(b.quantity, 3, "quantity");
    wholeIfEach(item, qty);
    entry = { qty, cost: unitCostOf(decimals(b.total, 2, "total paid", { allowZero: true }), qty), type: RESTOCK };
  } else if (hasQty && b.type === "adjust") {
    const type = REASONS[b.reason];
    if (!type) throw new HttpError(400, "Choose a reason.");
    const raw = Number(b.quantity);
    if (!Number.isFinite(raw) || raw === 0 || Math.round(raw * 1000) / 1000 !== raw || Math.abs(raw) > 10000000) throw new HttpError(400, "Enter a valid quantity.");
    wholeIfEach(item, raw);
    // A loss is entered as how much was lost; only a count correction can go either way
    entry = { qty: type === COUNT_CORRECTION ? raw : -Math.abs(raw), type };
  } else if (hasQty) throw new HttpError(400, "Choose Restock or Adjustment.");

  const onHand = await pool.tx(async (conn) => {
    await ensureRow(conn, businessId, locationId, item.id);
    const [[row]] = await conn.query("SELECT AverageUnitCost AS cost FROM Inventory WHERE LocationID = ? AND StockItemID = ? FOR UPDATE", [locationId, item.id]);
    if (entry) {
      if (entry.type !== RESTOCK) {
        entry.cost = row.cost; // losses and corrections are valued at the average cost
        if (entry.cost == null && entry.type !== COUNT_CORRECTION) throw new HttpError(409, "No cost is recorded for this item yet. Restock it first.");
      }
      await post(conn, { businessId, locationId, employeeId, stockItemId: item.id, qty: entry.qty, cost: entry.cost, type: entry.type, note });
    }
    if (hasThreshold) await conn.query("UPDATE Inventory SET ReorderThreshold = ? WHERE LocationID = ? AND StockItemID = ?", [threshold, locationId, item.id]);
    const [[after]] = await conn.query("SELECT Quantity AS onHand FROM Inventory WHERE LocationID = ? AND StockItemID = ?", [locationId, item.id]);
    return Number(after.onHand);
  });
  res.json({ onHand });
});

// A new stock item starts with none on hand; Restock adds the first. It is set up at the location being looked at.
router.post("/inventory/item", change, async (req, res) => {
  const { businessId } = req.session;
  const b = req.body;
  const locationId = await placeOf(req, b.locationId);
  const name = check.label(b.name, "stock item's name", 150);
  const [[unit]] = await pool.query("SELECT UnitCode AS code FROM UnitOfMeasure WHERE UnitCode = ? AND Active", [Number(b.unitCode)]);
  if (!unit) throw new HttpError(400, "Choose the unit it is counted in.");
  const threshold = blank(b.threshold) ? 0 : decimals(b.threshold, 3, "reorder threshold", { allowZero: true });
  let supplierId = null;
  if (!blank(b.supplierId)) {
    const [[sup]] = await pool.query("SELECT SupplierID AS id FROM Supplier WHERE SupplierID = ? AND BusinessID = ? AND Active", [String(b.supplierId), businessId]);
    if (!sup) throw new HttpError(400, "Choose a supplier from the list.");
    supplierId = sup.id;
  }
  try {
    const id = await pool.tx(async (conn) => {
      const itemId = uuid();
      await conn.query("INSERT INTO StockItem (StockItemID, BusinessID, Name, StockUnitCode) VALUES (?, ?, ?, ?)", [itemId, businessId, name, unit.code]);
      if (supplierId) await conn.query("INSERT INTO StockItemSupplier (StockItemID, SupplierID, BusinessID, IsPreferred) VALUES (?, ?, ?, TRUE)", [itemId, supplierId, businessId]);
      await conn.query("INSERT INTO Inventory (InventoryID, LocationID, StockItemID, BusinessID, ReorderThreshold) VALUES (?, ?, ?, ?, ?)", [uuid(), locationId, itemId, businessId, threshold]);
      return itemId;
    });
    res.json({ id });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const [[old]] = await pool.query("SELECT Active AS active FROM StockItem WHERE BusinessID = ? AND Name = ?", [businessId, name]);
      throw new HttpError(409, old && !old.active ? "A deactivated stock item has that name. Reactivate it instead." : "A stock item with that name already exists.");
    }
    throw err;
  }
});

// ---- Suppliers --------------------------------------------------------------------------------------------------

// A supplier can be added while receiving from a new one
router.post("/inventory/supplier", change, async (req, res) => {
  const { businessId } = req.session;
  const name = check.label(req.body.name, "supplier's name", 100);
  const email = check.email(req.body.email);
  const phone = check.contactPhone(req.body.phone);
  const id = uuid();
  try {
    await pool.query("INSERT INTO Supplier (SupplierID, BusinessID, Name, ContactEmail, ContactPhone) VALUES (?, ?, ?, ?, ?)", [id, businessId, name, email, phone]);
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      const [[old]] = await pool.query("SELECT Active AS active FROM Supplier WHERE BusinessID = ? AND Name = ?", [businessId, name]);
      throw new HttpError(409, old && !old.active ? "A deactivated supplier has that name. Reactivate it instead." : "A supplier with that name already exists.");
    }
    throw err;
  }
  res.json({ id });
});

// An item without a configured supplier stays a draft until the supplier is assigned.
router.post("/inventory/purchase-order/:id/supplier", change, async (req, res) => {
  const locationId = await placeOf(req, req.body.locationId);
  const { businessId } = req.session;
  const [[supplier]] = await pool.query("SELECT SupplierID AS id FROM Supplier WHERE SupplierID = ? AND BusinessID = ? AND Active", [String(req.body.supplierId), businessId]);
  if (!supplier) throw new HttpError(400, "Choose an active supplier.");
  await pool.tx(async (conn) => {
    const [[order]] = await conn.query(
      `SELECT p.PurchaseOrderID AS id, p.SupplierID AS supplierId, i.StockItemID AS stockItemId
         FROM PurchaseOrder p JOIN Inventory i ON i.InventoryID = p.InventoryID
        WHERE p.PurchaseOrderID = ? AND i.BusinessID = ? AND i.LocationID = ? AND p.ReceivedDeliveryID IS NULL FOR UPDATE`,
      [req.params.id, businessId, locationId]);
    if (!order || order.supplierId) throw new HttpError(409, "This order is no longer waiting for a supplier. Refresh the list.");
    const [[quote]] = await conn.query("SELECT MinOrderQty AS minimum, UnitCost AS cost FROM StockItemSupplier WHERE StockItemID = ? AND SupplierID = ?", [order.stockItemId, supplier.id]);
    // Keep the chosen supplier available to future automatic orders for this item.
    await conn.query("INSERT IGNORE INTO StockItemSupplier (StockItemID, SupplierID, BusinessID) VALUES (?, ?, ?)",
      [order.stockItemId, supplier.id, businessId]);
    await conn.query("UPDATE PurchaseOrder SET SupplierID = ?, UnitCost = ?, Quantity = GREATEST(Quantity, ?) WHERE PurchaseOrderID = ?",
      [supplier.id, quote?.cost ?? null, quote?.minimum ?? 1, order.id]);
  });
  res.json({ status: "Ordered" });
});

// ---- Receive delivery -------------------------------------------------------------------------------------------

router.post("/inventory/delivery", change, async (req, res) => {
  const { businessId, employeeId } = req.session;
  const b = req.body;
  const locationId = await placeOf(req, b.locationId);
  const [[supplier]] = await pool.query("SELECT SupplierID AS id FROM Supplier WHERE SupplierID = ? AND BusinessID = ? AND Active", [String(b.supplierId), businessId]);
  if (!supplier) throw new HttpError(400, "Choose the supplier.");
  if (!/^\d{4}-\d\d-\d\d$/.test(b.deliveredOn)) throw new HttpError(400, "Choose the delivery date.");
  const [[window]] = await pool.query(
    `SELECT ? > DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', TimeZone)) AS future,
            ? < DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', TimeZone)) - INTERVAL 1 YEAR AS old FROM Location WHERE LocationID = ?`, [b.deliveredOn, b.deliveredOn, locationId]);
  if (window.future) throw new HttpError(400, "The delivery date can't be in the future.");
  if (window.old) throw new HttpError(400, "The delivery date is more than a year ago. Check the year.");
  const invoice = check.label(b.invoice, "invoice number", 50, { required: false }) || null;
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) throw new HttpError(400, "Add at least one line.");
  const seen = new Set();
  const clean = [];
  for (const l of lines) {
    const item = await stockItem(pool, businessId, l.stockItemId);
    if (seen.has(item.id)) throw new HttpError(400, "Each stock item can appear once in a delivery.");
    seen.add(item.id);
    const qty = decimals(l.quantity, 3, "quantity received");
    wholeIfEach(item, qty);
    const total = decimals(l.total, 2, "total paid", { allowZero: true });
    clean.push({ id: item.id, qty, total, cost: unitCostOf(total, qty) });
  }
  clean.sort((a, b) => (a.id < b.id ? -1 : 1)); // every request locks stock rows in the same order, so two at once can't deadlock

  try {
    const deliveryId = await pool.tx(async (conn) => {
      const id = uuid();
      await conn.query(
        "INSERT INTO Delivery (DeliveryID, BusinessID, LocationID, SupplierID, InvoiceNumber, DeliveredOn, ReceivedByEmployeeID) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, businessId, locationId, supplier.id, invoice, b.deliveredOn, employeeId]);
      // Lock stock before its queue entry, matching the inventory trigger's lock order.
      for (const l of clean) await ensureRow(conn, businessId, locationId, l.id);
      if (!blank(b.purchaseOrderId)) {
        const [[pending]] = await conn.query(
          `SELECT p.PurchaseOrderID AS id, p.SupplierID AS supplierId, i.StockItemID AS stockItemId FROM PurchaseOrder p
             JOIN Inventory i ON i.InventoryID = p.InventoryID
            WHERE p.PurchaseOrderID = ? AND i.LocationID = ? AND i.BusinessID = ? AND p.ReceivedDeliveryID IS NULL FOR UPDATE`,
          [String(b.purchaseOrderId), locationId, businessId]);
        if (!pending) throw new HttpError(409, "This purchase order is no longer available. Refresh the list.");
        if (!pending.supplierId) throw new HttpError(409, "Assign a supplier and place this order before receiving it.");
        if (pending.supplierId !== supplier.id) throw new HttpError(409, "Receive this purchase order from its original supplier.");
        if (!seen.has(pending.stockItemId)) throw new HttpError(400, "Include the pending stock item in this delivery.");
        // Close before posting: a short delivery that is still low creates a new purchase order.
        await conn.query("UPDATE PurchaseOrder SET ReceivedDeliveryID = ? WHERE PurchaseOrderID = ?", [id, pending.id]);
      }
      for (const l of clean) {
        await post(conn, { businessId, locationId, employeeId, stockItemId: l.id, qty: l.qty, cost: l.cost, type: RESTOCK, deliveryId: id });
      }
      return id;
    });
    res.json({ id: deliveryId, lines: clean.length, total: Math.round(clean.reduce((a, l) => a + l.total, 0) * 100) / 100 });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") throw new HttpError(409, "That invoice has already been received from this supplier.");
    throw err;
  }
});

// ---- Deactivate and reactivate ----------------------------------------------------------------------------------

// Nothing is deleted: a deactivated item or supplier leaves the lists and can come back. An item that a recipe or an option
// still uses (even a deactivated one: it may come back) can't be switched off, or those products would lose an ingredient.
router.post("/inventory/item/:id/active", change, async (req, res) => {
  const { businessId } = req.session;
  const active = !!req.body.active;
  const [[item]] = await pool.query("SELECT StockItemID FROM StockItem WHERE StockItemID = ? AND BusinessID = ?", [req.params.id, businessId]);
  if (!item) throw new HttpError(404, "Stock item not found.");
  if (!active) {
    const [[use]] = await pool.query(
      `SELECT (SELECT COUNT(DISTINCT v.ProductID) FROM VariantRecipe vr JOIN ProductVariant v ON v.VariantID = vr.VariantID WHERE vr.StockItemID = ?) AS recipes,
              (SELECT COUNT(DISTINCT m.ModifierID) FROM Modifier m WHERE
                 m.ModifierID IN (SELECT ModifierID FROM ModifierAddition WHERE StockItemID = ?)
                 OR m.ModifierID IN (SELECT ModifierID FROM ModifierSubstitution WHERE FromStockItemID = ? OR ToStockItemID = ?)) AS options`,
      [item.StockItemID, item.StockItemID, item.StockItemID, item.StockItemID]);
    if (use.recipes || use.options)
      throw new HttpError(409, `This item is still used by ${use.recipes} product recipe${use.recipes === 1 ? "" : "s"} and ${use.options} option${use.options === 1 ? "" : "s"}. Take it out of those first.`);
  }
  await pool.query("UPDATE StockItem SET Active = ? WHERE StockItemID = ?", [active, item.StockItemID]);
  res.json({ ok: true });
});

router.post("/inventory/supplier/:id/active", change, async (req, res) => {
  const [r] = await pool.query("UPDATE Supplier SET Active = ? WHERE SupplierID = ? AND BusinessID = ?", [!!req.body.active, req.params.id, req.session.businessId]);
  if (!r.affectedRows) throw new HttpError(404, "Supplier not found.");
  res.json({ ok: true });
});

// ---- Stock count ------------------------------------------------------------------------------------------------

// The difference is worked out here against what is on hand now, so a sale during the count can't be counted twice
router.post("/inventory/count", change, async (req, res) => {
  const { businessId, employeeId } = req.session;
  const locationId = await placeOf(req, req.body.locationId);
  const counts = Array.isArray(req.body.counts) ? req.body.counts : [];
  if (!counts.length) throw new HttpError(400, "Count at least one item.");
  const note = check.note(req.body.note, "note", 255) || null;
  const seen = new Set();
  const clean = [];
  for (const c of counts) {
    const item = await stockItem(pool, businessId, c.stockItemId);
    if (seen.has(item.id)) throw new HttpError(400, "Each item can be counted once.");
    seen.add(item.id);
    const counted = decimals(c.counted, 3, "count", { allowZero: true });
    wholeIfEach(item, counted);
    clean.push({ id: item.id, counted });
  }
  clean.sort((a, b) => (a.id < b.id ? -1 : 1)); // same lock order as a delivery

  const result = await pool.tx(async (conn) => {
    const countId = uuid();
    await conn.query("INSERT INTO StockCount (StockCountID, BusinessID, LocationID, CountedByEmployeeID, CountedAt, ItemsCounted, Note) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)",
      [countId, businessId, locationId, employeeId, clean.length, note]);
    let differ = 0, value = 0;
    for (const c of clean) {
      const [[row]] = await conn.query("SELECT Quantity AS qty, AverageUnitCost AS cost FROM Inventory WHERE LocationID = ? AND StockItemID = ? FOR UPDATE", [locationId, c.id]);
      if (!row) throw new HttpError(404, "Count only items this location stocks.");
      const diff = Math.round((c.counted - Number(row.qty)) * 1000) / 1000;
      if (!diff) continue;
      await post(conn, { businessId, locationId, employeeId, stockItemId: c.id, qty: diff, cost: row.cost, type: COUNT_CORRECTION, countId });
      differ++;
      value += diff * Number(row.cost || 0);
    }
    return { counted: clean.length, differ, value: Math.round(value * 100) / 100 };
  });
  res.json(result);
});

module.exports = router;
