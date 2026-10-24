// The public kiosk server (server/kiosk.js), the only side the public proxy points at: it serves the kiosk page and nothing of the staff side.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
process.env.KIOSK_LOCATION_ID = "loc-campus"; // the demo café this kiosk belongs to
delete process.env.KIOSK_PHONE_SIGNIN; // off unless a test turns it on
const { start, pool } = require("./env");
const kioskApp = require("../../server/kiosk");

let staff, pub, base;
const get = (path, opts) => fetch(base + path, { redirect: "manual", ...opts });
const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test.before(async () => {
  staff = await start();
  pub = await new Promise((r) => { const s = kioskApp.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${pub.address().port}`;
});
test.after(async () => { pub.close(); staff.server.close(); await pool.end(); });

test("it serves the kiosk page and the files that page loads", async () => {
  for (const path of ["/customer.html", "/css/customer.css", "/js/customer.js", "/vendor/react.js", "/vendor/htm.js", "/img/customer/dropdown.svg"])
    assert.equal((await get(path)).status, 200, path);
  assert.equal((await get("/customer")).headers.get("location"), "/customer.html");
  assert.equal((await get("/")).headers.get("location"), "/customer.html");
});

test("nothing from the staff side is there", async () => {
  const paths = ["/home.html", "/login.html", "/register.html", "/reports.html", "/employees.html", "/css/register.css", "/js/shell.js", "/js/register.js",
    "/api/session", "/api/employees", "/api/reports/live", "/api/orders", "/api/register/catalog", "/health", "/package.json",
    "/img/customer/%2e%2e/%2e%2e/server/server.js", "/%2e%2e/server/server.js", "/vendor/../server/server.js"];
  for (const path of paths) assert.equal((await get(path)).status, 404, path);
  assert.equal((await post("/api/login/pin", { employeeNumber: "10420001", pin: "111111" })).status, 404, "no staff sign-in");
});

test("phone sign-in is off here, and the page is told so", async () => {
  const login = await post("/api/customer/login", { phone: "(312) 555-0142" });
  assert.equal(login.status, 403);
  assert.match((await login.json()).error, /Continue as a guest/);
  assert.equal((await (await get("/api/customer/context")).json()).phoneSignIn, false);
  assert.equal((await get("/api/customer/my-orders")).status, 401);
  // the staff-side address still offers it
  const own = await fetch(`${staff.base}/api/customer/context`);
  assert.equal((await own.json()).phoneSignIn, true);
});

test("with KIOSK_PHONE_SIGNIN=1 (a demo) phone sign-in works here too", async () => {
  process.env.KIOSK_PHONE_SIGNIN = "1";
  try {
    assert.equal((await (await get("/api/customer/context")).json()).phoneSignIn, true);
    const login = await post("/api/customer/login", { phone: "(312) 555-0142" });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await get("/api/customer/my-orders", { headers: { cookie } })).status, 200, "and the session works");
    assert.ok(!/;\s*secure/i.test(login.headers.get("set-cookie")), "no Secure flag over plain http");
    const viaProxy = await fetch(base + "/api/customer/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "https" }, body: JSON.stringify({ phone: "(312) 555-0142" }) });
    assert.match(viaProxy.headers.get("set-cookie"), /;\s*secure/i, "Secure when the proxy says it served https");
  } finally { delete process.env.KIOSK_PHONE_SIGNIN; }
  assert.equal((await post("/api/customer/login", { phone: "(312) 555-0142" })).status, 403, "off again when the flag is gone");
});

test("a guest can browse, order and read their order back", async () => {
  const catalog = await (await get("/api/customer/catalog")).json();
  assert.ok(catalog.products.length > 0);
  const order = await post("/api/customer/orders", { idempotencyKey: crypto.randomUUID(), paymentMethod: "Cash", guestName: "Public guest",
    items: [{ key: "a", variantId: "var-croissant", quantity: 1 }] });
  assert.equal(order.status, 200);
  const { orderId } = await order.json();
  assert.equal((await get(`/api/customer/orders/${orderId}`)).status, 200);
  assert.equal((await get("/api/customer/orders/not-a-real-id")).status, 404);
  assert.equal((await get("/api/customer/products/not-a-real-id/photo")).status, 404);
});

test("one address can't make endless requests, which would hold the database from the registers", async () => {
  let blocked = 0;
  for (let i = 0; i < 320 && !blocked; i++) if ((await post("/api/customer/touch", {})).status === 429) blocked = i;
  assert.ok(blocked > 0 && blocked <= 300, `limited after ${blocked} requests`);
  assert.equal((await get("/customer.html")).status, 200, "the page itself still loads");
});
