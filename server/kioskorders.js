// Kiosk orders paid in cash wait as PENDING_PAYMENT and hold their stock. The register takes the payment, or cancels the
// order; one that nobody pays within HOLD_MINUTES is cancelled by expireStale(), so unpaid orders can't tie up stock.
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { notify } = require("./watchers");

const HOLD_MINUTES = 15;
const PENDING = 1, CONFIRMED = 2, CANCELLED = 6, KIOSK = 3, CASH = 1;

const history = (conn, o, status, employeeId) => conn.query(
  "INSERT INTO OrderStatusHistory (OrderStatusHistoryID, OrderID, BusinessID, OrderStatusCode, ChangedAt, ChangedByEmployeeID) VALUES (UUID(), ?, ?, ?, UTC_TIMESTAMP(), ?)",
  [o.OrderID, o.BusinessID, status, employeeId]);

// The order, locked, only while it is still waiting for payment (null if paid, cancelled or at another café)
const waiting = async (conn, orderId, locationId) => (await conn.query(
  `SELECT OrderID, BusinessID, LocationID, Total FROM Orders
    WHERE OrderID = ? AND ChannelCode = ? AND OrderStatusCode = ? ${locationId ? "AND LocationID = ?" : ""} FOR UPDATE`,
  [orderId, KIOSK, PENDING, ...(locationId ? [locationId] : [])]))[0][0];

// Puts the stock back by reversing the order's SALE movements (type 3, RETURN), then cancels it
async function cancel(conn, orderId, { employeeId = null, locationId = null } = {}) {
  const o = await waiting(conn, orderId, locationId);
  if (!o) return false;
  await conn.query(
    `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                       QuantityChange, UnitCost, TransactionTypeCode, OrderID, Note)
     SELECT UUID(), BusinessID, StockItemID, LocationID, ?, -QuantityChange, UnitCost, 3, OrderID, 'unpaid kiosk order cancelled'
       FROM InventoryTransaction WHERE OrderID = ? AND TransactionTypeCode = 2 ORDER BY StockItemID`,
    [employeeId, orderId]);
  await conn.query("UPDATE Orders SET OrderStatusCode = ? WHERE OrderID = ?", [CANCELLED, orderId]);
  await history(conn, o, CANCELLED, employeeId);
  return true;
}

// Records the cash the cashier took and sends the order to the kitchen
async function takeCash(conn, orderId, employeeId, locationId) {
  const o = await waiting(conn, orderId, locationId);
  if (!o) return false;
  if (Number(o.Total) > 0)
    await conn.query("INSERT INTO Payment (PaymentID, OrderID, PaymentMethodCode, Amount, PaymentStatusCode) VALUES (UUID(), ?, ?, ?, 3)", [orderId, CASH, o.Total]);
  await conn.query("UPDATE Orders SET OrderStatusCode = ? WHERE OrderID = ?", [CONFIRMED, orderId]);
  await history(conn, o, CONFIRMED, employeeId);
  return true;
}

const gone = () => new HttpError(409, "That order was already paid or cancelled.");

async function pendingAt(locationId) {
  const [rows] = await pool.query(
    `SELECT o.OrderID AS id, o.OrderNumber AS orderNumber, o.Total AS total, o.CustomerNote AS note, c.FirstName AS member,
            TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), o.OrderDateTime + INTERVAL ? MINUTE) AS secondsLeft
       FROM Orders o LEFT JOIN Customer c ON c.CustomerID = o.CustomerID
      WHERE o.LocationID = ? AND o.ChannelCode = ? AND o.OrderStatusCode = ? ORDER BY o.OrderDateTime`,
    [HOLD_MINUTES, locationId, KIOSK, PENDING]);
  return rows.map((r) => ({ id: r.id, orderNumber: r.orderNumber, totalCents: Math.round(Number(r.total) * 100), secondsLeft: Math.max(0, r.secondsLeft),
    // a member's name is on file; a guest's is the first part of the note (only the guest name can start it, it is checked at the kiosk)
    name: r.member || (r.note?.startsWith("Name: ") ? /^Name: ([^|]*)/.exec(r.note)[1].trim() : null) }));
}

async function pay(session, orderId) {
  if (!(await pool.tx((conn) => takeCash(conn, orderId, session.employeeId, session.locationId)))) throw gone();
  notify(session.locationId);
}

async function cancelAt(session, orderId) {
  if (!(await pool.tx((conn) => cancel(conn, orderId, { employeeId: session.employeeId, locationId: session.locationId })))) throw gone();
}

// Cancels what has waited too long. Several processes may run it: each order is locked and re-checked, so it is done once.
async function expireStale(minutes = HOLD_MINUTES) {
  const [rows] = await pool.query(
    "SELECT OrderID FROM Orders WHERE ChannelCode = ? AND OrderStatusCode = ? AND OrderDateTime < UTC_TIMESTAMP() - INTERVAL ? MINUTE LIMIT 50",
    [KIOSK, PENDING, minutes]);
  let n = 0;
  for (const r of rows) if (await pool.tx((conn) => cancel(conn, r.OrderID))) n++;
  return n;
}

const startExpiry = () => setInterval(() => expireStale().catch((err) => console.error("expiring unpaid kiosk orders failed:", err.message)), 60 * 1000).unref();

module.exports = { HOLD_MINUTES, pendingAt, pay, cancelAt, expireStale, startExpiry };
