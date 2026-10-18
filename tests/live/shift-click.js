// Drives the real My shift and Team timecards pages in jsdom: a barista's clock, a manager's tabs, filters and dialogs.
// Adds a clock-in/out for Jordan and reads (does not change) the shared timecards.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = ["api", "shell", "shift"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

async function open(base, number, pin, hash = "") {
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: number, pin }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/shift.html" + hash, pretendToBeVisual: true }).window;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
  w.eval(app);
  await sleep(900);
  const $ = (sel) => w.document.querySelector(sel);
  const $$ = (sel) => [...w.document.querySelectorAll(sel)];
  return { w, $, $$, text: () => w.document.body.textContent, byText: (sel, t) => $$(sel).find((e) => e.textContent.trim().startsWith(t)),
           click: async (el, ms = 300) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); } };
}

(async () => {
  const { server, base } = await start();

  // Barista: straight to My shift, no tabs
  const b = await open(base, "10420005", "555555");
  check("barista opens My shift with no tabs", /Time clock/.test(b.text()) && !b.$(".tabs") && !/Team timecards/.test(b.text()));
  check("barista menu: Kitchen and My shift only, My shift current", b.$$(".nav a.link").map((a) => a.textContent).join("|") === "Kitchen|My shift" && b.byText(".nav a.link", "My shift").getAttribute("aria-current") === "page");
  check("labels filled: employee, location, rate", /Jordan Lee/.test(b.text()) && /Brewbean Campus/.test(b.text()) && /Hourly rate: \$16\.00/.test(b.text()));
  const btn = (t) => b.byText(".tbtn", t);
  check("clocked out: only Clock in is enabled", !btn("Clock in").disabled && btn("Clock out").disabled && btn("Break Start").disabled && btn("Break End").disabled && /Not clocked in/.test(b.text()));
  await b.click(btn("Clock in"), 600);
  check("clocked in: Clock in disabled, Break Start and Clock out enabled", btn("Clock in").disabled && !btn("Break Start").disabled && !btn("Clock out").disabled && btn("Break End").disabled && /Clocked in since/.test(b.text()));
  check("the open shift shows as OPEN with no hours", /OPEN/.test(b.text()));
  await b.click(btn("Break Start"), 600);
  check("on a break: only Break End (and Clock out) enabled", btn("Break Start").disabled && !btn("Break End").disabled && !btn("Clock out").disabled);
  await b.click(btn("Break End"), 600);
  check("break ended: Break Start enabled again", !btn("Break Start").disabled && btn("Break End").disabled);
  await sleep(1100);
  await b.click(btn("Clock out"), 300);
  check("Clock out asks first", !!b.$("dialog[open]") && /submit this shift/.test(b.text()));
  await b.click(b.byText("dialog button", "Cancel"), 200);
  check("Cancel keeps the shift open", /Clocked in since/.test(b.text()));
  await b.click(btn("Clock out"), 300);
  await b.click(b.byText("dialog button", "Clock out"), 700);
  check("confirmed: shift submitted", /Not clocked in/.test(b.text()) && /SUBMITTED/.test(b.text()) && !btn("Clock out") .disabled === false);
  check("sales cards present", /Today's sales at Brewbean Campus/.test(b.text()) && /Orders/.test(b.text()) && /Net sales/.test(b.text()) && /Items sold/.test(b.text()));
  check("barista page: no React warnings", b.w.errors.length === 0, b.w.errors.join(" | "));

  // Manager: Team timecards first, with the toggle
  const m = await open(base, "10420002", "222222");
  check("manager opens Team timecards", /Timecards/.test(m.text()) && !!m.$(".filters") && m.byText(".tab", "Team timecards").getAttribute("aria-pressed") === "true");
  check("manager sees all nine menu links", m.$$(".nav a.link").length === 9);
  check("counter text", /\d+ waiting for approval/.test(m.text()));
  const rows = () => m.$$(".cards tbody tr").filter((r) => r.querySelectorAll("td").length > 1);
  check("default filter lists only SUBMITTED rows with Approve, Reject, Edit", rows().length > 0 && rows().every((r) => /SUBMITTED/.test(r.textContent) && /Approve/.test(r.textContent) && /Reject/.test(r.textContent) && /Edit/.test(r.textContent)));
  const status = m.$$(".filters select")[2];
  const set = async (el, v) => { Object.getOwnPropertyDescriptor(m.w.HTMLSelectElement.prototype, "value").set.call(el, v); el.dispatchEvent(new m.w.Event("change", { bubbles: true })); await sleep(80); };
  await set(m.$$(".filters select")[0], "pp-curr"); // the seeded approved and rejected cards are in the earlier period
  await set(status, "APPROVED"); await m.click(m.byText(".filters button", "Show"), 700);
  check("Show with Approved: rows say who approved, no buttons", rows().length > 0 && rows().every((r) => /APPROVED/.test(r.textContent) && /Approved by \w+/.test(r.textContent) && !r.querySelector("button")));
  await set(m.$$(".filters select")[2], "REJECTED"); await m.click(m.byText(".filters button", "Show"), 700);
  check("Rejected rows offer only Edit", rows().length > 0 && rows().every((r) => r.querySelectorAll("button").length === 1 && /Edit/.test(r.textContent)));
  await m.click(rows()[0].querySelector("button"), 300);
  check("Edit opens a form with the row's clock in, clock out and break", !!m.$("dialog[open] input[type=datetime-local]") && m.$$("dialog input").length === 3);
  await m.click(m.byText("dialog button", "Cancel"), 200);
  await m.click(m.byText(".tab", "My shift"), 700);
  check("My shift tab shows the manager's own clock; hash #shift", /Time clock/.test(m.text()) && m.w.location.hash === "#shift");
  await m.click(m.byText(".tab", "Team timecards"), 700);
  check("Team timecards tab returns", !!m.$(".filters"));
  await m.click(m.byText(".closing button", "Close pay period"), 300);
  check("Close pay period asks first", !!m.$("dialog[open]") && /locked/.test(m.text()));
  await m.click(m.byText("dialog button", "Cancel"), 200);
  check("manager page: no React warnings", m.w.errors.length === 0, m.w.errors.join(" | "));

  // Placeholder menu pages
  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
