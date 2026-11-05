const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const check = require("./validate");
const { cents, dollars } = require("./pricing");
const { verifyOverride } = require("./override");
const { requirePermission } = require("./session");
const { myLocations } = require("./locations");
const { hasPermission } = require("./pin");
const approvals = require("./approvals");
const { approve } = approvals;
const { label } = require("./labels");

const PERM_SIGN_REFUND_OVERRIDES = 3;
const PERM_APPROVE_DISCOUNTS = 4;
const PERM_REFUND = 2;

const router = express.Router();
router.use("/refunds", requirePermission(PERM_REFUND));

router.get("/refunds/order", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) throw new HttpError(400, "Enter an order number, or a member email or phone.");
  const { businessId, employeeId } = req.session;
  const mine = await myLocations(employeeId); // an order at another café isn't found, so it can't be refunded from here
  if (!mine.length) throw new HttpError(404, "No order found.");

  const base = `SELECT o.OrderID, o.OrderNumber, o.OrderDateTime, o.OrderStatusCode, c.FirstName, c.LastName
                  FROM Orders o LEFT JOIN Customer c ON c.CustomerID = o.CustomerID WHERE o.BusinessID = ? AND o.LocationID IN (?)`;
  const [[order]] = /^\d{1,8}$/.test(q)
    ? await pool.query(`${base} AND o.OrderNumber = ?`, [businessId, mine, q])
    : await pool.query(
        `${base} AND o.OrderStatusCode IN (5, 7)
            AND (c.Email = ? OR c.PhoneDigits = ?)
          ORDER BY o.OrderDateTime DESC LIMIT 1`,
        [businessId, mine, q, q.replace(/\D/g, "").slice(-10) || "#"]
      );
  if (!order) throw new HttpError(404, "No order found.");
  if (![5, 7].includes(order.OrderStatusCode))
    throw new HttpError(409, `Order ${order.OrderNumber} isn't completed, so it can't be refunded.`);

  const [lines] = await pool.query(
    `SELECT oi.OrderItemID, p.Name AS Product, v.Name AS Variant, oi.Quantity, oi.NetAmount, oi.TaxAmount,
            v.RestockOnReturn,
            (SELECT COUNT(*) FROM ProductVariant x WHERE x.ProductID = p.ProductID AND x.Active) AS Sizes,
            COALESCE((SELECT SUM(ri.QuantityReturned) FROM ReturnItem ri WHERE ri.OrderItemID = oi.OrderItemID), 0) AS Returned
       FROM OrderItem oi
       JOIN ProductVariant v ON v.VariantID = oi.VariantID
       JOIN Product p ON p.ProductID = v.ProductID
      WHERE oi.OrderID = ? ORDER BY p.Name, v.Name`,
    [order.OrderID]
  );
  const [payments] = await pool.query(
    `SELECT p.Amount, p.TipAmount, pm.Description FROM Payment p JOIN PaymentMethod pm USING (PaymentMethodCode)
      WHERE p.OrderID = ? AND p.PaymentStatusCode IN (3, 5) ORDER BY p.PaymentDateTime`,
    [order.OrderID]
  );

  res.json({
    orderId: order.OrderID,
    orderNumber: order.OrderNumber,
    placedAt: order.OrderDateTime,
    member: order.FirstName ? [order.FirstName, order.LastName].filter(Boolean).join(" ") : null,
    paidCents: payments.reduce((a, p) => a + cents(p.Amount), 0),
    tipCents: payments.reduce((a, p) => a + cents(p.TipAmount), 0), // never part of a refund
    method: payments.map((p) => label(p.Description)).join(" + "),
    lines: lines.map((l) => ({
      orderItemId: l.OrderItemID,
      name: l.Sizes > 1 ? `${l.Product}, ${l.Variant}` : l.Product,
      bought: Number(l.Quantity),
      returned: Number(l.Returned),
      netCents: cents(l.NetAmount),
      taxCents: cents(l.TaxAmount),
      restockable: !!l.RestockOnReturn,
    })),
  });
});

// ---- recording a refund ---------------------------------------------------------------------------------------------

// Put the stock back for a returned line that goes back on the shelf
const postRestock = (conn, locationId, employeeId, orderItemId, qty) =>
  conn.query(
    `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                       QuantityChange, UnitCost, TransactionTypeCode, OrderID)
     SELECT UUID(), c.BusinessID, c.StockItemID, ?, ?, ROUND(c.QuantityUsed * ? / oi.Quantity, 3), c.UnitCost, 3, oi.OrderID
       FROM OrderItemComponent c JOIN OrderItem oi ON oi.OrderItemID = c.OrderItemID
      WHERE c.OrderItemID = ? AND ROUND(c.QuantityUsed * ? / oi.Quantity, 3) > 0`,
    [locationId, employeeId, qty, orderItemId, qty]
  );

// Once money has gone back: a payment refunded in full is marked so, and an order with every item returned becomes REFUNDED
async function afterRefund(conn, { order, paymentId, remainingBefore, totalCents, employeeId, businessId }) {
  if (remainingBefore === totalCents) await conn.query("UPDATE Payment SET PaymentStatusCode = 5 WHERE PaymentID = ?", [paymentId]);
  const [[open]] = await conn.query(
    `SELECT COUNT(*) AS n FROM OrderItem oi
      WHERE oi.OrderID = ? AND oi.Quantity > COALESCE((SELECT SUM(ri.QuantityReturned) FROM ReturnItem ri WHERE ri.OrderItemID = oi.OrderItemID), 0)`,
    [order.OrderID]
  );
  if (!open.n && order.OrderStatusCode === 5) {
    await conn.query("UPDATE Orders SET OrderStatusCode = 7 WHERE OrderID = ?", [order.OrderID]);
    await conn.query(
      `INSERT INTO OrderStatusHistory (OrderStatusHistoryID, OrderID, BusinessID, OrderStatusCode, ChangedByEmployeeID)
       VALUES (UUID(), ?, ?, 7, ?)`,
      [order.OrderID, businessId, employeeId]
    );
  }
  return !open.n;
}

// A refund over the business's limit, or on an order older than its limit in days, is a rule-breaker: whoever signs it must hold
// the override permission, not just any approving one. (This used to be a database trigger.) A limit left empty is switched off.
const OVERRIDE_REFUSED = "This refund breaks a refund rule; a manager must sign the override.";
async function requireOverrideIfNeeded(conn, { businessId, orderId, totalCents, signerId }) {
  const [[r]] = await conn.query(
    `SELECT b.RefundOverrideAmount AS maxAmount,
            COALESCE(o.CompletedAt, o.OrderDateTime) < UTC_TIMESTAMP() - INTERVAL b.RefundOverrideDays DAY AS tooOld
       FROM Business b JOIN Orders o ON o.OrderID = ? WHERE b.BusinessID = ?`,
    [orderId, businessId]
  );
  const breaks = (r.maxAmount != null && totalCents > cents(r.maxAmount)) || !!r.tooOld;
  if (breaks && !(await hasPermission(conn, signerId, PERM_SIGN_REFUND_OVERRIDES))) throw new HttpError(409, OVERRIDE_REFUSED);
}

function readRefundBody(body) {
  const reason = check.note(body.reason, "reason", 255, { required: true });
  const wanted = body.lines;
  if (!Array.isArray(wanted) || !wanted.length) throw new HttpError(400, "Tick at least one item to return.");
  for (const l of wanted)
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new HttpError(400, "Quantity to return must be a whole number above zero.");
  return { reason, wanted };
}

// A refund is either done now (a manager signed it) or only asked for: saved as PENDING with its return recorded, so the
// items count as returned, while stock, payment and order are left alone until a manager approves it.
async function recordRefund(conn, { session, orderId, wanted, reason, managerId = null, pending = false }) {
  const { employeeId, businessId } = session;
  // Order first, then payments: the same lock order every refund uses, so two at once can't deadlock
  const [[order]] = await conn.query(
    "SELECT OrderID, LocationID, OrderStatusCode FROM Orders WHERE OrderID = ? AND BusinessID = ? FOR UPDATE",
    [String(orderId), businessId]
  );
  if (!order) throw new HttpError(404, "No order found.");
  if (![5, 7].includes(order.OrderStatusCode)) throw new HttpError(409, "Only completed orders can be refunded.");
  if (!(await myLocations(employeeId)).includes(order.LocationID)) throw new HttpError(403, "You don't work at that order's location.");
  const [items] = await conn.query(
    `SELECT oi.OrderItemID, oi.Quantity, v.RestockOnReturn,
            COALESCE((SELECT SUM(ri.QuantityReturned) FROM ReturnItem ri WHERE ri.OrderItemID = oi.OrderItemID), 0) AS Returned
       FROM OrderItem oi JOIN ProductVariant v ON v.VariantID = oi.VariantID WHERE oi.OrderID = ?`,
    [order.OrderID]
  );
  const returnId = crypto.randomUUID();
  await conn.query(
    "INSERT INTO Returns (ReturnID, OrderID, BusinessID, CreatedBy) VALUES (?, ?, ?, ?)",
    [returnId, order.OrderID, businessId, employeeId]
  );

  let netCents = 0;
  let taxCents = 0;
  for (const l of wanted) {
    const item = items.find((i) => i.OrderItemID === l.orderItemId);
    if (!item) throw new HttpError(400, "An item isn't part of this order.");
    if (l.qty > Number(item.Quantity) - Number(item.Returned)) throw new HttpError(409, "More items than are left to return. A refund for some of them may be waiting for a manager.");
    item.Returned = Number(item.Returned) + l.qty; // a request that lists the same item twice counts both
    const restock = l.restock ? l.qty : 0;
    if (restock && !item.RestockOnReturn) throw new HttpError(400, "That item can't go back to stock.");

    await conn.query(
      `INSERT INTO ReturnItem (ReturnItemID, ReturnID, OrderID, OrderItemID, QuantityReturned, QuantityRestocked)
       VALUES (UUID(), ?, ?, ?, ?, ?)`,
      [returnId, order.OrderID, item.OrderItemID, l.qty, restock]
    );
    // The same proration the approval's caps use
    const [[share]] = await conn.query(
      "SELECT ROUND(NetAmount * ? / Quantity, 2) AS net, ROUND(TaxAmount * ? / Quantity, 2) AS tax FROM OrderItem WHERE OrderItemID = ?",
      [l.qty, l.qty, item.OrderItemID]
    );
    netCents += cents(share.net);
    taxCents += cents(share.tax);
  }
  // Per-unit proration rounds up each time, so two single-unit refunds can add a cent over what was collected
  const [[done]] = await conn.query(
    `SELECT COALESCE(SUM(Amount - TaxAmount), 0) AS net, COALESCE(SUM(TaxAmount), 0) AS tax
       FROM Refund WHERE OrderID = ? AND RefundStatusCode <> 3`,
    [order.OrderID]
  );
  const [[collected]] = await conn.query("SELECT Total - Tax AS net, Tax AS tax FROM Orders WHERE OrderID = ?", [order.OrderID]);
  netCents = Math.min(netCents, cents(collected.net) - cents(done.net));
  taxCents = Math.min(taxCents, cents(collected.tax) - cents(done.tax));
  const totalCents = netCents + taxCents;
  if (totalCents <= 0) throw new HttpError(400, "These items carry no refundable amount.");

  const [payments] = await conn.query(
    `SELECT p.PaymentID, pm.Description,
            p.Amount - COALESCE((SELECT SUM(r.Amount) FROM Refund r WHERE r.PaymentID = p.PaymentID AND r.RefundStatusCode <> 3), 0) AS Remaining
       FROM Payment p JOIN PaymentMethod pm USING (PaymentMethodCode)
      WHERE p.OrderID = ? AND p.PaymentStatusCode IN (3, 5) ORDER BY p.PaymentDateTime FOR UPDATE`,
    [order.OrderID]
  );
  const payment = payments.find((p) => cents(p.Remaining) >= totalCents);
  if (!payment) throw new HttpError(409, "No payment on this order has enough left to refund.");

  const refundId = crypto.randomUUID();
  await conn.query(
    `INSERT INTO Refund (RefundID, PaymentID, ReturnID, OrderID, BusinessID, Amount, TaxAmount, Reason, RefundStatusCode, CreatedBy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [refundId, payment.PaymentID, returnId, order.OrderID, businessId, dollars(totalCents), dollars(taxCents), reason, employeeId]
  );
  if (!pending) await approve(conn, session, "REFUND_APPROVE", refundId, {}, managerId);
  const [[updated]] = await conn.query("SELECT OrderStatusCode FROM Orders WHERE OrderID = ?", [order.OrderID]);
  return { itemsCents: netCents, taxCents, totalCents, method: label(payment.Description), orderRefunded: !pending && updated.OrderStatusCode === 7 };
}

router.post("/refunds", async (req, res) => {
  const { orderId, managerNumber, managerPin } = req.body;
  const { reason, wanted } = readRefundBody(req.body);
  const managerId = await verifyOverride(
    req.session, String(managerNumber), String(managerPin), [PERM_SIGN_REFUND_OVERRIDES, PERM_APPROVE_DISCOUNTS]
  );
  res.json(await pool.tx((conn) => recordRefund(conn, { session: req.session, orderId, wanted, reason, managerId })));
});

// ---- asking a manager, and the manager's answer ----------------------------------------------------------------------

// A cashier with no manager at hand asks instead: the refund waits, and shows on the manager's Needs attention page
router.post("/refunds/request", async (req, res) => {
  const { reason, wanted } = readRefundBody(req.body);
  const out = await pool.tx((conn) => recordRefund(conn, { session: req.session, orderId: req.body.orderId, wanted, reason, pending: true }));
  res.json({ totalCents: out.totalCents, method: out.method });
});

// What a manager reviews: each waiting refund with the rule it breaks and the items coming back
async function waitingRefunds(session) {
  const mine = await myLocations(session.employeeId);
  if (!mine.length) return [];
  const [rows] = await pool.query(
    `SELECT r.RefundID AS id, r.ReturnID AS returnId, r.Amount AS amount, r.Reason AS reason, r.CreatedAt AS askedAt, o.OrderNumber AS orderNumber,
            e.FirstName AS askedBy,
            CASE WHEN r.Amount > b.RefundOverrideAmount THEN CONCAT('Over the $', FORMAT(b.RefundOverrideAmount, 2), ' limit')
                 WHEN COALESCE(o.CompletedAt, o.OrderDateTime) < UTC_TIMESTAMP() - INTERVAL b.RefundOverrideDays DAY THEN CONCAT('Order older than ', b.RefundOverrideDays, ' days')
                 ELSE 'Needs a manager''s approval' END AS why
       FROM Refund r JOIN Orders o ON o.OrderID = r.OrderID JOIN Business b ON b.BusinessID = r.BusinessID JOIN Employee e ON e.EmployeeID = r.CreatedBy
      WHERE r.BusinessID = ? AND r.RefundStatusCode = 1 AND o.LocationID IN (?) ORDER BY r.CreatedAt`,
    [session.businessId, mine]
  );
  if (!rows.length) return [];
  const [lines] = await pool.query(
    `SELECT ri.ReturnID AS returnId, p.Name AS product, v.Name AS variant, ri.QuantityReturned AS qty, ri.QuantityRestocked AS restocked,
            (SELECT COUNT(*) FROM ProductVariant x WHERE x.ProductID = p.ProductID AND x.Active) > 1 AS sized
       FROM ReturnItem ri JOIN OrderItem oi ON oi.OrderItemID = ri.OrderItemID JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID
      WHERE ri.ReturnID IN (?)`,
    [rows.map((r) => r.returnId)]
  );
  return rows.map(({ returnId, ...r }) => ({
    ...r, amount: Number(r.amount),
    lines: lines.filter((l) => l.returnId === returnId).map((l) => ({ name: l.sized ? `${l.product}, ${l.variant}` : l.product, qty: Number(l.qty), restocked: Number(l.restocked) })),
  }));
}

const needSigner = async (req, res, next) => {
  if (!(await hasPermission(pool, req.session.employeeId, PERM_SIGN_REFUND_OVERRIDES))) return res.status(403).json({ error: "Your role can't do this." });
  next();
};

router.get("/refunds/waiting", needSigner, async (req, res) => res.json({ refunds: await waitingRefunds(req.session) }));

// Lock the waiting refund (and its order) before anything else changes
async function lockWaiting(conn, a) {
  const [[ref]] = await conn.query(
    `SELECT r.RefundID, r.OrderID, r.PaymentID, r.ReturnID, r.Amount, r.CreatedBy, o.LocationID, o.OrderStatusCode
       FROM Refund r JOIN Orders o ON o.OrderID = r.OrderID WHERE r.RefundID = ? AND r.BusinessID = ? AND r.RefundStatusCode = 1 FOR UPDATE`,
    [a.targetId, a.businessId]
  );
  if (!ref) throw new HttpError(409, "That refund isn't waiting any more.");
  if (!(await myLocations(a.actorId)).includes(ref.LocationID)) throw new HttpError(403, "You don't work at that order's location.");
  return ref;
}

// The handlers for a manager's decision on a waiting refund (ApprovalAction REFUND_APPROVE and REFUND_REJECT; see approvals.js)
approvals.handlers.REFUND_APPROVE = async (conn, a) => {
  const ref = await lockWaiting(conn, a);
  const { actorId: employeeId, approverId: managerId, businessId } = a;
  if (!(await hasPermission(conn, managerId, PERM_SIGN_REFUND_OVERRIDES)) && !(await hasPermission(conn, managerId, PERM_APPROVE_DISCOUNTS)))
    throw new HttpError(403, "The approver can't approve refunds.");
  const [[payment]] = await conn.query(
    `SELECT p.Amount - COALESCE((SELECT SUM(r.Amount) FROM Refund r WHERE r.PaymentID = p.PaymentID AND r.RefundStatusCode <> 3 AND r.RefundID <> ?), 0) AS Remaining, pm.Description
       FROM Payment p JOIN PaymentMethod pm USING (PaymentMethodCode) WHERE p.PaymentID = ? FOR UPDATE`,
    [ref.RefundID, ref.PaymentID]
  );
  await requireOverrideIfNeeded(conn, { businessId, orderId: ref.OrderID, totalCents: cents(ref.Amount), signerId: managerId });
  const [back] = await conn.query("SELECT OrderItemID, QuantityRestocked FROM ReturnItem WHERE ReturnID = ? AND QuantityRestocked > 0", [ref.ReturnID]);
  for (const b of back) await postRestock(conn, ref.LocationID, employeeId, b.OrderItemID, Number(b.QuantityRestocked));
  await conn.query("UPDATE Returns SET ApprovedByEmployeeID = ?, UpdatedBy = ? WHERE ReturnID = ?", [managerId, employeeId, ref.ReturnID]);
  await conn.query("UPDATE Refund SET RefundStatusCode = 2, RefundDateTime = UTC_TIMESTAMP(), ApprovedByEmployeeID = ?, UpdatedBy = ? WHERE RefundID = ?", [managerId, employeeId, ref.RefundID]);
  const totalCents = cents(ref.Amount);
  const orderRefunded = await afterRefund(conn, { order: { OrderID: ref.OrderID, OrderStatusCode: ref.OrderStatusCode }, paymentId: ref.PaymentID, remainingBefore: cents(payment.Remaining), totalCents, employeeId, businessId });
  return { totalCents, method: label(payment.Description), orderRefunded };
};

// Rejecting needs no PIN. The refund is marked FAILED, and its items are released so they can be asked for again.
approvals.handlers.REFUND_REJECT = async (conn, a) => {
  if (!(await hasPermission(conn, a.actorId, PERM_SIGN_REFUND_OVERRIDES))) throw new HttpError(403, "Your role can't do this.");
  const ref = await lockWaiting(conn, a);
  await conn.query("UPDATE Refund SET RefundStatusCode = 3, UpdatedBy = ? WHERE RefundID = ?", [a.actorId, ref.RefundID]);
  await conn.query("DELETE FROM ReturnItem WHERE ReturnID = ?", [ref.ReturnID]);
};

router.post("/refunds/:id/approve", needSigner, async (req, res) => {
  const managerId = await verifyOverride(
    req.session, String(req.body.managerNumber), String(req.body.managerPin), [PERM_SIGN_REFUND_OVERRIDES, PERM_APPROVE_DISCOUNTS]
  );
  res.json(await pool.tx((conn) => approve(conn, req.session, "REFUND_APPROVE", String(req.params.id), {}, managerId)));
});

router.post("/refunds/:id/reject", needSigner, async (req, res) => {
  await pool.tx((conn) => approve(conn, req.session, "REFUND_REJECT", String(req.params.id)));
  res.json({ ok: true });
});

router.waitingRefunds = waitingRefunds;
module.exports = router;
