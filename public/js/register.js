const REASONS = ["Regular", "Employee", "Complaint", "Damaged"];
const METHODS = [["cash", "Cash"], ["card", "Card"], ["gift", "Gift card"]];

const unitOf = (line) => line.variant.priceCents + line.modifiers.reduce((a, m) => a + m.deltaCents, 0);
const lineKey = (variantId, modifiers) => `${variantId}|${modifiers.map((m) => m.id).sort().join(",")}`;
const TIPS = [["No tip", 0], ["15%", 15], ["18%", 18], ["20%", 20]];
const tipOf = (order, priced) =>
  order.tipPct == null ? order.tip : (Math.round(((priced?.totalCents || 0) * order.tipPct) / 100) / 100).toFixed(2);
const VIEWS = ["register", "refund"];
const viewFromHash = () => {
  const h = decodeURIComponent(window.location.hash.slice(1));
  return VIEWS.includes(h) ? h : "register";
};
const toItems = (cart) => cart.map((l) => ({ key: l.key, variantId: l.variant.id, quantity: l.qty, modifierIds: l.modifiers.map((m) => m.id) }));
// One per sale, kept until it completes, so a repeated press can't charge twice. Not crypto.randomUUID: that needs HTTPS.
const newSaleId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const NO_TOTALS = { subtotalCents: 0, promotionCents: 0, discountCents: 0, taxCents: 0, totalCents: 0, taxRates: [] };
const sizeLabel = (product, variant) => (product.variants.length > 1 ? `, ${variant.name}` : "");

function Products({ catalog, selectedId, onPick, onCustomize, search, setSearch, category, setCategory, onRefund, showRefund }) {
  const q = search.trim().toLowerCase();
  const shown = catalog.products.filter((p) =>
    (!category || p.category === category) &&
    (!q || p.name.toLowerCase().includes(q) || p.variants.some((v) => v.sku.toLowerCase().includes(q))));
  const selected = catalog.products.find((p) => p.id === selectedId);

  return html`<section className="products" aria-label="Products">
    <header>
      <h2>Products</h2>
      <div className="search">
        ${showRefund && html`<button className="btn danger slim" onClick=${onRefund}>Refund</button>`}
        <label htmlFor="search">Search</label>
        <input id="search" className="field" placeholder="Name or SKU" value=${search}
          onChange=${(e) => setSearch(e.target.value)} />
      </div>
    </header>
    <div className="chips">
      ${[["", "All"], ...catalog.categories.map((c) => [c, c])].map(([value, label]) =>
        html`<button key=${label} className="chip" aria-pressed=${category === value}
          onClick=${() => setCategory(value)}>${label}</button>`)}
    </div>
    <div className="grid">
      ${shown.map((p) => {
        const open = p.variants.some((v) => v.available);
        const from = Math.min(...p.variants.map((v) => v.priceCents));
        return html`<button key=${p.id} className=${open ? "card" : "card out"} aria-pressed=${selectedId === p.id}
          aria-disabled=${!open} onClick=${() => open && onPick(p)}>
          <b>${p.name}</b><span>${money(from)} · ${open ? "Available" : "Out of stock"}</span></button>`;
      })}
      ${!shown.length && html`<p>No products match.</p>`}
    </div>
    <div className="tools">
      ${selected && html`<button className="btn primary block" onClick=${() => onCustomize(selected)}>Customize ${selected.name}</button>`}
    </div>
  </section>`;
}

function CustomizeModal({ product, onCancel, onAdd }) {
  const firstOpen = product.variants.find((v) => v.available) || product.variants[0];
  const [variant, setVariant] = useState(firstOpen);
  const [picked, setPicked] = useState(() => new Set(product.groups.map((g) => g.defaultId).filter(Boolean)));
  const [qty, setQty] = useState(1);

  const chosen = product.groups.flatMap((g) => g.modifiers.filter((m) => picked.has(m.id)));
  const total = (variant.priceCents + chosen.reduce((a, m) => a + m.deltaCents, 0)) * qty;
  const countIn = (g) => g.modifiers.filter((m) => picked.has(m.id)).length;
  const valid = variant.available && product.groups.every((g) => countIn(g) >= g.min);

  const toggle = (g, m) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(m.id)) {
      if (countIn(g) > g.min) next.delete(m.id);
    } else {
      if (g.max === 1) g.modifiers.forEach((x) => next.delete(x.id));
      next.add(m.id);
    }
    return next;
  });

  return html`<${Modal} title=${product.name} onClose=${onCancel}>
    <div className="stack">
      <div className="group" role="radiogroup" aria-label="Size">
        <div className="title">Size <span>· required</span></div>
        <div className="sizes">${product.variants.map((v) => html`<button key=${v.id} className="seg" role="radio"
          aria-checked=${variant.id === v.id} disabled=${!v.available} onClick=${() => setVariant(v)}>
          ${v.name} · ${money(v.priceCents)}${v.available ? "" : " · Out of stock"}</button>`)}</div>
      </div>
      ${product.groups.length > 0 && html`<hr className="rule" />`}
      <div className="cols">
        ${product.groups.map((g) => html`<div key=${g.id} role="group" aria-label=${g.name}>
          <div className="title"><b>${g.name}</b> <span>· ${g.min ? "required, " : ""}${g.max ? `up to ${g.max}` : "any number"}</span></div>
          ${g.modifiers.map((m) => {
            const on = picked.has(m.id);
            const full = g.max && !on && g.max > 1 && countIn(g) >= g.max;
            return html`<label key=${m.id} className="opt">
              <span><input type=${g.max === 1 ? "radio" : "checkbox"} name=${g.id} checked=${on} disabled=${full}
                onClick=${() => toggle(g, m)} onChange=${() => {}} />${m.name}</span>
              <span className="price">${m.id === g.defaultId && m.deltaCents === 0 ? "included" : `+${money(m.deltaCents)}`}</span></label>`;
          })}
        </div>`)}
      </div>
      <hr className="rule" />
      <div className="bar">
        <div className="step">
          <button className="btn small" aria-label="Fewer" disabled=${qty <= 1} onClick=${() => setQty(qty - 1)}>−</button>
          <span aria-live="polite">${qty}</span>
          <button className="btn small" aria-label="More" disabled=${qty >= 99} onClick=${() => setQty(qty + 1)}>+</button>
        </div>
        <b>Item total ${money(total)}</b>
        <div className="btns">
          <button className="btn" onClick=${onCancel}>Cancel</button>
          <button className="btn primary" disabled=${!valid} onClick=${() => onAdd({ product, variant, modifiers: chosen, qty })}>Add to order</button>
        </div>
      </div>
    </div>
  <//>`;
}

function DiscountModal({ lines, priced, staffRules, promotionId, onClose, onApproved }) {
  const [applyTo, setApplyTo] = useState("order");
  const [type, setType] = useState("percent");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("Regular");
  const [note, setNote] = useState("");
  const [keys, setKeys] = useState([]);
  const [number, setNumber] = useState("");
  const [pin, setPin] = useState("");
  const [staffNumber, setStaffNumber] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const staff = reason === "Employee"; // the only discount that can skip the manager
  // The server decides; this only shows the manager boxes when a staff discount is over the business's limit
  const base = applyTo === "order" ? (priced?.subtotalCents || 0) : lines.filter((l) => keys.includes(l.key)).reduce((a, l) => a + unitOf(l) * l.qty, 0);
  const wanted = type === "percent" ? (base * Number(value)) / 100 : Number(value) * 100;
  const overCap = wanted * 100 > staffRules.maxPercent * (priced?.subtotalCents || 0);
  const needManager = !staff || staffRules.needsApproval || overCap;

  const apply = async () => {
    setBusy(true);
    try {
      const discount = { applyTo, type, value: Number(value), reason, note, keys };
      const { approvalToken, terms } = await api("/register/discount/authorize", {
        discount, employeeNumber: staffNumber, managerNumber: number, managerPin: pin, promotionId: promotionId || undefined,
        items: toItems(lines),
      });
      onApproved({ terms, token: approvalToken });
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    }
    setBusy(false);
  };
  const seg = (current, set, options) => html`<div className="segs" role="radiogroup">${options.map(([v, label]) =>
    html`<button key=${v} className="seg" role="radio" aria-checked=${current === v} onClick=${() => set(v)}>${label}</button>`)}</div>`;
  const t = priced || NO_TOTALS;

  return html`<${Modal} title="Add discount" onClose=${onClose} wide>
    <div className="split">
      <aside className="recap" aria-label="Current order">
        <h3>Current order</h3>
        <ul className="lines">${lines.map((l) => html`<li key=${l.key} className="line">
          <label className="opt"><span>
            ${applyTo === "selected" && html`<input type="checkbox" checked=${keys.includes(l.key)}
              onChange=${(e) => setKeys(e.target.checked ? [...keys, l.key] : keys.filter((k) => k !== l.key))} />`}
            <span>${l.qty} × ${l.product.name}${sizeLabel(l.product, l.variant)}
              ${l.modifiers.length > 0 && html`<span className="opts"><br />${l.modifiers.map((m) => m.name).join(", ")}</span>`}</span></span>
            <span>${money(unitOf(l) * l.qty)}</span></label></li>`)}</ul>
        <hr className="rule" />
        <div className="row"><span>Subtotal</span><span>${money(t.subtotalCents)}</span></div>
        <div className="row"><span>Promotion</span><span>${money(-t.promotionCents)}</span></div>
        <div className="row"><span>Discount</span><span>${money(-t.discountCents)}</span></div>
        <div className="row"><span>Tax (${t.taxRates.join(" / ")}%)</span><span>${money(t.taxCents)}</span></div>
        <div className="row total"><span>Total</span><span>${money(t.totalCents)}</span></div>
      </aside>
      <div className="stack">
        <div className="group"><div>Apply to</div>${seg(applyTo, setApplyTo, [["order", "Whole order"], ["selected", "Selected items"]])}</div>
        <div className="group"><div>Discount type</div>${seg(type, setType, [["percent", "Percent off"], ["amount", "Amount off"]])}</div>
        <div className="two">
          <label>Value${type === "percent" ? " (%)" : " ($)"}
            <input className="field" type="number" min="0" step="0.01" value=${value} onChange=${(e) => setValue(e.target.value)} /></label>
          <div className="group"><div>Reason</div>${seg(reason, setReason, REASONS.map((r) => [r, r]))}</div>
        </div>
        <label>Note (optional)
          <input className="field" maxLength="255" placeholder="Up to 255 characters" value=${note} onChange=${(e) => setNote(e.target.value)} /></label>
        <hr className="rule" />
        ${staff && html`<label>Employee number
          <input className="field" inputMode="numeric" maxLength="8" autoComplete="off" value=${staffNumber}
            onChange=${(e) => setStaffNumber(e.target.value.replace(/\D/g, ""))} /></label>`}
        ${needManager && html`<div className="override"><b>Manager override</b>
          <${ManagerFields} number=${number} pin=${pin} setNumber=${setNumber} setPin=${setPin} /></div>`}
        <${Message} msg=${msg} />
        <div className="btns">
          <button className="btn primary" disabled=${busy} onClick=${apply}>Apply discount</button>
          <button className="btn" onClick=${onClose}>Cancel</button>
        </div>
      </div>
    </div>
  <//>`;
}

function Order({ cart, setQty, priced, pricingError, checkout, setCheckout, catalog, order, setOrder, onRefund, onAddDiscount, onRemoveDiscount, onComplete, busy, msg, setMsg }) {
  const [memberQuery, setMemberQuery] = useState("");

  const findMember = async () => {
    if (!memberQuery.trim()) return setOrder({ member: null });
    try {
      setOrder({ member: await api(`/register/member?q=${encodeURIComponent(memberQuery.trim())}`) });
      setMsg(null);
    } catch (err) {
      setOrder({ member: null });
      setMsg({ kind: "error", text: err.message });
    }
  };

  const lines = html`<ul className="lines" aria-label="Order items">${cart.map((l) => html`<li key=${l.key} className="line">
    <div><p className="name">${l.qty} × ${l.product.name}${sizeLabel(l.product, l.variant)}</p>
      ${l.modifiers.length > 0 && html`<p className="name opts">${l.modifiers.map((m) => m.name).join(", ")}</p>`}</div>
    <div className="step">
      <button className="btn small" aria-label=${`Fewer ${l.product.name}`} onClick=${() => setQty(l.key, l.qty - 1)}>−</button>
      <span>${l.qty}</span>
      <button className="btn small" aria-label=${`More ${l.product.name}`} onClick=${() => setQty(l.key, l.qty + 1)}>+</button>
    </div>
    <span>${money(unitOf(l) * l.qty)}</span></li>`)}</ul>`;

  const head = html`<div className="head"><h2>Current order</h2><button className="btn danger slim" onClick=${onRefund}>Refund</button></div>`;

  if (!checkout) {
    return html`<aside className="order" aria-label="Current order">${head}${lines}
      <button className="btn primary block" onClick=${() => setCheckout(true)}>Checkout</button></aside>`;
  }

  const t = priced || NO_TOTALS;
  const tipCents = order.method === "card" && t.totalCents > 0 ? Math.round(Number(tipOf(order, priced) || 0) * 100) : 0;
  const tipText = order.tipPct == null ? order.tip : order.tipPct ? tipOf(order, priced) : "";
  return html`<aside className="order expanded" aria-label="Current order">
    ${head}
    <label>Rewards member (optional)
      <input className="field" placeholder="Email or phone, blank = walk-in" value=${memberQuery}
        onChange=${(e) => setMemberQuery(e.target.value)} onBlur=${findMember}
        onKeyDown=${(e) => e.key === "Enter" && findMember()} /></label>
    ${order.member && html`<p className="sub">${order.member.name} · ${order.member.tier} · ${order.member.points} points</p>`}
    ${lines}
    <div className="scroll">
      <div className="row">
        <label>Promotion
          <select className="field" value=${order.promotionId} onChange=${(e) => setOrder({ promotionId: e.target.value })}>
            <option value="">None</option>
            ${catalog.promotions.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}</select></label>
        <button className="link" onClick=${onAddDiscount}>Add discount</button>
      </div>
      <div className="row"><span>Subtotal</span><span>${money(t.subtotalCents)}</span></div>
      ${order.promotionId && html`<div className="row"><span>Promotion</span><span>${money(-t.promotionCents)}</span></div>`}
      ${order.discount && html`<div className="row"><span>Discount (${order.discount.terms.reason})</span><span>${money(-t.discountCents)}</span></div>`}
      <div className="row"><span>Tax (${t.taxRates.join(" / ")}%)</span><span>${money(t.taxCents)}</span></div>
      <div className="row total"><span>Total</span><span>${money(t.totalCents)}</span></div>
      ${tipCents > 0 && html`<${React.Fragment}><div className="row"><span>Tip</span><span>${money(tipCents)}</span></div>
        <div className="row total"><span>Total with tip</span><span>${money(t.totalCents + tipCents)}</span></div>
        <p className="sub">The tip isn't taxed, isn't part of the sale and can't be refunded.</p><//>`}
      ${order.discount && html`<button className="btn slim" onClick=${onRemoveDiscount}>Remove discount</button>`}
      ${order.method === "card" && t.totalCents > 0 && html`<div className="group" role="group" aria-label="Tip"><div>Tip</div>
        <div className="pay">${TIPS.map(([label, pct]) => html`<button key=${label}
          aria-pressed=${order.tipPct === pct || (pct === 0 && order.tipPct == null && !order.tip)}
          onClick=${() => setOrder({ tipPct: pct, tip: "" })}>${label}</button>`)}</div>
        <input className="field" type="number" min="0" step="0.01" placeholder="Custom tip, $0.00" aria-label="Custom tip" value=${tipText}
          onChange=${(e) => setOrder({ tipPct: null, tip: e.target.value })} /></div>`}
      <div className="group"><div>Payment method</div>
        <div className="pay">${METHODS.map(([v, label]) => html`<button key=${v} aria-pressed=${order.method === v}
          onClick=${() => setOrder({ method: v })}>${label}</button>`)}</div></div>
      ${order.method === "gift" && html`<label>Gift card code
        <input className="field" autoComplete="off" value=${order.giftCode} onChange=${(e) => setOrder({ giftCode: e.target.value })} /></label>`}
      <${Message} msg=${msg || (pricingError && { kind: "error", text: pricingError })} />
    </div>
    <div className="btns">
      <button className="btn primary" disabled=${busy || !priced || !!pricingError} onClick=${onComplete}>Complete sale</button>
      <button className="btn" onClick=${() => { setCheckout(false); setMsg(null); }}>Cancel</button>
    </div>
  </aside>`;
}

const EMPTY_ORDER = { member: null, promotionId: "", discount: null, method: "cash", tip: "", tipPct: null, giftCode: "" };

function App() {
  const me = useMe();
  const [catalog, setCatalog] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState(viewFromHash);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [modal, setModal] = useState(null);
  const [cart, setCart] = useState([]);
  const [checkout, setCheckout] = useState(false);
  const [order, setOrderState] = useState(EMPTY_ORDER);
  const [priced, setPriced] = useState(null);
  const [pricingError, setPricingError] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const setOrder = useCallback((patch) => setOrderState((o) => ({ ...o, ...patch })), []);
  const loadCatalog = () => api("/register/catalog").then(setCatalog);

  useEffect(() => {
    loadCatalog().catch((err) => setLoadError(err.message));
  }, []);

  useEffect(() => { // Back and Forward move between views
    const onPop = () => setView(viewFromHash());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => { // short-lived confirmation text
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(id);
  }, [notice]);

  // The server prices the cart, so the figures shown are the ones the sale will be rung up with
  useEffect(() => {
    if (!cart.length) { setPriced(null); setPricingError(""); return; }
    let stale = false;
    api("/register/price", {
      items: toItems(cart),
      promotionId: order.promotionId || undefined,
      discount: order.discount?.terms,
    }).then((p) => { if (!stale) { setPriced(p); setPricingError(""); } })
      .catch((err) => { if (!stale) setPricingError(err.message); });
    return () => { stale = true; };
  }, [cart, order.promotionId, order.discount]);

  const saleId = useRef(newSaleId());
  const resetOrder = () => { saleId.current = newSaleId(); setCart([]); setCheckout(false); setOrderState(EMPTY_ORDER); setMsg(null); setSelectedId(null); };

  const addLine = (product, variant, modifiers, qty) => {
    const key = lineKey(variant.id, modifiers);
    setMsg(null);
    setCart((c) => c.some((l) => l.key === key)
      ? c.map((l) => (l.key === key ? { ...l, qty: Math.min(l.qty + qty, 99) } : l))
      : [...c, { key, product, variant, modifiers, qty }]);
  };
  const setQty = (key, qty) => {
    const next = cart.filter((l) => l.key !== key || qty > 0).map((l) => (l.key === key ? { ...l, qty: Math.min(qty, 99) } : l));
    if (!next.length) return resetOrder();
    setCart(next);
  };

  // A tap only selects; nothing reaches the cart except through the options dialog
  const pick = (product) => setSelectedId((id) => (id === product.id ? null : product.id));

  const go = (v) => {
    setView(v);
    window.history.pushState(null, "", v === "register" ? window.location.pathname : `#${encodeURIComponent(v)}`);
  };

  const complete = async () => {
    setBusy(true);
    try {
      const done = await api("/register/orders", {
        saleId: saleId.current,
        items: toItems(cart),
        promotionId: order.promotionId || undefined,
        discount: order.discount?.terms,
        approvalToken: order.discount?.token,
        customerId: order.member?.id,
        payment: { method: order.method, tip: priced?.totalCents > 0 ? tipOf(order, priced) : "", giftCardCode: order.giftCode },
      });
      resetOrder();
      setNotice(`Sale complete: order ${done.orderNumber}, ${money(done.totalCents)}${done.tipCents ? ` + ${money(done.tipCents)} tip` : ""}.`);
      loadCatalog().catch(() => {});
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    }
    setBusy(false);
  };

  let body;
  if (view === "refund") {
    body = html`<${RefundView} onExit=${() => go("register")} />`;
  } else if (loadError) {
    body = html`<section className="success" role="alert">${loadError}</section>`;
  } else if (!catalog) {
    body = html`<section className="success">Loading…</section>`;
  } else {
    body = html`
      <${React.Fragment}>
        <div style=${{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          ${notice && html`<p className="status" role="status" style=${{ paddingTop: 12 }}>${notice}</p>`}
          <${Products} catalog=${catalog} selectedId=${selectedId} onPick=${pick} onCustomize=${(p) => setModal({ type: "customize", product: p })}
            search=${search} setSearch=${setSearch} category=${category} setCategory=${setCategory}
            showRefund=${!cart.length} onRefund=${() => go("refund")} />
        </div>
        ${cart.length > 0 && html`<${Order} cart=${cart} setQty=${setQty} priced=${priced} pricingError=${pricingError}
          checkout=${checkout} setCheckout=${setCheckout} catalog=${catalog} order=${order} setOrder=${setOrder}
          onRefund=${() => go("refund")} onAddDiscount=${() => setModal({ type: "discount" })}
          onRemoveDiscount=${() => setOrder({ discount: null })} onComplete=${complete} busy=${busy} msg=${msg} setMsg=${setMsg} />`}
      <//>`;
  }

  return html`<div className="app">
    <${Sidebar} me=${me} current="Register" />
    ${body}
    ${modal?.type === "customize" && html`<${CustomizeModal} product=${modal.product} onCancel=${() => setModal(null)}
      onAdd=${({ product, variant, modifiers, qty }) => { addLine(product, variant, modifiers, qty); setSelectedId(null); setModal(null); }} />`}
    ${modal?.type === "discount" && html`<${DiscountModal} lines=${cart} priced=${priced} staffRules=${catalog.staffRules} promotionId=${order.promotionId} onClose=${() => setModal(null)}
      onApproved=${(discount) => { setOrder({ discount }); setModal(null); setMsg(null); }} />`}
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
