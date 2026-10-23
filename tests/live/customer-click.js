const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = fs.readFileSync(path.join(root, "public/js/customer.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

function kiosk(base) {
  let cookie = "";
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/customer.html", pretendToBeVisual: true }).window;
  w.fetch = async (url, opts = {}) => {
    const res = await fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
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
  const { server, base } = await start();
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
    await k.type(k.$("input"), "(312) 555-0177");
    await k.click("Log In");
    check("Chloe signs in by phone", /Hi, Chloe!/.test(k.text()));
    check("her phone is masked and her points shown", /\(\*\*\*\) \*\*\*-0177/.test(k.text()) && /106 points/.test(k.text()), k.text().slice(0, 200));

    await k.click("Redeem");
    check("Redeem opens the rewards page", /Redeem for store points/.test(k.text()));
    await k.click("Browse Menu");
    check("Browse Menu goes back to the menu", /Your order/.test(k.text()) && !!k.button("Checkout"));
    check("Checkout is off while the cart is empty", k.button("Checkout").disabled);

    const americano = [...k.w.document.querySelectorAll(".tile")].find((t) => /Americano/.test(t.textContent));
    americano.querySelector("button").click(); await sleep(400);
    check("Add opens the item options", !!k.button("Add to my order"));
    await k.click("Large 16 oz · $3.75");
    const caramel = [...k.w.document.querySelectorAll(".opt label")].find((l) => /Caramel/.test(l.textContent)).querySelector("input");
    caramel.click(); await sleep(200);
    check("the item total adds the option", /Item total \$4\.35/.test(k.text()), k.text().match(/Item total \$[\d.]+/)?.[0]);
    await k.click("Add to my order");
    check("the item lands in the cart", /Americano, Large 16 oz/.test(k.text()) && /Caramel/.test(k.text()));
    k.$('[aria-label="Add one Americano"]').click(); await sleep(200);
    check("+ raises the quantity", /Subtotal\$8\.70/.test(k.text().replace(/\s/g, "")), k.text().match(/Subtotal\s*\$[\d.]+/)?.[0]);

    await k.type(k.$(".cart .note input"), "Extra hot");
    await k.click("Checkout");
    check("checkout shows the account", /Chloe · \(\*\*\*\) \*\*\*-0177/.test(k.text()));
    check("the barista note carries into checkout", [...k.w.document.querySelectorAll(".checkout-overlay input")].some((i) => i.value === "Extra hot"));
    await sleep(400);
    await k.click("Place order");
    check("a payment method is required", /Choose how you'll pay/.test(k.text()));
    await k.click("Card");
    await k.click("Place order"); await sleep(600);
    check("confirmation shows the order", /Order received/.test(k.text()) && /#\d+/.test(k.text()));
    check("choosing Card is not a payment", /payment pending/.test(k.text()) && /did not charge/.test(k.text()));
    const number = k.text().match(/#(\d+)/)[1];
    const [[saved]] = await pool.query("SELECT OrderStatusCode AS status, CustomerNote AS note, (SELECT COUNT(*) FROM Payment p WHERE p.OrderID = o.OrderID) AS payments FROM Orders o WHERE OrderNumber = ? AND BusinessID = 'biz-brewbean'", [number]);
    check("saved as pending payment with no payment", saved.status === 1 && saved.payments === 0, JSON.stringify(saved));
    check("the note is saved with the order", /Extra hot/.test(saved.note), saved.note);

    await k.click("Back to menu");
    check("the cart is empty after the order", /Your order is empty/.test(k.text()));
    await k.click("Your Orders"); await sleep(400);
    check("Your Orders lists the new order", new RegExp(`Order #${number}`).test(k.text()));
    [...k.w.document.querySelectorAll(".order-card")].find((c) => c.textContent.includes(`#${number}`)).click(); await sleep(500);
    check("an order opens with its status", new RegExp(`Order #${number}`).test(k.text()) && /What you ordered/.test(k.text()));
    check("no Advance status control", !k.button("Advance status"));
    await k.click("Back to order history");
    check("back to history", /Signed-in order history/.test(k.text()));

    await k.click("Back to Customer Login"); await sleep(300);
    check("sign-out returns to the entry page", /How would you like to order\?/.test(k.text()));
    const session = await (await k.w.fetch("/api/customer/session")).json();
    check("the customer session is gone", session.signedIn === false);

    await k.click("Order as Guest");
    check("guest sees the menu, not Chloe", /Welcome, Guest!/.test(k.text()) && !/Chloe/.test(k.text()));
    check("guest has no Your Orders", !k.button("Your Orders"));
    const muffin = [...k.w.document.querySelectorAll(".tile")].find((t) => /muffin/i.test(t.textContent));
    muffin.querySelector("button").click(); await sleep(400);
    await k.click("Add to my order");
    await k.click("Checkout"); await sleep(400);
    await k.click("Cash");
    await k.click("Place order");
    check("a guest must give a name", /Enter a name for the order/.test(k.text()));
    await k.type(k.$(".checkout-overlay input"), "Sam");
    await k.click("Place order"); await sleep(600);
    check("guest order goes through", /Thanks, Sam/.test(k.text()) && /Order received/.test(k.text()));

    check("React reported no errors", k.w.errors.length === 0, k.w.errors.slice(0, 3).join(" | "));
  } finally {
    await pool.query("UPDATE Location SET AcceptsOnlineOrders = ? WHERE LocationID = 'loc-campus'", [open]);
    server.close();
    await pool.end();
  }
  console.log(fails ? `${fails} failed` : "all passed");
  process.exit(fails ? 1 : 0);
})();
