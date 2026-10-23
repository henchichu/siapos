const assert=require('node:assert/strict');
(async()=>{
const base='http://localhost:3000';
async function login(n,p){const r=await fetch(base+'/api/login/pin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({employeeNumber:n,pin:p})});assert.equal(r.status,200,await r.clone().text());return r.headers.get('set-cookie').split(';')[0];}
const cookie=await login('10420001','111111');
const get=async path=>{const r=await fetch(base+'/api'+path,{headers:{cookie}});assert.equal(r.status,200,await r.clone().text());return r.json();};
const general=await get('/settings/general');assert(general.locations.length);const roles=await get('/settings/roles');assert.equal(roles.permissions.length,22);assert((await get('/session')).nav.includes('Settings'));
const post=async(body,c=cookie)=>fetch(base+'/api/settings/roles',{method:'POST',headers:{cookie:c,'content-type':'application/json'},body:JSON.stringify(body)});
const owner=roles.roles.find(r=>r.owner);assert.equal((await post({...owner,active:true})).status,400);
assert.equal((await post({name:'invalid',active:true,opensTo:'REGISTER',permissions:[]})).status,400);
const server=await login('10420003','333333');assert.equal((await fetch(base+'/api/settings/general',{headers:{cookie:server}})).status,403);assert.equal((await post({name:'unauthorized',active:true,opensTo:'SHIFT',permissions:[]},server)).status,403);
assert.equal((await fetch(base+'/settings.html',{headers:{cookie}})).status,200);
console.log('PASS Settings reads, 22 permissions, owner lock, landing validation, unauthorized access, page serving');
})().catch(e=>{console.error(e);process.exit(1)});
