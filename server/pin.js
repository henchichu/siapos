const pool = require("./database/connection");
const { verifySecret } = require("./auth");

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const findEmployee = (db, employeeNumber, lock = "") =>
  db
    .query(
      `SELECT e.EmployeeID, e.BusinessID, e.FirstName, e.LastName, b.Name AS BusinessName,
              r.Name AS RoleName, r.OpensTo, r.IsOwner,
              c.PinHash, c.FailedPinAttempts, c.LockedUntil,
              c.LockedUntil > NOW() AS IsLocked
         FROM Employee e
         JOIN Business b USING (BusinessID)
         JOIN Role r USING (RoleID, BusinessID)
         LEFT JOIN EmployeeCredential c USING (EmployeeID)
        WHERE e.EmployeeNumber = ? AND e.Active AND b.Active AND r.Active ${lock}`,
      [employeeNumber]
    )
    .then(([rows]) => rows[0]);

// First active location (by name) and its first working register
async function workplace(employeeId) {
  const [[row]] = await pool.query(
    `SELECT l.LocationID, l.Name AS LocationName, g.RegisterID, g.Name AS RegisterName
       FROM EmployeeLocation el
       JOIN Location l USING (LocationID, BusinessID)
       LEFT JOIN Register g ON g.LocationID = l.LocationID AND g.RegStatusCode = 1
      WHERE el.EmployeeID = ? AND el.Active AND l.Active
      ORDER BY l.Name, g.Name LIMIT 1`,
    [employeeId]
  );
  return row;
}

// Adds one failed try to an account and locks it at the limit. Returns the answer to give back.
async function recordFailure(conn, employeeId) {
  const [[c]] = await conn.query("SELECT FailedPinAttempts AS n FROM EmployeeCredential WHERE EmployeeID = ? FOR UPDATE", [employeeId]);
  const failed = (c?.n || 0) + 1;
  if (failed >= MAX_ATTEMPTS) {
    await conn.query(
      "UPDATE EmployeeCredential SET FailedPinAttempts = 0, LockedUntil = NOW() + INTERVAL ? MINUTE WHERE EmployeeID = ?",
      [LOCK_MINUTES, employeeId]
    );
    const [[{ until }]] = await conn.query("SELECT LockedUntil AS until FROM EmployeeCredential WHERE EmployeeID = ?", [employeeId]);
    return { status: "locked", lockedUntil: until };
  }
  await conn.query("UPDATE EmployeeCredential SET FailedPinAttempts = ? WHERE EmployeeID = ?", [failed, employeeId]);
  return { status: "bad", retriesLeft: MAX_ATTEMPTS - failed };
}

// A correct PIN, a new PIN or an owner's Unlock all start the count again
const clearLockout = (db, employeeId) =>
  db.query("UPDATE EmployeeCredential SET FailedPinAttempts = 0, LockedUntil = NULL WHERE EmployeeID = ?", [employeeId]);

// Checks a PIN and keeps the attempt counter and lockout.
// Sign-in: wrong tries count against that employee. Manager override (payerId = the cashier): wrong tries
// count against the cashier, so nobody can lock a manager out by guessing at their PIN.
// status: ok | missing | locked | bad (with retriesLeft)
const authenticate = (employeeNumber, pin, payerId) =>
  pool.tx(async (conn) => {
    if (payerId) {
      const [[p]] = await conn.query("SELECT LockedUntil > NOW() AS locked, LockedUntil FROM EmployeeCredential WHERE EmployeeID = ? FOR UPDATE", [payerId]);
      if (p?.locked) return { status: "locked", lockedUntil: p.LockedUntil };
    }
    // Locking the credential row serialises concurrent guesses so none escape the attempt counter. Only that row:
    // locking the joined Business and Role rows too made two sign-ins deadlock, and every sign-in wait for every other.
    const emp = await findEmployee(conn, String(employeeNumber), "FOR UPDATE OF c");
    if (emp && !emp.IsLocked && emp.PinHash && verifySecret(String(pin), emp.PinHash)) {
      await clearLockout(conn, emp.EmployeeID);
      return { status: "ok", emp };
    }
    if (payerId) return recordFailure(conn, payerId);
    if (!emp) return { status: "missing" };
    if (emp.IsLocked) return { status: "locked", lockedUntil: emp.LockedUntil };
    return recordFailure(conn, emp.EmployeeID);
  });

// Same rule as the DB's HasPermission() (app_user can't execute routines): the owner role holds everything,
// other roles what RolePermission grants
const hasPermission = (db, employeeId, code) =>
  db
    .query(
      `SELECT EXISTS (SELECT 1 FROM Employee e JOIN Role r ON r.RoleID = e.RoleID
                       WHERE e.EmployeeID = ? AND e.Active AND r.Active
                         AND (r.IsOwner OR EXISTS (SELECT 1 FROM RolePermission rp
                                                    WHERE rp.RoleID = r.RoleID AND rp.PermissionCode = ?))) AS ok`,
      [employeeId, code]
    )
    .then(([[r]]) => !!r.ok);

// Every code 1-22 the person holds, in one query: what sign-in needs to build the menu
const grantedCodes = (db, employeeId) =>
  db
    .query(
      `SELECT p.PermissionCode AS code FROM Permission p
        WHERE p.PermissionCode BETWEEN 1 AND 22
          AND EXISTS (SELECT 1 FROM Employee e JOIN Role r ON r.RoleID = e.RoleID
                       WHERE e.EmployeeID = ? AND e.Active AND r.Active
                         AND (r.IsOwner OR EXISTS (SELECT 1 FROM RolePermission rp WHERE rp.RoleID = r.RoleID AND rp.PermissionCode = p.PermissionCode)))`,
      [employeeId]
    )
    .then(([rows]) => rows.map((r) => r.code));

// Read from the database each time, like hasPermission, so a demoted owner loses it at once
const isOwner = async (employeeId) => {
  const [[row]] = await pool.query("SELECT r.IsOwner AS owner FROM Employee e JOIN Role r ON r.RoleID = e.RoleID WHERE e.EmployeeID = ?", [employeeId]);
  return !!row?.owner;
};

module.exports = { findEmployee, workplace, authenticate, hasPermission, grantedCodes, isOwner, clearLockout };
