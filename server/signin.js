// Starts a staff session for an employee whose PIN has been checked (or who has just created their business): the same café
// check and the same menu for every way in. Gives back an error message, or null once signed in.
const pool = require("./database/connection");
const { workplace, grantedCodes } = require("./pin");
const session = require("./session");
const { access } = require("./nav");

const DESTINATIONS = { REGISTER: "/register.html", KITCHEN: "/kitchen.html", SHIFT: "/shift.html" };
const NO_CAFE = "You aren't assigned to a café. Ask an owner to add you to one.";

async function signInAs(res, emp) {
  const place = await workplace(emp.EmployeeID);
  if (!place) return NO_CAFE;
  const granted = await grantedCodes(pool, emp.EmployeeID);
  const { nav, tiles, home } = access(emp, DESTINATIONS, granted);
  session.create(res, {
    employeeId: emp.EmployeeID,
    businessId: emp.BusinessID,
    locationId: place.LocationID,
    registerId: place.RegisterID,
    info: {
      employeeName: `${emp.FirstName} ${emp.LastName}`,
      roleName: emp.RoleName,
      nav,
      tiles,
      home,
      locationName: place.LocationName,
      registerName: place.RegisterName,
    },
  });
  return null;
}

module.exports = { signInAs, DESTINATIONS };
