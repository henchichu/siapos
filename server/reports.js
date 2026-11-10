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
// The stock losses staff report, under the names Manager's To-Do List uses. Count corrections and adjustments aren't losses.
const REASONS = { broken: 5, spoiled: 6, stolen: 7 }; // the same keys the Inventory page sends
const MAX_DAYS = 366, MAX_REVENUE_DAYS = 3660; // Revenue history may span years

const router = express.Router();
router.use("/reports", requirePermission(PERM_REPORTS));

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

// A timestamp column in the café's own time zone; the query joins Location as l
const local = (col) => `CONVERT_TZ(${col}, '+00:00', l.TimeZone)`;
// The café's local days From to To, both included, for a UTC column: a day either side in UTC, then the exact local day.
// cutoff ('YYYY-MM-DD HH:MM:SS', local) stops at that moment, so part of a day compares with the same part of another.
function within(col, from, to, cutoff) {
  return {
    sql: `${col} >= ? AND ${col} < ? AND DATE_FORMAT(${local(col)}, '%Y-%m-%d') BETWEEN ? AND ?${cutoff ? ` AND ${local(col)} < ?` : ""}`,
    args: [addDays(from, -1), addDays(to, 2), from, to, ...(cutoff ? [cutoff] : [])],
  };
}

// Splits a total in cents into parts weighted by weights, to the cent: the parts always add up to the total exactly.
// Leftover cents go to the parts with the largest fractions.
function apportion(weights, total) {
  if (!weights.length) return [];
  const sum = weights.reduce((a, w) => a + w, 0);
  if (!sum) return weights.map((_, i) => (i === 0 ? total : 0));
  const exact = weights.map((w) => (w * total) / sum);
  const out = exact.map(Math.floor);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let left = total - out.reduce((a, v) => a + v, 0), k = 0; left > 0; left--, k++) out[order[k % order.length][1]]++;
  return out;
}
const pctOf = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const NO_CATEGORY = "No category";

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
const PRODUCT = `JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID`;
const inCategory = (category) => ({
  sql: category === "none" ? "AND p.CategoryID IS NULL" : category ? "AND p.CategoryID = ?" : "",
  args: category && category !== "none" ? [category] : [],
});
async function ranking(businessId, ids, from, to, category, costs) {
  const sold = within("o.OrderDateTime", from, to), cat = inCategory(category);
  const [rows] = await pool.query(
    `SELECT p.ProductID AS id, p.Name AS product, p.CategoryID AS categoryId, c.Name AS category, SUM(oi.Quantity) AS units,
            SUM(oi.NetAmount) AS revenue, SUM(oi.LineCost) AS cost
       ${SOLD} ${PRODUCT} LEFT JOIN Category c ON c.CategoryID = p.CategoryID
      WHERE ${PAID_HERE} AND ${sold.sql} ${cat.sql}
      GROUP BY p.ProductID, p.Name, p.CategoryID, c.Name
      ORDER BY units DESC, revenue DESC, product`,
    [businessId, ids, PAID, ...sold.args, ...cat.args]
  );
  const list = rows.map((r, i) => {
    const revenue = cents(r.revenue), cost = cents(r.cost);
    return { rank: i + 1, id: r.id, product: r.product, categoryId: r.categoryId || "none", category: r.category || NO_CATEGORY, units: Number(r.units), revenue,
      ...(costs && { cost, margin: revenue - cost, marginPct: pctOf(revenue - cost, revenue) }) };
  });
  const revenue = list.reduce((a, r) => a + r.revenue, 0);
  const cost = costs ? list.reduce((a, r) => a + r.cost, 0) : null;
  const total = { units: Math.round(list.reduce((a, r) => a + r.units, 0) * 1000) / 1000, revenue,
    ...(costs && { cost, margin: revenue - cost, marginPct: pctOf(revenue - cost, revenue) }) };
  return { list, total, cards: { units: total.units, revenue, cost, marginPct: costs ? total.marginPct : null } };
}

router.get("/reports/top-sellers", async (req, res) => {
  const { chosen } = await scope(req);
  const { from, to } = await range(req, chosen[0].timeZone);
  const category = String(req.query.category || "");
  const { businessId } = req.session;
  const known = await categories(businessId);
  if (category && category !== "none" && !known.some((c) => c.id === category)) throw new HttpError(400, "Choose a category from the list.");
  const costs = await hasPermission(pool, req.session.employeeId, PERM_COSTS);
  const ids = chosen.map((l) => l.id);
  const sold = within("o.OrderDateTime", from, to), cat = inCategory(category);
  const args = [businessId, ids, PAID, ...sold.args, ...cat.args];

  const { list, total, cards } = await ranking(businessId, ids, from, to, category, costs);
  // compared with the same number of days just before
  const length = daysBetween(from, to) + 1;
  const previous = { from: addDays(from, -length), to: addDays(from, -1), days: length,
    cards: (await ranking(businessId, ids, addDays(from, -length), addDays(from, -1), category, costs)).cards };

  // Add-ons and substitutions chosen on the products sold: how many times (per item made) and what they added to the price
  const [mods] = await pool.query(
    `SELECT md.ModifierID AS id, md.Name AS name, g.Name AS grp,
            EXISTS (SELECT 1 FROM ModifierSubstitution s WHERE s.ModifierID = md.ModifierID) AS swap,
            SUM(m.Quantity * oi.Quantity) AS times, SUM(m.PriceDelta * m.Quantity * oi.Quantity) AS revenue
       ${SOLD} ${PRODUCT} JOIN OrderItemModifier m ON m.OrderItemID = oi.OrderItemID
       JOIN Modifier md ON md.ModifierID = m.ModifierID JOIN ModifierGroup g ON g.ModifierGroupID = md.ModifierGroupID
      WHERE ${PAID_HERE} AND ${sold.sql} ${cat.sql}
      GROUP BY md.ModifierID, md.Name, g.Name
      ORDER BY times DESC, revenue DESC, name LIMIT 10`, args);
  const addOns = mods.map((m) => ({ key: m.id, name: m.name, group: m.grp, kind: m.swap ? "Substitution" : "Add-on", value: Number(m.times), revenue: cents(m.revenue) }));

  // The five active products that sold least, none at all first
  const [slow] = await pool.query(
    `SELECT p.ProductID AS id, p.Name AS product, COALESCE(s.units, 0) AS units, COALESCE(s.revenue, 0) AS revenue
       FROM Product p LEFT JOIN (
         SELECT v.ProductID, SUM(oi.Quantity) AS units, SUM(oi.NetAmount) AS revenue
           ${SOLD} JOIN ProductVariant v ON v.VariantID = oi.VariantID
          WHERE ${PAID_HERE} AND ${sold.sql} GROUP BY v.ProductID) s ON s.ProductID = p.ProductID
      WHERE p.BusinessID = ? AND p.Active ${cat.sql}
      ORDER BY units, revenue, product LIMIT 5`,
    [businessId, ids, PAID, ...sold.args, businessId, ...cat.args]);
  const slowest = slow.map((p) => ({ key: p.id, name: p.product, value: Number(p.units), revenue: cents(p.revenue) }));

  // What went into each product sold, per item, from the stock each line used at the cost on the day
  if (costs) {
    const [used] = await pool.query(
      `SELECT p.ProductID AS id, s.Name AS item, u.Symbol AS unit, SUM(cp.QuantityUsed) AS qty, SUM(cp.QuantityUsed * cp.UnitCost) AS cost
         ${SOLD} ${PRODUCT} JOIN OrderItemComponent cp ON cp.OrderItemID = oi.OrderItemID
         JOIN StockItem s ON s.StockItemID = cp.StockItemID JOIN UnitOfMeasure u ON u.UnitCode = cp.StockUnitCode
        WHERE ${PAID_HERE} AND ${sold.sql} ${cat.sql}
        GROUP BY p.ProductID, s.StockItemID, s.Name, u.Symbol
        ORDER BY cost DESC, item`, args);
    for (const r of list) {
      r.costPerItem = r.units ? Math.round(r.cost / r.units) : 0;
      const mine = used.filter((x) => x.id === r.id);
      const each = apportion(mine.map((x) => Number(x.cost)), r.costPerItem); // rounded to add up to the cost per item
      r.ingredients = mine.map((x, i) => ({ item: x.item, unit: x.unit, perItem: Math.round((Number(x.qty) / r.units) * 1000) / 1000, costPerItem: each[i] }));
    }
  }

  res.json({
    from, to,
    location: chosen[0].name,
    category: category === "none" ? NO_CATEGORY : known.find((c) => c.id === category)?.name || "All categories",
    categoryId: category,
    seesCosts: costs,
    cards,
    previous,
    addOns,
    slowest,
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

// Customers' breakdowns. Every one uses the Customers rules: visits only (an order refunded in full doesn't count), and an
// order's spend is what was paid for it less every refund on it, whenever the refund was made.
const SEGMENTS = ["Champion", "Loyal", "Recent", "Steady", "At risk", "Lapsed"];
const VISITED = `o.BusinessID = ? AND o.LocationID IN (?) AND o.OrderStatusCode IN (?)`;
const REFUNDED_BY_ORDER = `(SELECT OrderID, SUM(Amount - TaxAmount) AS refunded FROM Refund WHERE BusinessID = ? AND RefundStatusCode = ? GROUP BY OrderID)`;

// Spend by category for the customers in these dates (or one customer): what each line sold for, less each refund split
// across the items that were returned (a refund with no returned items across its whole order). Map of customer -> Map of category.
async function spendByCategory(businessId, ids, from, to, customerId) {
  const w = within("o.OrderDateTime", from, to);
  const who = customerId ? "o.CustomerID = ?" : "o.CustomerID IS NOT NULL";
  const args = [businessId, ids, VISITS, ...w.args, ...(customerId ? [customerId] : [])];
  const CAT = `JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID LEFT JOIN Category c ON c.CategoryID = p.CategoryID`;
  const [sold] = await pool.query(
    `SELECT o.CustomerID AS cust, p.CategoryID AS cat, c.Name AS name, SUM(oi.NetAmount) AS sold
       ${SOLD} ${CAT} WHERE ${VISITED} AND ${w.sql} AND ${who} GROUP BY o.CustomerID, p.CategoryID, c.Name`, args);
  const [shares] = await pool.query(
    `SELECT r.RefundID AS id, o.CustomerID AS cust, r.Amount - r.TaxAmount AS net, p.CategoryID AS cat, c.Name AS name, oi.NetAmount * ri.QuantityReturned / oi.Quantity AS share
       FROM Refund r JOIN Orders o ON o.OrderID = r.OrderID JOIN Location l ON l.LocationID = o.LocationID
       JOIN ReturnItem ri ON ri.ReturnID = r.ReturnID JOIN OrderItem oi ON oi.OrderItemID = ri.OrderItemID ${CAT}
      WHERE r.BusinessID = ? AND r.RefundStatusCode = ? AND ${VISITED} AND ${w.sql} AND ${who}
     UNION ALL
     SELECT r.RefundID, o.CustomerID, r.Amount - r.TaxAmount, p.CategoryID, c.Name, oi.NetAmount
       FROM Refund r JOIN Orders o ON o.OrderID = r.OrderID JOIN Location l ON l.LocationID = o.LocationID
       JOIN OrderItem oi ON oi.OrderID = r.OrderID ${CAT}
      WHERE r.BusinessID = ? AND r.RefundStatusCode = ? AND ${VISITED} AND ${w.sql} AND ${who}
        AND NOT EXISTS (SELECT 1 FROM ReturnItem ri WHERE ri.ReturnID = r.ReturnID)`,
    [businessId, REFUND_DONE, ...args, businessId, REFUND_DONE, ...args]);
  const out = new Map();
  const slot = (cust, cat, name) => {
    if (!out.has(cust)) out.set(cust, new Map());
    const m = out.get(cust), k = cat || "none";
    if (!m.has(k)) m.set(k, { key: k, name: name || NO_CATEGORY, value: 0 });
    return m.get(k);
  };
  for (const x of sold) slot(x.cust, x.cat, x.name).value += cents(x.sold);
  const perRefund = new Map();
  for (const x of shares) (perRefund.get(x.id) || perRefund.set(x.id, []).get(x.id)).push(x);
  for (const lines of perRefund.values())
    apportion(lines.map((x) => Number(x.share) * 100), cents(lines[0].net)).forEach((v, i) => { slot(lines[i].cust, lines[i].cat, lines[i].name).value -= v; });
  return out;
}

// The lowest and highest value that earned each score, from everyone scored (the filter doesn't change scores)
function cutoffs(scored) {
  const of = (scoreKey, valueKey) => [1, 2, 3, 4, 5].map((score) => {
    const values = scored.filter((c) => c[scoreKey] === score).map((c) => c[valueKey]);
    return { score, customers: values.length, min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
  });
  return { r: of("r", "daysSince"), f: of("f", "orders"), m: of("m", "spend") };
}

async function customerBreakdown({ businessId, ids, from, to, args, list, scored, groups, tier, total }) {
  // 1, 2 and the deep dive: every segment, the empty ones too
  const segments = SEGMENTS.map((name) => {
    const people = list.filter((c) => c.segment === name), n = people.length;
    const spend = people.reduce((a, c) => a + c.spend, 0), orders = people.reduce((a, c) => a + c.orders, 0);
    return { key: name, name, customers: n, spend, orders,
      averageOrders: n ? Math.round((orders / n) * 10) / 10 : null,
      averageDays: n ? Math.round(people.reduce((a, c) => a + c.daysSince, 0) / n) : null,
      averageSpend: n ? Math.round(spend / n) : null };
  });

  // 3. Spend from customers vs walk-ins, every order in the dates by the same rules
  const [whose] = await pool.query(
    `SELECT s.CustomerID AS id, SUM(s.sold - COALESCE(r.refunded, 0)) AS spend, COUNT(*) AS orders
       FROM (SELECT o.OrderID, o.CustomerID, SUM(oi.NetAmount) AS sold FROM Orders o JOIN Location l ON l.LocationID = o.LocationID
               JOIN OrderItem oi ON oi.OrderID = o.OrderID WHERE ${VISITED} AND ${within("o.OrderDateTime", from, to).sql} GROUP BY o.OrderID, o.CustomerID) s
       LEFT JOIN ${REFUNDED_BY_ORDER} r ON r.OrderID = s.OrderID
      GROUP BY s.CustomerID`, [...args, businessId, REFUND_DONE]);
  const shown = new Set(list.map((c) => c.id));
  const who = { mine: { spend: 0, orders: 0 }, others: { spend: 0, orders: 0, customers: 0 }, walkins: { spend: 0, orders: 0 } };
  for (const x of whose) {
    const part = x.id == null ? who.walkins : shown.has(x.id) ? who.mine : who.others;
    part.spend += cents(x.spend); part.orders += Number(x.orders);
    if (x.id != null && !shown.has(x.id)) who.others.customers++;
  }
  const tierName = tier ? groups.find((g) => g.id === tier).name : null;
  const known = [
    { key: "known", name: tierName ? `${tierName} customers` : "Known customers", value: who.mine.spend, orders: who.mine.orders },
    ...(tier ? [{ key: "others", name: "Other customers", value: who.others.spend, orders: who.others.orders }] : []),
    { key: "walkins", name: "Walk-ins (no customer)", value: who.walkins.spend, orders: who.walkins.orders },
  ];

  // 4. Spend by customer, by category: the top 10 by spend, the rest as one bar, all in the same category order
  const split = await spendByCategory(businessId, ids, from, to);
  const catTotals = new Map();
  for (const c of list) for (const x of (split.get(c.id) || new Map()).values())
    catTotals.set(x.key, { key: x.key, name: x.name, value: (catTotals.get(x.key)?.value || 0) + x.value });
  const cats = [...catTotals.values()].sort(byValue);
  const partsOf = (people) => cats.map((cat) => ({ name: cat.name, value: people.reduce((a, c) => a + (split.get(c.id)?.get(cat.key)?.value || 0), 0) }));
  const bySpend = [...list].sort((a, b) => b.spend - a.spend || a.customer.localeCompare(b.customer));
  const byCustomer = bySpend.slice(0, 10).map((c) => ({ key: c.id, name: c.customer, value: c.spend, segment: c.segment, parts: partsOf([c]) }));
  const rest = bySpend.slice(10);
  if (rest.length) byCustomer.push({ key: "other", name: `Other customers (${rest.length})`, value: rest.reduce((a, c) => a + c.spend, 0), customers: rest.length, parts: partsOf(rest) });

  // 5. Spend by membership, by segment
  const byTier = groups.filter((g) => !tier || g.id === tier).map((g) => {
    const people = list.filter((c) => c.tierId === g.id);
    return { key: g.id, name: g.name, value: people.reduce((a, c) => a + c.spend, 0), customers: people.length,
      parts: SEGMENTS.map((name) => ({ name, value: people.filter((c) => c.segment === name).reduce((a, c) => a + c.spend, 0) })) };
  });

  return { segments, known, categories: cats.map(({ key, name }) => ({ key, name })), byCustomer, byTier, cutoffs: cutoffs(scored), scoredCustomers: scored.length };
}

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
  const scored = rfm(rows.map((x) => ({ id: x.id, customer: x.customer || "No name given", tierId: groupOf(x.tierId).id, membership: groupOf(x.tierId).name, lastOrder: x.lastOrder, daysSince: daysBetween(x.lastOrder, to), orders: Number(x.orders), spend: cents(x.spend) })));
  const list = scored.filter((c) => !tier || c.tierId === tier);
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
    breakdown: await customerBreakdown({ businessId, ids: chosen.map((l) => l.id), from, to, args, list, scored, groups, tier, total }),
    rows: list,
    total,
  });
});

// One customer's visits in the dates, under the same rules as their row: each order with its items and what it came to
// after refunds, spend by category, favourite products and the loyalty points those orders moved.
router.get("/reports/customers/:id", async (req, res) => {
  const { chosen } = await scope(req);
  const { from, to } = await range(req, chosen[0].timeZone);
  const { businessId } = req.session;
  const ids = chosen.map((l) => l.id);
  const id = String(req.params.id);
  const [[who]] = await pool.query("SELECT CustomerID AS id, CONCAT_WS(' ', FirstName, LastName) AS name FROM Customer WHERE CustomerID = ? AND BusinessID = ?", [id, businessId]);
  if (!who) throw new HttpError(404, "No customer found.");
  const w = within("o.OrderDateTime", from, to);
  const args = [businessId, ids, VISITS, ...w.args, id];

  const [orders] = await pool.query(
    `SELECT s.id, s.number, s.at, s.sold - COALESCE(r.refunded, 0) AS spend, COALESCE(r.refunded, 0) AS refunded
       FROM (SELECT o.OrderID AS id, o.OrderNumber AS number, DATE_FORMAT(${local("o.OrderDateTime")}, '%Y-%m-%d %H:%i') AS at, SUM(oi.NetAmount) AS sold
               ${SOLD} WHERE ${VISITED} AND ${w.sql} AND o.CustomerID = ? GROUP BY o.OrderID, o.OrderNumber, at) s
       LEFT JOIN ${REFUNDED_BY_ORDER} r ON r.OrderID = s.id
      ORDER BY s.at DESC`, [...args, businessId, REFUND_DONE]);
  if (!orders.length) throw new HttpError(404, "This customer has no orders in these dates.");
  const [lines] = await pool.query(
    `SELECT o.OrderID AS orderId, p.ProductID AS productId, p.Name AS product, v.Name AS size, SUM(oi.Quantity) AS qty, SUM(oi.NetAmount) AS sold
       ${SOLD} JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID
      WHERE ${VISITED} AND ${w.sql} AND o.CustomerID = ?
      GROUP BY o.OrderID, p.ProductID, p.Name, v.Name ORDER BY p.Name, v.Name`, args);
  // points on these orders, and adjustments with no order made in these dates
  const [points] = await pool.query(
    `SELECT lt.LoyaltyTransactionTypeCode AS type, SUM(lt.PointsChange) AS pts FROM LoyaltyTransaction lt
      WHERE lt.CustomerID = ? AND (lt.OrderID IN (?) OR (lt.OrderID IS NULL
        AND DATE_FORMAT(CONVERT_TZ(lt.TransactionDateTime, '+00:00', ?), '%Y-%m-%d') BETWEEN ? AND ?))
      GROUP BY lt.LoyaltyTransactionTypeCode`,
    [id, orders.map((o) => o.id), chosen[0].timeZone, from, to]);
  const pts = (type) => Number(points.find((p) => p.type === type)?.pts || 0);

  const spend = orders.reduce((a, o) => a + cents(o.spend), 0);
  const favourites = Object.values(lines.reduce((acc, l) => {
    const f = (acc[l.productId] ||= { name: l.product, units: 0, sold: 0 });
    f.units += Number(l.qty); f.sold += cents(l.sold);
    return acc;
  }, {})).sort((a, b) => b.units - a.units || b.sold - a.sold || a.name.localeCompare(b.name)).slice(0, 3);
  res.json({
    id, customer: who.name || "No name given", from, to,
    orders: orders.map((o) => ({ number: o.number, at: o.at, spend: cents(o.spend), refunded: cents(o.refunded),
      items: lines.filter((l) => l.orderId === o.id).map((l) => ({ name: l.size && l.size !== "Regular" ? `${l.product} (${l.size})` : l.product, qty: Number(l.qty) })) })),
    totals: { orders: orders.length, spend, averageOrder: Math.round(spend / orders.length) },
    byCategory: [...((await spendByCategory(businessId, ids, from, to, id)).get(id) || new Map()).values()].sort(byValue),
    favourites,
    points: { earned: pts(1), redeemed: -pts(2), adjusted: pts(3) },
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

const SOLD = `FROM Orders o JOIN Location l ON l.LocationID = o.LocationID JOIN OrderItem oi ON oi.OrderID = o.OrderID`;
const PAID_HERE = `o.BusinessID = ? AND o.LocationID IN (?) AND o.OrderStatusCode IN (?)`;
const REFUNDED_HERE = `r.BusinessID = ? AND o.LocationID IN (?) AND r.RefundStatusCode = ?`;

// The Revenue cards' figures for any stretch of days, by the cards' own rules; the last period they are compared with.
async function periodTotals(businessId, ids, from, to, cutoff) {
  const sold = within("o.OrderDateTime", from, to, cutoff), back = within("r.RefundDateTime", from, to, cutoff);
  const [[s]] = await pool.query(
    `SELECT COUNT(DISTINCT o.OrderID) AS orders, SUM(oi.NetAmount + oi.DiscountAmount) AS gross, SUM(oi.DiscountAmount) AS discounts, SUM(oi.LineCost) AS cost
       ${SOLD} WHERE ${PAID_HERE} AND ${sold.sql}`, [businessId, ids, PAID, ...sold.args]);
  const [[r]] = await pool.query(
    `SELECT SUM(r.Amount - r.TaxAmount) AS refunds FROM Refund r JOIN Orders o ON o.OrderID = r.OrderID JOIN Location l ON l.LocationID = o.LocationID
      WHERE ${REFUNDED_HERE} AND ${back.sql}`, [businessId, ids, REFUND_DONE, ...back.args]);
  const [[t]] = await pool.query(
    `SELECT SUM(p.TipAmount) AS tips FROM Payment p JOIN Orders o ON o.OrderID = p.OrderID JOIN Location l ON l.LocationID = o.LocationID
      WHERE ${PAID_HERE} AND p.PaymentStatusCode IN (?) AND ${sold.sql}`, [businessId, ids, PAID, TIPPED, ...sold.args]);
  const orders = Number(s.orders || 0), gross = cents(s.gross), discounts = cents(s.discounts), refunds = cents(r.refunds);
  const net = gross - discounts - refunds, cost = cents(s.cost);
  return { orders, avgOrder: orders ? Math.round(net / orders) : 0, gross, discounts, refunds, net, cost, profit: net - cost, tips: cents(t.tips) };
}

const CHANNELS = { 1: "Register", 2: "Online", 3: "Kiosk" };
const METHOD_NAMES = { 1: "Cash", 2: "Card", 4: "Other", 5: "Apple Pay", 6: "Google Pay" };
const byValue = (a, b) => b.value - a.value || a.name.localeCompare(b.name);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// What makes up the Revenue cards, panel by panel. Each panel adds up to its card to the cent: sales by the day the order
// was paid, refunds by the day the money went back, both under the cards' rules. Cost panels only for a role that sees costs.
async function breakdowns(businessId, ids, from, to, cards, costs) {
  const sold = within("o.OrderDateTime", from, to), back = within("r.RefundDateTime", from, to);
  const salesArgs = [businessId, ids, PAID, ...sold.args], refundArgs = [businessId, ids, REFUND_DONE, ...back.args];
  const REFUNDS = `FROM Refund r JOIN Orders o ON o.OrderID = r.OrderID JOIN Location l ON l.LocationID = o.LocationID`;
  const keyed = (map, key, init) => (map.has(key) ? map.get(key) : map.set(key, init()).get(key));

  // Net sales by channel: each order's sales and refunds go to the channel it came in on
  const [chSales] = await pool.query(`SELECT o.ChannelCode AS code, SUM(oi.NetAmount) AS net ${SOLD} WHERE ${PAID_HERE} AND ${sold.sql} GROUP BY code`, salesArgs);
  const [chRefunds] = await pool.query(`SELECT o.ChannelCode AS code, SUM(r.Amount - r.TaxAmount) AS refunds ${REFUNDS} WHERE ${REFUNDED_HERE} AND ${back.sql} GROUP BY code`, refundArgs);
  const channels = new Map();
  for (const c of chSales) keyed(channels, c.code, () => ({ key: String(c.code), name: CHANNELS[c.code] || `Channel ${c.code}`, value: 0 })).value += cents(c.net);
  for (const c of chRefunds) keyed(channels, c.code, () => ({ key: String(c.code), name: CHANNELS[c.code] || `Channel ${c.code}`, value: 0 })).value -= cents(c.refunds);

  // Net sales by payment method: an order's sales split across its payments by amount, a refund off the payment it went back to
  const [orderNet] = await pool.query(`SELECT o.OrderID AS id, SUM(oi.NetAmount) AS net ${SOLD} WHERE ${PAID_HERE} AND ${sold.sql} GROUP BY o.OrderID`, salesArgs);
  const [pays] = await pool.query(
    `SELECT p.OrderID AS id, p.PaymentMethodCode AS method, p.Amount AS amount FROM Payment p JOIN Orders o ON o.OrderID = p.OrderID JOIN Location l ON l.LocationID = o.LocationID
      WHERE ${PAID_HERE} AND p.PaymentStatusCode IN (?) AND ${sold.sql} ORDER BY p.PaymentDateTime, p.PaymentID`,
    [businessId, ids, PAID, TIPPED, ...sold.args]);
  const [payRefunds] = await pool.query(
    `SELECT p.PaymentMethodCode AS method, SUM(r.Amount - r.TaxAmount) AS refunds ${REFUNDS} JOIN Payment p ON p.PaymentID = r.PaymentID
      WHERE ${REFUNDED_HERE} AND ${back.sql} GROUP BY method`, refundArgs);
  const methods = new Map();
  const method = (code) => keyed(methods, code, () => ({ key: String(code), name: code == null ? "No payment" : METHOD_NAMES[code] || `Method ${code}`, value: 0 }));
  const paysOf = new Map();
  for (const p of pays) keyed(paysOf, p.id, () => []).push(p);
  for (const o of orderNet) {
    const ps = paysOf.get(o.id) || [];
    if (!ps.length) { if (cents(o.net)) method(null).value += cents(o.net); continue; }
    apportion(ps.map((p) => cents(p.amount)), cents(o.net)).forEach((v, i) => { method(ps[i].method).value += v; });
  }
  for (const r of payRefunds) method(r.method).value -= cents(r.refunds);

  // Per category: gross with the add-ons' share of it (their price deltas, less tax when prices include it), net and cost
  const [cats] = await pool.query(
    `SELECT x.id, x.name, SUM(x.gross) AS gross, SUM(x.addons) AS addons, SUM(x.net) AS net, SUM(x.cost) AS cost FROM (
       SELECT p.CategoryID AS id, c.Name AS name, oi.NetAmount + oi.DiscountAmount AS gross, oi.NetAmount AS net, oi.LineCost AS cost,
              COALESCE((SELECT SUM(m.PriceDelta * m.Quantity) FROM OrderItemModifier m WHERE m.OrderItemID = oi.OrderItemID), 0) * oi.Quantity
                * IF(oi.LineTotal > 0, (oi.NetAmount + oi.DiscountAmount) / oi.LineTotal, 0) AS addons
         ${SOLD} JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID
         LEFT JOIN Category c ON c.CategoryID = p.CategoryID
        WHERE ${PAID_HERE} AND ${sold.sql}) x
      GROUP BY x.id, x.name`, salesArgs);
  const categories = cats.map((c) => {
    const gross = cents(c.gross), addons = Math.round(Number(c.addons) * 100);
    return { key: c.id || "none", name: c.name || NO_CATEGORY, value: gross, base: gross - addons, addons };
  });

  // Discounts by promotion, manual discounts as one bar. Anything the order lines carry that neither records is shown, not hidden.
  const [promos] = await pool.query(
    `SELECT pm.PromotionID AS id, pm.Name AS name, SUM(pr.DiscountAmount) AS amount FROM PromotionRedemption pr JOIN Promotion pm ON pm.PromotionID = pr.PromotionID
       JOIN Orders o ON o.OrderID = pr.OrderID JOIN Location l ON l.LocationID = o.LocationID
      WHERE ${PAID_HERE} AND ${sold.sql} GROUP BY pm.PromotionID, pm.Name`, salesArgs);
  const [[manual]] = await pool.query(
    `SELECT SUM(d.Amount) AS amount FROM OrderDiscount d JOIN Orders o ON o.OrderID = d.OrderID JOIN Location l ON l.LocationID = o.LocationID
      WHERE ${PAID_HERE} AND ${sold.sql}`, salesArgs);
  const discounts = promos.map((p) => ({ key: p.id, name: p.name, value: cents(p.amount) }));
  if (cents(manual.amount)) discounts.push({ key: "manual", name: "Manual discounts", value: cents(manual.amount) });
  const unrecorded = cards.discounts - discounts.reduce((a, d) => a + d.value, 0);
  if (unrecorded) discounts.push({ key: "other", name: "Other discounts", value: unrecorded });

  // Refunds by the reason staff typed, the same words in any case or spacing together
  const [reasons] = await pool.query(
    `SELECT LOWER(TRIM(r.Reason)) AS k, MIN(TRIM(r.Reason)) AS name, COUNT(*) AS n, SUM(r.Amount - r.TaxAmount) AS amount
       ${REFUNDS} WHERE ${REFUNDED_HERE} AND ${back.sql} GROUP BY k`, refundArgs);
  const refunds = reasons.map((r) => ({ key: r.k, name: capital(r.name), value: cents(r.amount), count: Number(r.n) }));

  const out = {
    channels: [...channels.values()].sort(byValue),
    payments: [...methods.values()].sort(byValue),
    categories: categories.sort(byValue),
    discounts: discounts.sort(byValue),
    refunds: refunds.sort(byValue),
  };
  if (!costs) return out;

  // Cost of goods by stock item, from the ingredients each line used at the cost when it was sold (the same rows LineCost is
  // summed from). The card rounds hour by hour or day by day, so the cents are fitted to it; gap is how far apart they were.
  const [items] = await pool.query(
    `SELECT s.StockItemID AS id, s.Name AS name, SUM(cp.QuantityUsed * cp.UnitCost) AS cost
       ${SOLD} JOIN OrderItemComponent cp ON cp.OrderItemID = oi.OrderItemID JOIN StockItem s ON s.StockItemID = cp.StockItemID
      WHERE ${PAID_HERE} AND ${sold.sql} GROUP BY s.StockItemID, s.Name`, salesArgs);
  const [[bare]] = await pool.query(
    `SELECT SUM(oi.LineCost) AS cost ${SOLD} WHERE ${PAID_HERE} AND ${sold.sql}
        AND NOT EXISTS (SELECT 1 FROM OrderItemComponent cp WHERE cp.OrderItemID = oi.OrderItemID)`, salesArgs);
  const parts = items.map((i) => ({ key: i.id, name: i.name, raw: Number(i.cost) * 100 }));
  if (Number(bare.cost)) parts.push({ key: "bare", name: "Not itemized", raw: Number(bare.cost) * 100 });
  const rawCents = parts.reduce((a, p) => a + p.raw, 0);
  apportion(parts.map((p) => p.raw), cards.cost).forEach((v, i) => { parts[i].value = v; });
  parts.sort(byValue);
  const top = parts.slice(0, 8).map(({ key, name, value }) => ({ key, name, value }));
  const rest = parts.slice(8).reduce((a, p) => a + p.value, 0);
  if (parts.length > 8) top.push({ key: "other", name: `Other (${parts.length - 8} items)`, value: rest });
  out.ingredients = top;
  out.ingredientGap = cards.cost - Math.round(rawCents);

  // Profit by category: net sales less cost. Refunds aren't stored by category, so each refund is split across the lines
  // that were returned, by their share of the line's net; a refund with no returned items across the whole order.
  const [shares] = await pool.query(
    `SELECT r.RefundID AS id, r.Amount - r.TaxAmount AS net, p.CategoryID AS cat, c.Name AS name, oi.NetAmount * ri.QuantityReturned / oi.Quantity AS share
       ${REFUNDS} JOIN ReturnItem ri ON ri.ReturnID = r.ReturnID JOIN OrderItem oi ON oi.OrderItemID = ri.OrderItemID
       JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID LEFT JOIN Category c ON c.CategoryID = p.CategoryID
      WHERE ${REFUNDED_HERE} AND ${back.sql}
     UNION ALL
     SELECT r.RefundID, r.Amount - r.TaxAmount, p.CategoryID, c.Name, oi.NetAmount
       ${REFUNDS} JOIN OrderItem oi ON oi.OrderID = r.OrderID
       JOIN ProductVariant v ON v.VariantID = oi.VariantID JOIN Product p ON p.ProductID = v.ProductID LEFT JOIN Category c ON c.CategoryID = p.CategoryID
      WHERE ${REFUNDED_HERE} AND ${back.sql} AND NOT EXISTS (SELECT 1 FROM ReturnItem ri WHERE ri.ReturnID = r.ReturnID)`,
    [...refundArgs, ...refundArgs]);
  const profit = new Map();
  const cat = (id, name) => keyed(profit, id || "none", () => ({ key: id || "none", name: name || NO_CATEGORY, net: 0, cost: 0, raw: 0 }));
  for (const c of cats) { const x = cat(c.id, c.name); x.net += cents(c.net); x.raw += Number(c.cost || 0) * 100; }
  const perRefund = new Map();
  for (const s of shares) keyed(perRefund, s.id, () => []).push(s);
  for (const lines of perRefund.values())
    apportion(lines.map((l) => Number(l.share) * 100), cents(lines[0].net)).forEach((v, i) => { cat(lines[i].cat, lines[i].name).net -= v; });
  const list = [...profit.values()];
  apportion(list.map((x) => x.raw), cards.cost).forEach((v, i) => { list[i].cost = v; });
  out.profit = list.map(({ key, name, net, cost }) => ({ key, name, net, cost, value: net - cost, marginPct: pctOf(net - cost, net) })).sort(byValue);
  return out;
}

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
  const cards = { orders: total.orders, avgOrder: total.orders ? Math.round(total.net / total.orders) : 0, gross: total.gross, discounts: total.discounts,
    refunds: total.refunds, net: total.net, cost: costs ? total.cost : null, profit: costs ? total.profit : null, tips: cents(tips.tips) };

  // Compared with: live, the same days a week earlier (today only up to this time of day); history, the same number of days just before
  const isToday = day === (await today(chosen[0].timeZone));
  const length = daysBetween(from, day) + 1;
  const [prevFrom, prevTo] = history ? [addDays(from, -length), addDays(from, -1)] : [addDays(from, -7), addDays(day, -7)];
  let cutoff;
  if (!history && isToday) {
    const [[now]] = await pool.query("SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%H:%i:%s') AS t", [chosen[0].timeZone]);
    cutoff = `${prevTo} ${now.t}`;
  }
  const before = await periodTotals(businessId, ids, prevFrom, prevTo, cutoff);
  if (!costs) { delete before.cost; delete before.profit; }
  res.json({
    day, by, from,
    isToday,
    location: chosen[0].name,
    timeZone: chosen[0].timeZone,
    updatedAt: new Date().toISOString(),
    seesCosts: costs,
    cards,
    previous: { from: prevFrom, to: prevTo, until: cutoff ? cutoff.slice(11, 16) : null, days: history ? length : null, cards: before },
    breakdown: await breakdowns(businessId, ids, from, day, cards, costs),
    rows,
    total,
  });
});

module.exports = router;
