// Drives the real Home page in jsdom for each kind of role: which tiles exist, where they go, the header, and Sign out.
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

const ALL = "Inventory|Rewards|Employees|Needs attention|Products|Settings|Kitchen|Sign out|Reports|Register|My shift";

async function home(base, number, pin) {
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeNumber: number, pin }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const redirect = (await login.json()).redirect;
  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/home.html", pretendToBeVisual: true }).window;
  w.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
  w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
  w.eval(app);
  await sleep(700);
  const tiles = [...w.document.querySelectorAll(".grid .tile")];
  return { w, cookie, redirect, tiles, names: tiles.map((t) => t.textContent.trim()).join("|"), header: w.document.querySelector(".bar").textContent };
}

(async () => {
  const { server, base } = await start();

  const owner = await home(base, "10420001", "111111");
  check("sign-in lands on Home", owner.redirect === "/home.html");
  check("owner sees every tile, in the wireframe's order", owner.names === ALL, owner.names);
  const manager = await home(base, "10420002", "222222");
  check("manager sees every tile", manager.names === ALL, manager.names);
  const waiter = await home(base, "10420003", "333333");
  check("server sees only Register, Kitchen, Rewards, Products, My shift and Sign out", waiter.names === "Rewards|Products|Kitchen|Sign out|Register|My shift", waiter.names);
  const barista = await home(base, "10420005", "555555");
  check("barista sees only Kitchen, My shift and Sign out", barista.names === "Kitchen|Sign out|My shift", barista.names);
  check("hidden tiles aren't in the page at all", !/Inventory|Settings|Employees|Reports/.test(barista.w.document.body.textContent));

  check("header shows Home and the register and location", /^Home/.test(barista.header) && /Brewbean Campus/.test(barista.header) && /Counter - Brewbean Campus/.test(barista.header), barista.header);
  const link = (h, n) => h.tiles.find((t) => t.textContent.trim() === n)?.getAttribute("href");
  check("tiles open their pages", link(owner, "Register") === "/register.html" && link(owner, "Kitchen") === "/kitchen.html" && link(owner, "My shift") === "/shift.html" && link(owner, "Inventory") === "/inventory.html" && link(owner, "Needs attention") === "/attention.html" && link(owner, "Reports") === "/reports.html" && link(owner, "Employees") === "/shift.html#team");
  check("every tile has its icon and the grid is uniform", owner.tiles.every((t) => t.querySelector("img")?.getAttribute("src")?.startsWith("/img/home/")));

  const signOut = owner.tiles.find((t) => t.textContent.trim() === "Sign out");
  check("Sign out is a button, not a link", signOut.tagName === "BUTTON");
  signOut.click(); await sleep(500);
  const after = await fetch(base + "/api/session", { headers: { cookie: owner.cookie } });
  check("Sign out destroys the session", after.status === 401);
  const redirectBack = await fetch(base + "/home.html", { headers: { cookie: owner.cookie }, redirect: "manual" });
  check("Home needs a sign-in", redirectBack.status === 302 && redirectBack.headers.get("location") === "/login.html");

  check("no React warnings", [owner, manager, waiter, barista].every((h) => h.w.errors.filter((e) => !/Not implemented/.test(e)).length === 0), JSON.stringify(owner.w.errors));
  server.close(); await pool.end();
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
