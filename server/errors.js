class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The last stop for every route: a status the code set, a rule the database enforces, or an unexpected failure
function handleErrors(err, req, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  // a rule the database enforces itself (SQLSTATE 45000): its message is written for people
  if (err.sqlState === "45000") return res.status(409).json({ error: err.sqlMessage });
  if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "That name or SKU is already in use." });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}

module.exports = { HttpError, handleErrors };
