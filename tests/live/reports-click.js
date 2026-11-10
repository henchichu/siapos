// Drives the real Reports page in jsdom: the tabs, Revenue (live and history) filters, cards, chart and table, as the general manager and as a manager.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool, creds } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = ["api", "shell", "reports"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

async function open(base, number, pin) {
  const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(creds(number)) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/reports.html", pretendToBeVisual: true }).window;
  w.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
  // the page's timers are kept so a test can fire the minute-by-minute refresh without waiting a minute
  w.timers = new Map();
  const setI = w.setInterval.bind(w), clearI = w.clearInterval.bind(w);
  w.setInterval = (fn, ms) => { const id = setI(fn, ms); w.timers.set(id, { fn, ms }); return id; };
  w.clearInterval = (id) => { w.timers.delete(id); clearI(id); };
  w.eval(app);
  await sleep(900);
  const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
  const set = (proto, el, v) => Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, v);
  const field = (label) => $$(".rfilters label").find((l) => l.querySelector("b")?.textContent === label)?.querySelector("input, select");
  return {
    w, $, $$, field,
    byText: (s, t) => $$(s).find((e) => e.textContent.trim().startsWith(t)),
    click: async (el, ms = 500) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); },
    type: async (el, v) => { set(w.HTMLInputElement, el, v); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(80); },
    choose: async (el, v) => { set(w.HTMLSelectElement, el, v); el.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(150); },
    heads: () => $$("section.report table thead th").map((t) => t.textContent),
    rows: () => $$("section.report table tbody tr").filter((r) => r.querySelectorAll("td").length > 1),
    foot: () => [...($("section.report table tfoot tr")?.querySelectorAll("td") || [])].map((c) => c.textContent),
    cards: () => $$(".rcard").map((c) => [c.querySelector("span").textContent, c.querySelector("b").textContent]),
    bars: () => $$(".chart .col"),
  };
}
const dollars = (s) => Number(s.replace(/[$,]/g, "").replace("−", "-"));

(async () => {
  const { server, base } = await start();
  const m = await open(base, "10420001", "111111");

  check("the sidebar has Reports, marked as this page", m.$(".nav [aria-current=page]")?.textContent === "Reports");
  check("the wireframes' five tabs and Customers", m.$$(".tabs[aria-label=Reports] .tab").map((t) => t.textContent).join("|") === "Revenue|Top sellers|Labor cost|Stock losses|Customers");
  check("Revenue is open, on Live", m.$(".tabs [aria-pressed=true]")?.textContent === "Revenue" && !!m.$("section[aria-label='Live sales']")
    && m.$$("[aria-label='Revenue views'] .tab").map((t) => t.textContent).join("|") === "Live|History");
  const { today } = await (await m.w.fetch("/api/reports/options")).json();
  check("Live sales filters: a blank Day and no Location list", m.field("Day")?.value === "" && !m.field("From") && !m.field("Location"));
  check("Live starts without output or refresh", m.cards().length === 0 && m.w.timers.size === 0);
  await m.type(m.field("Day"), today);
  await m.click(m.byText("button", "Run report"), 700);
  check("nine cards, Net sales so far in black", m.cards().map(([k]) => k).join("|") === "Gross sales|Discounts|Refunds|Net sales so far|Cost of goods|Profit|Tips|Orders|Avg order"
    && m.$$(".rcard")[3].className.includes("dark"), m.cards().join());
  const hHeads = () => m.$$("section[aria-label='Live sales'] table thead th").map((t) => t.textContent);
  const hRows = () => m.$$("section[aria-label='Live sales'] table tbody tr").filter((r) => r.querySelectorAll("td").length > 1).map((r) => [...r.children].map((c) => c.textContent));
  const hFoot = () => [...m.$("section[aria-label='Live sales'] table tfoot tr").children].map((c) => c.textContent);
  check("Hour by hour columns", m.$("section[aria-label='Live sales'] .tablewrap h3").textContent === "Hour by hour"
    && hHeads().join("|") === "Hour|Orders|Gross|Discounts|Refunds|Net sales|Cost|Profit|Running net", hHeads().join("|"));
  check("hours in order, a bar each", hRows().length > 0 && hRows().every((r) => /^\d+ (AM|PM)$/.test(r[0])) && m.bars().length === hRows().length && !!m.$(".chart[aria-label='Net sales by hour']"));
  check("running net adds up to Net sales, and the Total row leaves it blank", hRows().at(-1)[8] === m.cards()[3][1] && hFoot()[5] === m.cards()[3][1] && hFoot()[8] === "", hFoot().join("|"));
  check("Updated, and a refresh every minute while it's today", /Updated \d/.test(m.$(".livebar").textContent) && [...m.w.timers.values()].some((t) => t.ms === 60000));

  const ordersNow = Number(hFoot()[1]);
  const priya = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(creds("10420004")) });
  const sale = await fetch(base + "/api/register/orders", { method: "POST", headers: { "content-type": "application/json", cookie: priya.headers.get("set-cookie").split(";")[0] },
    body: JSON.stringify({ items: [{ key: "a", variantId: "var-amer-s", quantity: 1 }], payment: { method: "cash" } }) });
  check("(a sale comes in)", sale.status === 200);
  [...m.w.timers.values()].find((t) => t.ms === 60000).fn(); await sleep(700);
  check("the next refresh shows it without Run report", Number(hFoot()[1]) === ordersNow + 1, `${ordersNow} -> ${hFoot()[1]}`);

  await m.click(m.byText(".livebar button", "By day"), 700);
  await m.click(m.byText("button", "Run report"), 700);
  check("By day: Monday up to today", m.$("section[aria-label='Live sales'] .tablewrap h3").textContent === "Day by day" && hHeads()[0] === "Day"
    && hRows().at(-1)[0].includes(new Date(`${today}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })) && hRows()[0][0].startsWith("Mon"));
  check("Live offers only By hour and By day", m.$$(".livebar .tab").map((t) => t.textContent).join("|") === "By hour|By day");
  const past = new Date(Date.parse(`${today}T00:00:00Z`) - 8 * 864e5).toISOString().slice(0, 10);
  await m.type(m.field("Day"), past);
  await m.click(m.byText("button", "Run report"), 700);
  check("an earlier day: no refresh, Net sales without 'so far'", ![...m.w.timers.values()].some((t) => t.ms === 60000) && /As of/.test(m.$(".livebar").textContent) && m.cards()[3][0] === "Net sales");

  await m.click(m.byText("[aria-label='Revenue views'] .tab", "History"), 700);
  check("History opens", !!m.$("section[aria-label='Revenue history']") && m.byText("[aria-label='Revenue views'] .tab", "History").getAttribute("aria-pressed") === "true");
  check("filters: From, To and Run report, no Location", !!m.field("From") && !!m.field("To") && !m.field("Location") && !!m.byText("button", "Run report"));
  check("Daily, Monthly and Yearly", m.$$(".livebar .tab").map((t) => t.textContent).join("|") === "Daily|Monthly|Yearly");
  check("History dates start blank with no output", m.field("From").value === "" && m.field("To").value === "" && m.cards().length === 0);
  await m.type(m.field("From"), new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 864e5).toISOString().slice(0, 10));
  await m.type(m.field("To"), today);
  await m.click(m.byText("button", "Run report"), 700);
  check("every figure Live shows", m.cards().map(([k]) => k).join("|") === "Gross sales|Discounts|Refunds|Net sales|Cost of goods|Profit|Tips|Orders|Avg order" && m.$$(".rcard")[3].className.includes("dark"), m.cards().join());
  check("one bar per day, last 30 days", m.bars().length === 30 && m.rows().length === 30);
  check("table columns", m.heads().join("|") === "Day|Orders|Gross|Discounts|Refunds|Net sales|Cost|Profit|Running net", m.heads().join("|"));
  const sumNet = m.rows().reduce((a, r) => a + dollars(r.children[5].textContent), 0);
  check("the Total row adds up and matches Net sales", m.foot()[0] === "Total" && Math.abs(dollars(m.foot()[5]) - sumNet) < 0.005 && m.foot()[5] === m.cards()[3][1], m.foot().join("|"));

  m.bars()[29].dispatchEvent(new m.w.MouseEvent("mouseover", { bubbles: true })); await sleep(100);
  check("hovering a bar shows its day and amount", /\$\d/.test(m.$(".tip")?.textContent || ""), m.$(".tip")?.textContent);

  const to = m.field("To").value;
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 13 * 864e5).toISOString().slice(0, 10);
  await m.type(m.field("From"), from);
  check("the report waits for Run report", m.bars().length === 30);
  await m.click(m.byText("button", "Run report"), 700);
  check("Run report: 14 days, Downtown only", m.bars().length === 14 && /Brewbean Downtown/.test(m.$(".report .sub").textContent));
  const card = (name) => dollars(m.cards().find(([k]) => k === name)[1]);
  const panel = (title) => m.$(`.rpanel[aria-label='${title}']`);
  const figures = (title, sel = ".hval") => [...panel(title).querySelectorAll(sel)].map((e) => dollars(e.textContent.split(" · ")[0]));
  const adds = (title, name, sel) => Math.abs(figures(title, sel).reduce((x, y) => x + y, 0) - card(name)) < 0.005;
  check("each card says how it compares with the last period", m.$$(".rcard").every((c) => /previous 14 days/.test(c.querySelector(".change")?.textContent || "")));
  check("the waterfall steps from Gross sales down to Profit", m.$$(".waterfall .wlbl").map((e) => e.textContent).join("|") === "Gross sales|− Discounts|− Refunds|Net sales|− Cost of goods|Profit"
    && /Cost of goods includes refunded items/.test(panel("How it adds up").textContent), m.$$(".waterfall .wlbl").map((e) => e.textContent).join("|"));
  check("the breakdown panels, in order", m.$$(".rgrid .rpanel h3").map((h) => h.textContent).join("|")
    === "Net sales by channel|Sales by payment method|Gross sales by category|Discounts by promotion|Refunds by reason|Cost of goods by ingredient|Profit by category", m.$$(".rgrid .rpanel h3").map((h) => h.textContent).join("|"));
  check("each panel adds up to its card", adds("Net sales by channel", "Net sales", ".dlegend .hval") && adds("Sales by payment method", "Net sales", ".dlegend .hval")
    && adds("Gross sales by category", "Gross sales") && adds("Cost of goods by ingredient", "Cost of goods") && adds("Profit by category", "Profit")
    && (adds("Discounts by promotion", "Discounts") || /No discounts/.test(panel("Discounts by promotion").textContent))
    && (adds("Refunds by reason", "Refunds") || /No refunds/.test(panel("Refunds by reason").textContent)));
  check("Profit by category explains how refunds are split", /Refunds are split across the items that were returned/.test(panel("Profit by category").textContent));

  await m.click(m.byText(".livebar button", "Monthly"), 700);
  await m.click(m.byText("button", "Run report"), 700);
  check("Monthly: a row per month in the dates", m.$(".tablewrap h3").textContent === "Month by month" && m.heads()[0] === "Month" && m.rows().length === (from.slice(0, 7) === to.slice(0, 7) ? 1 : 2));
  await m.type(m.field("From"), `${Number(to.slice(0, 4)) - 1}-01-01`);
  await m.click(m.byText(".livebar button", "Yearly"), 700);
  await m.click(m.byText("button", "Run report"), 700);
  check("Yearly: a row per year, the last is this year", m.$(".tablewrap h3").textContent === "Year by year" && m.heads()[0] === "Year" && m.rows().length === 2 && m.rows().at(-1).children[0].textContent === to.slice(0, 4));

  await m.type(m.field("From"), new Date(Date.parse(`${today}T00:00:00Z`) + 864e5).toISOString().slice(0, 10));
  await m.click(m.byText("button", "Run report"), 500);
  check("a From after To is explained", /From must not be later than To/.test(m.$(".report .msg")?.textContent || ""));

  const coffee = [...panel("Gross sales by category").querySelectorAll("button.hrow")].find((x) => x.querySelector(".hname").textContent === "Coffee");
  await m.click(coffee, 900);
  const lastYear = new Date(Date.parse(`${to}T00:00:00Z`) - 365 * 864e5).toISOString().slice(0, 10);
  check("clicking a category opens Top sellers for it, over the same dates up to the 366 it allows", m.$(".tabs [aria-pressed=true]").textContent === "Top sellers" && m.field("Category").value === "cat-coffee"
    && m.field("From").value === lastYear && m.field("To").value === to && m.cards().length === 4 && /covers up to 366 days/.test(m.$("section.report").textContent)
    && m.rows().every((r) => r.children[2].textContent === "Coffee"), `${m.field("Category").value} ${m.field("From").value} ${m.field("To").value}`);

  await m.click(m.byText(".tabs .tab", "Top sellers"), 700);
  check("Top sellers starts without output", m.cards().length === 0 && m.field("From").value === "" && m.field("To").value === "");
  await m.type(m.field("From"), new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10));
  await m.type(m.field("To"), today);
  await m.click(m.byText("button", "Run report"), 700);
  check("Top sellers opens without a reload", m.$(".tabs [aria-pressed=true]").textContent === "Top sellers" && m.w.location.hash === "#top-sellers" && !!m.$("section[aria-label='Top sellers']"));
  check("Top sellers filters add Category", !!m.field("From") && !!m.field("To") && !m.field("Location") && m.field("Category")?.value === ""
    && [...m.field("Category").options].map((o) => o.textContent).join("|") === "All categories|Bakery|Coffee|Retail|Tea|No category");
  check("Top sellers cards", m.cards().map(([k]) => k).join("|") === "Units sold|Revenue|Cost of goods|Margin %", m.cards().join());
  const tHeads = () => m.$$("table[aria-label='Top sellers'] thead th").map((t) => t.textContent);
  const tRows = () => m.$$("table[aria-label='Top sellers'] tbody tr").filter((r) => r.querySelectorAll("td").length > 1).map((r) => [...r.children].map((c) => c.textContent));
  const tFoot = () => [...m.$("table[aria-label='Top sellers'] tfoot tr").children].map((c) => c.textContent);
  check("Top sellers columns", tHeads().join("|") === "Rank|Product|Category|Units sold|Revenue|Cost|Margin $|Margin %", tHeads().join("|"));
  check("ranked 1, 2, 3… by units sold", tRows().length > 3 && tRows().every((r, i) => r[0] === String(i + 1)) && tRows().every((r, i, a) => !i || Number(a[i - 1][3]) >= Number(r[3])));
  check("the Total row matches the cards", tFoot()[0] === "Total" && tFoot()[3] === m.cards()[0][1] && tFoot()[4] === m.cards()[1][1] && tFoot()[7] === m.cards()[3][1], tFoot().join("|"));
  check("Top sellers charts", m.$$(".rgrid .rpanel h3").map((h) => h.textContent).join("|") === "Top 10 products by units sold|Revenue by category|Most popular add-ons and substitutions|Slowest sellers");
  await m.click(m.byText(".rpanel .tab", "Revenue"), 200);
  check("the top 10 can rank by revenue", m.$$(".rgrid .rpanel h3")[0].textContent === "Top 10 products by revenue");
  await m.click(m.$("table[aria-label='Top sellers'] .rowopen"), 200);
  const mini = m.$("tr.ingr table.mini");
  const each = mini ? [...mini.querySelectorAll(":scope > tbody > tr")].map((r) => dollars(r.children[2].textContent)) : [];
  check("a product opens to show its ingredients, adding up to its cost per item", each.length > 0
    && Math.abs(each.reduce((x, y) => x + y, 0) - dollars(mini.querySelector("tfoot td:last-child").textContent)) < 0.005);
  await m.click(m.$("table[aria-label='Top sellers'] .rowopen"), 200);
  check("and closes again", !m.$("tr.ingr"));
  await m.choose(m.field("Category"), "cat-bakery");
  await m.click(m.byText("button", "Run report"), 700);
  check("the Category filter narrows the ranking", tRows().length > 0 && tRows().every((r) => r[2] === "Bakery") && tRows()[0][0] === "1" && /Bakery/.test(m.$(".report .sub").textContent));

  await m.click(m.byText(".tabs .tab", "Stock losses"), 700);
  check("Stock losses starts without output", m.cards().length === 0 && m.field("From").value === "" && m.field("To").value === "");
  await m.type(m.field("From"), new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10));
  await m.type(m.field("To"), today);
  await m.click(m.byText("button", "Run report"), 700);
  const lHeads = () => m.$$("table[aria-label='Stock losses by item and reason'] thead th").map((t) => t.textContent);
  const lRows = () => m.$$("table[aria-label='Stock losses by item and reason'] tbody tr").filter((r) => r.querySelectorAll("td").length > 1).map((r) => [...r.children].map((c) => c.textContent));
  const lFoot = () => [...m.$("table[aria-label='Stock losses by item and reason'] tfoot tr").children].map((c) => c.textContent);
  check("Stock losses opens", m.$(".tabs [aria-pressed=true]").textContent === "Stock losses" && m.w.location.hash === "#losses");
  check("Stock losses filters add Reason", [...(m.field("Reason")?.options || [])].map((o) => o.textContent).join("|") === "All reasons|Broken or spilled|Spoiled or expired|Stolen");
  check("Stock losses cards", m.cards().map(([k]) => k).join("|") === "Stock lost at cost|Loss reports|Loss as % of stock used|Most common reason", m.cards().join());
  check("Stock losses columns", lHeads().join("|") === "Stock item|Reason|Reports|Amount lost|Unit|Cost", lHeads().join("|"));
  check("the Total row has Reports and Cost, no Amount", lFoot()[0] === "Total" && lFoot()[2] === m.cards()[1][1] && lFoot()[3] === "" && lFoot()[5] === m.cards()[0][1], lFoot().join("|"));
  await m.choose(m.field("Reason"), "spoiled");
  await m.click(m.byText("button", "Run report"), 700);
  check("the Reason filter narrows the table", lRows().length > 0 && lRows().every((r) => r[1] === "Spoiled or expired") && m.cards()[3][1] === "Spoiled or expired");

  await m.click(m.byText(".tabs .tab", "Labor cost"), 700);
  check("Labor starts with an empty period and no output", m.field("Pay period").value === "" && m.cards().length === 0);
  const reportOptions = await (await m.w.fetch("/api/reports/options")).json();
  await m.choose(m.field("Pay period"), reportOptions.payPeriod);
  await m.click(m.byText("button", "Run report"), 700);
  const pHeads = () => m.$$("table[aria-label='Labor cost by employee'] thead th").map((t) => t.textContent);
  const pRow = (name) => [...(m.$$("table[aria-label='Labor cost by employee'] tbody tr").find((r) => r.children[0].textContent === name)?.children || [])].map((c) => c.textContent);
  const pFoot = () => [...m.$("table[aria-label='Labor cost by employee'] tfoot tr").children].map((c) => c.textContent);
  check("Labor cost opens", m.$(".tabs [aria-pressed=true]").textContent === "Labor cost" && m.w.location.hash === "#labor");
  check("a Pay period dropdown instead of dates", !m.field("From") && /to/.test(m.field("Pay period")?.selectedOptions[0]?.textContent || "") && !m.field("Location"));
  check("Labor cost cards", m.cards().map(([k]) => k).join("|") === "Hours worked|Labor cost|Net sales|Labor as % of sales", m.cards().join());
  check("Labor cost columns", pHeads().join("|") === "Employee|Role|Shifts|Regular hours|Overtime hours|Hourly rate|Pay", pHeads().join("|"));
  check("this period: Priya at her new rate", pRow("Priya Shah")[1] === "Server" && pRow("Priya Shah")[5] === "$17.25", pRow("Priya Shah").join("|"));
  check("the Total row leaves Hourly rate blank and matches the cards", pFoot()[0] === "Total" && pFoot()[5] === "" && pFoot()[6] === m.cards()[1][1], pFoot().join("|"));
  await m.choose(m.field("Pay period"), "pp-prev");
  await m.click(m.byText("button", "Run report"), 700);
  check("an earlier period: her old rate", pRow("Priya Shah")[5] === "$16.50" && /closed/.test(m.field("Pay period").selectedOptions[0].textContent));
  await m.click(m.byText(".tabs .tab", "Customers"), 700);
  check("Customers starts without output", m.cards().length === 0 && m.field("From").value === "" && m.field("To").value === "");
  await m.type(m.field("From"), new Date(Date.parse(`${today}T00:00:00Z`) - 89 * 864e5).toISOString().slice(0, 10));
  await m.type(m.field("To"), today);
  await m.click(m.byText("button", "Run report"), 700);
  const cTable = "table[aria-label='Customers by RFM score']";
  const cHeads = m.$$(`${cTable} thead th`).map((t) => t.textContent);
  const cRows = () => m.$$(`${cTable} tbody tr`).filter((r) => r.querySelectorAll("td").length > 1).map((r) => [...r.children].map((c) => c.textContent));
  const cFoot = () => [...m.$(`${cTable} tfoot tr`).children].map((c) => c.textContent);
  check("Customers opens", m.$(".tabs [aria-pressed=true]").textContent === "Customers" && m.w.location.hash === "#customers");
  check("Customers has dates and no Location list, and goes back 90 days", !m.field("Location") && m.field("From").value === new Date(Date.parse(`${m.field("To").value}T00:00:00Z`) - 89 * 864e5).toISOString().slice(0, 10));
  check("Customers cards", m.cards().map(([k]) => k).join("|") === "Customers|Average spend|Average orders|Average days since last order", m.cards().join());
  check("Customers columns", cHeads.join("|") === "Customer|Membership|Segment|Last order|Days since|Orders|Total spend|Recency|Frequency|Spend", cHeads.join("|"));
  const tips = m.$$(`${cTable} thead .headtip`);
  check("each score header explains itself and can be reached by keyboard", tips.map((t) => t.dataset.tip).join("|") === "How recently they ordered (5 = most recent)|How often they order (5 = most often)|How much they spend (5 = highest)" && tips.every((t) => t.tabIndex === 0 && t.getAttribute("aria-label").includes(t.dataset.tip)), tips.map((t) => t.dataset.tip).join("|"));
  check("the scores are 1 to 5, centered like their headers", cRows().every((r) => r.slice(7).every((s) => /^[1-5]$/.test(s))) && m.$$(`${cTable} tbody tr:first-child td.score`).length === 3);
  check("one row per customer, matching the card", cRows().length > 0 && String(cRows().length) === m.cards()[0][1], cRows().join());
  check("the Total row adds up the spend", cFoot()[0] === "Total" && dollars(cFoot()[6]) === Math.round(cRows().reduce((a, r) => a + dollars(r[6]), 0) * 100) / 100, cFoot().join("|"));
  const mRows = () => m.$$("table[aria-label='Customers by membership'] tbody tr").map((r) => [...r.children].map((c) => c.textContent));
  check("the Membership filter lists the tiers, All by default", [...(m.field("Membership")?.options || [])].map((o) => o.textContent).join("|") === "All memberships|Bean|Gold|No membership" && m.field("Membership").value === "");
  check("the breakdown has every group, adding up to the card", mRows().map((r) => r[0]).join("|") === "Bean|Gold|No membership" && String(mRows().reduce((a, r) => a + Number(r[1]), 0)) === m.cards()[0][1], mRows().join());
  check("the minimum gaps are in the note under the cards", /At risk until 30 days after their last order, or Lapsed until 60 days/.test(m.$(".rcards").nextElementSibling?.textContent || ""), m.$(".rcards").nextElementSibling?.textContent);
  await m.choose(m.field("Membership"), "none");
  await m.click(m.byText("button", "Run report"), 700);
  check("the Membership filter narrows the table and breakdown", cRows().length > 0 && cRows().every((r) => r[1] === "No membership") && mRows().length === 1 && mRows()[0][0] === "No membership", cRows().join());
  check("the long note under the table is gone", !m.$(cTable).closest(".tablewrap").querySelector("p"));

  await m.choose(m.field("Membership"), "");
  await m.click(m.byText("button", "Run report"), 900);
  const icon = (label) => m.$$(".rcard").find((c) => c.querySelector("span").textContent === label).querySelector(".cicon svg").innerHTML;
  check("Average orders and Average days have their own icons, not the money one", icon("Average orders").includes("M8 9h8") && icon("Average days since last order").includes("M12 6v6"));
  check("the Customers panels", m.$$(".rgrid .rpanel h3").map((h) => h.textContent).join("|")
    === "Customers by segment|Revenue by segment|Spend from known customers vs walk-ins|Revenue by membership tier|Spend by customer|How scores are given", m.$$(".rgrid .rpanel h3").map((h) => h.textContent).join("|"));
  check("the walk-ins note", /refunds count against their original order, so this differs from Revenue's Net sales/.test(m.$(".rpanel[aria-label='Spend from known customers vs walk-ins']").textContent));
  check("score cut-offs say where they come from", m.$$(".scores .cuts").length === 3 && m.$$(".scores .cuts b").every((x) => x.textContent === "Values that earned each score in this report:"));
  const segRows = () => m.$$("table[aria-label='Segments'] tbody tr").map((r) => [...r.children].map((c) => c.textContent));
  check("the deep dive lists every segment, with a Total row matching the cards", segRows().map((r) => r[0]).join("|") === "Champion|Loyal|Recent|Steady|At risk|Lapsed"
    && m.$("table[aria-label='Segments'] tfoot td:nth-child(2)").textContent === m.cards()[0][1]
    && m.$("table[aria-label='Segments'] tfoot td:nth-child(8)").textContent === m.cards()[1][1], segRows().join(" / "));
  const busiest = segRows().filter((r) => r[1] !== "0")[0][0];
  await m.click(m.$$(".dpick").find((x) => x.querySelector(".hname").textContent === busiest), 200);
  check("clicking a segment slice filters the RFM table, with a chip to undo it", m.$(".chip")?.textContent.includes(`Showing: ${busiest}`) && cRows().length > 0 && cRows().every((r) => r[2] === busiest));
  await m.click(m.$(".chip"), 200);
  check("the chip shows everyone again", !m.$(".chip") && cRows().length === Number(m.cards()[0][1]));
  const first = cRows()[0];
  await m.click(m.$("table[aria-label='Customers by RFM score'] .rowopen"), 900);
  const orders = m.$("tr.ingr table.mini");
  check("a customer opens to their orders, adding up to their row", !!orders && orders.querySelector("tfoot td:last-child").textContent === first[6]
    && orders.querySelectorAll(":scope > tbody > tr").length === Number(first[5]) && m.$("tr.ingr .csum").textContent.includes("Points:"), first.join("|"));
  await m.click(m.$("table[aria-label='Customers by RFM score'] .rowopen"), 200);
  check("page: no React warnings", m.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, m.w.errors.join(" | "));

  const l = await open(base, "10420002", "222222"); // Leo works at Downtown only
  check("a manager has no location list", !l.field("Location"));
  await l.type(l.field("Day"), today);
  await l.click(l.byText("button", "Run report"), 700);
  check("and sees only their own location's figures", /Brewbean Downtown/.test(l.$(".report p.sub").textContent));
  check("manager page: no React warnings", l.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, l.w.errors.join(" | "));

  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
