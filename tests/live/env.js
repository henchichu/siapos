// Starts the real app on a free port against the running dev database (docker compose ... docker-compose.dev.yaml).
const path = require("path");
const root = path.resolve(__dirname, "../..");
process.env.DB_PASSWORD_FILE ??= path.join(root, "sql/secrets/app_user_password.txt");
process.env.GIFTCARD_SECRET_FILE ??= path.join(root, "sql/secrets/giftcard_secret.txt");
const fs = require("fs");
const app = require("../../server/server");
const pool = require("../../server/database/connection");

const start = () => new Promise((resolve) => { const s = app.listen(0, () => resolve({ server: s, base: `http://127.0.0.1:${s.address().port}` })); });

// Small client that keeps the session cookie
function client(base) {
  let cookie = "";
  const call = async (path, body) => {
    const res = await fetch(base + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, cookie: () => cookie };
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

module.exports = { start, client, pool, unlock, pickUp, removeCatalog };
