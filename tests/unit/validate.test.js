const test = require("node:test");
const assert = require("node:assert/strict");
const v = require("../../server/validate");

const fails = (fn) => assert.throws(fn, (e) => e.status === 400 || e.statusCode === 400);

test("phone: real US numbers only, saved as 312-555-0142", () => {
  for (const ok of ["312-555-0142", "(312) 555-0142", "3125550142", "+1 312 555 0142", "1.312.555.0142"]) assert.equal(v.phone(ok), "312-555-0142", ok);
  for (const no of ["abc", "123", "000-000-0000", "123-123-1234", "(312) 055-0142", "99999 312 555 0142", "21 312 555 0142", "312-555-0142 ext 5", "312/555/0142"]) fails(() => v.phone(no));
  assert.equal(v.phone(""), null);
  assert.equal(v.phone("  "), null);
  fails(() => v.phone("", { required: true }));
  assert.equal(v.phoneDigits("(312) 555-0142"), "3125550142");
  assert.equal(v.phoneDigits("x"), null);
});

test("email: strict shape, lowercased", () => {
  assert.equal(v.email(" Name.Last+tag@Example.COM "), "name.last+tag@example.com");
  for (const no of ["a@b.c", "a@@b.com", "a@b..com", "a b@c.com", ".a@b.com", "a.@b.com", "a@-b.com", "a@b.com.", "plain", "a@b", `${"x".repeat(65)}@b.com`, `a@${"x".repeat(250)}.com`]) fails(() => v.email(no));
  assert.equal(v.email(""), null);
  fails(() => v.email("", { required: true }));
});

test("person names: letters, spaces and . ' - only", () => {
  assert.equal(v.personName("  Mary   Anne ", "first name"), "Mary Anne");
  for (const ok of ["José", "O'Brien", "Anne-Marie", "St. John", "李"]) assert.equal(v.personName(ok, "first name"), ok);
  for (const no of ["", "123", "<b>x</b>", "Pat 🙂", "Pat2", "-Pat", "a".repeat(51), "zero​width"]) fails(() => v.personName(no, "first name"));
  assert.equal(v.personName("", "last name", { required: false }), "");
});

test("labels and notes: no invisible characters, and a clear error when too long", () => {
  assert.equal(v.label("  Chef  /  barista ", "role name", 50), "Chef / barista");
  fails(() => v.label("a​b", "name", 50));
  fails(() => v.label("a\u0007b", "name", 50));
  fails(() => v.label("x".repeat(51), "name", 50));
  fails(() => v.label("  ", "name", 50));
  assert.equal(v.label("", "address", 255, { required: false }), "");
  assert.equal(v.note("line one\nline two", "note", 255), "line one\nline two");
  fails(() => v.note("bad\u0000note", "note", 255));
  fails(() => v.note("x".repeat(256), "note", 255));
  fails(() => v.note("", "reason", 255, { required: true }));
});

test("tip, gift code, card checksum, percent", () => {
  assert.deepEqual(["", "0", "2.5", "2.50", "100"].map(v.tipCents), [0, 0, 250, 250, 10000]);
  for (const no of ["1e2", "-5", "2.555", "abc", "1,5", "123456"]) fails(() => v.tipCents(no));
  assert.equal(v.giftCode(" dev-seed-card-0001 "), "dev-seed-card-0001");
  for (const no of ["", "short", "has space in it", "bad!chars-123"]) fails(() => v.giftCode(no));
  assert.equal(v.luhn("4242424242424242"), true);
  assert.equal(v.luhn("4242424242424241"), false);
  assert.deepEqual(["0", "8.25", "100", "0.0001"].map((x) => v.percent(x, "a tax")), [0, 8.25, 100, 0.0001]);
  for (const no of ["", "-1", "100.01", "8.12345", "abc", "1e1"]) fails(() => v.percent(no, "a tax"));
});

test("collect lists every problem and rethrows anything else", () => {
  const problems = [];
  assert.equal(v.collect(problems, () => v.phone("x")), null);
  assert.equal(v.collect(problems, () => v.email("y")), null);
  assert.equal(v.collect(problems, () => v.email("a@b.com")), "a@b.com");
  assert.equal(problems.length, 2);
  assert.throws(() => v.collect(problems, () => { throw new TypeError("bug"); }), TypeError);
});
