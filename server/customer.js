const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { verifySecret, hashSecret } = require("./auth");
const { DUMMY } = require("./pin");
const { HttpError } = require("./errors");
const check = require("./validate");
const rateLimit = require("./ratelimit");
const session = require("./session");

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const SESSION_MS = 2 * 60 * 60 * 1000;
const IDLE_MS = 15 * 60 * 1000;

// shortcut: in memory like staff sessions, so a restart signs customers out; move to a table with more than one server
const sessions = new Map();
const over = (s) => s.expires < Date.now() || Date.now() - s.active >= IDLE_MS;
setInterval(() => { for (const [t, s] of sessions) if (over(s)) sessions.delete(t); }, 60 * 60 * 1000).unref();

const tokenOf = (req) => /(?:^|;\s*)customer_session=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1];

function create(res, data) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...data, expires: Date.now() + SESSION_MS, active: Date.now() });
  res.cookie("customer_session", token, { httpOnly: true, sameSite: "strict", maxAge: SESSION_MS, secure: process.env.COOKIE_SECURE === "1" });
}

function destroy(req, res) {
  const token = tokenOf(req);
  if (!token) return; // nothing to end, and no cookie header to send on every staff sign-in
  sessions.delete(token);
  res.clearCookie("customer_session");
}

function fromRequest(req) {
  const token = tokenOf(req);
  const s = sessions.get(token);
  if (s && over(s)) sessions.delete(token);
  return s && !over(s) ? s : null;
}

function requireCustomer(req, res, next) {
  const s = fromRequest(req);
  if (!s) return res.status(401).json({ error: "Not signed in." });
  req.customer = s;
  next();
}

const authenticate = (email, password) =>
  pool.tx(async (conn) => {
    const [[c]] = await conn.query(
      `SELECT c.CustomerID, c.BusinessID, c.FirstName, k.PasswordHash, k.FailedAttempts, k.LockedUntil, k.LockedUntil > NOW() AS IsLocked
         FROM Customer c JOIN Business b USING (BusinessID) JOIN CustomerCredential k USING (CustomerID)
        WHERE c.Email = ? AND c.Active AND b.Active FOR UPDATE OF k`,
      [String(email).trim()]
    );
    const good = verifySecret(String(password), c?.PasswordHash || DUMMY);
    if (!c) return { status: "missing" };
    if (!c.IsLocked && good) {
      await conn.query("UPDATE CustomerCredential SET FailedAttempts = 0, LockedUntil = NULL WHERE CustomerID = ?", [c.CustomerID]);
      return { status: "ok", customer: { customerId: c.CustomerID, businessId: c.BusinessID, firstName: c.FirstName } };
    }
    if (c.IsLocked) return { status: "locked", lockedUntil: c.LockedUntil };
    const failed = c.FailedAttempts + 1;
    if (failed < MAX_ATTEMPTS) {
      await conn.query("UPDATE CustomerCredential SET FailedAttempts = ? WHERE CustomerID = ?", [failed, c.CustomerID]);
      return { status: "bad" };
    }
    await conn.query("UPDATE CustomerCredential SET FailedAttempts = 0, LockedUntil = NOW() + INTERVAL ? MINUTE WHERE CustomerID = ?", [LOCK_MINUTES, c.CustomerID]);
    const [[{ until }]] = await conn.query("SELECT LockedUntil AS until FROM CustomerCredential WHERE CustomerID = ?", [c.CustomerID]);
    return { status: "locked", lockedUntil: until };
  });

const router = express.Router();

// Self sign-up: a first name, an email and a password make a customer, signed in at once. The email must be new: no other
// customer's (even a walk-in staff entered, which would hand a stranger that person's points) and no employee's.
// Nothing proves the email is theirs: there is no mail service to verify it with.
const TAKEN = "That email is already registered. Sign in instead.";
router.post("/signup", rateLimit(5, 60 * 60 * 1000, { ban: true }), async (req, res) => {
  const problems = [];
  const firstName = check.collect(problems, () => check.personName(req.body.firstName, "first name"));
  const email = check.collect(problems, () => check.email(req.body.email, { required: true }));
  const { password, confirm } = req.body;
  if (typeof password !== "string" || password.length < 8 || password.length > 200) problems.push("Choose a password of 8 to 200 characters.");
  else if (password !== confirm) problems.push("The passwords don't match. Type the same password in both.");
  if (problems.length) throw new HttpError(400, problems[0]);

  const [[b]] = await pool.query("SELECT BusinessID AS id FROM Business WHERE Active LIMIT 1");
  if (!b) throw new HttpError(404, "Sign-up isn't open right now.");
  const customerId = crypto.randomUUID();
  const hash = hashSecret(password);
  try {
    await pool.tx(async (conn) => {
      const [[e]] = await conn.query("SELECT EXISTS (SELECT 1 FROM Employee WHERE Email = ?) AS taken", [email]);
      if (e.taken) throw new HttpError(409, TAKEN);
      await conn.query("INSERT INTO Customer (CustomerID, BusinessID, FirstName, Email) VALUES (?, ?, ?, ?)", [customerId, b.id, firstName, email]);
      await conn.query("INSERT INTO CustomerCredential (CustomerID, PasswordHash) VALUES (?, ?)", [customerId, hash]);
      // Auto-enroll: every new sign-up joins rewards at the lowest tier, the same way staff enroll a member (server/rewards.js)
      const [[tier]] = await conn.query("SELECT TierID AS id FROM MembershipTier WHERE BusinessID = ? ORDER BY MinimumPoints, Name LIMIT 1", [b.id]);
      if (tier) await conn.query("INSERT INTO LoyaltyAccount (LoyaltyAccountID, CustomerID, TierID, BusinessID) VALUES (UUID(), ?, ?, ?)", [customerId, tier.id, b.id]);
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") throw new HttpError(409, TAKEN);
    throw err;
  }
  session.destroy(req, res); // one kind of sign-in per browser
  create(res, { customerId, businessId: b.id, firstName });
  res.json({ redirect: "/kiosk.html" });
});

// Who is signed in, with points read live from the ledger
router.get("/customer/me", requireCustomer, async (req, res) => {
  const [[c]] = await pool.query(
    `SELECT c.FirstName AS firstName, c.Email AS email, t.Name AS tier, la.LoyaltyAccountID AS account,
            COALESCE((SELECT SUM(lt.PointsChange) FROM LoyaltyTransaction lt WHERE lt.LoyaltyAccountID = la.LoyaltyAccountID), 0) AS points
       FROM Customer c
       LEFT JOIN LoyaltyAccount la ON la.CustomerID = c.CustomerID AND la.Active
       LEFT JOIN MembershipTier t ON t.TierID = la.TierID
      WHERE c.CustomerID = ?`, [req.customer.customerId]);
  res.json({
    firstName: c.firstName || "there",
    maskedEmail: c.email.replace(/^(.).*(@.*)$/, "$1***$2"),
    member: !!c.account,
    points: c.account ? Number(c.points) : null,
    tier: c.tier || null,
  });
});

// Return only customer-app order notifications belonging to the signed-in customer.
// Channel 3 is used by this app when placing pickup orders; POS is channel 1.
router.get("/customer/notifications", requireCustomer, async (req, res) => {
  const [alerts] = await pool.query(
    `SELECT a.AlertID AS id,
            a.OrderID AS orderId,
            o.OrderNumber AS orderNumber,
            s.Description AS status,
            a.CreatedAt AS createdAt,
            a.ReadAt AS readAt
       FROM OrderStatusAlert a
       JOIN Orders o ON o.OrderID = a.OrderID
       JOIN OrderStatus s
         ON s.OrderStatusCode = a.OrderStatusCode
      WHERE a.CustomerID = ? AND o.ChannelCode = 3
      ORDER BY a.CreatedAt DESC, a.AlertID DESC
      LIMIT 100`,
    [req.customer.customerId]
  );

  res.json({ alerts });
});

router.post("/customer/notifications/:id/read", requireCustomer, async (req, res) => {
  const id = String(req.params.id);
  if (!/^[1-9][0-9]{0,19}$/.test(id)) throw new HttpError(404, "No such notification.");
  const [result] = await pool.query(
    "UPDATE OrderStatusAlert SET ReadAt = COALESCE(ReadAt, UTC_TIMESTAMP()) WHERE AlertID = ? AND CustomerID = ?",
    [id, req.customer.customerId]
  );
  if (!result.affectedRows) throw new HttpError(404, "No such notification.");
  res.json({ ok: true });
});

router.post("/customer/logout", (req, res) => {
  destroy(req, res);
  res.json({ ok: true });
});

module.exports = { router, authenticate, create, destroy, fromRequest, requireCustomer };
