const orderId = new URLSearchParams(window.location.search).get("id") || "";

const Metric = ({ label, value }) => html`<div className="metric"><span>${label}</span><b>${value}</b></div>`;

function Items({ data, sub }) {
  const { totals } = data;
  return html`<section className=${`osec ${panelOf("items", sub)}`} aria-label="Items">
    <h3>Items</h3>
    <div className="tscroll"><table className="table fit rowcards">
      <thead><tr><th scope="col">Item</th><th scope="col" className="r">Qty</th><th scope="col" className="r">Unit price</th><th scope="col" className="r">Line total</th></tr></thead>
      <tbody>${data.items.map((i, n) => html`<tr key=${n}>
        <td>${i.name}${i.options.length > 0 && html`<span className="opts">${i.options.join(", ")}</span>`}</td>
        <td className="r">${i.qty}</td><td className="r">${fromDollars(i.unitPrice)}</td><td className="r">${fromDollars(i.lineTotal)}</td></tr>`)}</tbody></table></div>
    <dl className="totals">
      <div><dt>Subtotal</dt><dd>${fromDollars(totals.subtotal)}</dd></div>
      ${totals.discount > 0 && html`<div><dt>Discount${totals.discountNames.length ? ` (${totals.discountNames.join(", ")})` : ""}</dt><dd>${fromDollars(-totals.discount)}</dd></div>`}
      <div><dt>${totals.taxIncluded ? "Tax (included)" : "Tax"}</dt><dd>${fromDollars(totals.tax)}</dd></div>
      <div className="grand"><dt>Total</dt><dd>${fromDollars(totals.total)}</dd></div>
    </dl>
  </section>`;
}

function Payments({ data, sub }) {
  return html`<section className=${`osec ${panelOf("payments", sub)}`} aria-label="Payments and refunds">
    <h3>Payments and refunds</h3>
    ${data.payments.length === 0 ? html`<p className="sub">Nothing has been paid yet.</p>` : html`<div className="tscroll"><table className="table fit rowcards">
      <thead><tr><th scope="col">Type</th><th scope="col">Method</th><th scope="col" className="r">Amount</th><th scope="col">Status</th><th scope="col">Date</th></tr></thead>
      <tbody>${data.payments.map((p, n) => html`<tr key=${n}>
        <td>${p.type}</td><td>${p.method || "—"}</td><td className="r">${fromDollars(p.amount)}</td>
        <td>${p.type === "Tip" ? html`<button className="act" disabled title="Adjusting a tip isn't available yet">Adjust tip</button>` : p.status}</td>
        <td>${when(p.at, data.timeZone)}</td></tr>`)}</tbody></table></div>`}
  </section>`;
}

function Info({ data, sub }) {
  const w = data.where;
  return html`<aside className="oside">
    <section className=${`osec ${panelOf("info", sub)}`} aria-label="Who and where">
      <h3>Who and where</h3>
      <ul className="facts">
        <li>Location: ${w.location}</li>
        <li>Register: ${w.register || "none"}</li>
        <li>Rung up by: ${w.rungUpBy || "—"}</li>
        <li>Customer: ${w.customer}</li>
        ${w.pickup && html`<li>Pickup: ${w.pickup.at ? when(w.pickup.at, data.timeZone) : "as soon as possible"}</li>`}
        <li>Note: ${w.note || "none"}</li>
      </ul>
    </section>
    <section className=${`osec ${panelOf("history", sub)}`} aria-label="Status history">
      <h3>Status history</h3>
      ${data.history.length === 0 ? html`<p className="sub">No status changes recorded.</p>` : html`<div className="tscroll"><table className="table fit rowcards">
        <thead><tr><th scope="col">Time</th><th scope="col">Status</th><th scope="col">By</th></tr></thead>
        <tbody>${data.history.map((h, n) => html`<tr key=${n}><td>${when(h.at, data.timeZone)}</td><td>${h.status}</td><td>${h.by || "—"}</td></tr>`)}</tbody></table></div>`}
    </section>
  </aside>`;
}

function App() {
  const me = useMe();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [refunding, setRefunding] = useState(false);
  const [sub, setSub] = useState("items"); // the section a phone shows
  const load = useCallback(() => api(`/orders/${encodeURIComponent(orderId)}`).then((d) => { setData(d); setError(""); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Orders" />
    <section className="main scrolls" aria-label="Order details">
      ${error ? html`<${React.Fragment}><p className="success" role="alert">${error}</p><a className="pbtn outline" href="/orders.html">Back to orders</a><//>`
        : !data ? html`<p className="success">Loading…</p>` : html`<${React.Fragment}>
        <header className="ohead">
          <a className="pbtn outline" href="/orders.html">Back to orders</a>
          <${PageTitle}>Order ${data.orderNumber}<//>
          <button className="pbtn outline" disabled=${!data.canRefund} title=${data.canRefund ? "" : "Only completed orders can be refunded, by a role that may refund"} onClick=${() => setRefunding(true)}>Refund this order</button>
        </header>
        <div className="metrics">
          <${Metric} label="Status" value=${data.status} /><${Metric} label="Source" value=${data.source} />
          <${Metric} label="Placed" value=${when(data.placedAt, data.timeZone)} /><${Metric} label="Total" value=${fromDollars(data.total)} />
        </div>
        <${SubTabs} tabs=${[["items", "Items"], ["payments", "Payments"], ["info", "Details"], ["history", "History"]]} value=${sub} onChange=${setSub} label="Order sections" />
        <div className="odetail"><div className="oleft"><${Items} data=${data} sub=${sub} /><${Payments} data=${data} sub=${sub} /></div><${Info} data=${data} sub=${sub} /></div>
        ${refunding && html`<${Modal} title="Refund this order" wide onClose=${() => { setRefunding(false); load(); }}>
          <${RefundView} orderNumber=${data.orderNumber} onExit=${() => { setRefunding(false); load(); }} onDone=${load} />
        <//>`}
      <//>`}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
