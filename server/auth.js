const crypto = require("crypto");

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(secret, salt, 64).toString("hex")}`;
}

function verifySecret(secret, stored) {
  const [scheme, salt, hash] = (stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(secret, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashSecret, verifySecret };
