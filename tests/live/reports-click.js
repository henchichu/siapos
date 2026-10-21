// Drives the real Reports page in jsdom: the tabs, Live sales by hour and by day, each report's filters, tiles and totals,
// and what an owner sees that a manager doesn't. It saves nothing.
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
  w.eval(app);
  await sleep(900);
  const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
  const set = (proto, el, v) => { Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, v); };
  return {
    w, $, $$, byText: (s, t) => $$(s).find((e) => e.textContent.trim().startsWith(t)),
    click: async (el, ms = 400) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); },
    type: async (el, v) => { set(w.HTMLInputElement, el, v); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(150); },
    choose: async (el, v) => { set(w.HTMLSelectElement, el, v); el.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(400); },
    tiles: () => Object.fromEntries($$(".tile").map((t) => [t.querySelector("span").textContent, t.querySelector("b").textContent])),
    heads: () => $$(".rsection thead th").map((t) => t.textContent).join("|"),
    rows: () => $$(".rsection tbody tr").filter((r) => !r.querySelector(".note")).map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim())),
    foot: () => [...($(".rsection tfoot tr")?.querySelectorAll("td") || [])].map((c) => c.textContent.trim()),
    select: (label) => [...$$(".filters label")].find((l) => l.textContent.startsWith(label))?.querySelector("select, input"),
  };
}
const options = (sel) => [...sel.options].map((o) => o.textContent).join("|");
const yesterday = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);

(async () => {
  const { server, base } = await start();
  const m = await open(base, "10420002", "222222");
  const today = m.select("Day").value;

  check("five tabs, Live sales first and open", m.$$(".reports .tab[role], .reports > .tabs .tab").map((t) => t.textContent).join("|") === "Live sales|1. Sales by day|2. Top sellers|3. Labor cost|4. Stock losses"
    && m.byText(".tabs .tab", "Live sales").getAttribute("aria-pressed") === "true");
  check("the sidebar marks Reports", m.$(".nav [aria-current=page]")?.textContent === "Reports");
  check("a manager's Live sales shows only their own location", options(m.select("Location")) === "Brewbean Campus");
  check("By hour is on and the time it was updated shows", m.byText(".filters .tab", "By hour").getAttribute("aria-pressed") === "true" && /^Updated \d/.test(m.$(".updated")?.textContent));
  check("today's tiles, net sales so far in the dark one", Object.keys(m.tiles()).join("|") === "Gross sales|Discounts|Refunds|Net sales so far|Cost of goods|Profit|Tips" && m.$(".tile.dark span").textContent === "Net sales so far");

  await m.type(m.select("Day"), yesterday(today));
  await sleep(400);
  const hours = m.rows();
  check("a past day is just Net sales", !!m.tiles()["Net sales"]);
  check("hour by hour columns", m.heads() === "Hour|Orders|Gross|Discounts|Refunds|Net sales|Cost|Profit|Running net", m.heads());
  check("one row per hour from the first sale to the last", hours.length > 3 && hours.every((r) => /^\d{1,2} (AM|PM)$/.test(r[0])), hours.map((r) => r[0]).join(","));
  check("one bar per hour, labelled", m.$$(".plot .col").length === hours.length && m.$$(".ticks span")[0].textContent === hours[0][0]);
  check("running net ends on the total net", hours.at(-1)[8] === m.foot()[5] && m.foot()[5] === m.tiles()["Net sales"], `${hours.at(-1)[8]} ${m.foot()[5]}`);
  check("discounts and refunds read as money off", m.foot()[3].startsWith("−") || m.foot()[3] === "$0.00");
  m.$$(".plot .col")[1].dispatchEvent(new m.w.MouseEvent("mouseover", { bubbles: true }));
  await sleep(150);
  check("hovering a bar shows its hour and figures", new RegExp(`^${hours[1][0]}`).test(m.$(".tip")?.textContent || "") && /net/.test(m.$(".tip").textContent), m.$(".tip")?.textContent);

  await m.click(m.byText(".filters .tab", "By day"));
  const week = m.rows();
  check("By day runs Monday to the chosen day", /^Mon/.test(week[0][0]) && week.length >= 1 && week.length <= 7 && m.heads().startsWith("Day|"), week.map((r) => r[0]).join(","));

  await m.click(m.byText(".tabs .tab", "1. Sales by day"));
  check("Sales by day: the tab is in the address", m.w.location.hash === "#sales");
  check("its tiles", Object.keys(m.tiles()).join("|") === "Net sales|Orders|Average order|Tax collected");
  check("its filters: dates, location with All", options(m.select("Location")) === "All locations|Brewbean Campus|Brewbean Downtown" && m.select("From date").value < m.select("To date").value);
  check("a bar for each of the seven days", m.$$(".plot .col").length === 7);
  check("table columns", m.heads() === "Date|Location|Orders|Gross|Discounts|Refunds|Net sales", m.heads());
  check("the Total row matches the Net sales tile", m.foot()[6] === m.tiles()["Net sales"] && m.foot()[2] === m.tiles().Orders);
  await m.choose(m.select("Location"), "loc-downtown");
  await m.click(m.byText(".filters button", "Run report"));
  check("Run report narrows to one location", m.rows().length > 0 && m.rows().every((r) => r[1] === "Brewbean Downtown"));
  await m.type(m.select("From date"), "2026-12-01");
  await m.click(m.byText(".filters button", "Run report"));
  check("a From date after the To date is refused", /on or before/.test(m.$(".msg.error")?.textContent || ""), m.$(".msg")?.textContent);

  await m.click(m.byText(".tabs .tab", "2. Top sellers"));
  check("Top sellers: one ranking with Category as a column", m.$(".rsection h3").textContent === "Top sellers" && m.heads() === "Rank|Product|Category|Units sold|Revenue|Cost|Margin $|Margin %", m.heads());
  check("its tiles", Object.keys(m.tiles()).join("|") === "Units sold|Revenue|Cost of goods|Margin");
  check("ranked from 1", m.rows()[0][0] === "1" && m.rows().every((r, i) => r[0] === String(i + 1)));
  await m.choose(m.select("Category"), m.$$("select option").find((o) => o.textContent === "Bakery").value);
  await m.click(m.byText(".filters button", "Run report"));
  check("the Category filter keeps one category", m.rows().length > 0 && m.rows().every((r) => r[2] === "Bakery"));

  await m.click(m.byText(".tabs .tab", "3. Labor cost"));
  check("Labor cost: a pay period dropdown, the current one chosen", m.select("Pay period").value === "pp-curr" && / to /.test(m.select("Pay period").selectedOptions[0].textContent));
  check("its tiles", Object.keys(m.tiles()).join("|") === "Hours worked|Labor cost|Net sales|Labor as % of sales");
  check("labor by employee", m.heads() === "Employee|Role|Shifts|Regular hours|Overtime hours|Hourly rate|Pay" && m.rows().some((r) => r[0] === "Sam Rivera"));
  check("the Total row's pay matches the Labor cost tile", m.foot()[6] === m.tiles()["Labor cost"] && m.foot()[5] === "");

  await m.click(m.byText(".tabs .tab", "4. Stock losses"));
  check("Stock losses: three reasons", options(m.select("Reason")) === "All reasons|Broken or spilled|Spoiled or expired|Stolen");
  check("its tiles", Object.keys(m.tiles()).join("|") === "Stock lost, at cost|Loss reports|Loss as % of stock used|Most common reason");
  check("its table", m.heads() === "Stock item|Reason|Reports|Amount lost|Unit|Cost");

  m.w.history.back(); await sleep(300);
  check("Back returns to the previous tab", m.byText(".tabs .tab", "3. Labor cost").getAttribute("aria-pressed") === "true");
  check("manager page: no React warnings", m.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, m.w.errors.join(" | "));

  const o = await open(base, "10420001", "111111");
  check("an owner's Live sales covers All locations", options(o.select("Location")) === "All locations|Brewbean Campus|Brewbean Downtown" && o.select("Location").value === "all");
  check("owner page: no React warnings", o.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, o.w.errors.join(" | "));

  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
