// Request limits kept in memory. shortcut: one server process only, use a shared store (Redis) with several.
// A limit counts by the address a request comes from (by: "address") or by the device cookie from server/device.js (by: "device"),
// because on a café's wifi every phone shares one address: the address limit is high and only a flood reaches it, while the
// device limit is tight and stops one script without touching the other phones. A request with no device cookie counts by address.
const SCALE = Number(process.env.RATE_LIMIT_SCALE) || 1; // multiplies every limit; for the load test only
const STRIKES = 3, STRIKE_WINDOW_MS = 10 * 60 * 1000, BAN_MS = 15 * 60 * 1000;

// An IPv6 client owns a whole /64, so the first four groups are one client; ::ffff:1.2.3.4 is just the IPv4 address
function addressOf(req) {
  const ip = String(req.ip || "").replace(/^::ffff:/i, "").split("%")[0];
  if (!ip.includes(":")) return ip;
  const [h, t = ""] = ip.split("::");
  const head = h ? h.split(":") : [], tail = t ? t.split(":") : [];
  const groups = ip.includes("::") ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  return groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":");
}

// An address that goes over its limit in 3 different windows within 10 minutes is refused everywhere for 15 minutes.
// One strike per window, so a rush that overshoots once is a strike, not a ban.
const bans = new Map(); // address -> { strikes: [times], until }
function strike(address, now) {
  const b = bans.get(address) || { strikes: [], until: 0 };
  b.strikes = b.strikes.filter((t) => now - t < STRIKE_WINDOW_MS);
  b.strikes.push(now);
  if (b.strikes.length >= STRIKES) { b.until = now + BAN_MS; b.strikes = []; }
  bans.set(address, b);
}
const purgeBans = () => { const now = Date.now(); for (const [a, b] of bans) if (b.until < now && b.strikes.every((t) => now - t >= STRIKE_WINDOW_MS)) bans.delete(a); };
setInterval(purgeBans, 5 * 60 * 1000).unref();

const tooMany = (res, ms) => {
  res.set("Retry-After", String(Math.ceil(ms / 1000)));
  return res.status(429).json({ error: "Too many attempts. Wait a minute and try again." });
};

// ban: this limit also feeds the ban above (use it on the address limit only). skip(req): requests it doesn't count.
module.exports = (max, windowMs, { by = "address", ban = false, skip } = {}) => {
  const hits = new Map();
  const limit = (req, res, next) => {
    if (skip?.(req)) return next();
    const now = Date.now();
    const address = addressOf(req);
    const banned = bans.get(address);
    if (ban && banned && banned.until > now) return tooMany(res, banned.until - now);
    const key = by === "device" && req.device ? `d:${req.device}` : address;
    if (hits.size > 1000) for (const [k, h] of hits) if (h.until < now) hits.delete(k);
    let h = hits.get(key);
    if (!h || h.until < now) hits.set(key, (h = { n: 0, until: now + windowMs, struck: false }));
    if (++h.n > max * SCALE) {
      if (ban && !h.struck) { h.struck = true; strike(address, now); }
      return tooMany(res, h.until - now);
    }
    next();
  };
  limit.reset = () => { hits.clear(); bans.clear(); }; // for tests: start every test with an empty count
  return limit;
};
module.exports.addressOf = addressOf;
