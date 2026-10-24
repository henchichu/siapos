// The rules for what people type into forms, in one place so every form refuses the same bad data.
// Each check returns the cleaned value or throws a 400 with a message to show. A form that lists all its problems at once
// wraps each call in collect().
const { HttpError } = require("./errors");

const bad = (message) => { throw new HttpError(400, message); };
const text = (v) => (typeof v === "string" ? v.normalize("NFC") : "");

// Control characters, zero-width and other invisible format characters: never part of anything meant to be read
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MULTILINE_OK = /[^\n\t\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[\n\t]/u;

// Runs a check; on a problem, adds its message to the list and gives back null
function collect(problems, check) {
  try { return check(); } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    problems.push(err.message);
    return null;
  }
}

// A person's name: letters (any language), spaces and . ' - only
function personName(v, label, { required = true, max = 50 } = {}) {
  const s = text(v).trim().replace(/\s+/g, " ");
  if (!s && !required) return "";
  if (!s || s.length > max || !/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(s))
    bad(`Enter a ${label} (letters, spaces, . ' - only, up to ${max} characters).`);
  return s;
}

// A name or heading for something in the business (product, role, supplier...): anything readable, no invisible characters
function label(v, what, max, { required = true } = {}) {
  const s = text(v).trim().replace(/\s+/g, " ");
  if (!s && !required) return "";
  if (!s) bad(`Enter the ${what}.`);
  if (s.length > max) bad(`The ${what} is too long (up to ${max} characters).`);
  if (INVISIBLE.test(s)) bad(`The ${what} has characters that can't be shown. Retype it.`);
  return s;
}

// A note or reason: may run to several lines, but not hold invisible characters
function note(v, what, max, { required = false } = {}) {
  const s = text(v).trim();
  if (!s && !required) return "";
  if (!s) bad(`Enter the ${what}.`);
  if (s.length > max) bad(`The ${what} is too long (up to ${max} characters).`);
  if ([...s].some((c) => !MULTILINE_OK.test(c))) bad(`The ${what} has characters that can't be shown. Retype it.`);
  return s;
}

// A US phone number as its 10 digits, or null. 10 digits, or 11 with a leading 1; neither the area code nor the exchange
// starts with 0 or 1; only digits, spaces and ( ) . + - may be typed.
function phoneDigits(v) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!/^[\d\s().+-]+$/.test(s)) return null;
  const d = s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? d : null;
}
// ...saved as 312-555-0142; empty gives null when allowed
function phone(v, { required = false } = {}) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s && !required) return null;
  const d = phoneDigits(s);
  if (!d) bad("Enter a US phone number with 10 digits, like 312-555-0142.");
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

// An email in lowercase: one @, a dotted domain with no empty parts, a letters-only ending of 2 or more, no spaces
const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
function email(v, { required = false } = {}) {
  const s = text(v).trim().toLowerCase();
  if (!s && !required) return null;
  if (s.length > 254 || s.split("@")[0].length > 64 || !EMAIL.test(s)) bad("Enter a valid email, like name@example.com.");
  return s;
}

// A tip typed at the register, in cents: digits with up to 2 decimals, so "1e2" or "-5" are not read as numbers
function tipCents(v) {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) bad("Enter a valid tip, like 2.50.");
  return Math.round(Number(s) * 100);
}

const giftCode = (v) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(s)) bad("Enter the gift card code: letters, numbers and dashes, 8 or more characters.");
  return s;
};

// A card number's checksum (Luhn): what every real card number passes, and a mistyped digit usually fails
function luhn(number) {
  let sum = 0;
  [...number].reverse().forEach((c, i) => { let n = Number(c); if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; });
  return sum % 10 === 0;
}

// A percentage with at most 4 decimals (the database keeps 6 places of the fraction), between 0 and 100
function percent(v, what) {
  const s = String(v ?? "").trim();
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(s) || Number(s) > 100) bad(`Enter ${what} from 0 to 100, with up to 4 decimals.`);
  return Number(s);
}

const EMPLOYEE_NUMBER = /^\d{8}$/;

module.exports = { collect, personName, label, note, phone, phoneDigits, email, tipCents, giftCode, luhn, percent, EMPLOYEE_NUMBER, INVISIBLE };
