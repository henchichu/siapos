// The refund screen, shared by the register and the order details page. Given an orderNumber it opens on that order
// (no search box); onDone runs after a refund is made or asked for.
const share = (cents, qty, bought) => Math.floor((2 * cents * qty + bought) / (2 * bought));

function ManagerFields({ number, pin, setNumber, setPin }) {
  return html`<div className="two">
    <label>Manager number
      <input className="field" inputMode="numeric" maxLength="8" autoComplete="off" value=${number}
        onChange=${(e) => setNumber(e.target.value.replace(/\D/g, ""))} /></label>
    <label>PIN (6 digits)
      <input className="field" type="password" inputMode="numeric" maxLength="6" autoComplete="off" value=${pin}
        onChange=${(e) => setPin(e.target.value.replace(/\D/g, ""))} /></label>
  </div>`;
}

function RefundView({ onExit, orderNumber, onDone }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState(null);
  const [picks, setPicks] = useState({});
  const [reason, setReason] = useState("");
  const [number, setNumber] = useState("");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async (query) => {
    const order = await api(`/refunds/order?q=${encodeURIComponent(query)}`);
    setFound(order);
    return order;
  };
  useEffect(() => { if (orderNumber) load(String(orderNumber)).catch((err) => setMsg({ kind: "error", text: err.message })); }, [orderNumber]);
  const find = async (e) => {
    e.preventDefault();
    setPicks({}); setResult(null);
    try { await load(q.trim()); setMsg(null); } catch (err) { setFound(null); setMsg({ kind: "error", text: err.message }); }
  };
  const left = (l) => l.bought - l.returned;
  const pick = (l, patch) => { setResult(null); setPicks((p) => ({ ...p, [l.orderItemId]: { ...p[l.orderItemId], ...patch } })); };
  const chosen = (found?.lines || []).filter((l) => picks[l.orderItemId]?.on && left(l) > 0);
  const qtyOf = (l) => Math.min(Math.max(parseInt(picks[l.orderItemId].qty, 10) || 0, 0), left(l));
  const sum = chosen.reduce((a, l) => ({
    net: a.net + share(l.netCents, qtyOf(l), l.bought), tax: a.tax + share(l.taxCents, qtyOf(l), l.bought) }), { net: 0, tax: 0 });
  const shown = result ? { net: result.itemsCents, tax: result.taxCents } : sum;

  const complete = async () => {
    setBusy(true);
    try {
      const done = await api("/refunds", {
        orderId: found.orderId, reason, managerNumber: number, managerPin: pin,
        lines: chosen.map((l) => ({ orderItemId: l.orderItemId, qty: qtyOf(l), restock: !!picks[l.orderItemId].restock })),
      });
      setResult(done); setPicks({}); setNumber(""); setPin("");
      await load(String(found.orderNumber));
      setMsg({ kind: "ok", text: `Refund complete: ${money(done.totalCents)} back to ${done.method}.` });
      onDone?.();
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    }
    setBusy(false);
  };

  // No manager at hand: the refund waits for one (it shows on their Needs attention page)
  const ask = async () => {
    setBusy(true);
    try {
      const out = await api("/refunds/request", {
        orderId: found.orderId, reason,
        lines: chosen.map((l) => ({ orderItemId: l.orderItemId, qty: qtyOf(l), restock: !!picks[l.orderItemId].restock })),
      });
      setResult(null); setPicks({}); setNumber(""); setPin("");
      await load(String(found.orderNumber));
      setMsg({ kind: "ok", text: `Sent to a manager: ${money(out.totalCents)} to ${out.method} once approved.` });
      onDone?.();
    } catch (err) {
      setMsg({ kind: "error", text: err.message });
    }
    setBusy(false);
  };

  return html`<section className="refund" aria-label="Refund on an order">
    <div className="main">
      ${!orderNumber && html`<${React.Fragment}>
        <div className="title"><button className="btn" onClick=${onExit}>Back to register</button><${PageTitle}>Refund<//></div>
        <div className="find"><h3>Find the order</h3>
          <form onSubmit=${find}>
            <input className="field" aria-label="Order number, or member email or phone" placeholder="Order number, or member email or phone"
              value=${q} onChange=${(e) => setQ(e.target.value)} />
            <button className="btn primary" type="submit">Find</button></form></div>
      <//>`}
      ${found && html`<div className="order-sum">
        <div><h3>Order ${found.orderNumber}</h3>
          <p className="sub">${new Date(found.placedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${found.member || "walk-in"} · Paid ${money(found.paidCents)} by ${found.method}${found.tipCents ? ` · Tip ${money(found.tipCents)} (not refundable)` : ""}</p></div>
        <table className="rt"><thead><tr><th>Return</th><th>Item</th><th>Bought</th><th>Already returned</th><th>Qty to return</th><th>Back to stock</th><th className="r">Amount</th></tr></thead>
          <tbody>${found.lines.map((l) => {
            const p = picks[l.orderItemId] || {};
            const done = left(l) <= 0;
            return html`<tr key=${l.orderItemId}>
              <td><input type="checkbox" aria-label=${`Return ${l.name}`} disabled=${done} checked=${!!p.on}
                onChange=${(e) => pick(l, { on: e.target.checked, qty: p.qty || String(left(l)) })} /></td>
              <td>${l.name}</td><td>${l.bought}</td><td>${l.returned}</td>
              <td>${done ? html`<span className="sub">Fully returned</span>` : html`<input type="number" min="1" max=${left(l)}
                aria-label=${`Quantity of ${l.name} to return`} disabled=${!p.on} value=${p.qty || ""} onChange=${(e) => pick(l, { qty: e.target.value })} />`}</td>
              <td>${!done && html`<input type="checkbox" aria-label=${`Put ${l.name} back to stock`} disabled=${!p.on || !l.restockable}
                title=${l.restockable ? "" : "This item can't go back to stock"} checked=${!!p.restock} onChange=${(e) => pick(l, { restock: e.target.checked })} />`}</td>
              <td className="r">${done ? "—" : p.on ? money(share(l.netCents, qtyOf(l), l.bought) + share(l.taxCents, qtyOf(l), l.bought)) : money(0)}</td></tr>`;
          })}</tbody></table></div>`}
    </div>
    <aside className="side" aria-label="Refund summary">
      <h2>Refund summary</h2>
      <label><b>Reason (required)</b>
        <input className="field" maxLength="255" value=${reason} onChange=${(e) => setReason(e.target.value)} /></label>
      <div className="sumrow"><span>Items</span><span>${money(shown.net)}</span></div>
      <div className="sumrow"><span>Tax</span><span>${money(shown.tax)}</span></div>
      <div className="divider"></div>
      <div className="sumrow sumtotal"><span>Refund total</span><span>${money(shown.net + shown.tax)}</span></div>
      ${found && html`<p className="sub">Goes back to the original payment: ${result?.method || found.method}${found.tipCents ? ". Tips are never refunded." : ""}</p>`}
      <div className="dashed"><b>Manager override</b>
        <${ManagerFields} number=${number} pin=${pin} setNumber=${setNumber} setPin=${setPin} /></div>
      <${Message} msg=${msg} dashed />
      <button className="btn block" disabled=${busy || !found || !chosen.length || !reason.trim() || chosen.some((l) => qtyOf(l) < 1)} onClick=${ask}>Send to a manager</button>
      <p className="sub">No manager here? Send it, and they approve it from Needs attention.</p>
      <div className="btns">
        <button className="btn primary" disabled=${busy || !found || !chosen.length || !reason.trim() || chosen.some((l) => qtyOf(l) < 1)} onClick=${complete}>Complete refund</button>
        <button className="btn" onClick=${onExit}>Cancel</button></div>
    </aside>
  </section>`;
}
