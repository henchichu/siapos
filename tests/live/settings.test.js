// Needs the dev database. Who may grant which permissions in Settings > Roles, and what a role or location with staff may not do.
// Leo is moved onto a test role that holds Settings (21), Roles (22) and Register (1), then back.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool } = require("./env");

let env, leoRole, mine, owner, leo;
const signIn = async (number, pin) => { const c = client(env.base); assert.equal((await c.call("/login/pin", { employeeNumber: number, pin })).status, 200); return c; };
const role = (over) => ({ name: "Test role", opensTo: "SHIFT", active: true, permissions: [1], ...over });
const roleId = async (name) => (await pool.query("SELECT RoleID AS id FROM Role WHERE Name = ? AND BusinessID = 'biz-brewbean'", [name]))[0][0]?.id;

test.before(async () => {
  env = await start();
  [[{ leoRole }]] = await pool.query("SELECT RoleID AS leoRole FROM Employee WHERE EmployeeID = 'emp-leo'");
  owner = await signIn("10420001", "111111");
  assert.equal((await owner.call("/settings/roles", role({ name: "Test settings manager", permissions: [1, 21, 22] }))).status, 200);
  mine = await roleId("Test settings manager");
  await pool.query("UPDATE Employee SET RoleID = ? WHERE EmployeeID = 'emp-leo'", [mine]);
  leo = await signIn("10420002", "222222");
});
test.after(async () => {
  await pool.query("UPDATE Employee SET RoleID = ? WHERE EmployeeID = 'emp-leo'", [leoRole]);
  const ids = (await pool.query("SELECT RoleID FROM Role WHERE Name LIKE 'Test %' AND BusinessID = 'biz-brewbean'"))[0].map((r) => r.RoleID);
  if (ids.length) { await pool.query("DELETE FROM RolePermission WHERE RoleID IN (?)", [ids]); await pool.query("DELETE FROM Role WHERE RoleID IN (?)", [ids]); }
  env.server.close();
  await pool.end();
});

test("someone who isn't an owner can't grant Staff or Roles management, nor edit a role that has them", async () => {
  const grant = await leo.call("/settings/roles", role({ name: "Test grants staff", permissions: [1, 19] }));
  assert.deepEqual([grant.status, grant.body.error], [400, "Only an owner can grant staff or role management."]);
  const own = await leo.call("/settings/roles", role({ id: mine, name: "Test settings manager", permissions: [1, 21, 22] }));
  assert.deepEqual([own.status, own.body.error], [400, "Only an owner can edit staff or role management roles."]);
  assert.equal(await roleId("Test grants staff"), undefined, "nothing was saved");
});

test("a non-owner may only grant permissions they hold", async () => {
  const over = await leo.call("/settings/roles", role({ name: "Test too much", permissions: [1, 20] }));
  assert.deepEqual([over.status, over.body.error], [400, "You can only grant permissions you hold."]);
  assert.equal((await leo.call("/settings/roles", role({ name: "Test within reach", permissions: [1, 21] }))).status, 200);
});

test("the Owner role is locked, and a role with active staff can't be switched off", async () => {
  const [[{ id }]] = await pool.query("SELECT RoleID AS id FROM Role WHERE IsOwner AND BusinessID = 'biz-brewbean'");
  const locked = await owner.call("/settings/roles", role({ id, name: "Owner", permissions: [1] }));
  assert.deepEqual([locked.status, locked.body.error], [400, "The Owner role is locked."]);
  const off = await owner.call("/settings/roles", role({ id: mine, name: "Test settings manager", permissions: [1, 21, 22], active: false }));
  assert.deepEqual([off.status, off.body.error], [400, "Reassign active staff before deactivating this role."]);
});

test("a role change signs out the people on it", async () => {
  assert.equal((await leo.call("/session")).status, 200);
  assert.equal((await owner.call("/settings/roles", role({ id: mine, name: "Test settings manager", permissions: [1, 21, 22] }))).status, 200);
  assert.equal((await leo.call("/session")).status, 401);
});

test("a location with active staff can't be deactivated", async () => {
  const general = (await owner.call("/settings/general")).body;
  const [[{ id }]] = await pool.query("SELECT el.LocationID AS id FROM EmployeeLocation el JOIN Employee e USING (EmployeeID) WHERE el.Active AND e.Active AND e.BusinessID = 'biz-brewbean' LIMIT 1");
  const l = general.locations.find((x) => x.id === id);
  const r = await owner.call("/settings/locations", { ...l, active: false, online: !!l.online });
  assert.deepEqual([r.status, r.body.error], [400, "Reassign active staff before deactivating this location."]);
});
