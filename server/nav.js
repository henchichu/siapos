const PAGE_PERMISSIONS = { "Needs attention": [14,17,3], Register: [1], Kitchen: [5], Orders: [16], Rewards: [9], Products: [11], Inventory: [14], Reports: [20], "My shift": [] };
const PATHS = { "Needs attention": '/attention.html', Register: '/register.html', Kitchen: '/kitchen.html', 'My shift': '/shift.html' };
// A role that can see Needs attention opens to it; any other role opens to the page its OpensTo names (else its first page)
function access(emp, destinations, granted) {
 const nav = Object.entries(PAGE_PERMISSIONS).filter(([, codes]) => !codes.length || codes.some(c => granted.includes(c))).map(([name]) => name);
 const available = nav.map(n => PATHS[n]).filter(Boolean);
 const own = destinations[emp.OpensTo];
 return { nav, home: nav.includes('Needs attention') ? PATHS['Needs attention'] : available.includes(own) ? own : available[0] || '/shift.html' };
}
module.exports = { access, PAGE_PERMISSIONS };
