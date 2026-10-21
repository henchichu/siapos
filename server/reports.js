const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { hasPermission, isOwner } = require("./pin");
const { requirePermission } = require("./session");
const { myLocations } = require("./locations");
const { LOSS_REASONS } = require("./attention");
const { splitOvertime, shiftPay } = require("./overtime");

const PERM_REPORTS = 20;
const PERM_COSTS = 13;
const PERM_SEE_TEAM = 17;
const SOLD = [2, 3, 4, 5, 7]; // paid orders; a refunded one still counts, its refund is taken off on the day it was paid back
const SUBMITTED = 2, APPROVED = 3;
const SALE = 2, RETURN = 3;
const MAX_DAYS = 366;

const router = express.Router();
router.use("/reports", requirePermission(PERM_REPORTS));

const c = (v) => Math.round(Number(v || 0) * 100);

// ---- dates: calendar days as "YYYY-MM-DD", worked out in UTC so a day never shifts -------------------------------

const DAY = /^\d{4}-\d\d-\d\d$/;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekday = (d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
const validDay = (d) => typeof d === "string" && DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && addDays(d, 0) === d;
function days(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// The From and To dates of a report: the last seven days unless chosen
function dateRange(q, today) {
  const from = q.from || addDays(today, -6), to = q.to || today;
  if (!validDay(from) || !validDay(to)) throw new HttpError(400, "Enter both dates.");
  if (from > to) throw new HttpError(400, "From date must be on or before To date.");
  if (addDays(from, MAX_DAYS) <= to) throw new HttpError(400, `A report covers at most ${MAX_DAYS} days.`);
  return { from, to };
}

// ---- where: everyone reports on the places they work; on Live sales only an owner sees beyond the one they signed in to

async function places(req) {
  const { employeeId, locationId } = req.session;
  const [owner, mine] = await Promise.all([isOwner(employeeId), myLocations(employeeId)]);
  const [rows] = await pool.query(
    `SELECT LocationID AS id, Name AS name, TimeZone AS timeZone,
            DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', TimeZone), '%Y-%m-%d') AS today
       FROM Location WHERE LocationID IN (?) AND Active ORDER BY Name`,
    [mine.length ? mine : [""]]
  );
  const here = rows.find((r) => r.id === locationId);
  return { owner, all: rows, live: owner ? rows : rows.filter((r) => r === here), today: (here || rows[0])?.today || new Date().toISOString().slice(0, 10) };
}

function pick(list, wanted) {
  if (!list.length) throw new HttpError(403, "You don't work at any location.");
  if (!wanted || wanted === "all") return list;
  const one = list.filter((l) => l.id === wanted);
  if (!one.length) throw new HttpError(403, "You can't report on that location.");
  return one;
}
const ids = (list) => list.map((l) => l.id);
const named = (list) => (list.length === 1 ? list[0].name : "All locations");

// ---- the sales figures every sales report is made of -----------------------------------------------------------

// Times are each location's own, so a day or an hour means the same at every café
const local = (col) => `CONVERT_TZ(${col}, '+00:00', l.TimeZone)`;
const KEYS = {
  all: () => "''",
  day: (col) => `DATE_FORMAT(${local(col)}, '%Y-%m-%d')`,
  hour: (col) => `HOUR(${local(col)})`,
  dayLocation: (col) => `CONCAT(DATE_FORMAT(${local(col)}, '%Y-%m-%d'), '|', l.LocationID)`,
};
// Local dates from..to; the UTC bounds a day either side let the date index do the first cut
const within = (col) => `${col} >= ? - INTERVAL 1 DAY AND ${col} < ? + INTERVAL 2 DAY AND DATE(${local(col)}) BETWEEN ? AND ?`;
const span = (from, to) => [from, to, from, to];
const NOT_GIFT_CARDS = "JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID AND NOT p.IsGiftCard";

const blank = () => ({ orders: 0, grossCents: 0, discountCents: 0, refundCents: 0, salesCents: 0, netCents: 0, taxCents: 0, costCents: 0, profitCents: 0, tipCents: 0 });

// Gross is before discounts and net after discounts and refunds, both without tax. A sale counts on the day it was
// rung up, a refund (and the stock cost it puts back) on the day the money went back. Selling a gift card isn't a sale:
// what it is spent on later is.
async function measures(locationIds, from, to, by) {
  const key = KEYS[by];
  const args = [locationIds, ...span(from, to)];
  const [[sales], [tips], [refunds], [returns]] = await Promise.all([
    pool.query(
      `SELECT ${key("o.OrderDateTime")} AS k, COUNT(DISTINCT o.OrderID) AS orders, SUM(oi.NetAmount) AS sales,
              SUM(oi.DiscountAmount) AS discounts, SUM(oi.TaxAmount) AS tax, SUM(COALESCE(oi.LineCost, 0)) AS cost
         FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN OrderItem oi ON oi.OrderID = o.OrderID ${NOT_GIFT_CARDS}
        WHERE o.LocationID IN (?) AND o.OrderStatusCode IN (?) AND ${within("o.OrderDateTime")} GROUP BY k`,
      [locationIds, SOLD, ...span(from, to)]
    ),
    pool.query(
      `SELECT ${key("o.OrderDateTime")} AS k, SUM(p.TipAmount) AS tips
         FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN Payment p ON p.OrderID = o.OrderID AND p.PaymentStatusCode IN (3, 5)
        WHERE o.LocationID IN (?) AND o.OrderStatusCode IN (?) AND ${within("o.OrderDateTime")} GROUP BY k`,
      [locationIds, SOLD, ...span(from, to)]
    ),
    pool.query(
      `SELECT ${key("r.RefundDateTime")} AS k, SUM(r.Amount - r.TaxAmount) AS net, SUM(r.TaxAmount) AS tax
         FROM Refund r JOIN Orders o ON o.OrderID = r.OrderID JOIN Location l ON l.LocationID = o.LocationID
        WHERE o.LocationID IN (?) AND r.RefundStatusCode = 2 AND ${within("r.RefundDateTime")} GROUP BY k`,
      args
    ),
    pool.query(
      `SELECT ${key("t.TransactionDateTime")} AS k, SUM(t.QuantityChange * t.UnitCost) AS cost
         FROM InventoryTransaction t JOIN Location l ON l.LocationID = t.LocationID
        WHERE t.LocationID IN (?) AND t.TransactionTypeCode = ${RETURN} AND ${within("t.TransactionDateTime")} GROUP BY k`,
      args
    ),
  ]);

  const out = new Map();
  const at = (k) => {
    k = String(k);
    if (!out.has(k)) out.set(k, blank());
    return out.get(k);
  };
  for (const r of sales) {
    const m = at(r.k);
    Object.assign(m, { orders: Number(r.orders), salesCents: c(r.sales), discountCents: c(r.discounts) });
    m.taxCents += c(r.tax);
    m.costCents += c(r.cost);
  }
  for (const r of tips) at(r.k).tipCents = c(r.tips);
  for (const r of refunds) { at(r.k).refundCents = c(r.net); at(r.k).taxCents -= c(r.tax); }
  for (const r of returns) at(r.k).costCents -= c(r.cost);
  for (const m of out.values()) {
    m.grossCents = m.salesCents + m.discountCents;
    m.netCents = m.salesCents - m.refundCents;
    m.profitCents = m.netCents - m.costCents;
  }
  return out;
}

const total = (rows) => {
  const t = blank();
  for (const r of rows) for (const k of Object.keys(t)) t[k] += r[k];
  return t;
};

// Costs, profit and margins are only for a role that may see them
const costsFor = (canCosts, fields) => (row) => {
  if (canCosts) return row;
  const out = { ...row };
  for (const f of fields) delete out[f];
  return out;
};
const canSeeCosts = (req) => hasPermission(pool, req.session.employeeId, PERM_COSTS);

// ---- the filters a page needs to draw itself ------------------------------------------------------------------

router.get("/reports/options", async (req, res) => {
  const { employeeId, businessId } = req.session;
  const [p, canCosts, canLabor, [categories]] = await Promise.all([
    places(req),
    canSeeCosts(req),
    hasPermission(pool, employeeId, PERM_SEE_TEAM),
    pool.query("SELECT CategoryID AS id, Name AS name FROM Category WHERE BusinessID = ? AND Active ORDER BY Name", [businessId]),
  ]);
  const brief = (list) => list.map(({ id, name }) => ({ id, name }));
  res.json({
    today: p.today,
    owner: p.owner,
    locations: brief(p.all),
    liveLocations: brief(p.live),
    categories,
    reasons: Object.entries(LOSS_REASONS).map(([code, label]) => ({ code, label })),
    canCosts,
    canLabor,
  });
});

// ---- Live sales: one day by hour, or that day's week so far by day --------------------------------------------

router.get("/reports/live", async (req, res) => {
  const p = await places(req);
  const where = pick(p.live, req.query.locationId);
  const day = req.query.day || p.today;
  if (!validDay(day)) throw new HttpError(400, "Choose a day.");
  const byDay = req.query.view === "day";
  const from = byDay ? addDays(day, -weekday(day)) : day;
  const got = await measures(ids(where), from, day, byDay ? "day" : "hour");

  // No opening hours are stored, so the day runs from its first hour with sales to its last
  let keys = days(from, day);
  if (!byDay) {
    const hours = [...got.keys()].map(Number);
    keys = hours.length ? Array.from({ length: Math.max(...hours) - Math.min(...hours) + 1 }, (_, i) => Math.min(...hours) + i) : [];
  }
  let running = 0;
  const rows = keys.map((k) => {
    const m = got.get(String(k)) || blank();
    running += m.netCents;
    return { key: k, ...m, runningNetCents: running };
  });
  const costs = costsFor(await canSeeCosts(req), ["costCents", "profitCents"]);
  res.json({
    day, today: p.today, view: byDay ? "day" : "hour",
    location: named(where), timeZone: where[0].timeZone, updatedAt: new Date(),
    rows: rows.map(costs), totals: costs(total(rows)),
  });
});

// ---- 1. Sales by day ----------------------------------------------------------------------------------------------

router.get("/reports/sales", async (req, res) => {
  const p = await places(req);
  const where = pick(p.all, req.query.locationId);
  const { from, to } = dateRange(req.query, p.today);
  const got = await measures(ids(where), from, to, "dayLocation");
  const names = new Map(p.all.map((l) => [l.id, l.name]));
  const rows = [...got]
    .map(([k, m]) => { const [date, id] = k.split("|"); return { date, location: names.get(id), ...m }; })
    .sort((a, b) => a.date.localeCompare(b.date) || a.location.localeCompare(b.location));
  const costs = costsFor(false, ["costCents", "profitCents"]); // this report shows no costs
  res.json({
    from, to, location: named(where),
    rows: rows.map(costs),
    totals: costs(total(rows)),
    chart: days(from, to).map((date) => ({ date, netCents: rows.filter((r) => r.date === date).reduce((a, r) => a + r.netCents, 0) })),
  });
});

// ---- 2. Top sellers: one ranking across all products --------------------------------------------------------------

router.get("/reports/top-sellers", async (req, res) => {
  const p = await places(req);
  const where = pick(p.all, req.query.locationId);
  const { from, to } = dateRange(req.query, p.today);
  const category = req.query.categoryId && req.query.categoryId !== "all" ? String(req.query.categoryId) : null;
  const [lines] = await pool.query(
    `SELECT p.Name AS product, cat.Name AS category, SUM(oi.Quantity) AS units, SUM(oi.NetAmount) AS revenue, SUM(COALESCE(oi.LineCost, 0)) AS cost
       FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN OrderItem oi ON oi.OrderID = o.OrderID ${NOT_GIFT_CARDS}
       LEFT JOIN Category cat ON cat.CategoryID = p.CategoryID
      WHERE o.LocationID IN (?) AND o.OrderStatusCode IN (?) AND ${within("o.OrderDateTime")} ${category ? "AND p.CategoryID = ?" : ""}
      GROUP BY p.ProductID, p.Name, cat.Name
      ORDER BY units DESC, revenue DESC, p.Name`,
    [ids(where), SOLD, ...span(from, to), ...(category ? [category] : [])]
  );
  const margin = (revenueCents, costCents) => ({ marginCents: revenueCents - costCents, marginPct: revenueCents ? (revenueCents - costCents) / revenueCents : null });
  const rows = lines.map((l, i) => {
    const revenueCents = c(l.revenue), costCents = c(l.cost);
    return { rank: i + 1, product: l.product, category: l.category, units: Number(l.units), revenueCents, costCents, ...margin(revenueCents, costCents) };
  });
  const sum = (f) => rows.reduce((a, r) => a + r[f], 0);
  const totals = { units: Math.round(sum("units") * 1000) / 1000, revenueCents: sum("revenueCents"), costCents: sum("costCents") };
  const costs = costsFor(await canSeeCosts(req), ["costCents", "marginCents", "marginPct"]);
  res.json({ from, to, location: named(where), rows: rows.map(costs), totals: costs({ ...totals, ...margin(totals.revenueCents, totals.costCents) }) });
});

// ---- 3. Labor cost for one pay period ---------------------------------------------------------------------------

router.get("/reports/labor", requirePermission(PERM_SEE_TEAM), async (req, res) => {
  const { businessId } = req.session;
  const p = await places(req);
  const where = pick(p.all, req.query.locationId);
  const [periods] = await pool.query(
    `SELECT PayPeriodID AS id, DATE_FORMAT(StartDate, '%Y-%m-%d') AS start, DATE_FORMAT(EndDate, '%Y-%m-%d') AS end
       FROM PayPeriod WHERE BusinessID = ? ORDER BY StartDate DESC`,
    [businessId]
  );
  const period = periods.find((x) => x.id === req.query.payPeriodId) || periods.find((x) => x.start <= p.today && p.today <= x.end) || periods[0];
  if (!period) return res.json({ periods, period: null, location: named(where), rows: [], totals: null });

  // Overtime is counted per Monday-to-Sunday week across every location, so the weeks the period touches are read whole,
  // shifts in other pay periods included. Open shifts have no end yet and rejected ones are not paid.
  const weekFrom = addDays(period.start, -weekday(period.start));
  const weekTo = addDays(period.end, 6 - weekday(period.end));
  const [shifts] = await pool.query(
    `SELECT te.EmployeeID AS employeeId, CONCAT(e.FirstName, ' ', e.LastName) AS employee, r.Name AS role,
            te.LocationID AS locationId, te.PayPeriodID AS periodId, te.ClockInAt AS clockInAt, te.ClockOutAt AS clockOutAt,
            te.UnpaidBreakMinutes AS breakMinutes,
            DATE_FORMAT(DATE(${local("te.ClockInAt")}) - INTERVAL WEEKDAY(${local("te.ClockInAt")}) DAY, '%Y-%m-%d') AS week,
            (SELECT pr.HourlyRate FROM EmployeePayRate pr
              WHERE pr.EmployeeID = te.EmployeeID AND pr.EffectiveFrom <= te.ClockInAt
                AND (pr.EffectiveTo IS NULL OR pr.EffectiveTo > te.ClockInAt) LIMIT 1) AS rate
       FROM TimeEntry te JOIN Employee e ON e.EmployeeID = te.EmployeeID JOIN Role r ON r.RoleID = e.RoleID
       JOIN Location l ON l.LocationID = te.LocationID
      WHERE te.BusinessID = ? AND te.TimeEntryStatusCode IN (?, ?) AND te.ClockOutAt IS NOT NULL AND ${within("te.ClockInAt")}
      ORDER BY te.EmployeeID, te.ClockInAt`,
    [businessId, SUBMITTED, APPROVED, ...span(weekFrom, weekTo)]
  );

  const shown = new Set(ids(where));
  for (const s of shifts) s.minutes = Math.max(0, (s.clockOutAt - s.clockInAt) / 60000 - s.breakMinutes);
  const split = splitOvertime(shifts);
  const people = new Map();
  shifts.forEach((s, i) => {
    if (s.periodId !== period.id || !shown.has(s.locationId)) return;
    if (!people.has(s.employeeId)) people.set(s.employeeId, { employee: s.employee, role: s.role, shifts: 0, regular: 0, overtime: 0, pay: 0, rate: null, missingRate: false });
    const e = people.get(s.employeeId);
    e.shifts++;
    e.regular += split[i].regular;
    e.overtime += split[i].overtime;
    if (s.rate == null) e.missingRate = true;
    else {
      e.rate = Number(s.rate); // shifts come in time order, so this ends on the latest rate
      e.pay += shiftPay(split[i], e.rate);
    }
  });
  const hours = (minutes) => Math.round((minutes / 60) * 100) / 100;
  const list = [...people.values()].sort((a, b) => a.employee.localeCompare(b.employee));
  const rows = list.map((e) => ({
    employee: e.employee, role: e.role, shifts: e.shifts,
    regularHours: hours(e.regular), overtimeHours: hours(e.overtime),
    rate: e.rate, payCents: Math.round(e.pay * 100), missingRate: e.missingRate,
  }));
  const sum = (f) => list.reduce((a, e) => a + e[f], 0);
  const payCents = rows.reduce((a, r) => a + r.payCents, 0);
  const netCents = ((await measures(ids(where), period.start, period.end, "all")).get("") || blank()).netCents;
  res.json({
    periods, period, location: named(where), rows,
    totals: {
      shifts: sum("shifts"), regularHours: hours(sum("regular")), overtimeHours: hours(sum("overtime")), hoursWorked: hours(sum("regular") + sum("overtime")),
      payCents, netCents, laborPct: netCents > 0 ? payCents / netCents : null,
    },
  });
});

// ---- 4. Stock losses ----------------------------------------------------------------------------------------------

router.get("/reports/losses", async (req, res) => {
  const p = await places(req);
  const where = pick(p.all, req.query.locationId);
  const { from, to } = dateRange(req.query, p.today);
  const all = Object.keys(LOSS_REASONS).map(Number);
  const reason = Number(req.query.reason);
  if (req.query.reason && req.query.reason !== "all" && !all.includes(reason)) throw new HttpError(400, "Choose a reason from the list.");
  const codes = all.includes(reason) ? [reason] : all;

  const [[lines], [[used]]] = await Promise.all([
    pool.query(
      `SELECT s.Name AS item, t.TransactionTypeCode AS type, COUNT(*) AS reports, SUM(-t.QuantityChange) AS amount, u.Symbol AS unit,
              SUM(-t.QuantityChange * t.UnitCost) AS cost
         FROM InventoryTransaction t JOIN Location l ON l.LocationID = t.LocationID
         JOIN StockItem s ON s.StockItemID = t.StockItemID JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
        WHERE t.LocationID IN (?) AND t.TransactionTypeCode IN (?) AND ${within("t.TransactionDateTime")}
        GROUP BY s.StockItemID, s.Name, t.TransactionTypeCode, u.Symbol
        ORDER BY cost DESC, s.Name`,
      [ids(where), codes, ...span(from, to)]
    ),
    // Stock used: what went out in sales plus every kind of loss, at the cost recorded when it went
    pool.query(
      `SELECT SUM(-t.QuantityChange * t.UnitCost) AS cost
         FROM InventoryTransaction t JOIN Location l ON l.LocationID = t.LocationID
        WHERE t.LocationID IN (?) AND t.TransactionTypeCode IN (?) AND ${within("t.TransactionDateTime")}`,
      [ids(where), [SALE, ...all], ...span(from, to)]
    ),
  ]);
  const rows = lines.map((l) => ({ item: l.item, reason: LOSS_REASONS[l.type], reports: Number(l.reports), amount: Number(l.amount), unit: l.unit, costCents: c(l.cost) }));
  const lostCents = rows.reduce((a, r) => a + r.costCents, 0);
  const usedCents = c(used.cost);
  // The reason with the most reports; a tie goes to the one that cost more
  const byReason = new Map();
  for (const r of rows) {
    const b = byReason.get(r.reason) || { reports: 0, costCents: 0 };
    byReason.set(r.reason, { reports: b.reports + r.reports, costCents: b.costCents + r.costCents });
  }
  const [common] = [...byReason].sort(([, a], [, b]) => b.reports - a.reports || b.costCents - a.costCents);
  const costs = costsFor(await canSeeCosts(req), ["costCents", "lossPct"]);
  res.json({
    from, to, location: named(where),
    rows: rows.map(costs),
    totals: costs({ reports: rows.reduce((a, r) => a + r.reports, 0), costCents: lostCents, lossPct: usedCents > 0 ? lostCents / usedCents : null, commonReason: common?.[0] || null }),
  });
});

module.exports = router;
