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
function Entry({ businessName, locationName, phoneSignIn, onGuest, onSignedIn }) {
  const [phone, setPhone] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const logIn = async () => {
    const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); // same rule as the server
    if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) { setMsg("Enter a valid 10-digit US phone number."); return; }
    setBusy(true); setMsg("");
    try {
      const d = await post("/customer/login", { phone: digits });
      onSignedIn(d);
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  return html`
    <div className="entry">
      <div className="topbar"><p>${businessName}</p></div>
      <div className="body">
        <div className="wrap">
          <div className="hero">
            <h1>${businessName}</h1>
            <h2>How would you like to order?</h2>
            <p>${phoneSignIn ? "Log in to your account or continue as a guest." : "Continue as a guest to place an order."}</p>
          </div>
          <div className="cards">
            ${phoneSignIn && html`<section className="card">
              <div>
                <h3>Customer login</h3>
                <p className="sub">Use your customer account to order.</p>
              </div>
              <label>Phone Number
                <input inputMode="tel" autoComplete="tel" maxLength="20" value=${phone}
                  onChange=${(e) => { setPhone(e.target.value); setMsg(""); }} />
              </label>
              ${msg && html`<p className="alert" role="alert">${msg}</p>`}
              <button className="login" disabled=${busy} onClick=${logIn}>Log In</button>
              <button className="restart" onClick=${() => { setPhone(""); setMsg(""); }}>Start Over</button>
            </section>`}
            <section className="card">
              <div>
                <h3>Continue as a guest</h3>
                <p className="sub">No account needed. Browse the menu and place an order for pickup.</p>
              </div>
              <button className="guest" onClick=${onGuest}>Order as Guest</button>
            </section>
          </div>
          <p className="sub">${locationName}</p>
        </div>
      </div>
    </div>`;
}
//  Product customize panel 
function Customize({ product, cart, headerActions, onAdd, onCancel }) {
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
    <div className="customize">
      <div className="header">
        <h1>${product.name}</h1>
        ${headerActions}
        <button className="back-menu" onClick=${onCancel}>Back to menu</button>
      </div>
      <div className="body">
        <section className="form">
          <h2>${product.name}</h2>
          ${product.description && html`<p className="reg" style=${{ fontSize: "14px", color: "var(--muted)" }}>${product.description}</p>`}

          ${variants.length > 1 && html`
            <fieldset className="fieldset">
              <div className="legend"><span className="semi">Size</span><span className="req">· required</span></div>
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
                  <span className="req">· ${isRadio ? "choose 1" : "choose up to " + (g.max || 255)}</span></div>
                <div className="opt-list">
                  ${g.modifiers.map((m) => {
                    const on = sel.has(m.id);
                    const atLimit = !on && sel.size >= (g.max || 255);
                    return html`
                    <div key=${m.id} className=${"opt" + (atLimit ? " disabled" : "")}>
                      <label>
                        <input type=${isRadio ? "radio" : "checkbox"} className="sr-only" style=${{ position: "absolute", width: "1px", height: "1px", opacity: "0" }}
                          name=${"g" + g.id} checked=${on} disabled=${atLimit}
                          onChange=${() => isRadio ? setRadio(g, m) : toggle(g, m)} />
                        ${on ? html`<img src=${isRadio ? "/img/customer/option-radio.svg" : "/img/customer/option-checkbox.svg"} alt="" />`
                             : html`<span className=${"box" + (isRadio ? " radio" : "")}></span>`}
                        <span className="name">${m.name}</span>
                        <span className="delta">${m.deltaCents === 0 ? "included" : "+" + money(m.deltaCents)}</span>
                      </label>
                    </div>`;
                  })}
                </div>
              </fieldset>`;
          })}

          <div className="footer">
            ${!canAdd && html`<p className="need" role="alert">Choose a size and all required options before adding this item.</p>`}
            <div className="actions">
              <div className="qty-ctrl">
                <button aria-label="Decrease quantity" disabled=${qty === 1} onClick=${() => setQty(Math.max(1, qty - 1))}>−</button>
                <span>${qty}</span>
                <button aria-label="Increase quantity" onClick=${() => setQty(qty + 1)}>+</button>
              </div>
              <p className="item-total">Item total ${money(itemTotal)}</p>
              <button className="cancel" onClick=${onCancel}>Cancel</button>
              <button className="confirm" disabled=${!canAdd} onClick=${confirm}>Add to my order</button>
            </div>
          </div>
        </section>

        <aside className="order-side">
          <h2>Your order</h2>
          <div className="items">
            ${cart.length === 0 ? html`<p className="empty">Your order is empty.</p>`
              : cart.map((it) => html`
                <div className="line" key=${it.key}>
                  <span>${it.qty} × ${it.name}${it.variantName ? ", " + it.variantName : ""}</span>
                  ${it.options.length > 0 && html`<span style=${{ fontSize: "12px", color: "var(--muted)", paddingLeft: "16px" }}>${it.options.join(", ")}</span>`}
                </div>`)}
          </div>
          <div className="sub"><span>Subtotal</span><span>${money(cart.reduce((a, it) => a + it.unitCents * it.qty, 0))}</span></div>
        </aside>
      </div>
    </div>`;
}
//  Shared header actions 
function HeaderActions({ canOpenOrders, onOpenOrders, onExit }) {
  return html`<div className="actions">
    ${canOpenOrders && html`<button onClick=${onOpenOrders}>Your Orders</button>`}
    <button className="exit" onClick=${onExit}>Back to Customer Login</button>
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

  return html`
    <div className="checkout-overlay screen">
      <div className="header">
        <h1>${businessName}</h1>
        <button className="back-menu" onClick=${onBack}>Back to menu</button>
      </div>
      <div className="body">
        <section className="form">
          <h2>Review your order</h2>

          <div className="section gap3">
            <h3>1. ${mode === "guest" ? "Guest details" : "Account"}</h3>
            ${mode === "guest" ? html`<${React.Fragment}>
              <p className="reg" style=${{ fontSize: "14px", color: "var(--muted)" }}>Checking out as a guest</p>
              <div className="label maxw">Name for the order
                <input placeholder="Enter your first name" value=${guestName}
                  onChange=${(e) => setGuestName(e.target.value)} />
              </div><//>` : html`
              <p className="semi" style=${{ fontSize: "16px" }}>${memberInfo.firstName} · ${memberInfo.maskedPhone}</p>`}
          </div>

          <div className="section gap3 bordered">
            <h3>2. Pickup</h3>
            <div style=${{ fontSize: "14px", color: "var(--muted)" }}>
              <p>Pickup at this counter</p>
              <p>We'll prepare your order after payment.</p>
            </div>
            <div className="label">Note for the kitchen (optional)
              <input maxLength="120" value=${note} onChange=${(e) => onNoteChange(e.target.value)} />
            </div>
          </div>

          <div className="section gap3 bordered">
            <h3>3. Payment</h3>
            <p className="reg" style=${{ fontSize: "14px", color: "var(--muted)" }}>${payHere ? "Test mode: Card, Apple Pay and Google Pay are not charged for real. Cash is paid at the counter." : "Pay with cash at the counter when you pick up."}</p>
            <div className="methods">
              ${(payHere ? ["Cash", "Card", "Apple Pay", "Google Pay"] : ["Cash"]).map((m) => html`
                <button key=${m} className=${"method" + (payMethod === m ? " on" : "")}
                  onClick=${() => setPayMethod(m)}>${m}</button>`)}
            </div>
            ${payMethod === "Card" && html`<div className="gap3">
              <div className="label maxw">Card number
                <input inputMode="numeric" autoComplete="off" placeholder="4242 4242 4242 4242" value=${card.number}
                  onChange=${(e) => setCard({ ...card, number: e.target.value })} /></div>
              <div className="label maxw">Expiry (MM/YY)
                <input autoComplete="off" placeholder="12/30" value=${card.expiry} onChange=${(e) => setCard({ ...card, expiry: e.target.value })} /></div>
              <div className="label maxw">Security code
                <input inputMode="numeric" autoComplete="off" placeholder="123" value=${card.cvc} onChange=${(e) => setCard({ ...card, cvc: e.target.value })} /></div>
            </div>`}
          </div>
        </section>

        <aside className="summary">
          <h2>Order summary</h2>
          <div className="lines">
            ${cart.map((it) => html`
              <div key=${it.key} style=${{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                <span>${it.qty} × ${it.name}${it.variantName ? ", " + it.variantName : ""}</span>
                <span style=${{ flexShrink: "0" }}>${money(it.unitCents * it.qty)}</span>
              </div>`)}
          </div>
          <dl>
            <div className="row"><dt>Subtotal</dt><dd>${money(subtotalCents)}</dd></div>
            ${taxCents != null ? html`<div className="row"><dt>Tax</dt><dd>${money(taxCents)}</dd></div>` : null}
          </dl>
          <dl className="total">
            <div className="row grand"><dt>Order total</dt><dd>${totalCents != null ? money(totalCents) : "…"}</dd></div>
            <div className="row"><dt>Payment method</dt><dd>${payMethod || "Not selected"}</dd></div>
          </dl>
          ${msg && html`<p className="alert" role="alert">${msg}</p>`}
          <button className="place" disabled=${busy || !cart.length} onClick=${place}>
            ${busy ? "Placing order…" : "Place order"}
          </button>
          <p className="hint">${payMethod === "Cash" ? "You'll pay at the counter." : "Test mode: nothing is charged for real."}</p>
        </aside>
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
  return html`
    <div className="confirm-overlay screen">
      <div className="bar">
        <p className="semi" style=${{ fontSize: "16px" }}>Order confirmation</p>
        <button className="back" onClick=${onBack}>Back to menu</button>
      </div>
      <div className="center">
        <section className="card">
          <p className="where">${businessName} · Pickup at this counter</p>
          <h1>Order received</h1>
          <p className="thanks">Thanks, ${name}. ${paid ? "We're preparing your order." : "We'll prepare your order after payment."}</p>
          <div className="lines">
            ${cart.map((it) => html`
              <div className="line" key=${it.key}>
                <span>
                  <span style=${{ display: "block" }}>${it.qty} × ${it.name}${it.variantName ? ", " + it.variantName : ""}</span>
                  ${it.options.length > 0 && html`<span style=${{ display: "block", fontSize: "12px", color: "var(--muted)" }}>${it.options.join(", ")}</span>`}
                </span>
                <span style=${{ flexShrink: "0" }}>${money(it.unitCents * it.qty)}</span>
              </div>`)}
          </div>
          ${note && html`<p style=${{ fontSize: "14px", marginBottom: "16px" }}><span className="semi">Kitchen note:</span> ${note}</p>`}
          <dl>
            <div className="row"><dt>Order total</dt><dd>${totalCents != null ? money(totalCents) : "–"}</dd></div>
            <div className="row"><dt>Payment method</dt><dd>${payMethod}</dd></div>
            <div className="row"><dt>Order number</dt><dd>#${orderNumber}</dd></div>
          </dl>
          <div className="pending-box">
            <p className="ttl">${title}</p>
            <p className="sub">${sub}</p>
          </div>
          ${code !== 6 && html`
            <div className="steps">
              ${STATUS_STEPS.map((s, i) => html`
                <div key=${s} className=${"step" + (i < stepIdx ? " done" : i === stepIdx ? " current" : "")}>
                  <p className="lbl">${s}</p>
                </div>`)}
            </div>`}
          ${mode === "signed-in" && memberInfo && memberInfo.member && html`
            <div className="pts-row">
              <p>${paid ? "Points you'll earn at pickup" : "Points to be earned once paid"}: ~${Math.floor((totalCents || 0) / 100)} pts</p>
              <span className="badge">${paid ? "At pickup" : "Pending"}</span>
            </div>`}
        </section>
      </div>
    </div>`;
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


// Phones and small tablets (the same 900px the stylesheet switches at): customizing an item and checking out are pop-up windows over the menu
const NARROW = "(max-width: 900px)";
function useNarrow() {
  const q = window.matchMedia ? window.matchMedia(NARROW) : { matches: false, addEventListener() {}, removeEventListener() {} }; // jsdom has no media queries
  const [narrow, setNarrow] = useState(q.matches);
  useEffect(() => { const f = () => setNarrow(q.matches); q.addEventListener("change", f); return () => q.removeEventListener("change", f); }, []);
  return narrow;
}

function Menu({ businessName, mode, memberInfo, hasOrders, locationName, payHere, products, categories, cart, onAddItem, onChangeQty, onOrderPlaced, onOpenOrders, onExit }) {
  const [cat, setCat] = useState("All");
  const [customizing, setCustomizing] = useState(null);
  const [note, setNote] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [lastOrder, setLastOrder] = useState(null);
  const [cartOpen, setCartOpen] = useState(false); // phones only: the cart is a full-screen sheet
  const narrow = useNarrow();
  useEffect(() => { // Escape closes the pop-up window
    if (!narrow || !(customizing || checkoutOpen)) return undefined;
    const onKey = (e) => { if (e.key === "Escape") { if (checkoutOpen) setCheckoutOpen(false); else setCustomizing(null); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [narrow, customizing, checkoutOpen]);

  const visible = products.filter((p) => (cat === "All" || p.category === cat) && p.variants.some((v) => v.available));
  const cartTotal = cart.reduce((a, it) => a + it.unitCents * it.qty, 0);

  const addItem = (item) => { onAddItem(item); setCustomizing(null); };

  const headerActions = html`<${HeaderActions} canOpenOrders=${mode === "signed-in" || hasOrders} onOpenOrders=${onOpenOrders} onExit=${onExit} />`;

  const customizeEl = customizing && html`<${Customize} product=${customizing} cart=${cart} headerActions=${headerActions}
      onAdd=${addItem} onCancel=${() => setCustomizing(null)} />`;
  const checkoutEl = checkoutOpen && html`<${Checkout} businessName=${businessName} cart=${cart} mode=${mode} memberInfo=${memberInfo} locationName=${locationName} payHere=${payHere}
      note=${note} onNoteChange=${setNote}
      onBack=${() => setCheckoutOpen(false)}
      onOrderPlaced=${(r) => { setLastOrder(r); setCheckoutOpen(false); onOrderPlaced(r); setNote(""); }} />`;
  if (!narrow && customizeEl) return customizeEl; // a wide screen shows them full-screen, a narrow one as a window over the menu below
  if (!narrow && checkoutEl) return checkoutEl;

  if (lastOrder) {
    return html`<${Confirmation} businessName=${businessName} receipt=${lastOrder} onBack=${() => setLastOrder(null)} />`;
  }

  return html`
    <div className=${narrow && (customizing || checkoutOpen) ? "screen has-popup" : "screen"}>
      <div className="menu-body">
        <section className="menu-main">
          <h2>Order</h2>
          <div className="filters">
            ${["All", ...categories].map((c) => html`
              <button key=${c} className=${cat === c ? "on" : ""} onClick=${() => setCat(c)}>${c}</button>`)}
          </div>
          <div className="grid">
            ${visible.map((p, i) => html`
              <article key=${p.id} className="tile">
                <img src=${p.hasPhoto ? `/api/customer/products/${p.id}/photo` : productImg(i)}
                  alt=${p.name} loading="lazy" />
                <h3>${p.name}</h3>
                <p className="desc">${p.description || ""}</p>
                <div className="row">
                  <span className="price">${money(Math.min(...p.variants.filter((v) => v.available).map((v) => v.priceCents)))}</span>
                  <button className="add" onClick=${() => setCustomizing(p)}>Add</button>
                </div>
              </article>`)}
          </div>
        </section>

        ${cart.length > 0 && html`
          <button className="cart-bar" onClick=${() => setCartOpen(true)}>
            <span>View order · ${cart.reduce((a, it) => a + it.qty, 0)} items</span><span>${money(cartTotal)}</span>
          </button>`}

        <aside className=${"cart" + (cartOpen ? " open" : "")}>
          <div className="cart-head">
            <h2>Your order</h2>
            <button className="cart-close" onClick=${() => setCartOpen(false)}>Keep browsing</button>
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
          <div className="note">Note for the barista (optional)
            <input maxLength="120" value=${note} onChange=${(e) => setNote(e.target.value)} />
          </div>
          <div className="totals">
            <div className="row dollar"><span>Subtotal</span><span>${money(cartTotal)}</span></div>
            <button className="checkout" disabled=${cart.length === 0} onClick=${() => setCheckoutOpen(true)}>Checkout</button>
          </div>
        </aside>
      </div>
      ${narrow && customizeEl}
      ${narrow && checkoutEl}
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

  const stepIdx = STEP_OF[order.statusCode] ?? -1; // -1: waiting for payment, or cancelled

  return html`
    <div className="details screen">
      <div className="body">
        <div className="card">
          <p className="thanks">Thanks, ${memberInfo ? memberInfo.firstName : "there"}. Your order is in.</p>
          <div className="num-row">
            <h2>Order #${order.orderNumber}</h2>
          </div>
          ${order.statusCode === 6 ? html`<p className="thanks">This order was cancelled.</p>` : html`<div className="steps">
            ${STATUS_STEPS.map((s, i) => html`
              <div key=${s} className=${"step" + (i < stepIdx ? " done" : i === stepIdx ? " current" : "")}>
                <p className="lbl">${s}</p>
              </div>`)}
          </div>`}
        </div>

        <div className="card">
          <p className="where">${businessName}</p>
          <p className="when">${order.statusCode === 6 ? "Order cancelled"
            : order.statusCode === 4 ? "Ready for pickup"
            : order.statusCode === 5 || order.statusCode === 7
              ? (order.completedAt ? `Picked up at: ${fmt(order.completedAt, order.tz)}` : order.statusCode === 7 ? "Order refunded" : "Picked up")
              : `Estimated ready time: ${fmt(new Date(new Date(order.placedAt).getTime() + 7 * 60 * 1000), order.tz)}`}</p>
        </div>

        <div className="card">
          <h3>What you ordered</h3>
          <div className="lines">
            ${order.items.map((it, i) => html`
              <div className="line" key=${i}>
                <span>${it.qty} × ${it.name}</span>
                <span>${money(Math.round(it.lineTotal * 100))}</span>
              </div>`)}
          </div>
          <dl>
            <div className="row"><dt>Order total</dt><dd>${money(Math.round(order.total * 100))}</dd></div>
          </dl>
        </div>

        ${onBackToHistory ? html`
          <button className="back-link" onClick=${onBackToHistory}>Back to order history</button>` : null}
      </div>
    </div>`;
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

  const idleLimit = useRef(IDLE_MS);
  const signOut = async () => {
    idleLimit.current = IDLE_MS;
    await post("/customer/logout", {}).catch(() => {});
    setMode(null); setMemberInfo(null); setCart([]); setView("entry"); setOpenOrderId(null);
    if (ctx?.sharedDevice) { setGuestOrders([]); saveGuestOrders([]); } // the next person on a shared screen must not see these
  };
  const orderPlaced = (r) => {
    setCart([]); idleLimit.current = IDLE_AFTER_ORDER_MS;
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
    <main className="page">${content}</main></div>`;

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
      mode=${mode} memberInfo=${memberInfo} hasOrders=${guestOrders.length > 0}
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

