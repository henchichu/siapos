// Drives the real sign-in page in jsdom: the email and password form, empty and wrong entries, the generic wrong-password message,
// the lockout (form off), and a successful sign-in.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, pool, unlock } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = fs.readFileSync(path.join(root, "public/js/login.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

const PRIYA = { id: "emp-priya", email: "priya@brewbean.example.com", password: "priya-dev-pass" };

(async () => {
  const { server, base } = await start();
  await unlock(PRIYA.id);
  try {
    const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/login.html", pretendToBeVisual: true }).window;
    const answers = []; // every sign-in answer, newest last
    w.fetch = async (url, opts = {}) => {
      const res = await fetch(base + url, opts);
      answers.push({ url, status: res.status, body: await res.clone().json().catch(() => ({})) });
      return res;
    };
    w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
    w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
    w.eval(app);
    await sleep(300);

    const $ = (s) => w.document.querySelector(s);
    const $$ = (s) => [...w.document.querySelectorAll(s)];
    const live = () => $(".messages")?.textContent.trim() || "";
    // React watches the input event, so set the value the way a browser does
    const fill = async (name, value) => {
      const el = $(`input[name=${name}]`);
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(el, value);
      el.dispatchEvent(new w.Event("input", { bubbles: true }));
      await sleep(30);
    };
    const submit = async (email, password) => { await fill("email", email); await fill("password", password); $(".signbtn").click(); await sleep(500); };

    check("Sign in, an email field, a password field and a Sign in button", $(".eyebrow")?.textContent === "Sign in" && $("input[name=email]")?.type === "email"
      && $("input[name=password]")?.type === "password" && $(".signbtn")?.textContent === "Sign in");
    check("the fields are labelled and the browser may offer saved logins", $$("label").map((l) => l.firstChild.textContent.trim()).join("|") === "Email|Password"
      && $("input[name=email]").autocomplete === "username" && $("input[name=password]").autocomplete === "current-password");
    check("the page is branded with the business's name from the database", $(".brand")?.textContent === "Brewbean Coffee" && w.document.title === "Brewbean Coffee · Sign in", `${$(".brand")?.textContent} | ${w.document.title}`);
    check("no keypad, no employee number", !$(".numpad") && !/employee number/i.test(w.document.body.textContent));
    check("messages sit in an aria-live region", $(".messages")?.getAttribute("aria-live") === "assertive");

    const before0 = answers.length;
    $(".signbtn").click(); await sleep(200);
    check("an empty form is explained and nothing is sent", /Enter your email and password/.test(live()) && answers.length === before0, live());

    await submit("nobody@brewbean.example.com", "wrong-password");
    const unknown = answers.filter((a) => a.url === "/api/login").at(-1);
    check("an unknown email gets the same plain answer", unknown?.status === 401 && /^Incorrect email or password\.$/.test(live()), live());
    check("and the password is cleared, the email kept", $("input[name=password]").value === "" && $("input[name=email]").value === "nobody@brewbean.example.com");

    await submit(PRIYA.email, "wrong-password");
    check("a wrong password for a real email says exactly the same", /^Incorrect email or password\.$/.test(live()) && !$(".lockout"), live());

    for (let i = 0; i < 3; i++) await submit(PRIYA.email, "wrong-password");
    await submit(PRIYA.email, "wrong-password");
    check("the fifth wrong password locks the account, showing a time and its lock icon, with no soft message beside it", answers.at(-1).status === 423 && /^Too many tries\. Locked until \d{1,2}:\d\d/.test($(".lockout")?.textContent || "") && !!$(".lockout svg.lock") && !$(".messages .error"), $(".lockout")?.textContent);
    check("while locked the fields and button are off", $("input[name=email]").disabled && $("input[name=password]").disabled && $(".signbtn").disabled);
    const before = answers.length;
    $(".signbtn").click(); await sleep(200);
    check("while locked nothing is sent", answers.length === before);

    await unlock(PRIYA.id);
    // a real browser would reload the page once the lock is lifted; start a fresh one
    const w2 = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/login.html", pretendToBeVisual: true }).window;
    const answers2 = [];
    w2.fetch = async (url, opts = {}) => { const res = await fetch(base + url, opts); answers2.push({ url, status: res.status, body: await res.clone().json().catch(() => ({})) }); return res; };
    w2.eval(lib("react/umd/react.development.js")); w2.eval(lib("react-dom/umd/react-dom.development.js")); w2.eval(lib("htm/dist/htm.umd.js"));
    w2.errors = []; w2.console.error = (...a) => w2.errors.push(a.join(" ").slice(0, 300));
    w2.eval(app);
    await sleep(300);
    const set = async (name, value) => { const el = w2.document.querySelector(`input[name=${name}]`); Object.getOwnPropertyDescriptor(w2.HTMLInputElement.prototype, "value").set.call(el, value); el.dispatchEvent(new w2.Event("input", { bubbles: true })); await sleep(30); };
    await set("email", `  ${PRIYA.email.toUpperCase()} `); await set("password", PRIYA.password);
    w2.document.querySelector("form").dispatchEvent(new w2.Event("submit", { bubbles: true, cancelable: true })); await sleep(600);
    const ok = answers2.filter((a) => a.url === "/api/login").at(-1);
    check("the right email and password sign in and head Home", ok?.status === 200 && ok.body.redirect === "/home.html", JSON.stringify(ok));
    check("no React warnings (second page)", w2.errors.filter((e) => !/Not implemented/.test(e)).length === 0, JSON.stringify(w2.errors));
    check("no React warnings", w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, JSON.stringify(w.errors));
  } finally {
    await unlock(PRIYA.id);
    server.close(); await pool.end();
  }
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
