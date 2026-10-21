// Drives the real Rewards page in jsdom: search, Show inactive, Enroll / Edit / Clear, Deactivate / Reactivate, then a
// member's history and an order's details, and Back to members; then as a server. The member it enrolls is removed at the end.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = ["api", "shell", "rewards"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };
const TAG = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
const LAST = `Clicker ${TAG}`;
let chloe; // her membership as it was before the run; the page is checked with her active
const cleanup = async () => {
  if (chloe) await pool.query("UPDATE LoyaltyAccount SET Active = ? WHERE CustomerID = 'cus-chloe'", [chloe.active]);
  const [rows] = await pool.query("SELECT CustomerID AS id FROM Customer WHERE LastName = ?", [LAST]);
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  await pool.query("DELETE FROM LoyaltyAccount WHERE CustomerID IN (?)", [ids]);
  await pool.query("DELETE FROM Customer WHERE CustomerID IN (?)", [ids]);
};

async function open(base, number, pin, at = "/rewards.html") {
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: number, pin }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + at, pretendToBeVisual: true }).window;
  w.calls = []; // what the page asked the server for
  w.fetch = (url, opts = {}) => { w.calls.push(url); return fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } }); };
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.scrollTo = () => {};
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
  w.eval(app);
  await sleep(900);
  const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
  const set = (proto, el, v) => Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, v);
  return {
    w, $, $$,
    field: (label) => $$(".pform label").find((l) => l.querySelector("b")?.textContent === label)?.querySelector("input"),
    byText: (s, t) => $$(s).find((e) => e.textContent.trim().startsWith(t)),
    click: async (el, ms = 500) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); },
    type: async (el, v, ms = 80) => { set(w.HTMLInputElement, el, v); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(ms); },
    search: () => $("input[type=search]"),
    rows: () => $$("table[aria-label=Members] tbody tr").filter((r) => r.querySelectorAll("td").length > 1),
    row: (name) => $$("table[aria-label=Members] tbody tr").find((r) => r.querySelector("td")?.textContent.startsWith(name)),
    cells: (r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim()),
    title: () => $(".pform h2")?.textContent,
    message: () => $(".pform .msg")?.textContent || "",
  };
}

(async () => {
  const { server, base } = await start();
  [[chloe]] = await pool.query("SELECT Active AS active FROM LoyaltyAccount WHERE CustomerID = 'cus-chloe'");
  await pool.query("UPDATE LoyaltyAccount SET Active = TRUE WHERE CustomerID = 'cus-chloe'");
  const m = await open(base, "10420002", "222222");

  check("the sidebar has Rewards, marked as this page", m.$(".nav [aria-current=page]")?.textContent === "Rewards");
  check("table columns from the wireframe", m.$$("table[aria-label=Members] thead th").map((t) => t.textContent).join("|") === "Name|Contact|Tier|Points|Status|Actions");
  check("members only: Ava and Chloe, not the customers Ben and Diego", !!m.row("Ava Nguyen") && !!m.row("Chloe Moreau") && !m.row("Ben") && !m.row("Diego"));
  check("a row: name, email (phone under it), tier, points, status, actions", m.cells(m.row("Chloe Moreau")).slice(0, 2).join("|") === "Chloe Moreau|chloe@example.com312-555-0177"
    && m.cells(m.row("Chloe Moreau"))[2] === "Bean" && m.cells(m.row("Chloe Moreau"))[4] === "Active" && m.cells(m.row("Chloe Moreau"))[5] === "EditHistoryDeactivate", m.cells(m.row("Chloe Moreau")).join("|"));
  check("Enroll member form, with the note under it", m.title() === "Enroll member" && /Email or phone is required \(at least one\)\./.test(m.$(".pform").textContent));

  // typing: one search, after the typing stops, and no page reload
  const before = m.w.calls.length;
  for (const v of ["c", "ch", "chl"]) await m.type(m.search(), v, 60);
  await sleep(500);
  const searches = m.w.calls.slice(before).filter((u) => u.startsWith("/api/rewards/members?"));
  check("search waits for the typing to stop: one request for three keystrokes", searches.length === 1 && searches[0].includes("q=chl"), searches.join(" "));
  check("and filters the table", m.rows().length === 1 && !!m.row("Chloe Moreau"));
  check("the search is kept in the address", m.w.location.search === "?q=chl");
  await m.type(m.search(), "", 500);
  check("a phone's digits find them too", await (async () => { await m.type(m.search(), "0177", 500); return m.rows().length === 1 && !!m.row("Chloe"); })());
  await m.type(m.search(), "", 500);

  await m.click(m.byText("button", "Save"));
  check("Save with nothing filled in says what's missing", /first name/.test(m.message()) && /email or a phone/.test(m.message()), m.message());
  await m.type(m.field("First name"), "Click");
  await m.type(m.field("Last name"), LAST);
  await m.type(m.field("Phone"), "(773) 555 01 99x");
  await m.click(m.byText("button", "Save"));
  check("a bad phone is refused", /10 digits/.test(m.message()), m.message());
  await m.type(m.field("Phone"), "");
  await m.type(m.field("Email"), `Click${TAG}@Example.com`);
  await m.click(m.byText("button", "Save"), 800);
  check("Save enrolls them and says so", m.message() === `Enrolled Click ${LAST}.`, m.message());
  check("the form is cleared", m.title() === "Enroll member" && m.field("First name").value === "" && m.field("Email").value === "");
  check("they appear in the list, email in lowercase, lowest tier, 0 points", !!m.row(`Click ${LAST}`)
    && m.cells(m.row(`Click ${LAST}`)).slice(1, 5).join("|") === `click${TAG}@example.com|Bean|0|Active`, m.row(`Click ${LAST}`) && m.cells(m.row(`Click ${LAST}`)).join("|"));

  await m.click(m.row(`Click ${LAST}`).querySelector("button"));
  check("Edit loads them into the form as Edit member", m.title() === "Edit member" && m.field("First name").value === "Click" && m.field("Email").value === `click${TAG}@example.com`);
  check("the row being edited is marked", m.row(`Click ${LAST}`).className.includes("sel"));
  await m.type(m.field("Email"), "chloe@example.com");
  await m.click(m.byText("button", "Save"));
  check("a taken email is named", m.message() === "That email is already used by member Chloe Moreau.", m.message());
  await m.type(m.field("Email"), `click${TAG}@example.com`);
  await m.type(m.field("Phone"), "773.555.0198");
  await m.click(m.byText("button", "Save"), 800);
  check("Save updates them and goes back to Enroll member", m.message() === `Saved Click ${LAST}.` && m.title() === "Enroll member"
    && m.cells(m.row(`Click ${LAST}`))[1] === `click${TAG}@example.com773-555-0198`, m.message());
  await m.click(m.row(`Click ${LAST}`).querySelector("button"));
  await m.click(m.byText("button", "Clear"));
  check("Clear switches back to Enroll member", m.title() === "Enroll member" && m.field("First name").value === "");

  await m.click(m.row(`Click ${LAST}`).querySelectorAll("button")[2]);
  check("Deactivate asks first", new RegExp(`Deactivate Click ${LAST}\\?`).test(m.$("dialog[open]")?.textContent || ""));
  await m.click(m.byText("dialog .btn", "Deactivate"), 800);
  check("then hides them", !m.row(`Click ${LAST}`) && /Deactivated Click/.test(m.$(".pview .msg")?.textContent || ""));
  await m.click(m.byText("label", "Show inactive").querySelector("input"), 800);
  check("Show inactive lists them with Reactivate", m.cells(m.row(`Click ${LAST}`))[4] === "Inactive" && m.cells(m.row(`Click ${LAST}`))[5] === "EditHistoryReactivate");
  check("Show inactive is kept in the address", m.w.location.search === "?inactive=1");
  await m.click(m.row(`Click ${LAST}`).querySelectorAll("button")[2], 800);
  check("Reactivate brings them back", m.cells(m.row(`Click ${LAST}`))[4] === "Active");

  // History, with a search to come back to
  await m.type(m.search(), "chloe", 600);
  await m.click(m.row("Chloe Moreau").querySelectorAll("button")[1], 900);
  check("History opens Member history", m.$("h2")?.textContent === "Member history" && /member=cus-chloe/.test(m.w.location.search));
  const cards = m.$$(".mcards > div").map((d) => `${d.querySelector("span").textContent}=${d.querySelector("b").textContent}`);
  check("cards: name and tier, points, orders, total spent", cards.length === 4 && cards[0] === "Chloe Moreau=Bean" && /^Points balance=\d+$/.test(cards[1])
    && /^Orders=\d+$/.test(cards[2]) && /^Total spent=\$\d+\.\d\d$/.test(cards[3]), cards.join(" | "));
  check("contact · member since", /^chloe@example\.com · 312-555-0177 · member since \w{3} \d+, \d{4}$/.test(m.byText(".phead .sub", "chloe")?.textContent || ""));
  check("history columns", m.$$("table[aria-label='Orders and points'] thead th").map((t) => t.textContent).join("|") === "Date|Order|Source|Items|Total|Points earned|Points redeemed|");
  const first = m.$("table[aria-label='Orders and points'] tbody tr");
  check("a row: date, order, source, items, total, points, View", /\d{4}, \d+:\d\d/.test(first.cells[0].textContent) && /^(Register|Online)$/.test(first.cells[2].textContent)
    && /\d+ items?/.test(first.cells[3].textContent) && /^\$/.test(first.cells[4].textContent) && first.cells[7].textContent === "View", [...first.cells].map((c) => c.textContent).join("|"));
  await m.click(first.querySelector("button"), 800);
  const dlg = m.$("dialog[open]");
  check("View shows the order's details", new RegExp(`^Order ${first.cells[1].textContent.replace(/\D.*/, "")}`).test(dlg?.querySelector("h2")?.textContent || "")
    && /Subtotal/.test(dlg.textContent) && /Total/.test(dlg.textContent) && /Points/.test(dlg.textContent), dlg?.textContent.slice(0, 200));
  await m.click(m.byText("dialog .btn", "Close"));
  check("Close shuts it", !m.$("dialog[open]"));
  await m.click(m.byText("button", "Back to members"), 900);
  check("Back to members keeps the search", m.$("h2")?.textContent === "Rewards members" && m.search().value === "chloe" && m.rows().length === 1);
  check("page: no React warnings", m.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, m.w.errors.join(" | "));

  // A server looks up, enrolls and sees history, but doesn't edit or deactivate
  const s = await open(base, "10420003", "333333");
  check("server: History only", s.cells(s.row("Ava Nguyen"))[5] === "History");
  check("server: can enroll", s.title() === "Enroll member");
  // opened straight on a member's history, as the browser's Back would
  const h = await open(base, "10420003", "333333", "/rewards.html?member=cus-ava&q=ava");
  check("server: Ava's history from the address", h.$(".mcards b")?.textContent === "Gold");
  await h.click(h.byText("button", "Back to members"), 900);
  check("and back to her in the list", h.search().value === "ava" && h.rows().length === 1);
  check("server page: no React warnings", [s, h].every((p) => p.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0), s.w.errors.concat(h.w.errors).join(" | "));

  await cleanup();
  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1); });
