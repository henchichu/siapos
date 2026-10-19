const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { cents, dollars } = require("./pricing");
const { verifyOverride } = require("./override");
const { requirePermission } = require("./session");
const { myLocations } = require("./locations");
const { hasPermission } = require("./pin");

const PERM_SIGN_REFUND_OVERRIDES = 3;
const PERM_APPROVE_DISCOUNTS = 4;
const PERM_REFUND = 2;

const router = express.Router();
router.use("/refunds", requirePermission(PERM_REFUND));

const methodName = (description) => {
  const s = description.replace(/_/g, " ").toLowerCase();
  return s[0].toUpperCase() + s.slice(1);
};

router.get("/refunds/order", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) throw new HttpError(400, "Enter an order number, or a member email or phone.");
  const { businessId } = req.session;

  const base = `SELECT o.OrderID, o.OrderNumber, o.OrderDateTime, o.OrderStatusCode, c.FirstName, c.LastName
                  FROM Orders o LEFT JOIN Customer c ON c.CustomerID = o.CustomerID WHERE o.BusinessID = ?`;
  const [[order]] = /^\d{1,8}$/.test(q)
    ? await pool.query(`${base} AND o.OrderNumber = ?`, [businessId, q])
    : await pool.query(
        `${base} AND o.OrderStatusCode IN (5, 7)
            AND (c.Email = ? OR REGEXP_REPLACE(c.Phone, '[^0-9]', '') = ?)
          ORDER BY o.OrderDateTime DESC LIMIT 1`,
        [businessId, q, q.replace(/\D/g, "") || "#"]
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
    method: payments.map((p) => methodName(p.Description)).join(" + "),
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

function readRefundBody(body) {
  const reason = String(body.reason || "").trim();
  const wanted = body.lines;
  if (!reason || reason.length > 255) throw new HttpError(400, "Enter a reason (up to 255 characters).");
  if (!Array.isArray(wanted) || !wanted.length) throw new HttpError(400, "Tick at least one item to return.");
  for (const l of wanted)
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new HttpError(400, "Quantity to return must be a whole number above zero.");
  return { reason, wanted };
}

// A refund is either done now (a manager signed it) or only asked for: saved as PENDING with its return recorded, so the
// items count as returned, while stock, payment and order are left alone until a manager approves it.
async function recordRefund(conn, { session, orderId, wanted, reason, managerId = null, pending = false }) {
  const { employeeId, businessId } = session;
  // Order first, then payments: the same lock order the DB's own checks use
  const [[order]] = await conn.query(
    "SELECT OrderID, LocationID, OrderStatusCode FROM Orders WHERE OrderID = ? AND BusinessID = ? FOR UPDATE",
    [String(orderId), businessId]
  );
  if (!order) throw new HttpError(404, "No order found.");
  if (![5, 7].includes(order.OrderStatusCode)) throw new HttpError(409, "Only completed orders can be refunded.");
  if (pending) {
    if (!(await myLocations(employeeId)).includes(order.LocationID)) throw new HttpError(403, "You don't work at that order's location.");
    const [[gift]] = await conn.query("SELECT COUNT(*) AS n FROM OrderItem oi JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID WHERE oi.OrderID = ? AND p.IsGiftCard", [order.OrderID]);
    if (gift.n) throw new HttpError(409, "This order sold a gift card. Refund it with a manager present.");
  }

  const [items] = await conn.query(
    `SELECT oi.OrderItemID, oi.Quantity, v.RestockOnReturn,
            COALESCE((SELECT SUM(ri.QuantityReturned) FROM ReturnItem ri WHERE ri.OrderItemID = oi.OrderItemID), 0) AS Returned
       FROM OrderItem oi JOIN ProductVariant v ON v.VariantID = oi.VariantID WHERE oi.OrderID = ?`,
    [order.OrderID]
  );
  const returnId = crypto.randomUUID();
  await conn.query(
    "INSERT INTO Returns (ReturnID, OrderID, BusinessID, ApprovedByEmployeeID, CreatedBy) VALUES (?, ?, ?, ?, ?)",
    [returnId, order.OrderID, businessId, managerId, employeeId]
  );

  let netCents = 0;
  let taxCents = 0;
  for (const l of wanted) {
    const item = items.find((i) => i.OrderItemID === l.orderItemId);
    if (!item) throw new HttpError(400, "An item isn't part of this order.");
    if (l.qty > Number(item.Quantity) - Number(item.Returned)) throw new HttpError(409, "More items than are left to return. A refund for some of them may be waiting for a manager.");
    const restock = l.restock ? l.qty : 0;
    if (restock && !item.RestockOnReturn) throw new HttpError(400, "That item can't go back to stock.");

    await conn.query(
      `INSERT INTO ReturnItem (ReturnItemID, ReturnID, OrderID, OrderItemID, QuantityReturned, QuantityRestocked)
       VALUES (UUID(), ?, ?, ?, ?, ?)`,
      [returnId, order.OrderID, item.OrderItemID, l.qty, restock]
    );
    if (restock && !pending) await postRestock(conn, order.LocationID, employeeId, item.OrderItemID, restock);
    // The same proration the DB caps a refund with (CheckRefund)
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

  await conn.query(
    `INSERT INTO Refund (RefundID, PaymentID, ReturnID, OrderID, BusinessID, Amount, TaxAmount, RefundDateTime,
                         Reason, RefundStatusCode, ApprovedByEmployeeID, CreatedBy)
     VALUES (UUID(), ?, ?, ?, ?, ?, ?, ${pending ? "NULL" : "UTC_TIMESTAMP()"}, ?, ?, ?, ?)`,
    [payment.PaymentID, returnId, order.OrderID, businessId, dollars(totalCents), dollars(taxCents), reason, pending ? 1 : 2, managerId, employeeId]
  );

  const orderRefunded = pending ? false
    : await afterRefund(conn, { order, paymentId: payment.PaymentID, remainingBefore: cents(payment.Remaining), totalCents, employeeId, businessId });
  return { itemsCents: netCents, taxCents, totalCents, method: methodName(payment.Description), orderRefunded };
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
async function lockWaiting(conn, session, id) {
  const [[ref]] = await conn.query(
    `SELECT r.RefundID, r.OrderID, r.PaymentID, r.ReturnID, r.Amount, o.LocationID, o.OrderStatusCode
       FROM Refund r JOIN Orders o ON o.OrderID = r.OrderID WHERE r.RefundID = ? AND r.BusinessID = ? AND r.RefundStatusCode = 1 FOR UPDATE`,
    [id, session.businessId]
  );
  if (!ref) throw new HttpError(409, "That refund isn't waiting any more.");
  if (!(await myLocations(session.employeeId)).includes(ref.LocationID)) throw new HttpError(403, "You don't work at that order's location.");
  return ref;
}

router.post("/refunds/:id/approve", needSigner, async (req, res) => {
  const managerId = await verifyOverride(
    req.session, String(req.body.managerNumber), String(req.body.managerPin), [PERM_SIGN_REFUND_OVERRIDES, PERM_APPROVE_DISCOUNTS]
  );
  const { employeeId, businessId } = req.session;
  const out = await pool.tx(async (conn) => {
    const ref = await lockWaiting(conn, req.session, req.params.id);
    const [[payment]] = await conn.query(
      `SELECT p.Amount - COALESCE((SELECT SUM(r.Amount) FROM Refund r WHERE r.PaymentID = p.PaymentID AND r.RefundStatusCode <> 3 AND r.RefundID <> ?), 0) AS Remaining, pm.Description
         FROM Payment p JOIN PaymentMethod pm USING (PaymentMethodCode) WHERE p.PaymentID = ? FOR UPDATE`,
      [ref.RefundID, ref.PaymentID]
    );
    const [back] = await conn.query("SELECT OrderItemID, QuantityRestocked FROM ReturnItem WHERE ReturnID = ? AND QuantityRestocked > 0", [ref.ReturnID]);
    for (const b of back) await postRestock(conn, ref.LocationID, employeeId, b.OrderItemID, Number(b.QuantityRestocked));
    await conn.query("UPDATE Returns SET ApprovedByEmployeeID = ?, UpdatedBy = ? WHERE ReturnID = ?", [managerId, employeeId, ref.ReturnID]);
    await conn.query("UPDATE Refund SET RefundStatusCode = 2, RefundDateTime = UTC_TIMESTAMP(), ApprovedByEmployeeID = ?, UpdatedBy = ? WHERE RefundID = ?", [managerId, employeeId, ref.RefundID]);
    const totalCents = cents(ref.Amount);
    const orderRefunded = await afterRefund(conn, { order: { OrderID: ref.OrderID, OrderStatusCode: ref.OrderStatusCode }, paymentId: ref.PaymentID, remainingBefore: cents(payment.Remaining), totalCents, employeeId, businessId });
    return { totalCents, method: methodName(payment.Description), orderRefunded };
  });
  res.json(out);
});

// Rejecting needs no PIN. The refund is marked FAILED, and its items are released so they can be asked for again.
router.post("/refunds/:id/reject", needSigner, async (req, res) => {
  await pool.tx(async (conn) => {
    const ref = await lockWaiting(conn, req.session, req.params.id);
    await conn.query("UPDATE Refund SET RefundStatusCode = 3, UpdatedBy = ? WHERE RefundID = ?", [req.session.employeeId, ref.RefundID]);
    await conn.query("DELETE FROM ReturnItem WHERE ReturnID = ?", [ref.ReturnID]);
  });
  res.json({ ok: true });
});

router.waitingRefunds = waitingRefunds;
module.exports = router;
