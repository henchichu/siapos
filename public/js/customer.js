// Customer kiosk
const html = htm.bind(React.createElement);
const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;

const IMG_ROTATION = [1,2,3,4,5,6];
const productImg = (idx) => `/img/customer/product-${IMG_ROTATION[idx % 6]}.jpg`;
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const fmt = (iso, tz) => iso ? new Date(iso).toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZone:tz }) : "";
// crypto.randomUUID exists only on HTTPS or localhost; an iPad on plain http://<lan-ip> has just getRandomValues
const newKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

// The café's QR code opens /order/<locationId>; every call says which café this is
const LOCATION_ID = (/^\/order\/([^/]+)/.exec(window.location.pathname) || [])[1];
const HEADERS = LOCATION_ID ? { "x-location-id": decodeURIComponent(LOCATION_ID) } : {};

async function api(path) {
  const r = await fetch(`/api${path}`, { headers: HEADERS });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Something went wrong.");
  return d;
}
async function post(path, body) {
  const r = await fetch(`/api${path}`, { method:"POST", headers:{"Content-Type":"application/json", ...HEADERS}, body:JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Something went wrong.");
  return d;
}

//  Entry screen
const formatPhone = (v) => {
  const d = v.replace(/\D/g, "").slice(0, 10);
  return d.length > 6 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d.length > 3 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : d;
};
function Entry({ businessName, locationName, phoneSignIn, onGuest, onSignedIn }) {
  const [who, setWho] = useState(""); // a phone number or an email
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const logIn = async () => {
    const isEmail = /[a-z@]/i.test(who);
    const digits = who.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); // same rule as the server
    const email = who.trim().toLowerCase();
    if (isEmail ? !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) : !/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) { setMsg("Enter a valid 10-digit US phone number or an email."); return; }
    setBusy(true); setMsg("");
    try {
      const d = await post("/customer/login", isEmail ? { email } : { phone: digits });
      onSignedIn(d);
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  return html`
    <div className="entry">
      <div className="topbar"><p>${businessName}</p></div>
      <div className="body">
        <div className="signin">
          <div className="brand">
            <span className="pill">${locationName}</span>
            <h1>${businessName}</h1>
            <p>${phoneSignIn ? "Members earn points on every order." : "Continue as a guest to place an order."}</p>
          </div>
          <section className="panel">
            ${phoneSignIn && html`<${React.Fragment}>
              <label className="field">Phone or email
                <span className="box">
                  <input inputMode="email" autoComplete="username" autoFocus maxLength="254" placeholder="(312) 555-0142 or name@example.com" value=${who}
                    onChange=${(e) => { const v = e.target.value; setWho(/[a-z@]/i.test(v) ? v : formatPhone(v)); setMsg(""); }}
                    onKeyDown=${(e) => e.key === "Enter" && !busy && logIn()} />
                  ${who && html`<button className="clear" aria-label="Clear" onClick=${() => { setWho(""); setMsg(""); }}><${NavIcon} name="close" /></button>`}
                </span>
              </label>
              ${msg && html`<p className="alert" role="alert">${msg}</p>`}
              <button className="login" disabled=${busy} onClick=${logIn}>Log In</button>
              <p className="or"><span>or</span></p>
            <//>`}
            <button className="guest" onClick=${onGuest}>Order as Guest</button>
          </section>
          <p className="where">Pickup at ${locationName}</p>
        </div>
      </div>
    </div>`;
}
//  Product customize panel 
function Customize({ product, img, onAdd, onCancel }) {
  const variants = product.variants.filter((v) => v.available);
  const firstVariant = variants[0];
  const [variantId, setVariantId] = useState(firstVariant ? firstVariant.id : null);
  const [chosen, setChosen] = useState({}); // groupId -> Set of modifierIds
  const [qty, setQty] = useState(1);

  const variant = product.variants.find((v) => v.id === variantId) || firstVariant;
  const baseCents = variant ? variant.priceCents : 0;

  const extrasCents = product.groups.reduce((sum, g) => {
    const sel = chosen[g.id] || new Set();
    return sum + g.modifiers.filter((m) => sel.has(m.id)).reduce((a, m) => a + m.deltaCents, 0);
  }, 0);
  const unitCents = baseCents + extrasCents;
  const itemTotal = unitCents * qty;

  const problems = [];
  for (const g of product.groups) {
    const sel = chosen[g.id] || new Set();
    const min = g.min || 0;
    const max = g.max || 255;
    if (sel.size < min) problems.push(g.name);
    if (sel.size > max) problems.push(g.name);
  }
  const canAdd = !!variantId && problems.length === 0 && variants.length > 0;

  const toggle = (g, m) => {
    setChosen((prev) => {
      const next = { ...prev };
      const set = new Set(next[g.id] || []);
      const max = g.max || 255;
      if (set.has(m.id)) set.delete(m.id);
      else if (set.size < max) set.add(m.id);
      next[g.id] = set;
      return next;
    });
  };
  const setRadio = (g, m) => {
    setChosen((prev) => ({ ...prev, [g.id]: new Set([m.id]) }));
  };

  const confirm = () => {
    if (!canAdd) return;
    const optionNames = [];
    const modifierIds = [];
    for (const g of product.groups) {
      const sel = chosen[g.id] || new Set();
      for (const m of g.modifiers) if (sel.has(m.id)) { optionNames.push(m.name); modifierIds.push(m.id); }
    }
    const key = [variantId, ...modifierIds.sort()].join("|");
    onAdd({
      key: `p${product.id}|${key}`,
      productId: product.id, name: product.name, variantId,
      variantName: variant.name, options: optionNames,
      modifierIds, unitCents, qty,
    }, qty);
  };

  return html`
    <div className="customize" role="dialog" aria-modal="true" aria-label=${product.name}>
      <button className="close" aria-label="Close" onClick=${onCancel}><${NavIcon} name="close" /></button>
      <div className="body">
        <img className="hero" src=${img} alt="" />
        <section className="form">
          <div className="head">
            <h2>${product.name}</h2>
            ${product.description && html`<p className="desc">${product.description}</p>`}
          </div>

          ${variants.length > 1 && html`
            <fieldset className="fieldset">
              <div className="legend"><span className="semi">Size</span><span className="badge req">Required</span></div>
              <div className="choices">
                ${variants.map((v) => html`
                  <button key=${v.id} className=${"choice" + (v.id === variantId ? " on" : "")}
                    onClick=${() => setVariantId(v.id)}>${v.name} · ${money(v.priceCents)}</button>`)}
              </div>
            </fieldset>`}

          ${product.groups.map((g) => {
            const sel = chosen[g.id] || new Set();
            const isRadio = (g.min === 1 && g.max === 1);
            return html`
              <fieldset key=${g.id} className="fieldset">
                <div className="legend"><span className="semi">${g.name}</span>
                  <span className=${"badge" + (g.min ? " req" : "")}>${g.min ? "Required" : "Optional"}</span>
                  ${!isRadio && html`<span className="count">${sel.size} of ${g.max || 255}</span>`}</div>
                <div className="opt-list">
                  ${g.modifiers.map((m) => {
                    const on = sel.has(m.id);
                    const atLimit = !on && sel.size >= (g.max || 255);
                    return html`
                    <div key=${m.id} className=${"opt" + (on ? " on" : "") + (atLimit ? " disabled" : "")}>
                      <label>
                        <input type=${isRadio ? "radio" : "checkbox"} className="sr-only" style=${{ position: "absolute", width: "1px", height: "1px", opacity: "0" }}
                          name=${"g" + g.id} checked=${on} disabled=${atLimit}
                          onChange=${() => isRadio ? setRadio(g, m) : toggle(g, m)} />
                        <span className=${"box" + (isRadio ? " radio" : "")}></span>
                        <span className="name">${m.name}</span>
                        <span className="delta">${m.deltaCents === 0 ? "included" : "+" + money(m.deltaCents)}</span>
                      </label>
                    </div>`;
                  })}
                </div>
              </fieldset>`;
          })}
        </section>
      </div>
      <div className="footer">
        ${!canAdd && html`<p className="need" role="alert">Choose a size and all required options before adding this item.</p>`}
        <div className="actions">
          <div className="qty-ctrl">
            <button aria-label="Decrease quantity" disabled=${qty === 1} onClick=${() => setQty(Math.max(1, qty - 1))}>−</button>
            <span>${qty}</span>
            <button aria-label="Increase quantity" onClick=${() => setQty(qty + 1)}>+</button>
          </div>
          <button className="confirm" disabled=${!canAdd} onClick=${confirm}>Add to order · ${money(itemTotal)}</button>
        </div>
      </div>
    </div>`;
}
//  Navigation 
// The staff pages' menu, in this page's colours: a slim top bar with a menu button on a phone (or a window taller than it is wide), icons beside the page
// on a tablet, the open menu on a laptop with a button that folds it. The fold is kept in this browser. Classes go on <body>; customer.css does the rest.
const NAV_KEY = "customer.nav.collapsed";
const DRAWER = "(max-width: 760px), (max-aspect-ratio: 1/1)";
const RAIL = "(max-width: 1024px)";
const navMode = () => (!window.matchMedia ? "full" : window.matchMedia(DRAWER).matches ? "drawer" : window.matchMedia(RAIL).matches ? "rail" : "full");
const savedFold = () => { try { return localStorage.getItem(NAV_KEY) === "1"; } catch (err) { return false; } };
const NAV_ICONS = {
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>', close: '<path d="M18 6 6 18M6 6l12 12"/>', chevron: '<path d="m15 18-6-6 6-6"/>',
  signout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  signin: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17-5-5 5-5M5 12h12"/>',
  cup: '<path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
  receipt: '<path d="M4 2v20l3-2 3 2 2-2 2 2 3-2 3 2V2l-3 2-3-2-2 2-2-2-3 2Z"/><path d="M8 9h8M8 13h6"/>',
  check: '<path d="m5 12 5 5 9-10"/>', cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>', wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><path d="M16 13h.01"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z"/>',
};
const NavIcon = ({ name }) => html`<svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" dangerouslySetInnerHTML=${{ __html: NAV_ICONS[name] }}></svg>`;

function CustomerNav({ businessName, locationName, mode, memberInfo, current, canOrders, onMenu, onOrders, onRewards, onExit }) {
  const [navKind, setNavKind] = useState(navMode);
  const [collapsed, setCollapsed] = useState(savedFold);
  const [open, setOpen] = useState(false); // the phone drawer
  const [tip, setTip] = useState(null);
  const navRef = useRef(null), burger = useRef(null), closer = useRef(null);
  const folded = navKind === "rail" || (navKind === "full" && collapsed);
  const guest = !memberInfo;
  const items = [["menu", "Menu", "cup", onMenu], ...(canOrders ? [["orders", "Your Orders", "receipt", onOrders]] : []), ...(memberInfo?.member ? [["rewards", "Rewards", "star", onRewards]] : [])];
  const label = items.find(([k]) => k === current)?.[1] || "Menu";

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const queries = [DRAWER, RAIL].map((q) => window.matchMedia(q));
    const change = () => { setNavKind(navMode()); setTip(null); };
    queries.forEach((q) => q.addEventListener("change", change));
    return () => queries.forEach((q) => q.removeEventListener("change", change));
  }, []);
  useEffect(() => { if (navKind !== "drawer") setOpen(false); }, [navKind]);
  useLayoutEffect(() => {
    document.body.classList.toggle("nav-collapsed", folded);
    document.body.classList.toggle("nav-open", open);
  }, [folded, open]);
  // While the drawer is open the rest of the page is inert, Tab stays inside it and Escape closes it
  useEffect(() => {
    if (!open) return undefined;
    const nav = navRef.current;
    const others = [...nav.parentElement.children].filter((el) => el !== nav && !el.classList.contains("navshade"));
    others.forEach((el) => { el.inert = true; });
    closer.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
      if (e.key !== "Tab") return;
      const stops = [...nav.querySelectorAll("button:not(:disabled)")].filter((el) => el.offsetParent);
      const first = stops[0], last = stops[stops.length - 1];
      if (!nav.contains(document.activeElement)) { e.preventDefault(); first?.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); others.forEach((el) => { el.inert = false; }); burger.current?.focus(); };
  }, [open]);

  const toggle = () => { const next = !collapsed; setCollapsed(next); setTip(null); try { localStorage.setItem(NAV_KEY, next ? "1" : "0"); } catch (err) { /* storage can be blocked */ } };
  const show = (text, el) => { if (!document.body.classList.contains("nav-collapsed")) return; const r = el.getBoundingClientRect(); setTip({ text, x: r.right + 12, y: r.top + r.height / 2 }); };
  const tipFor = (text) => ({ onMouseEnter: (e) => show(text, e.currentTarget), onFocus: (e) => show(text, e.currentTarget), onMouseLeave: () => setTip(null), onBlur: () => setTip(null) });
  const go = (fn) => () => { setOpen(false); fn(); };
  const initial = guest ? "G" : (memberInfo.firstName || "?").trim().charAt(0).toUpperCase();

  return html`<${React.Fragment}>
    <header className="navbar">
      <button className="burger" ref=${burger} aria-expanded=${open} aria-controls="customer-nav" aria-label="Open navigation" onClick=${() => setOpen(true)}><${NavIcon} name="menu" /></button>
      <span className="navtitle">${businessName}</span>
      <span className="navsection">${label}</span>
    </header>
    ${open && html`<div className="navshade" onClick=${() => setOpen(false)}></div>`}
    <nav className="nav" id="customer-nav" aria-label="Main" ref=${navRef}>
      <div>
        <button className="navclose" ref=${closer} aria-expanded=${open} aria-controls="customer-nav" aria-label="Close navigation" onClick=${() => setOpen(false)}><${NavIcon} name="close" /></button>
        <h1 className="brand"><span className="brand-mark" aria-hidden="true">${(businessName || "").trim().charAt(0).toUpperCase()}</span><span className="label">${businessName}</span></h1>
        <ul>${items.map(([key, text, icon, fn]) => html`<li key=${key}>
          <button className="link" aria-current=${key === current ? "page" : undefined} onClick=${go(fn)} ...${tipFor(text)}><${NavIcon} name=${icon} /><span className="label">${text}</span></button></li>`)}</ul>
      </div>
      <div className="foot">
        ${navKind === "full" && html`<button className="navtoggle" aria-expanded=${!collapsed} aria-controls="customer-nav" aria-label=${collapsed ? "Expand navigation" : "Collapse navigation"}
          onClick=${toggle} ...${tipFor(collapsed ? "Expand navigation" : "Collapse navigation")}><${NavIcon} name="chevron" /></button>`}
        <div className="who">
          <span className="avatar" aria-hidden="true">${initial}</span>
          <span className="name">${guest ? "Guest" : memberInfo.firstName}</span>
          <span>${memberInfo?.member ? `${memberInfo.points} points` : "Pickup at " + locationName}</span>
          <button className="link signout" onClick=${go(onExit)} ...${tipFor(guest ? "Sign in" : "Sign out")}><${NavIcon} name=${guest ? "signin" : "signout"} /><span className="label">${guest ? "Sign in" : "Sign out"}</span></button>
        </div>
      </div>
      ${tip && html`<div className="navtip" aria-hidden="true" style=${{ left: tip.x, top: tip.y }}>${tip.text}</div>`}
    </nav>
  <//>`;
}

//  Checkout overlay 
function Checkout({ businessName, cart, mode, memberInfo, locationName, payHere, note, onNoteChange, onBack, onOrderPlaced }) {
  const [guestName, setGuestName] = useState("");
  const [payMethod, setPayMethod] = useState(null);
  const [card, setCard] = useState({ number: "", expiry: "", cvc: "" }); // a test card: this kiosk takes mock payments
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // receipt after submit
  const idempKey = useRef(newKey());
  const [phoneSheet] = useState(() => !!window.matchMedia && window.matchMedia("(max-width: 600px)").matches); // a phone starts with the summary folded

  const subtotalCents = cart.reduce((a, it) => a + it.unitCents * it.qty, 0);
  const [priced, setPriced] = useState(null);

  useEffect(() => {
    if (!cart.length) return;
    post("/customer/price", { items: cart.map((it) => ({ key: it.key, variantId: it.variantId, quantity: it.qty, modifierIds: it.modifierIds || [] })) }).then(setPriced).catch(() => {});
  }, []);

  const totalCents = priced ? priced.totalCents : null;
  const taxCents = priced ? priced.taxCents : null;

  const place = async () => {
    if (!payMethod) { setMsg("Choose how you'll pay."); return; }
    if (mode === "guest" && !guestName.trim()) { setMsg("Enter a name for the order."); return; }
    setBusy(true); setMsg("");
    try {
      const d = await post("/customer/orders", {
        idempotencyKey: idempKey.current,
        paymentMethod: payMethod,
        card: payMethod === "Card" ? card : undefined,
        guestName: mode === "guest" ? guestName : undefined,
        note,
        items: cart.map((it) => ({ key: it.key, variantId: it.variantId, quantity: it.qty, modifierIds: it.modifierIds || [] })),
      });
      const receipt = { ...d, cart, note, payMethod, guestName, mode, memberInfo };
      setDone(receipt);
      onOrderPlaced(receipt);
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  if (done) {
    return html`<${Confirmation} businessName=${businessName} receipt=${done} onBack=${onBack} />`;
  }

  const items = cart.reduce((a, it) => a + it.qty, 0);
  const due = totalCents != null ? money(totalCents) : "…";
  const digits = (v, n) => v.replace(/\D/g, "").slice(0, n);
  const METHOD_ICON = { Cash: "cash", Card: "card", "Apple Pay": "wallet", "Google Pay": "wallet" };
  return html`
    <div className="checkout-overlay screen" role="dialog" aria-modal="true" aria-label="Checkout">
      <button className="close" aria-label="Close" onClick=${onBack}><${NavIcon} name="close" /></button>
      <div className="body">
        <section className="form">
          <h2>Checkout</h2>

          <div className="section">
            <h3>${mode === "guest" ? "Guest details" : "Account"}</h3>
            ${mode === "guest" ? html`
              <div className="label">Name for the order
                <input placeholder="Enter your first name" value=${guestName}
                  onChange=${(e) => setGuestName(e.target.value)} />
              </div>` : html`
              <p className="semi" style=${{ fontSize: "16px" }}>${memberInfo.firstName}${memberInfo.maskedPhone || memberInfo.maskedEmail ? " · " + (memberInfo.maskedPhone || memberInfo.maskedEmail) : ""}</p>`}
          </div>

          <div className="section">
            <h3>Pickup</h3>
            <div style=${{ fontSize: "14px", color: "var(--muted)" }}>
              <p>Pickup at this counter</p>
              <p>We'll prepare your order after payment.</p>
            </div>
            <div className="label">Note for the kitchen (optional)
              <input maxLength="120" value=${note} onChange=${(e) => onNoteChange(e.target.value)} />
            </div>
          </div>

          <div className="section">
            <h3>Payment</h3>
            <p style=${{ fontSize: "14px", color: "var(--muted)" }}>${payHere ? "Test mode: Card, Apple Pay and Google Pay are not charged for real. Cash is paid at the counter." : "Pay the cashier at the counter."}</p>
            <div className="methods">
              ${(payHere ? ["Cash", "Card", "Apple Pay", "Google Pay"] : ["Cash"]).map((m) => html`
                <button key=${m} className=${"method" + (payMethod === m ? " on" : "")}
                  onClick=${() => setPayMethod(m)}><${NavIcon} name=${METHOD_ICON[m]} />${m}</button>`)}
            </div>
            ${payMethod === "Card" && html`<div className="cardbox">
              <div className="label wide">Card number
                <input inputMode="numeric" autoComplete="off" placeholder="4242 4242 4242 4242" value=${card.number}
                  onChange=${(e) => setCard({ ...card, number: digits(e.target.value, 19).replace(/(.{4})(?=.)/g, "$1 ") })} /></div>
              <div className="label">Expiry (MM/YY)
                <input autoComplete="off" placeholder="12/30" value=${card.expiry}
                  onChange=${(e) => { const d = digits(e.target.value, 4); setCard({ ...card, expiry: d.length > 2 ? d.slice(0, 2) + "/" + d.slice(2) : d }); }} /></div>
              <div className="label">Security code
                <input inputMode="numeric" autoComplete="off" placeholder="123" value=${card.cvc} onChange=${(e) => setCard({ ...card, cvc: digits(e.target.value, 4) })} /></div>
            </div>`}
          </div>
        </section>

        <details className="summary" open=${!phoneSheet}>
          <summary><span>Order summary · ${items} ${items === 1 ? "item" : "items"}</span><strong>${due}</strong></summary>
          <div className="lines">
            ${cart.map((it) => html`
              <div key=${it.key} className="line">
                <span>${it.qty} × ${it.name}${it.variantName ? ", " + it.variantName : ""}</span>
                <span>${money(it.unitCents * it.qty)}</span>
              </div>`)}
          </div>
          <dl>
            <div className="row"><dt>Subtotal</dt><dd>${money(subtotalCents)}</dd></div>
            ${taxCents != null ? html`<div className="row"><dt>Tax</dt><dd>${money(taxCents)}</dd></div>` : null}
          </dl>
        </details>
      </div>
      <div className="footer">
        ${msg && html`<p className="alert" role="alert">${msg}</p>`}
        <div className="due"><span>Total</span><strong>${due}</strong></div>
        <button className="place" disabled=${busy || !cart.length} onClick=${place}>
          ${busy ? "Placing order…" : "Place order"}
        </button>
      </div>
    </div>`;
}

//  Confirmation 
function Confirmation({ businessName, receipt, onBack }) {
  const { cart, note, payMethod, guestName, mode, memberInfo, orderNumber, orderId, totalCents, paid } = receipt;
  const name = mode === "guest" ? guestName : (memberInfo && memberInfo.firstName) || "there";
  // The order's real status, so a phone shows "Ready for pickup" without the customer asking; it stops once the order is over
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (!orderId) return;
    let stop = false;
    const t = setInterval(() => load(), 8000);
    const load = () => api(`/customer/orders/${orderId}`).then((o) => { if (stop) return; setLive(o); if ([5, 6, 7].includes(o.statusCode)) clearInterval(t); }).catch(() => {});
    load();
    return () => { stop = true; clearInterval(t); };
  }, [orderId]);
  const code = live?.statusCode;
  const stepIdx = code != null ? (STEP_OF[code] ?? -1) : paid ? 0 : -1; // -1: waiting for payment
  const [title, sub] = code === 6 ? ["Order cancelled", "This order was cancelled, for example because it wasn't paid in time. Place a new one any time."]
    : code === 4 ? ["Ready for pickup", "Your order is ready. Collect it at the counter."]
    : code === 5 || code === 7 ? ["Picked up", "Enjoy!"]
    : code === 3 ? ["Being prepared", "We're making your order now."]
    : paid || code === 2 ? ["Paid — your order is being prepared", paid ? `Paid with ${payMethod}. This is test mode, so nothing was charged for real.` : "We have your payment. Thank you."]
    : ["Order submitted — payment pending", "Pay the cashier at the counter within 15 minutes, and we'll start your order."];
  const where = `${businessName} · Pickup at this counter`;
  return html`
    <div className="confirm-overlay screen">
      <button className="close" aria-label="Close" onClick=${onBack}><${NavIcon} name="close" /></button>
      <div className="center">
        <${OrderStatus} where=${where} number=${orderNumber} cancelled=${code === 6} headline=${code === 6 ? "Order cancelled" : "Order received"}
          title=${title} sub=${sub} stepIdx=${stepIdx} note=${note}
          lines=${cart.map((it) => ({ label: `${it.qty} × ${it.name}${it.variantName ? ", " + it.variantName : ""}`, sub: it.options.join(", "), cents: it.unitCents * it.qty }))}
          rows=${[["Order total", totalCents != null ? money(totalCents) : "–"], ["Payment method", payMethod]]}>
          ${mode === "signed-in" && memberInfo && memberInfo.member && html`
            <div className="pts-row">
              <p>${paid ? "Points you'll earn at pickup" : "Points to be earned once paid"}: ~${Math.floor((totalCents || 0) / 100)} pts</p>
              <span className="badge">${paid ? "At pickup" : "Pending"}</span>
            </div>`}
          <button className="primary" onClick=${onBack}>Back to menu</button>
        <//>
      </div>
    </div>`;
}

// The order's status as one screen: a check, the number, what is happening now, a progress line, and the receipt. The confirmation and the order page both use it.
function OrderStatus({ where, number, headline, title, sub, stepIdx, cancelled, lines, note, rows, children }) {
  return html`
    <section className="status-card">
      <p className="where">${where}</p>
      <svg className=${"mark" + (cancelled ? " bad" : "")} viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d=${cancelled ? "M17 17l18 18M35 17L17 35" : "M15 27l8 8 14-16"}/></svg>
      <h1>${headline}</h1>
      <p className="num">#${number}</p>
      <div className="now">
        <p className="ttl when">${title}</p>
        ${sub && html`<p className="sub">${sub}</p>`}
      </div>
      ${!cancelled && html`
        <div className="steps">
          ${STATUS_STEPS.map((s, i) => html`
            <div key=${s} className=${"step" + (i < stepIdx ? " done" : i === stepIdx ? " current" : "")}>
              <span className="dot">${i < stepIdx ? html`<${NavIcon} name="check" />` : i + 1}</span>
              <p className="lbl">${s}</p>
            </div>`)}
        </div>`}
      <div className="receipt">
        <div className="lines">
          ${lines.map((l, i) => html`
            <div className="line" key=${i}>
              <span><span className="nm">${l.label}</span>${l.sub && html`<span className="opt">${l.sub}</span>`}</span>
              <span>${money(l.cents)}</span>
            </div>`)}
        </div>
        ${note && html`<p className="note"><span className="semi">Kitchen note:</span> ${note}</p>`}
        <dl>${rows.map(([k, v]) => html`<div className="row" key=${k}><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
      </div>
      ${children}
    </section>`;
}

// ---- Rewards catalog (points redemption not yet supported by backend) ------
function RewardsPage({ businessName, memberInfo, onBrowseMenu }) {
  return html`
    <div className="screen">
      <div style=${{ flex: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "24px", padding: "40px", textAlign: "center" }}>
        <h2 style=${{ fontSize: "24px", fontWeight: "600" }}>Redeem for store points</h2>
        <p style=${{ maxWidth: "480px", fontSize: "15px", color: "var(--muted)" }}>
          Points redemption is coming soon. Your points balance is safe and will be applied automatically
          when this feature is enabled by the store.
        </p>
        ${memberInfo.member
          ? html`<p style=${{ fontSize: "16px", fontWeight: "600" }}>Your balance: ${memberInfo.points} points</p>`
          : html`<p style=${{ fontSize: "14px", color: "var(--muted)" }}>You don't have a rewards account yet — ask a team member to enroll you.</p>`}
        <button style=${{ border: "1px solid var(--ink)", background: "var(--ink)", color: "#fff", padding: "12px 24px", fontSize: "16px", fontWeight: "600" }}
          onClick=${onBrowseMenu}>Browse Menu</button>
      </div>
    </div>`;
}


function Menu({ businessName, mode, memberInfo, hasOrders, openOrder, locationName, payHere, products, categories, cart, onAddItem, onChangeQty, onOrderPlaced, onOpenOrders, onExit }) {
  const [active, setActive] = useState(""); // the category whose section is at the top of the menu
  const [customizing, setCustomizing] = useState(null);
  const [note, setNote] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [lastOrder, setLastOrder] = useState(null);
  const [cartOpen, setCartOpen] = useState(false); // phones only: the cart is a full-screen sheet
  useEffect(() => { // Escape closes the pop-up window
    if (!(customizing || checkoutOpen || cartOpen)) return undefined;
    const onKey = (e) => { if (e.key === "Escape") { if (checkoutOpen) setCheckoutOpen(false); else if (customizing) setCustomizing(null); else setCartOpen(false); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [customizing, checkoutOpen, cartOpen]);

  // The menu is one page of sections, a heading and a grid per category, with a bar that jumps to each; the bar follows the scroll
  const available = products.filter((p) => p.variants.some((v) => v.available));
  const names = [...categories, ...(available.some((p) => !categories.includes(p.category)) ? ["Other"] : [])];
  const sections = names.map((name) => [name, available.filter((p) => (categories.includes(p.category) ? p.category : "Other") === name)]).filter(([, list]) => list.length);
  const slug = (name) => "cat-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const sectionKey = sections.map(([name]) => name).join("|");
  const current = active && sections.some(([name]) => name === active) ? active : sections[0]?.[0];
  const jump = (name) => {
    setActive(name); heldUntil.current = Date.now() + 900;
    document.getElementById(slug(name))?.scrollIntoView?.({ block: "start", behavior: "smooth" }); // needs enough content below to travel; the sections are padded for that
  };
  const heldUntil = useRef(0); // after a tap on the bar, the tapped category stays current until the page has settled
  useEffect(() => {
    if (sections.length < 2) return undefined;
    let frame = 0;
    const onScroll = (e) => {
      if (frame || Date.now() < heldUntil.current) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const t = e.target;
        const atEnd = t?.scrollHeight && t.scrollTop + t.clientHeight >= t.scrollHeight - 2; // a last section too short to reach the top still counts
        let found = atEnd ? sections[sections.length - 1][0] : sections[0][0];
        if (!atEnd) for (const [name] of sections) { const el = document.getElementById(slug(name)); if (el && el.getBoundingClientRect().top <= 140) found = name; }
        setActive(found);
      });
    };
    document.addEventListener("scroll", onScroll, true); // scroll events don't bubble; the menu's own scroller is not known here
    return () => { document.removeEventListener("scroll", onScroll, true); cancelAnimationFrame(frame); };
  }, [sectionKey]);
  useEffect(() => { document.querySelector(".cats [aria-current=true]")?.scrollIntoView?.({ inline: "nearest", block: "nearest" }); }, [current]);
  const cartTotal = cart.reduce((a, it) => a + it.unitCents * it.qty, 0);

  const addItem = (item) => { onAddItem(item); setCustomizing(null); };


  const customizeEl = customizing && html`<${Customize} product=${customizing} img=${customizing.hasPhoto ? `/api/customer/products/${customizing.id}/photo` : productImg(available.indexOf(customizing))}
      onAdd=${addItem} onCancel=${() => setCustomizing(null)} />`;
  const checkoutEl = checkoutOpen && html`<${Checkout} businessName=${businessName} cart=${cart} mode=${mode} memberInfo=${memberInfo} locationName=${locationName} payHere=${payHere}
      note=${note} onNoteChange=${setNote}
      onBack=${() => setCheckoutOpen(false)}
      onOrderPlaced=${(r) => { setLastOrder(r); setCheckoutOpen(false); setCartOpen(false); onOrderPlaced(r); setNote(""); }} />`;

  if (lastOrder) {
    return html`<${Confirmation} businessName=${businessName} receipt=${lastOrder} onBack=${() => setLastOrder(null)} />`;
  }

  return html`
    <div className=${customizing || checkoutOpen ? "screen has-popup" : "screen"}>
      <div className="menu-body">
        <section className="menu-main">
          ${sections.length > 1 && html`<nav className="cats" aria-label="Menu categories">
            ${sections.map(([name]) => html`<button key=${name} aria-current=${name === current ? "true" : undefined} onClick=${() => jump(name)}>${name}</button>`)}
          </nav>`}
          ${sections.map(([name, list]) => html`<section key=${name} id=${slug(name)} data-cat=${name} className="cat-section" aria-label=${sections.length > 1 ? name : "Menu"}>
            ${sections.length > 1 && html`<h2 className="cat-title">${name}</h2>`}
            <div className="grid">
              ${list.map((p) => html`
                <article key=${p.id} className="tile">
                  <button className="pick" aria-label=${"Add " + p.name} onClick=${() => setCustomizing(p)}>
                    <img src=${p.hasPhoto ? `/api/customer/products/${p.id}/photo` : productImg(available.indexOf(p))} alt="" loading="lazy" />
                    <h3>${p.name}</h3>
                  </button>
                </article>`)}
            </div>
          </section>`)}
        </section>

        ${cart.length > 0 && html`
          <button className="cart-bar" onClick=${() => setCartOpen(true)}>
            <span className="lbl"><b className="count">${cart.reduce((a, it) => a + it.qty, 0)}</b>View order</span><span>${money(cartTotal)}</span>
          </button>`}

        <aside className=${"cart" + (cartOpen ? " open" : "") + (cart.length > 0 && !customizing && !checkoutOpen ? " shown" : "")}>
          <div className="cart-head">
            <h2>Your order</h2>
            <button className="cart-close" aria-label="Keep browsing" onClick=${() => setCartOpen(false)}><${NavIcon} name="close" /></button>
          </div>
          <div className="items">
            ${cart.length === 0 ? html`<p className="empty">Your order is empty.</p>`
              : cart.map((it) => html`
                <div key=${it.key} className="line">
                  <div className="info">
                    <p className="nm">${it.name}${it.variantName ? ", " + it.variantName : ""}</p>
                    ${it.options.length > 0 && html`<p className="opts">${it.options.join(", ")}</p>`}
                    <p className="pr">${money(it.unitCents * it.qty)}</p>
                  </div>
                  <div className="qty">
                    <button aria-label=${"Remove one " + it.name} onClick=${() => onChangeQty(it.key, -1)}>−</button>
                    <span>${it.qty}</span>
                    <button aria-label=${"Add one " + it.name} onClick=${() => onChangeQty(it.key, 1)}>+</button>
                  </div>
                </div>`)}
          </div>
          <div className="totals">
            <div className="row dollar"><span>Subtotal</span><span>${money(cartTotal)}</span></div>
            ${openOrder && html`<p className="held" role="status">Order #${openOrder.orderNumber} is still in progress. You can order again once it has been picked up.</p>`}
            <button className="checkout" disabled=${cart.length === 0 || !!openOrder} onClick=${() => { setCartOpen(false); setCheckoutOpen(true); }}>Checkout</button>
          </div>
        </aside>
      </div>
      ${customizeEl}
      ${checkoutEl}
    </div>`;
}

//  Order history 
function OrderHistory({ businessName, memberInfo, guestIds, onBackToMenu, onExit, onOpenOrder }) {
  const [orders, setOrders] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (memberInfo) return void api("/customer/my-orders").then((d) => setOrders(d.orders)).catch((e) => setErr(e.message));
    // a guest has no account: each order of this visit is looked up by its unguessable id
    Promise.all(guestIds.map((id) => api(`/customer/orders/${id}`).catch(() => null))).then((all) => setOrders(all.filter(Boolean)));
  }, []);

  const ACTIVE = new Set(["Confirmed","Preparing","Ready for pickup"]);
  const sorted = orders ? [...orders].sort((a, b) => {
    const aa = ACTIVE.has(a.status), bb = ACTIVE.has(b.status);
    if (aa !== bb) return aa ? -1 : 1;
    return new Date(b.placedAt) - new Date(a.placedAt);
  }) : [];

  return html`
    <div className="history screen">
      <div className="body">
        <div className="intro">
          <p>${memberInfo ? `${memberInfo.firstName} · Signed-in order history` : "Orders you placed on this phone this visit"}</p>
          <h2>Your Orders</h2>
        </div>
        ${err && html`<p className="alert" role="alert">${err}</p>`}
        ${orders === null && !err && html`<p className="loading">Loading…</p>`}
        ${orders && orders.length === 0 && html`
          <div className="empty-state">
            <div>
              <h3>No orders yet</h3>
              <p>${memberInfo ? "Orders placed with this phone number will appear here." : "Orders you place will appear here."}</p>
              <button onClick=${onBackToMenu}>Start an order</button>
            </div>
          </div>`}
        ${sorted.map((o) => html`
          <button key=${o.id} className="order-card" onClick=${() => onOpenOrder(o.id)}>
            <div className="main">
              <div className="top"><h3>Order #${o.orderNumber}</h3><span className="badge">${o.status}</span></div>
              <p className="meta">${fmt(o.placedAt, o.tz)}</p>
            </div>
            <div className="right">
              <p>${money(Math.round(o.total * 100))}</p>
              ${memberInfo && (o.earned > 0 ? html`<p className="pts">${o.earned} pts earned</p>` : html`<p className="pts">Points pending</p>`)}
            </div>
          </button>`)}
      </div>
    </div>`;
}

//  Order details (status) 
const STATUS_STEPS = ["Confirmed","Preparing","Ready","Picked up"];
const STEP_OF = { 2: 0, 3: 1, 4: 2, 5: 3, 7: 3 }; // the order's status code -> its step; the status wording changes ("Ready for pickup"), the code does not
function OrderDetails({ businessName, orderId, memberInfo, onBackToHistory, onBackToMenu, onExit }) {
  const [order, setOrder] = useState(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api(`/customer/orders/${orderId}`).then(setOrder).catch((e) => setErr(e.message));
  }, [orderId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  if (err) return html`<div className="error-page"><h2>Could not load order</h2><p>${err}</p><button onClick=${load}>Try again</button></div>`;
  if (!order) return html`<div className="loading">Loading…</div>`;

  const code = order.statusCode;
  const stepIdx = STEP_OF[code] ?? -1; // -1: waiting for payment, or cancelled
  const when = code === 6 ? "Order cancelled"
    : code === 4 ? "Ready for pickup"
    : code === 5 || code === 7
      ? (order.completedAt ? `Picked up at: ${fmt(order.completedAt, order.tz)}` : code === 7 ? "Order refunded" : "Picked up")
      : `Estimated ready time: ${fmt(new Date(new Date(order.placedAt).getTime() + 7 * 60 * 1000), order.tz)}`;

  return html`
    <div className="details screen">
      <div className="body">
        <${OrderStatus} where=${businessName} number=${order.orderNumber} cancelled=${code === 6} headline="Your order"
          title=${when} stepIdx=${stepIdx}
          lines=${order.items.map((it) => ({ label: `${it.qty} × ${it.name}`, cents: Math.round(it.lineTotal * 100) }))}
          rows=${[["Order total", money(Math.round(order.total * 100))]]}>
          ${onBackToHistory ? html`<button className="link" onClick=${onBackToHistory}>Back to order history</button>` : null}
        <//>
      </div>
    </div>`;
}

// A floating card for the customer's order that is still in progress: its number and status, and a tap opens it
const ISLAND_WORDS = { 1: "Waiting for payment", 2: "Confirmed", 3: "Being prepared", 4: "Ready for pickup" };
function StatusIsland({ order, onOpen }) {
  const idx = STEP_OF[order.statusCode] ?? -1;
  return html`<button className=${"island s" + order.statusCode} onClick=${onOpen} aria-live="polite">
    <span className="pulse"></span>
    <span className="txt"><b>Order #${order.orderNumber}</b><span>${ISLAND_WORDS[order.statusCode] || order.status}</span></span>
    <span className="mini">${STATUS_STEPS.map((s, i) => html`<i key=${s} className=${i <= idx ? "on" : ""}></i>`)}</span>
  </button>`;
}

//  App shell 
// This iPad is shared: with no touches for IDLE_MS (30 seconds once an order has been placed) the customer is signed out
// and the cart cleared. The server ends the session after 5 minutes by itself (server/customers.js).
const IDLE_MS = 2 * 60 * 1000, IDLE_AFTER_ORDER_MS = 30 * 1000, TOUCH_EVERY_MS = 20 * 1000;
// Only on a shared screen (the server says so with KIOSK_SHARED_DEVICE=1). On a customer's own phone nobody is signed out while
// they wait for their order.
const GUEST_KEY = "guestOrders"; // ids of the orders a guest placed in this browser tab; the tab's session storage forgets them when it closes
const savedGuestOrders = () => { try { return JSON.parse(sessionStorage.getItem(GUEST_KEY)) || []; } catch (e) { return []; } };
const saveGuestOrders = (ids) => { try { sessionStorage.setItem(GUEST_KEY, JSON.stringify(ids)); } catch (e) { /* storage can be blocked */ } };
function App() {
  const [guestOrders, setGuestOrders] = useState(savedGuestOrders);
  const [ctx, setCtx] = useState(null);  // { businessName, locationName }
  const [catalog, setCatalog] = useState(null);
  const [view, setView] = useState("entry"); // entry | menu | history | order | rewards
  const [mode, setMode] = useState(null);  // "guest" | "signed-in"
  const [memberInfo, setMemberInfo] = useState(null);
  const [cart, setCart] = useState([]);
  const [openOrderId, setOpenOrderId] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [active, setActive] = useState(null); // this customer's order still in progress, kept fresh while they are past the entry screen

  // Check if a customer session already exists (e.g. page refresh mid-session)
  useEffect(() => {
    if (!LOCATION_ID) { setLoadErr("Scan your café's QR code to order."); return; }
    Promise.all([
      api("/customer/context"),
      api("/customer/catalog"),
      api("/customer/session"),
    ]).then(([c, cat, sess]) => {
      setCtx(c);
      setCatalog(cat);
      if (sess.signedIn) { setMode("signed-in"); setMemberInfo(sess); setView("menu"); }
    }).catch((e) => setLoadErr(e.message));
  }, []);

  const refreshActive = () => api("/customer/active-order").then((d) => setActive(d.order || null)).catch(() => {});
  useEffect(() => {
    if (view === "entry") { setActive(null); return undefined; }
    refreshActive();
    const t = setInterval(refreshActive, 10000);
    document.addEventListener("visibilitychange", refreshActive);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", refreshActive); };
  }, [view === "entry", mode]);
  useEffect(() => { document.body.classList.toggle("has-island", !!active && view !== "entry"); }, [active, view]);

  const idleLimit = useRef(IDLE_MS);
  const signOut = async () => {
    idleLimit.current = IDLE_MS;
    await post("/customer/logout", {}).catch(() => {});
    setMode(null); setMemberInfo(null); setCart([]); setView("entry"); setOpenOrderId(null); setActive(null);
    if (ctx?.sharedDevice) { setGuestOrders([]); saveGuestOrders([]); } // the next person on a shared screen must not see these
  };
  const orderPlaced = (r) => {
    setCart([]); idleLimit.current = IDLE_AFTER_ORDER_MS; setTimeout(refreshActive, 300);
    if (mode === "guest" && r?.orderId) setGuestOrders((prev) => { const next = [r.orderId, ...prev]; saveGuestOrders(next); return next; });
  };

  const shared = !!ctx?.sharedDevice;
  const touchedAt = useRef(Date.now()), lastTouch = useRef(0);
  useEffect(() => {
    const touch = () => {
      touchedAt.current = Date.now();
      if (shared && mode === "signed-in" && Date.now() - lastTouch.current >= TOUCH_EVERY_MS) { lastTouch.current = Date.now(); post("/customer/touch", {}).catch(() => {}); }
    };
    const events = ["pointerdown", "keydown", "wheel"];
    events.forEach((e) => document.addEventListener(e, touch, true));
    const t = shared && setInterval(() => { if (view !== "entry" && Date.now() - touchedAt.current >= idleLimit.current) signOut(); }, 1000);
    return () => { events.forEach((e) => document.removeEventListener(e, touch, true)); clearInterval(t); };
  }, [view, mode, shared]);

  const onSignedIn = (info) => { setMode("signed-in"); setMemberInfo(info); setView("menu"); };
  const onGuest = () => { setMode("guest"); setMemberInfo(null); setView("menu"); };

  const addItem = (item) => {
    setCart((prev) => {
      const ex = prev.find((it) => it.key === item.key);
      return ex ? prev.map((it) => it.key === item.key ? { ...it, qty: it.qty + item.qty } : it)
                : [...prev, item];
    });
  };
  const changeQty = (key, delta) => {
    setCart((prev) => prev.map((it) => it.key === key ? { ...it, qty: it.qty + delta } : it).filter((it) => it.qty > 0));
  };

  if (loadErr) return html`
    <div className="error-page"><h2>Could not connect</h2><p>${loadErr}</p>
      <button onClick=${() => location.reload()}>Retry</button></div>`;

  if (!ctx || !catalog) return html`<div className="loading">Loading…</div>`;

  if (view === "entry") return html`
    <${Entry} businessName=${ctx.businessName} locationName=${ctx.locationName}
      phoneSignIn=${ctx.phoneSignIn} onGuest=${onGuest} onSignedIn=${onSignedIn} />`;

  // Everything after the entry screen sits in the navigation's shell: the menu beside (or above, on a phone) the page
  const current = view === "history" || view === "order" ? "orders" : view === "rewards" ? "rewards" : "menu";
  const shell = (content) => html`<div className="shell">
    <${CustomerNav} businessName=${ctx.businessName} locationName=${ctx.locationName} mode=${mode} memberInfo=${memberInfo} current=${current}
      canOrders=${mode === "signed-in" || guestOrders.length > 0}
      onMenu=${() => setView("menu")} onOrders=${() => setView("history")} onRewards=${() => setView("rewards")} onExit=${signOut} />
    <main className="page">${content}</main>
    ${active && !(view === "order" && openOrderId === active.id) && html`<${StatusIsland} order=${active} onOpen=${() => { setOpenOrderId(active.id); setView("order"); }} />`}</div>`;

  if (view === "history") return shell(html`
    <${OrderHistory} businessName=${ctx.businessName} memberInfo=${memberInfo} guestIds=${guestOrders}
      onBackToMenu=${() => setView("menu")}
      onExit=${signOut}
      onOpenOrder=${(id) => { setOpenOrderId(id); setView("order"); }} />`);

  if (view === "order") return shell(html`
    <${OrderDetails} businessName=${ctx.businessName} orderId=${openOrderId} memberInfo=${memberInfo}
      onBackToHistory=${() => setView("history")}
      onBackToMenu=${() => setView("menu")}
      onExit=${signOut} />`);

  if (view === "rewards") return shell(html`
    <${RewardsPage} businessName=${ctx.businessName} memberInfo=${memberInfo} onBrowseMenu=${() => setView("menu")} />`);

  return shell(html`
    <${Menu} businessName=${ctx.businessName}
      mode=${mode} memberInfo=${memberInfo} hasOrders=${guestOrders.length > 0} openOrder=${active}
      locationName=${ctx.locationName} payHere=${ctx.payHere}
      products=${catalog.products} categories=${catalog.categories}
      cart=${cart}
      onAddItem=${addItem}
      onChangeQty=${changeQty}
      onOrderPlaced=${orderPlaced}
      onOpenOrders=${() => setView("history")}
      onExit=${signOut} />`);
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);

