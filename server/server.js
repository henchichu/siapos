const path = require("path");
const express = require("express");
const router = require("./router");
const session = require("./session");
const pool = require("./database/connection");
const { hasPermission } = require("./pin");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const app = express();
// Behind an HTTPS proxy every request comes from the proxy: trust its forwarded address, or the sign-in limit counts the whole shop as one
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

app.get("/health", (req, res) => res.json({ status: "ok", application: "SIAPOS" }));

const VENDOR = {
  "react.js": "react/umd/react.production.min.js",
  "react-dom.js": "react-dom/umd/react-dom.production.min.js",
  "htm.js": "htm/dist/htm.umd.js",
};
app.get("/vendor/:file", (req, res, next) => {
  const file = VENDOR[req.params.file];
  if (!file) return next();
  res.sendFile(path.join(__dirname, "../node_modules", file), { maxAge: "1d" });
});

app.use("/api", express.json(), router);

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
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  // a rule the database enforces itself (SQLSTATE 45000): its message is written for people
  if (err.sqlState === "45000") return res.status(409).json({ error: err.sqlMessage });
  if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "That name or SKU is already in use." });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => console.log(`SIAPOS is running at http://localhost:${PORT}`));
}

module.exports = app;
