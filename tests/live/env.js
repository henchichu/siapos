// Starts the real app on a free port against the running dev database (docker compose ... docker-compose.dev.yaml).
const path = require("path");
const root = path.resolve(__dirname, "../..");
process.env.DB_PASSWORD_FILE ??= path.join(root, "sql/secrets/app_user_password.txt");
process.env.MOCK_PAY ??= "1"; // the tests pay with the mock processor's test cards
process.env.GIFTCARD_SECRET_FILE ??= path.join(root, "sql/secrets/giftcard_secret.txt");
const fs = require("fs");
const app = require("../../server/server");
const pool = require("../../server/database/connection");

const kioskApp = require("../../server/kiosk");
// The public order page is its own server (server/kiosk.js), separate from the staff one
const startKiosk = () => new Promise((resolve) => { const s = kioskApp.listen(0, () => resolve({ server: s, base: `http://127.0.0.1:${s.address().port}` })); });
const start = () => new Promise((resolve) => { const s = app.listen(0, () => resolve({ server: s, base: `http://127.0.0.1:${s.address().port}` })); });

// Small client that keeps the session cookie
function client(base, headers = {}) {
  const jar = new Map(); // a browser keeps every cookie it is given (session, device...), not just the last
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const call = async (path, body) => {
    const res = await fetch(base + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", cookie: cookie(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const set of res.headers.getSetCookie()) { const [pair] = set.split(";"); const i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, cookie };
}

// A wrong-PIN test must not leave an account locked for the next run
const unlock = (employeeId) => pool.query("UPDATE EmployeeCredential SET FailedPinAttempts = 0, LockedUntil = NULL WHERE EmployeeID = ?", [employeeId]);

// Hand-over is the kitchen's last step; refunds need a completed order, so tests that refund finish the order directly
const pickUp = (orderNumber) => pool.query("UPDATE Orders SET OrderStatusCode = 5, CompletedAt = UTC_TIMESTAMP() WHERE OrderNumber = ? AND OrderStatusCode = 2", [orderNumber]);

// Products, option groups and promotions made by a test run are removed afterwards, so the demo catalog stays as it was.
// They are removed in dependency order and only by id, never by name.
async function removeCatalog({ products = [], groups = [], promotions = [] }) {
  if (promotions.length) { await pool.query("DELETE FROM PromotionProduct WHERE PromotionID IN (?)", [promotions]); await pool.query("DELETE FROM Promotion WHERE PromotionID IN (?)", [promotions]); }
  if (products.length) {
    await pool.query("DELETE FROM PromotionProduct WHERE ProductID IN (?)", [products]);
    await pool.query("DELETE FROM VariantRecipe WHERE VariantID IN (SELECT VariantID FROM ProductVariant WHERE ProductID IN (?))", [products]);
    await pool.query("DELETE FROM ProductVariant WHERE ProductID IN (?)", [products]);
    await pool.query("DELETE FROM ProductModifierGroup WHERE ProductID IN (?)", [products]);
    await pool.query("DELETE FROM Product WHERE ProductID IN (?)", [products]);
    const dir = path.join(process.env.UPLOAD_DIR || path.join(root, "uploads"), "products"); // their uploaded pictures
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (products.some((p) => f.startsWith(`${p}.`))) fs.rmSync(path.join(dir, f));
  }
  if (groups.length) {
    const mods = "(SELECT ModifierID FROM Modifier WHERE ModifierGroupID IN (?))";
    await pool.query(`DELETE FROM ModifierAddition WHERE ModifierID IN ${mods}`, [groups]);
    await pool.query(`DELETE FROM ModifierSubstitution WHERE ModifierID IN ${mods}`, [groups]);
    await pool.query("DELETE FROM ProductModifierGroup WHERE ModifierGroupID IN (?)", [groups]);
    await pool.query("DELETE FROM Modifier WHERE ModifierGroupID IN (?)", [groups]);
    await pool.query("DELETE FROM ModifierGroup WHERE ModifierGroupID IN (?)", [groups]);
  }
}

// Test sales use up demo stock for good (oat milk goes fastest), so a test that sells it first tops it up at Campus
async function topUp(stockItemId, atLeast, locationId = "loc-campus") {
  const [[row]] = await pool.query("SELECT Quantity AS qty, AverageUnitCost AS cost FROM Inventory WHERE LocationID = ? AND StockItemID = ?", [locationId, stockItemId]);
  if (Number(row.qty) >= atLeast) return;
  await pool.query(
    `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID, QuantityChange, UnitCost, TransactionTypeCode, Note)
     VALUES (UUID(), 'biz-brewbean', ?, ?, 'emp-leo', ?, ?, 1, 'test top-up')`,
    [stockItemId, locationId, atLeast - Number(row.qty), row.cost]);
}

// The mock processor (server/mockpay.js) approves this one; its expiry is far enough ahead not to age out
const TEST_CARD = { number: "4242 4242 4242 4242", expiry: "12/49", cvc: "123" };

// A phone at the Campus café: the page sends the café it was opened for (its QR code) with every call
const phone = (base, locationId = "loc-campus") => client(base, { "x-location-id": locationId });

module.exports = { start, startKiosk, client, phone, pool, unlock, pickUp, removeCatalog, topUp, TEST_CARD };
