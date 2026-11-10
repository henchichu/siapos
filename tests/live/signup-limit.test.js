// Needs the dev database. Sign-up is limited to 5 tries an hour from one address (a try that is refused counts too), and an
// address that keeps going is refused everywhere for a while. Its own file: the limit is per process, and no test scaling here.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool } = require("./env");

test("the sixth sign-up try in an hour is refused, whatever it says", async () => {
  const env = await start();
  try {
    const c = client(env.base);
    for (let i = 0; i < 5; i++) assert.equal((await c.call("/signup", { firstName: "", email: "x", password: "" })).status, 400);
    const sixth = await c.call("/signup", { firstName: "Nia", email: `late-${Date.now()}@example.com`, password: "a-long-pass-1", confirm: "a-long-pass-1" });
    assert.equal(sixth.status, 429);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM Customer WHERE FirstName = 'Nia' AND Email LIKE 'late-%'");
    assert.equal(n, 0, "and nothing was created");
  } finally { env.server.close(); await pool.end(); }
});
