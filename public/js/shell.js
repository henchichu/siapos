// Shared by every page: React helpers, the left navigation, dialogs and sign-out. Load before the page's own script.
const html = htm.bind(React.createElement);
const { useState, useEffect, useRef, useCallback } = React;

// Menu items and Home tiles with a page of their own; every other one opens the generic section page
const PAGES = { Register: "/register.html", Kitchen: "/kitchen.html", "My shift": "/shift.html", Products: "/products.html", Inventory: "/inventory.html", Orders: "/orders.html", "Needs attention": "/attention.html", Reports: "/reports.html", Employees: "/employees.html" };
const hrefOf = (name) => PAGES[name] || `/section.html#${encodeURIComponent(name)}`;

// The signed-in employee and what their role may open. The server already refuses pages the role lacks (server.js).
function useMe() {
  const [me, setMe] = useState(null);
  useEffect(() => { api("/session").then(setMe).catch(() => {}); }, []);
  return me;
}

async function signOut() {
  try { await api("/logout", {}); } catch (err) { /* the session is gone either way */ }
  try { sessionStorage.clear(); localStorage.clear(); } catch (err) { /* storage can be blocked */ }
  window.location.replace("/login.html");
}

function Sidebar({ me, current, onSignOut = signOut }) {
  return html`<nav className="nav" aria-label="Main">
    <div>
      <h1><a href="/home.html">ClockIt</a></h1>
      <ul>${(me?.nav || []).map((n) => html`<li key=${n}>
        <a className="link" href=${hrefOf(n)} aria-current=${n === current ? "page" : undefined}>${n}</a>
        ${n === current && html`<span className="nav-rule"></span>`}</li>`)}</ul>
    </div>
    <div className="who">
      <span>${me?.employeeName} ·</span>
      <span>${me?.roleName} · ${me?.locationName}</span>
      <button className="link" onClick=${onSignOut}>Sign out</button>
    </div>
  </nav>`;
}

// A dropdown that holds checkboxes: the native <details> keeps it keyboard-friendly with no extra code
function Multi({ options, value, onChange, empty }) {
  const names = options.filter((o) => value.includes(o.id)).map((o) => o.name);
  return html`<details className="multi">
    <summary className="select">${names.length ? names.join(", ") : empty}</summary>
    <div className="menu">${options.map((o) => html`<label key=${o.id}><input type="checkbox" checked=${value.includes(o.id)}
      onChange=${(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((v) => v !== o.id))} /> ${o.name}</label>`)}</div>
  </details>`;
}

function SuccessPanel({ name }) {
  return html`<section className="success" role="status">Success: ${name} view initialized successfully.</section>`;
}

function Modal({ title, onClose, wide, children }) {
  const ref = useRef();
  useEffect(() => ref.current.showModal(), []); // native <dialog>: focus trap and Esc come with it
  return html`<dialog ref=${ref} className=${wide ? "modal wide" : "modal"} aria-label=${title}
      onCancel=${(e) => { e.preventDefault(); onClose(); }}>
    <h2>${title}</h2>${children}
  </dialog>`;
}

function Confirm({ title, text, label, onYes, onNo }) {
  return html`<${Modal} title=${title} onClose=${onNo}>
    <p>${text}</p>
    <div className="btns"><button className="btn primary" onClick=${onYes}>${label}</button><button className="btn" onClick=${onNo}>Cancel</button></div>
  <//>`;
}

// No box until there is something to say; the live region stays so screen readers still hear it
function Message({ msg, dashed }) {
  if (!msg?.text) return html`<p className="sr" role="status"></p>`;
  return html`<p className=${`msg ${dashed ? "dashed " : ""}${msg.kind || ""}`} role="status">${msg.text}</p>`;
}

// Idle sign-out. The server ends a session after IDLE_MS without a touch (server/session.js).
// Work on the page touches it, throttled; the notice counts down from that same moment and warns at 5 minutes and 1 minute.
const IDLE_MS = 15 * 60 * 1000;
const TOUCH_EVERY_MS = 15 * 1000;
let touchedAt = 0;
const lastTouch = () => { try { return Math.max(touchedAt, Number(localStorage.getItem("idle.touched")) || 0); } catch (err) { return touchedAt; } }; // shared with other tabs

function noteActivity() {
  const now = Date.now();
  if (now - lastTouch() < TOUCH_EVERY_MS) return;
  touchedAt = now;
  try { localStorage.setItem("idle.touched", String(now)); } catch (err) { /* storage can be blocked */ }
  api("/session/touch", {}).catch(() => {});
}
["pointerdown", "keydown", "wheel"].forEach((e) => document.addEventListener(e, noteActivity, true));

function IdleWarning() {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      const left = IDLE_MS - (Date.now() - lastTouch());
      if (left <= 0) { clearInterval(t); signOut(); return; }
      setLevel(left <= 60 * 1000 ? 2 : left <= 5 * 60 * 1000 ? 1 : 0);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  return level ? html`<div className="idle" role="alert">
    <span>No activity: you'll be signed out in ${level === 2 ? "1 minute" : "5 minutes"}.</span>
    <button onClick=${() => { noteActivity(); setLevel(0); }}>Stay signed in</button></div>` : null;
}
document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/css/idle.css" }));
const idleRoot = document.body.appendChild(document.createElement("div"));
ReactDOM.createRoot(idleRoot).render(html`<${IdleWarning} />`);
noteActivity(); // opening a page counts as activity
