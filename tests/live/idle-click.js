// Drives the idle notice on the real Home page in jsdom: the 5 and 1 minute warnings, Stay signed in, and the sign-out at 15 minutes.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = ["api", "shell", "home"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

(async () => {
  const { server, base } = await start();
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: "10420003", pin: "333333" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/home.html", pretendToBeVisual: true }).window;
  const calls = [];
  w.fetch = (url, opts = {}) => { calls.push(url); return fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } }); };
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
  w.eval(app);
  await sleep(1500);
  const notice = () => w.document.querySelector(".idle")?.textContent.trim() || "";
  const MIN = 60 * 1000, realNow = w.Date.now;
  const clockAt = (min) => { const t = realNow() + min * MIN; w.Date.now = () => t; };

  check("opening the page touches the session", calls.includes("/api/session/touch"));
  check("no notice while the person is active", notice() === "");
  clockAt(9); await sleep(1200);
  check("none at 9 minutes idle", notice() === "");
  clockAt(10.5); await sleep(1200);
  check("5 minute warning", /in 5 minutes/.test(notice()) && /Stay signed in/.test(notice()), notice());
  clockAt(14.5); await sleep(1200);
  check("1 minute warning", /in 1 minute\./.test(notice()), notice());

  calls.length = 0;
  w.document.querySelector(".idle button").click(); await sleep(300);
  check("Stay signed in clears the notice and touches the session", notice() === "" && calls.includes("/api/session/touch"), notice());
  clockAt(14.5 + 5); await sleep(1200);
  check("the clock restarted from the touch", notice() === "", notice());

  clockAt(14.5 + 15.5); await sleep(1800);
  const after = await fetch(base + "/api/session", { headers: { cookie } });
  check("at 15 minutes the page signs out", calls.includes("/api/logout") && after.status === 401);
  check("no React warnings", w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, JSON.stringify(w.errors));
  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
