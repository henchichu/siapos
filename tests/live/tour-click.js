// The demo front page (public/tour.html): "/" goes to sign-in unless DEMO_MODE=1; the tour kit's spotlight, focus trap and keys work;
// the page walks the real staff pages (shown on sample data at /tour/<page>.html) and ends at the demo sign-ins; and every step's target
// is really on its page.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { start } = require("./env");

const root = path.resolve(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };
const react = (w) => { w.eval(read("node_modules/react/umd/react.development.js")); w.eval(read("node_modules/react-dom/umd/react-dom.development.js")); w.eval(read("node_modules/htm/dist/htm.umd.js")); };

(async () => {
  const { server, base } = await start();
  try {
    const here = (p) => fetch(base + p, { redirect: "manual" });
    let r = await here("/");
    check("not a demo: / goes to sign-in", r.status === 302 && r.headers.get("location") === "/login.html", `${r.status} ${r.headers.get("location")}`);
    r = await here("/tour/register.html");
    check("not a demo: the sample pages are gone", r.status === 404, r.status);
    check("not a demo: no demo sign-ins are given out", (await here("/api/demo")).status === 404);
    process.env.DEMO_MODE = "1";
    r = await here("/");
    check("demo: / serves the front page", r.status === 200 && /id="root"/.test(await r.text()));
    r = await here("/tour/register.html");
    check("demo: a sample page is served, an unlisted one is not", r.status === 200 && (await here("/tour/login.html")).status === 404);
    check("demo: the settings and employees sample pages are gone", (await here("/tour/settings.html")).status === 404 && (await here("/tour/employees.html")).status === 404);

    // ---- the kit, on a plain page ----
    {
      const w = new JSDOM('<div id="root"></div><p id="a">first</p>', { runScripts: "outside-only", url: base + "/", pretendToBeVisual: true }).window;
      w.ResizeObserver = class { observe() {} disconnect() {} };
      w.Element.prototype.scrollIntoView = function () {};
      w.Element.prototype.getBoundingClientRect = function () { return { top: 100, left: 200, width: 300, height: 120, right: 500, bottom: 220 }; };
      react(w);
      w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
      w.eval(read("public/js/tour-kit.js") + `
        const steps = [{ title: "One", body: "intro" }, { target: "#a", title: "Two", body: "a" }, { target: "#late", title: "Three", body: "late" }, { title: "Last", body: "end", cta: { label: "Go", href: "/login.html" } }];
        const Page = () => { const t = useTour(); return html\`<button id="again" onClick=\${t.start}>again</button>\`; };
        ReactDOM.createRoot(document.getElementById("root")).render(html\`<\${TourProvider} steps=\${steps}><\${Page} /><//>\`);`);
      await sleep(300);
      const $ = (s) => w.document.querySelector(s);
      const key = (k, extra = {}) => w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
      const click = async (el) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await sleep(300); };
      const button = (t) => [...w.document.querySelectorAll(".tour-card button")].find((b) => b.textContent.trim() === t);
      const title = () => $("#tour-title")?.textContent;
      const card = $(".tour-card");
      check("kit: opens on step 1 in a modal dialog drawn into the body", card?.getAttribute("role") === "dialog" && card.getAttribute("aria-modal") === "true" && title() === "One" && $(".tour-layer").parentElement === w.document.body);
      check("kit: the page behind is inert and cannot scroll; focus is on the card", $("#root").inert === true && w.document.documentElement.style.overflow === "hidden" && w.document.activeElement === card);
      check("kit: a step with no target dims the whole page", $(".tour-spot.none") !== null && !button("Back"));
      await click(button("Next"));
      check("kit: a target gets a spotlight around it", title() === "Two" && $(".tour-spot:not(.none)")?.style.top === "92px", $(".tour-spot")?.getAttribute("style"));
      const items = [...card.querySelectorAll("a[href], button:not([disabled])")];
      items[items.length - 1].focus(); key("Tab");
      check("kit: Tab from the last control wraps to the first", w.document.activeElement === items[0]);
      items[0].focus(); key("Tab", { shiftKey: true });
      check("kit: Shift+Tab from the first control wraps to the last", w.document.activeElement === items[items.length - 1]);
      await click(button("Next"));
      check("kit: an element not there yet gets the card centred, until it renders", title() === "Three" && $(".tour-spot.none") !== null);
      w.document.body.insertAdjacentHTML("beforeend", '<p id="late">late</p>');
      await sleep(500);
      check("kit: ...and then the spotlight finds it", $(".tour-spot:not(.none)") !== null);
      await click(button("Next"));
      check("kit: the last step carries the call to action", title() === "Last" && $(".tour-card a.primary")?.getAttribute("href") === "/login.html" && !button("Skip tour"));
      key("Escape"); await sleep(100);
      check("kit: Escape closes it and gives the page back", !$(".tour-layer") && $("#root").inert === false && w.document.documentElement.style.overflow === "");
      await click($("#again"));
      check("kit: start() opens it again from step 1", title() === "One");
      check("kit: no React warnings", w.errors.length === 0, w.errors.join(" | "));
    }

    // ---- the page ----
    let navigations = 0; // jsdom can't navigate; it reports the attempt
    const vc = new VirtualConsole(); vc.on("jsdomError", (e) => { if (/navigation/.test(e.message)) navigations++; });
    const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/", pretendToBeVisual: true, virtualConsole: vc }).window;
    w.ResizeObserver = class { observe() {} disconnect() {} };
    w.Element.prototype.scrollIntoView = function () {};
    w.fetch = (u, o) => fetch(base + u, o);
    react(w);
    w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
    w.eval(read("public/js/tour-kit.js") + "\n" + read("public/js/tour.js") + "\nwindow.STEPS = STEPS;");
    await sleep(300);
    const $ = (s) => w.document.querySelector(s);
    const next = async () => { [...w.document.querySelectorAll(".tour-card button")].find((b) => b.textContent === "Next").click(); await sleep(200); };
    check("page: starts on the Home screen with the welcome step", $("#screen")?.getAttribute("src") === "/tour/home.html" && $("#tour-title").textContent === "Welcome to ClockIt");
    check("page: the sample screen can't be used", $("#screen").hasAttribute("inert"));
    const visited = [];
    while ([...w.document.querySelectorAll(".tour-card button")].some((b) => b.textContent === "Next")) { await next(); visited.push($("#screen").getAttribute("src")); }
    const order = [...new Set(visited)].map((s) => s.replace("/tour/", "").replace(".html", ""));
    check("page: it visits every screen once, in the menu's order", order.join(",") === "register,kitchen,attention,orders,rewards,products,inventory,reports,shift,home", order.join(","));
    check("page: the last step offers the demo sign-ins", $("#tour-title").textContent === "Ready to try it?" && [...w.document.querySelectorAll(".tour-card button")].some((b) => b.textContent === "Show demo sign-ins"));
    check("page: no React warnings", w.errors.length === 0, w.errors.join(" | "));

    // ---- the demo sign-ins ----
    {
      try {
      r = await here("/");
      check("demo: / shows the tour", r.status === 200 && /id="root"/.test(await r.text()));
      check("demo: the sample pages are served", (await here("/tour/kitchen.html")).status === 200);
      const given = await (await here("/api/demo")).json();
      check("demo: the six dev employees, with number and PIN", given.credentials.length === 6 && given.credentials[0].number === "10420001" && given.credentials[0].pin === "111111"
        && given.credentials.every((c) => c.name && c.role && /^\d{8}$/.test(c.number) && /^\d{6}$/.test(c.pin)));

      const open = async (after) => {
        const d = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/", pretendToBeVisual: true, virtualConsole: vc }).window;
        d.ResizeObserver = class { observe() {} disconnect() {} };
        d.Element.prototype.scrollIntoView = function () {};
        d.fetch = (u, o) => fetch(base + u, o);
        react(d);
        d.errors = []; d.console.error = (...a) => d.errors.push(a.join(" ").slice(0, 300));
        d.eval(read("public/js/tour-kit.js") + "\n" + read("public/js/tour.js") + "\nwindow.STEPS = STEPS;");
        await sleep(400);
        await after(d);
        return d;
      };
      const before = navigations;
      const shown = (d) => ({ rows: [...d.document.querySelectorAll(".logintable tbody tr")].map((tr) => tr.textContent), keep: d.document.querySelector(".keep"), go: d.document.querySelector("a.tour-btn.primary") });
      const checkLogins = (name, d) => {
        const x = shown(d);
        check(`demo: ${name} shows the sign-ins with a keep-this warning and a way on`, x.rows.length === 6 && /Maya.*General manager.*10420001.*111111/.test(x.rows[0]) && /Ana.*Assistant Manager.*10420006.*666666/.test(x.rows[5])
          && /picture.*write it down/.test(x.keep?.textContent) && x.keep.getAttribute("role") === "alert" && x.go?.getAttribute("href") === "/login.html" && navigations === before, JSON.stringify(x.rows));
      };
      checkLogins("Skip tour", await open(async (d) => { [...d.document.querySelectorAll(".tour-card button")].find((b) => b.textContent === "Skip tour").click(); await sleep(150); }));
      checkLogins("Escape", await open(async (d) => { d.document.dispatchEvent(new d.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(150); }));
      checkLogins("the last step", await open(async (d) => {
        const click = async (t) => { [...d.document.querySelectorAll(".tour-card button")].find((b) => b.textContent === t).click(); await sleep(60); };
        for (let i = 0; i < d.STEPS.length - 1; i++) await click("Next");
        await click("Show demo sign-ins"); await sleep(100);
      }));
    } finally { }
    }

    // ---- every step's target is on its page, which runs on sample data ----
    const steps = w.STEPS.filter((s) => s.target);
    let missing = [];
    for (const page of [...new Set(steps.map((s) => s.page))]) {
      const p = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: `${base}/tour/${page}.html`, pretendToBeVisual: true }).window;
      p.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
      p.fetch = (u, o) => fetch(base + u, o);
      const errs = []; p.console.error = (...a) => errs.push(a.join(" ").slice(0, 200));
      react(p);
      p.eval([...read(`public/${page}.html`).matchAll(/src="\/js\/([^"]+)"/g)].map((m) => read(`public/js/${m[1]}`)).join("\n"));
      await sleep(1200);
      for (const s of steps.filter((s) => s.page === page)) if (!p.document.querySelector(s.target)) missing.push(`${page}: ${s.target}`);
      if (errs.length) missing.push(`${page} warnings: ${errs[0]}`);
      if (/isn't in the sample/.test(p.document.body.textContent)) missing.push(`${page}: a call is missing from js/tour-demo.json`);
      p.close();
    }
    check("every step's target is on its sample page, with no gaps in the sample data", missing.length === 0, missing.join(" | "));
  } finally { delete process.env.DEMO_MODE; server.close(); }
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
