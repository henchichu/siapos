const test = require("node:test");
const assert = require("node:assert/strict");
const rateLimit = require("../../server/ratelimit");

const res = () => ({ code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json() { return this; } });
// returns the status a request got
const hit = (limit, req) => { const r = res(); let passed = false; limit(req, r, () => { passed = true; }); return passed ? 200 : r.code; };

test("addressOf: IPv4 as is, v4-mapped unwrapped, an IPv6 client counts as its /64", () => {
  const a = (ip) => rateLimit.addressOf({ ip });
  assert.equal(a("203.0.113.9"), "203.0.113.9");
  assert.equal(a("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(a("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), a("2001:db8:1:2::1"));
  assert.notEqual(a("2001:db8:1:2::1"), a("2001:db8:1:3::1"));
  assert.equal(a("::1"), "0000:0000:0000:0000");
});

test("a limit counts per window, then lets requests through again", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const limit = rateLimit(3, 1000);
  const req = { ip: "10.0.0.1" };
  assert.deepEqual([1, 2, 3, 4].map(() => hit(limit, req)), [200, 200, 200, 429]);
  t.mock.timers.tick(1001);
  assert.equal(hit(limit, req), 200);
});

test("phones on one address: the device limit stops one, the others still pass", () => {
  const byAddress = rateLimit(60, 60000), byDevice = rateLimit(2, 60000, { by: "device" });
  const both = (req) => { const a = hit(byAddress, req); return a === 200 ? hit(byDevice, req) : a; };
  const wifi = "198.51.100.7";
  assert.deepEqual([1, 2, 3].map(() => both({ ip: wifi, device: "phone-a" })), [200, 200, 429]);
  assert.equal(both({ ip: wifi, device: "phone-b" }), 200);
  assert.equal(both({ ip: wifi }), 200, "a request with no device cookie counts by address");
});

test("an address over its limit in 3 windows is banned for 15 minutes, and a single overshoot is not", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const limit = rateLimit(1, 1000, { ban: true });
  const req = { ip: "192.0.2.5" };
  const overshoot = () => { hit(limit, req); hit(limit, req); t.mock.timers.tick(1001); };
  overshoot(); overshoot();
  assert.equal(hit(limit, req), 200, "two windows over the limit is only two strikes");
  hit(limit, req); // over again in a third window: the third strike
  t.mock.timers.tick(1001);
  assert.equal(hit(limit, req), 429, "banned: even the first request of a new window is refused");
  t.mock.timers.tick(14 * 60 * 1000);
  assert.equal(hit(limit, req), 429, "still banned");
  t.mock.timers.tick(61 * 1000);
  assert.equal(hit(limit, req), 200, "the ban has ended");
  assert.equal(hit(limit, { ip: "192.0.2.6" }), 200, "another address was never affected");
});

test("a refused request says when to try again", () => {
  const limit = rateLimit(1, 30000);
  const req = { ip: "10.0.0.9" };
  hit(limit, req);
  const r = res();
  limit(req, r, () => {});
  assert.equal(r.code, 429);
  assert.ok(Number(r.headers["Retry-After"]) > 0);
});
