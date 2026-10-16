// Per-IP request limit, kept in memory. shortcut: one server process only, use a shared store (Redis) with several.
module.exports = (max, windowMs) => {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 1000) for (const [k, h] of hits) if (h.until < now) hits.delete(k);
    let h = hits.get(req.ip);
    if (!h || h.until < now) hits.set(req.ip, (h = { n: 0, until: now + windowMs }));
    if (++h.n > max) return res.status(429).json({ error: "Too many attempts. Wait a minute and try again." });
    next();
  };
};
