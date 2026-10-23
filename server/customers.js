// Customer kiosk API. Mounted before the employee session check, so it never needs a staff sign-in.
// Auth is phone-number only, as the owner chose: anyone who knows a customer's phone can open their history
// on this device. Accepted for a counter kiosk where the customer is present.
const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { priceCart, cents, dollars } = require("./pricing");
const { notify } = require("./kitchen");
const { addOrderLines, fingerprint } = require("./orderlines");
const { charge } = require("./mockpay");
const path = require("path");
const { label } = require("./labels");

const router = express.Router();

// shortcut: customer sessions are in memory; a restart signs customers out. Move to a table for several servers.
const sessions = new Map();
const SESSION_MS = 2 * 60 * 60 * 1000;
// A shared iPad: the page signs the customer out after 2 minutes of no touches (public/js/customer.js), and the server
// ends the session itself after 5, in case the page was closed. Only POST /customer/touch counts, not pages polling.
const IDLE_MS = 5 * 60 * 1000;
const tokenOf = (req) => /(?:^|;\s*)customer_session=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1];

function signIn(res, customerId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { customerId, expires: Date.now() + SESSION_MS, active: Date.now() });
  res.cookie("customer_session", token, { httpOnly: true, sameSite: "strict", maxAge: SESSION_MS, secure: process.env.COOKIE_SECURE === "1" });
}

function currentCustomer(req) {
  const token = tokenOf(req);
  const s = token && sessions.get(token);
  if (!s) return null;
  if (over(s)) { sessions.delete(token); return null; }
  return s;
}

const over = (s) => s.expires < Date.now() || Date.now() - s.active >= IDLE_MS;
setInterval(() => {
  for (const [token, s] of sessions) if (over(s)) sessions.delete(token);
}, 60 * 60 * 1000).unref();

// The business and location this iPad is set up for: KIOSK_LOCATION_ID. Without it, only a database with a single
// active location can say, so a second café can't have its orders silently go to the first.
async function kiosk() {
  const id = process.env.KIOSK_LOCATION_ID;
  const [rows] = await pool.query(
    `SELECT l.LocationID, l.BusinessID, l.Name AS locationName, b.Name AS businessName, r.RegisterID
       FROM Location l JOIN Business b ON b.BusinessID = l.BusinessID
       LEFT JOIN Register r ON r.LocationID = l.LocationID AND r.RegStatusCode = 1
      WHERE l.Active ${id ? "AND l.LocationID = ?" : ""} ORDER BY l.Name, r.Name`, id ? [id] : []);
  const k = rows[0];
  if (!k) throw new HttpError(503, "This kiosk has no location set up yet.");
  if (!id && rows.some((r) => r.LocationID !== k.LocationID)) throw new HttpError(503, "This kiosk doesn't know which café it is in. Set KIOSK_LOCATION_ID.");
  return k;
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
  res.json({ businessName: k.businessName, locationName: k.locationName, phoneSignIn: !req.publicKiosk });
});

// A product's picture, for the kiosk page (the staff route needs a staff sign-in). Only products on sale here.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "../uploads");
router.get("/customer/products/:id/photo", async (req, res) => {
  const k = await kiosk();
  const [[p]] = await pool.query("SELECT ImageKey FROM Product WHERE ProductID = ? AND BusinessID = ? AND Active AND NOT IsGiftCard AND ImageKey IS NOT NULL",
    [String(req.params.id), k.BusinessID]);
  if (!p) throw new HttpError(404, "No photo.");
  res.sendFile(path.resolve(UPLOAD_DIR, p.ImageKey), (err) => { if (err && !res.headersSent) res.status(404).json({ error: "No photo." }); });
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
  if (req.publicKiosk) throw new HttpError(403, "Phone sign-in isn't available on this address. Continue as a guest.");
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

// The page calls this when the customer touches it, which restarts the idle clock
router.post("/customer/touch", (req, res) => {
  const s = currentCustomer(req);
  if (s) s.active = Date.now();
  res.json({});
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
// The key counts only for the address that sent it, so nobody else can ask for someone's receipt back.
const submitted = new Map();
// Nothing is paid yet but stock is already taken, so a script must not be able to place orders without end.
// shortcut: this only slows it down; stock should be taken when the order is paid, not when it is placed.
const orderLimit = require("./ratelimit")(20, 60 * 1000);
router.resetOrderLimit = orderLimit.reset;
router.post("/customer/orders", orderLimit, async (req, res) => {
  const key = req.body.idempotencyKey ? `${req.ip}|${req.body.idempotencyKey}` : "";
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

// Paying here is a mock payment (server/mockpay.js): the order is paid and confirmed at once, and goes to the kitchen.
// Cash waits for the counter: that order goes in as PENDING_PAYMENT, and nothing on the staff side takes the payment yet.
const PAID_HERE = { "Card": [2, "card"], "Apple Pay": [5, "apple"], "Google Pay": [6, "google"] }; // payment method code, mock kind
async function placeOrder(req) {
  const k = await kiosk();
  const s = currentCustomer(req);
  const customerId = s?.customerId || null;
  const payWith = String(req.body.paymentMethod || "");
  if (payWith !== "Cash" && !PAID_HERE[payWith]) throw new HttpError(400, "Choose how you'll pay.");
  const paidHere = PAID_HERE[payWith];
  const name = customerId ? null : String(req.body.guestName || "").trim().slice(0, 50);
  if (!customerId && !name) throw new HttpError(400, "Enter a name for the order.");
  const note = String(req.body.note || "").trim().slice(0, 120);
  const priced = await priceCart(pool, { businessId: k.BusinessID, locationId: k.LocationID }, cartOf(req.body));
  // shortcut: promotionId and discount are not accepted from customers; staff-only pricing features are stripped by cartOf
  if (paidHere && priced.totalCents > 0) charge(paidHere[1], req.body.card); // before the order exists, so a decline leaves nothing behind

  return pool.tx(async (conn) => {
    const orderId = crypto.randomUUID();
    // KIOSK (3) has no staffed register and is independent of online ordering.
    // The note holds the name and payment choice, as the schema has no columns for them
    const customerNote = [name && `Name: ${name}`, paidHere ? `Paid: ${payWith}` : `Pay at counter: ${payWith}`, note].filter(Boolean).join(" | ");
    await conn.query(
      `INSERT INTO Orders (OrderID, LocationID, BusinessID, RegisterID, EmployeeID, CustomerID, ChannelCode, CustomerNote)
       VALUES (?, ?, ?, NULL, NULL, ?, 3, ?)`,
      [orderId, k.LocationID, k.BusinessID, customerId, customerNote]);

    await addOrderLines(conn, { orderId, businessId: k.BusinessID, locationId: k.LocationID, employeeId: null, priced,
      unavailable: (l) => `${l.productName} can't be ordered right now.` });

    await conn.query("UPDATE Orders SET Subtotal = ?, Tax = ?, Total = ? WHERE OrderID = ?",
      [dollars(priced.subtotalCents), dollars(priced.taxCents), dollars(priced.totalCents), orderId]);
    const history = (status) => conn.query(
      "INSERT INTO OrderStatusHistory (OrderStatusHistoryID, OrderID, BusinessID, OrderStatusCode, ChangedAt) VALUES (UUID(), ?, ?, ?, UTC_TIMESTAMP())",
      [orderId, k.BusinessID, status]);
    await history(1);
    if (paidHere) {
      if (priced.totalCents > 0)
        await conn.query(
          "INSERT INTO Payment (PaymentID, OrderID, PaymentMethodCode, Amount, PaymentStatusCode) VALUES (UUID(), ?, ?, ?, 3)",
          [orderId, paidHere[0], dollars(priced.totalCents)]);
      await conn.query("UPDATE Orders SET OrderStatusCode = 2 WHERE OrderID = ?", [orderId]);
      await history(2);
    }
    const [[o]] = await conn.query("SELECT OrderNumber FROM Orders WHERE OrderID = ?", [orderId]);
    return { orderId, orderNumber: o.OrderNumber, totalCents: priced.totalCents, paid: !!paidHere };
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
