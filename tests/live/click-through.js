// Drives the real register page in jsdom against the real app and dev database: select, customize,
// checkout, discounts (staff and manager), tip, sale, refund, nav, sign-out. Adds test sales to the dev DB.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { start, client, pool, unlock, pickUp } = require("./env");

const root = path.resolve(__dirname, "../..");
const lib = (f) => fs.readFileSync(path.join(root, "node_modules", f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + extra)); if (!ok) fails++; };

(async () => {
  const { server, base } = await start();
  const login = await fetch(base + "/api/login/pin", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ employeeNumber: "10420003", pin: "333333" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const w = new JSDOM('<div id="root"></div>', { runScripts: "outside-only", url: base + "/register.html", pretendToBeVisual: true }).window;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.fetch = (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  w.eval(lib("react/umd/react.development.js"));
  w.eval(lib("react-dom/umd/react-dom.development.js"));
  w.eval(lib("htm/dist/htm.umd.js"));
  const errors = [];
  w.console.error = (...a) => errors.push(a.join(" ").slice(0, 300));
  w.eval(["api", "shell", "refund", "register"].map((f) => fs.readFileSync(path.join(root, `public/js/${f}.js`), "utf8")).join("\n"));

  const $ = (sel) => w.document.querySelector(sel);
  const $$ = (sel) => [...w.document.querySelectorAll(sel)];
  const byText = (sel, text) => $$(sel).find((e) => e.textContent.trim().startsWith(text));
  const click = async (el, ms = 150) => { if (!el) throw new Error("missing element"); el.click(); await sleep(ms); };
  const type = async (el, value) => {
    const proto = el.tagName === "SELECT" ? w.HTMLSelectElement : w.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, value);
    el.dispatchEvent(new w.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    await sleep(80);
  };
  const text = () => w.document.body.textContent;
  const opt = (name) => $$("dialog input").find((i) => i.parentElement.textContent.startsWith(name));

  await sleep(800);
  check("footer: employee, role/location", /Sam Rivera/.test(text()) && /Server · Brewbean Downtown/.test(text()));
  check("catalog cards load", $$(".card").length === 6, String($$(".card").length));
  check("1A: no order sidebar, no Customize", !$(".order") && !byText("button", "Customize"));
  check("Refund is a red button", /danger/.test(byText("button", "Refund").className));

  await click(byText(".card", "Latte"));
  check("tap only selects", !$(".order") && !!byText("button", "Customize Latte"));
  await click(byText("button", "Customize Latte"));
  check("modal: Size, Milk, Extras, included", !!$("dialog[open]") && /Size/.test(text()) && /Milk/.test(text()) && /Extras/.test(text()) && /included/.test(text()));
  await click(byText("dialog button", "Large 16 oz")); await click(opt("Oat milk")); await click(opt("Extra shot"));
  check("item total 5.25+0.75+1.00", /Add to order · \$7\.00/.test(text()));
  await click(byText("dialog button", "Cancel"));
  check("Cancel adds nothing", !$("dialog") && !$(".order"));
  await click(byText("button", "Customize Latte"));
  await click(byText("dialog button", "Large 16 oz")); await click(opt("Oat milk"));
  await click(byText("dialog button", "Add to order"));
  check("Add to order: line + panel, selection cleared", /1 × Latte, Large 16 oz/.test(text()) && !!$(".order") && !byText("button", "Customize"));
  check("simple cart view: dark Checkout only", !!byText("button", "Checkout") && !/Subtotal/.test(text()) && /primary/.test(byText("button", "Checkout").className));

  await click(byText("button", "Checkout"), 500);
  check("checkout modules revealed", ["Rewards member", "Promotion", "Subtotal", "Tax (", "Payment method", "Complete sale"].every((s) => text().includes(s)));
  check("Complete sale pinned outside the scroll area, no empty message box", !$(".scroll").contains(byText("button", "Complete sale")) && !$(".msg"));
  check("tip hidden unless card", !/Tip/.test(text()));

  await click(byText("button", "Add discount"));
  await type($("dialog input[type=number]"), "10");
  const [mn, mp] = $$("dialog .override input");
  await type(mn, "10420003"); await type(mp, "333333");
  await click(byText("dialog button", "Apply discount"), 600);
  check("server credentials blocked, modal and inputs kept", !!$("dialog[open]") && /Unauthorized\. Supervisor or Owner credentials required to override\./.test($("dialog .msg").textContent) && mn.value === "10420003");
  await type(mn, "10420002"); await type(mp, "222222");
  await click(byText("dialog button", "Complaint"));
  await click(byText("dialog button", "Apply discount"), 800);
  check("manager approves: Discount (Complaint)", !$("dialog") && /Discount \(Complaint\)/.test(text()));
  await click(byText("button", "Remove discount"), 500);
  check("Remove discount restores", !/Discount \(/.test(text()));

  await click(byText("button", "Add discount"));
  await click(byText("dialog button", "Employee"));
  check("Employee: employee number box, no manager boxes", !$("dialog .override") && /Employee number/.test($("dialog").textContent));
  await type($("dialog input[type=number]"), "50");
  check("Employee over the limit brings the manager boxes", !!$("dialog .override"));
  await type($("dialog input[type=number]"), "15");
  check("Employee under the limit hides them again", !$("dialog .override"));
  await click(byText("dialog button", "Apply discount"), 500);
  check("empty employee number refused", /8-digit/.test($("dialog .msg").textContent));
  await type($("dialog label input[inputmode=numeric]"), "99999999");
  await click(byText("dialog button", "Apply discount"), 500);
  check("unknown employee number refused", /Employee Number does not exist\./.test($("dialog .msg").textContent));
  await type($("dialog label input[inputmode=numeric]"), "10420004");
  await click(byText("dialog button", "Apply discount"), 800);
  check("real employee number applies it, no manager", !$("dialog") && /Discount \(Employee\)/.test(text()));

  await click(byText(".pay button", "Card")); await click(byText(".pay button", "18%"));
  check("tip separate, with Total with tip", /Tip\s*\$/.test(text()) && /Total with tip/.test(text()) && /can't be refunded/.test(text()));
  await type($("input[aria-label='Card number']"), "4242 4242 4242 4242");
  await type($("input[aria-label='Card expiry']"), "12/49");
  await type($("input[aria-label='Card security code']"), "123");
  await click(byText("button", "Cancel"), 150);
  check("Cancel returns to the simple cart view", !!byText("button", "Checkout") && !/Subtotal/.test(text()));
  await click(byText("button", "Checkout"), 400);
  await click(byText("button", "Complete sale"), 1500);
  const sale = /Sale complete: order (\d+), \$([\d.]+)/.exec(text()) || [];
  check("sale complete: notice, sidebar hidden", !!sale[1] && !$(".order"), text().slice(0, 200));

  await pickUp(sale[1]); // the kitchen's last step; refunds need a completed order
  await click(byText("button", "Refund"));
  check("refund view, #refund", /Find the order/.test(text()) && w.location.hash === "#refund");
  await type($(".find input"), sale[1]);
  await click(byText(".find button", "Find"), 600);
  check("refund screen offers Send to a manager, off until items and a reason are chosen", !!byText("button", "Send to a manager")?.disabled);
  check("order found, tip shown as not refundable", new RegExp("Order " + sale[1]).test(text()) && /not refundable/.test(text()));
  await click($(".rt tbody input[type=checkbox]"), 200);
  check("refund total excludes the tip", new RegExp("Refund total\\s*\\$" + sale[2].replace(".", "\\.")).test(text()));
  await type($(".side .field"), "Customer changed mind");
  const si = $$(".dashed input");
  await type(si[0], "10420003"); await type(si[1], "333333");
  await click(byText("button", "Complete refund"), 800);
  check("refund blocked for server credentials", /Unauthorized\./.test(($(".msg.dashed") || {}).textContent || ""));
  await type(si[0], "10420002"); await type(si[1], "222222");
  await click(byText("button", "Complete refund"), 1200);
  check("refund completes; Fully returned", /Refund complete/.test(text()) && /Fully returned/.test(text()));
  w.history.back(); await sleep(150);
  check("browser Back leaves the refund view", $$(".card").length === 6);
  const links = $$(".nav a.link");
  check("a server's menu lists only its five pages", links.map((a) => a.textContent).join("|") === "Register|Kitchen|Rewards|Products|My shift");
  check("Kitchen and My shift open their own pages", links[1].getAttribute("href") === "/kitchen.html" && links[4].getAttribute("href") === "/shift.html" && links[0].getAttribute("aria-current") === "page");
  w.localStorage.setItem("x", "1");
  await click(byText("button", "Sign out"), 500);
  const after = await fetch(base + "/api/session", { headers: { cookie } });
  check("sign out: session destroyed, browser storage cleared", after.status === 401 && w.localStorage.getItem("x") === null);
  check("no React warnings", !errors.length, errors.join(" | "));

  server.close();
  await pool.end();
  console.log(fails ? fails + " FAILED" : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
