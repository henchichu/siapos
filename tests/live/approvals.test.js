const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool, admin, start, client, creds } = require("./env");
let env;
const { applyApproval } = require("../../server/approvals");
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
    await admin.query("DELETE FROM ApprovalAction WHERE TargetID IN (?)", [cards]);
    await admin.query("DELETE FROM TimeEntry WHERE TimeEntryID IN (?)", [cards]);
  }
  await admin.query("DELETE FROM PayPeriod WHERE PayPeriodID = ?", [period]);
  env.server.close(); await pool.end(); await admin.end();
});

test("approval-only writes cannot bypass the action trigger", async () => {
  const id = await card();
  for (const sql of [
    "UPDATE TimeEntry SET TimeEntryStatusCode = 3, ApprovedByEmployeeID = 'emp-leo' WHERE TimeEntryID = ?",
    "UPDATE TimeEntry SET UnpaidBreakMinutes = 100 WHERE TimeEntryID = ?",
    "UPDATE PayPeriod SET Closed = TRUE WHERE PayPeriodID = ?",
    "UPDATE Refund SET RefundStatusCode = 2 WHERE RefundID = ?",
    "DELETE FROM ReturnItem WHERE ReturnID = ?",
    "INSERT INTO OrderDiscount (OrderDiscountID) VALUES (?)",
  ]) await assert.rejects(pool.query(sql, [id]), error => ["ER_COLUMNACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR"].includes(error.code));
  assert.equal(await state(id), 2);
});

test("unauthorized and rolled-back decisions leave neither effects nor audit rows", async () => {
  const id = await card();
  await assert.rejects(pool.tx(conn => applyApproval(conn, manager, "TIMECARD_APPROVE", "x".repeat(37))), error => error.status === 409);
  await assert.rejects(pool.tx(conn => applyApproval(conn, cashier, "TIMECARD_APPROVE", id)), error => error.sqlState === "45000");
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
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
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