// The public side of the customer kiosk, for the Caddy proxy to point at. It is a second server that holds only what the
// kiosk page needs, so exposing it can't expose the staff pages or API: they don't exist here.
// Phone sign-in is off on this side unless KIOSK_PHONE_SIGNIN=1 (a phone number alone is not enough to guard someone's
// order history on the internet), so customers order as guests. Turn it on only for a demo with made-up customers.
const path = require("path");
const express = require("express");
const customers = require("./customers");
const { handleErrors } = require("./errors");

const PUBLIC = path.resolve(__dirname, "../public");
const app = express();
app.set("trust proxy", 1); // only the proxy reaches this port: its forwarded address is the customer's, for the rate limits
app.use((req, res, next) => { req.noPhoneSignIn = process.env.KIOSK_PHONE_SIGNIN !== "1"; next(); });

app.get(["/", "/customer"], (req, res) => res.redirect("/customer.html"));
app.use("/api", express.json(), customers); // customers has no catch-all, so anything else under /api is a 404 below
app.use(require("./vendor"));
// exactly the files the page loads, and nothing else from public/
for (const file of ["customer.html", "css/customer.css", "js/customer.js"]) app.get(`/${file}`, (req, res) => res.sendFile(path.join(PUBLIC, file)));
app.use("/img/customer", express.static(path.join(PUBLIC, "img/customer")));

app.use((req, res) => res.status(404).type("text").send("Page not found"));
app.use(handleErrors);

module.exports = app;
