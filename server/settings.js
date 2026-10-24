const router = require('express').Router();
const { randomUUID } = require('crypto');
const pool = require('./database/connection');
const { requirePermission, endSessionsOf } = require('./session');
const { hasPermission, isOwner } = require('./pin');
const { HttpError } = require('./errors');
const bad = message => { throw new HttpError(400, message); };
function text(v, max, required=false) { if (v != null && typeof v !== 'string') bad('Invalid text.'); const s=(v||'').trim(); if(s.length>max || required&&!s) bad(`Enter 1-${max} characters.`); return s; }
function num(v,max,integer=false) { if(v===''||v==null)return null; const n=Number(v); if(!Number.isFinite(n)||n<0||n>max||integer&&!Number.isInteger(n))bad('Invalid number.'); return n; }
function flag(v) { if(typeof v!=='boolean')bad('Invalid checkbox.'); return v; }
async function owned(db,table,key,id,b) { const [[r]]=await db.query(`SELECT * FROM ${table} WHERE ${key}=? AND BusinessID=? FOR UPDATE`,[id,b]); if(!r)throw new HttpError(404,'Record not found.'); return r; }
router.get('/settings/access',async(req,res)=>res.json({general:await hasPermission(pool,req.session.employeeId,21),roles:await hasPermission(pool,req.session.employeeId,22)}));
router.get('/settings/general',requirePermission(21),async(req,res)=>{
 const b=req.session.businessId;
 const [[business]]=await pool.query('SELECT Name AS name, ContactEmail AS email, ContactPhone AS phone, PricesIncludeTax AS includesTax, RefundOverrideAmount AS amount, RefundOverrideDays AS days FROM Business WHERE BusinessID=?',[b]);
 const [categories]=await pool.query('SELECT CategoryID AS id, Name AS name, Active AS active FROM Category WHERE BusinessID=? ORDER BY Name',[b]);
 const [taxes]=await pool.query('SELECT TaxCategoryID AS id, Name AS name FROM TaxCategory WHERE BusinessID=? AND Active ORDER BY Name',[b]);
 const [locations]=await pool.query('SELECT LocationID AS id, Name AS name, Address AS address, Phone AS phone, TimeZone AS timeZone, Active AS active, AcceptsOnlineOrders AS online FROM Location WHERE BusinessID=? ORDER BY Name',[b]);
 for(const l of locations){const [rates]=await pool.query('SELECT TaxCategoryID AS id, Rate AS rate FROM LocationTaxRate WHERE LocationID=?',[l.id]); const [registers]=await pool.query('SELECT RegisterID AS id, Name AS name FROM Register WHERE LocationID=? ORDER BY Name',[l.id]); l.rates=Object.fromEntries(rates.map(r=>[r.id,String(Number(r.rate)*100)])); l.registers=registers;}
 res.json({business,categories,taxes,locations});
});
router.post('/settings/business',requirePermission(21),async(req,res)=>{
 const f=req.body,email=text(f.email,255); if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))bad('Enter a valid email.');
 await pool.query('UPDATE Business SET Name=?, ContactEmail=?, ContactPhone=?, PricesIncludeTax=? WHERE BusinessID=?',[text(f.name,100,true),email,text(f.phone,30),flag(f.includesTax),req.session.businessId]); res.json({message:'Business saved.'});
});
router.post('/settings/refunds',requirePermission(21),async(req,res)=>{
 const amount=num(req.body.amount,99999999.99),days=num(req.body.days,65535,true);
 if(amount!=null&&Math.abs(amount*100-Math.round(amount*100))>0.00001)bad('Use at most two decimal places.');
 await pool.query('UPDATE Business SET RefundOverrideAmount=?, RefundOverrideDays=? WHERE BusinessID=?',[amount,days,req.session.businessId]);res.json({message:'Refund rules saved.'});
});
router.post('/settings/categories',requirePermission(21),async(req,res)=>{
 const f=req.body,b=req.session.businessId,name=text(f.name,100,true);
 await pool.tx(async db=>{if(f.id){await owned(db,'Category','CategoryID',f.id,b);await db.query('UPDATE Category SET Name=?, Active=? WHERE CategoryID=?',[name,flag(f.active),f.id]);}else await db.query('INSERT INTO Category (CategoryID,BusinessID,Name) VALUES (?,?,?)',[randomUUID(),b,name]);});res.json({message:'Category saved.'});
});
router.post('/settings/locations',requirePermission(21),async(req,res)=>{
 const f=req.body,b=req.session.businessId,id=f.id||randomUUID(),name=text(f.name,100,true),address=text(f.address,255),phone=text(f.phone,30),tz=text(f.timeZone,64,true),active=flag(f.active),online=flag(f.online);
 try{new Intl.DateTimeFormat('en',{timeZone:tz}).format();}catch{bad('Enter a valid IANA time zone.');}
 if(!Array.isArray(f.registers)||!f.registers.length)bad('Add at least one register.');
 const regs=f.registers.map(r=>({id:r.id,name:text(r.name,100,true)}));if(new Set(regs.map(r=>r.name.toLowerCase())).size!==regs.length)bad('Register names must be unique.');
 await pool.tx(async db=>{
 if(f.id){await owned(db,'Location','LocationID',id,b);if(!active){const [[r]]=await db.query('SELECT COUNT(*) AS n FROM EmployeeLocation el JOIN Employee e USING (EmployeeID) WHERE el.LocationID=? AND el.Active AND e.Active',[id]);if(r.n)bad('Reassign active staff before deactivating this location.');}await db.query('UPDATE Location SET Name=?,Address=?,Phone=?,TimeZone=?,Active=?,AcceptsOnlineOrders=? WHERE LocationID=?',[name,address,phone,tz,active,online,id]);}
 else{await db.query('INSERT INTO Location (LocationID,BusinessID,Name,Address,Phone,TimeZone,Active,AcceptsOnlineOrders) VALUES (?,?,?,?,?,?,?,?)',[id,b,name,address,phone,tz,active,online]);if(await isOwner(req.session.employeeId))await db.query('INSERT INTO EmployeeLocation (EmployeeID,LocationID,BusinessID,Active) VALUES (?,?,?,TRUE)',[req.session.employeeId,id,b]);}
 const [taxes]=await db.query('SELECT TaxCategoryID AS id FROM TaxCategory WHERE BusinessID=? AND Active',[b]);for(const t of taxes){const rate=num(f.rates?.[t.id],100);if(rate==null)bad('Enter every tax percentage (0 for exempt).');await db.query('INSERT INTO LocationTaxRate (LocationID,TaxCategoryID,BusinessID,Rate) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE Rate=VALUES(Rate)',[id,t.id,b,rate/100]);}
 const [existing]=await db.query('SELECT RegisterID AS id FROM Register WHERE LocationID=?',[id]);if(existing.some(r=>!regs.some(g=>g.id===r.id)))bad('Existing registers cannot be removed here.');
 for(const r of regs){if(r.id){if(!existing.some(g=>g.id===r.id))bad('Invalid register.');await db.query('UPDATE Register SET Name=? WHERE RegisterID=? AND LocationID=?',[r.name,r.id,id]);}else await db.query('INSERT INTO Register (RegisterID,LocationID,Name) VALUES (?,?,?)',[randomUUID(),id,r.name]);}
 });res.json({message:'Location saved. Sign in again to refresh location names.'});
});
router.get('/settings/roles',requirePermission(22),async(req,res)=>{
 const b=req.session.businessId;
 const [permissions]=await pool.query('SELECT PermissionCode AS code,Name AS name,GroupName AS groupName FROM Permission WHERE PermissionCode BETWEEN 1 AND 22 ORDER BY PermissionCode');
 const [roles]=await pool.query('SELECT r.RoleID AS id,r.Name AS name,r.OpensTo AS opensTo,r.IsOwner AS owner,r.Active AS active,(SELECT COUNT(*) FROM Employee e WHERE e.RoleID=r.RoleID AND e.Active) AS staff FROM Role r WHERE r.BusinessID=? ORDER BY r.IsOwner,r.Name',[b]);
 const [grants]=await pool.query('SELECT RoleID AS id,PermissionCode AS code FROM RolePermission WHERE BusinessID=? AND PermissionCode BETWEEN 1 AND 22',[b]);for(const r of roles)r.permissions=grants.filter(g=>g.id===r.id).map(g=>g.code);
 res.json({roles,permissions,owner:await isOwner(req.session.employeeId)});
});
router.post('/settings/roles',requirePermission(22),async(req,res)=>{
 const f=req.body,b=req.session.businessId,id=f.id||randomUUID(),name=text(f.name,50,true),active=flag(f.active);
 if(!Array.isArray(f.permissions)||f.permissions.some(p=>!Number.isInteger(p)||p<1||p>22))bad('Invalid permissions.');const permissions=[...new Set(f.permissions)];
 const destinations={REGISTER:1,KITCHEN:5,SHIFT:null};if(!Object.hasOwn(destinations,f.opensTo)||destinations[f.opensTo]&&!permissions.includes(destinations[f.opensTo]))bad('Choose a landing page this role can access.');
 const owner=await isOwner(req.session.employeeId);
 const affected=await pool.tx(async db=>{
 let old;if(f.id){old=await owned(db,'Role','RoleID',id,b);if(old.IsOwner)bad('The Owner role is locked.');const [[senior]]=await db.query('SELECT COUNT(*) AS n FROM RolePermission WHERE RoleID=? AND PermissionCode IN (19,22)',[id]);if(!owner&&senior.n)bad('Only an owner can edit staff or role management roles.');if(!active){const [[staff]]=await db.query('SELECT COUNT(*) AS n FROM Employee WHERE RoleID=? AND Active',[id]);if(staff.n)bad('Reassign active staff before deactivating this role.');}}
 if(!owner&&permissions.some(p=>p===19||p===22))bad('Only an owner can grant staff or role management.');if(!owner)for(const p of permissions)if(!await hasPermission(db,req.session.employeeId,p))bad('You can only grant permissions you hold.');
 if(old)await db.query('UPDATE Role SET Name=?,OpensTo=?,Active=? WHERE RoleID=?',[name,f.opensTo,active,id]);else await db.query('INSERT INTO Role (RoleID,BusinessID,Name,OpensTo,Active) VALUES (?,?,?,?,?)',[id,b,name,f.opensTo,active]);
 // Only replace the permissions managed by this editor; preserve all others.
 await db.query('DELETE FROM RolePermission WHERE RoleID=? AND PermissionCode BETWEEN 1 AND 22',[id]);for(const p of permissions)await db.query('INSERT INTO RolePermission (RoleID,BusinessID,PermissionCode) VALUES (?,?,?)',[id,b,p]);
 const [staff]=await db.query('SELECT EmployeeID FROM Employee WHERE RoleID=?',[id]);return staff;
 });affected.forEach(s=>endSessionsOf(s.EmployeeID));res.json({message:'Role saved. Affected staff must sign in again.'});
});
module.exports=router;
