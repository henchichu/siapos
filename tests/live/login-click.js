// Drives the real sign-in page in jsdom: the employee-number step, the PIN step, the keypad and the keyboard,
// auto-advance and auto-submit, a wrong PIN, the lockout (keypad off), Start over, and a successful sign-in.
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

const PRIYA = { id: "emp-priya", number: "10420004", pin: "444444" };

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
    const key = (k) => $$(".numpad button").find((b) => b.textContent === k);
    const tap = async (digits) => { for (const d of digits) { key(d).click(); await sleep(20); } await sleep(400); };
    const type = async (keys) => { for (const k of keys) { w.document.body.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true })); await sleep(20); } await sleep(400); };
    const live = () => $(".messages")?.textContent.trim() || "";
    const slots = () => $$(".slot").map((s) => s.textContent).join("");
    const filled = () => $$(".pin.on").length;

    check("step 1: Staff sign-in, the heading, 8 empty slots", $(".eyebrow")?.textContent === "Staff sign-in" && $(".prompt")?.textContent === "Enter your employee number"
      && $$(".slot").length === 8 && slots() === "");
    check("the logo is the light ClockIt image", $(".brand img")?.getAttribute("src") === "/img/clockit-logo-light.png" && $(".brand img").getAttribute("alt") === "ClockIt");
    check("the keypad is 11 real buttons: 1-9, Delete, 0", $$(".numpad button").map((b) => b.textContent).join("") === "123456789Delete0" && $$(".numpad button").every((b) => b.type === "button"));
    check("Step 1 of 2 with a two-part progress bar, first part on", /Step 1 of 2/.test($(".step")?.textContent) && $$(".progress span").length === 2 && $$(".progress span.on").length === 1);
    check("messages sit in an aria-live region", $(".messages")?.getAttribute("aria-live") === "assertive");

    await tap("1042"); await type(["0"]);
    check("keypad and keyboard both type into the slots", slots() === "10420", slots());
    await type(["Backspace"]); key("Delete").click(); await sleep(100);
    check("Backspace and Delete each remove one digit", slots() === "104", slots());

    await type("99999".split(""));
    check("an unknown number says so, in the live region, and clears the slots", /does not exist/.test(live()) && slots() === "" && !$(".pins"), live());

    await type(PRIYA.number.split(""));
    check("8 digits move on to the PIN step by themselves", $(".prompt")?.textContent === "Enter your PIN" && $$(".pin").length === 6, $(".prompt")?.textContent);
    check("the PIN step names the business and café but not the person", $(".eyebrow")?.textContent === "Brewbean Coffee · Brewbean Campus" && !/Priya/.test(w.document.body.textContent), $(".eyebrow")?.textContent);
    check("no step bar on the PIN step, and Not you? Start over", !$(".step") && /Not you\?\s*Start over/.test($(".again")?.textContent || ""));

    await tap("12");
    check("circles fill as digits are typed", filled() === 2);
    await type("0000".split(""));
    const wrong = answers.filter((a) => a.url === "/api/login/pin").at(-1);
    check("6 digits submit by themselves", wrong?.status === 401);
    check("a wrong PIN says how many tries are left and clears the circles", /Incorrect PIN\. 4 retries left\./.test(live()) && filled() === 0 && !$(".lockout"), live());

    for (let i = 0; i < 4; i++) await type("000000".split(""));
    check("the fifth wrong PIN locks the account", answers.at(-1).status === 423 && /^Too many tries\. Locked until \d{1,2}:\d\d/.test($(".lockout")?.textContent || ""), $(".lockout")?.textContent);
    check("the lockout bar has its lock icon and no soft message beside it", !!$(".lockout svg.lock") && !$(".messages .error"));
    check("while locked the keypad is off", $$(".numpad button").every((b) => b.disabled));
    const before = answers.length;
    await type("444444".split("")); await type(["Enter"]);
    check("while locked the keyboard does nothing", answers.length === before && filled() === 0);

    $(".again .link").click(); await sleep(200);
    check("Start over goes back to step 1, empty", $(".prompt")?.textContent === "Enter your employee number" && slots() === "" && !$(".lockout") && live() === "");

    await unlock(PRIYA.id);
    await type(PRIYA.number.split(""));
    await type(PRIYA.pin.split(""));
    const ok = answers.filter((a) => a.url === "/api/login/pin").at(-1);
    check("the right PIN signs in and heads Home", ok?.status === 200 && ok.body.redirect === "/home.html", JSON.stringify(ok));
    check("no React warnings", w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, JSON.stringify(w.errors));
  } finally {
    await unlock(PRIYA.id);
    server.close(); await pool.end();
  }
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
