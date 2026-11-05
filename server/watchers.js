// The kitchen screens that are open, and the push that tells them something changed.
const watchers = new Map(); // locationId -> open responses
const notify = (locationId) => { for (const res of watchers.get(locationId) || []) res.write("data: changed\n\n"); };

module.exports = { watchers, notify };
