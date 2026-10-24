const test=require('node:test');
const assert=require('node:assert/strict');
const {access}=require('../../server/nav');
const destinations={REGISTER:'/register.html',KITCHEN:'/kitchen.html',SHIFT:'/shift.html'};
test('custom names receive permission-based pages',()=>{const a=access({RoleName:'Shift lead',OpensTo:'REGISTER'},destinations,[14]);assert(a.nav.includes('Inventory'));assert(a.nav.includes('Needs attention'));assert(!a.nav.includes('Register'));assert.equal(a.home,'/shift.html');});
test('manager name grants no access',()=>{const a=access({RoleName:'Night manager',OpensTo:'REGISTER'},destinations,[]);assert.deepEqual(a.nav,['My shift']);});
test('settings permissions independently expose Settings',()=>{for(const p of [21,22])assert(access({},destinations,[p]).nav.includes('Settings'));});
test('owner retains all pages and a permitted landing page',()=>{const a=access({IsOwner:true,OpensTo:'KITCHEN'},destinations,[]);assert(a.nav.includes('Settings'));assert(a.nav.includes('Employees'));assert.equal(a.home,'/kitchen.html');});
