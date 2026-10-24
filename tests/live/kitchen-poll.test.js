// Needs the dev database. An order taken by the public server (another process) reaches an open kitchen screen: the staff
// server looks at the database for cafés with a screen open. The order here is written straight to the database, the way
// another process would, so nothing in this process calls notify().
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { start, client, pool } = require("./env");
const { startPolling } = require("../../server/watchers");

let env, timer;
test.before(async () => { env = await start(); timer = startPolling(pool, 200); });
test.after(async () => { clearInterval(timer); env.server.close(); await pool.end(); });

test("an order placed elsewhere reaches an open kitchen screen without being asked", async () => {
  const leo = client(env.base);
  assert.equal((await leo.call("/login/pin", { employeeNumber: "10420002", pin: "222222" })).status, 200);
  const stop = new AbortController();
  const res = await fetch(`${env.base}/api/kitchen/stream`, { headers: { cookie: leo.cookie() }, signal: stop.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let heard = "";
  const listening = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; heard += Buffer.from(value).toString(); if (heard.includes("data: changed")) return; } })().catch(() => {});
  // the café Leo signed in at: his first active one by name, as sign-in picks it
  const [[{ loc }]] = await pool.query("SELECT l.LocationID AS loc FROM EmployeeLocation el JOIN Location l USING (LocationID) WHERE el.EmployeeID = 'emp-leo' AND el.Active AND l.Active ORDER BY l.Name LIMIT 1");
  await new Promise((r) => setTimeout(r, 500)); // the first look at the café's tickets, so a change can be seen
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO Orders (OrderID, LocationID, BusinessID, ChannelCode, OrderStatusCode) VALUES (?, ?, 'biz-brewbean', 3, 2)", [id, loc]);
  try {
    await Promise.race([listening, new Promise((r) => setTimeout(r, 3000))]);
    assert.ok(heard.includes("data: changed"), `the screen was told: ${JSON.stringify(heard)}`);
  } finally { stop.abort(); await pool.query("DELETE FROM Orders WHERE OrderID = ?", [id]); }
});
