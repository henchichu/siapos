const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { requirePermission, endSessionsOf } = require("./session");
const { hashSecret } = require("./auth");
const { clearLockout, isOwner } = require("./pin");
const { myLocations } = require("./locations");

const PERM_MANAGE_STAFF = 19;
const OPEN = 1; // a shift still running

const router = express.Router();
router.use("/employees", requirePermission(PERM_MANAGE_STAFF));

const cents = (n) => Math.round(Number(n) * 100);
const dollars = (c) => (c / 100).toFixed(2);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const dayOf = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// The café's today, where the owner signed in
async function today(locationId) {
  const [[r]] = await pool.query(
    "SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', TimeZone), '%Y-%m-%d') AS d FROM Location WHERE LocationID = ?", [locationId]);
  return r.d;
}

// What this person may do here. Owners: everyone, every location, and pay. Anyone else who manages staff: only the
// staff at their own locations, never people whose role also manages staff (owners and managers), and pay read-only.
async function powers(session) {
  const owner = await isOwner(session.employeeId);
  // a "senior" role is one that manages staff itself: the owner role, and any role holding permission 19
  const [roles] = await pool.query(
    `SELECT r.RoleID AS id, r.Name AS name, (r.IsOwner OR EXISTS (SELECT 1 FROM RolePermission rp WHERE rp.RoleID = r.RoleID AND rp.PermissionCode = ?)) AS senior
       FROM Role r WHERE r.BusinessID = ? AND r.Active ORDER BY r.IsOwner DESC, r.Name`, [PERM_MANAGE_STAFF, session.businessId]);
  const [all] = await pool.query("SELECT LocationID AS id, Name AS name FROM Location WHERE BusinessID = ? AND Active ORDER BY Name", [session.businessId]);
  const mine = owner ? all.map((l) => l.id) : await myLocations(session.employeeId);
  return {
    owner,
    roles: roles.map((r) => ({ id: r.id, name: r.name, senior: !!r.senior })),
    locations: all.filter((l) => mine.includes(l.id)),
    mine,
    canAssign: (roleId) => owner || roles.some((r) => r.id === roleId && !r.senior),
  };
}

// The employee being changed, if this person may change them: anyone for an owner; for anyone else, staff with a
// non-senior role at one of their locations
async function target(session, p, id) {
  const [[e]] = await pool.query(
    `SELECT e.EmployeeID AS id, e.FirstName AS firstName, e.LastName AS lastName, e.RoleID AS roleId
       FROM Employee e WHERE e.EmployeeID = ? AND e.BusinessID = ?
        ${p.owner ? "" : "AND EXISTS (SELECT 1 FROM EmployeeLocation el WHERE el.EmployeeID = e.EmployeeID AND el.Active AND el.LocationID IN (?))"}`,
    p.owner ? [id, session.businessId] : [id, session.businessId, p.mine.length ? p.mine : [""]]);
  if (!e) throw new HttpError(404, "Employee not found.");
  if (!p.canAssign(e.roleId)) throw new HttpError(403, "Only an owner can change owners and managers.");
  return e;
}

// Everyone this person may see, with their role, locations, pay and status. Nothing about PINs leaves the server
// except whether the account is locked.
router.get("/employees", async (req, res) => {
  const { businessId, employeeId, locationId } = req.session;
  const day = await today(locationId);
  const p = await powers(req.session);
  const [people] = await pool.query(
    `SELECT e.EmployeeID AS id, e.FirstName AS firstName, e.LastName AS lastName, e.EmployeeNumber AS number, e.Email AS email,
            e.RoleID AS roleId, r.Name AS role, e.Active AS active, COALESCE(c.LockedUntil > NOW(), FALSE) AS locked
       FROM Employee e JOIN Role r ON r.RoleID = e.RoleID LEFT JOIN EmployeeCredential c ON c.EmployeeID = e.EmployeeID
      WHERE e.BusinessID = ?
        ${p.owner ? "" : "AND EXISTS (SELECT 1 FROM EmployeeLocation el WHERE el.EmployeeID = e.EmployeeID AND el.Active AND el.LocationID IN (?))"}
      ORDER BY e.LastName, e.FirstName`,
    p.owner ? [businessId] : [businessId, p.mine.length ? p.mine : [""]]
  );
  const [links] = await pool.query(
    `SELECT el.EmployeeID AS employeeId, l.LocationID AS id, l.Name AS name FROM EmployeeLocation el JOIN Location l ON l.LocationID = el.LocationID
      WHERE el.BusinessID = ? AND el.Active ORDER BY l.Name`, [businessId]);
  const [rates] = await pool.query(
    `SELECT EmployeeID AS employeeId, HourlyRate AS rate, DATE_FORMAT(EffectiveFrom, '%Y-%m-%d') AS startsOn, DATE_FORMAT(EffectiveTo, '%Y-%m-%d') AS endsOn
       FROM EmployeePayRate WHERE BusinessID = ? ORDER BY EffectiveFrom`, [businessId]);

  res.json({
    me: employeeId,
    today: day,
    canPay: p.owner,
    roles: p.roles.map(({ id, name }) => ({ id, name })),
    assignable: p.roles.filter((r) => p.canAssign(r.id)).map((r) => r.id),
    locations: p.locations,
    employees: people.map((e) => {
      const mine = rates.filter((r) => r.employeeId === e.id).map((r) => ({ rate: Number(r.rate), startsOn: r.startsOn, endsOn: r.endsOn }));
      const now = mine.find((r) => r.startsOn <= day && (!r.endsOn || r.endsOn > day));
      const next = mine.filter((r) => r.startsOn > day).at(-1);
      return {
        ...e,
        active: !!e.active,
        locked: !!e.locked,
        status: !e.active ? "Inactive" : e.locked ? "Locked" : "Active",
        manageable: p.canAssign(e.roleId),
        locations: links.filter((l) => l.employeeId === e.id).map(({ id, name }) => ({ id, name })),
        rate: now ? now.rate : null,
        next: next ? { rate: next.rate, startsOn: next.startsOn } : null,
        latest: mine.length ? { rate: mine.at(-1).rate, startsOn: mine.at(-1).startsOn } : null,
      };
    }),
  });
});

// Reads the form and lists every problem at once, so the owner fixes them in one go. On an edit the PIN may be blank.
function readForm(b, { adding, pay }) {
  const f = {
    firstName: String(b.firstName || "").trim(),
    lastName: String(b.lastName || "").trim(),
    number: String(b.number || "").trim(),
    email: String(b.email || "").trim().toLowerCase(),
    roleId: String(b.roleId || ""),
    locationIds: Array.isArray(b.locationIds) ? [...new Set(b.locationIds.map(String))] : [],
    rate: String(b.rate ?? "").trim(),
    startsOn: String(b.startsOn || ""),
    pin: String(b.pin || ""),
  };
  const problems = [];
  if (!f.firstName || f.firstName.length > 50) problems.push("Enter a first name (up to 50 characters).");
  if (!f.lastName || f.lastName.length > 50) problems.push("Enter a last name (up to 50 characters).");
  if (!/^\d{8}$/.test(f.number)) problems.push("The employee number must be 8 digits.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email) || f.email.length > 255) problems.push("Enter a valid email.");
  if (!f.roleId) problems.push("Choose a role.");
  if (!f.locationIds.length) problems.push("Choose at least one location.");
  if (pay) {
    if (!/^\d{1,6}(\.\d{1,2})?$/.test(f.rate) || cents(f.rate) <= 0) problems.push("Enter an hourly rate, like 16.50.");
    if (!isDate(f.startsOn)) problems.push("Choose the date the pay rate starts.");
  }
  if ((adding || f.pin) && !/^\d{6}$/.test(f.pin)) problems.push("The PIN must be 6 digits.");
  if (problems.length) throw new HttpError(400, problems.join(" "));
  return f;
}

// The role and locations must be this business's own, and ones this person may give.
// kept: locations the employee already has elsewhere, which come back from the form unchanged.
function checkChoices(p, f, kept = []) {
  if (!p.roles.some((r) => r.id === f.roleId)) throw new HttpError(400, "Choose a role from the list.");
  if (!p.canAssign(f.roleId)) throw new HttpError(403, "Only an owner can make someone an owner or a manager.");
  if (f.locationIds.some((l) => !p.mine.includes(l) && !kept.includes(l))) throw new HttpError(403, "You can only add staff to your own locations.");
}

// Pay is the owner's: anyone else can't send a rate at all
const PAY_OWNER_ONLY = "Only an owner can set or change pay rates.";

// Employee numbers are typed at sign-in, so they are unique across every business; emails within this one
async function checkUnique(businessId, f, id = "") {
  const [[taken]] = await pool.query("SELECT 1 AS ok FROM Employee WHERE EmployeeNumber = ? AND EmployeeID <> ?", [f.number, id]);
  if (taken) throw new HttpError(409, `Employee number ${f.number} is already in use. Choose another.`);
  const [[email]] = await pool.query("SELECT 1 AS ok FROM Employee WHERE BusinessID = ? AND Email = ? AND EmployeeID <> ?", [businessId, f.email, id]);
  if (email) throw new HttpError(409, "Another employee already uses that email.");
}

// Closed pay periods are paid out, so a rate can't start inside one
async function checkPayDate(businessId, day) {
  const [[closed]] = await pool.query(
    `SELECT DATE_FORMAT(StartDate, '%Y-%m-%d') AS start, DATE_FORMAT(EndDate, '%Y-%m-%d') AS end FROM PayPeriod
      WHERE BusinessID = ? AND Closed AND ? BETWEEN StartDate AND EndDate`, [businessId, day]);
  if (closed) throw new HttpError(409, `The pay period ${dayOf(closed.start)} to ${dayOf(closed.end)} is already closed. Choose a later start date for the pay rate.`);
}

router.post("/employees", async (req, res) => {
  const { businessId } = req.session;
  const p = await powers(req.session);
  if (!p.owner && (String(req.body.rate ?? "").trim() || String(req.body.startsOn || ""))) throw new HttpError(403, PAY_OWNER_ONLY);
  const f = readForm(req.body, { adding: true, pay: p.owner });
  checkChoices(p, f);
  await checkUnique(businessId, f);
  if (p.owner) await checkPayDate(businessId, f.startsOn);
  const id = crypto.randomUUID();
  await pool.tx(async (conn) => {
    await conn.query("INSERT INTO Employee (EmployeeID, BusinessID, FirstName, LastName, Email, EmployeeNumber, RoleID) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, businessId, f.firstName, f.lastName, f.email, f.number, f.roleId]);
    await conn.query("INSERT INTO EmployeeCredential (EmployeeID, PinHash) VALUES (?, ?)", [id, hashSecret(f.pin)]);
    for (const loc of f.locationIds)
      await conn.query("INSERT INTO EmployeeLocation (EmployeeID, LocationID, BusinessID) VALUES (?, ?, ?)", [id, loc, businessId]);
    // a manager's new hire has no rate until an owner sets one
    if (p.owner) await conn.query("INSERT INTO EmployeePayRate (PayRateID, EmployeeID, BusinessID, HourlyRate, EffectiveFrom) VALUES (UUID(), ?, ?, ?, ?)",
      [id, businessId, dollars(cents(f.rate)), f.startsOn]);
  });
  res.json({ id, message: `Added ${f.firstName} ${f.lastName} (No. ${f.number}).${p.owner ? "" : " An owner sets their pay rate."}` });
});

// Edit: details, role, locations, a new PIN, or a new pay rate from Starts on. The old rate is kept as history.
router.post("/employees/:id", async (req, res) => {
  const { businessId, employeeId } = req.session;
  const p = await powers(req.session);
  const e = await target(req.session, p, req.params.id);
  if (e.id === employeeId && String(req.body.roleId || "") !== e.roleId) throw new HttpError(409, "You can't change your own role.");

  const [[latest]] = await pool.query(
    `SELECT PayRateID AS id, HourlyRate AS rate, DATE_FORMAT(EffectiveFrom, '%Y-%m-%d') AS startsOn FROM EmployeePayRate
      WHERE EmployeeID = ? ORDER BY EffectiveFrom DESC LIMIT 1`, [e.id]);
  // Anyone else may send the rate back as it was (or not at all), never a different one
  const sentRate = String(req.body.rate ?? "").trim();
  if (!p.owner && sentRate && (!latest || cents(sentRate) !== cents(latest.rate))) throw new HttpError(403, PAY_OWNER_ONLY);
  // someone with no rate yet (a manager's new hire) can be edited without giving one
  const f = readForm(req.body, { adding: false, pay: p.owner && (!!latest || !!sentRate) });

  // Locations outside this person's own are left as they were
  const [current] = await pool.query("SELECT LocationID AS id FROM EmployeeLocation WHERE EmployeeID = ? AND Active", [e.id]);
  const elsewhere = current.map((l) => l.id).filter((l) => !p.mine.includes(l));
  checkChoices(p, f, elsewhere);
  f.locationIds = [...new Set([...elsewhere, ...f.locationIds.filter((l) => p.mine.includes(l))])];
  await checkUnique(businessId, f, e.id);

  const newRate = p.owner && !!sentRate && (!latest || cents(latest.rate) !== cents(f.rate));
  if (newRate) {
    if (latest && f.startsOn <= latest.startsOn)
      throw new HttpError(409, `A new pay rate must start after the current one, which started ${dayOf(latest.startsOn)}.`);
    await checkPayDate(businessId, f.startsOn);
  }

  const removed = current.map((l) => l.id).filter((l) => !f.locationIds.includes(l));
  if (removed.length) {
    const [[busy]] = await pool.query(
      `SELECT l.Name AS name FROM TimeEntry te JOIN Location l ON l.LocationID = te.LocationID
        WHERE te.EmployeeID = ? AND te.TimeEntryStatusCode = ? AND te.LocationID IN (?) LIMIT 1`, [e.id, OPEN, removed]);
    if (busy) throw new HttpError(409, `${f.firstName} is clocked in at ${busy.name}. Remove that location after they clock out.`);
  }

  await pool.tx(async (conn) => {
    await conn.query("UPDATE Employee SET FirstName = ?, LastName = ?, Email = ?, EmployeeNumber = ?, RoleID = ? WHERE EmployeeID = ?",
      [f.firstName, f.lastName, f.email, f.number, f.roleId, e.id]);
    // a location taken away is switched off, not deleted: their timecards and sales there still point to it
    if (removed.length) await conn.query("UPDATE EmployeeLocation SET Active = FALSE WHERE EmployeeID = ? AND LocationID IN (?)", [e.id, removed]);
    for (const loc of f.locationIds)
      await conn.query("INSERT INTO EmployeeLocation (EmployeeID, LocationID, BusinessID) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE Active = TRUE", [e.id, loc, businessId]);
    if (f.pin) {
      await conn.query("INSERT INTO EmployeeCredential (EmployeeID, PinHash) VALUES (?, ?) ON DUPLICATE KEY UPDATE PinHash = VALUES(PinHash)", [e.id, hashSecret(f.pin)]);
      await clearLockout(conn, e.id);
    }
    if (newRate) {
      // the latest rate ends where the new one starts (or earlier, if it already had an end)
      if (latest) await conn.query("UPDATE EmployeePayRate SET EffectiveTo = LEAST(COALESCE(EffectiveTo, ?), ?) WHERE PayRateID = ?", [f.startsOn, f.startsOn, latest.id]);
      await conn.query("INSERT INTO EmployeePayRate (PayRateID, EmployeeID, BusinessID, HourlyRate, EffectiveFrom) VALUES (UUID(), ?, ?, ?, ?)",
        [e.id, businessId, dollars(cents(f.rate)), f.startsOn]);
    }
  });
  const parts = [`Saved ${f.firstName} ${f.lastName}.`];
  if (newRate) parts.push(`New rate $${dollars(cents(f.rate))} from ${dayOf(f.startsOn)}.`);
  if (f.pin) parts.push("Their PIN has been reset.");
  res.json({ message: parts.join(" ") });
});

// Deactivate or reactivate. Nobody deactivates themselves, or someone still on the clock; a deactivated person is
// signed out everywhere at once.
router.post("/employees/:id/active", async (req, res) => {
  const { employeeId } = req.session;
  if (req.body.active !== true && req.params.id === employeeId) throw new HttpError(409, "You can't deactivate yourself.");
  const e = await target(req.session, await powers(req.session), req.params.id);
  const name = `${e.firstName} ${e.lastName}`;
  if (req.body.active === true) {
    await pool.query("UPDATE Employee SET Active = TRUE WHERE EmployeeID = ?", [e.id]);
    return res.json({ message: `Reactivated ${name}. They can sign in again.` });
  }
  // one statement, so a clock-in can't slip in between the check and the change
  const [r] = await pool.query(
    `UPDATE Employee SET Active = FALSE WHERE EmployeeID = ? AND Active
        AND NOT EXISTS (SELECT 1 FROM TimeEntry WHERE EmployeeID = ? AND TimeEntryStatusCode = ?)`, [e.id, e.id, OPEN]);
  if (!r.affectedRows) {
    const [[busy]] = await pool.query("SELECT 1 AS ok FROM TimeEntry WHERE EmployeeID = ? AND TimeEntryStatusCode = ?", [e.id, OPEN]);
    if (busy) throw new HttpError(409, `${name} is clocked in. They need to clock out before they can be deactivated.`);
  }
  endSessionsOf(e.id);
  res.json({ message: `Deactivated ${name}. Their shifts, sales and pay history stay on record.` });
});

router.post("/employees/:id/unlock", async (req, res) => {
  const e = await target(req.session, await powers(req.session), req.params.id);
  await clearLockout(pool, e.id);
  res.json({ message: `Unlocked ${e.firstName} ${e.lastName}. They can sign in with their PIN again.` });
});

module.exports = router;
