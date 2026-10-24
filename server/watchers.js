// The kitchen screens that are open, and the push that tells them something changed.
// shortcut: open screens are tracked in this process only (the staff server). Orders placed in another process, the public
// kiosk server, can't call notify() here, so poll() below looks at the database for them.
const watchers = new Map(); // locationId -> open responses
const notify = (locationId) => { for (const res of watchers.get(locationId) || []) res.write("data: changed\n\n"); };

// For each café with a screen open, one cheap query describes its open tickets (CONFIRMED, PREPARING, READY: what the screen
// lists); when that changes, the screens are told. Cafés with no screen open cost nothing.
const seen = new Map();
async function poll(pool) {
  for (const [locationId, screens] of watchers) {
    if (!screens.size) { seen.delete(locationId); continue; }
    const [[f]] = await pool.query(
      "SELECT COUNT(*) AS n, COALESCE(MAX(OrderNumber), 0) AS newest, COALESCE(SUM(OrderStatusCode), 0) AS stages FROM Orders WHERE LocationID = ? AND OrderStatusCode IN (2, 3, 4)",
      [locationId]);
    const print = `${f.n}|${f.newest}|${f.stages}`;
    if (seen.has(locationId) && seen.get(locationId) !== print) notify(locationId);
    seen.set(locationId, print);
  }
}
const startPolling = (pool, ms = 2000) =>
  setInterval(() => poll(pool).catch((err) => console.error("checking for new kitchen tickets failed:", err.message)), ms).unref();

module.exports = { watchers, notify, poll, startPolling };
