const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { hasPermission } = require("./pin");
const { requirePermission } = require("./session");

const PERM_SEE_KITCHEN = 5;
const PERM_WORK_TICKETS = 6;
const PERM_PICKED_UP = 7;
const PERM_REPORT_LOSS = 8;
const CONFIRMED = 2, PREPARING = 3, READY = 4, COMPLETED = 5;
const LOSS_TYPES = { broken: 5, spoiled: 6 }; // DAMAGED, EXPIRED

const router = express.Router();

// shortcut: open screens are tracked in this process only, so a second server process would miss them; share a channel (Redis) before running two
const watchers = new Map(); // locationId -> open responses
const notify = (locationId) => { for (const res of watchers.get(locationId) || []) res.write("data: changed\n\n"); };

// One-way push: the screen only needs to know "something changed", then it reloads its tickets
router.get("/kitchen/stream", requirePermission(PERM_SEE_KITCHEN), (req, res) => {
  const { locationId, expires } = req.session;
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write(": open\n\n");
  if (!watchers.has(locationId)) watchers.set(locationId, new Set());
  watchers.get(locationId).add(res);
  const beat = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  const stop = setTimeout(() => res.end(), Math.max(0, expires - Date.now())); // end with the sign-in, so the page re-checks it
  res.on("close", () => { clearInterval(beat); clearTimeout(stop); watchers.get(locationId).delete(res); });
});

// Open tickets for the signed-in location, oldest first, with the time and person of their latest status
router.get("/kitchen/tickets", requirePermission(PERM_SEE_KITCHEN), async (req, res) => {
  const { businessId, locationId, employeeId } = req.session;
  const [orders] = await pool.query(
    `SELECT o.OrderID, o.OrderNumber, o.ChannelCode, o.OrderStatusCode, o.OrderDateTime, o.PickupAt, o.CustomerNote,
            CONCAT_WS(' ', c.FirstName, c.LastName) AS CustomerName,
            h.ChangedAt AS StatusAt, e.FirstName AS StatusBy
       FROM Orders o
       LEFT JOIN Customer c ON c.CustomerID = o.CustomerID
       LEFT JOIN OrderStatusHistory h ON h.OrderStatusHistoryID =
            (SELECT x.OrderStatusHistoryID FROM OrderStatusHistory x
              WHERE x.OrderID = o.OrderID AND x.OrderStatusCode = o.OrderStatusCode ORDER BY x.ChangedAt DESC LIMIT 1)
       LEFT JOIN Employee e ON e.EmployeeID = h.ChangedByEmployeeID
      WHERE o.BusinessID = ? AND o.LocationID = ? AND o.OrderStatusCode IN (?, ?, ?)
      ORDER BY o.OrderDateTime, o.OrderNumber`,
    [businessId, locationId, CONFIRMED, PREPARING, READY]
  );
  const ids = orders.map((o) => o.OrderID);
  const [items] = ids.length
    ? await pool.query(
        `SELECT oi.OrderItemID, oi.OrderID, oi.Quantity, p.Name AS Product, v.Name AS Size,
                (SELECT COUNT(*) FROM ProductVariant x WHERE x.ProductID = p.ProductID AND x.Active) > 1 AS Sized
           FROM OrderItem oi JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID
          WHERE oi.OrderID IN (?) ORDER BY oi.OrderItemID`,
        [ids]
      )
    : [[]];
  const [mods] = items.length
    ? await pool.query(
        `SELECT oim.OrderItemID, m.Name FROM OrderItemModifier oim JOIN Modifier m ON m.ModifierID = oim.ModifierID
          WHERE oim.OrderItemID IN (?) ORDER BY m.Name`,
        [items.map((i) => i.OrderItemID)]
      )
    : [[]];
  const [[loc]] = await pool.query("SELECT TimeZone FROM Location WHERE LocationID = ?", [locationId]);

  const stage = (code) => orders.filter((o) => o.OrderStatusCode === code).map((o) => ({
    id: o.OrderID,
    number: o.OrderNumber,
    online: o.ChannelCode === 2,
    pickupAt: o.PickupAt,
    placedAt: o.OrderDateTime,
    statusAt: o.StatusAt,
    statusBy: o.StatusBy,
    customer: o.CustomerName || "Guest",
    note: o.CustomerNote,
    items: items.filter((i) => i.OrderID === o.OrderID).map((i) => ({
      quantity: Number(i.Quantity),
      name: i.Product,
      size: i.Sized ? i.Size : null,
      options: mods.filter((m) => m.OrderItemID === i.OrderItemID).map((m) => m.Name),
    })),
  }));

  res.json({
    now: new Date(),
    timeZone: loc.TimeZone,
    canPickUp: await hasPermission(pool, employeeId, PERM_PICKED_UP),
    queues: { new: stage(CONFIRMED), preparing: stage(PREPARING), ready: stage(READY) },
  });
});

// Moves one ticket a step. The WHERE on the old status means two screens can't both move it.
async function advance(req, res, from, to) {
  const { businessId, locationId, employeeId } = req.session;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `UPDATE Orders SET OrderStatusCode = ?, CompletedAt = IF(? = ${COMPLETED}, UTC_TIMESTAMP(), CompletedAt)
        WHERE OrderID = ? AND BusinessID = ? AND LocationID = ? AND OrderStatusCode = ?`,
      [to, to, req.params.id, businessId, locationId, from]
    );
    if (!r.affectedRows) throw new HttpError(409, "That ticket has already moved on.");
    await conn.query(
      `INSERT INTO OrderStatusHistory (OrderStatusHistoryID, OrderID, BusinessID, OrderStatusCode, ChangedByEmployeeID)
       VALUES (UUID(), ?, ?, ?, ?)`,
      [req.params.id, businessId, to, employeeId]
    );
    await conn.commit();
    notify(locationId);
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

router.post("/kitchen/orders/:id/start", requirePermission(PERM_WORK_TICKETS), (req, res) => advance(req, res, CONFIRMED, PREPARING));
router.post("/kitchen/orders/:id/ready", requirePermission(PERM_WORK_TICKETS), (req, res) => advance(req, res, PREPARING, READY));
router.post("/kitchen/orders/:id/pickup", requirePermission(PERM_PICKED_UP), (req, res) => advance(req, res, READY, COMPLETED));

// Stock losses: written to the stock ledger, so the DB itself refuses more than is on hand
router.get("/kitchen/losses", requirePermission(PERM_REPORT_LOSS), async (req, res) => {
  const { businessId, locationId } = req.session;
  const [[loc]] = await pool.query("SELECT Name, TimeZone FROM Location WHERE LocationID = ?", [locationId]);
  const [stock] = await pool.query(
    `SELECT s.StockItemID AS id, s.Name AS name, u.Symbol AS unit, u.AllowsFraction AS fraction
       FROM Inventory i JOIN StockItem s ON s.StockItemID = i.StockItemID AND s.Active
       JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
      WHERE i.LocationID = ? AND i.BusinessID = ? ORDER BY s.Name`,
    [locationId, businessId]
  );
  // "today" is the café's local day, so the cut-off is local midnight converted back to UTC
  const [rows] = await pool.query(
    `SELECT t.TransactionDateTime AS at, s.Name AS item, -t.QuantityChange AS amount, u.Symbol AS unit,
            t.TransactionTypeCode AS type, e.FirstName AS byName
       FROM InventoryTransaction t
       JOIN StockItem s ON s.StockItemID = t.StockItemID
       JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
       LEFT JOIN Employee e ON e.EmployeeID = t.EmployeeID
      WHERE t.LocationID = ? AND t.TransactionTypeCode IN (5, 6)
        AND t.TransactionDateTime >= CONVERT_TZ(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?)), ?, '+00:00')
      ORDER BY t.TransactionDateTime DESC`,
    [locationId, loc.TimeZone, loc.TimeZone]
  );
  res.json({
    location: loc.Name,
    timeZone: loc.TimeZone,
    stock: stock.map((s) => ({ ...s, fraction: !!s.fraction })),
    losses: rows.map((r) => ({ at: r.at, item: r.item, amount: Number(r.amount), unit: r.unit, reason: r.type === 5 ? "Broken or spilled" : "Spoiled or expired", by: r.byName })),
  });
});

router.post("/kitchen/losses", requirePermission(PERM_REPORT_LOSS), async (req, res) => {
  const { businessId, locationId, employeeId } = req.session;
  const { stockItemId, reason, note } = req.body;
  const amount = Number(req.body.amount);
  const type = LOSS_TYPES[reason];
  if (!type) throw new HttpError(400, "Choose a reason.");
  if (!(amount > 0) || amount > 100000 || Math.round(amount * 1000) / 1000 !== amount) throw new HttpError(400, "Enter how much was lost.");
  const text = typeof note === "string" ? note.trim() : "";
  if (text.length > 255) throw new HttpError(400, "The note is too long.");

  const [[item]] = await pool.query(
    `SELECT u.AllowsFraction AS fraction, i.AverageUnitCost AS cost FROM Inventory i JOIN StockItem s ON s.StockItemID = i.StockItemID AND s.Active
       JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
      WHERE i.LocationID = ? AND i.StockItemID = ? AND i.BusinessID = ?`,
    [locationId, String(stockItemId), businessId]
  );
  if (!item) throw new HttpError(404, "Choose a stock item from the list.");
  if (!item.fraction && !Number.isInteger(amount)) throw new HttpError(400, "This item is counted in whole units.");

  // Plain VALUES: the ledger trigger updates Inventory, which an INSERT ... SELECT from it can't also read
  await pool.query(
    `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                       QuantityChange, UnitCost, TransactionTypeCode, Note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), businessId, String(stockItemId), locationId, employeeId, (-amount).toFixed(3), item.cost, type, text || null]
  );
  res.json({ ok: true });
});

module.exports = router;
module.exports.notify = notify;
