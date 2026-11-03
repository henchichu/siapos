const express = require("express");
const pool = require("./database/connection");
const { findEmployee, workplace, authenticate } = require("./pin");
const session = require("./session");
const rateLimit = require("./ratelimit");
const { EMPLOYEE_NUMBER } = require("./validate");
const { signInAs } = require("./signin");

const PERM_REPORTS = 20;
const PERM_MEMBERS = 9;

const router = express.Router();
router.use((req, res, next) => {
  req.body ??= {};
  next();
});

const loginLimit = rateLimit(30, 60 * 1000);
router.use("/login", loginLimit);

// Employee numbers are 8 digits, so anything else is refused without a lookup (and without saying whether a number exists)
router.use("/login", (req, res, next) =>
  EMPLOYEE_NUMBER.test(String(req.body.employeeNumber)) ? next() : res.status(400).json({ error: "Employee numbers are 8 digits." }));

// Step 1 shows the first name before the PIN (the sign-in design needs it), so the lookup has its own tighter limits: enough for
// a café's staff signing in on one address, too few to try numbers in bulk. No ban: the whole café shares that address.
const lookupLimits = [rateLimit(10, 60 * 1000), rateLimit(60, 60 * 60 * 1000)];
router.resetLookupLimits = () => lookupLimits.forEach((l) => l.reset());
router.post("/login/employee", lookupLimits, async (req, res) => {
  const emp = await findEmployee(pool, String(req.body.employeeNumber));
  if (!emp) return res.status(404).json({ error: "Employee Number does not exist." });
  const place = await workplace(emp.EmployeeID);
  res.json({ firstName: emp.FirstName, businessName: emp.BusinessName, locationName: place?.LocationName });
});

router.post("/login/pin", async (req, res) => {
  if (!/^\d{6}$/.test(req.body.pin)) return res.status(400).json({ error: "PIN must be 6 digits." });
  const result = await authenticate(req.body.employeeNumber, req.body.pin);

  if (result.status === "missing") return res.status(404).json({ error: "Employee Number does not exist." });
  if (result.status === "locked") return res.status(423).json({ locked: true, lockedUntil: result.lockedUntil });
  if (result.status === "bad")
    return res
      .status(401)
      .json({ error: `Incorrect PIN. ${result.retriesLeft} retries left.`, retriesLeft: result.retriesLeft });

  const refused = await signInAs(res, result.emp);
  if (refused) return res.status(403).json({ error: refused });
  res.json({ redirect: "/home.html" }); // everyone lands on Home; its tiles come from the role
});


router.post("/logout", (req, res) => {
  session.destroy(req, res);
  res.json({ ok: true });
});

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
