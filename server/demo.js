// DEMO_MODE=1: the front page shows the tour, and its end shows these sign-ins for the dev-seeded shop (sql/dev).
// For demos only: it hands out working passwords and PINs, so it must never be set where real people's accounts exist.
// Sign-in is email + password; the employee number and PIN are what a manager types to approve a discount or refund.
const CREDENTIALS = [
  { name: "Maya", role: "General manager", email: "maya@brewbean.example.com", password: "maya-dev-pass", number: "10420001", pin: "111111" },
  { name: "Leo", role: "Manager", email: "leo@brewbean.example.com", password: "leo-dev-pass", number: "10420002", pin: "222222" },
  { name: "Sam", role: "Server", email: "sam@brewbean.example.com", password: "sam-dev-pass", number: "10420003", pin: "333333" },
  { name: "Priya", role: "Server", email: "priya@brewbean.example.com", password: "priya-dev-pass", number: "10420004", pin: "444444" },
  { name: "Jordan", role: "Chef/barista", email: "jordan@brewbean.example.com", password: "jordan-dev-pass", number: "10420005", pin: "555555" },
  { name: "Ana", role: "Assistant Manager", email: "ana@brewbean.example.com", password: "ana-dev-pass", number: "10420006", pin: "666666" },
];
const on = () => process.env.DEMO_MODE === "1";
module.exports = { CREDENTIALS, on };
