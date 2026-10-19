const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { hasPermission } = require("./pin");
const { requirePermission } = require("./session");
const { myLocations } = require("./locations");

const PERM_SEE_TEAM = 17;
const PERM_APPROVE = 18;
const OPEN = 1, SUBMITTED = 2, APPROVED = 3, REJECTED = 4;
const STATUS_CODES = { OPEN, SUBMITTED, APPROVED, REJECTED };

const router = express.Router();

// ---- shared helpers -------------------------------------------------------------------------------------------

const ENTRY_SQL = `
  SELECT te.TimeEntryID AS id, te.EmployeeID AS employeeId, CONCAT(e.FirstName, ' ', e.LastName) AS employee,
         l.Name AS location, l.TimeZone AS timeZone, te.ClockInAt AS clockInAt, te.ClockOutAt AS clockOutAt,
         te.UnpaidBreakMinutes AS breakMinutes, te.BreakStartedAt AS breakStartedAt,
         te.TimeEntryStatusCode AS statusCode, s.Description AS status,
         CONCAT(a.FirstName, ' ', a.LastName) AS approvedBy,
         DATE_FORMAT(CONVERT_TZ(te.ClockInAt, '+00:00', l.TimeZone), '%Y-%m-%d') AS localDate,
         (SELECT r.HourlyRate FROM EmployeePayRate r
           WHERE r.EmployeeID = te.EmployeeID AND r.EffectiveFrom <= te.ClockInAt
             AND (r.EffectiveTo IS NULL OR r.EffectiveTo > te.ClockInAt) LIMIT 1) AS rate
    FROM TimeEntry te
    JOIN Employee e ON e.EmployeeID = te.EmployeeID
    JOIN Location l ON l.LocationID = te.LocationID
    JOIN TimeEntryStatus s ON s.TimeEntryStatusCode = te.TimeEntryStatusCode
    LEFT JOIN Employee a ON a.EmployeeID = te.ApprovedByEmployeeID`;

// Paid minutes: time on the clock less breaks (a break still running counts as break)
function workedMinutes(r, now) {
  let m = ((r.clockOutAt || now) - r.clockInAt) / 60000 - r.breakMinutes;
  if (!r.clockOutAt && r.breakStartedAt) m -= (now - r.breakStartedAt) / 60000;
  return Math.max(0, m);
}
const toHours = (minutes) => Math.round((minutes / 60) * 100) / 100;

const row = (r, now) => ({
  id: r.id, employee: r.employee, location: r.location, timeZone: r.timeZone,
  clockInAt: r.clockInAt, clockOutAt: r.clockOutAt, breakMinutes: r.breakMinutes, onBreak: !!r.breakStartedAt,
  hours: r.clockOutAt ? toHours(workedMinutes(r, now)) : null,
  status: r.status, approvedBy: r.status === "APPROVED" ? r.approvedBy : null, rate: r.rate == null ? null : Number(r.rate),
});

const periodAt = async (businessId, locationId) => {
  const [[p]] = await pool.query(
    `SELECT pp.PayPeriodID AS id, DATE_FORMAT(pp.StartDate, '%Y-%m-%d') AS start, DATE_FORMAT(pp.EndDate, '%Y-%m-%d') AS end, pp.Closed AS closed
       FROM PayPeriod pp JOIN Location l ON l.LocationID = ?
      WHERE pp.BusinessID = ? AND DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', l.TimeZone)) BETWEEN pp.StartDate AND pp.EndDate`,
    [locationId, businessId]
  );
  return p;
};

// ---- My shift (everyone) --------------------------------------------------------------------------------------

router.get("/shift", async (req, res) => {
  const { businessId, locationId, employeeId } = req.session;
  const now = new Date();
  const [[day]] = await pool.query(
    `SELECT l.Name AS location, l.TimeZone AS timeZone,
            DATE_FORMAT(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', l.TimeZone)), '%Y-%m-%d') AS today,
            DATE_FORMAT(DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', l.TimeZone)),
                                 INTERVAL WEEKDAY(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', l.TimeZone)) DAY), '%Y-%m-%d') AS weekStart
       FROM Location l WHERE l.LocationID = ?`,
    [locationId]
  );
  const period = await periodAt(businessId, locationId);
  const [entries] = await pool.query(
    `${ENTRY_SQL} WHERE te.EmployeeID = ? AND (te.PayPeriodID = ? OR te.TimeEntryStatusCode = ? OR
        DATE(CONVERT_TZ(te.ClockInAt, '+00:00', l.TimeZone)) >= ?) ORDER BY te.ClockInAt DESC`,
    [employeeId, period?.id || "", OPEN, day.weekStart]
  );

  const sum = (list) => toHours(list.reduce((a, r) => a + workedMinutes(r, now), 0));
  const inPeriod = entries.filter((r) => period && r.localDate >= period.start && r.localDate <= period.end);
  const periodRows = inPeriod.map((r) => row(r, now));
  const open = entries.find((r) => r.statusCode === OPEN);
  const rated = inPeriod.filter((r) => r.clockOutAt && r.rate != null);
  const [[rate]] = await pool.query(
    `SELECT HourlyRate AS rate FROM EmployeePayRate
      WHERE EmployeeID = ? AND EffectiveFrom <= UTC_TIMESTAMP() AND (EffectiveTo IS NULL OR EffectiveTo > UTC_TIMESTAMP()) LIMIT 1`,
    [employeeId]
  );
  const [[sales]] = await pool.query(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(t.net), 0) AS net, COALESCE(SUM(t.items), 0) AS items
       FROM (SELECT o.OrderID,
                    (SELECT SUM(NetAmount) FROM OrderItem WHERE OrderID = o.OrderID) AS net,
                    (SELECT SUM(Quantity) FROM OrderItem WHERE OrderID = o.OrderID) AS items
               FROM Orders o JOIN Location l ON l.LocationID = o.LocationID
              WHERE o.LocationID = ? AND o.OrderStatusCode IN (2, 3, 4, 5)
                AND DATE(CONVERT_TZ(o.OrderDateTime, '+00:00', l.TimeZone)) = ?) t`,
    [locationId, day.today]
  );

  res.json({
    now,
    employee: req.session.info.employeeName,
    role: req.session.info.roleName,
    location: day.location,
    timeZone: day.timeZone,
    open: open ? { clockInAt: open.clockInAt, onBreak: !!open.breakStartedAt, breakMinutes: open.breakMinutes } : null,
    hours: {
      today: sum(entries.filter((r) => r.localDate === day.today)),
      week: sum(entries.filter((r) => r.localDate >= day.weekStart)),
      period: sum(inPeriod),
    },
    sales: { orders: sales.orders, netCents: Math.round(Number(sales.net) * 100), items: Number(sales.items) },
    period: period ? { start: period.start, end: period.end } : null,
    entries: periodRows,
    totalHours: Math.round(periodRows.reduce((a, r) => a + (r.hours || 0), 0) * 100) / 100,
    rate: rate ? Number(rate.rate) : null,
    estimatedCents: Math.round(rated.reduce((a, r) => a + toHours(workedMinutes(r, now)) * Number(r.rate), 0) * 100),
    canTeam: await hasPermission(pool, employeeId, PERM_SEE_TEAM),
  });
});

// Each action is one UPDATE guarded by the state it needs, so a double click or a second screen can't repeat it
const changed = (r, message) => { if (!r.affectedRows) throw new HttpError(409, message); };

router.post("/shift/clock-in", async (req, res) => {
  const { businessId, locationId, employeeId } = req.session;
  const [[already]] = await pool.query("SELECT 1 AS yes FROM TimeEntry WHERE EmployeeID = ? AND TimeEntryStatusCode = ?", [employeeId, OPEN]);
  if (already) throw new HttpError(409, "You are already clocked in.");
  const period = await periodAt(businessId, locationId);
  if (!period) throw new HttpError(409, "No pay period covers today. Ask a manager to set one up.");
  await pool.query(
    `INSERT INTO TimeEntry (TimeEntryID, EmployeeID, LocationID, BusinessID, PayPeriodID, ClockInAt, TimeEntryStatusCode)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
    [crypto.randomUUID(), employeeId, locationId, businessId, period.id, OPEN]
  );
  res.json({ ok: true });
});

router.post("/shift/break-start", async (req, res) => {
  const [r] = await pool.query(
    `UPDATE TimeEntry SET BreakStartedAt = UTC_TIMESTAMP()
      WHERE EmployeeID = ? AND TimeEntryStatusCode = ? AND ClockOutAt IS NULL AND BreakStartedAt IS NULL`,
    [req.session.employeeId, OPEN]
  );
  changed(r, "You can only start a break while clocked in and not on one.");
  res.json({ ok: true });
});

// Minutes are added to the shift's running total; the first assignment still sees the old BreakStartedAt
const BREAK_MINUTES = "ROUND(TIMESTAMPDIFF(SECOND, BreakStartedAt, UTC_TIMESTAMP()) / 60)";

router.post("/shift/break-end", async (req, res) => {
  const [r] = await pool.query(
    `UPDATE TimeEntry SET UnpaidBreakMinutes = UnpaidBreakMinutes + ${BREAK_MINUTES}, BreakStartedAt = NULL
      WHERE EmployeeID = ? AND TimeEntryStatusCode = ? AND ClockOutAt IS NULL AND BreakStartedAt IS NOT NULL`,
    [req.session.employeeId, OPEN]
  );
  changed(r, "No break is running.");
  res.json({ ok: true });
});

// Clocking out during a break ends the break first, then submits the shift for approval
router.post("/shift/clock-out", async (req, res) => {
  const [r] = await pool.query(
    `UPDATE TimeEntry SET UnpaidBreakMinutes = UnpaidBreakMinutes + COALESCE(${BREAK_MINUTES}, 0), BreakStartedAt = NULL,
            ClockOutAt = UTC_TIMESTAMP(), TimeEntryStatusCode = ?
      WHERE EmployeeID = ? AND TimeEntryStatusCode = ? AND ClockOutAt IS NULL AND ClockInAt < UTC_TIMESTAMP()`,
    [SUBMITTED, req.session.employeeId, OPEN]
  );
  changed(r, "You are not clocked in, or the shift started less than a second ago.");
  res.json({ ok: true });
});

// ---- Team timecards (permission 17 to see, 18 to change) ------------------------------------------------------

router.get("/team/timecards", requirePermission(PERM_SEE_TEAM), async (req, res) => {
  const { businessId, locationId, employeeId } = req.session;
  const mine = await myLocations(employeeId);
  const [periods] = await pool.query(
    `SELECT PayPeriodID AS id, DATE_FORMAT(StartDate, '%Y-%m-%d') AS start, DATE_FORMAT(EndDate, '%Y-%m-%d') AS end, Closed AS closed
       FROM PayPeriod WHERE BusinessID = ? ORDER BY StartDate DESC`,
    [businessId]
  );
  const [locations] = await pool.query("SELECT LocationID AS id, Name AS name FROM Location WHERE LocationID IN (?) ORDER BY Name", [mine]);

  const current = await periodAt(businessId, locationId);
  const period = periods.find((p) => p.id === req.query.payPeriodId) || periods.find((p) => p.id === current?.id) || periods[0];
  if (!period) return res.json({ filters: { periods, locations }, selected: {}, rows: [], waiting: 0, period: null, canApprove: false });
  const place = locations.find((l) => l.id === req.query.locationId);
  const scope = place ? [place.id] : mine;
  const status = STATUS_CODES[String(req.query.status).toUpperCase()];

  const now = new Date();
  const [entries] = await pool.query(
    `${ENTRY_SQL} WHERE te.BusinessID = ? AND te.PayPeriodID = ? AND te.LocationID IN (?) ${status ? "AND te.TimeEntryStatusCode = ?" : ""}
      ORDER BY te.ClockInAt DESC, employee`,
    status ? [businessId, period.id, scope, status] : [businessId, period.id, scope]
  );
  const [[{ waiting }]] = await pool.query(
    "SELECT COUNT(*) AS waiting FROM TimeEntry WHERE BusinessID = ? AND PayPeriodID = ? AND LocationID IN (?) AND TimeEntryStatusCode = ?",
    [businessId, period.id, scope, SUBMITTED]
  );

  res.json({
    now,
    filters: { periods, locations },
    selected: { payPeriodId: period.id, locationId: place?.id || "all", status: status ? req.query.status.toUpperCase() : "ALL" },
    period,
    rows: entries.map((r) => row(r, now)),
    waiting,
    canApprove: await hasPermission(pool, employeeId, PERM_APPROVE),
  });
});

const decide = (to) => async (req, res) => {
  const { businessId, employeeId } = req.session;
  const [r] = await pool.query(
    `UPDATE TimeEntry SET TimeEntryStatusCode = ?, ApprovedByEmployeeID = ?
      WHERE TimeEntryID = ? AND BusinessID = ? AND LocationID IN (?) AND TimeEntryStatusCode = ?`,
    [to, to === APPROVED ? employeeId : null, req.params.id, businessId, await myLocations(employeeId), SUBMITTED]
  );
  changed(r, "That timecard is no longer waiting for approval.");
  res.json({ ok: true });
};
router.post("/team/timecards/:id/approve", requirePermission(PERM_APPROVE), decide(APPROVED));
router.post("/team/timecards/:id/reject", requirePermission(PERM_APPROVE), decide(REJECTED));

// One statement over the rows the manager is looking at (pay period and location), so it all happens or none of it does
router.post("/team/timecards/approve-all", requirePermission(PERM_APPROVE), async (req, res) => {
  const { businessId, employeeId } = req.session;
  const mine = await myLocations(employeeId);
  const scope = mine.includes(req.body.locationId) ? [req.body.locationId] : mine;
  const [r] = await pool.query(
    `UPDATE TimeEntry SET TimeEntryStatusCode = ?, ApprovedByEmployeeID = ?
      WHERE BusinessID = ? AND PayPeriodID = ? AND LocationID IN (?) AND TimeEntryStatusCode = ?`,
    [APPROVED, employeeId, businessId, String(req.body.payPeriodId), scope, SUBMITTED]
  );
  res.json({ approved: r.affectedRows });
});

// Manual correction. The times arrive as the café's local "YYYY-MM-DDTHH:mm"; a corrected card goes back to Submitted
const LOCAL = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
router.post("/team/timecards/:id/edit", requirePermission(PERM_APPROVE), async (req, res) => {
  const { businessId, employeeId } = req.session;
  const { clockIn, clockOut } = req.body;
  const brk = Number(req.body.breakMinutes);
  if (!LOCAL.test(clockIn) || !LOCAL.test(clockOut)) throw new HttpError(400, "Enter both times.");
  if (!Number.isInteger(brk) || brk < 0) throw new HttpError(400, "Break must be a whole number of minutes.");

  const [[entry]] = await pool.query(
    `SELECT l.TimeZone AS tz FROM TimeEntry te JOIN Location l ON l.LocationID = te.LocationID
      WHERE te.TimeEntryID = ? AND te.BusinessID = ? AND te.LocationID IN (?) AND te.TimeEntryStatusCode IN (?, ?)`,
    [req.params.id, businessId, await myLocations(employeeId), SUBMITTED, REJECTED]
  );
  if (!entry) throw new HttpError(409, "That timecard can't be edited.");
  const [[span]] = await pool.query(
    "SELECT TIMESTAMPDIFF(MINUTE, CONVERT_TZ(?, ?, '+00:00'), CONVERT_TZ(?, ?, '+00:00')) AS minutes",
    [clockIn.replace("T", " "), entry.tz, clockOut.replace("T", " "), entry.tz]
  );
  if (!(span.minutes > 0)) throw new HttpError(400, "Clock out must be after clock in.");
  if (brk > span.minutes) throw new HttpError(400, "Break can't be longer than the shift.");

  await pool.query(
    `UPDATE TimeEntry SET ClockInAt = CONVERT_TZ(?, ?, '+00:00'), ClockOutAt = CONVERT_TZ(?, ?, '+00:00'),
            UnpaidBreakMinutes = ?, BreakStartedAt = NULL, TimeEntryStatusCode = ?, ApprovedByEmployeeID = NULL
      WHERE TimeEntryID = ?`,
    [clockIn.replace("T", " "), entry.tz, clockOut.replace("T", " "), entry.tz, brk, SUBMITTED, req.params.id]
  );
  res.json({ ok: true });
});

// Closing freezes the whole period (the database refuses any later change to its shifts), so nothing may still be waiting
router.post("/team/pay-periods/:id/close", requirePermission(PERM_APPROVE), async (req, res) => {
  const { businessId, locationId } = req.session;
  const finalized = await pool.tx(async (conn) => {
    const [[p]] = await conn.query(
      `SELECT pp.Closed AS closed, pp.EndDate < DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', l.TimeZone)) AS ended
         FROM PayPeriod pp JOIN Location l ON l.LocationID = ? WHERE pp.PayPeriodID = ? AND pp.BusinessID = ? FOR UPDATE`,
      [locationId, req.params.id, businessId]
    );
    if (!p) throw new HttpError(404, "Pay period not found.");
    if (p.closed) throw new HttpError(409, "This pay period is already closed.");
    if (!p.ended) throw new HttpError(409, "This pay period hasn't ended yet.");
    const [[{ waiting }]] = await conn.query(
      "SELECT COUNT(*) AS waiting FROM TimeEntry WHERE PayPeriodID = ? AND TimeEntryStatusCode IN (?, ?)", [req.params.id, OPEN, SUBMITTED]
    );
    if (waiting) throw new HttpError(409, `${waiting} timecard${waiting === 1 ? " is" : "s are"} still open or waiting for approval. Approve or reject ${waiting === 1 ? "it" : "them"} first.`);
    const [[{ finalized }]] = await conn.query(
      "SELECT COUNT(*) AS finalized FROM TimeEntry WHERE PayPeriodID = ? AND TimeEntryStatusCode = ?", [req.params.id, APPROVED]
    );
    await conn.query("UPDATE PayPeriod SET Closed = TRUE WHERE PayPeriodID = ?", [req.params.id]);
    return finalized;
  });
  res.json({ finalized, message: "Success: Pay period successfully finalized and closed" });
});

module.exports = router;
