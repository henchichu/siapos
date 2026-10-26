// Public business sign-up: 4 steps, then a done screen. Layout from docs/design/ClockIt-registration.pdf.
// Each step is checked here before Continue, with the same rules and wording as the server (server/setup.js), which checks
// everything again and creates the business in one go.
const html = htm.bind(React.createElement);
const { useState, useEffect, useRef } = React;

const STEPS = [["Business", "Name and contact"], ["First location", "Address and registers"], ["Owner account", "Your sign-in and PIN"], ["Review", "Check and create"]];
const TIME_ZONES = [["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"]];
const MAX_REGISTERS = 20;

// ---- the same checks as server/validate.js ----
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const tidy = (v) => String(v || "").normalize("NFC").trim().replace(/\s+/g, " ");
function label(v, what, max, required, empty) {
  const s = tidy(v);
  if (!s) return required ? empty || `Enter the ${what}.` : null;
  if (s.length > max) return `The ${what} is too long (up to ${max} characters).`;
  if (INVISIBLE.test(s)) return `The ${what} has characters that can't be shown. Retype it.`;
  return null;
}
function personName(v, what) {
  const s = tidy(v);
  return !s || s.length > 50 || !/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(s) ? `Enter a ${what} (letters, spaces, . ' - only, up to 50 characters).` : null;
}
function email(v, required) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return required ? "Enter a valid email, like name@example.com." : null;
  return s.length > 254 || s.split("@")[0].length > 64 || !EMAIL.test(s) ? "Enter a valid email, like name@example.com." : null;
}
const usDigits = (s) => {
  if (!/^[\d\s().+-]+$/.test(s)) return null;
  const d = s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? d : null;
};
function contactPhone(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const m = /^(.*?)\s*(?:ext\.?|x)\s*(\d{1,6})$/i.exec(s);
  const number = m ? m[1] : s;
  if (usDigits(number)) return null;
  const digits = number.replace(/\D/g, "");
  if (/^\+[\d\s().-]+$/.test(number) && digits.length >= 7 && digits.length <= 15) return null;
  return "Enter a US phone number like 312-555-0142, or an international one with its country code, like +44 20 7946 0958.";
}

// Each step's problems, in the order the fields appear
const CHECKS = [
  (f) => [label(f.business.name, "business name", 100, true, "Enter your business name."), email(f.business.email), contactPhone(f.business.phone)],
  (f) => {
    const regs = f.location.registers.map(tidy);
    return [label(f.location.name, "location name", 100, true, "Give your first location a name."),
      TIME_ZONES.some(([z]) => z === f.location.timeZone) ? null : "Choose a time zone from the list.",
      label(f.location.address, "address", 255, false), contactPhone(f.location.phone),
      regs.length ? null : "Add at least one register.",
      ...[...new Set(f.location.registers.map((r) => label(r, "register name", 100, true, "Give each register a name.")))],
      new Set(regs.filter(Boolean).map((r) => r.toLowerCase())).size !== regs.filter(Boolean).length ? "Each register needs its own name." : null];
  },
  (f) => [personName(f.owner.firstName, "first name"), personName(f.owner.lastName, "last name"), email(f.owner.email, true),
    !/^\d{6}$/.test(f.owner.pin) ? "Choose a 6-digit PIN." : f.owner.pinConfirm !== f.owner.pin ? "The PINs don't match. Type the same 6 digits in both." : null],
  (f) => [f.agreed ? null : "Agree to the terms and privacy policy to create your business."],
];
const problemsAt = (step, f) => CHECKS[step](f).filter(Boolean);

const Check = () => html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>`;

// ---- the navy side panel ----
function Side({ name, step, done }) {
  return html`<aside className="side">
    <div className="side-top">
      <a className="logo" href="/"><img src="/img/clockit-logo-light.png" alt="ClockIt" width="210" height="53" /></a>
      <p className="eyebrow">Setting up</p>
      <p className="biz" aria-live="polite">${tidy(name) || "Your business"}</p>
      <ol className="steps" aria-label="Steps">
        ${STEPS.map(([title, sub], i) => {
          const state = done || i < step ? "is-done" : i === step ? "is-now" : "is-next";
          return html`<li key=${title} className=${state} aria-current=${state === "is-now" ? "step" : undefined}>
            <span className="num">${state === "is-done" ? html`<${React.Fragment}><${Check} /><span className="sr">Done: </span><//>` : i + 1}</span>
            <span className="words"><b>${title}</b><span>${sub}</span></span></li>`;
        })}
      </ol>
    </div>
    <p className="side-links"><a className="home" href="/">← ClockIt home</a><span>Already set up? <a href="/login.html">Go to staff sign-in</a></span></p>
  </aside>`;
}

// ---- the steps ----
const Field = ({ label: text, optional, children, wide }) => html`<label className=${wide ? "field wide" : "field"}>
  <span className="lbl">${text}${optional && html`<span className="opt">Optional</span>`}</span>${children}</label>`;

function BusinessStep({ f, set }) {
  const b = f.business;
  const choice = (yes, title, sub) => html`<label className=${b.includesTax === yes ? "choice on" : "choice"}>
    <input type="radio" name="includesTax" checked=${b.includesTax === yes} onChange=${() => set("business", { includesTax: yes })} />
    <b>${title}</b><span>${sub}</span></label>`;
  return html`<${React.Fragment}>
    <${Field} label="Business name" wide><input className="input" value=${b.name} maxLength="100" autoComplete="organization" onChange=${(e) => set("business", { name: e.target.value })} /><//>
    <div className="row">
      <${Field} label="Contact email" optional><input className="input" type="email" value=${b.email} autoComplete="email" onChange=${(e) => set("business", { email: e.target.value })} /><//>
      <${Field} label="Contact phone" optional><input className="input" type="tel" value=${b.phone} autoComplete="tel" onChange=${(e) => set("business", { phone: e.target.value })} /><//>
    </div>
    <fieldset className="choices">
      <legend className="lbl">Do your menu prices already include tax?</legend>
      <div className="row">${choice(false, "No, tax is added", "Prices show before tax")}${choice(true, "Yes, tax is included", "Prices already contain tax")}</div>
    </fieldset>
  <//>`;
}

function LocationStep({ f, set }) {
  const l = f.location;
  const regs = l.registers;
  const setReg = (i, v) => set("location", { registers: regs.map((r, j) => (j === i ? v : r)) });
  const added = useRef(false);
  useEffect(() => {
    if (!added.current) return;
    added.current = false;
    document.querySelectorAll(".reg input")[regs.length - 1]?.focus(); // a new register's name box gets the cursor
  }, [regs.length]);
  return html`<${React.Fragment}>
    <p className="sub">You can add more locations later in Settings.</p>
    <div className="row">
      <${Field} label="Location name"><input className="input" value=${l.name} maxLength="100" placeholder="e.g. Downtown" onChange=${(e) => set("location", { name: e.target.value })} /><//>
      <${Field} label="Time zone"><select className="input select" value=${l.timeZone} onChange=${(e) => set("location", { timeZone: e.target.value })}>
        ${TIME_ZONES.map(([z, name]) => html`<option key=${z} value=${z}>${name} (${z})</option>`)}</select><//>
    </div>
    <${Field} label="Address" optional wide><input className="input" value=${l.address} maxLength="255" placeholder="Street, city, state, ZIP" autoComplete="street-address" onChange=${(e) => set("location", { address: e.target.value })} /><//>
    <${Field} label="Location phone" optional wide><input className="input" type="tel" value=${l.phone} onChange=${(e) => set("location", { phone: e.target.value })} /><//>
    <section className="regs" aria-labelledby="regs-title">
      <div className="regs-head">
        <div><h3 id="regs-title">Registers</h3><p>Each checkout counter or tablet. You need at least one.</p></div>
        <button type="button" className="btn primary small" disabled=${regs.length >= MAX_REGISTERS}
          onClick=${() => { added.current = true; set("location", { registers: [...regs, ""] }); }}>+ Add register</button>
      </div>
      <ol>${regs.map((r, i) => html`<li key=${i} className="reg">
        <span className="num" aria-hidden="true">${i + 1}</span>
        <input className="input" value=${r} maxLength="100" aria-label=${`Register ${i + 1} name`} onChange=${(e) => setReg(i, e.target.value)} />
        ${regs.length > 1 ? html`<button type="button" className="btn danger small" aria-label=${`Remove register ${i + 1}${tidy(r) ? `, ${tidy(r)}` : ""}`}
          onClick=${() => set("location", { registers: regs.filter((_, j) => j !== i) })}>Remove</button>` : html`<span className="keep"></span>`}
      </li>`)}</ol>
    </section>
  <//>`;
}

function OwnerStep({ f, set }) {
  const o = f.owner;
  const digits = (v) => v.replace(/\D/g, "").slice(0, 6);
  const match = o.pinConfirm.length === 6 && /^\d{6}$/.test(o.pin) ? (o.pinConfirm === o.pin ? "yes" : "no") : null;
  return html`<${React.Fragment}>
    <div className="row">
      <${Field} label="First name"><input className="input" value=${o.firstName} maxLength="50" autoComplete="given-name" onChange=${(e) => set("owner", { firstName: e.target.value })} /><//>
      <${Field} label="Last name"><input className="input" value=${o.lastName} maxLength="50" autoComplete="family-name" onChange=${(e) => set("owner", { lastName: e.target.value })} /><//>
    </div>
    <${Field} label="Email" wide><input className="input" type="email" value=${o.email} autoComplete="email" onChange=${(e) => set("owner", { email: e.target.value })} /><//>
    <div className="note"><b>Your employee number</b><span>You'll get your 8-digit employee number when you finish. Use it to sign in at the register.</span></div>
    <div className="row">
      <${Field} label="Choose a 6-digit PIN"><input className="input pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength="6" value=${o.pin}
        onChange=${(e) => set("owner", { pin: digits(e.target.value) })} /><//>
      <${Field} label="Confirm PIN"><input className="input pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength="6" value=${o.pinConfirm}
        onChange=${(e) => set("owner", { pinConfirm: digits(e.target.value) })} /><//>
    </div>
    <div className="pinline">
      <span className="dots" aria-hidden="true">${Array.from({ length: 6 }, (_, i) => html`<i key=${i} className=${i < o.pin.length ? "on" : ""}></i>`)}</span>
      <span className=${match === "no" ? "match bad" : "match"} aria-live="polite">${match === "yes" ? "PINs match" : match === "no" ? "PINs don't match" : `${o.pin.length} of 6 digits`}</span>
    </div>
  <//>`;
}

function ReviewStep({ f, set, go }) {
  const zone = TIME_ZONES.find(([z]) => z === f.location.timeZone)?.[0] || f.location.timeZone;
  const rows = [
    ["Business", `${tidy(f.business.name)} · ${f.business.includesTax ? "tax included in prices" : "tax added at checkout"}`, 0],
    ["First location", `${tidy(f.location.name)} · ${zone}`, 1],
    ["Registers", f.location.registers.map(tidy).join(", "), 1],
    ["Owner", `${tidy(f.owner.firstName)} ${tidy(f.owner.lastName)} · ${f.owner.email.trim().toLowerCase()}`, 2],
  ];
  return html`<${React.Fragment}>
    <dl className="review">${rows.map(([what, value, step]) => html`<div key=${what}>
      <dt>${what}</dt><dd>${value}</dd>
      <dd className="edit"><button type="button" className="link" onClick=${() => go(step)} aria-label=${`Edit ${what.toLowerCase()}`}>Edit</button></dd></div>`)}</dl>
    <label className="agree"><input type="checkbox" checked=${f.agreed} onChange=${(e) => set("agreed", e.target.checked)} />
      <span>I agree to the <a href="#">[terms]</a> and <a href="#">[privacy policy]</a></span></label>
  <//>`;
}

// ---- the done screen ----
const NEXT = [
  ["Settings → Roles", "create roles like Manager and Barista"],
  ["Settings → General", "set tax rates when you edit your location"],
  ["Employees", "add your staff with their PINs and pay"],
  ["Products", "add your menu, sizes and prices"],
  ["Inventory", "add stock items and suppliers"],
  ["Settings → General", "set refund rules and categories"],
];
function Done({ result }) {
  const title = useRef();
  useEffect(() => title.current?.focus(), []);
  return html`<div className="done">
    <span className="bigcheck"><${Check} /></span>
    <h1 ref=${title} tabIndex="-1">You're all set, ${result.firstName}!</h1>
    <p className="number"><span>Sign in with employee number</span><b>${result.employeeNumber}</b></p>
    <section className="next" aria-labelledby="next-title">
      <h2 id="next-title">Next, inside ClockIt</h2>
      <ul>${NEXT.map(([where, what], i) => html`<li key=${i}><b>${where}</b> · ${what}</li>`)}</ul>
    </section>
    <a className="btn primary" href=${result.redirect}>Open ClockIt</a>
  </div>`;
}

// ---- the page ----
const BLANK = {
  business: { name: "", email: "", phone: "", includesTax: false },
  location: { name: "", timeZone: "America/Chicago", address: "", phone: "", registers: ["Front counter"] },
  owner: { firstName: "", lastName: "", email: "", pin: "", pinConfirm: "" },
  agreed: false,
};

function App() {
  const [f, setF] = useState(BLANK);
  const [step, setStep] = useState(0);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const heading = useRef();
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } heading.current?.focus(); }, [step]); // a new step is announced
  useEffect(() => { document.title = result ? "You're all set · ClockIt" : `Step ${step + 1} of 4: ${STEPS[step][0]} · Set up ClockIt`; }, [step, result]);

  const set = (part, value) => { setMsg(""); setF((old) => ({ ...old, [part]: typeof value === "object" && !Array.isArray(value) ? { ...old[part], ...value } : value })); };
  const go = (to) => { setMsg(""); setStep(to); };

  const create = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setResult(data); return; }
      if (data.step) setStep(data.step - 1); // the step the problem is on
      setMsg(data.error || "Something went wrong. Try again.");
    } catch (err) {
      setMsg("Can't reach the server. Try again.");
    } finally { setBusy(false); }
  };
  const next = (e) => {
    e.preventDefault();
    if (busy) return;
    const problems = problemsAt(step, f);
    if (problems.length) return setMsg(problems.join(" "));
    if (step < 3) go(step + 1); else create();
  };

  const titles = ["Tell us about your business", "Your first location", "Create your owner account", "Check everything"];
  const Body = [BusinessStep, LocationStep, OwnerStep, ReviewStep][step];
  return html`<div className="page">
    <${Side} name=${f.business.name} step=${step} done=${!!result} />
    <main className="main">
      <div className="card">
        ${result ? html`<${Done} result=${result} />` : html`<form className="form" onSubmit=${next} noValidate>
          <div className="cardhead">
            <p className="eyebrow">Step ${step + 1} of 4</p>
            <span className="bar" aria-hidden="true">${STEPS.map((_, i) => html`<i key=${i} className=${i <= step ? "on" : ""}></i>`)}</span>
          </div>
          <h1 ref=${heading} tabIndex="-1">${titles[step]}</h1>
          <div className="fields"><${Body} f=${f} set=${set} go=${go} /></div>
          <div className="foot">
            <div className="msg" role="alert" aria-live="assertive">${msg && html`<p>${msg}</p>`}</div>
            <div className="actions">
              ${step > 0 && html`<button type="button" className="btn" onClick=${() => go(step - 1)} disabled=${busy}>Back</button>`}
              <button type="submit" className="btn primary" disabled=${busy}>${step < 3 ? "Continue" : busy ? "Creating…" : "Create business"}</button>
            </div>
          </div>
        </form>`}
      </div>
    </main>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
