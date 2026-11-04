// RFM: how recently, how often and how much each customer buys, each scored 1 (lowest) to 5 (highest) against the other customers in the report.

// Scores only compare customers with each other, so someone can score low on recency after a very recent order.
// Nobody gets these labels until this many days after their last order.
const AT_RISK_MIN_DAYS = 30;
const LAPSED_MIN_DAYS = 60;

// A value's place among the others: 1 for the bottom fifth up to 5 for the top fifth. Ties share a score,
// and customers who are all the same score 3 rather than all looking like the best.
function scores(values) {
  return values.map((v) => {
    const below = values.filter((x) => x < v).length;
    const same = values.filter((x) => x === v).length;
    return Math.min(5, Math.floor(((below + same / 2) / values.length) * 5) + 1);
  });
}

// The first that fits. Monetary only decides Champions and At risk, as a big spender going quiet is worth a call.
function segmentOf(r, f, m, daysSince) {
  if (r >= 4 && f >= 4 && m >= 4) return "Champion";
  if (r >= 3 && f >= 4) return "Loyal";
  if (r >= 4 && f <= 2) return "Recent";
  if (r <= 2 && (f >= 3 || m >= 4) && daysSince >= AT_RISK_MIN_DAYS) return "At risk";
  if (r <= 2 && daysSince >= LAPSED_MIN_DAYS) return "Lapsed";
  return "Steady";
}

// customers: [{ daysSince, orders, spend }]. Adds the scores and segment; best customers first.
function rfm(customers) {
  const r = scores(customers.map((c) => -c.daysSince)); // fewer days since the last order is better
  const f = scores(customers.map((c) => c.orders));
  const m = scores(customers.map((c) => c.spend));
  return customers
    .map((c, i) => ({ ...c, r: r[i], f: f[i], m: m[i], segment: segmentOf(r[i], f[i], m[i], c.daysSince) }))
    .sort((a, b) => b.r + b.f + b.m - (a.r + a.f + a.m) || b.spend - a.spend || String(a.customer).localeCompare(String(b.customer)));
}

module.exports = { AT_RISK_MIN_DAYS, LAPSED_MIN_DAYS, scores, segmentOf, rfm };
