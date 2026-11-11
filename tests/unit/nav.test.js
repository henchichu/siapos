const test=require('node:test');
const assert=require('node:assert/strict');
const {access}=require('../../server/nav');
const destinations={REGISTER:'/register.html',KITCHEN:'/kitchen.html',SHIFT:'/shift.html'};
test("custom names receive permission-based pages, and Manager's To-Do is first and the landing page",()=>{const a=access({RoleName:'Shift lead',OpensTo:'REGISTER'},destinations,[14]);assert.deepEqual(a.nav,["Manager's To-Do",'Inventory','My shift']);assert.equal(a.home,'/attention.html');});
test('manager name grants no access',()=>{const a=access({RoleName:'Night manager',OpensTo:'REGISTER'},destinations,[]);assert.deepEqual(a.nav,['My shift']);});
test("a role holding every permission opens every page, landing on Manager's To-Do whatever its OpensTo",()=>{const all=Array.from({length:20},(_,i)=>i+1);const a=access({OpensTo:'KITCHEN'},destinations,all);assert.deepEqual(a.nav,["Manager's To-Do",'Register','Kitchen','Orders','Rewards','Products','Inventory','Reports','My shift']);assert.equal(a.home,'/attention.html');});
test("a role without Manager's To-Do opens to the page its OpensTo names",()=>{assert.equal(access({OpensTo:'REGISTER'},destinations,[1,5,9]).home,'/register.html');assert.equal(access({OpensTo:'KITCHEN'},destinations,[5,6,8]).home,'/kitchen.html');});
test('an OpensTo page the role lacks falls back to its first page',()=>{assert.equal(access({OpensTo:'REGISTER'},destinations,[5]).home,'/kitchen.html');assert.equal(access({OpensTo:'KITCHEN'},destinations,[]).home,'/shift.html');});
