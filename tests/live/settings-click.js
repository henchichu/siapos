// Drives the real Settings page in jsdom as the owner: the two tabs, the form column that opens for Add and Edit and closes on Cancel or Save,
// adding and deactivating a category, the role editor's 22 permissions, and the prompt before switching tabs with unsaved edits.
// The category it adds is removed at the end.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = ["api", "shell", "settings"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };
const NAME = `Click ${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
const cleanup = () => pool.query("DELETE FROM Category WHERE Name IN (?, ?)", [NAME, `${NAME} renamed`]);

async function open(base) {
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: "10420001", pin: "111111" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/settings.html", pretendToBeVisual: true }).window;
  w.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
  w.eval(app);
  await sleep(1000);
  const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
  const set = (proto, el, v) => Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, v);
  return {
    w, $, $$,
    byText: (s, t) => $$(s).find((e) => e.textContent.trim() === t),
    click: async (el, ms = 400) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); },
    type: async (el, v) => { set(w.HTMLInputElement, el, v); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(80); },
    field: (label) => $$(".pform label").find((l) => l.querySelector("b")?.textContent === label)?.querySelector("input, select"),
    row: (table, name) => $$(`table[aria-label=${table}] tbody tr`).find((r) => r.querySelector("td")?.firstChild?.textContent === name), // the name is the cell's first text
    title: () => $(".pform h2")?.textContent,
    message: () => $(".pform .msg")?.textContent || "",
    note: () => $(".main > .msg")?.textContent || "",
  };
}

(async () => {
  const { server, base } = await start();
  try {
    const m = await open(base);
    check("the sidebar has Settings, marked as this page, in the shared layout", m.$(".nav [aria-current=page]")?.textContent === "Settings" && !!m.$(".app.kitchen .main.scrolls") && m.$(".heading h2")?.textContent === "Settings");
    check("tabs for General and Roles and permissions", m.$$(".tabs button").map((b) => b.textContent).join("|") === "General|Roles and permissions" && m.$(".tabs [aria-pressed=true]").textContent === "General");
    check("business, refund rules, categories and locations are listed", /Save business/.test(m.$(".main").textContent) && /Save refund rules/.test(m.$(".main").textContent) && m.$$("table[aria-label=Categories] tbody tr").length > 0 && m.$$("table[aria-label=Locations] tbody tr").length >= 2);
    check("no form column until an action calls for it", !m.$(".pform"));

    await m.click(m.byText("button", "Add location"));
    check("Add location opens a wide form column", m.title() === "Add location" && m.$(".pform").classList.contains("pside") && m.$(".pform").classList.contains("wide") && !!m.field("IANA time zone"));
    const zone = m.field("IANA time zone");
    check("the time zone is a list, with America/Chicago chosen", zone?.tagName === "SELECT" && zone.options.length > 100 && zone.value === "America/Chicago" && [...zone.options].some((o) => o.value === "Europe/London"));
    check("with a tax rate for every category and one starting register", m.$$(".pform input[type=number]").length >= 1 && m.field("Register 1")?.value === "Register 1");
    await m.click(m.byText("button", "Cancel"));
    check("Cancel closes it", !m.$(".pform"));
    await m.click(m.$("table[aria-label=Locations] tbody tr button"));
    check("Edit opens the location, with its row marked", m.title() === "Edit location" && m.field("Location name").value.length > 0 && m.$$("table[aria-label=Locations] tr.sel").length === 1);
    await m.click(m.byText("button", "Cancel"));

    await m.click(m.byText("button", "Add category"));
    check("Add category opens a form column", m.title() === "Add category" && m.$(".pform").classList.contains("pside"));
    await m.click(m.byText("button", "Save"));
    check("an empty name isn't saved", m.title() === "Add category");
    await m.type(m.field("Category name"), NAME);
    await m.click(m.byText("button", "Save"), 800);
    check("Save closes the form and says so above the tables", !m.$(".pform") && /Category saved/.test(m.note()), m.note());
    check("the category is listed", !!m.row("Categories", NAME));
    await m.click(m.row("Categories", NAME).querySelector("button"));
    check("Rename opens it, with its row marked", m.title() === "Rename category" && m.field("Category name").value === NAME && m.row("Categories", NAME).className.includes("sel"));
    await m.type(m.field("Category name"), `${NAME} renamed`);
    await m.click(m.byText("button", "Save"), 800);
    check("renamed", !!m.row("Categories", `${NAME} renamed`) && !m.row("Categories", NAME));
    await m.click(m.row("Categories", `${NAME} renamed`).querySelectorAll("button")[1]);
    check("Deactivate asks first", /Deactivate .* renamed\?/.test(m.$("dialog[open]")?.textContent || ""));
    await m.click(m.byText("dialog button", "Cancel"));
    check("Cancel leaves it active", !m.$("dialog[open]") && !m.row("Categories", `${NAME} renamed`).className.includes("off"));
    await m.click(m.row("Categories", `${NAME} renamed`).querySelectorAll("button")[1]);
    await m.click(m.byText("dialog button", "Deactivate"), 800);
    check("then marks it inactive", m.row("Categories", `${NAME} renamed`).className.includes("off") && /inactive/.test(m.row("Categories", `${NAME} renamed`).textContent));

    // unsaved edits are not thrown away by a click on the other tab
    await m.type([...m.$$(".main input")].find((i) => i.value === "Brewbean Coffee"), "Brewbean Coffee!");
    await m.click(m.byText(".tabs button", "Roles and permissions"));
    check("switching tabs with unsaved edits asks first", /Switch tabs\?/.test(m.$("dialog[open]")?.textContent || "") && m.$(".tabs [aria-pressed=true]").textContent === "General");
    await m.click(m.byText("dialog button", "Cancel"));
    await m.type([...m.$$(".main input")].find((i) => i.value === "Brewbean Coffee!"), "Brewbean Coffee");
    await m.click(m.byText(".tabs button", "Roles and permissions"), 400);
    check("a confirmed switch opens Roles", /Switch tabs\?/.test(m.$("dialog[open]")?.textContent || ""));
    await m.click(m.byText("dialog button", "Switch"), 900);

    check("the Roles table has Role, Staff and Actions, with no Opens to column", m.$$("table[aria-label=Roles] thead th").map((t) => t.textContent).join("|") === "Role|Staff|Actions");
    check("Roles lists the roles, with the owner locked", m.$(".tabs [aria-pressed=true]").textContent === "Roles and permissions" && /Every permission, locked/.test(m.$("table[aria-label=Roles]").textContent) && !m.$(".pform"));
    await m.click(m.byText("button", "Add role"));
    check("Add role opens a wide form column with all 22 permissions", m.title() === "Add role" && m.$(".pform").classList.contains("wide") && m.$$(".permissions input[type=checkbox]").length === 22);
    check("the role form has no Opens to field", !/Opens to/.test(m.$(".pform").textContent));
    await m.click(m.byText("button", "Cancel"));
    check("Cancel closes it", !m.$(".pform"));
    await m.click(m.row("Roles", "Server").querySelector("button"));
    check("Edit opens the role with its permissions ticked", m.title() === "Edit role" && m.field("Role name").value === "Server" && m.$$(".permissions input:checked").length > 0 && m.row("Roles", "Server").className.includes("sel"));
    check("page: no React warnings", m.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, m.w.errors.join(" | "));
  } finally {
    await cleanup();
    server.close(); await pool.end();
  }
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1); });
