const path = require("path");
const express = require("express");
const router = require("./router");
const session = require("./session");
const pool = require("./database/connection");
const { hasPermission } = require("./pin");
const { handleErrors } = require("./errors");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const app = express();
// Behind an HTTPS proxy every request comes from the proxy: trust its forwarded address, or the sign-in limit counts the whole shop as one
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

app.get("/health", (req, res) => res.json({ status: "ok", application: "SIAPOS" }));

// "/" is the front page with the tour that leads to the one-time sign-up. Once the business exists, or for anyone signed in, it is
// the staff sign-in or home screen; with DEMO_MODE=1 it is the tour for everyone not signed in (server/demo.js).
// The phones' order page is a separate server (server/kiosk.js).
const demo = require("./demo");
app.get("/", async (req, res) => {
  if (session.fromRequest(req)) return res.redirect("/home.html");
  if (!demo.on() && await require("./setup").signupClosed(pool)) return res.redirect("/login.html");
  res.sendFile(path.resolve(__dirname, "../public/tour.html"));
});

// The tour's sample pages: the real staff pages, run on recorded sample data by public/js/api.js. Open only until the one business exists.
const TOUR_PAGES = ["home", "register", "kitchen", "attention", "orders", "rewards", "products", "inventory", "reports", "employees", "settings", "shift"];
app.get("/tour/:page.html", async (req, res, next) => {
  if (!TOUR_PAGES.includes(req.params.page) || (!demo.on() && await require("./setup").signupClosed(pool))) return next();
  res.sendFile(path.resolve(__dirname, `../public/${req.params.page}.html`));
});

app.use(require("./vendor"));

// The tour asks for the demo sign-ins; without DEMO_MODE there are none
app.get("/api/demo", (req, res) => (demo.on() ? res.json({ credentials: demo.CREDENTIALS }) : res.status(404).json({ error: "Not found" })));
app.use("/api", express.json(), router);
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
  require("./kioskorders").startExpiry(); // cancels kiosk orders nobody paid for, which puts their stock back
  require("./watchers").startPolling(pool); // tells open kitchen screens about orders the public server took
}

module.exports = app;
