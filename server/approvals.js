const { HttpError } = require("./errors");

// Call on the caller's transaction so the decision and all trigger effects commit together.
const applyApproval = (conn, session, actionType, targetId, payload = {}, approverId = session.employeeId) => {
  if (typeof targetId !== "string" || !targetId.length || targetId.length > 36) throw new HttpError(409, "That action target could not be found.");
  return conn.query(
    `INSERT INTO ApprovalAction (ApprovalActionID, BusinessID, ActorEmployeeID, ApproverEmployeeID, LocationID, ActionType, TargetID, Payload)
     VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?)`,
    [session.businessId, session.employeeId, approverId, session.locationId, actionType, targetId, JSON.stringify(payload)]
  );
};

module.exports = { applyApproval };