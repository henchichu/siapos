const test=require('node:test');
const assert=require('node:assert/strict');
const {access}=require('../../server/nav');
const destinations={REGISTER:'/register.html',KITCHEN:'/kitchen.html',SHIFT:'/shift.html'};
test('custom names receive permission-based pages',()=>{const a=access({RoleName:'Shift lead',OpensTo:'REGISTER'},destinations,[14]);assert(a.nav.includes('Inventory'));assert(a.nav.includes('Needs attention'));assert(!a.nav.includes('Register'));assert.equal(a.home,'/shift.html');});
test('manager name grants no access',()=>{const a=access({RoleName:'Night manager',OpensTo:'REGISTER'},destinations,[]);assert.deepEqual(a.nav,['My shift']);});
test('a role holding every permission opens every page, landing on its own',()=>{const all=Array.from({length:20},(_,i)=>i+1);const a=access({OpensTo:'KITCHEN'},destinations,all);assert.deepEqual(a.nav,['Register','Kitchen','Needs attention','Orders','Rewards','Products','Inventory','Reports','My shift']);assert.equal(a.home,'/kitchen.html');});
