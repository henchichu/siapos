// Overtime: the minutes past 40 hours in one employee's Monday-to-Sunday week, paid at 1.5 times the hourly rate
const WEEK_MINUTES = 40 * 60;
const OVERTIME_RATE = 1.5;

// Shifts in time order, each { employeeId, week (its Monday), minutes }; returns each shift's regular and overtime
// minutes, in the same order. The shift that crosses 40 hours is split.
function splitOvertime(shifts) {
  const weeks = new Map(); // employee|week -> minutes worked before this shift
  return shifts.map((s) => {
    const key = `${s.employeeId}|${s.week}`;
    const before = weeks.get(key) || 0;
    weeks.set(key, before + s.minutes);
    const regular = Math.min(s.minutes, Math.max(0, WEEK_MINUTES - before));
    return { regular, overtime: s.minutes - regular };
  });
}

// Dollars for one shift at an hourly rate
const shiftPay = ({ regular, overtime }, rate) => ((regular + overtime * OVERTIME_RATE) / 60) * rate;

module.exports = { splitOvertime, shiftPay };
