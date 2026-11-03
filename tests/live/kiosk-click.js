// Drives the real kiosk page in jsdom, signed in as Chloe: menu, options, cart, checkout (declined and approved test cards), the
// order's tracking, a cash order that waits for the counter, sign-out and the shared screen's idle sign-out.
process.env.RATE_LIMIT_SCALE = "50";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool, topUp } = require("./env");
const { expireStale } = require("../../server/kioskorders");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = fs.readFileSync(path.join(root, "public/js/kiosk.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };
const CHLOE = { email: "chloe@example.com", password: "chloe-dev-pass" };

// A page already signed in: the sign-in screen is the staff one, so the cookie is fetched first, as the browser would have it
async function kiosk(base) {
  const jar = new Map();
  const fetchJar = async (url, opts = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
    for (const set of res.headers.getSetCookie()) { const [pair] = set.split(";"); const i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return res;
  };
  const login = await fetchJar("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(CHLOE) });
  if (login.status !== 200) throw new Error(`Chloe could not sign in: ${login.status}`);
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/kiosk.html", pretendToBeVisual: true }).window;
  w.fetch = fetchJar;
  const { webcrypto } = require("crypto");
  Object.defineProperty(w, "crypto", { value: { getRandomValues: (a) => webcrypto.getRandomValues(a) }, configurable: true });
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
  w.eval(app);
  const $ = (sel) => w.document.querySelector(sel);
  const text = () => w.document.body.textContent;
  const button = (label) => [...w.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  const click = async (label) => { const b = button(label); if (!b) throw new Error(`no button "${label}"`); b.click(); await sleep(400); };
  const type = async (el, value) => {
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
    await sleep(50);
  };
  await sleep(900);
  return { w, $, text, button, click, type, signedIn: async () => (await w.fetch("/api/customer/me")).status === 200 };
}

const clearChloe = async () => {
  await pool.query("UPDATE Orders SET OrderDateTime = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE CustomerID = 'cus-chloe' AND ChannelCode = 3 AND OrderStatusCode = 1");
  while (await expireStale()) {}
  await pool.query("UPDATE Orders SET OrderStatusCode = 5, CompletedAt = UTC_TIMESTAMP() WHERE CustomerID = 'cus-chloe' AND ChannelCode = 3 AND OrderStatusCode IN (2, 3, 4)");
};

(async () => {
  const { server, base } = await start();
  await topUp("stk-caramel", 2000); // a caramel americano takes 15 syrup, so a few runs empty the shelf
  await clearChloe();
  try {
    const k = await kiosk(base);
    check("the menu opens straight away for the signed-in customer", /Chloe/.test(k.text()) && !!k.button("Checkout"), k.text().slice(0, 160));
    check("her points are shown in the navigation", /\d+ points/.test(k.text()), k.text().slice(0, 200));
    check("no sign-in or guest choices on the page", !k.button("Order as Guest") && !k.button("Log In"));

    await k.click("Rewards");
    check("Rewards opens the rewards page", /Redeem for store points/.test(k.text()));
    await k.click("Browse Menu");
    check("Browse Menu goes back to the menu", /Your order/.test(k.text()) && !!k.button("Checkout"));
    check("Checkout is off while the cart is empty", k.button("Checkout").disabled);

    const americano = [...k.w.document.querySelectorAll(".tile")].find((t) => /Americano/.test(t.textContent));
    americano.querySelector("button").click(); await sleep(400);
    check("Add opens the item options", !![...k.w.document.querySelectorAll(".customize .confirm")][0]);
    await k.click("Large 16 oz · $3.75");
    const caramel = [...k.w.document.querySelectorAll(".opt label")].find((l) => /Caramel/.test(l.textContent)).querySelector("input");
    caramel.click(); await sleep(200);
    check("the item total adds the option", /Add to order · \$4\.35/.test(k.text()), k.text().match(/Add to order · \$[\d.]+/)?.[0]);
    k.$(".customize .confirm").click(); await sleep(300);
    check("the item lands in the cart", /Americano, Large 16 oz/.test(k.text()) && /Caramel/.test(k.text()));
    k.$('[aria-label="Add one Americano"]').click(); await sleep(200);
    check("+ raises the quantity", /Subtotal\$8\.70/.test(k.text().replace(/\s/g, "")), k.text().match(/Subtotal\s*\$[\d.]+/)?.[0]);

    await k.click("Checkout");
    check("checkout shows the account", /Chloe · c\*\*\*@example\.com/.test(k.text()), k.text().match(/Account[^C]*Chloe[^P]*/)?.[0]);
    await k.type([...k.w.document.querySelectorAll(".checkout-overlay input")].find((i) => i.maxLength === 120), "Extra hot");
    await sleep(400);
    await k.click("Place order");
    check("a payment method is required", /Choose how you'll pay/.test(k.text()));
    await k.click("Card");
    const field = (placeholder) => [...k.w.document.querySelectorAll(".checkout-overlay input")].find((i) => i.placeholder === placeholder);
    check("Card asks for the card details, in test mode", !!field("4242 4242 4242 4242") && /Test mode/.test(k.text()));
    await k.type(field("4242 4242 4242 4242"), "4000 0000 0000 0002");
    await k.type(field("12/30"), "12/49");
    await k.type(field("123"), "123");
    const [[{ before }]] = await pool.query("SELECT COUNT(*) AS `before` FROM Orders");
    await k.click("Place order"); await sleep(500);
    check("a declined test card says so and makes no order", /Your card was declined/.test(k.text()) && !/Order received/.test(k.text()));
    check("nothing was saved", (await pool.query("SELECT COUNT(*) AS n FROM Orders"))[0][0].n === before);
    await k.type(field("4242 4242 4242 4242"), "4242 4242 4242 4242");
    await k.click("Place order"); await sleep(600);
    check("confirmation shows the order", /Order received/.test(k.text()) && /#\d+/.test(k.text()));
    check("a test card is paid on the kiosk", /Paid — your order is being prepared/.test(k.text()) && /nothing was charged for real/.test(k.text()) && !/payment pending/.test(k.text()));
    const number = k.text().match(/#(\d+)/)[1];
    const [[saved]] = await pool.query("SELECT OrderStatusCode AS status, CustomerNote AS note, (SELECT COUNT(*) FROM Payment p WHERE p.OrderID = o.OrderID AND p.PaymentStatusCode = 3) AS payments FROM Orders o WHERE OrderNumber = ? AND BusinessID = 'biz-brewbean'", [number]);
    check("saved as confirmed with its payment and the note", saved.status === 2 && saved.payments === 1 && saved.note === "Extra hot", JSON.stringify(saved));

    await k.click("Back to menu");
    check("the cart is empty after the order", /Your order is empty/.test(k.text()));
    check("the status island shows the order in progress", /Order #\d+/.test(k.$(".island")?.textContent || ""), k.$(".island")?.textContent);
    await k.click("Your Orders"); await sleep(400);
    check("Your Orders lists the new order", new RegExp(`Order #${number}`).test(k.text()));
    [...k.w.document.querySelectorAll(".order-card")].find((c) => c.textContent.includes(`#${number}`)).click(); await sleep(500);
    check("an order opens with its status", new RegExp(`#${number}`).test(k.text()) && /Order total/.test(k.text()) && !!k.$(".status-card .steps"));
    const stage = () => [...k.w.document.querySelectorAll(".step")].map((x) => x.className.replace("step", "").trim() || "-").join(",");
    check("Confirmed is the current step", stage() === "current,-,-,-", stage());
    // the customer wording for a ready order is "Ready for pickup"; the step must follow the status, not the wording
    await pool.query("UPDATE Orders SET OrderStatusCode = 4 WHERE OrderNumber = ? AND BusinessID = 'biz-brewbean'", [number]);
    await k.click("Back to order history");
    k.$(".order-card").click(); await sleep(500);
    check("Ready lights the third step, with the two before it done", stage() === "done,done,current,-", stage());
    await k.click("Back to order history");
    check("back to history", /Chloe · Order history/.test(k.text()));

    await k.click("Sign out"); await sleep(400);
    check("signing out ends the customer session", !(await k.signedIn()));
    check("React reported no errors", k.w.errors.length === 0, k.w.errors.slice(0, 3).join(" | "));

    // a cash order waits for the counter; the page notices when it is cancelled, without being asked
    await clearChloe();
    const c = await kiosk(base);
    const muffin = [...c.w.document.querySelectorAll(".tile")].find((t) => /muffin/i.test(t.textContent));
    muffin.querySelector("button").click(); await sleep(400);
    c.$(".customize .confirm").click(); await sleep(300);
    await c.click("Checkout"); await sleep(400);
    await c.click("Cash");
    await c.click("Place order"); await sleep(600);
    check("a cash order still waits for the counter", /Order received/.test(c.text()) && /payment pending/.test(c.text()) && /Pay the cashier/.test(c.text()));
    await expireStale(0);
    await sleep(8500);
    check("the page shows the order was cancelled, without being asked", /Order cancelled/.test(c.text()) && !/payment pending/.test(c.text()), c.text().slice(0, 200));

    // a shared screen signs the customer out when unattended: 30 seconds after an order, 2 minutes otherwise
    const real = c.w.Date.now, ahead = (ms) => { const t = real() + ms; c.w.Date.now = () => t; };
    await sleep(1200);
    check("signed in while present", await c.signedIn());
    ahead(31 * 1000); await sleep(1500);
    check("30 seconds after an order, the customer is signed out", !(await c.signedIn()));
    await clearChloe();
    const d = await kiosk(base);
    const realD = d.w.Date.now;
    d.w.Date.now = () => realD() + 60 * 1000; await sleep(1500);
    check("a minute of no touches is still signed in", await d.signedIn());
    d.w.Date.now = () => realD() + 3 * 60 * 1000; await sleep(1500);
    check("after 2 minutes idle, signed out", !(await d.signedIn()));
    check("React reported no errors on the later pages", c.w.errors.length === 0 && d.w.errors.length === 0, [...c.w.errors, ...d.w.errors].slice(0, 3).join(" | "));
  } finally {
    await clearChloe();
    server.close();
    await pool.end();
  }
  console.log(fails ? `${fails} failed` : "all passed");
  process.exit(fails ? 1 : 0);
})();
