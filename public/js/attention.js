const qty = (n) => String(Math.round(n * 1000) / 1000);

// One panel: title and how many, its table, and the button that goes where the work is done
function Panel({ title, count, children, empty, action, className = "" }) {
  return html`<section className=${`panel ${className}`} aria-label=${title}>
    <header><h3>${title}</h3><span className="count" aria-label=${`${count} ${title}`}>${count}</span></header>
    ${count ? children : html`<p className="sub">${empty}</p>`}
    ${action}
  </section>`;
}

// Columns are sized by the browser from their content (shift.css, "fit"); class nw keeps a short value on one line
const Table = ({ heads, children }) => html`<div className="tscroll"><table className="table mg fit rowcards">
  <thead><tr>${heads.map(([h, right], i) => html`<th key=${i} className=${right ? "r" : ""}>${h}</th>`)}</tr></thead>
  <tbody>${children}</tbody></table></div>`;

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
      <div className="row"><b>Order ${r.orderNumber} · ${fromDollars(r.amount)}</b><span className="sub">Asked by ${r.askedBy}</span></div>
      <p className="sub">${r.why}. Reason given: ${r.reason}</p>
      <p>${r.lines.map((l) => `${l.qty} × ${l.name}${l.restocked ? ` (${l.restocked} back to stock)` : ""}`).join(", ")}</p>
      <div className="btns"><button className="btn primary" disabled=${busy || number.length !== 8 || pin.length !== 6} onClick=${() => answer(r, "approve", { managerNumber: number, managerPin: pin })}>Approve</button>
        <button className="btn" disabled=${busy} onClick=${() => answer(r, "reject", {})}>Reject</button></div></li>`)}</ul>
    <${Message} msg=${msg} dashed />
    <div className="btns"><button className="btn" onClick=${onClose}>Close</button></div>
  <//>`;
}

function App() {
  const me = useMe();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const [tab, setTab] = useState(""); // the panel a phone shows
  const load = useCallback(() => api("/attention").then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const { losses, pendingDeliveries, timecards, refunds } = data || {};
  const tabs = [losses && ["losses", "Losses", losses.count], pendingDeliveries && ["deliveries", "Deliveries", pendingDeliveries.count],
    timecards && ["timecards", "Timecards", timecards.count], refunds && ["refunds", "Refunds", refunds.count]].filter(Boolean);
  const shown = tabs.some(([k]) => k === tab) ? tab : tabs[0]?.[0];
  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Needs attention" />
    <section className="main scrolls" aria-label="Needs attention">
      ${error ? html`<p className="success" role="alert">${error}</p>` : !data ? html`<p className="success">Loading…</p>` : html`<${React.Fragment}>
        <header className="phead heading"><${PageTitle}>Needs attention<//><span className="sub">${data.location} · today</span></header>
        <${SubTabs} tabs=${tabs} value=${shown} onChange=${setTab} label="Needs attention sections" />
        <div className="attention">
          ${losses && html`<${Panel} title="Stock losses reported today" className=${panelOf("losses", shown)} count=${losses.count} empty="No losses reported today."
            action=${html`<a className="pbtn outline" href="/inventory.html">Open inventory</a>`}>
            <${Table} heads=${[["Time"], ["Stock item"], ["Amount"], ["Reason"], ["By"]]}>
              ${losses.rows.map((l, i) => html`<tr key=${i}><td className="nw">${clock(l.at, data.timeZone)}</td><td>${l.item}</td><td className="nw">${qty(l.amount)} ${l.unit}</td><td>${l.reason}</td><td className="nw">${l.by || "—"}</td></tr>`)}<//>
          <//>`}
          ${pendingDeliveries && html`<${Panel} title="Pending deliveries" className=${panelOf("deliveries", shown)} count=${pendingDeliveries.count} empty="No deliveries are pending."
            action=${html`<a className="pbtn outline" href="/inventory.html#delivery">Receive delivery</a>`}>
            <${Table} heads=${[["Purchase order"], ["Stock item / supplier"], ["Quantity", true], ["Status"]]}>
              ${pendingDeliveries.rows.map((p) => html`<tr key=${p.id}><td className="nw">${p.orderNumber}</td><td>${p.item}<div className="sub">${p.supplier || "No supplier assigned"}</div></td><td className="r">${qty(p.quantity)} ${p.unit}</td><td className="nw">${p.status}</td></tr>`)}<//>
          <//>`}
          ${timecards && html`<${Panel} title="Timecards waiting for approval" className=${panelOf("timecards", shown)} count=${timecards.count} empty="No timecards are waiting."
            action=${html`<a className="pbtn outline" href=${`/shift.html${timecards.periodId ? `?payPeriodId=${timecards.periodId}` : ""}#team`}>Review timecards</a>`}>
            <${Table} heads=${[["Employee"], ["Date"], ["Hours", true]]}>
              ${timecards.rows.map((c, i) => html`<tr key=${i}><td>${c.employee}</td><td className="nw">${dayOf(c.date)}</td><td className="r">${c.hours.toFixed(2)}</td></tr>`)}<//>
          <//>`}
          ${refunds && html`<${Panel} title="Refunds waiting for an override" className=${panelOf("refunds", shown)} count=${refunds.count} empty="No refunds are waiting."
            action=${refunds.count > 0 && html`<button className="pbtn outline" onClick=${() => setReview(true)}>Review refund</button>`}>
            <${Table} heads=${[["Order"], ["Amount", true], ["Asked by"], ["Why"]]}>
              ${refunds.rows.map((r, i) => html`<tr key=${i}><td className="nw">${r.orderNumber}</td><td className="r">${fromDollars(r.amount)}</td><td className="nw">${r.askedBy}</td><td>${r.why}</td></tr>`)}<//>
          <//>`}
        </div>
        ${review && html`<${ReviewRefunds} onClose=${() => { setReview(false); load(); }} onChanged=${load} />`}
      <//>`}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
