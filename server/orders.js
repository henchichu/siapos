const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { requirePermission } = require("./session");
const { myLocations } = require("./locations");
const { hasPermission } = require("./pin");
const { label } = require("./labels");
const { isDate } = require("./dates");

const PERM_REFUND = 2;
const PERM_SEARCH_ORDERS = 16;
const SHOWN = 200; // rows a search lists; the count is the full figure
const MAX_DAYS = 366;
const ONLINE = 2;

const router = express.Router();
router.use("/orders", requirePermission(PERM_SEARCH_ORDERS));

const person = "NULLIF(TRIM(CONCAT_WS(' ', {t}.FirstName, {t}.LastName)), '')";
const nameOf = (t) => person.replaceAll("{t}", t);

// A day is the café's own day: its edges are that location's midnights, converted to UTC
router.get("/orders", async (req, res) => {
  const { businessId, locationId, employeeId } = req.session;
  const mine = await myLocations(employeeId);
  const [[home]] = await pool.query(
    "SELECT DATE_FORMAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', TimeZone)), '%Y-%m-%d') AS today FROM Location WHERE LocationID = ?", [locationId]);
  const from = String(req.query.from || home.today);
  const to = String(req.query.to || home.today);
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, "Dates must look like 2026-10-31.");
  const days = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000;
  if (days < 0) throw new HttpError(400, "The From date can't be after the To date.");
  if (days >= MAX_DAYS) throw new HttpError(400, "Search up to a year at a time.");

  const where = ["o.BusinessID = ?", "o.LocationID IN (?)",
    "o.OrderDateTime >= CONVERT_TZ(?, l.TimeZone, '+00:00')", "o.OrderDateTime < CONVERT_TZ(DATE_ADD(?, INTERVAL 1 DAY), l.TimeZone, '+00:00')"];
  const params = [businessId, mine, from, to];
  if (req.query.locationId && req.query.locationId !== "all") {
    if (!mine.includes(String(req.query.locationId))) throw new HttpError(403, "You don't work at that location.");
    where.push("o.LocationID = ?"); params.push(String(req.query.locationId));
  }
  if (req.query.employeeId && req.query.employeeId !== "all") { where.push("o.EmployeeID = ?"); params.push(String(req.query.employeeId)); }
  if (req.query.status && req.query.status !== "any") {
    const status = Number(req.query.status);
    if (!Number.isInteger(status) || status < 1 || status > 7) throw new HttpError(400, "That status doesn't exist.");
    where.push("o.OrderStatusCode = ?"); params.push(status);
  }

  const [statuses] = await pool.query("SELECT OrderStatusCode AS code, Description FROM OrderStatus ORDER BY OrderStatusCode");
  const filters = { locations: [], employees: [], statuses: statuses.map((s) => ({ code: s.code, name: label(s.Description) })) };
  if (!mine.length) return res.json({ from, to, count: 0, orders: [], filters });

  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM Orders o JOIN Location l ON l.LocationID = o.LocationID WHERE ${where.join(" AND ")}`, params);
  const [rows] = await pool.query(
    `SELECT o.OrderID AS id, o.OrderDateTime AS placedAt, l.TimeZone AS timeZone, o.OrderNumber AS orderNumber, o.ChannelCode AS channel,
            g.Name AS register, ${nameOf("e")} AS employee, ${nameOf("c")} AS member, s.Description AS status, o.Total AS total
       FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN OrderStatus s ON s.OrderStatusCode = o.OrderStatusCode
       LEFT JOIN Register g ON g.RegisterID = o.RegisterID LEFT JOIN Employee e ON e.EmployeeID = o.EmployeeID LEFT JOIN Customer c ON c.CustomerID = o.CustomerID
      WHERE ${where.join(" AND ")} ORDER BY o.OrderDateTime DESC, o.OrderNumber DESC LIMIT ${SHOWN}`,
    params
  );
  [filters.locations] = await pool.query("SELECT LocationID AS id, Name AS name FROM Location WHERE LocationID IN (?) ORDER BY Name", [mine]);
  [filters.employees] = await pool.query(
    `SELECT DISTINCT e.EmployeeID AS id, CONCAT_WS(' ', e.FirstName, e.LastName) AS name FROM EmployeeLocation el JOIN Employee e ON e.EmployeeID = el.EmployeeID
      WHERE el.LocationID IN (?) ORDER BY name`, [mine]);

  res.json({
    from, to, count: n, shown: SHOWN, filters,
    orders: rows.map((r) => ({
      id: r.id, placedAt: r.placedAt, timeZone: r.timeZone, orderNumber: r.orderNumber,
      source: r.channel === ONLINE ? "Online" : r.register || "Register", employee: r.employee, member: r.member || "Walk-in",
      status: label(r.status), total: Number(r.total),
    })),
  });
});

router.get("/orders/:id", async (req, res) => {
  const { businessId, employeeId } = req.session;
  const mine = await myLocations(employeeId);
  const [[o]] = mine.length ? await pool.query(
    `SELECT o.OrderID AS id, o.OrderNumber AS orderNumber, o.OrderDateTime AS placedAt, o.ChannelCode AS channel, o.OrderStatusCode AS statusCode,
            s.Description AS status, o.Subtotal AS subtotal, o.DiscountAmount AS discount, o.Tax AS tax, o.Total AS total, o.PricesIncludeTax AS pricesIncludeTax,
            o.PickupAt AS pickupAt, o.CustomerNote AS note, l.Name AS location, l.TimeZone AS timeZone, g.Name AS register,
            ${nameOf("e")} AS employee, ${nameOf("c")} AS customer
       FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN OrderStatus s ON s.OrderStatusCode = o.OrderStatusCode
       LEFT JOIN Register g ON g.RegisterID = o.RegisterID LEFT JOIN Employee e ON e.EmployeeID = o.EmployeeID LEFT JOIN Customer c ON c.CustomerID = o.CustomerID
      WHERE o.OrderID = ? AND o.BusinessID = ? AND o.LocationID IN (?)`,
    [String(req.params.id), businessId, mine]
  ) : [[]];
  if (!o) throw new HttpError(404, "No such order.");

  const [items] = await pool.query(
    `SELECT oi.OrderItemID AS id, p.Name AS product, v.Name AS variant, oi.Quantity AS qty, oi.UnitPrice AS unitPrice, oi.LineTotal AS lineTotal,
            (SELECT COUNT(*) FROM ProductVariant x WHERE x.ProductID = p.ProductID AND x.Active) > 1 AS sized
       FROM OrderItem oi JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID
      WHERE oi.OrderID = ? ORDER BY p.Name, v.Name`, [o.id]);
  const [mods] = items.length ? await pool.query(
    `SELECT om.OrderItemID AS itemId, m.Name AS name, om.Quantity AS qty FROM OrderItemModifier om JOIN Modifier m ON m.ModifierID = om.ModifierID
      WHERE om.OrderItemID IN (?) ORDER BY m.Name`, [items.map((i) => i.id)]) : [[]];
  const [promos] = await pool.query("SELECT p.Name AS name FROM PromotionRedemption r JOIN Promotion p ON p.PromotionID = r.PromotionID WHERE r.OrderID = ?", [o.id]);
  const [oneOffs] = await pool.query("SELECT Reason AS name FROM OrderDiscount WHERE OrderID = ?", [o.id]);
  const [payments] = await pool.query(
    `SELECT p.Amount AS amount, p.TipAmount AS tip, p.PaymentStatusCode AS statusCode, ps.Description AS status, pm.Description AS method, p.PaymentDateTime AS at
       FROM Payment p JOIN PaymentMethod pm USING (PaymentMethodCode) JOIN PaymentStatus ps USING (PaymentStatusCode) WHERE p.OrderID = ? ORDER BY p.PaymentDateTime`, [o.id]);
  const [refunds] = await pool.query(
    `SELECT r.Amount AS amount, rs.Description AS status, pm.Description AS method, COALESCE(r.RefundDateTime, r.CreatedAt) AS at
       FROM Refund r JOIN RefundStatus rs USING (RefundStatusCode) JOIN Payment p ON p.PaymentID = r.PaymentID JOIN PaymentMethod pm USING (PaymentMethodCode)
      WHERE r.OrderID = ? ORDER BY COALESCE(r.RefundDateTime, r.CreatedAt)`, [o.id]);
  const [history] = await pool.query(
    `SELECT h.ChangedAt AS at, s.Description AS status, ${nameOf("e")} AS byName FROM OrderStatusHistory h JOIN OrderStatus s ON s.OrderStatusCode = h.OrderStatusCode
       LEFT JOIN Employee e ON e.EmployeeID = h.ChangedByEmployeeID WHERE h.OrderID = ? ORDER BY h.ChangedAt, h.OrderStatusCode`, [o.id]);

  const tipRows = payments.filter((p) => [3, 5].includes(p.statusCode) && Number(p.tip) > 0);
  const tip = tipRows.reduce((a, p) => a + Number(p.tip), 0);
  const online = o.channel === ONLINE;
  res.json({
    id: o.id, orderNumber: o.orderNumber, timeZone: o.timeZone, placedAt: o.placedAt, status: label(o.status), source: online ? "Online" : o.register || "Register",
    total: Number(o.total),
    canRefund: [5, 7].includes(o.statusCode) && (await hasPermission(pool, employeeId, PERM_REFUND)),
    items: items.map((i) => ({
      name: i.sized ? `${i.product}, ${i.variant}` : i.product,
      options: mods.filter((m) => m.itemId === i.id).map((m) => (m.qty > 1 ? `${m.name} ×${m.qty}` : m.name)),
      qty: Number(i.qty), unitPrice: Number(i.unitPrice), lineTotal: Number(i.lineTotal),
    })),
    totals: {
      subtotal: Number(o.subtotal), discount: Number(o.discount), discountNames: [...promos, ...oneOffs].map((d) => d.name),
      tax: Number(o.tax), taxIncluded: !!o.pricesIncludeTax, total: Number(o.total),
    },
    payments: [
      ...payments.map((p) => ({ type: "Payment", method: label(p.method), amount: Number(p.amount), status: label(p.status), at: p.at })),
      ...refunds.map((r) => ({ type: "Refund", method: label(r.method), amount: -Number(r.amount), status: label(r.status), at: r.at })),
      ...(tip ? [{ type: "Tip", method: null, amount: tip, status: null, at: tipRows[tipRows.length - 1].at }] : []),
    ],
    where: {
      location: o.location, register: online ? null : o.register, rungUpBy: online ? "Online" : o.employee,
      customer: o.customer || "Walk-in", pickup: online ? { at: o.pickupAt } : null, note: o.note,
    },
    history: history.map((h) => ({ at: h.at, status: label(h.status), by: h.byName })),
  });
});

module.exports = router;
