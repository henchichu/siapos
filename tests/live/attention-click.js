// Drives the real Needs attention page in jsdom, and answers two waiting refunds from its Review dialog.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, client, pool, pickUp } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = ["api", "shell", "attention"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

(async () => {
  const { server, base } = await start();
  const call = async (number, pin) => { const c = client(base); await c.call("/login/pin", { employeeNumber: number, pin }); return c; };
  const sam = await call("10420003", "333333");
  // two croissant sales, each with a refund asked for
  const asked = [];
  for (let i = 0; i < 2; i++) {
    const made = await sam.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], payment: { method: "cash" } });
    await pickUp(made.body.orderNumber);
    const found = (await sam.call(`/refunds/order?q=${made.body.orderNumber}`)).body;
    await sam.call("/refunds/request", { orderId: found.orderId, reason: "Customer changed mind", lines: [{ orderItemId: found.lines[0].orderItemId, qty: 1, restock: false }] });
    asked.push(made.body.orderNumber);
  }

  const leo = await call("10420002", "222222");
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/attention.html", pretendToBeVisual: true }).window;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie: leo.cookie() } });
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  const errors = []; w.console.error = (...a) => errors.push(a.join(" ").slice(0, 300));
  w.eval(app);
  await sleep(1000);
  const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
  const byText = (s, t) => $$(s).find((e) => e.textContent.trim().startsWith(t));
  const click = async (el, ms = 300) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); };
  const type = async (el, v) => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(100); };
  const panel = (title) => $(`section.panel[aria-label='${title}']`);
  const count = (title) => Number(panel(title).querySelector(".count").textContent);

  check("heading and where and when", /Needs attention/.test($(".heading").textContent) && /Brewbean Campus · today/.test($(".heading").textContent));
  check("four panels, as in the wireframe", $$("section.panel h3").map((h) => h.textContent).join("|") === "Stock losses reported today|Pending deliveries|Timecards waiting for approval|Refunds waiting for an override");
  check("menu: Needs attention is current, with all ten links for a manager", byText(".nav a.link", "Needs attention")?.getAttribute("aria-current") === "page" && $$(".nav a.link").length === 10);
  check("Open inventory and Receive delivery go to the correct inventory tabs", panel("Stock losses reported today").querySelector("a").getAttribute("href") === "/inventory.html" && panel("Pending deliveries").querySelector("a").getAttribute("href") === "/inventory.html#delivery");
  const review = panel("Timecards waiting for approval").querySelector("a");
  check("Review timecards opens the team page at the waiting card's pay period", count("Timecards waiting for approval") === 0 || /^\/shift\.html\?payPeriodId=.+#team$/.test(review.getAttribute("href")), review.getAttribute("href"));
  check("each panel's table has the wireframe's columns", panel("Refunds waiting for an override").querySelectorAll("th").length === 4 && [...panel("Refunds waiting for an override").querySelectorAll("th")].map((t) => t.textContent).join("|") === "Order|Amount|Asked by|Why");
  const refundRows = () => $$("section.panel[aria-label='Refunds waiting for an override'] tbody tr").map((r) => r.textContent);
  const startCount = count("Refunds waiting for an override");
  check("the waiting refunds are listed with who asked and why", startCount >= 2 && asked.every((n) => refundRows().some((t) => t.includes(String(n)) && /Sam/.test(t) && /manager's approval/.test(t))));

  await click(byText("button", "Review refund"), 600);
  check("Review refund opens the waiting refunds", !!$("dialog[open]") && asked.every((n) => $("dialog").textContent.includes(`Order ${n} `)) && /Reason given: Customer changed mind/.test($("dialog").textContent) && /1 × Butter croissant/.test($("dialog").textContent));
  // act on our own two cards, whatever else is waiting
  const card = (n) => $$("dialog li").find((li) => li.textContent.includes(`Order ${n} `));
  const button = (n, label) => [...card(n).querySelectorAll("button")].find((b) => b.textContent === label);
  const [first, second] = asked;
  check("Approve waits for a number and a PIN, Reject doesn't", button(first, "Approve").disabled && !button(first, "Reject").disabled);
  const [num, pin] = $$("dialog input");
  await type(num, "10420002"); await type(pin, "000000");
  await click(button(first, "Approve"), 700);
  check("a wrong PIN is refused", /Unauthorized/.test($("dialog .msg")?.textContent || ""));
  await type(pin, "222222");
  await click(button(first, "Approve"), 900);
  check("the right PIN approves it and says where the money went", /refunded to Cash/.test($("dialog .msg")?.textContent || ""));
  await click(button(second, "Reject"), 900);
  check("Reject answers the next one", /refund rejected/.test($("dialog .msg")?.textContent || ""));
  check("neither is listed any more", !card(first) && !card(second));
  await click(byText("dialog button", "Close"), 600);
  check("the panel's count went down by two", count("Refunds waiting for an override") === startCount - 2 && !refundRows().some((t) => asked.some((n) => t.includes(String(n)))));
  check("a manager's location is plain text, not a menu", !$(".nav .where") && /Brewbean Campus/.test($(".nav .who").textContent));

  // the owner's page: the location opens a menu of their locations
  const owner = await call("10420001", "111111");
  const ow = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/attention.html", pretendToBeVisual: true }).window;
  ow.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  ow.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie: owner.cookie() } });
  ow.eval(lib("react/umd/react.development.js")); ow.eval(lib("react-dom/umd/react-dom.development.js")); ow.eval(lib("htm/dist/htm.umd.js"));
  ow.eval(app);
  await sleep(1000);
  const where = ow.document.querySelector(".nav .where");
  check("the owner's location in the sidebar is a button", !!where && /Brewbean Campus/.test(where.textContent) && !ow.document.querySelector(".heading .where"));
  where.click(); await sleep(600);
  const places = [...ow.document.querySelectorAll("dialog .places button")];
  check("clicking it opens a menu of their locations, current one marked", places.map((b) => b.textContent).join("|") === "Brewbean Campus|Brewbean Downtown" && places[0].getAttribute("aria-current") === "true");
  places[1].click(); await sleep(600);
  check("picking another location switches the session", (await owner.call("/session")).body.locationName === "Brewbean Downtown");
  await owner.call("/locations/switch", { locationId: "loc-campus" });
  check("page: no React warnings", errors.filter((e) => !/Not implemented/.test(e)).length === 0, errors.join(" | "));

  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
