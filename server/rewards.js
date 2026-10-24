const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { requirePermission } = require("./session");
const { hasPermission } = require("./pin");
const { label } = require("./labels");
const check = require("./validate");

const PERM_LOOK_UP = 9; // look up and enroll members
const PERM_EDIT = 10; // edit and deactivate members
const EARN = 1, REDEEM = 2, ADJUST = 3;
const PENDING_PAYMENT = 1, CANCELLED = 6, REFUNDED = 7;
const REFUND_PENDING = 1, REFUND_DONE = 2;
const LIMIT = 100;

const router = express.Router();
router.use("/rewards", requirePermission(PERM_LOOK_UP));

const cents = (n) => Math.round(Number(n) * 100);
const nameOf = (c) => [c.firstName, c.lastName].filter(Boolean).join(" ");
const digitsOf = (s) => String(s || "").replace(/\D/g, "");
// LIKE matches the text as typed: its own wildcards are escaped
const like = (s) => `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
// Phones are saved as 312-555-0142 but may have been typed any way before, so they are compared by their last 10 digits
const PHONE_DIGITS = "c.PhoneDigits";
const POINTS = "COALESCE((SELECT SUM(lt.PointsChange) FROM LoyaltyTransaction lt WHERE lt.LoyaltyAccountID = la.LoyaltyAccountID), 0)";

// A member is a customer with a loyalty account; deactivating one switches off the account, not the customer
const MEMBER = `SELECT c.CustomerID AS id, c.FirstName AS firstName, c.LastName AS lastName, c.Email AS email, c.Phone AS phone,
                       t.Name AS tier, la.Active AS active, la.EnrolledAt AS enrolledAt, ${POINTS} AS points
                  FROM Customer c JOIN LoyaltyAccount la ON la.CustomerID = c.CustomerID JOIN MembershipTier t ON t.TierID = la.TierID`;
const member = (m) => ({ id: m.id, firstName: m.firstName || "", lastName: m.lastName || "", email: m.email, phone: m.phone,
  tier: m.tier, points: Number(m.points), active: !!m.active });

async function findMember(businessId, id) {
  const [[m]] = await pool.query(`${MEMBER} WHERE c.CustomerID = ? AND c.BusinessID = ?`, [String(id), businessId]);
  if (!m) throw new HttpError(404, "Member not found.");
  return m;
}

// The list, searched on the server: part of a name, an email, or the digits of a phone. Inactive members only on request.
router.get("/rewards/members", async (req, res) => {
  const { businessId, employeeId } = req.session;
  const q = String(req.query.q || "").trim().slice(0, 100);
  const digits = digitsOf(q);
  const where = ["c.BusinessID = ?"];
  const args = [businessId];
  if (req.query.inactive !== "1") where.push("la.Active");
  if (q) {
    const or = ["CONCAT_WS(' ', c.FirstName, c.LastName) LIKE ?", "c.Email LIKE ?"];
    args.push(like(q), like(q));
    // a phone is searched by its digits, once there are enough of them to mean something
    if (digits.length >= 3) { or.push(`REGEXP_REPLACE(c.Phone, '[^0-9]', '') LIKE ?`); args.push(like(digits)); }
    where.push(`(${or.join(" OR ")})`);
  }
  const [rows] = await pool.query(`${MEMBER} WHERE ${where.join(" AND ")} ORDER BY c.LastName, c.FirstName, c.CustomerID LIMIT ?`, [...args, LIMIT + 1]);
  res.json({
    canEdit: await hasPermission(pool, employeeId, PERM_EDIT),
    more: rows.length > LIMIT,
    members: rows.slice(0, LIMIT).map(member),
  });
});

// One member's orders and points, newest first. Orders never paid for are left out; cancelled ones are listed but not
// counted. Points adjustments are rows of their own.
router.get("/rewards/members/:id", async (req, res) => {
  const { businessId, employeeId, locationId } = req.session;
  const m = await findMember(businessId, req.params.id);
  const [orders] = await pool.query(
    `SELECT o.OrderID AS id, o.OrderNumber AS number, o.OrderDateTime AS at, o.ChannelCode AS channel, o.OrderStatusCode AS status,
            o.Total AS total, l.TimeZone AS tz,
            COALESCE((SELECT SUM(oi.Quantity) FROM OrderItem oi WHERE oi.OrderID = o.OrderID), 0) AS items,
            COALESCE((SELECT SUM(r.Amount) FROM Refund r WHERE r.OrderID = o.OrderID AND r.RefundStatusCode = ?), 0) AS refunded,
            COALESCE((SELECT SUM(r.Amount) FROM Refund r WHERE r.OrderID = o.OrderID AND r.RefundStatusCode = ?), 0) AS pending
       FROM Orders o JOIN Location l ON l.LocationID = o.LocationID
      WHERE o.CustomerID = ? AND o.BusinessID = ? AND o.OrderStatusCode <> ?`,
    [REFUND_DONE, REFUND_PENDING, m.id, businessId, PENDING_PAYMENT]);
  const [points] = await pool.query(
    `SELECT lt.LoyaltyTransactionID AS id, lt.OrderID AS orderId, lt.LoyaltyTransactionTypeCode AS type, lt.PointsChange AS points,
            lt.TransactionDateTime AS at, o.OrderNumber AS number
       FROM LoyaltyTransaction lt JOIN LoyaltyAccount la ON la.LoyaltyAccountID = lt.LoyaltyAccountID
       LEFT JOIN Orders o ON o.OrderID = lt.OrderID
      WHERE la.CustomerID = ?`, [m.id]);
  const [[here]] = await pool.query("SELECT TimeZone AS tz FROM Location WHERE LocationID = ?", [locationId]);

  const sum = (orderId, type) => points.filter((p) => p.orderId === orderId && p.type === type).reduce((a, p) => a + p.points, 0);
  const paid = orders.filter((o) => o.status !== CANCELLED);
  const rows = [
    ...orders.map((o) => ({
      kind: "order",
      id: o.id,
      number: o.number,
      at: o.at,
      tz: o.tz,
      source: o.channel === 2 ? "Online" : "Register",
      items: Number(o.items),
      totalCents: cents(o.total),
      refundedCents: cents(o.refunded),
      pendingCents: cents(o.pending),
      state: o.status === CANCELLED ? "Cancelled" : o.status === REFUNDED ? "Refunded" : cents(o.refunded) > 0 ? "Partly refunded" : null,
      earned: sum(o.id, EARN),
      redeemed: -sum(o.id, REDEEM),
    })),
    ...points.filter((p) => p.type === ADJUST).map((p) => ({
      kind: "adjust", id: p.id, number: p.number, orderId: p.orderId, at: p.at, tz: here.tz,
      earned: Math.max(0, p.points), redeemed: Math.max(0, -p.points),
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  res.json({
    canEdit: await hasPermission(pool, employeeId, PERM_EDIT),
    tz: here.tz,
    member: { ...member(m), since: m.enrolledAt },
    orders: paid.length,
    spentCents: paid.reduce((a, o) => a + cents(o.total) - cents(o.refunded), 0),
    rows,
  });
});

// One order, for the View dialog: only an order of one of this business's members
router.get("/rewards/orders/:id", async (req, res) => {
  const { businessId } = req.session;
  const [[o]] = await pool.query(
    `SELECT o.OrderID AS id, o.OrderNumber AS number, o.OrderDateTime AS at, o.ChannelCode AS channel, os.Description AS status,
            o.Subtotal AS subtotal, o.DiscountAmount AS discount, o.Tax AS tax, o.Total AS total, o.PricesIncludeTax AS included,
            l.Name AS location, l.TimeZone AS tz, e.FirstName AS staff, c.CustomerID AS memberId
       FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN OrderStatus os ON os.OrderStatusCode = o.OrderStatusCode
       JOIN Customer c ON c.CustomerID = o.CustomerID JOIN LoyaltyAccount la ON la.CustomerID = c.CustomerID
       LEFT JOIN Employee e ON e.EmployeeID = o.EmployeeID
      WHERE o.OrderID = ? AND o.BusinessID = ?`, [String(req.params.id), businessId]);
  if (!o) throw new HttpError(404, "Order not found.");
  const [items] = await pool.query(
    `SELECT oi.OrderItemID AS id, oi.Quantity AS qty, oi.LineTotal AS line, oi.DiscountAmount AS discount, p.Name AS product, v.Name AS size,
            (SELECT COUNT(*) FROM ProductVariant x WHERE x.ProductID = p.ProductID) > 1 AS sized
       FROM OrderItem oi JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID
      WHERE oi.OrderID = ? ORDER BY oi.OrderItemID`, [o.id]);
  const [mods] = items.length
    ? await pool.query(
        `SELECT oim.OrderItemID AS itemId, m.Name AS name, oim.Quantity AS qty FROM OrderItemModifier oim JOIN Modifier m ON m.ModifierID = oim.ModifierID
          WHERE oim.OrderItemID IN (?) ORDER BY m.Name`, [items.map((i) => i.id)])
    : [[]];
  const [payments] = await pool.query(
    `SELECT pm.Description AS method, p.Amount AS amount, p.TipAmount AS tip, ps.Description AS status
       FROM Payment p JOIN PaymentMethod pm ON pm.PaymentMethodCode = p.PaymentMethodCode JOIN PaymentStatus ps ON ps.PaymentStatusCode = p.PaymentStatusCode
      WHERE p.OrderID = ? ORDER BY p.PaymentDateTime`, [o.id]);
  const [refunds] = await pool.query(
    `SELECT r.Amount AS amount, COALESCE(r.RefundDateTime, r.CreatedAt) AS at, r.Reason AS reason, rs.Description AS status
       FROM Refund r JOIN RefundStatus rs ON rs.RefundStatusCode = r.RefundStatusCode
      WHERE r.OrderID = ? AND r.RefundStatusCode <> 3 ORDER BY r.CreatedAt`, [o.id]);
  const [points] = await pool.query(
    `SELECT t.Description AS type, lt.PointsChange AS points FROM LoyaltyTransaction lt
       JOIN LoyaltyTransactionType t ON t.LoyaltyTransactionTypeCode = lt.LoyaltyTransactionTypeCode
      WHERE lt.OrderID = ? ORDER BY lt.TransactionDateTime`, [o.id]);

  res.json({
    number: o.number,
    at: o.at,
    tz: o.tz,
    location: o.location,
    source: o.channel === 2 ? "Online" : "Register",
    status: label(o.status),
    staff: o.staff,
    taxIncluded: !!o.included,
    lines: items.map((i) => ({
      qty: Number(i.qty),
      name: i.sized ? `${i.product} (${i.size})` : i.product,
      options: mods.filter((m) => m.itemId === i.id).map((m) => (m.qty > 1 ? `${m.qty} × ${m.name}` : m.name)),
      lineCents: cents(i.line),
      discountCents: cents(i.discount),
    })),
    subtotalCents: cents(o.subtotal),
    discountCents: cents(o.discount),
    taxCents: cents(o.tax),
    totalCents: cents(o.total),
    payments: payments.map((p) => ({ method: label(p.method), amountCents: cents(p.amount), tipCents: cents(p.tip), status: label(p.status) })),
    refunds: refunds.map((r) => ({ amountCents: cents(r.amount), at: r.at, reason: r.reason, status: label(r.status) })),
    points: points.map((p) => ({ type: label(p.type), points: p.points })),
  });
});

// Reads the form and lists every problem at once. Email is saved in lowercase, a phone as 312-555-0142.
function readForm(b) {
  const f = {
    firstName: String(b.firstName || "").trim(),
    lastName: String(b.lastName || "").trim(),
    email: String(b.email || "").trim().toLowerCase(),
    phone: String(b.phone || "").trim(),
  };
  const problems = [];
  f.firstName = check.collect(problems, () => check.personName(b.firstName, "first name")) ?? f.firstName;
  f.lastName = check.collect(problems, () => check.personName(b.lastName, "last name", { required: false })) ?? f.lastName;
  if (!f.email && !f.phone) problems.push("Enter an email or a phone number (at least one).");
  f.email = check.collect(problems, () => check.email(b.email)) ?? f.email;
  f.phone = check.collect(problems, () => check.phone(b.phone)) ?? f.phone;
  if (problems.length) throw new HttpError(400, problems.join(" "));
  f.email ||= null;
  f.phone ||= null;
  return f;
}

// The customers (members or not) already using this email or phone, other than the one being edited
async function holders(conn, businessId, f, exceptId = "") {
  const phone = digitsOf(f.phone) || "#"; // never matches, so no phone matches nobody
  const [rows] = await conn.query(
    `SELECT c.CustomerID AS id, c.FirstName AS firstName, c.LastName AS lastName, c.Email AS email, c.Phone AS phone,
            la.LoyaltyAccountID AS accountId, c.Email = ? AS sameEmail, ${PHONE_DIGITS} = ? AS samePhone
       FROM Customer c LEFT JOIN LoyaltyAccount la ON la.CustomerID = c.CustomerID
      WHERE c.BusinessID = ? AND c.CustomerID <> ? AND (c.Email = ? OR ${PHONE_DIGITS} = ?)`,
    [f.email, phone, businessId, exceptId, f.email, phone]);
  return rows;
}

const takenBy = (h) => {
  const what = h.sameEmail && h.samePhone ? "That email and phone are" : h.sameEmail ? "That email is" : "That phone number is";
  return `${what} already used by ${h.accountId ? "member" : "customer"} ${nameOf(h)}.`;
};

// Two people enrolling at once mustn't both take the same phone: the database doesn't make phones unique, so member
// changes in one business take turns. The lock belongs to the connection, so it is always given back.
async function oneAtATime(businessId, fn) {
  return pool.tx(async (conn) => {
    const [[got]] = await conn.query("SELECT GET_LOCK(?, 10) AS ok", [`siapos-members-${businessId}`]);
    if (!got.ok) throw new HttpError(503, "Members are being changed elsewhere. Try again.");
    try { return await fn(conn); }
    finally { await conn.query("SELECT RELEASE_LOCK(?)", [`siapos-members-${businessId}`]); }
  });
}

// Enroll: a new customer and their account, or an account for a customer already on file with this email or phone.
// New members start in the lowest tier.
router.post("/rewards/members", async (req, res) => {
  const { businessId } = req.session;
  const f = readForm(req.body);
  const out = await oneAtATime(businessId, async (conn) => {
    const [[tier]] = await conn.query("SELECT TierID AS id FROM MembershipTier WHERE BusinessID = ? ORDER BY MinimumPoints, Name LIMIT 1", [businessId]);
    if (!tier) throw new HttpError(409, "This business has no rewards tiers yet.");
    const found = await holders(conn, businessId, f);
    const ids = [...new Set(found.map((h) => h.id))];
    if (ids.length > 1) throw new HttpError(409, `That email belongs to ${nameOf(found.find((h) => h.sameEmail))} and that phone to ${nameOf(found.find((h) => !h.sameEmail))}. Check the details.`);
    const [h] = found;
    if (h?.accountId) throw new HttpError(409, takenBy(h));

    if (h) {
      // an existing customer keeps the details on file; a missing email or phone is filled in from the form
      await conn.query("UPDATE Customer SET Email = COALESCE(Email, ?), Phone = COALESCE(Phone, ?) WHERE CustomerID = ?", [f.email, f.phone, h.id]);
      await conn.query("INSERT INTO LoyaltyAccount (LoyaltyAccountID, CustomerID, TierID, BusinessID) VALUES (UUID(), ?, ?, ?)", [h.id, tier.id, businessId]);
      return { id: h.id, message: `${nameOf(h)} is already a customer; enrolled as a member.` };
    }
    const id = crypto.randomUUID();
    await conn.query("INSERT INTO Customer (CustomerID, BusinessID, FirstName, LastName, Email, Phone) VALUES (?, ?, ?, ?, ?, ?)",
      [id, businessId, f.firstName, f.lastName || null, f.email, f.phone]);
    await conn.query("INSERT INTO LoyaltyAccount (LoyaltyAccountID, CustomerID, TierID, BusinessID) VALUES (UUID(), ?, ?, ?)", [id, tier.id, businessId]);
    return { id, message: `Enrolled ${nameOf(f)}.` };
  });
  res.json(out);
});

router.post("/rewards/members/:id", requirePermission(PERM_EDIT), async (req, res) => {
  const { businessId } = req.session;
  const m = await findMember(businessId, req.params.id);
  const f = readForm(req.body);
  await oneAtATime(businessId, async (conn) => {
    const [h] = await holders(conn, businessId, f, m.id);
    if (h) throw new HttpError(409, takenBy(h));
    await conn.query("UPDATE Customer SET FirstName = ?, LastName = ?, Email = ?, Phone = ? WHERE CustomerID = ?",
      [f.firstName, f.lastName || null, f.email, f.phone, m.id]);
  });
  res.json({ message: `Saved ${nameOf(f)}.` });
});

// An inactive member can't be found or used at the register; their points and history stay
router.post("/rewards/members/:id/active", requirePermission(PERM_EDIT), async (req, res) => {
  const m = await findMember(req.session.businessId, req.params.id);
  const on = req.body.active === true;
  await pool.query("UPDATE LoyaltyAccount SET Active = ? WHERE CustomerID = ?", [on, m.id]);
  res.json({ message: on ? `Reactivated ${nameOf(m)}. They can earn and redeem points again.` : `Deactivated ${nameOf(m)}. Their points and history are kept.` });
});

module.exports = router;
