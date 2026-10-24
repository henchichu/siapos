const path = require("path");
const express = require("express");
const router = require("./router");
const session = require("./session");
const pool = require("./database/connection");
const { hasPermission } = require("./pin");
const { handleErrors } = require("./errors");
const kiosk = require("./kiosk");

const PORT = process.env.PORT || 3000;
const KIOSK_PORT = process.env.KIOSK_PORT || 3001;
const HOST = "0.0.0.0";

const app = express();
// Behind an HTTPS proxy every request comes from the proxy: trust its forwarded address, or the sign-in limit counts the whole shop as one
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

app.get("/health", (req, res) => res.json({ status: "ok", application: "SIAPOS" }));

// The customer iPad opens this URL; /customer redirects to the page
app.get("/customer", (req, res) => res.redirect("/customer.html"));

app.use(require("./vendor"));

// Customer kiosk routes precede employee authentication.
app.use("/api", express.json(), require("./customers"), router);
app.get("/settings.html", async (req, res, next) => {
  const s = session.fromRequest(req);
  if (!s) return res.redirect("/login.html");
  if (await hasPermission(pool, s.employeeId, 21) || await hasPermission(pool, s.employeeId, 22)) return next();
  res.redirect(s.info.home);
});

// Reports, Employees and Rewards are checked live against their permissions (20, 19 and 9), so taking one away works at once
const LIVE = { "/reports.html": 20, "/employees.html": 19, "/rewards.html": 9 };
app.get(Object.keys(LIVE), async (req, res, next) => {
  const s = session.fromRequest(req);
  if (!s) return res.redirect("/login.html");
  if (await hasPermission(pool, s.employeeId, LIVE[req.path])) return next();
  console.warn(`access violation: ${s.info.employeeName} (${s.info.roleName}) tried ${req.path}`);
  res.redirect(s.info.home);
});

// Each page opens only for a role that has it in its menu; anyone else goes back to their own home
const PAGE_NAV = { "/home.html": "", "/register.html": "Register", "/kitchen.html": "Kitchen", "/shift.html": "My shift", "/products.html": "Products", "/inventory.html": "Inventory", "/attention.html": "Needs attention", "/orders.html": "Orders", "/order.html": "Orders" };
app.use((req, res, next) => {
  const need = PAGE_NAV[req.path];
  if (need === undefined) return next();
  const s = session.fromRequest(req);
  if (!s) return res.redirect("/login.html");
  if (!need || s.info.nav.includes(need)) return next(); // Home needs only a sign-in
  console.warn(`access violation: ${s.info.employeeName} (${s.info.roleName}) tried ${req.path}`);
  res.redirect(s.info.home);
});

app.use(express.static(path.resolve(__dirname, "../public")));

app.use((req, res) => res.status(404).type("text").send("Page not found"));
app.use(handleErrors);

if (require.main === module) {
  app.listen(PORT, HOST, () => console.log(`SIAPOS is running at http://localhost:${PORT}`));
  // the only part meant for the internet, through the Caddy proxy: see server/kiosk.js
  kiosk.listen(KIOSK_PORT, HOST, () => console.log(`Customer kiosk (public side) at http://localhost:${KIOSK_PORT}`));
}

module.exports = app;
