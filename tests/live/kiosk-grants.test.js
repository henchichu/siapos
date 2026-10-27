// Needs the dev database (docker compose ... docker-compose.dev.yaml). The public order server runs as `kiosk_user`, a database
// login that can read the menu and write orders and nothing else. This starts the real server/kiosk.js as that login.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("node:child_process");
const mysql = require("mysql2/promise");
const { pool, TEST_CARD } = require("./env");
const { expireStale } = require("../../server/kioskorders");

const root = path.resolve(__dirname, "../..");
const passwordFile = path.join(root, "sql/secrets/kiosk_user_password.txt");
let child, base, db, logs = "";

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });

test.before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, KIOSK_PORT: String(port), DB_HOST: "127.0.0.1", DB_USER: "kiosk_user", DB_PASSWORD_FILE: passwordFile };
  delete env.DB_PASSWORD;
  child = spawn("node", ["server/kiosk.js"], { cwd: root, env });
  child.stdout.on("data", (d) => { logs += d; }); child.stderr.on("data", (d) => { logs += d; });
  for (let i = 0; i < 50; i++) { if ((await fetch(`${base}/ready`).catch(() => ({ ok: false }))).ok) break; await new Promise((r) => setTimeout(r, 200)); }
  db = await mysql.createConnection({ host: "127.0.0.1", database: process.env.DB_NAME || "miniworld", user: "kiosk_user", password: fs.readFileSync(passwordFile, "utf8").trim() });
});
test.after(async () => { child?.kill(); await db?.end(); await pool.end(); });

const denied = (sql) => assert.rejects(db.query(sql), (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR" || e.code === "ER_COLUMNACCESS_DENIED_ERROR", sql);

test("the public login can't read anything about staff, pay or money owed, and can't change the menu", async () => {
  for (const table of ["Employee", "EmployeeCredential", "EmployeePayRate", "Role", "RolePermission", "TimeEntry", "Refund", "GiftCard", "Supplier"])
    await denied(`SELECT * FROM ${table} LIMIT 1`);
  await denied("UPDATE Product SET Name = Name");
  await denied("DELETE FROM Orders WHERE 1 = 0");
  await denied("UPDATE Inventory SET Quantity = Quantity");
  const [[menu]] = await db.query("SELECT COUNT(*) AS n FROM Product");
  assert.ok(menu.n > 0, "it can read the menu");
});

test("the real public server, running as that login, serves the menu and takes orders paid and unpaid", async () => {
  const get = (p, h = {}) => fetch(base + p, { headers: { "x-location-id": "loc-campus", ...h } });
  assert.equal((await get("/ready")).status, 200);
  const menu = await (await get("/api/customer/catalog")).json();
  assert.ok(menu.products.length > 0);
  let cookie = "";
  const order = async (extra) => {
    const r = await fetch(base + "/api/customer/orders", { method: "POST", headers: { "content-type": "application/json", "x-location-id": "loc-campus", cookie },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), guestName: "Grant", items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], ...extra }) });
    cookie = (r.headers.getSetCookie().find((c) => c.startsWith("device=")) || "").split(";")[0] || cookie;
    return { status: r.status, body: await r.json() };
  };
  const cash = await order({ paymentMethod: "Cash" });
  assert.equal(cash.status, 200, JSON.stringify(cash.body) + logs.slice(-600));
  const card = await order({ paymentMethod: "Card", card: TEST_CARD });
  assert.equal(card.status, 200, JSON.stringify(card.body) + logs.slice(-600));
  const [[paid]] = await pool.query("SELECT (SELECT COUNT(*) FROM Payment WHERE OrderID = o.OrderID AND PaymentStatusCode = 3) AS payments, OrderStatusCode AS status FROM Orders o WHERE OrderID = ?", [card.body.orderId]);
  assert.deepEqual([paid.payments, paid.status], [1, 2], "the payment and the confirmed status were written");
  const [[moved]] = await pool.query("SELECT COUNT(*) AS n FROM InventoryTransaction WHERE OrderID = ? AND TransactionTypeCode = 2", [cash.body.orderId]);
  assert.ok(moved.n > 0, "the stock rules ran (triggers use their definer's rights)");
  await expireStale(0); // the unpaid one is cancelled and its stock goes back
});
