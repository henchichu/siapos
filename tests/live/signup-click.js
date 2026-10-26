// Drives the real sign-up page in jsdom: each step's checks before Continue, the side panel following along, registers added and
// removed, the PIN dots, Review's Edit links, and Create business through to the done screen and a signed-in owner.
// The business it creates is deleted afterwards.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { JSDOM } = require("jsdom");
const { start, pool, removeBusiness } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const app = fs.readFileSync(path.join(root, "public/js/signup.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };
const tag = crypto.randomBytes(3).toString("hex");

(async () => {
  const { server, base } = await start();
  let businessId;
  try {
    const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/signup.html", pretendToBeVisual: true }).window;
    let cookie = "";
    w.fetch = async (url, opts = {}) => {
      const res = await fetch(base + url, opts);
      cookie = (res.headers.get("set-cookie") || cookie).split(";")[0];
      return res;
    };
    w.eval(lib("react/umd/react.development.js")); w.eval(lib("react-dom/umd/react-dom.development.js")); w.eval(lib("htm/dist/htm.umd.js"));
    w.errors = []; w.console.error = (...a) => w.errors.push(a.join(" ").slice(0, 300));
    w.eval(app);
    await sleep(300);

    const $ = (s) => w.document.querySelector(s);
    const $$ = (s) => [...w.document.querySelectorAll(s)];
    const field = (label) => $$(".field").find((f) => f.querySelector(".lbl").textContent.startsWith(label))?.querySelector("input,select");
    const button = (t) => $$("button").find((b) => b.textContent.trim() === t);
    const type = async (el, v) => {
      const proto = el.tagName === "SELECT" ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new w.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
      await sleep(30);
    };
    const click = async (el) => { el.click(); await sleep(150); };
    const title = () => $(".form h1")?.textContent;
    const msg = () => $(".msg")?.textContent.trim() || "";
    const states = () => $$(".steps li").map((l) => l.className).join(" ");

    check("step 1: the business form, Setting up Your business, step 1 current", title() === "Tell us about your business" && $(".biz").textContent === "Your business"
      && states() === "is-now is-next is-next is-next" && $(".eyebrow")?.textContent === "Setting up", states());
    check("no Back on the first step, and the message area is a live region", !button("Back") && $(".msg").getAttribute("aria-live") === "assertive");
    check("the tax question is two choice cards, No chosen", $$(".choice").length === 2 && $(".choice.on").textContent.startsWith("No, tax is added"));
    check("links home and to the staff sign-in", $(".side-links .home")?.getAttribute("href") === "/" && $$(".side-links a").some((a) => a.getAttribute("href") === "/login.html"));

    await click(button("Continue"));
    check("Continue with no name says so and stays", msg() === "Enter your business name." && title() === "Tell us about your business", msg());
    await type(field("Business name"), `Click Shop ${tag}`);
    check("typing clears the message and the side panel follows", msg() === "" && $(".biz").textContent === `Click Shop ${tag}`);
    await type(field("Contact email"), "not-an-email");
    await click(button("Continue"));
    check("a bad optional email is caught", /valid email/.test(msg()), msg());
    await type(field("Contact email"), "");
    await click($$(".choice")[1].querySelector("input"));
    check("Yes, tax is included can be chosen", $(".choice.on").textContent.startsWith("Yes, tax is included"));
    await click(button("Continue"));

    check("step 2: the location form, step 1 ticked", title() === "Your first location" && states() === "is-done is-now is-next is-next", states());
    check("Central is the default time zone, from the short US list", field("Time zone").value === "America/Chicago" && $$(".select option").length === 7);
    check("one register, Front counter, which can't be removed", $$(".reg input").map((i) => i.value).join() === "Front counter" && !button("Remove"));
    await click(button("Continue"));
    check("the design's error example: Give your first location a name.", msg() === "Give your first location a name.", msg());
    await type(field("Location name"), "Downtown");
    await click(button("+ Add register"));
    check("Add register adds an empty one, and now each can be removed", $$(".reg").length === 2 && $$(".reg button").length === 2);
    await click(button("Continue"));
    check("an empty register name is caught", msg() === "Give each register a name.", msg());
    await type($$(".reg input")[1], "front counter");
    await click(button("Continue"));
    check("two registers can't share a name", msg() === "Each register needs its own name.", msg());
    await type($$(".reg input")[1], "Drive-thru");
    await click(button("+ Add register"));
    await type($$(".reg input")[2], "Patio");
    await click($$(".reg button")[2]);
    check("Remove takes that register away", $$(".reg input").map((i) => i.value).join() === "Front counter,Drive-thru");
    await type(field("Time zone"), "America/Denver");
    await click(button("Continue"));

    check("step 3: the owner form, with the employee number note", title() === "Create your owner account" && /8-digit employee number when you finish/.test($(".note").textContent));
    await type(field("First name"), "Dana");
    await type(field("Last name"), "Reyes");
    await type(field("Email"), `Dana.${tag}@Example.com`);
    await type(field("Choose a 6-digit PIN"), "48a15");
    check("the PIN keeps digits only, and its dots fill", field("Choose a 6-digit PIN").value === "4815" && $$(".dots i.on").length === 4);
    await click(button("Continue"));
    check("a short PIN is caught", msg() === "Choose a 6-digit PIN.", msg());
    await type(field("Choose a 6-digit PIN"), "481516");
    await type(field("Confirm PIN"), "481517");
    check("a different confirm PIN says so beside the dots", $(".match").textContent === "PINs don't match");
    await click(button("Continue"));
    check("and Continue won't go on", /PINs don't match/.test(msg()), msg());
    await type(field("Confirm PIN"), "481516");
    check("matching PINs say PINs match", $(".match").textContent === "PINs match");
    await click(button("Continue"));

    const rows = () => $$(".review > div").map((d) => `${d.querySelector("dt").textContent}=${d.querySelector("dd").textContent}`);
    check("step 4: one row per section", title() === "Check everything" && rows().join("|") === [`Business=Click Shop ${tag} · tax included in prices`, "First location=Downtown · America/Denver",
      "Registers=Front counter, Drive-thru", `Owner=Dana Reyes · dana.${tag}@example.com`].join("|"), rows().join("|"));
    await click($$(".review .edit button")[1]);
    check("Edit opens that step with what was typed", title() === "Your first location" && field("Location name").value === "Downtown");
    await type(field("Location name"), "Uptown");
    await click(button("Continue")); await click(button("Continue"));
    check("back on Review, the change shows", rows()[1] === "First location=Uptown · America/Denver", rows()[1]);
    await click(button("Create business"));
    check("Create business needs the terms ticked", /Agree to the terms/.test(msg()) && !$(".done"), msg());
    check("the terms and privacy links are placeholders", $$(".agree a").map((a) => a.textContent).join() === "[terms],[privacy policy]");
    await click($(".agree input"));
    await click(button("Create business"));
    await sleep(800);

    const number = $(".number b")?.textContent || "";
    check("the done screen greets the owner and shows their new number", $(".done h1")?.textContent === "You're all set, Dana!" && /^[1-9]\d{7}$/.test(number), $(".done")?.textContent);
    check("every step is ticked", states() === "is-done is-done is-done is-done", states());
    check("the checklist names screens that exist, as plain text", $$(".next li").length === 6 && !$(".next input") && /Settings → General · set tax rates/.test($(".next").textContent)
      && !/Pay and rewards|Sales tax/.test($(".next").textContent));
    check("Open ClockIt goes Home", $(".done a.btn")?.textContent === "Open ClockIt" && $(".done a.btn").getAttribute("href") === "/home.html");

    const [[emp]] = await pool.query("SELECT BusinessID AS id FROM Employee WHERE EmployeeNumber = ?", [number]);
    businessId = emp?.id;
    const [[loc]] = await pool.query("SELECT Name, TimeZone FROM Location WHERE BusinessID = ?", [businessId]);
    const [[biz]] = await pool.query("SELECT PricesIncludeTax FROM Business WHERE BusinessID = ?", [businessId]);
    check("what was typed is what was saved", loc?.Name === "Uptown" && loc.TimeZone === "America/Denver" && !!biz?.PricesIncludeTax, JSON.stringify([loc, biz]));
    const me = await fetch(base + "/api/session", { headers: { cookie } });
    const session = await me.json();
    check("the owner is signed in", me.status === 200 && session.employeeName === "Dana Reyes" && session.roleName === "Owner" && session.locationName === "Uptown", JSON.stringify(session));
    check("no React warnings", w.errors.filter((e) => !/Not implemented/.test(e)).length === 0, JSON.stringify(w.errors));
  } finally {
    if (businessId) await removeBusiness(businessId);
    server.close(); await pool.end();
  }
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
