const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { authenticate, hasPermission } = require("./pin");

const DENIED = "Unauthorized. Supervisor or Owner credentials required to override.";

// Returns the approver's EmployeeID, or throws 403. Wrong numbers, wrong PINs, locked accounts and
// roles without any of the permissions all get the same answer, so it reveals nothing.
// Nobody approves their own refund or discount, except an owner (who has no one above them). selfOk: the caller checks that
// itself, because the person signed in isn't the one the approval is about.
async function verifyOverride(session, managerNumber, managerPin, permissionCodes, { selfOk = false } = {}) {
  if (!/^\d{8}$/.test(managerNumber) || !/^\d{6}$/.test(managerPin)) throw new HttpError(403, DENIED);
  // Another business's number is refused before its PIN is tried, so nobody here can run up that person's lockout
  const [[ours]] = await pool.query("SELECT 1 AS ok FROM Employee WHERE EmployeeNumber = ? AND BusinessID = ?", [managerNumber, session.businessId]);
  if (!ours) throw new HttpError(403, DENIED);
  const result = await authenticate(managerNumber, managerPin, session.employeeId);
  if (result.status !== "ok" || result.emp.BusinessID !== session.businessId) throw new HttpError(403, DENIED);
  for (const code of permissionCodes)
    if (await hasPermission(pool, result.emp.EmployeeID, code)) {
      if (!selfOk && !result.emp.IsOwner && result.emp.EmployeeID === session.employeeId) throw new HttpError(403, "Another manager has to approve this: you can't approve your own.");
      return result.emp.EmployeeID;
    }
  throw new HttpError(403, DENIED);
}

// A staff discount needs no manager: it needs the number of a real, active employee of this business
async function findStaff(session, employeeNumber) {
  if (!/^\d{8}$/.test(employeeNumber)) throw new HttpError(400, "Enter the employee's 8-digit number.");
  const [[row]] = await pool.query(
    `SELECT e.EmployeeID FROM Employee e JOIN Role r ON r.RoleID = e.RoleID
      WHERE e.EmployeeNumber = ? AND e.BusinessID = ? AND e.Active AND r.Active`,
    [employeeNumber, session.businessId]
  );
  if (!row) throw new HttpError(400, "Employee Number does not exist.");
  return row.EmployeeID;
}

const staffRules = (businessId) =>
  pool
    .query("SELECT StaffDiscountsNeedApproval AS needs, StaffDiscountMaxPercent AS maxPercent FROM Business WHERE BusinessID = ?", [businessId])
    .then(([[r]]) => ({ needsApproval: !!r.needs, maxPercent: Number(r.maxPercent) }));

module.exports = { verifyOverride, findStaff, staffRules };
