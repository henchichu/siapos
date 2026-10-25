const html = htm.bind(React.createElement);
const { useState, useEffect, useRef } = React;

const EMP_LEN = 8;
const PIN_LEN = 6;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "Delete", "0"];
const timeOf = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function Numpad({ onDigit, onDelete, disabled }) {
  return html`<div className="numpad">
    ${KEYS.map((k) =>
      html`<button key=${k} type="button" disabled=${disabled}
        className=${k === "Delete" ? "key small" : "key"}
        onClick=${() => (k === "Delete" ? onDelete() : onDigit(k))}>${k}</button>`
    )}
  </div>`;
}

const LockIcon = () => html`<svg className="lock" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>`;

// The physical keyboard works too: digits, Backspace, and Enter (which only submits a complete entry).
// Enter or Space on a focused keypad button is left to the button.
function useKeys(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const h = ref.current;
      if (/^\d$/.test(e.key)) { e.preventDefault(); h.onDigit(e.key); }
      else if (e.key === "Backspace") { e.preventDefault(); h.onDelete(); }
      else if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); h.onEnter(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function App() {
  const [who, setWho] = useState(null); // set once the employee number is verified
  const [empNo, setEmpNo] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [lockedUntil, setLockedUntil] = useState(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  const locked = !!lockedUntil && lockedUntil > new Date();
  // re-render when the lock runs out, so the keypad comes back on its own
  useEffect(() => {
    if (!locked) return;
    const t = setTimeout(() => setTick((n) => n + 1), lockedUntil - new Date() + 500);
    return () => clearTimeout(t);
  }, [lockedUntil, locked]);

  const startOver = () => {
    setWho(null); setEmpNo(""); setPin(""); setError(""); setLockedUntil(null);
  };

  const submitEmployee = async () => {
    setBusy(true);
    try {
      const { status, data } = await post("/api/login/employee", { employeeNumber: empNo });
      if (status === 200) { setWho(data); setError(""); }
      else { setEmpNo(""); setError(data.error || "Something went wrong. Try again."); }
    } catch (err) {
      setEmpNo("");
      setError("Can't reach the server. Try again.");
    }
    setBusy(false);
  };

  const submitPin = async () => {
    setBusy(true);
    try {
      const { status, data } = await post("/api/login/pin", { employeeNumber: empNo, pin });
      if (status === 200) { window.location.href = data.redirect; return; }
      setPin("");
      if (status === 423) { setLockedUntil(new Date(data.lockedUntil)); setError(""); }
      else setError(data.error || "Something went wrong. Try again.");
    } catch (err) {
      setPin("");
      setError("Can't reach the server. Try again.");
    }
    setBusy(false);
  };

  // A full entry goes on by itself: 8 digits to the PIN step, 6 PIN digits to sign in
  useEffect(() => { if (!who && empNo.length === EMP_LEN && !busy) submitEmployee(); }, [empNo]);
  useEffect(() => { if (who && pin.length === PIN_LEN && !busy && !locked) submitPin(); }, [pin]);

  const blocked = busy || locked;
  const digit = (d) => {
    if (blocked) return;
    setError("");
    if (who) setPin((v) => (v.length < PIN_LEN ? v + d : v));
    else setEmpNo((v) => (v.length < EMP_LEN ? v + d : v));
  };
  const remove = () => {
    if (blocked) return;
    setError("");
    if (who) setPin((v) => v.slice(0, -1));
    else setEmpNo((v) => v.slice(0, -1));
  };
  const enter = () => {
    if (blocked) return;
    if (who && pin.length === PIN_LEN) submitPin();
    else if (!who && empNo.length === EMP_LEN) submitEmployee();
  };
  useKeys({ onDigit: digit, onDelete: remove, onEnter: enter });

  // One live region for every message, so screen readers announce each one as it appears
  const messages = html`<div className="messages" aria-live="assertive" aria-atomic="true">
    ${error && html`<p className="error">${error}</p>`}
    ${locked && html`<p className="lockout"><${LockIcon} />Too many tries. Locked until ${timeOf(lockedUntil)}.</p>`}
  </div>`;
  const brand = html`<h1 className="brand"><img src="/img/clockit-logo-light.png" alt="ClockIt" width="144" height="36" /></h1>`;

  if (!who) {
    return html`<main className="signin">
      ${brand}
      <p className="eyebrow">Staff sign-in</p>
      <h2 className="prompt">Enter your employee number</h2>
      <div className="slots" role="img" aria-label=${empNo ? `Employee number ${empNo.split("").join(" ")}, ${empNo.length} of ${EMP_LEN} digits` : `Employee number, ${EMP_LEN} digits`}>
        ${Array.from({ length: EMP_LEN }, (_, i) => html`<span key=${i} className=${i < empNo.length ? "slot on" : "slot"}>${empNo[i] || ""}</span>`)}
      </div>
      <${Numpad} disabled=${blocked} onDigit=${digit} onDelete=${remove} />
      ${messages}
      <div className="step">
        <p>Step 1 of 2</p>
        <div className="progress" aria-hidden="true"><span className="on"></span><span></span></div>
      </div>
    </main>`;
  }

  // No name here: the number alone isn't proof of who is at the keypad, so the PIN step doesn't greet anyone by name
  return html`<main className="signin">
    ${brand}
    <p className="eyebrow">${[who.businessName, who.locationName].filter(Boolean).join(" · ")}</p>
    <h2 className="prompt">Enter your PIN</h2>
    <div className="pins" role="img" aria-label=${`${pin.length} of ${PIN_LEN} digits entered`}>
      ${Array.from({ length: PIN_LEN }, (_, i) => html`<span key=${i} className=${i < pin.length ? "pin on" : "pin"} />`)}
    </div>
    <${Numpad} disabled=${blocked} onDigit=${digit} onDelete=${remove} />
    ${messages}
    <p className="again">Not you? <button type="button" className="link" onClick=${startOver}>Start over</button></p>
  </main>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
