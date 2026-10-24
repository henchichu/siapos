// Drives the real Products page in jsdom: a server's read-only list, and a manager's four tabs. Adds one switched-off product to the dev DB.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, client, pool, removeCatalog } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = ["api", "shell", "products"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
let cleanup = async () => {}; // runs on success and on a crash, so a failed run doesn't leave products behind
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

async function open(base, number, pin) {
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: number, pin }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/products.html", pretendToBeVisual: true }).window;
  w.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
  w.eval(app);
  await sleep(900);
  const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
  const byText = (s, t) => $$(s).find((e) => e.textContent.trim().startsWith(t));
  return {
    w, cookie, $, $$, byText, text: () => w.document.body.textContent,
    click: async (el, ms = 300) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); },
    type: async (el, v) => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(120); },
    choose: async (el, v) => { Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, "value").set.call(el, v); el.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(400); },
  };
}
const cells = (r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim());

(async () => {
  const { server, base } = await start();

  // Server: read-only
  const s = await open(base, "10420003", "333333");
  const rows = () => s.$$("tbody tr").filter((r) => r.querySelectorAll("td").length > 1);
  check("server sees the read-only table, no tabs, no form", /Products/.test(s.text()) && !s.$(".tabs") && !s.$(".pform") && s.$$("button.act, .pbtn").length === 0);
  check("columns: Product, Sizes, Category, Price from, Available", s.$$("thead th").map((t) => t.textContent).join("|") === "Product|Sizes|Category|Price from|Available");
  const latte = rows().map(cells).find((c) => c[0] === "Latte");
  check("a row shows name, sizes, category, price from, availability", JSON.stringify(latte) === JSON.stringify(["Latte", "2 sizes", "Coffee", "$4.25", "yes"]), JSON.stringify(latte));
  await s.choose(s.$("select[aria-label=Category]"), "cat-bakery");
  check("category filter keeps only Bakery", rows().length >= 2 && rows().every((r) => cells(r)[2] === "Bakery"));
  await s.choose(s.$("select[aria-label=Category]"), "");
  await s.type(s.$("input[aria-label='Name or SKU']"), "latte");
  check("search narrows by name", rows().length >= 2 && rows().every((r) => /latte/i.test(cells(r)[0])));
  await s.type(s.$("input[aria-label='Name or SKU']"), "zzzz");
  check("no match message", /No products match/.test(s.text()));
  check("server menu has Products current and the footer shows the role", s.byText(".nav a.link", "Products")?.getAttribute("aria-current") === "page" && /Server · Brewbean Downtown/.test(s.text()));
  check("server page: no React warnings", s.w.errors.length === 0, s.w.errors.join(" | "));

  // Manager: four tabs
  const lc = client(base); await lc.call("/login/pin", { employeeNumber: "10420002", pin: "222222" });
  const stamp = Date.now().toString(36);
  const made = await lc.call("/products", { name: `UI test ${stamp}`, categoryId: "cat-bakery", active: true });
  const [[{ today }]] = await pool.query("SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', 'America/Chicago'), '%Y-%m-%d') AS today");
  const ended = await lc.call("/promotions", { name: `UI ended ${stamp}`, kind: "percent", value: "10", starts: today, ends: today, productIds: ["prd-latte"] });
  await lc.call(`/promotions/${ended.body.id}/end`, {}); // so "Show ended" has one to show
  cleanup = async () => removeCatalog({ promotions: [ended.body.id], products: (await lc.call("/products/list")).body.products.filter((p) => p.name.includes(stamp)).map((p) => p.id) });
  const m = await open(base, "10420002", "222222");
  const mrows = () => m.$$("tbody tr").filter((r) => r.querySelectorAll("td").length > 1);
  check("manager sees the four tabs, Products first", m.$$(".tab").map((t) => t.textContent).join("|") === "Products|Sizes and recipes|Option groups|Promotions" && m.byText(".tab", "Products").getAttribute("aria-pressed") === "true");
  check("manager table has cost, margin and actions", m.$$("thead th").map((t) => t.textContent).join("|") === "Product|Category|Price from|Cost|Margin|Actions");
  check("the form column isn't there until an action calls for it", !m.$(".pform"));
  const lr = mrows().find((r) => cells(r)[0] === "Latte");
  check("Latte row shows price, cost and margin", /^\$4\.25$/.test(cells(lr)[2]) && /^\$\d+\.\d\d$/.test(cells(lr)[3]) && /^\d+%$/.test(cells(lr)[4]), JSON.stringify(cells(lr)));
  await m.click(lr.querySelector("button.act"));
  check("Edit pulls the row into the form", /Edit product/.test(m.text()) && m.$(".pform input.field").value === "Latte");
  check("the form column slid in", !!m.$(".pside"));
  await m.click(m.byText(".pform .pbtn", "Clear"));
  check("Clear puts the column away again", !m.$(".pform"));
  await m.click(m.byText(".phead .pbtn", "Add product"));
  check("Add product opens it empty", /Add product/.test(m.text()) && m.$(".pform input.field").value === "");
  check("Upload Photo, Active checkbox and Save are there", !!m.byText(".pform .pbtn", "Upload Photo") && !!m.$(".pform .check input:checked") && !!m.byText(".pform .pbtn", "Save"));

  const mine = () => mrows().find((r) => cells(r)[0].startsWith(`UI test ${stamp}`)); // an inactive row adds a tag after the name
  await m.click(mine().querySelectorAll("button.act")[1], 600);
  check("Deactivate greys the row and offers Activate", mine().classList.contains("off") && /Activate/.test(mine().textContent));
  await m.click(mine().querySelectorAll("button.act")[1], 600);
  check("Activate brings it back", !mine().classList.contains("off"));
  await m.click(mine().querySelectorAll("button.act")[1], 300); // leave it switched off
  await m.type(m.$(".pform input.field"), `Added by the click test ${stamp}`);
  await m.click(m.byText(".pform .pbtn", "Save"), 700);
  check("Save adds a product, shows a message and puts the column away", !m.$(".pform") && m.text().includes(`Added Added by the click test ${stamp}`) && mrows().some((r) => cells(r)[0].startsWith(`Added by the click test ${stamp}`)));

  // a photo that fails to save must not turn a retry into a second product
  await m.click(m.byText(".phead .pbtn", "Add product"));
  await m.type(m.$(".pform input.field"), `Photo test ${stamp}`);
  const file = m.$(".pform input[type=file]");
  Object.defineProperty(file, "files", { value: [new m.w.File(["not a picture"], "x.png", { type: "image/png" })] });
  file.dispatchEvent(new m.w.Event("change", { bubbles: true })); await sleep(150);
  await m.click(m.byText(".pform .pbtn", "Save"), 700);
  check("a failed photo keeps the form open with the error", !!m.$(".pform") && /picture/.test(m.$(".pform .msg")?.textContent || ""));
  await m.click(m.byText(".pform .pbtn", "Save"), 700);
  const copies = (await lc.call("/products/list")).body.products.filter((p) => p.name === `Photo test ${stamp}`).length;
  check("saving again updates the same product instead of adding another", copies === 1, `copies: ${copies}`);
  await m.click(m.byText(".pform .pbtn", "Clear"), 200);

  // the first product's sizes arrive late; switching products quickly must not let them overwrite the newer answer
  const real = m.w.fetch;
  let slowed = false;
  m.w.fetch = (u, o) => (!slowed && /\/sizes$/.test(u) && (slowed = true) ? sleep(800).then(() => real(u, o)) : real(u, o));
  await m.click(m.byText(".tab", "Sizes and recipes"), 100);
  await m.choose(m.$("select[aria-label=Product]"), "prd-latte");
  await sleep(1000);
  check("a slow answer for the old product doesn't replace the new product's sizes", mrows().filter((r) => /oz/.test(r.textContent)).length === 2, m.text().slice(0, 200));
  m.w.fetch = real;
  check("Sizes tab, #sizes, no side column yet", /Sizes of/.test(m.text()) && m.w.location.hash === "#sizes" && !m.$(".pside"));
  await m.choose(m.$("select[aria-label=Product]"), "prd-latte");
  check("choosing a product lists its sizes", mrows().filter((r) => /oz/.test(r.textContent)).length === 2 && /Missing|items/.test(m.text()));
  await m.click(mrows().find((r) => /Small/.test(r.textContent)).querySelector("button.act"), 700);
  check("Edit shows the size's recipe and fills the size form", /Recipe for Small 12 oz/.test(m.text()) && m.$("section[aria-label='Edit size'] input.field").value === "Small 12 oz");
  const costOf = () => parseFloat(/Cost to make one\s*\$([\d.]+)/.exec(m.text())[1]);
  const before = costOf();
  await m.choose(m.$("select[aria-label='Stock item']"), "stk-vanilla");
  await m.type(m.$("input[aria-label=Quantity]"), "10");
  await m.click(m.byText(".addrow .act", "Add"), 200);
  check("adding a recipe line raises the cost at once", costOf() > before && /Vanilla syrup/.test(m.text()), `${before} -> ${costOf()}`);
  await m.click(m.$$(".recipe tbody tr").find((r) => /Vanilla/.test(r.textContent)).querySelector("button.act"), 200);
  check("Remove takes it off again", costOf() === before);

  await m.click(m.byText(".tab", "Option groups"), 800);
  check("Option groups tab lists groups, no form yet", !m.$(".pform") && /Milk/.test(m.text()) && /up to 1/.test(m.text()) && /any number/.test(m.text()) && /\d products/.test(m.text()));
  await m.click(mrows().find((r) => /^Milk/.test(r.textContent)).querySelector("button.act"), 300);
  check("Edit group shows its options and effects", /Edit group/.test(m.text()) && /Oat milk/.test(m.text()) && /Swaps Whole milk for Oat milk/.test(m.text()));
  await m.click(m.byText(".pform .pbtn", "Clear"), 200);
  check("Clear closes the group form", !m.$(".pform"));

  await m.click(m.byText(".tab", "Promotions"), 800);
  const promoRows = () => m.$$("section[aria-label=Promotions] tbody tr").filter((r) => r.querySelectorAll("td").length > 1);
  check("Promotions hides ended ones by default", promoRows().every((r) => !/Ended/.test(r.textContent)) && /Morning pastry/.test(m.text()));
  await m.click(m.$("section[aria-label=Promotions] .check input"), 300);
  check("Show ended adds them", promoRows().some((r) => /Ended/.test(r.textContent)));
  check("no promotion form until asked for", !m.$(".pform"));
  await m.click(m.byText(".phead .pbtn", "Add promotion"), 300);
  check("promotion form: type toggle, value, dates, products, Save and Clear", /Percent off/.test(m.text()) && /Amount off/.test(m.text()) && m.$$(".pform input[type=date]").length === 2 && !!m.$(".pform details.multi") && !!m.byText(".pform .pbtn", "Save"));
  check("manager page: no React warnings", m.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, m.w.errors.join(" | "));

  await cleanup();
  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1); });
