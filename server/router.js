const express = require("express");
const pool = require("./database/connection");
const { findEmployee, workplace, authenticate, isOwner } = require("./pin");
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

// Only an owner moves between locations; everyone else stays at the one they signed in to
const ownerOnly = async (req, res, next) =>
  (await isOwner(req.session.employeeId)) ? next() : res.status(403).json({ error: "Only an owner can switch location." });

// The places this owner works, and a switch between them: the register and every location-scoped page follow the session
router.get("/locations", ownerOnly, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT l.LocationID AS id, l.Name AS name FROM EmployeeLocation el JOIN Location l USING (LocationID, BusinessID)
      WHERE el.EmployeeID = ? AND el.Active AND l.Active ORDER BY l.Name`,
    [req.session.employeeId]
  );
  res.json({ current: req.session.locationId, locations: rows });
});

router.post("/locations/switch", ownerOnly, async (req, res) => {
  const [[place]] = await pool.query(
    `SELECT l.LocationID, l.Name AS LocationName FROM EmployeeLocation el JOIN Location l USING (LocationID, BusinessID)
      WHERE el.EmployeeID = ? AND el.Active AND l.Active AND l.LocationID = ?`,
    [req.session.employeeId, String(req.body.locationId)]
  );
  if (!place) return res.status(403).json({ error: "You don't work at that location." });
  const [[reg]] = await pool.query("SELECT RegisterID, Name FROM Register WHERE LocationID = ? AND RegStatusCode = 1 ORDER BY Name LIMIT 1", [place.LocationID]);
  req.session.locationId = place.LocationID;
  req.session.registerId = reg?.RegisterID;
  req.session.info = Object.freeze({ ...req.session.info, locationName: place.LocationName, registerName: reg?.Name });
  res.json({ locationName: place.LocationName });
});

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

module.exports = router;
