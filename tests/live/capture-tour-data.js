// Records the demo data for the front-page tour (public/js/tour-demo.json): loads each real staff page in jsdom as the dev owner and
// keeps every answer the server gives. Run it against a database with the dev seed, then commit the file:
//   DB_PORT=3307 node tests/live/capture-tour-data.js
// (or against the running dev stack: node tests/live/capture-tour-data.js). Nothing is written to the database.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, client, pool } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGES = ["home", "register", "kitchen", "attention", "orders", "rewards", "products", "inventory", "reports", "employees", "settings", "shift"];
// the scripts a page loads after React, in its own order (api.js, shell.js, its own)
const scriptsOf = (page) => [...fs.readFileSync(path.join(root, `public/${page}.html`), "utf8").matchAll(/src="\/js\/([^"]+)"/g)].map((m) => m[1]);

(async () => {
  const { server, base } = await start();
  const owner = client(base);
  const login = await owner.call("/login/pin", { employeeNumber: "10420001", pin: "111111" });
  if (login.status !== 200) throw new Error(`Maya can't sign in (${login.status}): is this a database with the dev seed?`);
  const responses = {};
  for (const page of PAGES) {
    const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: `${base}/${page}.html`, pretendToBeVisual: true }).window;
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    w.fetch = async (url, opts = {}) => {
      const res = await fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie: owner.cookie() } });
      if (res.ok && url.startsWith("/api/")) {
        const key = `${opts.method || "GET"} ${url.slice(4).split("?")[0]}`;
        if (!(key in responses) && !/\/(logout|session\/touch)$/.test(key)) responses[key] = await res.clone().json().catch(() => undefined);
      }
      return res;
    };
    w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
    w.eval(scriptsOf(page).map((f) => fs.readFileSync(path.join(root, "public/js", f), "utf8")).join("\n"));
    await sleep(1500);
    w.close();
  }
  const out = path.join(root, "public/js/tour-demo.json");
  // the file is public: employee numbers (and so the dev PINs' owners) are masked
  fs.writeFileSync(out, JSON.stringify({ capturedAt: new Date().toISOString(), responses }, null, 1).replace(/("number": ")\d{4}(\d{4}")/g, "$1••••$2"));
  console.log(`${Object.keys(responses).length} answers -> ${path.relative(root, out)}`);
  console.log(Object.keys(responses).join("\n"));
  server.close(); await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
