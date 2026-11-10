const test = require("node:test");
const assert = require("node:assert/strict");
const { charge } = require("../../server/mockpay");

const GOOD = { number: "4242 4242 4242 4242", expiry: "12/49", cvc: "123" };
const fails = (kind, card, status, message) => assert.throws(() => charge(kind, card), (e) => e.status === status && message.test(e.message));

test("the test card and the wallets are approved", () => {
  charge("card", GOOD);
  charge("card", { ...GOOD, number: "4242-4242-4242-4242", expiry: "12 / 49" });
  charge("apple");
  charge("google");
});

test("test cards decline with a reason, as a 402", () => {
  fails("card", { ...GOOD, number: "4000 0000 0000 0002" }, 402, /declined/);
  fails("card", { ...GOOD, number: "4000000000009995" }, 402, /insufficient funds/);
});

test("anything that isn't a test card is refused, so a real card isn't taken", () => {
  fails("card", { ...GOOD, number: "5555 5555 5555 4444" }, 400, /test card number/);
});

test("bad details are refused before the card is looked at", () => {
  fails("card", { ...GOOD, number: "42" }, 400, /card number/);
  fails("card", { ...GOOD, expiry: "13/49" }, 400, /expiry/);
  fails("card", { ...GOOD, expiry: "01/20" }, 400, /hasn't passed/);
  fails("card", { ...GOOD, cvc: "12" }, 400, /security code/);
  fails("card", undefined, 400, /card number/);
  fails("cheque", GOOD, 400, /payment method/);
});
