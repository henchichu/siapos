// Drives the real Employees page in jsdom as the owner: the table and its filters, Edit and Clear, adding someone,
// and Deactivate / Reactivate; then as a manager. The employee it adds is removed at the end.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = ["api", "shell", "employees"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };
const NUMBER = `9998${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
const cleanup = async () => {
  const [rows] = await pool.query("SELECT EmployeeID AS id FROM Employee WHERE EmployeeNumber = ?", [NUMBER]);
  if (!rows.length) return;
  for (const t of ["EmployeeCredential", "EmployeePayRate", "EmployeeLocation", "Employee"]) await pool.query(`DELETE FROM ${t} WHERE EmployeeID = ?`, [rows[0].id]);
};

async function open(base, number, pin) {
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: number, pin }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/employees.html", pretendToBeVisual: true }).window;
  w.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
  w.eval(app);
  await sleep(900);
  const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
  const set = (proto, el, v) => Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, v);
  const field = (label) => $$(".pform label").find((l) => l.querySelector("b")?.textContent.startsWith(label))?.querySelector("input, select");
  return {
    w, $, $$, field,
    byText: (s, t) => $$(s).find((e) => e.textContent.trim().startsWith(t)),
    click: async (el, ms = 400) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); },
    type: async (el, v) => { set(w.HTMLInputElement, el, v); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(80); },
    choose: async (el, v) => { set(w.HTMLSelectElement, el, v); el.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(150); },
    rows: () => $$("table[aria-label=Employees] tbody tr").filter((r) => r.querySelectorAll("td").length > 1),
    row: (number) => $$("table[aria-label=Employees] tbody tr").find((r) => r.textContent.includes(`No. ${number}`)),
    cells: (r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim()),
    title: () => $(".pform h2").textContent,
    message: () => $(".pform .msg")?.textContent || "",
  };
}

(async () => {
  const { server, base } = await start();
  const m = await open(base, "10420001", "111111");

  check("the sidebar has Employees, marked as this page", m.$(".nav [aria-current=page]")?.textContent === "Employees");
  check("table columns from the wireframe", m.$$("table[aria-label=Employees] thead th").map((t) => t.textContent).join("|") === "Employee|Role|Locations|Pay rate|Status|Actions");
  check("name with the number under it, role, locations, rate and status", m.cells(m.row("10420003")).slice(0, 5).join("|") === "Sam RiveraNo. 10420003|Server|Brewbean Downtown|$17.25|Active", m.cells(m.row("10420003")).join("|"));
  check("an active row offers Edit and Deactivate", m.cells(m.row("10420003"))[5] === "EditDeactivate");
  check("you can't deactivate yourself", m.byText("tr", "Maya").querySelectorAll("button")[1].disabled);
  check("Add employee form, PIN required", m.title() === "Add employee" && !!m.field("PIN (6 digits)") && m.field("Starts on").value.length === 10);

  const all = m.rows().length;
  await m.choose(m.$("select[aria-label=Role]"), "role-server");
  check("All roles filters the table", m.rows().length === 2 && m.rows().every((r) => m.cells(r)[1] === "Server"));
  await m.choose(m.$("select[aria-label=Role]"), "all");
  check("and back to everyone", m.rows().length === all);

  await m.click(m.row("10420003").querySelector("button"));
  check("Edit loads them into the form as Edit employee", m.title() === "Edit employee" && m.field("First name").value === "Sam" && m.field("Employee number").value === "10420003"
    && m.field("Role").value === "role-server" && m.field("Hourly rate").value === "17.25");
  check("the PIN is optional when editing and never filled in", /leave blank/.test(m.$$(".pform label b").map((b) => b.textContent).join()) && m.field("New PIN").value === "");
  check("the row being edited is marked", m.row("10420003").className.includes("sel"));
  await m.click(m.byText("button", "Clear"));
  check("Clear empties the form and goes back to Add employee", m.title() === "Add employee" && m.field("First name").value === "" && m.field("Role").value === "");

  await m.click(m.byText("tr", "Maya").querySelector("button"));
  check("editing yourself: the role can't be changed", m.field("Role").disabled && /can't change your own role/.test(m.$(".pform").textContent));
  await m.click(m.byText("button", "Clear"));

  await m.click(m.byText("button", "Save"));
  check("Save with nothing filled in lists what's missing", /first name/.test(m.message()) && /8 digits/.test(m.message()) && /PIN must be 6/.test(m.message()), m.message());

  await m.type(m.field("First name"), "Click");
  await m.type(m.field("Last name"), "Tester");
  await m.type(m.field("Employee number"), NUMBER);
  await m.type(m.field("Email"), `click${NUMBER}@example.com`);
  await m.choose(m.field("Role"), "role-barista");
  await m.click(m.$(".multi summary"), 100);
  await m.click(m.$$(".multi .menu input")[0], 100);
  check("Locations is a dropdown of checkboxes", m.$(".multi summary").textContent === "Brewbean Campus");
  await m.type(m.field("Hourly rate"), "15.50");
  await m.type(m.field("PIN"), "975310");
  check("the PIN field takes digits only and hides them", m.field("PIN").type === "password");
  await m.click(m.byText("button", "Save"), 700);
  check("Save adds them and says so", new RegExp(`Added Click Tester \\(No\\. ${NUMBER}\\)`).test(m.message()), m.message());
  check("they appear in the table", !!m.row(NUMBER) && m.cells(m.row(NUMBER)).slice(1, 5).join("|") === "Chef / barista|Brewbean Campus|$15.50|Active");
  check("and the form is cleared", m.title() === "Add employee" && m.field("First name").value === "" && m.field("PIN").value === "");

  await m.click(m.row(NUMBER).querySelectorAll("button")[1]);
  check("Deactivate asks first", /Deactivate Click Tester\?/.test(m.$("dialog[open]")?.textContent || ""));
  await m.click(m.byText("dialog .btn", "Deactivate"), 700);
  check("then hides them from the table", !m.row(NUMBER) && /Deactivated Click Tester/.test(m.$(".pview .msg")?.textContent || ""));
  await m.click(m.byText("label", "Show inactive").querySelector("input"), 200);
  check("Show inactive lists them with Reactivate", m.cells(m.row(NUMBER))[4] === "Inactive" && m.cells(m.row(NUMBER))[5] === "EditReactivate");
  await m.click(m.row(NUMBER).querySelectorAll("button")[1], 700);
  check("Reactivate brings them back", m.cells(m.row(NUMBER))[4] === "Active");
  check("page: no React warnings", m.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, m.w.errors.join(" | "));

  // As a manager: the same page, nobody senior, pay to read only
  const l = await open(base, "10420002", "222222");
  check("manager: Employees in the sidebar, marked as this page", l.$(".nav [aria-current=page]")?.textContent === "Employees");
  check("manager: owners and managers are Owner only", l.cells(l.row("10420001"))[5] === "Owner only" && l.cells(l.row("10420002"))[5] === "Owner only");
  check("manager: staff below them can be edited", l.cells(l.row("10420004"))[5] === "EditDeactivate");
  check("manager: the Role list leaves out Owner and Manager", ![...l.field("Role").options].some((o) => /^(Owner|Manager)$/.test(o.textContent)) && [...l.field("Role").options].some((o) => o.textContent === "Server"));
  check("manager: no pay on a new person", l.field("Hourly rate").disabled && l.field("Starts on").disabled && l.field("Hourly rate").value === "" && /Only an owner can set or change pay rates/.test(l.$(".pform").textContent));
  await l.click(l.row("10420004").querySelector("button"));
  check("manager: Edit shows the rate, to read", l.title() === "Edit employee" && l.field("Hourly rate").value === "16.75" && l.field("Hourly rate").disabled);
  check("manager page: no React warnings", l.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, l.w.errors.join(" | "));

  await cleanup();
  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1); });
