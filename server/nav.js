const PAGE_PERMISSIONS = { Register: [1], Kitchen: [5], "Needs attention": [14,17,3], Orders: [16], Rewards: [9], Products: [11], Inventory: [14], Reports: [20], Employees: [19], Settings: [21,22], "My shift": [] };
const TILES = ["Inventory","Rewards","Employees","Needs attention","Products","Settings","Kitchen","Orders","Sign out","Reports","Register","My shift"];
function access(emp, destinations, granted) {
 const nav = Object.entries(PAGE_PERMISSIONS).filter(([, codes]) => emp.IsOwner || !codes.length || codes.some(c => granted.includes(c))).map(([name]) => name);
 const paths = { Register: '/register.html', Kitchen: '/kitchen.html', 'My shift': '/shift.html' };
 const available = nav.map(n => paths[n]).filter(Boolean);
 return { nav, tiles: TILES.filter(n => n === 'Sign out' || nav.includes(n)), home: available.includes(destinations[emp.OpensTo]) ? destinations[emp.OpensTo] : available[0] || '/shift.html' };
}
module.exports = { access, PAGE_PERMISSIONS };
