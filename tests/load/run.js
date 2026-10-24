// Load test against the running dev stack: phones ordering at the public server while registers sell at the staff server.
//   docker compose -f docker-compose.yaml -f docker-compose.dev.yaml -f docker-compose.load.yaml up -d kiosk-api
//   node tests/load/run.js [--phones 30] [--registers 3] [--seconds 20] [--hammer]
// --hammer drops every pause, so each phone and register goes as fast as it can: that finds the ceiling, not a realistic rush.
// Needs the database port (127.0.0.1:3306) like the other tests. Its orders are marked completed afterwards so the kitchen stays clear.
const crypto = require("crypto");
const { pool, topUp, TEST_CARD } = require("../live/env");

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const PHONES = arg("phones", 30), REGISTERS = arg("registers", 3), SECONDS = arg("seconds", 20);
const KIOSK = process.env.KIOSK_URL || "http://127.0.0.1:3001", STAFF = process.env.STAFF_URL || "http://127.0.0.1:3000";
const HAMMER = process.argv.includes("--hammer");
const sleep = (ms) => (HAMMER ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
const think = () => sleep(200 + Math.random() * 800); // a person pauses between taps

const stats = {}; // name -> { ms: [], status: {code: n} }
async function timed(name, run) {
  const t = performance.now();
  let status = "error", body;
  try { const r = await run(); status = r.status; body = r.body; return r; }
  catch (err) { return { status: 0, body: {} }; }
  finally {
    const s = (stats[name] ??= { ms: [], status: {} });
    s.ms.push(performance.now() - t); s.status[status] = (s.status[status] || 0) + 1;
    if (status !== 200 && !s.sample) s.sample = body?.error || String(status); // the first refusal's message
  }
}

// A browser's cookie jar, as much as these calls need
function session(base, headers = {}) {
  const jar = new Map();
  return async (path, body) => {
    const res = await fetch(base + "/api" + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const set of res.headers.getSetCookie()) { const [pair] = set.split(";"); const i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

async function phone(until) {
  const call = session(KIOSK, { "x-location-id": "loc-campus" });
  while (Date.now() < until) {
    await timed("phone: open page (context+menu)", async () => { const [a, b] = await Promise.all([call("/customer/context"), call("/customer/catalog")]); return b.status === 200 ? a : b; });
    await think();
    const items = [{ key: "a", variantId: "var-croissant", quantity: 1 }];
    await timed("phone: price the cart", () => call("/customer/price", { items }));
    await think();
    const r = await timed("phone: place order (card)", () => call("/customer/orders", { idempotencyKey: crypto.randomUUID(), paymentMethod: "Card", card: TEST_CARD, guestName: "Load", items }));
    if (r.body.orderId) await timed("phone: order status", () => call(`/customer/orders/${r.body.orderId}`));
    await sleep(2000 + Math.random() * 3000); // then it waits for the coffee before anyone orders again from this phone
  }
}

async function register(n, until) {
  const call = session(STAFF);
  const login = await call("/login/pin", { employeeNumber: "10420003", pin: "333333" });
  if (login.status !== 200) { console.error(`register ${n} could not sign in: ${login.status}`); return; }
  while (Date.now() < until) {
    await timed("register: sale (cash)", () => call("/register/orders", { saleId: crypto.randomUUID(), items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], payment: { method: "cash" } }));
    await sleep(500 + Math.random() * 1000);
  }
}

const pct = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))] : 0;

(async () => {
  const [[{ first }]] = await pool.query("SELECT COALESCE(MAX(OrderNumber), 0) AS first FROM Orders WHERE BusinessID = 'biz-brewbean'");
  const [recipe] = await pool.query("SELECT StockItemID AS id FROM VariantRecipe WHERE VariantID = 'var-croissant'");
  for (const r of recipe) for (const place of ["loc-campus", "loc-downtown"]) await topUp(r.id, 100000, place).catch(() => {}); // the registers' café may be either
  console.log(`${PHONES} phones and ${REGISTERS} registers for ${SECONDS}s (public ${KIOSK}, staff ${STAFF})`);
  const start = Date.now(), until = start + SECONDS * 1000;
  await Promise.all([...Array.from({ length: PHONES }, () => phone(until)), ...Array.from({ length: REGISTERS }, (_, i) => register(i + 1, until))]);
  const secs = (Date.now() - start) / 1000;
  console.log(`\n${"request".padEnd(36)} ${"n".padStart(6)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"p99".padStart(7)}   statuses`);
  for (const [name, s] of Object.entries(stats))
    console.log(`${name.padEnd(36)} ${String(s.ms.length).padStart(6)} ${pct(s.ms, 50).toFixed(0).padStart(5)}ms ${pct(s.ms, 95).toFixed(0).padStart(5)}ms ${pct(s.ms, 99).toFixed(0).padStart(5)}ms   ${JSON.stringify(s.status)}${s.sample ? `  e.g. "${s.sample}"` : ""}`);
  const orders = (stats["phone: place order (card)"]?.status[200] || 0) + (stats["register: sale (cash)"]?.status[200] || 0);
  console.log(`\n${orders} orders in ${secs.toFixed(1)}s = ${(orders / secs).toFixed(1)} orders/s`);
  // hand over what the test made, so the kitchen screen and the Orders page aren't left with hundreds of open tickets
  const [done] = await pool.query("UPDATE Orders SET OrderStatusCode = 5, CompletedAt = UTC_TIMESTAMP() WHERE BusinessID = 'biz-brewbean' AND OrderNumber > ? AND OrderStatusCode = 2", [first]);
  console.log(`${done.affectedRows} of the test's orders marked picked up`);
  await pool.end();
})();
