const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { requirePermission } = require("./session");
const { hasPermission } = require("./pin");
const { LOSS_REASONS } = require("./attention");
const { mondayOf, splitOvertime, shiftPay } = require("./overtime");
const { isDate } = require("./dates");
const { cents } = require("./pricing");
const { rfm, AT_RISK_MIN_DAYS, LAPSED_MIN_DAYS } = require("./rfm");

const PERM_REPORTS = 20;
const PERM_COSTS = 13;
const PERM_TEAM = 17; // pay is on the team's timecards
const COUNTED = [2, 3]; // submitted and approved shifts; open and rejected ones aren't paid
const PAID = [2, 3, 4, 5, 7]; // confirmed, preparing, ready, completed, refunded: money was taken. Pending and cancelled never count.
const VISITS = [2, 3, 4, 5]; // PAID without refunded: an order refunded in full doesn't count as a customer's visit
const REFUND_DONE = 2;
const SALE = 2;
const TIPPED = [2, 3, 5]; // authorized, completed, refunded payments: not pending or failed
// The stock losses staff report, under the names Manager To-Do uses. Count corrections and adjustments aren't losses.
const REASONS = { broken: 5, spoiled: 6, stolen: 7 }; // the same keys the Inventory page sends
const MAX_DAYS = 366, MAX_REVENUE_DAYS = 3660; // Revenue history may span years

const router = express.Router();
router.use("/reports", requirePermission(PERM_REPORTS));

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

// Reports cover the one location the person signed in to
async function places(session) {
  const [rows] = await pool.query(
    "SELECT LocationID AS id, Name AS name, TimeZone AS timeZone FROM Location WHERE BusinessID = ? AND Active AND LocationID = ? ORDER BY Name",
    [session.businessId, session.locationId]
  );
  return { locations: rows };
}

// The ?location= asked for, which can only be the location they signed in to
async function scope(req) {
  const { locations } = await places(req.session);
  const asked = String(req.query.location || "");
  const one = locations.find((l) => l.id === (asked || req.session.locationId));
  if (!one) throw new HttpError(403, "You can only see reports for your own location.");
  return { locations, chosen: [one] };
}

// Today's date where the café is, so a default range ends on the café's today, not the server's
async function today(timeZone) {
  const [[r]] = await pool.query("SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%Y-%m-%d') AS d", [timeZone]);
  return r.d;
}

// From and To are the café's local calendar days, both included
async function range(req, timeZone, maxDays = MAX_DAYS) {
  const to = req.query.to ? String(req.query.to) : await today(timeZone);
  const from = req.query.from ? String(req.query.from) : addDays(to, -6);
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, "Choose a From and a To date.");
  if (from > to) throw new HttpError(400, "From must be on or before To.");
  if (daysBetween(from, to) >= maxDays) throw new HttpError(400, `Choose a range of ${maxDays} days or fewer.`);
  return { from, to };
}

// Pay periods, newest first. The one holding today comes up first in the list's place.
async function payPeriods(businessId, day) {
  const [rows] = await pool.query(
    `SELECT PayPeriodID AS id, DATE_FORMAT(StartDate, '%Y-%m-%d') AS start, DATE_FORMAT(EndDate, '%Y-%m-%d') AS end, Closed AS closed
       FROM PayPeriod WHERE BusinessID = ? ORDER BY StartDate DESC`, [businessId]);
  const list = rows.map((p) => ({ ...p, closed: !!p.closed }));
  return { list, current: (list.find((p) => p.start <= day && day <= p.end) || list.find((p) => p.start <= day) || list[0])?.id || null };
}

// The business's categories; "none" stands for products with no category
async function categories(businessId) {
  const [rows] = await pool.query("SELECT CategoryID AS id, Name AS name FROM Category WHERE BusinessID = ? ORDER BY Name", [businessId]);
  return rows;
}

// The business's membership tiers, lowest first; "none" stands for customers with no active loyalty account
const NO_MEMBERSHIP = { id: "none", name: "No membership" };
async function tiers(businessId) {
  const [rows] = await pool.query("SELECT TierID AS id, Name AS name FROM MembershipTier WHERE BusinessID = ? ORDER BY MinimumPoints, Name", [businessId]);
  return rows;
}

router.get("/reports/options", async (req, res) => {
  const { locations } = await places(req.session);
  const home = locations.find((l) => l.id === req.session.locationId) || locations[0];
  const day = await today(home?.timeZone || "UTC");
  const periods = await payPeriods(req.session.businessId, day);
  res.json({
    locations: locations.map(({ id, name }) => ({ id, name })),
    location: home?.id,
    today: day,
    payPeriods: periods.list,
    payPeriod: periods.current,
    seesLabor: await hasPermission(pool, req.session.employeeId, PERM_TEAM),
    categories: await categories(req.session.businessId),
    tiers: [...(await tiers(req.session.businessId)), NO_MEMBERSHIP],
    reasons: Object.entries(REASONS).map(([id, code]) => ({ id, name: LOSS_REASONS[code] })),
    seesCosts: await hasPermission(pool, req.session.employeeId, PERM_COSTS),
  });
});

// Sales per day and location. Sales count on the day the order was paid, refunds on the day the money went back,
// each in that location's own time zone. Labor cost sets its net sales against it.
async function salesByDay(businessId, chosen, from, to) {
  const ids = chosen.map((l) => l.id);
  // a day either side in UTC, then the exact local day per location
  const near = [addDays(from, -1), addDays(to, 2)];

  const [sales] = await pool.query(
    `SELECT o.LocationID AS loc, DATE_FORMAT(CONVERT_TZ(o.OrderDateTime, '+00:00', l.TimeZone), '%Y-%m-%d') AS day,
            COUNT(DISTINCT o.OrderID) AS orders, SUM(oi.NetAmount + oi.DiscountAmount) AS gross,
            SUM(oi.DiscountAmount) AS discounts, SUM(oi.TaxAmount) AS tax
       FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN OrderItem oi ON oi.OrderID = o.OrderID
      WHERE o.BusinessID = ? AND o.LocationID IN (?) AND o.OrderStatusCode IN (?)
        AND o.OrderDateTime >= ? AND o.OrderDateTime < ?
      GROUP BY loc, day HAVING day BETWEEN ? AND ?`,
    [businessId, ids, PAID, ...near, from, to]
  );
  const [refunds] = await pool.query(
    `SELECT o.LocationID AS loc, DATE_FORMAT(CONVERT_TZ(r.RefundDateTime, '+00:00', l.TimeZone), '%Y-%m-%d') AS day,
            SUM(r.Amount - r.TaxAmount) AS refunds, SUM(r.TaxAmount) AS tax
       FROM Refund r JOIN Orders o ON o.OrderID = r.OrderID JOIN Location l ON l.LocationID = o.LocationID
      WHERE r.BusinessID = ? AND o.LocationID IN (?) AND r.RefundStatusCode = ?
        AND r.RefundDateTime >= ? AND r.RefundDateTime < ?
      GROUP BY loc, day HAVING day BETWEEN ? AND ?`,
    [businessId, ids, REFUND_DONE, ...near, from, to]
  );

  const rows = new Map();
  const rowOf = (loc, day) => {
    const key = `${day} ${loc}`;
    if (!rows.has(key)) rows.set(key, { day, location: chosen.find((l) => l.id === loc).name, orders: 0, gross: 0, discounts: 0, refunds: 0, net: 0, tax: 0 });
    return rows.get(key);
  };
  for (const s of sales) Object.assign(rowOf(s.loc, s.day), { orders: Number(s.orders), gross: cents(s.gross), discounts: cents(s.discounts), tax: cents(s.tax) });
  for (const r of refunds) { const row = rowOf(r.loc, r.day); row.refunds = cents(r.refunds); row.tax -= cents(r.tax); }
  for (const row of rows.values()) row.net = row.gross - row.discounts - row.refunds;
  const list = [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.location.localeCompare(b.location));
  const sum = (k) => list.reduce((a, r) => a + r[k], 0);
  return { list, total: { orders: sum("orders"), gross: sum("gross"), discounts: sum("discounts"), refunds: sum("refunds"), net: sum("net"), tax: sum("tax") } };
}

// 2. Top sellers: one ranking by units sold, before refunds. Revenue is after discounts and before tax;
// cost is what the stock cost when each line was sold. Cost and margin only for a role that may see costs.
router.get("/reports/top-sellers", async (req, res) => {
  const { chosen } = await scope(req);
  const { from, to } = await range(req, chosen[0].timeZone);
  const category = String(req.query.category || "");
  const known = await categories(req.session.businessId);
  if (category && category !== "none" && !known.some((c) => c.id === category)) throw new HttpError(400, "Choose a category from the list.");
  const costs = await hasPermission(pool, req.session.employeeId, PERM_COSTS);

  const [rows] = await pool.query(
    `SELECT p.ProductID AS id, p.Name AS product, c.Name AS category, SUM(oi.Quantity) AS units,
            SUM(oi.NetAmount) AS revenue, SUM(oi.LineCost) AS cost
       FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN OrderItem oi ON oi.OrderID = o.OrderID
       JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID
       LEFT JOIN Category c ON c.CategoryID = p.CategoryID
      WHERE o.BusinessID = ? AND o.LocationID IN (?) AND o.OrderStatusCode IN (?)
        AND o.OrderDateTime >= ? AND o.OrderDateTime < ?
        AND DATE_FORMAT(CONVERT_TZ(o.OrderDateTime, '+00:00', l.TimeZone), '%Y-%m-%d') BETWEEN ? AND ?
        ${category === "none" ? "AND p.CategoryID IS NULL" : category ? "AND p.CategoryID = ?" : ""}
      GROUP BY p.ProductID, p.Name, c.Name
      ORDER BY units DESC, revenue DESC, product`,
    [req.session.businessId, chosen.map((l) => l.id), PAID, addDays(from, -1), addDays(to, 2), from, to, ...(category && category !== "none" ? [category] : [])]
  );

  const pct = (margin, revenue) => (revenue ? Math.round((margin / revenue) * 1000) / 10 : null);
  const list = rows.map((r, i) => {
    const revenue = cents(r.revenue), cost = cents(r.cost);
    return { rank: i + 1, product: r.product, category: r.category || "No category", units: Number(r.units), revenue,
      ...(costs && { cost, margin: revenue - cost, marginPct: pct(revenue - cost, revenue) }) };
  });
  const revenue = list.reduce((a, r) => a + r.revenue, 0);
  const cost = costs ? list.reduce((a, r) => a + r.cost, 0) : null;
  const total = { units: Math.round(list.reduce((a, r) => a + r.units, 0) * 1000) / 1000, revenue,
    ...(costs && { cost, margin: revenue - cost, marginPct: pct(revenue - cost, revenue) }) };
  res.json({
    from, to,
    location: chosen[0].name,
    category: category === "none" ? "No category" : known.find((c) => c.id === category)?.name || "All categories",
    seesCosts: costs,
    cards: { units: total.units, revenue, cost, marginPct: costs ? total.marginPct : null },
    rows: list,
    total,
  });
});

// 4. Stock losses: what was reported broken, spoiled or stolen, at the average cost on the day.
// Stock used is everything that left the shelves: what sales used plus what was lost.
router.get("/reports/losses", async (req, res) => {
  const { chosen } = await scope(req);
  const { from, to } = await range(req, chosen[0].timeZone);
  const reason = String(req.query.reason || "");
  if (reason && !REASONS[reason]) throw new HttpError(400, "Choose a reason from the list.");
  const codes = reason ? [REASONS[reason]] : Object.values(REASONS);
  const costs = await hasPermission(pool, req.session.employeeId, PERM_COSTS);
  const window = `t.BusinessID = ? AND t.LocationID IN (?) AND t.TransactionDateTime >= ? AND t.TransactionDateTime < ?
        AND DATE_FORMAT(CONVERT_TZ(t.TransactionDateTime, '+00:00', l.TimeZone), '%Y-%m-%d') BETWEEN ? AND ?`;
  const args = [req.session.businessId, chosen.map((l) => l.id), addDays(from, -1), addDays(to, 2), from, to];

  const [rows] = await pool.query(
    `SELECT s.Name AS item, t.TransactionTypeCode AS type, COUNT(*) AS reports, SUM(-t.QuantityChange) AS amount, u.Symbol AS unit,
            SUM(-t.QuantityChange * t.UnitCost) AS cost
       FROM InventoryTransaction t JOIN Location l ON l.LocationID = t.LocationID
       JOIN StockItem s ON s.StockItemID = t.StockItemID JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
      WHERE ${window} AND t.TransactionTypeCode IN (?)
      GROUP BY s.StockItemID, s.Name, t.TransactionTypeCode, u.Symbol
      ORDER BY cost DESC, item, type`,
    [...args, codes]
  );
  const [[used]] = await pool.query(
    `SELECT SUM(-t.QuantityChange * t.UnitCost) AS cost FROM InventoryTransaction t JOIN Location l ON l.LocationID = t.LocationID
      WHERE ${window} AND t.TransactionTypeCode IN (?)`,
    [...args, [SALE, ...Object.values(REASONS)]]
  );

  const list = rows.map((r) => ({ item: r.item, reason: LOSS_REASONS[r.type], reports: Number(r.reports), amount: Number(r.amount), unit: r.unit, ...(costs && { cost: cents(r.cost) }) }));
  const lost = list.reduce((a, r) => a + (r.cost || 0), 0);
  const reports = list.reduce((a, r) => a + r.reports, 0);
  // the reason reported most often; a tie goes to the costlier one
  const byReason = Object.values(LOSS_REASONS).map((name) => ({ name, n: rows.filter((r) => LOSS_REASONS[r.type] === name).reduce((a, r) => a + Number(r.reports), 0), cost: rows.filter((r) => LOSS_REASONS[r.type] === name).reduce((a, r) => a + Number(r.cost), 0) }))
    .filter((r) => r.n).sort((a, b) => b.n - a.n || b.cost - a.cost);
  const usedCents = cents(used.cost);
  res.json({
    from, to,
    location: chosen[0].name,
    reason: reason ? LOSS_REASONS[REASONS[reason]] : "All reasons",
    seesCosts: costs,
    cards: {
      lost: costs ? lost : null,
      reports,
      lostPct: costs && usedCents ? Math.round((lost / usedCents) * 1000) / 10 : null,
      commonReason: byReason[0]?.name || null,
    },
    rows: list,
    total: { reports, ...(costs && { cost: lost }) },
  });
});

// 5. Customers: RFM for everyone with an order in these dates, as of the To date. Scores compare the customers in this report.
// Spend is what they paid for those orders, after discounts and before tax, less whatever has been refunded on them.
// An order refunded in full isn't a visit, so it isn't counted at all. Guest orders have no customer, so they aren't here.
// Everyone is scored first and the Membership filter applied after, so filtering never changes a customer's scores or segment.
router.get("/reports/customers", async (req, res) => {
  const { chosen } = await scope(req);
  const { from, to } = await range(req, chosen[0].timeZone);
  const { businessId } = req.session;
  const groups = [...(await tiers(businessId)), NO_MEMBERSHIP];
  const tier = String(req.query.tier || "");
  if (tier && !groups.some((g) => g.id === tier)) throw new HttpError(400, "Choose a membership from the list.");
  const window = `o.BusinessID = ? AND o.LocationID IN (?) AND o.OrderStatusCode IN (?)
        AND o.OrderDateTime >= ? AND o.OrderDateTime < ?
        AND DATE_FORMAT(CONVERT_TZ(o.OrderDateTime, '+00:00', l.TimeZone), '%Y-%m-%d') BETWEEN ? AND ?`;
  const args = [businessId, chosen.map((l) => l.id), VISITS, addDays(from, -1), addDays(to, 2), from, to];

  const [rows] = await pool.query(
    `SELECT c.CustomerID AS id, CONCAT_WS(' ', c.FirstName, c.LastName) AS customer, la.TierID AS tierId, COUNT(*) AS orders, MAX(s.day) AS lastOrder,
            SUM(s.sold - COALESCE(r.refunded, 0)) AS spend
       FROM (SELECT o.OrderID, o.CustomerID, DATE_FORMAT(CONVERT_TZ(o.OrderDateTime, '+00:00', l.TimeZone), '%Y-%m-%d') AS day, SUM(oi.NetAmount) AS sold
               FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN OrderItem oi ON oi.OrderID = o.OrderID
              WHERE o.CustomerID IS NOT NULL AND ${window}
              GROUP BY o.OrderID, o.CustomerID, day) s
       JOIN Customer c ON c.CustomerID = s.CustomerID
       LEFT JOIN LoyaltyAccount la ON la.CustomerID = c.CustomerID AND la.Active
       LEFT JOIN (SELECT OrderID, SUM(Amount - TaxAmount) AS refunded FROM Refund WHERE BusinessID = ? AND RefundStatusCode = ? GROUP BY OrderID) r ON r.OrderID = s.OrderID
      GROUP BY c.CustomerID, c.FirstName, c.LastName, la.TierID`,
    [...args, businessId, REFUND_DONE]
  );

  const groupOf = (id) => groups.find((g) => g.id === (id || NO_MEMBERSHIP.id));
  const list = rfm(rows.map((x) => ({ id: x.id, customer: x.customer || "No name given", tierId: groupOf(x.tierId).id, membership: groupOf(x.tierId).name, lastOrder: x.lastOrder, daysSince: daysBetween(x.lastOrder, to), orders: Number(x.orders), spend: cents(x.spend) })))
    .filter((c) => !tier || c.tierId === tier);
  const n = list.length;
  const sum = (k) => list.reduce((a, c) => a + c[k], 0);
  const total = { customers: n, orders: sum("orders"), spend: sum("spend") };
  res.json({
    from, to,
    location: chosen[0].name,
    membership: tier ? groupOf(tier).name : "All memberships",
    minDays: { atRisk: AT_RISK_MIN_DAYS, lapsed: LAPSED_MIN_DAYS },
    byMembership: groups.filter((g) => !tier || g.id === tier).map((g) => {
      const members = list.filter((c) => c.tierId === g.id);
      return { id: g.id, name: g.name, customers: members.length, averageSpend: members.length ? Math.round(members.reduce((a, c) => a + c.spend, 0) / members.length) : null };
    }),
    cards: {
      customers: n,
      averageSpend: n ? Math.round(total.spend / n) : 0,
      averageOrders: n ? Math.round((total.orders / n) * 10) / 10 : 0,
      averageDays: n ? Math.round(sum("daysSince") / n) : 0,
    },
    rows: list,
    total,
  });
});

// 3. Labor cost for one pay period: each person's submitted and approved shifts at the chosen locations, split into
// regular and overtime hours (server/overtime.js), at the pay rate in force when each shift started.
router.get("/reports/labor", async (req, res) => {
  if (!(await hasPermission(pool, req.session.employeeId, PERM_TEAM))) throw new HttpError(403, "Your role can't see team pay.");
  const { chosen } = await scope(req);
  const { businessId } = req.session;
  const [[period]] = await pool.query(
    `SELECT PayPeriodID AS id, DATE_FORMAT(StartDate, '%Y-%m-%d') AS start, DATE_FORMAT(EndDate, '%Y-%m-%d') AS end
       FROM PayPeriod WHERE BusinessID = ? AND PayPeriodID = ?`,
    [businessId, String(req.query.period || (await payPeriods(businessId, await today(chosen[0].timeZone))).current)]
  );
  if (!period) throw new HttpError(400, "Choose a pay period from the list.");
  const ids = chosen.map((l) => l.id);

  // Everyone who worked here this period, and all their shifts in the weeks it touches, wherever they worked,
  // so hours from the neighbouring period or another location count towards the 40
  const [shifts] = await pool.query(
    `SELECT te.TimeEntryID AS id, te.EmployeeID AS employeeId, te.LocationID AS locationId, te.PayPeriodID AS periodId, te.ClockInAt AS clockInAt,
            DATE_FORMAT(CONVERT_TZ(te.ClockInAt, '+00:00', l.TimeZone), '%Y-%m-%d') AS day,
            GREATEST(0, TIMESTAMPDIFF(MINUTE, te.ClockInAt, te.ClockOutAt) - te.UnpaidBreakMinutes) AS minutes,
            (SELECT r.HourlyRate FROM EmployeePayRate r
              WHERE r.EmployeeID = te.EmployeeID AND r.EffectiveFrom <= te.ClockInAt
                AND (r.EffectiveTo IS NULL OR r.EffectiveTo > te.ClockInAt) LIMIT 1) AS rate
       FROM TimeEntry te JOIN Location l ON l.LocationID = te.LocationID
      WHERE te.BusinessID = ? AND te.TimeEntryStatusCode IN (?) AND te.ClockOutAt IS NOT NULL
        AND te.ClockInAt >= ? AND te.ClockInAt < ?
        AND te.EmployeeID IN (SELECT EmployeeID FROM TimeEntry WHERE BusinessID = ? AND PayPeriodID = ? AND LocationID IN (?) AND TimeEntryStatusCode IN (?))`,
    [businessId, COUNTED, addDays(mondayOf(period.start), -1), addDays(mondayOf(period.end), 8), businessId, period.id, ids, COUNTED]
  );
  const [people] = await pool.query(
    `SELECT e.EmployeeID AS id, CONCAT(e.FirstName, ' ', e.LastName) AS name, r.Name AS role
       FROM Employee e JOIN Role r ON r.RoleID = e.RoleID WHERE e.BusinessID = ?`, [businessId]);

  const first = mondayOf(period.start), last = addDays(mondayOf(period.end), 6);
  const counted = splitOvertime(shifts.filter((s) => s.day >= first && s.day <= last).map((s) => ({ ...s, minutes: Number(s.minutes) })))
    .filter((s) => s.periodId === period.id && ids.includes(s.locationId));
  const byPerson = new Map();
  for (const s of counted) {
    const p = byPerson.get(s.employeeId) || { shifts: 0, regular: 0, overtime: 0, pay: 0, rates: new Set(), unpaid: 0 };
    const rate = s.rate == null ? null : cents(s.rate);
    Object.assign(p, { shifts: p.shifts + 1, regular: p.regular + s.regular, overtime: p.overtime + s.overtime, pay: p.pay + (rate == null ? 0 : shiftPay(s, rate)) });
    if (rate == null) p.unpaid++; else p.rates.add(rate);
    byPerson.set(s.employeeId, p);
  }
  const hours = (m) => Math.round((m / 60) * 100) / 100;
  const rows = [...byPerson].map(([id, p]) => {
    const who = people.find((e) => e.id === id);
    const rates = [...p.rates].sort((a, b) => a - b);
    return { employee: who.name, role: who.role, shifts: p.shifts, regularHours: hours(p.regular), overtimeHours: hours(p.overtime),
      rates, noRate: p.unpaid, pay: p.pay };
  }).sort((a, b) => a.employee.localeCompare(b.employee));

  const minutes = counted.reduce((a, s) => a + s.regular + s.overtime, 0);
  const cost = rows.reduce((a, r) => a + r.pay, 0);
  const { total: sales } = await salesByDay(businessId, chosen, period.start, period.end);
  res.json({
    period,
    location: chosen[0].name,
    cards: { hours: hours(minutes), cost, net: sales.net, laborPct: sales.net > 0 ? Math.round((cost / sales.net) * 1000) / 10 : null },
    rows,
    total: { shifts: counted.length, regularHours: hours(counted.reduce((a, s) => a + s.regular, 0)), overtimeHours: hours(counted.reduce((a, s) => a + s.overtime, 0)), pay: cost },
  });
});

// Revenue. Live: one day so far, hour by hour, or each day of its week so far. History (From and To given): each day,
// month or year in the dates. Same measures either way, plus cost of goods, profit and tips.
// The page asks again every minute while a live day is today.
router.get("/reports/revenue", async (req, res) => {
  const { chosen } = await scope(req);
  const history = Boolean(req.query.from);
  let day, from, by;
  if (history) {
    ({ from, to: day } = await range(req, chosen[0].timeZone, MAX_REVENUE_DAYS));
    by = ["month", "year"].includes(req.query.by) ? req.query.by : "day";
  } else {
    day = req.query.day ? String(req.query.day) : await today(chosen[0].timeZone);
    if (!isDate(day)) throw new HttpError(400, "Choose a day.");
    by = req.query.by === "day" ? "day" : "hour";
    from = by === "day" ? mondayOf(day) : day;
  }
  const costs = await hasPermission(pool, req.session.employeeId, PERM_COSTS);
  const { businessId } = req.session;
  const ids = chosen.map((l) => l.id);
  const near = [addDays(from, -1), addDays(day, 2)];
  const local = (col) => `CONVERT_TZ(${col}, '+00:00', l.TimeZone)`;
  const FORMAT = { day: "%Y-%m-%d", month: "%Y-%m", year: "%Y" };
  const bucket = (col) => (by === "hour" ? `HOUR(${local(col)})` : `DATE_FORMAT(${local(col)}, '${FORMAT[by]}')`);

  const [sales] = await pool.query(
    `SELECT ${bucket("o.OrderDateTime")} AS k, COUNT(DISTINCT o.OrderID) AS orders, SUM(oi.NetAmount + oi.DiscountAmount) AS gross,
            SUM(oi.DiscountAmount) AS discounts, SUM(oi.LineCost) AS cost
       FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN OrderItem oi ON oi.OrderID = o.OrderID
      WHERE o.BusinessID = ? AND o.LocationID IN (?) AND o.OrderStatusCode IN (?)
        AND o.OrderDateTime >= ? AND o.OrderDateTime < ?
        AND DATE_FORMAT(${local("o.OrderDateTime")}, '%Y-%m-%d') BETWEEN ? AND ?
      GROUP BY k`,
    [businessId, ids, PAID, ...near, from, day]
  );
  const [refunds] = await pool.query(
    `SELECT ${bucket("r.RefundDateTime")} AS k, SUM(r.Amount - r.TaxAmount) AS refunds
       FROM Refund r JOIN Orders o ON o.OrderID = r.OrderID JOIN Location l ON l.LocationID = o.LocationID
      WHERE r.BusinessID = ? AND o.LocationID IN (?) AND r.RefundStatusCode = ?
        AND r.RefundDateTime >= ? AND r.RefundDateTime < ?
        AND DATE_FORMAT(${local("r.RefundDateTime")}, '%Y-%m-%d') BETWEEN ? AND ?
      GROUP BY k`,
    [businessId, ids, REFUND_DONE, ...near, from, day]
  );
  // Tips ride on the payment, never in the sale; they count with the order they were left on.
  // A refund never gives a tip back, so a refunded payment's tip still counts.
  const [[tips]] = await pool.query(
    `SELECT SUM(p.TipAmount) AS tips FROM Payment p JOIN Orders o ON o.OrderID = p.OrderID JOIN Location l ON l.LocationID = o.LocationID
      WHERE o.BusinessID = ? AND o.LocationID IN (?) AND o.OrderStatusCode IN (?) AND p.PaymentStatusCode IN (?)
        AND o.OrderDateTime >= ? AND o.OrderDateTime < ? AND DATE_FORMAT(${local("o.OrderDateTime")}, '%Y-%m-%d') BETWEEN ? AND ?`,
    [businessId, ids, PAID, TIPPED, ...near, from, day]
  );

  // By hour: every hour from the first sale or refund to the last, the quiet ones too. By day, month and year: every one
  // in the dates, the quiet ones too (a live week starts on Monday).
  const hours = [...sales, ...refunds].map((r) => Number(r.k));
  const months = [];
  for (let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)); `${y}-${String(m).padStart(2, "0")}` <= day.slice(0, 7); m === 12 ? (y++, m = 1) : m++)
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  const keys = by === "day" ? Array.from({ length: daysBetween(from, day) + 1 }, (_, i) => addDays(from, i))
    : by === "month" ? months
    : by === "year" ? Array.from({ length: Number(day.slice(0, 4)) - Number(from.slice(0, 4)) + 1 }, (_, i) => String(Number(from.slice(0, 4)) + i))
    : hours.length ? Array.from({ length: Math.max(...hours) - Math.min(...hours) + 1 }, (_, i) => Math.min(...hours) + i) : [];
  let running = 0;
  const rows = keys.map((k) => {
    const s = sales.find((x) => String(x.k) === String(k)) || {};
    const gross = cents(s.gross), discounts = cents(s.discounts), refundCents = cents(refunds.find((x) => String(x.k) === String(k))?.refunds);
    const net = gross - discounts - refundCents, cost = cents(s.cost);
    running += net;
    return { key: k, orders: Number(s.orders || 0), gross, discounts, refunds: refundCents, net, ...(costs && { cost, profit: net - cost }), runningNet: running };
  });
  const sum = (f) => rows.reduce((a, r) => a + r[f], 0);
  const total = { orders: sum("orders"), gross: sum("gross"), discounts: sum("discounts"), refunds: sum("refunds"), net: sum("net"), ...(costs && { cost: sum("cost"), profit: sum("profit") }) };
  res.json({
    day, by, from,
    isToday: day === (await today(chosen[0].timeZone)),
    location: chosen[0].name,
    timeZone: chosen[0].timeZone,
    updatedAt: new Date().toISOString(),
    seesCosts: costs,
    cards: { gross: total.gross, discounts: total.discounts, refunds: total.refunds, net: total.net, cost: costs ? total.cost : null, profit: costs ? total.profit : null, tips: cents(tips.tips) },
    rows,
    total,
  });
});

module.exports = router;
