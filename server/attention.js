const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { hasPermission } = require("./pin");
const { myLocations } = require("./locations");
const { waitingRefunds } = require("./refunds");

const PERM_SEE_INVENTORY = 14;
const PERM_SEE_TEAM = 17;
const PERM_SIGN_REFUNDS = 3;
const SHOWN = 8; // rows listed in a panel; its count is the full figure
const LOSS_REASONS = { 5: "Broken or spilled", 6: "Spoiled or expired", 7: "Stolen" };

const router = express.Router();

// What needs a manager today. Each panel is there only for a role that can act on it; a role with none of them gets a 403.
router.get("/attention", async (req, res) => {
  const { businessId, locationId, employeeId } = req.session;
  const [inventory, team, signer] = await Promise.all([PERM_SEE_INVENTORY, PERM_SEE_TEAM, PERM_SIGN_REFUNDS].map((p) => hasPermission(pool, employeeId, p)));
  if (!inventory && !team && !signer) throw new HttpError(403, "Your role can't do this.");
  const [[place]] = await pool.query("SELECT Name AS name, TimeZone AS timeZone FROM Location WHERE LocationID = ?", [locationId]);
  const out = { location: place.name, timeZone: place.timeZone, losses: null, pendingDeliveries: null, timecards: null, refunds: null };

  if (inventory) {
    // "today" is the café's local day, so the cut-off is local midnight converted back to UTC
    const [losses] = await pool.query(
      `SELECT t.TransactionDateTime AS at, s.Name AS item, -t.QuantityChange AS amount, u.Symbol AS unit, t.TransactionTypeCode AS type, e.FirstName AS byName
         FROM InventoryTransaction t JOIN StockItem s ON s.StockItemID = t.StockItemID JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
         LEFT JOIN Employee e ON e.EmployeeID = t.EmployeeID
        WHERE t.LocationID = ? AND t.TransactionTypeCode IN (5, 6, 7)
          AND t.TransactionDateTime >= CONVERT_TZ(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?)), ?, '+00:00')
        ORDER BY t.TransactionDateTime DESC`,
      [locationId, place.timeZone, place.timeZone]
    );
    out.losses = { count: losses.length, rows: losses.slice(0, SHOWN).map((l) => ({ at: l.at, item: l.item, amount: Number(l.amount), unit: l.unit, reason: LOSS_REASONS[l.type], by: l.byName })) };

    const [pending] = await pool.query(
      `SELECT p.PurchaseOrderID AS id,
              CONCAT('PO-', LPAD(p.OrderNumber, GREATEST(6, LENGTH(p.OrderNumber)), '0')) AS orderNumber,
              s.Name AS item, u.Symbol AS unit, p.Quantity AS quantity, sp.Name AS supplier, p.Status AS status
         FROM PurchaseOrder p JOIN Inventory i ON i.InventoryID = p.InventoryID
         JOIN StockItem s ON s.StockItemID = i.StockItemID JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
         LEFT JOIN Supplier sp ON sp.SupplierID = p.SupplierID
        WHERE i.LocationID = ? AND i.BusinessID = ? AND p.ReceivedDeliveryID IS NULL
        ORDER BY p.CreatedAt, p.OrderNumber`,
      [locationId, businessId]
    );
    out.pendingDeliveries = { count: pending.length, rows: pending.slice(0, SHOWN).map((p) => ({ ...p, quantity: Number(p.quantity) })) };
  }

  if (team) {
    const mine = await myLocations(employeeId);
    const [cards] = mine.length ? await pool.query(
      `SELECT CONCAT(e.FirstName, ' ', e.LastName) AS employee, DATE_FORMAT(CONVERT_TZ(te.ClockInAt, '+00:00', l.TimeZone), '%Y-%m-%d') AS date,
              ROUND(GREATEST(0, TIMESTAMPDIFF(MINUTE, te.ClockInAt, te.ClockOutAt) - te.UnpaidBreakMinutes) / 60, 2) AS hours, te.PayPeriodID AS periodId
         FROM TimeEntry te JOIN Employee e ON e.EmployeeID = te.EmployeeID JOIN Location l ON l.LocationID = te.LocationID
        WHERE te.BusinessID = ? AND te.LocationID IN (?) AND te.TimeEntryStatusCode = 2 ORDER BY te.ClockInAt, employee`,
      [businessId, mine]
    ) : [[]];
    // the period of the oldest waiting card: that is the one Review timecards opens
    out.timecards = { count: cards.length, periodId: cards[0]?.periodId || null, rows: cards.slice(0, SHOWN).map((c) => ({ employee: c.employee, date: c.date, hours: Number(c.hours) })) };
  }

  if (signer) {
    const refunds = await waitingRefunds(req.session);
    out.refunds = { count: refunds.length, rows: refunds.slice(0, SHOWN).map((r) => ({ orderNumber: r.orderNumber, amount: r.amount, askedBy: r.askedBy, why: r.why })) };
  }
  res.json(out);
});

module.exports = router;
module.exports.LOSS_REASONS = LOSS_REASONS;
