const test = require("node:test");
const assert = require("node:assert/strict");
const session = require("../../server/session");

const MIN = 60 * 1000;
const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });

function signIn() {
  let token;
  session.create({ cookie: (_, t) => { token = t; } }, { employeeId: "e1", info: { nav: [], tiles: [] } });
  return { headers: { cookie: `session=${token}` } };
}
const at = (req, minutes, base = realNow()) => { Date.now = () => base + minutes * MIN; return session.fromRequest(req); };

test("a session ends after 15 idle minutes", () => {
  const req = signIn(), base = realNow(); // base after the sign-in, or the 15th minute can land a millisecond early
  assert.ok(at(req, 14, base));
  assert.equal(at(req, 15, base), null);
  assert.equal(at(req, 1, base), null, "and stays ended");
});

test("an ordinary request doesn't restart the idle clock, a touch does", () => {
  const req = signIn(), base = realNow(); // base after the sign-in, or the 15th minute can land a millisecond early
  for (const m of [5, 10, 14]) at(req, m, base); // e.g. a page polling in the background
  assert.equal(at(req, 15, base), null);

  Date.now = realNow;
  const req2 = signIn();
  at(req2, 10, base).active = base + 10 * MIN; // what POST /session/touch does
  assert.ok(at(req2, 20, base));
  assert.equal(at(req2, 25, base), null);
});
