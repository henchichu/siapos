const express = require("express");
const pool = require("./database/connection");
const { findEmployee, workplace, authenticate } = require("./pin");
const session = require("./session");
const rateLimit = require("./ratelimit");
const { access } = require("./nav");

const DESTINATIONS = { REGISTER: "/register.html", KITCHEN: "/kitchen.html" };

const router = express.Router();
router.use((req, res, next) => {
  req.body ??= {};
  next();
});

const loginLimit = rateLimit(30, 60 * 1000);
router.use("/login", loginLimit);

router.post("/login/employee", async (req, res) => {
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

  const { emp } = result;
  const place = (await workplace(emp.EmployeeID)) || {};
  const { nav, tiles, home } = access(emp, DESTINATIONS);
  session.create(res, {
    employeeId: emp.EmployeeID,
    businessId: emp.BusinessID,
    locationId: place.LocationID,
    registerId: place.RegisterID,
    info: {
      employeeName: `${emp.FirstName} ${emp.LastName}`,
      roleName: emp.RoleName,
      nav,
      tiles,
      home,
      locationName: place.LocationName,
      registerName: place.RegisterName,
    },
  });
  res.json({ redirect: "/home.html" }); // everyone lands on Home; its tiles come from the role
});

router.post("/logout", (req, res) => {
  session.destroy(req, res);
  res.json({ ok: true });
});

router.use(session.requireSession);

router.get("/session", (req, res) => res.json(req.session.info));

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

module.exports = router;
