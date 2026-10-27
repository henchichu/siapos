// Shared by every page: React helpers, the left navigation, dialogs and sign-out. Load before the page's own script.
const html = htm.bind(React.createElement);
const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;

// Menu items and Home tiles with a page of their own; every other one opens the generic section page
const PAGES = { Register: "/register.html", Kitchen: "/kitchen.html", "My shift": "/shift.html", Products: "/products.html", Inventory: "/inventory.html", Orders: "/orders.html", "Needs attention": "/attention.html", Reports: "/reports.html", Employees: "/employees.html", Rewards: "/rewards.html" };
PAGES.Settings = "/settings.html";
const hrefOf = (name) => PAGES[name] || `/section.html#${encodeURIComponent(name)}`;

// The signed-in employee and what their role may open. The server already refuses pages the role lacks (server.js).
// One request per page: the sidebar and the page title both ask.
let mePromise;
function useMe() {
  const [me, setMe] = useState(null);
  useEffect(() => { (mePromise ||= api("/session")).then(setMe).catch(() => {}); }, []);
  return me;
}

// Small outline icons, 24x24 and stroked in the text's color (theme.css .icon)
const ICONS = {
  register: '<rect x="2" y="4" width="20" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  kitchen: '<path d="M7 2v20M4 2v6a3 3 0 0 0 6 0V2M17 22V2c-2 1.5-3 4.5-3 8h3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  receipt: '<path d="M4 2v20l3-2 3 2 2-2 2 2 3-2 3 2V2l-3 2-3-2-2 2-2-2-3 2Z"/><path d="M8 9h8M8 13h6"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z"/>',
  cup: '<path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17v-5M13 17V7M18 17v-8"/>',
  people: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  money: '<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  chevron: '<path d="m15 18-6-6 6-6"/>',
  signout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
};
const Icon = ({ name }) => html`<svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" dangerouslySetInnerHTML=${{ __html: ICONS[name] || ICONS.chart }}></svg>`;
const MENU_ICONS = { Register: "register", Kitchen: "kitchen", "Needs attention": "bell", Orders: "receipt", Rewards: "star", Products: "cup", Inventory: "box",
  Reports: "chart", Employees: "people", Settings: "sliders", "My shift": "clock" };

// The small icon in a summary card's corner, picked from its label
const CARD_ICONS = [[/hour|today|week|period/i, "clock"], [/%|tax|discount/i, "percent"], [/refund|lost|loss|differ/i, "alert"],
  [/sales|revenue|profit|gross/i, "trend"], [/cost|tip|spent|value|average/i, "money"], [/order|report|unit|item|count/i, "receipt"], [/point|tier|member/i, "star"]];
const CardIcon = ({ label }) => html`<span className="cicon"><${Icon} name=${(CARD_ICONS.find(([re]) => re.test(label)) || [, "chart"])[1]} /></span>`;

// A status word with a colored dot before it (theme.css): tone "on" (cyan), "warn" (coral) or "off" (grey)
const Status = ({ tone = "on", children }) => html`<span className=${`dot ${tone}`}>${children}</span>`;

// The page header: this location in small caps above the page's title
// place: the location the page is showing, when that is not the one signed in to (Inventory's Change location)
function PageTitle({ place, children }) {
  const me = useMe();
  return html`<div className="ptitle"><p className="place"><${Icon} name="pin" />${place || me?.locationName || " "}</p><h2>${children}</h2><div className="titleaction"></div></div>`;
}

const initials = (name = "") => name.split(/\s+/).filter(Boolean).map((w) => w[0]).filter((c, i, a) => i === 0 || i === a.length - 1).join("").toUpperCase();

async function signOut() {
  if (DEMO) return; // the tour's sample pages have nobody to sign out
  try { await api("/logout", {}); } catch (err) { /* the session is gone either way */ }
  try { const navPick = localStorage.getItem(NAV_KEY); sessionStorage.clear(); localStorage.clear(); if (navPick) localStorage.setItem(NAV_KEY, navPick); } catch (err) { /* storage can be blocked */ }
  window.location.replace("/login.html"); // the menu's collapsed or open choice outlives the sign-out
}

// The overlay menu: an owner picks another of their locations and the whole page follows it
function PickLocation({ onClose, onPicked }) {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { api("/locations").then(setData).catch((e) => setMsg({ kind: "error", text: e.message })); }, []);
  const pick = async (l) => {
    if (l.id === data.current) return onClose();
    try { await api("/locations/switch", { locationId: l.id }); onPicked(); } catch (e) { setMsg({ kind: "error", text: e.message }); }
  };
  return html`<${Modal} title="Switch location" onClose=${onClose}>
    <ul className="places">${(data?.locations || []).map((l) => html`<li key=${l.id}>
      <button className=${`btn block ${l.id === data.current ? "primary" : ""}`} aria-current=${l.id === data.current ? "true" : undefined} onClick=${() => pick(l)}>${l.name}</button></li>`)}</ul>
    <${Message} msg=${msg} dashed />
    <div className="btns"><button className="btn" onClick=${onClose}>Cancel</button></div>
  <//>`;
}

// Three layouts, from the same breakpoints as the pages' own stylesheets: on a phone or a window taller than it is wide the menu is
// a drawer opened from a slim top bar; on a tablet it is icons only; on a laptop it is open, and folds to icons with its button.
// The fold choice is kept in this browser and outlives sign-out. Classes go on <body>, outside React, and nav.css does the rest.
const NAV_KEY = "nav.collapsed";
const DRAWER = "(max-width: 760px), (max-aspect-ratio: 1/1)";
const RAIL = "(max-width: 1024px)";
const navMode = () => (!window.matchMedia ? "full" : window.matchMedia(DRAWER).matches ? "drawer" : window.matchMedia(RAIL).matches ? "rail" : "full");
function savedCollapsed() {
  try { return localStorage.getItem(NAV_KEY) === "1"; } catch (err) { return false; }
}

// The clock icon on its own; until that image exists, the full logo cropped to its mark
function Mark() {
  const [ok, setOk] = useState(true);
  return ok ? html`<img className="mark" src="/img/clockit-mark-light.png" alt="ClockIt" width="40" height="40" onError=${() => setOk(false)} />`
    : html`<span className="mark crop"><img src="/img/clockit-logo-light.png" alt="ClockIt" width="176" height="44" /></span>`;
}

function Sidebar({ me, current, onSignOut = signOut }) {
  const [places, setPlaces] = useState(false);
  const [mode, setMode] = useState(navMode);
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const [open, setOpen] = useState(false); // the phone drawer
  const [tip, setTip] = useState(null); // { text, x, y } beside the hovered or focused icon while folded
  const navRef = useRef(null), burger = useRef(null), closer = useRef(null);
  const folded = mode === "rail" || (mode === "full" && collapsed);

  useEffect(() => { // follow the window across the breakpoints
    if (!window.matchMedia) return;
    const queries = [DRAWER, RAIL].map((q) => window.matchMedia(q));
    const onChange = () => { setMode(navMode()); setTip(null); };
    queries.forEach((q) => q.addEventListener("change", onChange));
    return () => queries.forEach((q) => q.removeEventListener("change", onChange));
  }, []);
  useEffect(() => { if (mode !== "drawer") setOpen(false); }, [mode]);
  React.useLayoutEffect(() => {
    document.body.classList.toggle("nav-collapsed", folded);
    document.body.classList.toggle("nav-open", open); // nav.css stops the page behind from scrolling
  }, [folded, open]);

  // While the drawer is open the rest of the page is inert, Tab stays inside it and Escape closes it; focus goes back to the menu button
  useEffect(() => {
    if (!open) return;
    const nav = navRef.current;
    const others = [...nav.parentElement.children].filter((el) => el !== nav && !el.classList.contains("navshade"));
    others.forEach((el) => { el.inert = true; });
    closer.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
      if (e.key !== "Tab") return;
      const stops = [...nav.querySelectorAll("a[href], button:not(:disabled)")].filter((el) => el.offsetParent && getComputedStyle(el).visibility !== "hidden");
      const first = stops[0], last = stops[stops.length - 1];
      if (!nav.contains(document.activeElement)) { e.preventDefault(); first?.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); others.forEach((el) => { el.inert = false; }); burger.current?.focus(); };
  }, [open]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next); setTip(null);
    try { localStorage.setItem(NAV_KEY, next ? "1" : "0"); } catch (err) { /* storage can be blocked */ }
  };
  // The tooltip is fixed to the window so the menu's scroll area can't clip it
  const tipFor = (text) => ({
    onMouseEnter: (e) => show(text, e.currentTarget), onFocus: (e) => show(text, e.currentTarget),
    onMouseLeave: () => setTip(null), onBlur: () => setTip(null),
  });
  const show = (text, el) => {
    if (!document.body.classList.contains("nav-collapsed")) return;
    const r = el.getBoundingClientRect();
    setTip({ text, x: r.right + 12, y: r.top + r.height / 2 });
  };
  const closeAfter = () => { if (open) setOpen(false); }; // a tap on a menu item closes the drawer as the page changes
  return html`<${React.Fragment}>
    <header className="navbar">
      <button className="burger" ref=${burger} aria-expanded=${open} aria-controls="main-nav" aria-label="Open navigation" onClick=${() => setOpen(true)}><${Icon} name="menu" /></button>
      <a href="/home.html" className="navhome"><${Mark} /></a>
      <span className="navtitle">${current}</span>
    </header>
    ${open && html`<div className="navshade" onClick=${() => setOpen(false)}></div>`}
    <nav className="nav" id="main-nav" aria-label="Main" ref=${navRef}>
      <div>
        <button className="navclose" ref=${closer} aria-expanded=${open} aria-controls="main-nav" aria-label="Close navigation" onClick=${() => setOpen(false)}><${Icon} name="close" /></button>
        <h1><a href="/home.html" onClick=${closeAfter} ...${tipFor("Home")}>
          <img className="full" src="/img/clockit-logo-light.png" alt="ClockIt" width="176" height="44" /><${Mark} />
        </a></h1>
        <ul>${(me?.nav || []).map((n) => html`<li key=${n}>
          <a className="link" href=${hrefOf(n)} aria-current=${n === current ? "page" : undefined} onClick=${closeAfter} ...${tipFor(n)}><${Icon} name=${MENU_ICONS[n]} /><span className="label">${n}</span></a></li>`)}</ul>
      </div>
      <div className="foot">
        ${mode === "full" && html`<button className="navtoggle" aria-expanded=${!collapsed} aria-controls="main-nav" aria-label=${collapsed ? "Expand navigation" : "Collapse navigation"}
          onClick=${toggle} ...${tipFor(collapsed ? "Expand navigation" : "Collapse navigation")}><${Icon} name="chevron" /></button>`}
        <div className="who">
          <span className="avatar" aria-hidden="true">${initials(me?.employeeName)}</span>
          <span className="name">${me?.employeeName}</span>
          ${me?.canSwitch
            ? html`<button className="where" aria-haspopup="dialog" onClick=${() => setPlaces(true)}>${me.roleName} · ${me.locationName}</button>`
            : html`<span>${me?.roleName} · ${me?.locationName}</span>`}
          <button className="link signout" onClick=${onSignOut} ...${tipFor("Sign out")}><${Icon} name="signout" /><span className="label">Sign out</span></button>
        </div>
      </div>
      ${tip && html`<div className="navtip" aria-hidden="true" style=${{ left: tip.x, top: tip.y }}>${tip.text}</div>`}
      ${places && html`<${PickLocation} onClose=${() => setPlaces(false)} onPicked=${() => window.location.reload()} />`}
    </nav>
  <//>`;
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

function Modal({ title, onClose, wide, className = "", children }) {
  const ref = useRef();
  useEffect(() => ref.current.showModal(), []); // native <dialog>: focus trap and Esc come with it
  return html`<dialog ref=${ref} className=${`modal${wide ? " wide" : ""}${className ? " " + className : ""}`} aria-label=${title}
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
if (!DEMO) ["pointerdown", "keydown", "wheel"].forEach((e) => document.addEventListener(e, noteActivity, true));

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
if (!DEMO) { ReactDOM.createRoot(idleRoot).render(html`<${IdleWarning} />`); noteActivity(); } // opening a page counts as activity

// Card layout (shift.css, ".rowcards"): below 760px each row becomes a card and every cell shows its column header from data-label.
// Set here from the header row, so no table has to repeat its headings, and again whenever a table's rows change.
let labelling = 0;
const labelCells = () => { labelling = 0; document.querySelectorAll("table.rowcards").forEach((t) => {
  const heads = [...(t.tHead?.rows[0]?.cells || [])].map((c) => c.textContent.trim());
  for (const row of [...(t.tBodies[0]?.rows || []), ...(t.tFoot?.rows || [])]) [...row.cells].forEach((c, i) => { if (c.colSpan === 1 && c.dataset.label !== (heads[i] || "")) c.dataset.label = heads[i] || ""; });
}); };
new MutationObserver(() => { if (!labelling) labelling = requestAnimationFrame(labelCells); }).observe(document.body, { childList: true, subtree: true });

// ---- Phone navigation: layers instead of one long scroll (styles in shift.css, all at 760px and below) ----
// Sub-tabs show one panel of a page at a time, a Sheet is a form that covers the whole screen, and the Filters button
// opens the page's filter controls in a sheet. Wider screens keep everything on the page as before.
const PHONE = "(max-width: 760px)";
function usePhone() {
  const q = window.matchMedia ? window.matchMedia(PHONE) : { matches: false, addEventListener() {}, removeEventListener() {} }; // jsdom has no media queries: never a phone
  const [phone, setPhone] = useState(q.matches);
  useEffect(() => { const f = () => setPhone(q.matches); q.addEventListener("change", f); return () => q.removeEventListener("change", f); }, []);
  return phone;
}

// tabs: [[key, title, count?]]. The page gives each panel className "subpanel on" when its key is the shown one.
function SubTabs({ tabs, value, onChange, label = "Sections" }) {
  return html`<div className="subtabs" role="group" aria-label=${label}>${tabs.map(([key, title, n]) =>
    html`<button key=${key} aria-pressed=${value === key} onClick=${() => onChange(key)}>${title}${n != null && html`<span className="badge">${n}</span>`}</button>`)}</div>`;
}
const panelOf = (key, shown) => (key === shown ? "subpanel on" : "subpanel");

// A side form: in its column on a wide screen, a full-screen sheet with a Back button on a phone (Escape closes it too).
// popup: on a phone this is a pop-up window (Modal) instead of a full-screen sheet; the page chooses per list.
function Sheet({ title, onClose, innerRef, popup, wide, className = "", children, ...rest }) {
  const phone = usePhone();
  const el = useRef(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!phone || popup) return undefined;
    el.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // the page behind stays where it was
    const onKey = (e) => { if (e.key === "Escape") close.current(); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", onKey); };
  }, [phone, popup]);
  if (popup && phone) return html`<${Modal} title=${title} onClose=${onClose} wide=${wide} className="popup">${children}<//>`;
  return html`<aside ref=${(n) => { el.current = n; if (innerRef) innerRef.current = n; }} tabIndex="-1" className=${`pform pside sheet ${className}`}
      role=${phone ? "dialog" : undefined} aria-modal=${phone ? "true" : undefined} aria-label=${title} ...${rest}>
    <div className="sheethead"><button type="button" className="sheetback" onClick=${onClose}>‹ Back</button><span>${title}</span></div>
    ${children}
  </aside>`;
}

// The page's filter controls. Wide: the controls as they are. Phone: one Filters button (top right of the list, with how many are on)
// that opens them in a sheet; the controls keep their state in the page, and a submit inside the sheet (Search) closes it.
function Filters({ active = 0, popup, children }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const mark = useRef(null);
  const [slot, setSlot] = useState(null);
  // the button goes in the list's title row, beside its other buttons (the .filterslot in its header); a list with no such slot gets a row of its own
  useLayoutEffect(() => { setSlot(mark.current?.closest(".pview, .results, .cards")?.querySelector(".filterslot") || mark.current?.parentElement?.querySelector(".filterslot") || null); }, [phone]);
  if (!phone) return children;
  const button = html`<button type="button" className="filterbtn" aria-haspopup="dialog" onClick=${() => setOpen(true)}>Filters${active > 0 && html`<span className="badge">${active}</span>`}</button>`;
  return html`<${React.Fragment}>
    <span ref=${mark} hidden></span>
    ${slot ? ReactDOM.createPortal(button, slot) : html`<div className="filterbar">${button}</div>`}
    ${open && html`<${Sheet} title="Filters" popup=${popup} onClose=${() => setOpen(false)}>
      <div onSubmit=${() => setOpen(false)} onClick=${(e) => { if (e.target.closest("[data-apply]")) setOpen(false); }}>${children}</div>
      ${popup ? html`<div className="btns"><button type="button" className="btn primary" onClick=${() => setOpen(false)}>Done</button></div>`
        : html`<div className="pactions"><button type="button" className="pbtn" onClick=${() => setOpen(false)}>Done</button></div>`}
    <//>`}
  <//>`;
}

// The page's location choice. Wide: the dropdown where the page put it. Phone: a "Change location" button up in the page title, beside the
// current location (the .titleaction slot PageTitle leaves), that opens the dropdown in a sheet; nothing when there is only one place to
// choose. The button is drawn into the title (a portal), so the dropdown's state stays with the page's filters. Choosing applies as the page
// already does; Done closes the sheet.
// popup: { options: [[value, name]], value, onChange } shows the choices as buttons in a pop-up window like the sidebar's Switch location.
function ChangeLocation({ show = true, popup, phoneOnly, children }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  if (!phone) return phoneOnly ? null : children;
  if (!show) return null;
  const button = html`<button type="button" className="filterbtn" aria-haspopup="dialog" onClick=${() => setOpen(true)}>Change location</button>`;
  const slot = document.querySelector(".titleaction");
  return html`<${React.Fragment}>
    ${slot ? ReactDOM.createPortal(button, slot) : html`<div className="filterbar">${button}</div>`}
    ${open && popup && html`<${Modal} title="Change location" onClose=${() => setOpen(false)} className="popup">
      <ul className="places">${popup.options.map(([value, name]) => html`<li key=${value}>
        <button className=${`btn block ${value === popup.value ? "primary" : ""}`} aria-current=${value === popup.value ? "true" : undefined}
          onClick=${() => { setOpen(false); if (value !== popup.value) popup.onChange(value); }}>${name}</button></li>`)}</ul>
      <div className="btns"><button type="button" className="btn" onClick=${() => setOpen(false)}>Cancel</button></div>
    <//>`}
    ${open && !popup && html`<${Sheet} title="Change location" onClose=${() => setOpen(false)}>
      <div className="pfilters">${children}</div>
      <div className="pactions"><button type="button" className="pbtn" onClick=${() => setOpen(false)}>Done</button></div>
    <//>`}
  <//>`;
}
