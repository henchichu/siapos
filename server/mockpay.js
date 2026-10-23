// A stand-in for a card processor while there is no real one: no money moves, and no card detail is kept or logged.
// Only test card numbers are accepted, so a real card typed into a mock form is refused. Apple Pay and Google Pay always succeed.
const { HttpError } = require("./errors");

// Like a processor's test cards: null approves, anything else is the reason for the decline
const TEST_CARDS = {
  "4242424242424242": null,
  "4000000000000002": "Your card was declined.",
  "4000000000009995": "Your card has insufficient funds.",
  "4000000000000069": "Your card has expired.",
  "4000000000000119": "The card processor had a problem. Try again.",
};
const WALLETS = ["apple", "google"];

// kind: "card", "apple" or "google". Resolves if the payment is approved; throws 400 for bad input, 402 for a decline.
function charge(kind, card = {}) {
  if (WALLETS.includes(kind)) return;
  if (kind !== "card") throw new HttpError(400, "Choose a payment method.");
  const number = String(card.number || "").replace(/[\s-]/g, "");
  const expiry = /^(0[1-9]|1[0-2])\s*\/?\s*(\d{2})$/.exec(String(card.expiry || "").trim());
  if (!/^\d{13,19}$/.test(number)) throw new HttpError(400, "Enter the card number.");
  if (!expiry || Number(`20${expiry[2]}${expiry[1]}`) < new Date().getFullYear() * 100 + new Date().getMonth() + 1) throw new HttpError(400, "Enter a card expiry that hasn't passed, like 12/30.");
  if (!/^\d{3,4}$/.test(String(card.cvc || ""))) throw new HttpError(400, "Enter the card's 3 or 4 digit security code.");
  if (!(number in TEST_CARDS)) throw new HttpError(400, "Test mode: use a test card number, like 4242 4242 4242 4242.");
  if (TEST_CARDS[number]) throw new HttpError(402, TEST_CARDS[number]);
}

module.exports = { charge };
