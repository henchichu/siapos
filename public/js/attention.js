const usd = (n) => `$${n.toFixed(2)}`;
const qty = (n) => String(Math.round(n * 1000) / 1000);

// One panel: title and how many, its table, and the button that goes where the work is done
function Panel({ title, count, children, empty, action }) {
  return html`<section className="panel" aria-label=${title}>
    <header><h3>${title}</h3><span className="count" aria-label=${`${count} ${title}`}>${count}</span></header>
    ${count ? children : html`<p className="sub">${empty}</p>`}
    ${action}
  </section>`;
}

const Table = ({ cols, heads, children }) => html`<table className="table mg">
  <colgroup>${cols.map((w, i) => html`<col key=${i} style=${w ? { width: w } : undefined} />`)}</colgroup>
  <thead><tr>${heads.map(([h, right], i) => html`<th key=${i} className=${right ? "r" : ""}>${h}</th>`)}</tr></thead>
  <tbody>${children}</tbody></table>`;

// A manager answers the refunds that are waiting: Approve needs their number and PIN, Reject doesn't
function ReviewRefunds({ onClose, onChanged }) {
  const [refunds, setRefunds] = useState(null);
  const [number, setNumber] = useState("");
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api("/refunds/waiting").then((d) => setRefunds(d.refunds)).catch((e) => setMsg({ kind: "error", text: e.message })), []);
  useEffect(() => { load(); }, [load]);

  const answer = async (r, path, body) => {
    setBusy(true);
    try {
      const out = await api(`/refunds/${r.id}/${path}`, body);
      setMsg({ kind: "ok", text: path === "approve" ? `Order ${r.orderNumber}: ${money(out.totalCents)} refunded to ${out.method}.` : `Order ${r.orderNumber}: refund rejected.` });
      if (path === "approve") { setNumber(""); setPin(""); }
      await load(); onChanged();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
    setBusy(false);
  };

  return html`<${Modal} title="Refunds waiting for an override" onClose=${onClose} wide>
    ${refunds && !refunds.length && html`<p>No refunds are waiting.</p>`}
    ${refunds && refunds.length > 0 && html`<div className="two">
      <label>Your employee number<input className="field" inputMode="numeric" maxLength="8" autoComplete="off" value=${number} onChange=${(e) => setNumber(e.target.value.replace(/\D/g, ""))} /></label>
      <label>PIN (6 digits)<input className="field" type="password" inputMode="numeric" maxLength="6" autoComplete="off" value=${pin} onChange=${(e) => setPin(e.target.value.replace(/\D/g, ""))} /></label></div>`}
    <ul className="waiting">${(refunds || []).map((r) => html`<li key=${r.id}>
      <div className="row"><b>Order ${r.orderNumber} · ${usd(r.amount)}</b><span className="sub">Asked by ${r.askedBy}</span></div>
      <p className="sub">${r.why}. Reason given: ${r.reason}</p>
      <p>${r.lines.map((l) => `${l.qty} × ${l.name}${l.restocked ? ` (${l.restocked} back to stock)` : ""}`).join(", ")}</p>
      <div className="btns"><button className="btn primary" disabled=${busy || number.length !== 8 || pin.length !== 6} onClick=${() => answer(r, "approve", { managerNumber: number, managerPin: pin })}>Approve</button>
        <button className="btn" disabled=${busy} onClick=${() => answer(r, "reject", {})}>Reject</button></div></li>`)}</ul>
    <${Message} msg=${msg} dashed />
    <div className="btns"><button className="btn" onClick=${onClose}>Close</button></div>
  <//>`;
}

// The overlay menu: pick another of your locations and the whole page follows it
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

function App() {
  const me = useMe();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const [places, setPlaces] = useState(false);
  const load = useCallback(() => api("/attention").then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const { losses, low, timecards, refunds } = data || {};
  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Needs attention" />
    <section className="main scrolls" aria-label="Needs attention">
      ${error ? html`<p className="success" role="alert">${error}</p>` : !data ? html`<p className="success">Loading…</p>` : html`<${React.Fragment}>
        <header className="phead heading"><h2>Needs attention</h2>${data.canSwitch
            ? html`<button className="where" aria-haspopup="dialog" onClick=${() => setPlaces(true)}>${data.location} · today</button>`
            : html`<span className="sub">${data.location} · today</span>`}</header>
        <div className="attention">
          ${losses && html`<${Panel} title="Stock losses reported today" count=${losses.count} empty="No losses reported today."
            action=${html`<a className="pbtn outline" href="/inventory.html">Open inventory</a>`}>
            <${Table} cols=${[64, 120, 84, 0, 72]} heads=${[["Time"], ["Stock item"], ["Amount"], ["Reason"], ["By"]]}>
              ${losses.rows.map((l, i) => html`<tr key=${i}><td>${clock(l.at, data.timeZone)}</td><td>${l.item}</td><td>${qty(l.amount)} ${l.unit}</td><td>${l.reason}</td><td>${l.by || "—"}</td></tr>`)}<//>
          <//>`}
          ${low && html`<${Panel} title="Low stock" count=${low.count} empty="Nothing is at or below its reorder level."
            action=${html`<a className="pbtn outline" href="/inventory.html#low">Restock</a>`}>
            <${Table} cols=${[0, 110, 90]} heads=${[["Stock item"], ["On hand"], ["Reorder at", true]]}>
              ${low.rows.map((l, i) => html`<tr key=${i}><td>${l.item}</td><td>${qty(l.onHand)} ${l.unit}</td><td className="r">${qty(l.reorderAt)}</td></tr>`)}<//>
          <//>`}
          ${timecards && html`<${Panel} title="Timecards waiting for approval" count=${timecards.count} empty="No timecards are waiting."
            action=${html`<a className="pbtn outline" href=${`/shift.html${timecards.periodId ? `?payPeriodId=${timecards.periodId}` : ""}#team`}>Review timecards</a>`}>
            <${Table} cols=${[0, 110, 64]} heads=${[["Employee"], ["Date"], ["Hours", true]]}>
              ${timecards.rows.map((c, i) => html`<tr key=${i}><td>${c.employee}</td><td>${dayOf(c.date)}</td><td className="r">${c.hours.toFixed(2)}</td></tr>`)}<//>
          <//>`}
          ${refunds && html`<${Panel} title="Refunds waiting for an override" count=${refunds.count} empty="No refunds are waiting."
            action=${refunds.count > 0 && html`<button className="pbtn outline" onClick=${() => setReview(true)}>Review refund</button>`}>
            <${Table} cols=${[64, 84, 90, 0]} heads=${[["Order"], ["Amount", true], ["Asked by"], ["Why"]]}>
              ${refunds.rows.map((r, i) => html`<tr key=${i}><td>${r.orderNumber}</td><td className="r">${usd(r.amount)}</td><td>${r.askedBy}</td><td>${r.why}</td></tr>`)}<//>
          <//>`}
        </div>
        ${places && html`<${PickLocation} onClose=${() => setPlaces(false)} onPicked=${() => window.location.reload()} />`}
        ${review && html`<${ReviewRefunds} onClose=${() => { setReview(false); load(); }} onChanged=${load} />`}
      <//>`}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
