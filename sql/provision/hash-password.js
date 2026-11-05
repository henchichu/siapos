// Prints the hash of a sign-in password (8 characters or more), for provision.sql's @password_hash or an UPDATE EmployeeCredential.
//   node sql/provision/hash-password.js 'a long password'
const { hashSecret } = require("../../server/auth");
const password = process.argv[2] || "";
if (password.length < 8 || password.length > 200) {
  console.error("Usage: node sql/provision/hash-password.js '<password, 8 to 200 characters>'");
  process.exit(1);
}
console.log(hashSecret(password));
