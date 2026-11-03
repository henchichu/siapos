// Customer sign-up: a first name, an email and a password, then straight to the kiosk. The checks match server/validate.js
// and server/customer.js, which check everything again.
const html = htm.bind(React.createElement);
const { useState, useEffect } = React;

const tidy = (v) => String(v || "").normalize("NFC").trim().replace(/\s+/g, " ");
const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
function problem(f) {
  const name = tidy(f.firstName);
  if (!name || name.length > 50 || !/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(name)) return "Enter a first name (letters, spaces, . ' - only, up to 50 characters).";
  const email = f.email.trim().toLowerCase();
  if (email.length > 254 || email.split("@")[0].length > 64 || !EMAIL.test(email)) return "Enter a valid email, like name@example.com.";
  if (f.password.length < 8 || f.password.length > 200) return "Choose a password of 8 to 200 characters.";
  if (f.password !== f.confirm) return "The passwords don't match. Type the same password in both.";
  return null;
}

function App() {
  const [brand, setBrand] = useState("");
  const [f, setF] = useState({ firstName: "", email: "", password: "", confirm: "" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/brand").then((r) => r.json()).then((d) => { setBrand(d.name || ""); if (d.name) document.title = `${d.name} · Create an account`; }).catch(() => {});
  }, []);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setMsg(""); };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const bad = problem(f);
    if (bad) { setMsg(bad); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { window.location.href = data.redirect; return; }
      setMsg(data.error || "Something went wrong. Try again.");
    } catch (err) { setMsg("Can't reach the server. Try again."); }
    setBusy(false);
  };

  const Field = ({ label, name, type = "text", hint, ...rest }) => html`<label className="field"><span className="lbl">${label}</span>
    <input className="input" name=${name} type=${type} value=${f[name]} onChange=${set(name)} disabled=${busy} ...${rest} />${hint && html`<span className="hint">${hint}</span>`}</label>`;

  return html`<div className="page">
    <aside className="side">
      <div><p className="eyebrow">Create an account</p><p className="biz" aria-live="polite">${brand}</p></div>
    </aside>
    <main className="main"><div className="card">
      <form className="form" onSubmit=${submit} noValidate>
        <h1>Create your account</h1>
        <p className="sub">Order ahead at the kiosk with your email and a password.</p>
        <div className="fields">
          ${Field({ label: "First name", name: "firstName", autoComplete: "given-name", autoFocus: true })}
          ${Field({ label: "Email", name: "email", type: "email", autoComplete: "username", autoCapitalize: "none", spellCheck: false })}
          ${Field({ label: "Password", name: "password", type: "password", autoComplete: "new-password", hint: "At least 8 characters." })}
          ${Field({ label: "Confirm password", name: "confirm", type: "password", autoComplete: "new-password" })}
        </div>
        <div className="foot">
          <div aria-live="assertive">${msg && html`<p className="msg">${msg}</p>`}</div>
          <button type="submit" className="btn" disabled=${busy}>Create account</button>
          <p className="alt">Already have an account? <a href="/login.html">Sign in</a></p>
        </div>
      </form>
    </div></main>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
