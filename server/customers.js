// Customer kiosk API. Mounted before the employee session check, so it never needs a staff sign-in.
// Auth is phone-number only, as the owner chose: anyone who knows a customer's phone can open their history
// on this device. Accepted for a counter kiosk where the customer is present.
const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { priceCart, cents, dollars } = require("./pricing");
const { notify } = require("./watchers");
const { addOrderLines, fingerprint } = require("./orderlines");
const { charge } = require("./mockpay");
const path = require("path");
const { label } = require("./labels");
const check = require("./validate");
const rateLimit = require("./ratelimit");
const device = require("./device");

const router = express.Router();
router.use("/customer", device); // a cookie that tells phones on one wifi apart

// shortcut: customer sessions are in memory; a restart signs customers out. Move to a table for several servers.
const sessions = new Map();
const SESSION_MS = 2 * 60 * 60 * 1000;
// KIOSK_SHARED_DEVICE=1 is a screen several people use (an iPad at the counter): the page signs the customer out after 2 minutes
// of no touches (public/js/customer.js), and the server ends the session itself after 5, in case the page was closed. Only
// POST /customer/touch counts, not pages polling. Otherwise each customer has their own phone and stays signed in.
const shared = () => process.env.KIOSK_SHARED_DEVICE === "1";
const idleMs = () => (shared() ? 5 * 60 * 1000 : SESSION_MS);
const tokenOf = (req) => /(?:^|;\s*)customer_session=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1];

// A sign-in belongs to the business of the café it was made at: at another business's café the phone is a guest there
function signIn(req, res, customerId, businessId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { customerId, businessId, expires: Date.now() + SESSION_MS, active: Date.now() });
  res.cookie("customer_session", token, { httpOnly: true, sameSite: "strict", maxAge: SESSION_MS, secure: process.env.COOKIE_SECURE === "1" || req.secure }); // req.secure: behind the HTTPS proxy
}

function currentCustomer(req, businessId) {
  const token = tokenOf(req);
  const s = token && sessions.get(token);
  if (!s) return null;
  if (over(s)) { sessions.delete(token); return null; }
  return businessId && s.businessId !== businessId ? null : s;
}

const over = (s) => s.expires < Date.now() || Date.now() - s.active >= idleMs();
setInterval(() => {
  for (const [token, s] of sessions) if (over(s)) sessions.delete(token);
}, 60 * 60 * 1000).unref();

// A small memory for lookups that rarely change (a café): each answer is kept for ms. shortcut: per process, so a
// change in Settings shows within a few seconds, not at once.
const memos = [];
function memo(ms, fn) {
  const kept = new Map();
  const get = (key) => {
    const e = kept.get(key);
    if (e && e.until > Date.now()) return e.value;
    const value = fn(key);
    kept.set(key, { value, until: Date.now() + ms });
    value.catch(() => kept.delete(key)); // a refusal isn't kept
    return value;
  };
  get.reset = () => kept.clear();
  memos.push(get);
  return get;
}
router.resetCaches = () => memos.forEach((m) => m.reset());

// The café a phone is ordering at: its x-location-id header, from the café's QR code (/order/<locationId>). The café decides the
// business, so several businesses share this server: an active café of an active business, or nothing.
const SCAN = "Scan your café's QR code to order.";
const placeAt = memo(5 * 1000, async (locationId) => {
  if (!locationId) throw new HttpError(404, SCAN);
  const [rows] = await pool.query(
    `SELECT l.LocationID, l.BusinessID, l.Name AS locationName, b.Name AS businessName, r.RegisterID
       FROM Location l JOIN Business b ON b.BusinessID = l.BusinessID AND b.Active
       LEFT JOIN Register r ON r.LocationID = l.LocationID AND r.RegStatusCode = 1
      WHERE l.LocationID = ? AND l.Active ORDER BY r.Name LIMIT 1`, [locationId]);
  if (!rows[0]) throw new HttpError(404, "This café link isn't valid. Scan the QR code in the café again.");
  return rows[0];
});
const place = (req) => placeAt(String(req.get("x-location-id") || ""));
router.SCAN = SCAN;

// Customer-facing wording for the database's statuses. Customers never change these.
const CUSTOMER_STATUS = {
  PENDING_PAYMENT: "Received", CONFIRMED: "Confirmed", PREPARING: "Preparing",
  READY: "Ready for pickup", COMPLETED: "Picked up", CANCELLED: "Cancelled", REFUNDED: "Refunded",
};
const statusLabel = (description) => CUSTOMER_STATUS[description] || label(description);

// Routes 

router.get("/customer/context", async (req, res) => {
  const k = await place(req);
  res.json({ businessName: k.businessName, locationName: k.locationName, phoneSignIn: !req.noPhoneSignIn, payHere: mockPay(), sharedDevice: shared() });
});

// A product's picture, for the kiosk page (the staff route needs a staff sign-in). Only products on sale here.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "../uploads");
router.get("/customer/products/:id/photo", async (req, res) => {
  // an <img> can't send the café header: any product on sale at an active business, which is what its menu shows anyway
  const [[p]] = await pool.query(
    `SELECT p.ImageKey FROM Product p JOIN Business b ON b.BusinessID = p.BusinessID AND b.Active
      WHERE p.ProductID = ? AND p.Active AND NOT p.IsGiftCard AND p.ImageKey IS NOT NULL`, [String(req.params.id)]);
  if (!p) throw new HttpError(404, "No photo.");
  // kept by the phone for 5 minutes, so a menu of pictures is fetched once; a replaced picture shows within that time
  res.sendFile(path.resolve(UPLOAD_DIR, p.ImageKey), { maxAge: "5m" }, (err) => { if (err && !res.headersSent) res.status(404).json({ error: "No photo." }); });
});

// Products for sale here, with their variants (sizes) and modifier groups (milk, extras)
// Kept 5 seconds per café, because every phone loads it: stock shown may lag by that long, but an order still checks stock itself.
const catalogOf = memo(5 * 1000, async (key) => {
  const [businessId, locationId] = JSON.parse(key);
  const k = { BusinessID: businessId, LocationID: locationId };
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
  return { products, categories: [...new Set(products.map((p) => p.category))].sort() };
});
router.get("/customer/catalog", async (req, res) => {
  const k = await place(req);
  res.json(await catalogOf(JSON.stringify([k.BusinessID, k.LocationID])));
});

// Phone-number sign-in. Only the phone is needed, so the limits stop guessing numbers: per phone, and per address for a script
// that drops its cookie.
const loginLimits = [rateLimit(60, 60 * 1000), rateLimit(10, 60 * 1000, { by: "device" })];
router.post("/customer/login", loginLimits, async (req, res) => {
  if (req.noPhoneSignIn) throw new HttpError(403, "Phone sign-in isn't available on this address. Continue as a guest.");
  const k = await place(req);
  const digits = check.phoneDigits(req.body.phone);
  if (!digits) return res.status(400).json({ error: "Enter a valid 10-digit US phone number." });
  const [[c]] = await pool.query(
    `SELECT c.CustomerID AS id FROM Customer c
      WHERE c.BusinessID = ? AND c.Active AND c.PhoneDigits = ?
      ORDER BY c.CustomerID LIMIT 1`,
    [k.BusinessID, digits]);
  if (!c) return res.status(404).json({ error: "We don't have an account for that number. Continue as a guest, or ask a team member." });
  signIn(req, res, c.id, k.BusinessID);
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
  const s = currentCustomer(req, (await place(req)).BusinessID);
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
  const k = await place(req);
  const p = await priceCart(pool, { businessId: k.BusinessID, locationId: k.LocationID }, cartOf(req.body));
  res.json({ subtotalCents: p.subtotalCents, taxCents: p.taxCents, totalCents: p.totalCents });
});

// Orders are submitted once per idempotencyKey: a retry with the same key and body gets the first receipt back.
// shortcut: remembered in memory per process; a retry after a restart could create a second order.
// The key counts only for the phone that sent it (its device cookie), so nobody else can ask for someone's receipt back.
const submitted = new Map();
// Nothing is paid yet but stock is already taken, so a script must not be able to place orders without end.
// Unpaid orders are cancelled after HOLD_MINUTES (server/kioskorders.js), which puts their stock back.
// A café's phones share one address, so a rush is allowed 60 orders a minute there, but one phone only 5.
const orderLimits = [rateLimit(60, 60 * 1000), rateLimit(5, 60 * 1000, { by: "device" })];
router.resetOrderLimit = () => [...orderLimits, ...loginLimits].forEach((l) => l.reset());
router.post("/customer/orders", orderLimits, async (req, res) => {
  const key = req.body.idempotencyKey ? `${req.device}|${req.body.idempotencyKey}` : "";
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
// Cash waits for the counter: that order goes in as PENDING_PAYMENT holding its stock, until the register takes the payment or
// cancels it, or it goes unpaid for HOLD_MINUTES (server/kioskorders.js).
const PAID_HERE = { "Card": [2, "card"], "Apple Pay": [5, "apple"], "Google Pay": [6, "google"] }; // payment method code, mock kind
// The mock takes no money, so it is offered only when MOCK_PAY=1 (development); without it the public page offers Cash only
const mockPay = () => process.env.MOCK_PAY === "1";
const UNPAID_MAX_ITEMS = 20; // an unpaid order holds stock, so one can't take a whole shelf
async function placeOrder(req) {
  const k = await place(req);
  const s = currentCustomer(req, k.BusinessID);
  const customerId = s?.customerId || null;
  const payWith = String(req.body.paymentMethod || "");
  const paidHere = mockPay() ? PAID_HERE[payWith] : null;
  if (payWith !== "Cash" && !paidHere) throw new HttpError(400, "Choose how you'll pay.");
  const name = customerId ? null : check.personName(req.body.guestName, "name for the order");
  const note = check.note(req.body.note, "note", 120);
  const priced = await priceCart(pool, { businessId: k.BusinessID, locationId: k.LocationID }, cartOf(req.body));
  // shortcut: promotionId and discount are not accepted from customers; staff-only pricing features are stripped by cartOf
  if (!paidHere && priced.lines.reduce((n, l) => n + l.quantity, 0) > UNPAID_MAX_ITEMS)
    throw new HttpError(400, `A pay-at-counter order can have up to ${UNPAID_MAX_ITEMS} items. For more, order at the counter.`);

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
    // Unpaid orders together may hold at most half of each stock item: what they hold can't exceed what is still on the shelf
    // shortcut: a plain read, so orders placed at the same instant can pass together; bounded by the order rate limits
    if (!paidHere) {
      const [over] = await conn.query(
        `SELECT c.StockItemID FROM OrderItemComponent c JOIN OrderItem oi ON oi.OrderItemID = c.OrderItemID
           JOIN Orders o ON o.OrderID = oi.OrderID
           JOIN Inventory i ON i.LocationID = o.LocationID AND i.StockItemID = c.StockItemID
          WHERE o.LocationID = ? AND o.ChannelCode = 3 AND o.OrderStatusCode = 1
            AND c.StockItemID IN (SELECT x.StockItemID FROM OrderItemComponent x JOIN OrderItem y ON y.OrderItemID = x.OrderItemID WHERE y.OrderID = ?)
          GROUP BY c.StockItemID, i.Quantity HAVING SUM(c.QuantityUsed) > i.Quantity`,
        [k.LocationID, orderId]);
      if (over.length) throw new HttpError(409, "Too many orders are waiting to be paid right now. Please order at the counter.");
    }

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
    // Charged last, after every write that can still fail: a decline rolls the order back, and nothing after it can fail.
    // shortcut: a deadlock reruns this, charging again; harmless for the mock, a real processor needs an idempotency key
    if (paidHere && priced.totalCents > 0) charge(paidHere[1], req.body.card);
    return { orderId, orderNumber: o.OrderNumber, totalCents: priced.totalCents, paid: !!paidHere };
  }).then((receipt) => { notify(k.LocationID); return receipt; });
}

// One order. Signed in: only that customer's own orders. Guest: only guest orders, found by their unguessable id.
router.get("/customer/orders/:id", async (req, res) => {
  const s = currentCustomer(req, (await place(req)).BusinessID);
  const [[o]] = await pool.query(
    `SELECT o.OrderID AS id, o.OrderNumber AS orderNumber, o.OrderDateTime AS placedAt, o.Total AS total,
            o.CompletedAt AS completedAt, o.CustomerNote AS note, o.OrderStatusCode AS statusCode, st.Description AS status, l.TimeZone AS tz
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
    status: statusLabel(o.status), statusCode: o.statusCode, completedAt: o.completedAt,
    items: items.map((i) => ({ name: i.sized ? `${i.product}, ${i.size}` : i.product, qty: Number(i.qty), lineTotal: Number(i.line) })),
  });
});

// Signed-in customer's own orders, newest first
router.get("/customer/my-orders", async (req, res) => {
  const s = currentCustomer(req, (await place(req)).BusinessID);
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
