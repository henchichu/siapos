// Overtime is worked out from the shifts, never stored: paid time past 40 hours in a Monday to Sunday week is paid at 1.5x.
// The 40 hours count every shift that week, at any location and in either pay period the week touches.
const WEEK_LIMIT = 40 * 60; // minutes
const OVERTIME_RATE = 1.5;

// The Monday of the week a calendar day (YYYY-MM-DD) falls in
function mondayOf(day) {
  const t = Date.parse(`${day}T00:00:00Z`);
  const sinceMonday = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - sinceMonday * 864e5).toISOString().slice(0, 10);
}

// shifts: [{ employeeId, day, clockInAt, minutes }]. Each comes back with its regular and overtime minutes.
// A week's first 40 hours are regular in clock-in order, so the shift that crosses 40 is split.
function splitOvertime(shifts) {
  const worked = new Map(); // employee and week -> minutes so far
  return [...shifts]
    .sort((a, b) => new Date(a.clockInAt) - new Date(b.clockInAt))
    .map((s) => {
      const key = `${s.employeeId} ${mondayOf(s.day)}`;
      const before = worked.get(key) || 0;
      const regular = Math.max(0, Math.min(s.minutes, WEEK_LIMIT - before));
      worked.set(key, before + s.minutes);
      return { ...s, regular, overtime: s.minutes - regular };
    });
}

// What a shift earns, in cents, at an hourly rate in cents
const shiftPay = ({ regular, overtime }, rateCents) => Math.round(((regular + overtime * OVERTIME_RATE) * rateCents) / 60);

module.exports = { mondayOf, splitOvertime, shiftPay, WEEK_LIMIT, OVERTIME_RATE };
