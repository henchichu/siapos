const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { hasPermission } = require("./pin");
const { requirePermission } = require("./session");
const { myLocations } = require("./locations");
const { applyApproval } = require("./approvals");

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

// The rules a shift must keep (they were database triggers): its pay period is open, its clock-in falls in that period by the
// café's local date, and it overlaps none of the person's other shifts. Lock the pay period, then the employee, so requests for the
// same person run one after the other, so neither can slip past the other's check. Call it inside pool.tx, before the write.
// clockIn and clockOut are UTC (a Date, or null for a shift still running). Clocking out, taking a break and approving change
// nothing these rules look at, so they don't call it.
async function checkShift(conn, { id = "", employeeId, locationId, payPeriodId, clockIn, clockOut }) {
  await conn.query("SELECT PayPeriodID FROM PayPeriod WHERE PayPeriodID = ? FOR SHARE", [payPeriodId]);
  await conn.query("SELECT EmployeeID FROM Employee WHERE EmployeeID = ? FOR UPDATE", [employeeId]);
  const [[p]] = await conn.query(
    `SELECT pp.Closed AS closed, DATE(CONVERT_TZ(?, '+00:00', l.TimeZone)) BETWEEN pp.StartDate AND pp.EndDate AS inside
       FROM PayPeriod pp JOIN Location l ON l.LocationID = ? WHERE pp.PayPeriodID = ?`,
    [clockIn, locationId, payPeriodId]
  );
  if (!p) throw new HttpError(404, "Pay period not found.");
  if (p.closed) throw new HttpError(409, "That pay period is closed.");
  if (!p.inside) throw new HttpError(409, "The clock-in falls outside the pay period.");
  const [[o]] = await conn.query(
    `SELECT EXISTS (SELECT 1 FROM TimeEntry WHERE EmployeeID = ? AND TimeEntryID <> ?
                       AND ClockInAt < COALESCE(?, '9999-12-31') AND ? < COALESCE(ClockOutAt, '9999-12-31')) AS overlap`,
    [employeeId, id, clockOut, clockIn]
  );
  if (o.overlap) throw new HttpError(409, "That shift overlaps another shift for this person.");
}

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

router.post("/shift/clock-in", async (req, res) => {
  const { businessId, locationId, employeeId } = req.session;
  const period = await periodAt(businessId, locationId);
  if (!period) throw new HttpError(409, "No pay period covers today. Ask a manager to set one up.");
  await pool.tx(async (conn) => {
    const [[{ now }]] = await conn.query("SELECT UTC_TIMESTAMP() AS now");
    // checkShift locks the employee first, then the open-shift check below is safe from a second click or screen
    await checkShift(conn, { employeeId, locationId, payPeriodId: period.id, clockIn: now, clockOut: null });
    const [[already]] = await conn.query("SELECT 1 AS yes FROM TimeEntry WHERE EmployeeID = ? AND TimeEntryStatusCode = ?", [employeeId, OPEN]);
    if (already) throw new HttpError(409, "You are already clocked in.");
    await conn.query(
      `INSERT INTO TimeEntry (TimeEntryID, EmployeeID, LocationID, BusinessID, PayPeriodID, ClockInAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), employeeId, locationId, businessId, period.id, now]
    );
  });
  res.json({ ok: true });
});

const clockAction = action => async (req, res) => {
  await pool.tx(conn => conn.query("CALL ChangeTimeEntry(?, ?, ?)", [req.session.businessId, req.session.employeeId, action]));
  res.json({ ok: true });
};
router.post("/shift/break-start", clockAction("BREAK_START"));
router.post("/shift/break-end", clockAction("BREAK_END"));
router.post("/shift/clock-out", clockAction("CLOCK_OUT"));
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

const decide = action => async (req, res) => {
  await pool.tx(conn => applyApproval(conn, req.session, action, String(req.params.id)));
  res.json({ ok: true });
};
router.post("/team/timecards/:id/approve", requirePermission(PERM_APPROVE), decide("TIMECARD_APPROVE"));
router.post("/team/timecards/:id/reject", requirePermission(PERM_APPROVE), decide("TIMECARD_REJECT"));

router.post("/team/timecards/approve-all", requirePermission(PERM_APPROVE), async (req, res) => {
  const mine = await myLocations(req.session.employeeId);
  const scope = mine.includes(req.body.locationId) ? [req.body.locationId] : mine;
  if (!scope.length) return res.json({ approved: 0 });
  const approved = await pool.tx(async conn => {
    const [entries] = await conn.query(
      `SELECT TimeEntryID FROM TimeEntry WHERE BusinessID = ? AND PayPeriodID = ? AND LocationID IN (?) AND TimeEntryStatusCode = ?
       ORDER BY EmployeeID, TimeEntryID`,
      [req.session.businessId, String(req.body.payPeriodId), scope, SUBMITTED]);
    for (const entry of entries) await applyApproval(conn, req.session, "TIMECARD_APPROVE", entry.TimeEntryID);
    return entries.length;
  });
  res.json({ approved });
});
// Manual correction. The times arrive as the café's local "YYYY-MM-DDTHH:mm"; a corrected card goes back to Submitted
const LOCAL = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
router.post("/team/timecards/:id/edit", requirePermission(PERM_APPROVE), async (req, res) => {
  const { businessId, employeeId } = req.session;
  const { clockIn, clockOut } = req.body;
  const brk = Number(req.body.breakMinutes);
  if (!LOCAL.test(clockIn) || !LOCAL.test(clockOut)) throw new HttpError(400, "Enter both times.");
  if (!Number.isInteger(brk) || brk < 0) throw new HttpError(400, "Break must be a whole number of minutes.");

  await pool.tx(conn => applyApproval(conn, req.session, "TIMECARD_EDIT", String(req.params.id), {
    clockIn: clockIn.replace("T", " "), clockOut: clockOut.replace("T", " "), breakMinutes: brk,
  }));
  res.json({ ok: true });
});

// Closing freezes the whole period (an edit to one of its shifts is refused, see checkShift), so nothing may still be waiting
router.post("/team/pay-periods/:id/close", requirePermission(PERM_APPROVE), async (req, res) => {
  const finalized = await pool.tx(async conn => {
    await applyApproval(conn, req.session, "PAY_PERIOD_CLOSE", String(req.params.id));
    const [[result]] = await conn.query("SELECT COUNT(*) AS n FROM TimeEntry WHERE PayPeriodID = ? AND TimeEntryStatusCode = ?", [req.params.id, APPROVED]);
    return Number(result.n);
  });
  res.json({ finalized, message: "Success: Pay period successfully finalized and closed" });
});

module.exports = router;
