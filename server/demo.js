// DEMO_MODE=1: the front page always shows the tour, and its end shows these sign-ins for the dev-seeded shop (sql/dev) instead of
// sending people to sign-up. For demos only: it hands out working PINs, so it must never be set where real people's accounts exist.
const CREDENTIALS = [
  { name: "Maya", role: "Owner", number: "10420001", pin: "111111" },
  { name: "Leo", role: "Manager", number: "10420002", pin: "222222" },
  { name: "Sam", role: "Server", number: "10420003", pin: "333333" },
  { name: "Priya", role: "Server", number: "10420004", pin: "444444" },
  { name: "Jordan", role: "Chef/barista", number: "10420005", pin: "555555" },
  { name: "Ana", role: "Assistant Manager", number: "10420006", pin: "666666" },
];
const on = () => process.env.DEMO_MODE === "1";
module.exports = { CREDENTIALS, on };
