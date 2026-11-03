const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { verifySecret } = require("./auth");
const { DUMMY } = require("./pin");

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

router.get("/customer/me", requireCustomer, (req, res) => res.json({ firstName: req.customer.firstName || "there" }));

router.post("/customer/logout", (req, res) => {
  destroy(req, res);
  res.json({ ok: true });
});

module.exports = { router, authenticate, create, destroy, fromRequest };
