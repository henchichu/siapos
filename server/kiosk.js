// The public side of the customer kiosk, for the Caddy proxy to point at. It is a second server that holds only what the
// kiosk page needs, so exposing it can't expose the staff pages or API: they don't exist here.
// Phone sign-in is off on this side unless KIOSK_PHONE_SIGNIN=1 (a phone number alone is not enough to guard someone's
// order history on the internet), so customers order as guests. Turn it on only for a demo with made-up customers.
const path = require("path");
const express = require("express");
const customers = require("./customers");
const { handleErrors } = require("./errors");
const pool = require("./database/connection");

const PUBLIC = path.resolve(__dirname, "../public");
const app = express();
app.set("trust proxy", 1); // only the proxy reaches this port: its forwarded address is the customer's, for the rate limits
app.use((req, res, next) => { req.noPhoneSignIn = process.env.KIOSK_PHONE_SIGNIN !== "1"; next(); });

// Each café's QR code opens /order/<locationId>; the page reads the id from its address, and the café decides the business.
// Without one there's no telling which café (or business) is meant, so people are told to scan the code.
// Every route that asks the database is limited by address, so one address can't hold the pool, which is shared with the
// registers. The limit is high because a café's phones share one address (a menu load is ~25 calls); tighter per-phone limits
// are in customers.js. Pictures have their own, higher limit (a menu shows many, and the browser keeps them after the first
// load). Both feed the same ban, so a banned address gets neither.
const PICTURE = /^\/customer\/products\/[^/]+\/photo$/;
const limits = [
  require("./ratelimit")(1500, 60 * 1000, { ban: true, skip: (req) => PICTURE.test(req.path) }),
  require("./ratelimit")(3000, 60 * 1000, { ban: true, skip: (req) => !PICTURE.test(req.path) }),
];

// For the container health check: it asks the database too, so a lost database login shows up as unhealthy
app.get("/ready", limits, async (req, res) => { await pool.query("SELECT 1"); res.json({ status: "ok" }); });

app.get("/order/:locationId", (req, res) => res.sendFile(path.join(PUBLIC, "customer.html")));
app.get(["/", "/customer"], (req, res) => res.status(404).type("text").send(customers.SCAN));
app.use("/api", limits, express.json(), customers); // customers has no catch-all, so anything else under /api is a 404 below
app.use(require("./vendor"));
// exactly the files the page loads, and nothing else from public/
for (const file of ["customer.html", "css/customer.css", "js/customer.js"]) app.get(`/${file}`, (req, res) => res.sendFile(path.join(PUBLIC, file)));
app.use("/img/customer", express.static(path.join(PUBLIC, "img/customer")));

app.use((req, res) => res.status(404).type("text").send("Page not found"));
app.use(handleErrors);

// The only part meant for the internet, through the Caddy proxy. It runs on its own (own container, own database login).
if (require.main === module) {
  const PORT = process.env.KIOSK_PORT || 3001;
  app.listen(PORT, "0.0.0.0", () => console.log(`Customer order page (public side) at http://localhost:${PORT}`));
}

module.exports = app;
