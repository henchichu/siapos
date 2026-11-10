// A real calendar day written YYYY-MM-DD. "2026-02-31" is refused, not rolled over into March.
const isDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d\d-\d\d$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().startsWith(s);
};

module.exports = { isDate };
