const html = htm.bind(React.createElement);
const { useState, useEffect } = React;

const timeOf = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const LockIcon = () => html`<svg className="lock" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>`;

function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [lockedUntil, setLockedUntil] = useState(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const [brand, setBrand] = useState(null); // the business's name; the page shows nothing until it arrives, so no other name flashes
  useEffect(() => {
    fetch("/api/brand").then((r) => r.json()).then((d) => {
      setBrand(d.name || "");
      if (d.name) document.title = `${d.name} · Sign in`;
    }).catch(() => setBrand(""));
  }, []);

  const locked = !!lockedUntil && lockedUntil > new Date();
  // re-render when the lock runs out, so the form comes back on its own
  useEffect(() => {
    if (!locked) return;
    const t = setTimeout(() => setTick((n) => n + 1), lockedUntil - new Date() + 500);
    return () => clearTimeout(t);
  }, [lockedUntil, locked]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || locked) return;
    if (!email.trim() || !password) { setError("Enter your email and password."); return; }
    setBusy(true);
    try {
      const { status, data } = await post("/api/login", { email: email.trim(), password });
      if (status === 200) { window.location.href = data.redirect; return; }
      setPassword("");
      if (status === 423) { setLockedUntil(new Date(data.lockedUntil)); setError(""); }
      else setError(data.error || "Something went wrong. Try again.");
    } catch (err) {
      setPassword("");
      setError("Can't reach the server. Try again.");
    }
    setBusy(false);
  };

  // One live region for every message, so screen readers announce each one as it appears
  const messages = html`<div className="messages" aria-live="assertive" aria-atomic="true">
    ${error && html`<p className="error">${error}</p>`}
    ${locked && html`<p className="lockout"><${LockIcon} />Too many tries. Locked until ${timeOf(lockedUntil)}.</p>`}
  </div>`;

  return html`<main className="signin">
    <h1 className="brand">${brand}</h1>
    <p className="eyebrow">Sign in</p>
    <form className="signform" onSubmit=${submit} noValidate>
      <label>Email
        <input type="email" name="email" autoComplete="username" autoCapitalize="none" spellCheck="false" autoFocus
          value=${email} disabled=${busy || locked} onChange=${(e) => { setEmail(e.target.value); setError(""); }} /></label>
      <label>Password
        <input type="password" name="password" autoComplete="current-password"
          value=${password} disabled=${busy || locked} onChange=${(e) => { setPassword(e.target.value); setError(""); }} /></label>
      ${messages}
      <button type="submit" className="signbtn" disabled=${busy || locked}>Sign in</button>
    </form>
    <p className="newhere">New here? <a href="/signup.html">Create an account</a></p>
  </main>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
