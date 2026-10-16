const express = require("express");
const pool = require("./database/connection");
const { findEmployee, workplace, authenticate } = require("./pin");
const session = require("./session");
const rateLimit = require("./ratelimit");

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
  session.create(res, {
    employeeId: emp.EmployeeID,
    businessId: emp.BusinessID,
    locationId: place.LocationID,
    registerId: place.RegisterID,
    info: {
      employeeName: `${emp.FirstName} ${emp.LastName}`,
      roleName: emp.RoleName,
      locationName: place.LocationName,
      registerName: place.RegisterName,
    },
  });
  res.json({ redirect: DESTINATIONS[emp.OpensTo] || "/index.html" });
});

router.post("/logout", (req, res) => {
  session.destroy(req, res);
  res.json({ ok: true });
});

router.use(session.requireSession);

router.get("/session", (req, res) => res.json(req.session.info));

router.use(require("./register"));
router.use(require("./refunds"));

module.exports = router;
