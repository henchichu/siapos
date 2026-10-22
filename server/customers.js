// Customer kiosk API. Mounted before the employee session check, so it never needs a staff sign-in.
// Auth is phone-number only, as the owner chose: anyone who knows a customer's phone can open their history
// on this device. Accepted for a counter kiosk where the customer is present.
const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { priceCart, cents, dollars } = require("./pricing");
const { notify } = require("./kitchen");
const { label } = require("./labels");

const router = express.Router();

// shortcut: customer sessions are in memory; a restart signs customers out. Move to a table for several servers.
const sessions = new Map();
const SESSION_MS = 2 * 60 * 60 * 1000;
const tokenOf = (req) => /(?:^|;\s*)customer_session=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1];

function signIn(res, customerId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { customerId, expires: Date.now() + SESSION_MS });
  res.cookie("customer_session", token, { httpOnly: true, sameSite: "strict", maxAge: SESSION_MS, secure: process.env.COOKIE_SECURE === "1" });
}

function currentCustomer(req) {
  const token = tokenOf(req);
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}

setInterval(() => {
  for (const [token, s] of sessions) if (s.expires < Date.now()) sessions.delete(token);
}, 60 * 60 * 1000).unref();

// The business and location this iPad is set up for: KIOSK_LOCATION_ID, or else the first active location
async function kiosk() {
  const [[k]] = process.env.KIOSK_LOCATION_ID
    ? await pool.query(
        `SELECT l.LocationID, l.BusinessID, l.Name AS locationName, b.Name AS businessName, r.RegisterID
           FROM Location l JOIN Business b ON b.BusinessID = l.BusinessID
           LEFT JOIN Register r ON r.LocationID = l.LocationID AND r.RegStatusCode = 1
          WHERE l.LocationID = ? AND l.Active ORDER BY r.Name LIMIT 1`, [process.env.KIOSK_LOCATION_ID])
    : await pool.query(
        `SELECT l.LocationID, l.BusinessID, l.Name AS locationName, b.Name AS businessName, r.RegisterID
           FROM Location l JOIN Business b ON b.BusinessID = l.BusinessID
           LEFT JOIN Register r ON r.LocationID = l.LocationID AND r.RegStatusCode = 1
          WHERE l.Active ORDER BY l.Name, r.Name LIMIT 1`);
  if (!k) throw new HttpError(503, "This kiosk has no location set up yet.");
  return k;
}

// Stock to take for one line, the same way the register does it: the recipe, less any substitutions, plus additions
const thousandths = (s) => Math.round(parseFloat(s) * 1000);
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

// Customer-facing wording for the database's statuses. Customers never change these.
const CUSTOMER_STATUS = {
  PENDING_PAYMENT: "Received", CONFIRMED: "Confirmed", PREPARING: "Preparing",
  READY: "Ready for pickup", COMPLETED: "Picked up", CANCELLED: "Cancelled", REFUNDED: "Refunded",
};
const statusLabel = (description) => CUSTOMER_STATUS[description] || label(description);

// Routes 

router.get("/customer/context", async (req, res) => {
  const k = await kiosk();
  res.json({ businessName: k.businessName, locationName: k.locationName });
});

// Products for sale here, with their variants (sizes) and modifier groups (milk, extras)
router.get("/customer/catalog", async (req, res) => {
  const k = await kiosk();
  const [rows] = await pool.query(
    `SELECT p.ProductID AS id, p.Name AS name, p.Description AS description, p.ImageKey AS imageKey, c.Name AS category
       FROM Product p LEFT JOIN Category c ON c.CategoryID = p.CategoryID AND c.Active
      WHERE p.BusinessID = ? AND p.Active AND NOT p.IsGiftCard ORDER BY p.Name`,
    [k.BusinessID]);
  const [variants] = await pool.query(
    `SELECT v.VariantID AS id, v.ProductID AS productId, v.Name AS name, v.Price AS price,
            EXISTS (SELECT 1 FROM VariantRecipe r WHERE r.VariantID = v.VariantID)
            AND NOT EXISTS (SELECT 1 FROM VariantRecipe vr LEFT JOIN Inventory i ON i.StockItemID = vr.StockItemID AND i.LocationID = ?
                             WHERE vr.VariantID = v.VariantID AND COALESCE(i.Quantity, 0) < vr.QuantityPerUnit) AS available
       FROM ProductVariant v JOIN Product p ON p.ProductID = v.ProductID
      WHERE v.BusinessID = ? AND v.Active AND p.Active AND NOT p.IsGiftCard ORDER BY v.Price`,
    [k.LocationID, k.BusinessID]);
  const [groups] = await pool.query(
    `SELECT pmg.ProductID AS productId, g.ModifierGroupID AS id, g.Name AS name, g.MinSelect AS min, g.MaxSelect AS max,
            m.ModifierID AS modId, m.Name AS modName, m.PriceDelta AS delta
       FROM ProductModifierGroup pmg
       JOIN ModifierGroup g ON g.ModifierGroupID = pmg.ModifierGroupID AND g.Active
       JOIN Modifier m ON m.ModifierGroupID = g.ModifierGroupID AND m.Active
      WHERE pmg.BusinessID = ? ORDER BY pmg.SortOrder, g.Name, m.PriceDelta, m.Name`,
    [k.BusinessID]);

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

// Phone-number sign-in. Only the phone is needed, so the limiter below stops guessing numbers.
const loginLimit = require("./ratelimit")(20, 60 * 1000);
router.post("/customer/login", loginLimit, async (req, res) => {
  const k = await kiosk();
  const digits = String(req.body.phone || "").replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return res.status(400).json({ error: "Enter a 10-digit phone number." });
  const [[c]] = await pool.query(
    `SELECT c.CustomerID AS id FROM Customer c
      WHERE c.BusinessID = ? AND c.Active AND RIGHT(REGEXP_REPLACE(c.Phone, '[^0-9]', ''), 10) = ?
      ORDER BY c.CustomerID LIMIT 1`,
    [k.BusinessID, digits]);
  if (!c) return res.status(404).json({ error: "We don't have an account for that number. Continue as a guest, or ask a team member." });
  signIn(res, c.id);
  res.json(await me(c.id));
});

router.post("/customer/logout", (req, res) => {
  const token = tokenOf(req);
  if (token) sessions.delete(token);
  res.clearCookie("customer_session");
  res.json({ ok: true });
});

// Who is signed in on this iPad, with points read live from the ledger
async function me(customerId) {
  const [[c]] = await pool.query(
    `SELECT c.FirstName AS firstName, c.Phone AS phone, t.Name AS tier, la.LoyaltyAccountID AS account,
            COALESCE((SELECT SUM(lt.PointsChange) FROM LoyaltyTransaction lt WHERE lt.LoyaltyAccountID = la.LoyaltyAccountID), 0) AS points
       FROM Customer c
       LEFT JOIN LoyaltyAccount la ON la.CustomerID = c.CustomerID AND la.Active
       LEFT JOIN MembershipTier t ON t.TierID = la.TierID
      WHERE c.CustomerID = ?`, [customerId]);
  return {
    firstName: c.firstName || "there",
    maskedPhone: c.phone ? `(***) ***-${String(c.phone).replace(/\D/g, "").slice(-4)}` : null,
    member: !!c.account,
    points: c.account ? Number(c.points) : null,
    tier: c.tier || null,
  };
}

router.get("/customer/session", async (req, res) => {
  const s = currentCustomer(req);
  if (!s) return res.json({ signedIn: false });
  res.json({ signedIn: true, ...(await me(s.customerId)) });
});

// Only the lines reach the pricer: a customer can't send their own promotion or discount (those need staff approval)
const cartOf = (body) => ({ items: Array.isArray(body.items) ? body.items.map((i) => ({ key: i.key, variantId: i.variantId, quantity: i.quantity, modifierIds: i.modifierIds })) : [] });

// Prices a cart on the server. The browser's totals are only a preview; the server's numbers are what get charged.
router.post("/customer/price", async (req, res) => {
  const k = await kiosk();
  const p = await priceCart(pool, { businessId: k.BusinessID, locationId: k.LocationID }, cartOf(req.body));
  res.json({ subtotalCents: p.subtotalCents, taxCents: p.taxCents, totalCents: p.totalCents });
});

// Orders are submitted once per idempotencyKey: a retry with the same key and body gets the first receipt back.
// shortcut: remembered in memory per process; a retry after a restart could create a second order.
const submitted = new Map();
router.post("/customer/orders", async (req, res) => {
  const key = String(req.body.idempotencyKey || "");
  const body = JSON.stringify({ ...req.body, idempotencyKey: undefined });
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

// Customer orders wait for payment at the counter: they go in as PENDING_PAYMENT and are not paid here.
async function placeOrder(req) {
  const k = await kiosk();
  const s = currentCustomer(req);
  const customerId = s?.customerId || null;
  const payWith = String(req.body.paymentMethod || "");
  if (!["Cash", "Card", "Apple Pay", "Google Pay"].includes(payWith)) throw new HttpError(400, "Choose how you'll pay at the counter.");
  const name = customerId ? null : String(req.body.guestName || "").trim().slice(0, 50);
  if (!customerId && !name) throw new HttpError(400, "Enter a name for the order.");
  const note = String(req.body.note || "").trim().slice(0, 120);
  const priced = await priceCart(pool, { businessId: k.BusinessID, locationId: k.LocationID }, cartOf(req.body));
  // shortcut: promotionId and discount are not accepted from customers; staff-only pricing features are stripped by cartOf

  return pool.tx(async (conn) => {
    const orderId = crypto.randomUUID();
    // KIOSK (3) has no staffed register and is independent of online ordering.
    // The note holds the name and payment choice, as the schema has no columns for them
    const customerNote = [name && `Name: ${name}`, `Pay at counter: ${payWith}`, note].filter(Boolean).join(" | ");
    await conn.query(
      `INSERT INTO Orders (OrderID, LocationID, BusinessID, RegisterID, EmployeeID, CustomerID, ChannelCode, CustomerNote)
       VALUES (?, ?, ?, NULL, NULL, ?, 3, ?)`,
      [orderId, k.LocationID, k.BusinessID, customerId, customerNote]);

    const takeStock = new Map();
    for (const l of priced.lines) {
      const itemId = crypto.randomUUID();
      await conn.query(
        `INSERT INTO OrderItem (OrderItemID, OrderID, VariantID, BusinessID, Quantity, UnitPrice, LineTotal,
                                DiscountAmount, TaxCategoryID, TaxRate, TaxAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [itemId, orderId, l.variantId, k.BusinessID, l.quantity, dollars(l.unitCents), dollars(l.lineCents),
         l.taxCategoryId, l.rate, dollars(l.taxCents)]);
      for (const m of l.modifiers)
        await conn.query("INSERT INTO OrderItemModifier (OrderItemID, ModifierID, BusinessID, PriceDelta) VALUES (?, ?, ?, ?)",
          [itemId, m.id, k.BusinessID, dollars(m.deltaCents)]);

      // Stock and cost come from the same inventory tables the register uses
      const used = await components(conn, l);
      if (!used.length) continue;
      const [costs] = await conn.query(
        `SELECT i.StockItemID, i.AverageUnitCost, s.StockUnitCode FROM Inventory i JOIN StockItem s ON s.StockItemID = i.StockItemID
          WHERE i.LocationID = ? AND i.StockItemID IN (?)`, [k.LocationID, used.map(([id]) => id)]);
      for (const [stockItemId, t] of used) {
        const c = costs.find((x) => x.StockItemID === stockItemId);
        if (!c || c.AverageUnitCost == null) throw new HttpError(409, `${l.productName} can't be ordered right now.`);
        await conn.query(
          `INSERT INTO OrderItemComponent (OrderItemID, StockItemID, BusinessID, QuantityUsed, StockUnitCode, UnitCost)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [itemId, stockItemId, k.BusinessID, (t / 1000).toFixed(3), c.StockUnitCode, c.AverageUnitCost]);
        takeStock.set(stockItemId, { t: (takeStock.get(stockItemId)?.t || 0) + t, cost: c.AverageUnitCost });
      }
      await conn.query(
        `UPDATE OrderItem oi SET oi.UnitCost = (SELECT ROUND(SUM(c.QuantityUsed * c.UnitCost) / oi.Quantity, 6)
                                                  FROM OrderItemComponent c WHERE c.OrderItemID = oi.OrderItemID),
                                 oi.LineCost = ROUND(oi.Quantity * oi.UnitCost, 6)
          WHERE oi.OrderItemID = ?`, [itemId]);
    }
    for (const [stockItemId, { t, cost }] of takeStock)
      await conn.query(
        `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                           QuantityChange, UnitCost, TransactionTypeCode, OrderID)
         VALUES (UUID(), ?, ?, ?, NULL, ?, ?, 2, ?)`,
        [k.BusinessID, stockItemId, k.LocationID, (-t / 1000).toFixed(3), cost, orderId]);

    await conn.query("UPDATE Orders SET Subtotal = ?, Tax = ?, Total = ? WHERE OrderID = ?",
      [dollars(priced.subtotalCents), dollars(priced.taxCents), dollars(priced.totalCents), orderId]);
    await conn.query(
      "INSERT INTO OrderStatusHistory (OrderStatusHistoryID, OrderID, BusinessID, OrderStatusCode, ChangedAt) VALUES (UUID(), ?, ?, 1, UTC_TIMESTAMP())",
      [orderId, k.BusinessID]);
    const [[o]] = await conn.query("SELECT OrderNumber FROM Orders WHERE OrderID = ?", [orderId]);
    return { orderId, orderNumber: o.OrderNumber, totalCents: priced.totalCents };
  }).then((receipt) => { notify(k.LocationID); return receipt; });
}

// One order. Signed in: only that customer's own orders. Guest: only guest orders, found by their unguessable id.
router.get("/customer/orders/:id", async (req, res) => {
  const s = currentCustomer(req);
  const [[o]] = await pool.query(
    `SELECT o.OrderID AS id, o.OrderNumber AS orderNumber, o.OrderDateTime AS placedAt, o.Total AS total,
            o.CustomerNote AS note, o.OrderStatusCode AS statusCode, st.Description AS status, l.TimeZone AS tz
       FROM Orders o JOIN OrderStatus st ON st.OrderStatusCode = o.OrderStatusCode JOIN Location l ON l.LocationID = o.LocationID
      WHERE o.OrderID = ? AND o.ChannelCode IN (2, 3) AND (o.CustomerID <=> ?)`,
    [String(req.params.id), s ? s.customerId : null]);
  if (!o) throw new HttpError(404, "No such order.");
  const [items] = await pool.query(
    `SELECT oi.Quantity AS qty, oi.LineTotal AS line, p.Name AS product, v.Name AS size,
            (SELECT COUNT(*) FROM ProductVariant x WHERE x.ProductID = p.ProductID AND x.Active) > 1 AS sized
       FROM OrderItem oi JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID
      WHERE oi.OrderID = ? ORDER BY oi.OrderItemID`, [o.id]);
  res.json({
    id: o.id, orderNumber: o.orderNumber, placedAt: o.placedAt, tz: o.tz, total: Number(o.total),
    status: statusLabel(o.status), statusCode: o.statusCode,
    items: items.map((i) => ({ name: i.sized ? `${i.product}, ${i.size}` : i.product, qty: Number(i.qty), lineTotal: Number(i.line) })),
  });
});

// Signed-in customer's own orders, newest first
router.get("/customer/my-orders", async (req, res) => {
  const s = currentCustomer(req);
  if (!s) return res.status(401).json({ error: "Sign in to see your orders." });
  const [rows] = await pool.query(
    `SELECT o.OrderID AS id, o.OrderNumber AS orderNumber, o.OrderDateTime AS placedAt, o.Total AS total,
            st.Description AS status, l.TimeZone AS tz,
            COALESCE((SELECT SUM(lt.PointsChange) FROM LoyaltyTransaction lt
                       WHERE lt.OrderID = o.OrderID AND lt.LoyaltyTransactionTypeCode = 1), 0) AS earned
       FROM Orders o JOIN OrderStatus st ON st.OrderStatusCode = o.OrderStatusCode JOIN Location l ON l.LocationID = o.LocationID
      WHERE o.CustomerID = ? AND o.ChannelCode IN (2, 3) ORDER BY o.OrderDateTime DESC LIMIT 50`, [s.customerId]);
  res.json({
    orders: rows.map((o) => ({ id: o.id, orderNumber: o.orderNumber, placedAt: o.placedAt, tz: o.tz,
      total: Number(o.total), status: statusLabel(o.status), earned: Number(o.earned) })),
  });
});

module.exports = router;
