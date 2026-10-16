// Starts the real app on a free port against the running dev database (docker compose ... docker-compose.dev.yaml).
const path = require("path");
const root = path.resolve(__dirname, "../..");
process.env.DB_PASSWORD_FILE ??= path.join(root, "sql/secrets/app_user_password.txt");
process.env.GIFTCARD_SECRET_FILE ??= path.join(root, "sql/secrets/giftcard_secret.txt");
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

module.exports = { start, client, pool, unlock };
