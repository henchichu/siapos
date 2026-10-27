const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { startKiosk, pool, topUp } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = fs.readFileSync(path.join(root, "public/js/customer.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CAFE = { headers: { "x-location-id": "loc-campus" } }; // what the page sends with every call: a sign-in counts only at its own business
let fails = 0;
process.env.KIOSK_PHONE_SIGNIN = "1"; // the demo switch: these checks sign Chloe in by phone
process.env.KIOSK_SHARED_DEVICE = "1"; // these checks are for the shared iPad; a phone is never signed out while it waits
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

function kiosk(base) {
  const jar = new Map(); // a browser keeps every cookie it is given (session, device)
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/order/loc-campus", pretendToBeVisual: true }).window;
  w.fetch = async (url, opts = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
    for (const set of res.headers.getSetCookie()) { const [pair] = set.split(";"); const i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return res;
  };
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
  return { w, $, text, button, click, type };
}

(async () => {
  const { server, base } = await startKiosk(); // the public order page is its own server
  await topUp("stk-caramel", 2000); // a caramel americano takes 15 syrup, so a few runs empty the shelf
  const [[{ open }]] = await pool.query("SELECT AcceptsOnlineOrders AS open FROM Location WHERE LocationID = 'loc-campus'");
  await pool.query("UPDATE Location SET AcceptsOnlineOrders = FALSE WHERE LocationID = 'loc-campus'");
  try {
    const k = kiosk(base);
    await sleep(800);
    check("entry asks how you'd like to order", /How would you like to order\?/.test(k.text()));
    check("no staff sign-in on the page", !/employee/i.test(k.text()));

    await k.type(k.$("input"), "123");
    await k.click("Log In");
    check("a short number is refused", /10-digit/.test(k.text()));
    await k.type(k.$("input"), "(000) 000-0000");
    await k.click("Log In");
    check("a number that can't exist is refused before asking the server", /valid 10-digit US phone/.test(k.text()));
    await k.type(k.$("input"), "(312) 555-0177");
    await k.click("Log In");
    check("Chloe signs in by phone", /Chloe/.test(k.text()));
    check("her points are shown in the navigation", /106 points/.test(k.text()), k.text().slice(0, 200));

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
    check("checkout shows the account", /Chloe · \(\*\*\*\) \*\*\*-0177/.test(k.text()));
    await k.type([...k.w.document.querySelectorAll(".checkout-overlay input")].find((i) => i.maxLength === 120), "Extra hot");
    await sleep(400);
    await k.click("Place order");
    check("a payment method is required", /Choose how you'll pay/.test(k.text()));
    await k.click("Card");
    const field = (placeholder) => [...k.w.document.querySelectorAll(".checkout-overlay input")].find((i) => i.placeholder === placeholder);
    check("Card asks for the card details, in test mode", !!field("4242 4242 4242 4242") && /Test mode/.test(k.text()));
    await k.click("Place order");
    check("empty card details are refused", /Enter the card number/.test(k.text()), k.text().match(/Enter[^.]*\./)?.[0]);
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
    check("saved as confirmed with its payment", saved.status === 2 && saved.payments === 1, JSON.stringify(saved));
    check("the note is saved with the order", /Extra hot/.test(saved.note), saved.note);

    await k.click("Back to menu");
    check("the cart is empty after the order", /Your order is empty/.test(k.text()));
    await k.click("Your Orders"); await sleep(400);
    check("Your Orders lists the new order", new RegExp(`Order #${number}`).test(k.text()));
    [...k.w.document.querySelectorAll(".order-card")].find((c) => c.textContent.includes(`#${number}`)).click(); await sleep(500);
    check("an order opens with its status", new RegExp(`#${number}`).test(k.text()) && /Order total/.test(k.text()) && !!k.$(".status-card .steps"));
    check("no Advance status control", !k.button("Advance status"));
    const stage = () => [...k.w.document.querySelectorAll(".step")].map((x) => x.className.replace("step", "").trim() || "-").join(",");
    check("Confirmed is the current step", stage() === "current,-,-,-", stage());
    // the customer wording for a ready order is "Ready for pickup"; the step must follow the status, not the wording
    await pool.query("UPDATE Orders SET OrderStatusCode = 4 WHERE OrderNumber = ? AND BusinessID = 'biz-brewbean'", [number]);
    await k.click("Back to order history");
    k.$(".order-card").click(); await sleep(500);
    check("Ready lights the third step, with the two before it done", stage() === "done,done,current,-", stage());
    await k.click("Back to order history");
    check("back to history", /Signed-in order history/.test(k.text()));

    await k.click("Sign out"); await sleep(300);
    check("sign-out returns to the entry page", /How would you like to order\?/.test(k.text()));
    const session = await (await k.w.fetch("/api/customer/session", CAFE)).json();
    check("the customer session is gone", session.signedIn === false);

    await k.click("Order as Guest");
    check("guest sees the menu, not Chloe", /Guest/.test(k.text()) && !/Chloe/.test(k.text()));
    check("guest has no Your Orders", !k.button("Your Orders"));
    const muffin = [...k.w.document.querySelectorAll(".tile")].find((t) => /muffin/i.test(t.textContent));
    muffin.querySelector("button").click(); await sleep(400);
    k.$(".customize .confirm").click(); await sleep(300);
    await k.click("Checkout"); await sleep(400);
    await k.click("Cash");
    await k.click("Place order");
    check("a guest must give a name", /Enter a name for the order/.test(k.text()));
    await k.type(k.$(".checkout-overlay input"), "Sam");
    await k.click("Place order"); await sleep(600);
    check("guest order goes through", /Thanks, Sam/.test(k.text()) && /Order received/.test(k.text()));
    check("a cash order still waits for the counter", /payment pending/.test(k.text()) && /Pay the cashier/.test(k.text()));

    // the page asks for the order's status by itself: here the counter never took the cash, so it is cancelled and says so
    await require("../../server/kioskorders").expireStale(0);
    await sleep(8500);
    check("the phone shows the order was cancelled, without being asked", /Order cancelled/.test(k.text()) && !/payment pending/.test(k.text()), k.text().slice(0, 200));

    // a shared iPad signs the customer out when unattended: 30 seconds after an order, 2 minutes otherwise
    const real = k.w.Date.now, ahead = (ms) => { const t = real() + ms; k.w.Date.now = () => t; };
    await sleep(1200);
    check("the confirmation is still there while the guest is present", /Order received/.test(k.text()));

    // a guest has no account, but can reopen the orders of this visit
    const guestNumber = k.text().match(/Order number#(\d+)/)?.[1];
    await k.click("Back to menu");
    check("a guest who has ordered gets Your Orders", !!k.button("Your Orders"));
    await k.click("Your Orders"); await sleep(800);
    check("it lists the order from this visit", new RegExp(`Order #${guestNumber}`).test(k.text()) && /Orders you placed on this phone/.test(k.text()), k.text().slice(0, 200));
    k.$(".order-card").click(); await sleep(800);
    check("and reopens its tracking screen", /Order cancelled/.test(k.text()) && /Order total/.test(k.text()));

    ahead(31 * 1000); await sleep(1500);
    check("30 seconds after an order, the kiosk is back at the entry page", /How would you like to order\?/.test(k.text()), k.text().slice(0, 120));
    await k.click("Order as Guest");
    check("on a shared screen the next guest doesn't see those orders", !k.button("Your Orders"));
    ahead(31 * 1000 + 2 * 60 * 1000 + 1000); await sleep(1500); // idle again: back to the entry page
    k.w.Date.now = real;
    await k.type(k.$("input"), "(312) 555-0177");
    await k.click("Log In");
    check("Chloe signs in again", /Chloe/.test(k.text()));
    ahead(60 * 1000); await sleep(1500);
    check("a minute of no touches is still signed in", /Chloe/.test(k.text()));
    ahead(3 * 60 * 1000); await sleep(1500);
    check("after 2 minutes idle, signed out", /How would you like to order\?/.test(k.text()) && !/Chloe/.test(k.text()));
    check("and the server session is gone", (await (await k.w.fetch("/api/customer/session", CAFE)).json()).signedIn === false);

    // the public address (server/kiosk.js): guests only, with no phone sign-in to offer
    const pub = await new Promise((r) => { const sv = require("../../server/kiosk").listen(0, () => r(sv)); });
    delete process.env.KIOSK_PHONE_SIGNIN; // a real deployment has the demo switch off
    try {
      const g = kiosk(`http://127.0.0.1:${pub.address().port}`);
      await sleep(900);
      check("the public kiosk offers guest ordering only", /Continue as a guest to place an order/.test(g.text()) && !/Customer login/.test(g.text()) && !g.button("Log In") && !!g.button("Order as Guest"), g.text().slice(0, 160));
      await g.click("Order as Guest");
      check("and its menu opens for a guest", /Guest/.test(g.text()) && !g.button("Your Orders"));
      check("the public kiosk page reported no errors", g.w.errors.length === 0, g.w.errors.slice(0, 2).join(" | "));
    } finally { pub.close(); }

    check("React reported no errors", k.w.errors.length === 0, k.w.errors.slice(0, 3).join(" | "));
  } finally {
    await pool.query("UPDATE Location SET AcceptsOnlineOrders = ? WHERE LocationID = 'loc-campus'", [open]);
    server.close();
    await pool.end();
  }
  console.log(fails ? `${fails} failed` : "all passed");
  process.exit(fails ? 1 : 0);
})();
