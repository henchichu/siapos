const fs = require("fs");
const crypto = require("crypto");
const { HttpError } = require("./errors");

const secret =
  process.env.GIFTCARD_SECRET ||
  (process.env.GIFTCARD_SECRET_FILE && fs.existsSync(process.env.GIFTCARD_SECRET_FILE)
    ? fs.readFileSync(process.env.GIFTCARD_SECRET_FILE, "utf8").trim()
    : "");

// GiftCard.CodeHash holds HMAC-SHA256(secret, code), so a copy of the database can't be used to guess cards
function codeHash(code) {
  if (!secret) throw new HttpError(503, "Gift cards aren't set up on this server.");
  return crypto.createHmac("sha256", secret).update(code).digest();
}

module.exports = { codeHash };
