// Drives the real Orders and Order details pages in jsdom: search, open an order, and send a refund to a manager from its modal.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, client, pool, pickUp } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const src = (names) => names.map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

(async () => {
  const { server, base } = await start();
  const call = async (number, pin) => { const c = client(base); await c.call("/login/pin", { employeeNumber: number, pin }); return c; };
  const sam = await call("10420003", "333333");
  const leo = await call("10420002", "222222");
  const made = await sam.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: 2 }], payment: { method: "cash" } });
  await pickUp(made.body.orderNumber);
  const [[row]] = await pool.query("SELECT OrderID AS id FROM Orders WHERE OrderNumber = ?", [made.body.orderNumber]);

  const mount = (url, scripts) => {
    const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + url, pretendToBeVisual: true }).window;
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    w.fetch = (u, opts = {}) => fetch(base + u, { ...opts, headers: { ...(opts.headers || {}), cookie: leo.cookie() } });
    w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
    const errors = []; w.console.error = (...a) => errors.push(a.join(" ").slice(0, 300));
    w.eval(src(scripts));
    return { w, errors, $: (s) => w.document.querySelector(s), $$: (s) => [...w.document.querySelectorAll(s)] };
  };
  const type = async (w, el, v) => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(100); };

  // ---- Orders
  const list = mount("/orders.html", ["api", "shell", "orders"]);
  await sleep(1200);
  const L = list;
  check("menu: Orders is current", [...L.$$(".nav a.link")].find((a) => a.textContent === "Orders")?.getAttribute("aria-current") === "page");
  check("today's search ran on load, with its dates filled in", /^\d{4}-\d\d-\d\d$/.test(L.$("input[type=date]").value) && /orders? found/.test(L.$(".results header").textContent));
  check("the wireframe's columns", L.$$(".results th").map((t) => t.textContent).join("|") === "Date and time|Order|Source|Employee|Member|Status|Total");
  const mine = L.$$("tbody tr").find((r) => r.querySelector("a").textContent === String(made.body.orderNumber));
  check("the new sale is a row with a keyboard link to its details", !!mine && mine.querySelector("a").getAttribute("href") === `/order.html?id=${row.id}` && /Sam Rivera/.test(mine.textContent) && /Walk-in/.test(mine.textContent) && /Completed/.test(mine.textContent));
  const [from, to] = L.$$("input[type=date]");
  await type(L.w, from, "2020-01-01"); await type(L.w, to, "2020-01-31"); L.$(".osearch").dispatchEvent(new L.w.Event("submit", { bubbles: true, cancelable: true })); await sleep(700);
  check("a search for 2020 finds nothing and says so", /0 orders found/.test(L.$(".results header").textContent) && /No orders match/.test(L.$(".results").textContent));
  await type(L.w, to, "2019-01-01"); L.$(".osearch").dispatchEvent(new L.w.Event("submit", { bubbles: true, cancelable: true })); await sleep(700);
  check("a From date after the To date shows the error", /can't be after/.test(L.$(".msg")?.textContent || ""));
  check("orders page: no React warnings", L.errors.length === 0, L.errors.join(" | "));

  // ---- Order details
  const d = mount(`/order.html?id=${row.id}`, ["api", "shell", "refund", "order"]);
  await sleep(1200);
  const D = d;
  check("details: back link, title, and a refund button", D.$(".ohead a").getAttribute("href") === "/orders.html" && D.$(".ohead h2").textContent === `Order ${made.body.orderNumber}` && !D.$(".ohead button").disabled);
  check("summary strip", D.$$(".metric").map((m) => m.firstChild.textContent).join("|") === "Status|Source|Placed|Total" && /Completed/.test(D.$(".metrics").textContent));
  check("items, totals, payments and who/where are there", /Butter croissant/.test(D.$("section[aria-label=Items]").textContent) && /Subtotal/.test(D.$(".totals").textContent) && /Cash/.test(D.$("section[aria-label='Payments and refunds']").textContent) && /Location: Brewbean Downtown/.test(D.$(".facts").textContent) && /Rung up by: Sam Rivera/.test(D.$(".facts").textContent));
  check("status history lists the order's steps", D.$$("section[aria-label='Status history'] tbody tr").length >= 1);

  D.$(".ohead button").click(); await sleep(900);
  check("Refund this order opens the refund screen on this order, without a search box", !!D.$("dialog[open]") && /Order \d+/.test(D.$("dialog .order-sum h3")?.textContent || "") && !D.$("dialog .find") && /Butter croissant/.test(D.$("dialog").textContent));
  const tick = D.$("dialog tbody input[type=checkbox]"); tick.click(); await sleep(200);
  await type(D.w, D.$("dialog aside input.field"), "Customer changed mind");
  const ask = [...D.$$("dialog button")].find((b) => b.textContent === "Send to a manager");
  check("with an item and a reason, the order can be sent to a manager", !ask.disabled);
  ask.click(); await sleep(1000);
  check("it is sent, as from the register", /Sent to a manager/.test(D.$("dialog .msg")?.textContent || ""));
  const waiting = (await leo.call("/refunds/waiting")).body.refunds.filter((r) => r.orderNumber === made.body.orderNumber);
  check("and it waits on the manager's list", waiting.length === 1 && waiting[0].reason === "Customer changed mind");
  for (const r of waiting) await leo.call(`/refunds/${r.id}/reject`, {});
  check("details page: no React warnings", D.errors.filter((e) => !/Not implemented/.test(e)).length === 0, D.errors.join(" | "));

  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
