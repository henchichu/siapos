// "PENDING_PAYMENT" -> "Pending payment": how the database's status and method names read on screen
const NAMES = { APPLE_PAY: "Apple Pay", GOOGLE_PAY: "Google Pay" };
const label = (description) => {
  if (NAMES[description]) return NAMES[description];
  const s = description.replace(/_/g, " ").toLowerCase();
  return s[0].toUpperCase() + s.slice(1);
};

module.exports = { label };
