// Drives the real sign-up page in jsdom: the business's name, each check before anything is sent, a taken email, and a good sign-up.
process.env.RATE_LIMIT_SCALE = "50";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool, admin } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = fs.readFileSync(path.join(root, "public/js/signup.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };
const EMAIL = `click-${Date.now().toString(36)}@example.com`;

(async () => {
  const { server, base } = await start();
  try {
    const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/signup.html", pretendToBeVisual: true }).window;
    const sent = []; // what the page sent to /api/signup
    w.fetch = (url, opts) => { if (url === "/api/signup") sent.push(JSON.parse(opts.body)); return fetch(base + url, opts); };
    w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
    w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
    w.eval(app);
    await sleep(500);
    const $ = (s) => w.document.querySelector(s);
    const fill = async (name, value) => {
      const el = $(`input[name=${name}]`);
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(el, value);
      el.dispatchEvent(new w.Event("input", { bubbles: true }));
      await sleep(30);
    };
    const submit = async () => { $("form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await sleep(700); };
    const msg = () => $(".msg")?.textContent || "";

    check("the brand panel names the business", $(".biz")?.textContent === "Brewbean Coffee" && w.document.title === "Brewbean Coffee · Create an account", `${$(".biz")?.textContent} | ${w.document.title}`);
    check("four labelled fields and a Create account button", [...w.document.querySelectorAll(".lbl")].map((l) => l.textContent).join("|") === "First name|Email|Password|Confirm password"
      && $(".btn")?.textContent === "Create account");
    check("a link back to sign-in", [...w.document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/login.html"));

    await submit();
    check("an empty form is refused before anything is sent", /first name/.test(msg()) && sent.length === 0, msg());
    await fill("firstName", "Nia"); await submit();
    check("a missing email is refused", /valid email/.test(msg()) && sent.length === 0, msg());
    await fill("email", EMAIL); await fill("password", "short"); await fill("confirm", "short"); await submit();
    check("a short password is refused", /8 to 200/.test(msg()) && sent.length === 0, msg());
    await fill("password", "a-long-pass-1"); await fill("confirm", "a-long-pass-2"); await submit();
    check("two different passwords are refused", /don't match/.test(msg()) && sent.length === 0, msg());

    await fill("email", "ava@example.com"); await fill("confirm", "a-long-pass-1"); await submit();
    check("a taken email says so, from the server", sent.length === 1 && /already registered/.test(msg()), msg());
    check("and the fields stay filled in", $("input[name=firstName]").value === "Nia");

    await fill("email", EMAIL); await submit();
    const [[made]] = await pool.query("SELECT COUNT(*) AS n FROM Customer c JOIN CustomerCredential k USING (CustomerID) WHERE c.Email = ?", [EMAIL]);
    check("a good sign-up creates the customer with a password", sent.length === 2 && made.n === 1, JSON.stringify(sent.at(-1)));
    check("React reported no errors", w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, JSON.stringify(w.errors));
  } finally {
    await admin.query("DELETE FROM CustomerCredential WHERE CustomerID IN (SELECT CustomerID FROM Customer WHERE Email = ?)", [EMAIL]);
    await admin.query("DELETE FROM Customer WHERE Email = ?", [EMAIL]);
    server.close(); await pool.end(); await admin.end();
  }
  console.log(fails ? `${fails} failed` : "all passed");
  process.exit(fails ? 1 : 0);
})();
