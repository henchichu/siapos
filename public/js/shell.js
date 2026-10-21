// Shared by every page: React helpers, the left navigation, dialogs and sign-out. Load before the page's own script.
const html = htm.bind(React.createElement);
const { useState, useEffect, useRef, useCallback } = React;

// Menu items and Home tiles with a page of their own; every other one opens the generic section page
const PAGES = { Register: "/register.html", Kitchen: "/kitchen.html", "My shift": "/shift.html", Products: "/products.html", Inventory: "/inventory.html", "Needs attention": "/attention.html", Reports: "/reports.html", Employees: "/shift.html#team" }; // Employees is the team timecards
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
