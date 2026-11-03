// Prints the hash of a 6-digit PIN, for the @pin_hash line in provision.sql or an UPDATE EmployeeCredential.
//   node sql/provision/hash-pin.js 246810
const { hashSecret } = require("../../server/auth");
const pin = process.argv[2] || "";
if (!/^\d{6}$/.test(pin)) {
  console.error("Usage: node sql/provision/hash-pin.js <6-digit PIN>");
  process.exit(1);
}
console.log(hashSecret(pin));
