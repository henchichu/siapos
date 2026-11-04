const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool, admin, start, client, creds } = require("./env");
let env;
const { approve: applyApproval, sweep } = require("../../server/approvals");
const period = "pp-approval-" + Date.now().toString(36);
const cards = [];
const manager = { businessId: "biz-brewbean", employeeId: "emp-leo", locationId: "loc-downtown" };
const cashier = { ...manager, employeeId: "emp-sam" };
const card = async () => {
  const id = crypto.randomUUID(); cards.push(id);
  await admin.query(`INSERT INTO TimeEntry (TimeEntryID, EmployeeID, BusinessID, LocationID, PayPeriodID, ClockInAt, ClockOutAt, TimeEntryStatusCode)
    VALUES (?, 'emp-sam', 'biz-brewbean', 'loc-downtown', ?, '2020-01-02 14:00:00', '2020-01-02 15:00:00', 2)`, [id, period]);
  return id;
};
const state = async id => (await pool.query("SELECT TimeEntryStatusCode AS status FROM TimeEntry WHERE TimeEntryID = ?", [id]))[0][0].status;
const count = async id => Number((await pool.query("SELECT COUNT(*) AS n FROM ApprovalAction WHERE TargetID = ?", [id]))[0][0].n);

test.before(async () => {
  env = await start();
  await admin.query("INSERT INTO PayPeriod (PayPeriodID, BusinessID, StartDate, EndDate) VALUES (?, 'biz-brewbean', '2020-01-01', '2020-01-14')", [period]);
});
test.after(async () => {
  if (cards.length) {
    await admin.query("DELETE FROM NotificationQueue WHERE EntityName = 'ApprovalAction' AND EntityID IN (SELECT ApprovalActionID FROM ApprovalAction WHERE TargetID IN (?))", [cards]);
    await admin.query("DELETE FROM ApprovalAction WHERE TargetID IN (?)", [cards]);
    await admin.query("DELETE FROM TimeEntry WHERE TimeEntryID IN (?)", [cards]);
  }
  await admin.query("DELETE FROM PayPeriod WHERE PayPeriodID = ?", [period]);
  env.server.close(); await pool.end(); await admin.end();
});

test("a recorded decision is queued by the trigger and marked done once carried out; the record can't be edited", async () => {
  const id = await card();
  await pool.tx((conn) => applyApproval(conn, manager, "TIMECARD_APPROVE", id));
  const [[q]] = await pool.query("SELECT EntityName, ActionType, Status, Error, ProcessedAt, NewData FROM NotificationQueue WHERE EntityID IN (SELECT ApprovalActionID FROM ApprovalAction WHERE TargetID = ?)", [id]);
  assert.deepEqual([q.EntityName, q.ActionType, q.Status, q.Error], ["ApprovalAction", "TIMECARD_APPROVE", "Done", null]);
  assert.ok(q.ProcessedAt);
  assert.deepEqual([q.NewData.actorId, q.NewData.approverId, q.NewData.targetId, q.NewData.locationId], ["emp-leo", "emp-leo", id, "loc-downtown"]);
  for (const sql of [
    "UPDATE ApprovalAction SET ActionType = 'TIMECARD_REJECT' WHERE TargetID = ?",
    "DELETE FROM ApprovalAction WHERE TargetID = ?",
    "UPDATE NotificationQueue SET NewData = '{}' WHERE EntityID IN (SELECT ApprovalActionID FROM ApprovalAction WHERE TargetID = ?)",
    "DELETE FROM NotificationQueue WHERE EntityName = 'ApprovalAction' AND EntityID = ?",
    "INSERT INTO NotificationQueue (EntityName, EntityID, ActionType, NewData) VALUES ('ApprovalAction', ?, 'TIMECARD_APPROVE', '{}')",
  ]) await assert.rejects(pool.query(sql, [id]), (error) => ["ER_COLUMNACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR"].includes(error.code), sql);
});

test("the worker carries out a decision still Pending, and marks one it can't carry out Failed with the reason", async () => {
  const good = await card(), gone = await card();
  await admin.query("UPDATE TimeEntry SET TimeEntryStatusCode = 4 WHERE TimeEntryID = ?", [gone]); // already decided, so a second decision can't apply
  const record = (target) => admin.query(
    `INSERT INTO ApprovalAction (ApprovalActionID, BusinessID, ActorEmployeeID, ApproverEmployeeID, LocationID, ActionType, TargetID, Payload)
     VALUES (UUID(), 'biz-brewbean', 'emp-leo', 'emp-leo', 'loc-downtown', 'TIMECARD_APPROVE', ?, '{}')`, [target]);
  await record(good); await record(gone);
  const status = async (target) => (await pool.query("SELECT Status, Error FROM NotificationQueue WHERE EntityID IN (SELECT ApprovalActionID FROM ApprovalAction WHERE TargetID = ?)", [target]))[0][0];
  assert.equal((await status(good)).Status, "Pending", "queued by the trigger, not yet carried out");
  assert.equal(await state(good), 2);
  await sweep();
  assert.equal(await state(good), 3);
  assert.equal((await status(good)).Status, "Done");
  const failed = await status(gone);
  assert.deepEqual([failed.Status, failed.Error], ["Failed", "That timecard is not waiting for approval."]);
});

test("unauthorized and rolled-back decisions leave neither effects nor audit rows", async () => {
  const id = await card();
  await assert.rejects(pool.tx(conn => applyApproval(conn, manager, "TIMECARD_APPROVE", "x".repeat(37))), error => error.status === 409);
  await assert.rejects(pool.tx(conn => applyApproval(conn, cashier, "TIMECARD_APPROVE", id)), error => error.status === 403);
  assert.equal(await state(id), 2); assert.equal(await count(id), 0);
  await assert.rejects(pool.tx(async conn => {
    await applyApproval(conn, manager, "TIMECARD_APPROVE", id);
    throw new Error("rollback check");
  }), /rollback check/);
  assert.equal(await state(id), 2); assert.equal(await count(id), 0);
});

test("two concurrent decisions apply once and record the authenticated actor", async () => {
  const id = await card();
  const results = await Promise.allSettled([1, 2].map(() => pool.tx(conn => applyApproval(conn, manager, "TIMECARD_APPROVE", id))));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(await state(id), 3); assert.equal(await count(id), 1);
  const [[action]] = await pool.query("SELECT ActorEmployeeID, ApproverEmployeeID, CreatedAt FROM ApprovalAction WHERE TargetID = ?", [id]);
  assert.equal(action.ActorEmployeeID, "emp-leo"); assert.equal(action.ApproverEmployeeID, "emp-leo"); assert(action.CreatedAt);
  await assert.rejects(pool.query("DELETE FROM ApprovalAction WHERE TargetID = ?", [id]));
  await assert.rejects(pool.query("UPDATE ApprovalAction SET ActorEmployeeID = 'emp-sam' WHERE TargetID = ?", [id]));
});
test("discount execution rechecks permission, rolls back a refused sale, and records the signer on retry", async () => {
  const cashierPage = client(env.base);
  assert.equal((await cashierPage.call("/login", creds("10420003"))).status, 200);
  const items = [{ key: "a", variantId: "var-croissant", quantity: 1 }];
  const discount = { applyTo: "order", type: "percent", value: 10, reason: "Complaint" };
  const auth = await cashierPage.call("/register/discount/authorize", { items, discount, managerNumber: "10420002", managerPin: "222222" });
  assert.equal(auth.status, 200);
  const body = { saleId: crypto.randomUUID(), items, discount, approvalToken: auth.body.approvalToken, payment: { method: "cash" } };
  const [[before]] = await pool.query("SELECT COUNT(*) AS n FROM Orders");
  await admin.query("DELETE FROM RolePermission WHERE RoleID = 'role-manager' AND PermissionCode = 4");
  try {
    const denied = await cashierPage.call("/register/orders", body);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal((await pool.query("SELECT COUNT(*) AS n FROM Orders"))[0][0].n, before.n);
  } finally {
    await admin.query("INSERT INTO RolePermission (RoleID, BusinessID, PermissionCode) VALUES ('role-manager', 'biz-brewbean', 4)");
  }
  const done = await cashierPage.call("/register/orders", body);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const [[action]] = await pool.query(`SELECT a.ActorEmployeeID, a.ApproverEmployeeID FROM ApprovalAction a
    JOIN Orders o ON o.OrderID = a.TargetID WHERE o.OrderNumber = ? AND a.ActionType = 'DISCOUNT_APPLY'`, [done.body.orderNumber]);
  assert.equal(action.ActorEmployeeID, "emp-sam"); assert.equal(action.ApproverEmployeeID, "emp-leo");
  const staff = { ...discount, value: 10, reason: "Employee" };
  const unsigned = await cashierPage.call("/register/discount/authorize", { items, discount: staff, employeeNumber: "10420004" });
  assert.equal(unsigned.status, 200);
  const staffSale = await cashierPage.call("/register/orders", { items, discount: staff, approvalToken: unsigned.body.approvalToken, payment: { method: "cash" } });
  assert.equal(staffSale.status, 200, JSON.stringify(staffSale.body));
});