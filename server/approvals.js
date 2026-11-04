// A manager's decision (a refund approved or rejected, a timecard approved or rejected, a discount signed) is recorded in
// ApprovalAction. TR_ApprovalAction_AfterInsert only queues it in NotificationQueue; the work is JavaScript, in a handler that the
// module owning that work registers here (refunds.js, shift.js, register.js).
//
// approve() records, queues and carries out a decision on the caller's own transaction, so the decision and everything it does
// commit together, and a refusal rolls all of it back. The timer in startWorker() carries out any decision still Pending, such as
// one recorded by hand in SQL: those are marked Failed with the reason instead.
const crypto = require("crypto");
const pool = require("./database/connection");
const { HttpError } = require("./errors");

const handlers = {}; // ActionType -> async (conn, action) => result, where action = { id, type, businessId, actorId, approverId, locationId, targetId, payload }

async function run(conn, row) {
  const handler = handlers[row.ActionType];
  if (!handler) throw new HttpError(409, "Unknown approval action.");
  const result = await handler(conn, { id: row.EntityID, type: row.ActionType, ...row.NewData });
  await conn.query("UPDATE NotificationQueue SET Status = 'Done', ProcessedAt = UTC_TIMESTAMP() WHERE NotificationID = ?", [row.NotificationID]);
  return result;
}

async function approve(conn, session, actionType, targetId, payload = {}, approverId = session.employeeId) {
  if (typeof targetId !== "string" || !targetId.length || targetId.length > 36) throw new HttpError(409, "That action target could not be found.");
  const id = crypto.randomUUID();
  await conn.query(
    `INSERT INTO ApprovalAction (ApprovalActionID, BusinessID, ActorEmployeeID, ApproverEmployeeID, LocationID, ActionType, TargetID, Payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, session.businessId, session.employeeId, approverId, session.locationId, actionType, targetId, JSON.stringify(payload)]
  );
  const [[row]] = await conn.query("SELECT * FROM NotificationQueue WHERE EntityName = 'ApprovalAction' AND EntityID = ? FOR UPDATE", [id]);
  return run(conn, row);
}

async function sweep() {
  await pool.tx(async (conn) => {
    const [rows] = await conn.query(
      "SELECT * FROM NotificationQueue WHERE Status = 'Pending' AND EntityName = 'ApprovalAction' ORDER BY NotificationID LIMIT 20 FOR UPDATE SKIP LOCKED"
    );
    for (const row of rows) {
      await conn.query("SAVEPOINT item");
      try { await run(conn, row); } catch (err) {
        await conn.query("ROLLBACK TO SAVEPOINT item");
        await conn.query("UPDATE NotificationQueue SET Status = 'Failed', Error = ?, ProcessedAt = UTC_TIMESTAMP() WHERE NotificationID = ?",
          [String(err.message).slice(0, 255), row.NotificationID]);
      }
    }
  });
}
const startWorker = (ms = 5000) => setInterval(() => sweep().catch((err) => console.error("approval worker failed:", err.message)), ms).unref();

module.exports = { approve, handlers, sweep, startWorker };
