// The numbers on the navigation's badges. A key is there only for a role that has that page.
const express = require("express");
const pool = require("./database/connection");
const { hasPermission } = require("./pin");
const { attentionFor } = require("./attention");

const PERM_USE_REGISTER = 1;
const PERM_SEE_KITCHEN = 5;
const KIOSK = 3;

const router = express.Router();

router.get("/nav-counts", async (req, res) => {
  const { locationId, employeeId } = req.session;
  const out = {};
  const count = (sql, params) => pool.query(sql, params).then(([[r]]) => r.n);
  if (await hasPermission(pool, employeeId, PERM_USE_REGISTER))
    // kiosk orders waiting for the cashier: unpaid, so not yet in the kitchen
    out.register = await count("SELECT COUNT(*) AS n FROM Orders WHERE LocationID = ? AND ChannelCode = ? AND OrderStatusCode = 1", [locationId, KIOSK]);
  if (await hasPermission(pool, employeeId, PERM_SEE_KITCHEN))
    // every ticket the kitchen screen lists: new, preparing or ready, none yet picked up
    out.kitchen = await count("SELECT COUNT(*) AS n FROM Orders WHERE LocationID = ? AND OrderStatusCode IN (2, 3, 4)", [locationId]);
  // shortcut: this runs the whole Manager's To-Do page's queries to add up its panels; give it COUNT queries if it gets slow
  const attention = await attentionFor(req.session);
  if (attention) out.attention = ["losses", "reorder", "timecards", "refunds"].reduce((n, k) => n + (attention[k]?.count || 0), 0);
  res.json(out);
});

module.exports = router;
