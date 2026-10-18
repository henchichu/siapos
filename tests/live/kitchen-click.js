// Drives the real kitchen page in jsdom: three queues, the Report a loss transition, My shift, sign-out.
// jsdom has no layout, so the scroll rules are checked as CSS text, not as pixels.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

(async () => {
  const { server, base } = await start();
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ employeeNumber: "10420005", pin: "555555" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/kitchen.html", pretendToBeVisual: true }).window;
  w.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  w.eval(lib("react/umd/react.development.js"));
  w.eval(lib("react-dom/umd/react-dom.development.js"));
  w.eval(lib("htm/dist/htm.umd.js"));
  const errors = [];
  w.console.error = (...a) => errors.push(a.join(" ").slice(0, 300));
  w.eval(fs.readFileSync(path.join(root, "public/js/api.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "public/js/kitchen.js"), "utf8"));

  const $ = (sel) => w.document.querySelector(sel);
  const $$ = (sel) => [...w.document.querySelectorAll(sel)];
  const byText = (sel, text) => $$(sel).find((e) => e.textContent.trim().startsWith(text));
  const click = async (el, ms = 200) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); };
  const text = () => w.document.body.textContent;

  await sleep(800);
  const heads = $$(".queue h3").map((h) => h.textContent);
  check("three queues in order", heads.join("|") === "New|Preparing|Ready for pickup", heads.join("|"));
  const counts = $$(".queue .badge").map((b) => Number(b.textContent));
  check("badges match the cards", $$(".queue").every((q, i) => q.querySelectorAll(".ticket").length === counts[i]));
  check("a ticket shows order, customer, item and a Start button", /Order \d+/.test(text()) && /Ava/.test(text()) && /2 × Latte/.test(text()) && !!byText(".queue .kbtn", "Start"));
  check("options and note show", /Large 16 oz · Extra shot, Oat milk/.test(text()) && /Note: Extra hot, please/.test(text()));

  const css = fs.readFileSync(path.join(root, "public/css/kitchen.css"), "utf8");
  check("each queue scrolls on its own", /\.queue \{[^}]*overflow-y: auto/.test(css) && /\.queues \{[^}]*min-height: 0/.test(css));

  await click(byText("button", "My shift"));
  check("My shift shows the success panel", /Success: My shift view initialized successfully\./.test(text()) && w.location.hash === "#my%20shift");
  await click(byText("button", "Kitchen"));
  check("Kitchen link returns to the queues", $$(".queue").length === 3);

  await click(byText("button", "Report a loss"), 500);
  check("Report a loss opens screen 2, #loss", /What was lost\?/.test(text()) && /Reported today at Brewbean Campus/.test(text()) && w.location.hash === "#loss");
  check("today's loss is listed", /Whole milk/.test(text()) && /Broken or spilled/.test(text()));
  check("Report loss is disabled until an item and amount are set", byText("button", "Report loss").disabled);
  await click(byText("button", "Back to tickets"));
  check("Back to tickets returns", $$(".queue").length === 3 && w.location.hash === "");

  check("no console errors", errors.length === 0, errors.join(" | "));
  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
