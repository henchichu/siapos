// Drives the real Inventory page in jsdom: filters, the row actions that fill the form, the delivery maths and the count totals.
// It saves nothing; the API test covers the writes.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, client, pool } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = ["api", "shell", "inventory"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
let restore = async () => {};
let cleanup = async () => restore(); // runs on success and on a crash, so a failed run doesn't leave test rows behind
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

async function open(base, number, pin) {
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: number, pin }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/inventory.html", pretendToBeVisual: true }).window;
  w.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
  w.eval(app);
  await sleep(900);
  const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
  return {
    w, $, $$, text: () => w.document.body.textContent, byText: (s, t) => $$(s).find((e) => e.textContent.trim().startsWith(t)),
    click: async (el, ms = 300) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); },
    type: async (el, v) => { Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(120); },
    choose: async (el, v) => { Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, "value").set.call(el, v); el.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(400); },
  };
}
const cells = (r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim());

(async () => {
  const { server, base } = await start();
  // The demo stock changes as people use the app, so make one item low on purpose: its reorder level goes just above what is on hand
  const sc = client(base); await sc.call("/login/pin", { employeeNumber: "10420002", pin: "222222" });
  const muffin = (await sc.call("/inventory")).body.rows.find((r) => r.id === "stk-muffin");
  await sc.call("/inventory/change", { stockItemId: "stk-muffin", threshold: String(muffin.onHand + 5) });
  restore = () => sc.call("/inventory/change", { stockItemId: "stk-muffin", threshold: String(muffin.reorderAt) });
  const units = (await (await fetch(base + "/api/inventory", { headers: { cookie: (await (await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: "10420002", pin: "222222" }) })).headers.get("set-cookie")).split(";")[0] } })).json()).units;
  const m = await open(base, "10420002", "222222");
  const rows = (sel = "section.pview[aria-label=Inventory]") => m.$$(`${sel} tbody tr`).filter((r) => r.querySelectorAll("td").length > 1);
  const row = (name) => rows().find((r) => cells(r)[0].startsWith(name)); // a deactivated row adds a tag after the name

  check("three tabs, Stock first", m.$$(".tab").map((t) => t.textContent).join("|") === "Stock|Receive delivery|Stock count" && m.byText(".tab", "Stock").getAttribute("aria-pressed") === "true");
  check("stock columns", m.$$("section.pview[aria-label=Inventory] thead th").map((t) => t.textContent).join("|") === "Stock item|On hand|Reorder at|Avg cost|Status|Actions");
  check("a row shows on hand with its unit, reorder level, average cost and status", /^\d+ ml$/.test(cells(row("Whole milk"))[1]) && /^\$0\.00\d+$/.test(cells(row("Whole milk"))[3]) && cells(row("Whole milk"))[4] === "OK");
  check("at or below the reorder level is LOW", cells(row("Blueberry muffin"))[4] === "LOW" && row("Blueberry muffin").querySelector("td.low"));
  check("the form column isn't there until a row action", !m.$(".pform"));
  check("footer shows employee, role and location", /Leo Brandt/.test(m.text()) && /Manager · Brewbean Campus/.test(m.text()));

  await m.click(m.$("input[type=checkbox]"), 200);
  check("Low stock only keeps just the LOW rows", rows().length >= 1 && rows().every((r) => cells(r)[4] === "LOW"));
  await m.click(m.$("input[type=checkbox]"), 200);
  await m.type(m.$("input[aria-label='Stock item name']"), "milk");
  check("the name filter narrows the rows", rows().length === 2 && rows().every((r) => /milk/i.test(cells(r)[0])));
  await m.type(m.$("input[aria-label='Stock item name']"), "");
  await m.choose(m.$("select[aria-label=Supplier]"), "sup-bakery");
  check("the supplier filter keeps that supplier's items", rows().map((r) => cells(r)[0]).join("|") === "Blueberry muffin|Butter croissant");
  await m.choose(m.$("select[aria-label=Supplier]"), "");
  check("a location dropdown is there", !!m.$("select[aria-label=Location]"));

  await m.click(row("12 oz cup").querySelectorAll("button.act")[0]);
  check("Restock fills the form: item, Restock chosen, Unit cost shown, no Reason", !!m.$(".pform") && m.$(".pform select").value === "stk-cup-12"
    && m.byText(".pform .tab", "Restock").getAttribute("aria-pressed") === "true"
    && !!m.byText(".pform label", "Total paid") && !m.byText(".pform label", "Unit cost") && !m.byText(".pform label", "Reason"));
  check("the reorder threshold is pre-filled", m.byText(".pform label", "Reorder threshold").querySelector("input").value === "100");
  await m.click(row("Oat milk").querySelectorAll("button.act")[1]);
  check("Adjust switches to Adjustment: Reason shown, no Unit cost", m.byText(".pform .tab", "Adjustment").getAttribute("aria-pressed") === "true"
    && !!m.byText(".pform label", "Reason") && !m.byText(".pform label", "Total paid") && m.$(".pform select").value === "stk-oat");
  await m.click(m.byText(".pform .tab", "Restock"), 200);
  check("switching the Type swaps the two fields", !!m.byText(".pform label", "Total paid") && !m.byText(".pform label", "Reason"));
  await m.type(m.byText(".pform label", "Quantity").querySelector("input"), "1000");
  await m.type(m.byText(".pform label", "Total paid").querySelector("input"), "1.15");
  check("the unit cost is worked out as the total is typed", /Unit cost \$0\.00115 per ml/.test(m.$(".pform").textContent), m.$(".pform").textContent.slice(0, 300));
  await m.type(m.byText(".pform label", "Quantity").querySelector("input"), ""); // nothing typed, so Save below saves nothing
  await m.type(m.byText(".pform label", "Total paid").querySelector("input"), "");
  await m.click(m.byText(".pform .tab", "Adjustment"), 200);
  await m.click(m.byText(".pform .pbtn", "Save"), 500);
  check("saving nothing shows a message", /Enter a quantity or a new reorder threshold/.test(m.$(".pform .msg")?.textContent || ""));
  await m.click(m.byText(".pform .pbtn", "Clear"));
  check("Clear puts the column away", !m.$(".pform"));
  check("recent stock movements are listed", /Recent stock movements/.test(m.text()) && /RESTOCK|SALE|ADJUSTMENT/.test(m.text()));

  // Add stock item
  const stamp = Date.now().toString(36);
  cleanup = async () => {
    await restore();
    await pool.query("DELETE FROM Supplier WHERE Name LIKE ?", [`UI supplier ${stamp}%`]); // never delivered to
    await pool.query("DELETE FROM StockItemSupplier WHERE StockItemID IN (SELECT StockItemID FROM StockItem WHERE Name LIKE ?)", [`UI stock ${stamp}%`]);
    await pool.query("DELETE FROM Inventory WHERE StockItemID IN (SELECT StockItemID FROM StockItem WHERE Name LIKE ?)", [`UI stock ${stamp}%`]);
    await pool.query("DELETE FROM StockItem WHERE Name LIKE ?", [`UI stock ${stamp}%`]); // no ledger rows, so it can go
  };
  await m.click(m.byText(".phead .pbtn", "Add stock item"));
  check("Add stock item opens its own form: name, unit, threshold, supplier", !!m.$(".pform[aria-label='Add stock item']") && !m.$(".pform[aria-label='Record stock change']")
    && !!m.byText(".pform label", "Name") && !!m.byText(".pform label", "Unit") && !!m.byText(".pform label", "Reorder threshold") && !!m.byText(".pform label", "Supplier"));
  await m.click(m.byText(".pform .pbtn", "Save"), 500);
  check("saving it empty shows a message", /Enter the stock item's name/.test(m.$(".pform .msg")?.textContent || ""));
  await m.type(m.byText(".pform label", "Name").querySelector("input"), `UI stock ${stamp}`);
  await m.choose(m.byText(".pform label", "Unit").querySelector("select"), String(units.find((u) => u.symbol === "g").code));
  await m.type(m.byText(".pform label", "Reorder threshold").querySelector("input"), "50");
  await m.click(m.byText(".pform .pbtn", "Save"), 800);
  check("Save adds it to the table with nothing on hand, and puts the column away", !m.$(".pform") && cells(row(`UI stock ${stamp}`) || m.$("tr")).join("|").startsWith(`UI stock ${stamp}|0 g|50`), cells(row(`UI stock ${stamp}`) || m.$("tr")).join("|"));
  check("it shows as LOW until it is restocked", cells(row(`UI stock ${stamp}`))[4] === "LOW");

  // Deactivate and reactivate
  const mine = `UI stock ${stamp}`;
  await m.click(row(mine).querySelectorAll("button.act")[2], 700);
  check("Deactivate takes the item out of the list", !row(mine) && /Deactivated UI stock/.test(m.text()));
  const toggle = () => m.byText("section.pview[aria-label=Inventory] label", "Show deactivated").querySelector("input");
  await m.click(toggle(), 300);
  check("Show deactivated brings it back, marked, with only Reactivate", !!row(mine) && row(mine).classList.contains("off") && /deactivated/.test(row(mine).textContent) && row(mine).querySelectorAll("button.act").length === 1 && /Reactivate/.test(row(mine).textContent) && cells(row(mine))[4] === "—");
  await m.click(row(mine).querySelector("button.act"), 700);
  check("Reactivate makes it a normal row again", !row(mine).classList.contains("off") && row(mine).querySelectorAll("button.act").length === 3);
  await m.click(toggle(), 200);

  // Receive delivery
  await m.click(m.byText(".tab", "Receive delivery"), 500);
  check("Delivery tab, #delivery, today's date filled in", m.w.location.hash === "#delivery" && /^\d{4}-\d\d-\d\d$/.test(m.$("input[type=date]").value) && /Receiving at Brewbean Campus/.test(m.text()));
  const pendingSection = m.$('section[aria-label="Pending deliveries"]');
  check("pending dashboard appears below recent deliveries", !!pendingSection && !!(m.$('section[aria-label="Recent deliveries"]').compareDocumentPosition(pendingSection) & m.w.Node.DOCUMENT_POSITION_FOLLOWING));
  const expandPending = pendingSection.querySelector('[aria-label="Expand pending deliveries"]');
  if (expandPending) await m.click(expandPending, 200);
  const pendingMuffin = [...pendingSection.querySelectorAll("tbody tr")].find((r) => /Blueberry muffin/.test(r.textContent));
  check("low stock automatically places a numbered purchase order", !!pendingMuffin && /PO-\d+/.test(pendingMuffin.textContent) && /Ordered/.test(pendingMuffin.textContent));
  await m.click(pendingMuffin.querySelector("button"), 300);
  check("pending Receive fills supplier, item and quantity", m.$('section[aria-label="Receive delivery"] select').value === "sup-bakery" && !!m.$('input[aria-label="Quantity of Blueberry muffin"]') && Number(m.$('input[aria-label="Quantity of Blueberry muffin"]').value) > 0);
  await m.click(m.byText('section[aria-label="Receive delivery"] button', "Clear"), 200);
  await m.choose(m.byText(".pform select, section[aria-label='Receive delivery'] select", "").closest("section").querySelectorAll("select")[0], "sup-supply");
  const addLine = async (id) => { await m.choose(m.$("select[aria-label='Stock item']"), id); await m.click(m.byText("button", "Add line"), 200); };
  const lineRows = () => m.$$(".dlines tbody tr").filter((r) => r.querySelector("input"));
  await addLine("stk-cup-12");
  check("Add line adds a row with quantity and total paid to fill in", lineRows().length === 1 && lineRows()[0].querySelectorAll("input").length === 2 && /—/.test(lineRows()[0].textContent));
  await m.type(lineRows()[0].querySelectorAll("input")[0], "10");
  check("the supplier's quote hints at the total once there is a quantity", lineRows()[0].querySelectorAll("input")[1].getAttribute("placeholder") === "≈ 1.10");
  await m.type(lineRows()[0].querySelectorAll("input")[1], "1.10");
  check("unit cost is the total paid divided by the quantity", /\$0\.11/.test(lineRows()[0].textContent) && /Delivery total\s*\$1\.10/.test(m.text()), lineRows()[0].textContent);
  await addLine("stk-muffin");
  await m.type(lineRows()[1].querySelectorAll("input")[0], "2");
  await m.type(lineRows()[1].querySelectorAll("input")[1], "1.90");
  check("a second line works out its own unit cost", /\$0\.95/.test(lineRows()[1].textContent));
  check("the total adds the lines", /Delivery total\s*\$3\.00/.test(m.text()), m.text().match(/Delivery total\s*\$[\d.]+/)?.[0]);
  await m.click(lineRows()[0].querySelector("button.act"));
  check("Remove takes that line out and the total follows", lineRows().length === 1 && /Delivery total\s*\$1\.90/.test(m.text()));
  await m.click(m.byText("button", "New supplier"), 200);
  check("New supplier opens an inline form", !!m.$("[aria-label='New supplier']") && !!m.byText("[aria-label='New supplier'] label", "Name"));
  await m.click(m.byText("button", "Save supplier"), 500);
  check("saving it empty shows a message", /Enter the supplier's name/.test(m.$(".msg")?.textContent || ""));
  await m.type(m.byText("[aria-label='New supplier'] label", "Name").querySelector("input"), `UI supplier ${stamp}`);
  await m.click(m.byText("button", "Save supplier"), 900);
  const supplierSelect = m.$("section[aria-label='Receive delivery'] select");
  check("the new supplier is added, selected, and the form closes", !m.$("[aria-label='New supplier']") && supplierSelect.selectedOptions[0]?.textContent === `UI supplier ${stamp}`, supplierSelect.selectedOptions[0]?.textContent);
  const sup = () => m.$("section[aria-label='Receive delivery'] select");
  const supId = sup().value;
  await m.click(m.byText("section[aria-label='Receive delivery'] button", "Deactivate"), 700);
  check("Deactivate supplier takes it out of the dropdown", ![...sup().options].some((o) => o.value === supId) && /Deactivated UI supplier/.test(m.text()));
  await m.click(m.byText("section[aria-label='Receive delivery'] label", "Show deactivated").querySelector("input"), 300);
  check("Show deactivated lists it again, marked", [...sup().options].some((o) => o.value === supId && /\(deactivated\)/.test(o.textContent)));
  await m.choose(sup(), supId);
  check("a deactivated supplier offers Reactivate and can't receive", !!m.byText("section[aria-label='Receive delivery'] button", "Reactivate") && m.byText("button", "Receive into stock").disabled);
  await m.click(m.byText("section[aria-label='Receive delivery'] button", "Reactivate"), 700);
  check("Reactivate brings it back", [...sup().options].some((o) => o.value === supId && !/deactivated/.test(o.textContent)) && !m.byText("button", "Receive into stock").disabled);
  await m.click(m.byText("section[aria-label='Receive delivery'] label", "Show deactivated").querySelector("input"), 200);
  await m.click(m.byText("button", "Receive into stock").closest("section").querySelectorAll(".pactions button")[1], 200);
  check("Clear empties the delivery", lineRows().length === 0 && /Delivery total\s*\$0\.00/.test(m.text()));
  await m.click(m.byText("button", "Receive into stock"), 500);
  check("receiving with no lines shows a message", /Choose the supplier|Add at least one line/.test(m.$(".msg")?.textContent || ""));
  check("recent deliveries are listed", /Recent deliveries/.test(m.text()) && m.$$("section[aria-label='Recent deliveries'] tbody tr").length > 0);

  // Stock count
  await m.click(m.byText(".tab", "Stock count"), 500);
  check("Count tab, #count, with the print button", m.w.location.hash === "#count" && !!m.byText("button", "Print count sheet"));
  const crow = (name) => m.$$("section[aria-label='Stock count'] tbody tr").find((r) => cells(r)[0] === name);
  const boxes = () => m.$$(".totals .box b").map((b) => b.textContent);
  check("nothing counted yet: 0 of N, 0 differ", /^0 of \d+$/.test(boxes()[0]) && boxes()[1] === "0" && boxes()[2] === "±$0.00" && m.byText("button", "Save count and adjust stock").disabled);
  const inSystem = Number(cells(crow("Blueberry muffin"))[2]);
  await m.type(crow("Blueberry muffin").querySelector("input"), String(inSystem + 5));
  check("difference and value follow the counted figure", cells(crow("Blueberry muffin"))[4] === "+5" && cells(crow("Blueberry muffin"))[5] === "+$4.75");
  await m.type(crow("Butter croissant").querySelector("input"), String(Number(cells(crow("Butter croissant"))[2])));
  check("totals: 2 counted, 1 differs, the summed value", /^2 of /.test(boxes()[0]) && boxes()[1] === "1" && boxes()[2] === "+$4.75", boxes().join(" | "));
  await m.type(crow("Blueberry muffin").querySelector("input"), String(inSystem - 2));
  check("a shortage is negative", cells(crow("Blueberry muffin"))[4] === "−2" && boxes()[2] === "−$1.90");
  await m.choose(m.$("section[aria-label='Stock count'] select[aria-label=Supplier]"), "sup-bakery");
  check("the supplier filter limits the rows being counted", m.$$("section[aria-label='Stock count'] tbody tr").length === 2 && /^2 of 2$/.test(boxes()[0]));
  await m.click(m.byText("button", "Clear"), 200);
  check("Clear empties the count", /^0 of 2$/.test(boxes()[0]));
  check("page: no React warnings", m.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, m.w.errors.join(" | "));

  await cleanup();
  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1); });
