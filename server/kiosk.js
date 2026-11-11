// The kiosk: a signed-in customer browses the menu and orders for pickup at the café. A cash order waits, holding its stock,
// until the register takes the cash (server/kioskorders.js). With MOCK_PAY=1 a test card, Apple Pay or Google Pay pays at once.
// A customer can't send their own promotion or discount: only the lines reach the pricer.
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { priceCart, cents, dollars } = require("./pricing");
const { notify } = require("./watchers");
const { addOrderLines, fingerprint, nextOrderNumber } = require("./orderlines");
const { charge } = require("./mockpay");
const { label } = require("./labels");
const check = require("./validate");
const rateLimit = require("./ratelimit");
const { requireCustomer } = require("./customer");

const router = express.Router();
router.use("/customer", requireCustomer);

const KIOSK = 3;
const UNPAID_MAX_ITEMS = 20; // an unpaid order holds stock, so one can't take a whole shelf
const PAID_HERE = { "Card": [2, "card"], "Apple Pay": [5, "apple"], "Google Pay": [6, "google"] }; // payment method code, mock kind
const mockPay = () => process.env.MOCK_PAY === "1"; // the mock takes no money, so it is offered only in development

// The café is the business's first active one by name, like a staff sign-in
async function place(customer) {
  const [[l]] = await pool.query(
    `SELECT l.LocationID, l.Name AS locationName, b.Name AS businessName
       FROM Location l JOIN Business b ON b.BusinessID = l.BusinessID AND b.Active
      WHERE l.BusinessID = ? AND l.Active ORDER BY l.Name LIMIT 1`, [customer.businessId]);
  if (!l) throw new HttpError(404, "This café isn't taking orders right now.");
  return l;
}

// Customer-facing wording for the database's statuses. Customers never change these.
const CUSTOMER_STATUS = {
  PENDING_PAYMENT: "Received", CONFIRMED: "Confirmed", PREPARING: "Preparing",
  READY: "Ready for pickup", COMPLETED: "Picked up", CANCELLED: "Cancelled", REFUNDED: "Refunded",
};
const statusLabel = (description) => CUSTOMER_STATUS[description] || label(description);

router.get("/customer/context", async (req, res) => {
  const k = await place(req.customer);
  res.json({ businessName: k.businessName, locationName: k.locationName, payHere: mockPay() });
});

// The page calls this when the customer touches it, which restarts the idle clock
router.post("/customer/touch", (req, res) => { req.customer.active = Date.now(); res.json({}); });

// A product's picture, for the page's <img> tags
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "../uploads");
router.get("/customer/products/:id/photo", async (req, res) => {
  const [[p]] = await pool.query("SELECT ImageKey FROM Product WHERE ProductID = ? AND BusinessID = ? AND Active AND ImageKey IS NOT NULL", [String(req.params.id), req.customer.businessId]);
  if (!p) throw new HttpError(404, "No photo.");
  res.sendFile(path.resolve(UPLOAD_DIR, p.ImageKey), { maxAge: "5m" }, (err) => { if (err && !res.headersSent) res.status(404).json({ error: "No photo." }); });
});

// Products for sale here, with their variants (sizes) and modifier groups (milk, extras)
router.get("/customer/catalog", async (req, res) => {
  const { businessId } = req.customer;
  const k = await place(req.customer);
  const [rows] = await pool.query(
    `SELECT p.ProductID AS id, p.Name AS name, p.Description AS description, p.ImageKey AS imageKey, c.Name AS category
       FROM Product p LEFT JOIN Category c ON c.CategoryID = p.CategoryID AND c.Active
      WHERE p.BusinessID = ? AND p.Active ORDER BY p.Name`, [businessId]);
  const [variants] = await pool.query(
    `SELECT v.VariantID AS id, v.ProductID AS productId, v.Name AS name, v.Price AS price,
            EXISTS (SELECT 1 FROM VariantRecipe r WHERE r.VariantID = v.VariantID)
            AND NOT EXISTS (SELECT 1 FROM VariantRecipe vr LEFT JOIN Inventory i ON i.StockItemID = vr.StockItemID AND i.LocationID = ?
                             WHERE vr.VariantID = v.VariantID AND COALESCE(i.Quantity, 0) < vr.QuantityPerUnit) AS available
       FROM ProductVariant v JOIN Product p ON p.ProductID = v.ProductID
      WHERE v.BusinessID = ? AND v.Active AND p.Active ORDER BY v.Price`, [k.LocationID, businessId]);
  const [groups] = await pool.query(
    `SELECT pmg.ProductID AS productId, g.ModifierGroupID AS id, g.Name AS name, g.MinSelect AS min, g.MaxSelect AS max,
            m.ModifierID AS modId, m.Name AS modName, m.PriceDelta AS delta
       FROM ProductModifierGroup pmg
       JOIN ModifierGroup g ON g.ModifierGroupID = pmg.ModifierGroupID AND g.Active
       JOIN Modifier m ON m.ModifierGroupID = g.ModifierGroupID AND m.Active
      WHERE pmg.BusinessID = ? ORDER BY pmg.SortOrder, g.Name, m.PriceDelta, m.Name`, [businessId]);
  const products = rows.map((p) => {
    const groupsOf = [];
    for (const g of groups.filter((x) => x.productId === p.id)) {
      let grp = groupsOf.find((x) => x.id === g.id);
      if (!grp) groupsOf.push((grp = { id: g.id, name: g.name, min: g.min, max: g.max, modifiers: [] }));
      grp.modifiers.push({ id: g.modId, name: g.modName, deltaCents: cents(g.delta) });
    }
    return {
      id: p.id, name: p.name, description: p.description, category: p.category || "Other", hasPhoto: !!p.imageKey,
      variants: variants.filter((v) => v.productId === p.id).map((v) => ({ id: v.id, name: v.name, priceCents: cents(v.price), available: !!v.available })),
      groups: groupsOf,
    };
  });
  res.json({ products, categories: [...new Set(products.map((p) => p.category))].sort() });
});

const cartOf = (body) => ({ items: Array.isArray(body.items) ? body.items.map((i) => ({ key: i.key, variantId: i.variantId, quantity: i.quantity, modifierIds: i.modifierIds })) : [] });

// Prices a cart on the server. The browser's totals are only a preview; the server's numbers are what get charged.
router.post("/customer/price", async (req, res) => {
  const k = await place(req.customer);
  const p = await priceCart(pool, { businessId: req.customer.businessId, locationId: k.LocationID }, cartOf(req.body));
  res.json({ subtotalCents: p.subtotalCents, taxCents: p.taxCents, totalCents: p.totalCents });
});

// An order still on its way: waiting for payment, confirmed, being made, or ready. Its customer can't place another until it is picked up.
async function activeOrder(customerId, businessId) {
  const [[o]] = await pool.query(
    `SELECT o.OrderID AS id, o.OrderNumber AS orderNumber, o.OrderDateTime AS placedAt, o.OrderStatusCode AS statusCode, st.Description AS status, l.TimeZone AS tz
       FROM Orders o JOIN OrderStatus st ON st.OrderStatusCode = o.OrderStatusCode JOIN Location l ON l.LocationID = o.LocationID
      WHERE o.CustomerID = ? AND o.BusinessID = ? AND o.ChannelCode = ? AND o.OrderStatusCode IN (1, 2, 3, 4)
      ORDER BY o.OrderDateTime DESC LIMIT 1`, [customerId, businessId, KIOSK]);
  return o ? { id: o.id, orderNumber: o.orderNumber, placedAt: o.placedAt, tz: o.tz, statusCode: o.statusCode, status: statusLabel(o.status) } : null;
}

async function placeOrder(req) {
  const { customerId, businessId } = req.customer;
  const k = await place(req.customer);
  const open = await activeOrder(customerId, businessId);
  if (open) throw new HttpError(409, `Your order #${open.orderNumber} is still in progress. You can order again once it has been picked up.`);
  const payWith = String(req.body.paymentMethod || "");
  const paidHere = mockPay() ? PAID_HERE[payWith] : null;
  if (payWith !== "Cash" && !paidHere) throw new HttpError(400, "Choose how you'll pay.");
  const note = check.note(req.body.note, "note", 120) || null;
  const priced = await priceCart(pool, { businessId, locationId: k.LocationID }, cartOf(req.body));
  if (!paidHere && priced.lines.reduce((n, l) => n + l.quantity, 0) > UNPAID_MAX_ITEMS)
    throw new HttpError(400, `A pay-at-counter order can have up to ${UNPAID_MAX_ITEMS} items. For more, order at the counter.`);

  return pool.tx(async (conn) => {
    const orderId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO Orders (OrderID, LocationID, BusinessID, RegisterID, EmployeeID, CustomerID, ChannelCode, CustomerNote, OrderNumber, PricesIncludeTax)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, (SELECT PricesIncludeTax FROM Business WHERE BusinessID = ?))`,
      [orderId, k.LocationID, businessId, customerId, KIOSK, note, await nextOrderNumber(conn, businessId), businessId]);
    await addOrderLines(conn, { orderId, businessId, locationId: k.LocationID, employeeId: null, priced,
      unavailable: (l) => `${l.productName} can't be ordered right now.` });
    await conn.query("UPDATE Orders SET Subtotal = ?, Tax = ?, Total = ? WHERE OrderID = ?",
      [dollars(priced.subtotalCents), dollars(priced.taxCents), dollars(priced.totalCents), orderId]);
    const history = (status) => conn.query(
      "INSERT INTO OrderStatusHistory (OrderStatusHistoryID, OrderID, BusinessID, OrderStatusCode, ChangedAt) VALUES (UUID(), ?, ?, ?, UTC_TIMESTAMP())",
      [orderId, businessId, status]);
    await history(1);
    if (paidHere) {
      if (priced.totalCents > 0)
        await conn.query("INSERT INTO Payment (PaymentID, OrderID, PaymentMethodCode, Amount, PaymentStatusCode) VALUES (UUID(), ?, ?, ?, 3)",
          [orderId, paidHere[0], dollars(priced.totalCents)]);
      await conn.query("UPDATE Orders SET OrderStatusCode = 2 WHERE OrderID = ?", [orderId]);
      await history(2);
    }
    const [[o]] = await conn.query("SELECT OrderNumber FROM Orders WHERE OrderID = ?", [orderId]);
    // Charged last, after every write that can still fail: a decline rolls the order back, and nothing after it can fail.
    // shortcut: a deadlock reruns this, charging again; harmless for the mock, a real processor needs an idempotency key
    if (paidHere && priced.totalCents > 0) charge(paidHere[1], req.body.card);
    return { orderId, orderNumber: o.OrderNumber, totalCents: priced.totalCents, paid: !!paidHere };
  }).then((receipt) => { notify(k.LocationID); return receipt; });
}

// Orders are submitted once per idempotencyKey: a retry with the same key and body gets the first receipt back.
// shortcut: remembered in memory per process; a retry after a restart could create a second order.
const submitted = new Map();
router.post("/customer/orders", rateLimit(10, 60 * 1000), async (req, res) => {
  const key = req.body.idempotencyKey ? `${req.customer.customerId}|${req.body.idempotencyKey}` : "";
  const body = fingerprint({ ...req.body, idempotencyKey: undefined });
  let receipt = key && submitted.get(key)?.body === body ? submitted.get(key).receipt : null;
  if (!receipt) {
    receipt = placeOrder(req);
    if (key) {
      submitted.set(key, { body, receipt });
      receipt.catch(() => submitted.get(key)?.receipt === receipt && submitted.delete(key));
      if (submitted.size > 200) submitted.delete(submitted.keys().next().value);
    }
  }
  res.json(await receipt);
});

// One of the customer's own orders
router.get("/customer/orders/:id", async (req, res) => {
  const [[o]] = await pool.query(
    `SELECT o.OrderID AS id, o.OrderNumber AS orderNumber, o.OrderDateTime AS placedAt, o.Total AS total,
            o.CompletedAt AS completedAt, o.CustomerNote AS note, o.OrderStatusCode AS statusCode, st.Description AS status, l.TimeZone AS tz
       FROM Orders o JOIN OrderStatus st ON st.OrderStatusCode = o.OrderStatusCode JOIN Location l ON l.LocationID = o.LocationID
      WHERE o.OrderID = ? AND o.ChannelCode = ? AND o.CustomerID = ? AND o.BusinessID = ?`, [String(req.params.id), KIOSK, req.customer.customerId, req.customer.businessId]);
  if (!o) throw new HttpError(404, "No such order.");
  const [items] = await pool.query(
    `SELECT oi.Quantity AS qty, oi.LineTotal AS line, p.Name AS product, v.Name AS size,
            (SELECT COUNT(*) FROM ProductVariant x WHERE x.ProductID = p.ProductID AND x.Active) > 1 AS sized
       FROM OrderItem oi JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID
      WHERE oi.OrderID = ? ORDER BY oi.OrderItemID`, [o.id]);
  res.json({
    id: o.id, orderNumber: o.orderNumber, placedAt: o.placedAt, tz: o.tz, total: Number(o.total), note: o.note,
    status: statusLabel(o.status), statusCode: o.statusCode, completedAt: o.completedAt,
    items: items.map((i) => ({ name: i.sized ? `${i.product}, ${i.size}` : i.product, qty: Number(i.qty), lineTotal: Number(i.line) })),
  });
});

// The order the status island shows: this customer's newest one still in progress, or none
router.get("/customer/active-order", async (req, res) => res.json({ order: await activeOrder(req.customer.customerId, req.customer.businessId) }));

router.get("/customer/my-orders", async (req, res) => {
  const [rows] = await pool.query(
    `SELECT o.OrderID AS id, o.OrderNumber AS orderNumber, o.OrderDateTime AS placedAt, o.Total AS total,
            st.Description AS status, l.TimeZone AS tz,
            COALESCE((SELECT SUM(lt.PointsChange) FROM LoyaltyTransaction lt
                       WHERE lt.OrderID = o.OrderID AND lt.LoyaltyTransactionTypeCode = 1), 0) AS earned
       FROM Orders o JOIN OrderStatus st ON st.OrderStatusCode = o.OrderStatusCode JOIN Location l ON l.LocationID = o.LocationID
      WHERE o.CustomerID = ? AND o.ChannelCode = ? AND o.BusinessID = ? ORDER BY o.OrderDateTime DESC LIMIT 50`, [req.customer.customerId, KIOSK, req.customer.businessId]);
  res.json({ orders: rows.map((o) => ({ id: o.id, orderNumber: o.orderNumber, placedAt: o.placedAt, tz: o.tz, total: Number(o.total), status: statusLabel(o.status), earned: Number(o.earned) })) });
});

module.exports = router;
