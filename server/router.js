const express = require("express");
const pool = require("./database/connection");
const { authenticatePassword } = require("./pin");
const session = require("./session");
const rateLimit = require("./ratelimit");
const { signInAs } = require("./signin");
const customer = require("./customer");

const PERM_REPORTS = 20;
const PERM_MEMBERS = 9;

const router = express.Router();
router.use((req, res, next) => {
  req.body ??= {};
  next();
});

const loginLimit = rateLimit(30, 60 * 1000);
router.use("/login", loginLimit);

// The sign-in name is the email; the password is checked for length when it is set (sql/provision), not here, so an old short one still works
const sane = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!sane(email, 255) || !sane(password, 200)) return res.status(400).json({ error: "Enter your email and password." });
  let result = await authenticatePassword(email, password);

  // Not an employee's email: it may be a customer's, who signs in here too and lands on the kiosk instead
  if (result.status === "missing") {
    const c = await customer.authenticate(email, password);
    if (c.status === "ok") {
      session.destroy(req, res); // one kind of sign-in per browser
      customer.create(res, c.customer);
      return res.json({ redirect: "/kiosk.html" });
    }
    result = c;
  }

  if (result.status === "locked") return res.status(423).json({ locked: true, lockedUntil: result.lockedUntil });
  // A wrong email and a wrong password get the same answer, so this doesn't say which emails exist
  if (result.status !== "ok") return res.status(401).json({ error: "Incorrect email or password." });

  customer.destroy(req, res);
  const refused = await signInAs(res, result.emp);
  if (refused) return res.status(403).json({ error: refused });
  res.json({ redirect: "/home.html" }); // everyone lands on Home; its tiles come from the role
});

router.post("/logout", (req, res) => {
  session.destroy(req, res);
  res.json({ ok: true });
});

router.use(customer.router); // before the staff check: customers have their own session
router.use(require("./kiosk"));

router.use(session.requireSession);

router.get("/session", (req, res) => res.json(req.session.info));
// The page calls this when the person does something, which restarts the idle clock
router.post("/session/touch", (req, res) => { req.session.active = Date.now(); res.json({}); });

// A page that finds the role may not open it reports it here before redirecting home
router.post("/access-violation", (req, res) => {
  const { employeeName, roleName } = req.session.info;
  console.warn(`access violation: ${employeeName} (${roleName}) tried ${String(req.body.page).slice(0, 40)}`);
  res.json({ ok: true });
});

router.use(require("./register"));
router.use(require("./refunds"));
router.use(require("./kitchen"));
router.use(require("./shift"));
router.use(require("./products"));
router.use(require("./inventory"));
router.use(require("./attention"));
router.use(require("./reports"));
router.use(require("./orders"));
router.use(require("./rewards"));

module.exports = router;
