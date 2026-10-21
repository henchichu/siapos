const crypto = require("crypto");
const pool = require("./database/connection");
const { hasPermission } = require("./pin");

// shortcut: in memory, so a restart signs everyone out; move to a table when running more than one server
const sessions = new Map();
const SESSION_MS = 8 * 60 * 60 * 1000; // one shift
const APPROVAL_MS = 10 * 60 * 1000;
const GIFT_TRIES = 5;
const GIFT_WINDOW_MS = 15 * 60 * 1000;

setInterval(() => {
  for (const [token, s] of sessions) if (s.expires < Date.now()) sessions.delete(token);
}, 60 * 60 * 1000).unref();

const tokenOf = (req) => /(?:^|;\s*)session=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1];

function create(res, data) {
  Object.freeze(data.info.nav);
  Object.freeze(data.info.tiles);
  Object.freeze(data.info); // the role and what it may open can't change until the next sign-in
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...data, approvals: new Map(), expires: Date.now() + SESSION_MS });
  // set COOKIE_SECURE=1 once the app is served over HTTPS
  res.cookie("session", token, { httpOnly: true, sameSite: "strict", maxAge: SESSION_MS, secure: process.env.COOKIE_SECURE === "1" });
}

function destroy(req, res) {
  sessions.delete(tokenOf(req));
  res.clearCookie("session");
}

// Signs someone out everywhere at once, e.g. when they are deactivated
function endSessionsOf(employeeId) {
  for (const [token, s] of sessions) if (s.employeeId === employeeId) sessions.delete(token);
}

function fromRequest(req) {
  const token = tokenOf(req);
  const s = sessions.get(token);
  if (s && s.expires < Date.now()) sessions.delete(token);
  return s && s.expires >= Date.now() ? s : null;
}

function requireSession(req, res, next) {
  const s = fromRequest(req);
  if (!s) return res.status(401).json({ error: "Not signed in." });
  req.session = s;
  next();
}

// Checked against the DB on every call, so a role change takes effect at once
const requirePermission = (code) => async (req, res, next) => {
  if (!(await hasPermission(pool, req.session.employeeId, code)))
    return res.status(403).json({ error: "Your role can't do this." });
  next();
};

// A manager's approval of one specific discount: tied to this session and these exact terms.
// It is held (busy) while a sale uses it, so two sales sent together can't both spend it.
function grantApproval(session, terms, approverId, staffId) {
  const token = crypto.randomBytes(16).toString("hex");
  session.approvals.set(token, { terms: JSON.stringify(terms), approverId, staffId, expires: Date.now() + APPROVAL_MS, busy: false });
  return token;
}

function checkApproval(session, token, terms) {
  const a = session.approvals.get(token);
  if (!a || a.busy || a.expires < Date.now() || a.terms !== JSON.stringify(terms)) return null;
  a.busy = true;
  return { approverId: a.approverId, staffId: a.staffId };
}

const releaseApproval = (session, token) => { const a = session.approvals.get(token); if (a) a.busy = false; };
// Spent once the sale is committed, so a failed sale doesn't cost the manager a second sign-off
const spendApproval = (session, token) => session.approvals.delete(token);

// Wrong gift card codes: a few per session per 15 minutes, so codes can't be guessed at the till
const giftAllowed = (s) => !(s.giftFails && s.giftFails.n >= GIFT_TRIES && Date.now() - s.giftFails.since < GIFT_WINDOW_MS);
function giftFailed(s) {
  const g = s.giftFails;
  s.giftFails = g && Date.now() - g.since < GIFT_WINDOW_MS ? { n: g.n + 1, since: g.since } : { n: 1, since: Date.now() };
}
const giftOk = (s) => { s.giftFails = null; };

module.exports = {
  create, destroy, endSessionsOf, fromRequest, requireSession, requirePermission,
  grantApproval, checkApproval, releaseApproval, spendApproval, giftAllowed, giftFailed, giftOk,
};
