const html = htm.bind(React.createElement);
const { useState } = React;

const EMP_LEN = 8;
const PIN_LEN = 6;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "Delete", "0"];

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

function App() {
  const [who, setWho] = useState(null); // set once the employee number is verified
  const [empNo, setEmpNo] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [lockedUntil, setLockedUntil] = useState(null);
  const [busy, setBusy] = useState(false);

  const startOver = () => {
    setWho(null); setEmpNo(""); setPin(""); setError(""); setLockedUntil(null);
  };

  const submitEmployee = async () => {
    setBusy(true);
    try {
      const { status, data } = await post("/api/login/employee", { employeeNumber: empNo });
      if (status === 200) { setWho(data); setError(""); }
      else setError(data.error || "Something went wrong. Try again.");
    } catch (err) {
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
      setError("Can't reach the server. Try again.");
    }
    setBusy(false);
  };

  if (!who) {
    const padded = empNo.padEnd(EMP_LEN, "_").split("").join(" ");
    return html`<main className="panel">
      <p className="brand">ClockIt</p>
      <p className="sub">Staff sign-in</p>
      <p className="prompt">Enter your employee number</p>
      <p className="digits" aria-label="Employee number">${padded}</p>
      <p className="error" role="alert">${error}</p>
      <${Numpad} disabled=${busy}
        onDigit=${(d) => { setError(""); setEmpNo((v) => (v.length < EMP_LEN ? v + d : v)); }}
        onDelete=${() => { setError(""); setEmpNo((v) => v.slice(0, -1)); }} />
      <button type="button" className="enter" disabled=${busy || empNo.length < EMP_LEN}
        onClick=${submitEmployee}>Enter</button>
      <p className="sub">Step 1 of 2</p>
    </main>`;
  }

  const locked = lockedUntil && lockedUntil > new Date();
  return html`<main className="panel">
    <p className="brand">ClockIt</p>
    <p className="sub">${who.businessName}</p>
    <p className="sub">${who.locationName}</p>
    <p className="prompt">Hi ${who.firstName}, enter your PIN</p>
    <div className="dots" aria-label=${`${pin.length} of ${PIN_LEN} digits entered`}>
      ${Array.from({ length: PIN_LEN }, (_, i) =>
        html`<span key=${i} className=${i < pin.length ? "dot on" : "dot"} />`)}
    </div>
    <p className="error" role="alert">${error}</p>
    <${Numpad} disabled=${busy || locked}
      onDigit=${(d) => { setError(""); setPin((v) => (v.length < PIN_LEN ? v + d : v)); }}
      onDelete=${() => { setError(""); setPin((v) => v.slice(0, -1)); }} />
    <button type="button" className="enter" disabled=${busy || locked || pin.length < PIN_LEN}
      onClick=${submitPin}>Enter</button>
    ${locked && html`<p className="lockout" role="alert">Too many tries. Locked until ${
      lockedUntil.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</p>`}
    <button type="button" className="link" onClick=${startOver}>Not you? Start over</button>
  </main>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
