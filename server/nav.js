// What each kind of role may open. Decided once at sign-in and kept, frozen, in the session.
const ALL = ["Register", "Kitchen", "Needs attention", "Orders", "Rewards", "Products", "Inventory", "Reports", "My shift"];
const SERVER = ["Register", "Kitchen", "Rewards", "Products", "My shift"];
const KITCHEN = ["Kitchen", "My shift"];

// Home dashboard tiles, in the wireframe's order: the role's menu items, plus Sign out for everyone.
// Employees and Settings have no menu item, so only full access gets them.
const TILES = ["Inventory", "Rewards", "Employees", "Needs attention", "Products", "Settings", "Kitchen", "Sign out", "Reports", "Register", "My shift"];
const tilesFor = (names) => Object.freeze(TILES.filter((t) => t === "Sign out" || names.includes(t)));

// Roles are named by each business, so they are matched by name; anything unrecognised gets the least access
function access({ RoleName, IsOwner, OpensTo }, destinations) {
  const name = RoleName.toLowerCase();
  if (IsOwner || name.includes("manager")) return { nav: ALL, tiles: tilesFor(TILES), home: destinations[OpensTo] || "/register.html" };
  if (name.includes("server")) return { nav: SERVER, tiles: tilesFor(SERVER), home: "/register.html" };
  if (/barista|kitchen|chef/.test(name)) return { nav: KITCHEN, tiles: tilesFor(KITCHEN), home: "/kitchen.html" };
  return { nav: ["My shift"], tiles: tilesFor(["My shift"]), home: "/shift.html" };
}

module.exports = { access };
