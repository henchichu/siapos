// What each kind of role may open. Decided once at sign-in and kept, frozen, in the session.
const ALL = ["Register", "Kitchen", "Needs attention", "Orders", "Rewards", "Products", "Inventory", "Reports", "Employees", "My shift"];
const SERVER = ["Register", "Kitchen", "Rewards", "Products", "My shift"];
const KITCHEN = ["Kitchen", "My shift"];

// Home dashboard tiles, in the wireframe's order: the role's menu items, plus Sign out for everyone.
// Settings has no menu item, so only full access gets it.
const TILES = ["Inventory", "Rewards", "Employees", "Needs attention", "Products", "Settings", "Kitchen", "Orders", "Sign out", "Reports", "Register", "My shift"];
const tilesFor = (names) => Object.freeze(TILES.filter((t) => t === "Sign out" || names.includes(t)));

// Roles are named by each business, so they are matched by name; anything unrecognised gets the least access
function byRole({ RoleName, IsOwner, OpensTo }, destinations) {
  const name = RoleName.toLowerCase();
  if (IsOwner || name.includes("manager")) return { nav: ALL, tiles: tilesFor(TILES), home: destinations[OpensTo] || "/register.html" };
  if (name.includes("server")) return { nav: SERVER, tiles: tilesFor(SERVER), home: "/register.html" };
  if (/barista|kitchen|chef/.test(name)) return { nav: KITCHEN, tiles: tilesFor(KITCHEN), home: "/kitchen.html" };
  return { nav: ["My shift"], tiles: tilesFor(["My shift"]), home: "/shift.html" };
}

// Reports and Employees follow the permissions, not the role's name: a menu item and tile only for a role that
// may see reports (granted.reports) or manage staff (granted.staff). Owners hold every permission.
function access(emp, destinations, granted) {
  const out = byRole(emp, destinations);
  const keep = (n) => (n !== "Reports" || granted.reports) && (n !== "Employees" || granted.staff);
  return { ...out, nav: out.nav.filter(keep), tiles: Object.freeze(out.tiles.filter(keep)) };
}

module.exports = { access };
