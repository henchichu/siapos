// Public business sign-up (public/signup.html): one POST creates a business, its owner and first café, all in one transaction,
// and signs the owner in. Mounted before the staff session check, so it needs no sign-in.
const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { hashSecret } = require("./auth");
const { findEmployee } = require("./pin");
const { signInAs } = require("./signin");
const check = require("./validate");
const rateLimit = require("./ratelimit");

const router = express.Router();

// The US zones the form offers (public/js/signup.js), stored as their IANA names
const TIME_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];
const MAX_REGISTERS = 20;
const PAY_PERIODS = 26; // a year of two-week periods; nothing adds more yet
const NUMBER_TRIES = 5;
const dailyCap = () => Number(process.env.SIGNUP_DAILY_CAP) || 50; // new businesses a day, across every address

const bad = (message) => { throw new HttpError(400, message); };

// Each step's checks, in the form's order and with its wording. The first step with problems is the one sent back, with all its
// problems at once, so the page can open that step.
function readSetup(b) {
  const steps = [
    (p) => {
      const f = b.business || {};
      const name = check.collect(p, () => (String(f.name || "").trim() ? check.label(f.name, "business name", 100) : bad("Enter your business name.")));
      const email = check.collect(p, () => check.email(f.email));
      const phone = check.collect(p, () => check.contactPhone(f.phone));
      if (typeof f.includesTax !== "boolean") p.push("Choose whether your menu prices already include tax.");
      return { name, email, phone, includesTax: f.includesTax === true };
    },
    (p) => {
      const f = b.location || {};
      const name = check.collect(p, () => (String(f.name || "").trim() ? check.label(f.name, "location name", 100) : bad("Give your first location a name.")));
      if (!TIME_ZONES.includes(f.timeZone)) p.push("Choose a time zone from the list.");
      const address = check.collect(p, () => check.label(f.address, "address", 255, { required: false })) || null;
      const phone = check.collect(p, () => check.contactPhone(f.phone));
      const list = Array.isArray(f.registers) ? f.registers : [];
      if (!list.length) p.push("Add at least one register.");
      if (list.length > MAX_REGISTERS) p.push(`Add up to ${MAX_REGISTERS} registers here; you can add more later in Settings.`);
      const registers = list.map((r) => check.collect(p, () => (String(r || "").trim() ? check.label(r, "register name", 100) : bad("Give each register a name."))));
      if (new Set(registers.filter(Boolean).map((r) => r.toLowerCase())).size !== registers.filter(Boolean).length) p.push("Each register needs its own name.");
      return { name, timeZone: f.timeZone, address, phone, registers };
    },
    (p) => {
      const f = b.owner || {};
      const firstName = check.collect(p, () => check.personName(f.firstName, "first name"));
      const lastName = check.collect(p, () => check.personName(f.lastName, "last name"));
      const email = check.collect(p, () => check.email(f.email, { required: true }));
      if (!/^\d{6}$/.test(String(f.pin || ""))) p.push("Choose a 6-digit PIN.");
      else if (f.pinConfirm !== f.pin) p.push("The PINs don't match. Type the same 6 digits in both.");
      return { firstName, lastName, email, pin: String(f.pin || "") };
    },
    (p) => { if (b.agreed !== true) p.push("Agree to the terms and privacy policy to create your business."); },
  ];
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const problems = [];
    out.push(steps[i](problems));
    if (problems.length) throw Object.assign(new HttpError(400, problems.join(" ")), { step: i + 1 });
  }
  return { business: out[0], location: out[1], owner: out[2] };
}

// A random 8-digit number (no leading zero, so it can't be read short). Random rather than counting up, because the sign-in
// page shows the first name behind a number. The unique key on EmployeeNumber is the real guard: a clash tries another.
const newNumber = () => String(crypto.randomInt(10000000, 100000000));
const numberTaken = (err) => err.code === "ER_DUP_ENTRY" && /UQ_Employee_EmployeeNumber/.test(err.sqlMessage);

// Sign-up is open to anyone: a few a day from one address, and a modest cap on new businesses overall
const signupLimit = rateLimit(5, 60 * 60 * 1000);
router.resetSetupLimit = () => signupLimit.reset();

router.post("/setup", signupLimit, async (req, res) => {
  let f;
  try { f = readSetup(req.body || {}); } catch (err) {
    if (err.step) return res.status(400).json({ error: err.message, step: err.step });
    throw err;
  }
  const [[today]] = await pool.query("SELECT COUNT(*) AS n FROM Business WHERE CreatedAt > UTC_TIMESTAMP() - INTERVAL 1 DAY");
  if (today.n >= dailyCap()) throw new HttpError(429, "We're setting up a lot of businesses today. Try again tomorrow.");

  const pinHash = hashSecret(f.owner.pin);
  const number = await pool.tx(async (conn) => {
    const businessId = crypto.randomUUID(), roleId = crypto.randomUUID(), locationId = crypto.randomUUID(), employeeId = crypto.randomUUID();
    await conn.query("INSERT INTO Business (BusinessID, Name, ContactEmail, ContactPhone, PricesIncludeTax) VALUES (?, ?, ?, ?, ?)",
      [businessId, f.business.name, f.business.email, f.business.phone, f.business.includesTax]);
    // The owner role holds every permission through IsOwner alone, like the demo data's; Settings shows it locked
    await conn.query("INSERT INTO Role (RoleID, BusinessID, Name, OpensTo, IsOwner) VALUES (?, ?, 'Owner', 'REGISTER', TRUE)", [roleId, businessId]);
    await conn.query("INSERT INTO Location (LocationID, BusinessID, Name, Address, Phone, TimeZone) VALUES (?, ?, ?, ?, ?, ?)",
      [locationId, businessId, f.location.name, f.location.address, f.location.phone, f.location.timeZone]);
    for (const name of f.location.registers)
      await conn.query("INSERT INTO Register (RegisterID, LocationID, Name) VALUES (?, ?, ?)", [crypto.randomUUID(), locationId, name]);
    // Tax categories with no rates: sales are refused until the owner sets this café's rates in Settings
    for (const name of ["Standard", "Exempt"])
      await conn.query("INSERT INTO TaxCategory (TaxCategoryID, BusinessID, Name) VALUES (?, ?, ?)", [crypto.randomUUID(), businessId, name]);

    let number;
    for (let tries = 1; !number; tries++) {
      const candidate = newNumber();
      try {
        await conn.query("INSERT INTO Employee (EmployeeID, BusinessID, FirstName, LastName, Email, EmployeeNumber, RoleID) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [employeeId, businessId, f.owner.firstName, f.owner.lastName, f.owner.email, candidate, roleId]);
        number = candidate;
      } catch (err) {
        if (!numberTaken(err) || tries === NUMBER_TRIES) throw err; // a failed insert undoes only itself
      }
    }
    await conn.query("INSERT INTO EmployeeCredential (EmployeeID, PinHash) VALUES (?, ?)", [employeeId, pinHash]);
    await conn.query("INSERT INTO EmployeeLocation (EmployeeID, LocationID, BusinessID) VALUES (?, ?, ?)", [employeeId, locationId, businessId]);

    // Two-week pay periods from today, the café's own date, so clock-in works on day one
    const [[{ start }]] = await conn.query("SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%Y-%m-%d') AS start", [f.location.timeZone]);
    for (let i = 0; i < PAY_PERIODS; i++)
      await conn.query("INSERT INTO PayPeriod (PayPeriodID, BusinessID, StartDate, EndDate) VALUES (?, ?, ? + INTERVAL ? DAY, ? + INTERVAL ? DAY)",
        [crypto.randomUUID(), businessId, start, i * 14, start, i * 14 + 13]);
    await conn.query("INSERT INTO MembershipTier (TierID, BusinessID, Name, MinimumPoints) VALUES (?, ?, 'Bean', 0)", [crypto.randomUUID(), businessId]);
    return number;
  });

  // Signed straight in, through the same café check as the sign-in page
  const refused = await signInAs(res, await findEmployee(pool, number));
  if (refused) throw new HttpError(403, refused);
  res.json({ employeeNumber: number, firstName: f.owner.firstName, businessName: f.business.name, redirect: "/home.html" });
});

router.TIME_ZONES = TIME_ZONES;
module.exports = router;
