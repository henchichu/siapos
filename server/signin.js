// Starts a staff session for an employee whose PIN has been checked (or who has just created their business): the same café
// check and the same menu for every way in. Gives back { error } with a message, or { home }, the page the role opens to.
const pool = require("./database/connection");
const { workplace, grantedCodes } = require("./pin");
const session = require("./session");
const { access } = require("./nav");

const DESTINATIONS = { REGISTER: "/register.html", KITCHEN: "/kitchen.html", SHIFT: "/shift.html" };
const NO_CAFE = "You aren't assigned to a café. Ask a manager to add you to one.";

async function signInAs(res, emp) {
  const place = await workplace(emp.EmployeeID);
  if (!place) return { error: NO_CAFE };
  const granted = await grantedCodes(pool, emp.EmployeeID);
  const { nav, home } = access(emp, DESTINATIONS, granted);
  session.create(res, {
    employeeId: emp.EmployeeID,
    businessId: emp.BusinessID,
    locationId: place.LocationID,
    registerId: place.RegisterID,
    info: {
      businessName: emp.BusinessName,
      employeeName: `${emp.FirstName} ${emp.LastName}`,
      roleName: emp.RoleName,
      nav,
      home,
      locationName: place.LocationName,
      registerName: place.RegisterName,
    },
  });
  return { home };
}

module.exports = { signInAs, DESTINATIONS };
