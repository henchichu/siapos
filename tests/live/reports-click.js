// Drives the real Reports page in jsdom: the tabs, Sales by day's filters, cards, chart and table, as an owner and as a manager.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = ["api", "shell", "reports"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

async function open(base, number, pin) {
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: number, pin }) });
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
    heads: () => $$("table[aria-label='Sales by day and location'] thead th").map((t) => t.textContent),
    rows: () => $$("table[aria-label='Sales by day and location'] tbody tr").filter((r) => r.querySelectorAll("td").length > 1),
    foot: () => [...($("table[aria-label='Sales by day and location'] tfoot tr")?.querySelectorAll("td") || [])].map((c) => c.textContent),
    cards: () => $$(".rcard").map((c) => [c.querySelector("span").textContent, c.querySelector("b").textContent]),
    bars: () => $$(".chart .col"),
  };
}
const dollars = (s) => Number(s.replace(/[$,]/g, "").replace("−", "-"));

(async () => {
  const { server, base } = await start();
  const m = await open(base, "10420001", "111111");

  check("the sidebar has Reports, marked as this page", m.$(".nav [aria-current=page]")?.textContent === "Reports");
  check("five tabs, as in the wireframes", m.$$(".tabs[aria-label=Reports] .tab").map((t) => t.textContent).join("|") === "Live sales|1. Sales by day|2. Top sellers|3. Labor cost|4. Stock losses");
  check("Live sales is open", m.$(".tabs [aria-pressed=true]")?.textContent === "Live sales" && !!m.$("section[aria-label='Live sales']"));
  const { today } = await (await m.w.fetch("/api/reports/options")).json();
  check("Live sales filters: a Day, today, and Location", m.field("Day")?.value === today && !m.field("From") && m.field("Location").value === "all");
  check("seven cards, Net sales so far in black", m.cards().map(([k]) => k).join("|") === "Gross sales|Discounts|Refunds|Net sales so far|Cost of goods|Profit|Tips"
    && m.$$(".rcard")[3].className.includes("dark"), m.cards().join());
  const hHeads = () => m.$$("section[aria-label='Live sales'] table thead th").map((t) => t.textContent);
  const hRows = () => m.$$("section[aria-label='Live sales'] table tbody tr").filter((r) => r.querySelectorAll("td").length > 1).map((r) => [...r.children].map((c) => c.textContent));
  const hFoot = () => [...m.$("section[aria-label='Live sales'] table tfoot tr").children].map((c) => c.textContent);
  check("Hour by hour columns", m.$("section[aria-label='Live sales'] .tablewrap h3").textContent === "Hour by hour"
    && hHeads().join("|") === "Hour|Orders|Gross|Discounts|Refunds|Net sales|Cost|Profit|Running net", hHeads().join("|"));
  check("hours in order, a bar each", hRows().length > 0 && hRows().every((r) => /^\d+ (AM|PM)$/.test(r[0])) && m.bars().length === hRows().length && m.$(".chart h3").textContent === "Net sales by hour");
  check("running net adds up to Net sales, and the Total row leaves it blank", hRows().at(-1)[8] === m.cards()[3][1] && hFoot()[5] === m.cards()[3][1] && hFoot()[8] === "", hFoot().join("|"));
  check("Updated, and a refresh every minute while it's today", /Updated \d/.test(m.$(".livebar").textContent) && [...m.w.timers.values()].some((t) => t.ms === 60000));

  const ordersNow = Number(hFoot()[1]);
  const sam = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: "10420003", pin: "333333" }) });
  const sale = await fetch(base + "/api/register/orders", { method: "POST", headers: { "content-type": "application/json", cookie: sam.headers.get("set-cookie").split(";")[0] },
    body: JSON.stringify({ items: [{ key: "a", variantId: "var-amer-s", quantity: 1 }], payment: { method: "cash" } }) });
  check("(a sale comes in)", sale.status === 200);
  [...m.w.timers.values()].find((t) => t.ms === 60000).fn(); await sleep(700);
  check("the next refresh shows it without Run report", Number(hFoot()[1]) === ordersNow + 1, `${ordersNow} -> ${hFoot()[1]}`);

  await m.click(m.byText(".livebar button", "By day"), 700);
  check("By day: Monday up to today", m.$("section[aria-label='Live sales'] .tablewrap h3").textContent === "Day by day" && hHeads()[0] === "Day"
    && hRows().at(-1)[0].includes(new Date(`${today}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })) && hRows()[0][0].startsWith("Mon"));
  const past = new Date(Date.parse(`${today}T00:00:00Z`) - 8 * 864e5).toISOString().slice(0, 10);
  await m.type(m.field("Day"), past);
  await m.click(m.byText("button", "Run report"), 700);
  check("an earlier day: no refresh, Net sales without 'so far'", ![...m.w.timers.values()].some((t) => t.ms === 60000) && /As of/.test(m.$(".livebar").textContent) && m.cards()[3][0] === "Net sales");

  await m.click(m.byText(".tabs .tab", "1. Sales by day"), 700);
  check("Sales by day opens", m.$(".tabs [aria-pressed=true]")?.textContent === "1. Sales by day");
  check("filters: From, To, Location and Run report", !!m.field("From") && !!m.field("To") && !!m.field("Location") && !!m.byText("button", "Run report"));
  check("an owner starts on All locations", m.field("Location").value === "all" && m.field("Location").options[0].textContent === "All locations");
  check("the four cards", m.cards().map(([k]) => k).join("|") === "Net sales|Orders|Average order|Tax collected", m.cards().join());
  check("one bar per day, last 7 days", m.bars().length === 7);
  check("table columns", m.heads().join("|") === "Date|Location|Orders|Gross|Discounts|Refunds|Net sales", m.heads().join("|"));
  check("a row per day and location", m.rows().length >= 12 && m.rows().some((r) => r.textContent.includes("Brewbean Campus")) && m.rows().some((r) => r.textContent.includes("Brewbean Downtown")));
  const sumNet = m.rows().reduce((a, r) => a + dollars(r.lastElementChild.textContent), 0);
  check("the Total row adds up and matches Net sales", m.foot()[0] === "Total" && Math.abs(dollars(m.foot()[6]) - sumNet) < 0.005 && m.foot()[6] === m.cards()[0][1], m.foot().join("|"));

  m.bars()[6].dispatchEvent(new m.w.MouseEvent("mouseover", { bubbles: true })); await sleep(100);
  check("hovering a bar shows its day and amount", /\$\d/.test(m.$(".tip")?.textContent || ""), m.$(".tip")?.textContent);

  const to = m.field("To").value;
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 13 * 864e5).toISOString().slice(0, 10);
  await m.type(m.field("From"), from);
  await m.choose(m.field("Location"), "loc-downtown");
  check("the report waits for Run report", m.bars().length === 7);
  await m.click(m.byText("button", "Run report"), 700);
  check("Run report: 14 days, Downtown only", m.bars().length === 14 && m.rows().every((r) => r.children[1].textContent === "Brewbean Downtown") && /Brewbean Downtown/.test(m.$(".report .sub").textContent));

  await m.type(m.field("From"), "2026-12-01");
  await m.click(m.byText("button", "Run report"), 500);
  check("a From after To is explained", /on or before/.test(m.$(".report .msg")?.textContent || ""));

  await m.click(m.byText(".tabs .tab", "2. Top sellers"), 700);
  check("Top sellers opens without a reload", m.$(".tabs [aria-pressed=true]").textContent === "2. Top sellers" && m.w.location.hash === "#top-sellers" && !!m.$("section[aria-label='Top sellers']"));
  check("Top sellers filters add Category", !!m.field("From") && !!m.field("To") && m.field("Location").value === "all" && m.field("Category")?.value === ""
    && [...m.field("Category").options].map((o) => o.textContent).join("|") === "All categories|Bakery|Coffee|Retail|Tea|No category");
  check("Top sellers cards", m.cards().map(([k]) => k).join("|") === "Units sold|Revenue|Cost of goods|Margin %", m.cards().join());
  const tHeads = () => m.$$("table[aria-label='Top sellers'] thead th").map((t) => t.textContent);
  const tRows = () => m.$$("table[aria-label='Top sellers'] tbody tr").filter((r) => r.querySelectorAll("td").length > 1).map((r) => [...r.children].map((c) => c.textContent));
  const tFoot = () => [...m.$("table[aria-label='Top sellers'] tfoot tr").children].map((c) => c.textContent);
  check("Top sellers columns", tHeads().join("|") === "Rank|Product|Category|Units sold|Revenue|Cost|Margin $|Margin %", tHeads().join("|"));
  check("ranked 1, 2, 3… by units sold", tRows().length > 3 && tRows().every((r, i) => r[0] === String(i + 1)) && tRows().every((r, i, a) => !i || Number(a[i - 1][3]) >= Number(r[3])));
  check("the Total row matches the cards", tFoot()[0] === "Total" && tFoot()[3] === m.cards()[0][1] && tFoot()[4] === m.cards()[1][1] && tFoot()[7] === m.cards()[3][1], tFoot().join("|"));
  await m.choose(m.field("Category"), "cat-bakery");
  await m.click(m.byText("button", "Run report"), 700);
  check("the Category filter narrows the ranking", tRows().length > 0 && tRows().every((r) => r[2] === "Bakery") && tRows()[0][0] === "1" && /Bakery/.test(m.$(".report .sub").textContent));

  await m.click(m.byText(".tabs .tab", "4. Stock losses"), 700);
  const lHeads = () => m.$$("table[aria-label='Stock losses by item and reason'] thead th").map((t) => t.textContent);
  const lRows = () => m.$$("table[aria-label='Stock losses by item and reason'] tbody tr").filter((r) => r.querySelectorAll("td").length > 1).map((r) => [...r.children].map((c) => c.textContent));
  const lFoot = () => [...m.$("table[aria-label='Stock losses by item and reason'] tfoot tr").children].map((c) => c.textContent);
  check("Stock losses opens", m.$(".tabs [aria-pressed=true]").textContent === "4. Stock losses" && m.w.location.hash === "#losses");
  check("Stock losses filters add Reason", [...(m.field("Reason")?.options || [])].map((o) => o.textContent).join("|") === "All reasons|Broken or spilled|Spoiled or expired|Stolen");
  check("Stock losses cards", m.cards().map(([k]) => k).join("|") === "Stock lost at cost|Loss reports|Loss as % of stock used|Most common reason", m.cards().join());
  check("Stock losses columns", lHeads().join("|") === "Stock item|Reason|Reports|Amount lost|Unit|Cost", lHeads().join("|"));
  check("the Total row has Reports and Cost, no Amount", lFoot()[0] === "Total" && lFoot()[2] === m.cards()[1][1] && lFoot()[3] === "" && lFoot()[5] === m.cards()[0][1], lFoot().join("|"));
  await m.choose(m.field("Reason"), "spoiled");
  await m.click(m.byText("button", "Run report"), 700);
  check("the Reason filter narrows the table", lRows().length > 0 && lRows().every((r) => r[1] === "Spoiled or expired") && m.cards()[3][1] === "Spoiled or expired");

  await m.click(m.byText(".tabs .tab", "3. Labor cost"), 700);
  const pHeads = () => m.$$("table[aria-label='Labor cost by employee'] thead th").map((t) => t.textContent);
  const pRow = (name) => [...(m.$$("table[aria-label='Labor cost by employee'] tbody tr").find((r) => r.children[0].textContent === name)?.children || [])].map((c) => c.textContent);
  const pFoot = () => [...m.$("table[aria-label='Labor cost by employee'] tfoot tr").children].map((c) => c.textContent);
  check("Labor cost opens", m.$(".tabs [aria-pressed=true]").textContent === "3. Labor cost" && m.w.location.hash === "#labor");
  check("a Pay period dropdown instead of dates", !m.field("From") && /to/.test(m.field("Pay period")?.selectedOptions[0]?.textContent || "") && !!m.field("Location"));
  check("Labor cost cards", m.cards().map(([k]) => k).join("|") === "Hours worked|Labor cost|Net sales|Labor as % of sales", m.cards().join());
  check("Labor cost columns", pHeads().join("|") === "Employee|Role|Shifts|Regular hours|Overtime hours|Hourly rate|Pay", pHeads().join("|"));
  check("this period: Sam at his new rate", pRow("Sam Rivera")[1] === "Server" && pRow("Sam Rivera")[5] === "$17.25", pRow("Sam Rivera").join("|"));
  check("the Total row leaves Hourly rate blank and matches the cards", pFoot()[0] === "Total" && pFoot()[5] === "" && pFoot()[6] === m.cards()[1][1], pFoot().join("|"));
  await m.choose(m.field("Pay period"), "pp-prev");
  await m.click(m.byText("button", "Run report"), 700);
  check("an earlier period: his old rate", pRow("Sam Rivera")[5] === "$16.50" && /closed/.test(m.field("Pay period").selectedOptions[0].textContent));
  check("page: no React warnings", m.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, m.w.errors.join(" | "));

  const l = await open(base, "10420002", "222222");
  await l.click(l.byText(".tabs .tab", "1. Sales by day"), 700);
  const opts = [...l.field("Location").options].map((o) => o.textContent);
  check("a manager sees only their own location", opts.length === 1 && !opts.includes("All locations") && l.field("Location").disabled, opts.join());
  check("and their own figures", l.rows().length > 0 && l.rows().every((r) => r.children[1].textContent === opts[0]));
  check("manager page: no React warnings", l.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, l.w.errors.join(" | "));

  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
