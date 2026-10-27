const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "../..");

test("configured business name follows kiosk navigation, checkout, and order history", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/order/test", runScripts: "outside-only" });
  const w = dom.window;
  const businessName = "Owner's <Coffee> & Co.";
  const order = { id: "test", orderNumber: 1, placedAt: "2026-10-26T12:00:00Z", tz: "America/Chicago", total: 3, statusCode: 2, status: "Confirmed", items: [] };
  const responses = {
    "/api/customer/context": { businessName, locationName: "Campus", phoneSignIn: true },
    "/api/customer/session": { signedIn: true, firstName: "Test", member: true, points: 10 },
    "/api/customer/catalog": { categories: [], products: [{ id: "coffee", name: "Coffee", groups: [], variants: [{ id: "regular", name: "Regular", available: true, priceCents: 300 }] }] },
    "/api/customer/price": { subtotalCents: 300, taxCents: 0, totalCents: 300 },
    "/api/customer/orders": { orderId: "test", orderNumber: 1, totalCents: 300, paid: false },
    "/api/customer/orders/test": order,
    "/api/customer/my-orders": { orders: [order] },
    "/api/customer/logout": {},
  };
  w.fetch = async url => { assert(url in responses, url); return { ok: true, json: async () => responses[url] }; };
  for (const file of ["react/umd/react.development.js", "react-dom/umd/react-dom.development.js", "htm/dist/htm.umd.js"]) w.eval(fs.readFileSync(path.join(root, "node_modules", file), "utf8"));
  w.eval(fs.readFileSync(path.join(root, "public/js/customer.js"), "utf8"));
  const wait = () => new Promise(resolve => setTimeout(resolve, 80));
  const click = async text => {
    const button = [...w.document.querySelectorAll("button")].find(b => b.textContent.trim() === text);
    assert(button, text); button.click(); await wait();
  };
  const header = () => assert.equal(w.document.querySelector(".nav h1 .label")?.textContent, businessName); // the navigation names the café on every screen after the entry one
  try {
    await wait(); header();
    await click("Rewards"); header();
    await click("Browse Menu"); header();
    w.document.querySelector(".tile button").click(); await wait(); w.document.querySelector(".customize .confirm").click(); await wait();
    await click("Checkout"); header();
    await click("Cash"); await click("Place order");
    assert.equal(w.document.querySelector(".confirm-overlay .where")?.textContent, businessName + " · Pickup at this counter");
    await click("Back to menu"); await click("Your Orders"); header();
    w.document.querySelector(".order-card").click(); await wait(); header();
    assert.equal(w.document.querySelector(".details .where")?.textContent, businessName);
    await click("Sign out");
    assert.equal(w.document.querySelector(".topbar p")?.textContent, businessName);
    assert(!w.document.body.textContent.includes("ClockIt Cafe"));
    assert(!w.document.querySelector("coffee"), "business name is escaped as text");
  } finally { w.close(); }
});