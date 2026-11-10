const pool = require("./database/connection");

// The locations an employee works at: stock, timecards and refunds are only read and changed there
const myLocations = async (employeeId) => {
  const [rows] = await pool.query("SELECT LocationID FROM EmployeeLocation WHERE EmployeeID = ? AND Active", [employeeId]);
  return rows.map((r) => r.LocationID);
};

module.exports = { myLocations };
