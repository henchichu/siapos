const TABS = [["stock", "Stock"], ["delivery", "Receive delivery"], ["count", "Stock count"]];
const tabFromHash = () => { const h = window.location.hash.slice(1); return TABS.some(([k]) => k === h) ? h : "stock"; };
const REASONS = [["broken", "Broken or spilled"], ["spoiled", "Spoiled or expired"], ["stolen", "Stolen"], ["correction", "Count correction"]];

const qty = (n) => String(Math.round(n * 1000) / 1000);
// A unit cost worked out from a total can need many places (a millilitre of milk costs a fraction of a cent)
const unitMoney = (n) => (n == null ? "—" : n >= 0.1 ? `$${n.toFixed(2)}` : `$${n.toFixed(6).replace(/0+$/, "").padEnd(6, "0")}`);
// The stock table's average cost: 2 places for a normal price, 4 for a tiny per-unit cost ($0.0122)
const avgMoney = (n) => (n == null ? "—" : `$${n.toFixed(n >= 0.1 ? 2 : 4)}`);
const delta = (n) => (n > 0 ? `+${qty(n)}` : n < 0 ? `−${qty(-n)}` : "±0");
const moneyDelta = (n) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}$${Math.abs(n).toFixed(2)}`;
const num = (s) => (s === "" || s == null || !Number.isFinite(Number(s)) ? null : Number(s));
const isLow = (r) => r.onHand <= r.reorderAt;

function Tabs({ tab, onTab }) {
  return html`<div className="tabs thin" role="group" aria-label="Inventory">
    ${TABS.map(([k, label]) => html`<button key=${k} className="tab" aria-pressed=${tab === k} onClick=${() => onTab(k)}>${label}</button>`)}</div>`;
}

function LocationSelect({ data, onLocation }) {
  return html`<select className="select" aria-label="Location" value=${data.location.id} onChange=${(e) => onLocation(e.target.value)}>
    ${data.locations.map((l) => html`<option key=${l.id} value=${l.id}>${l.name}</option>`)}</select>`;
}
// Deactivated suppliers only appear while "Show deactivated" is on
const visibleSuppliers = (data, showInactive) => data.suppliers.filter((s) => s.active || showInactive);
const SupplierSelect = ({ data, value, onChange, showInactive, empty = "All suppliers", label = "Supplier" }) => html`<select className="select" aria-label=${label} value=${value} onChange=${(e) => onChange(e.target.value)}>
  <option value="">${empty}</option>${visibleSuppliers(data, showInactive).map((s) => html`<option key=${s.id} value=${s.id}>${s.name}${s.active ? "" : " (deactivated)"}</option>`)}</select>`;
const ShowInactive = ({ checked, onChange }) => html`<label className="check"><input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.target.checked)} /> Show deactivated</label>`;

function StockTab({ data, reload, showInactive, setShowInactive }) {
  const [supplier, setSupplier] = useState("");
  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState(window.location.hash === "#low"); // Keep existing direct low-stock links working.
  const [form, setForm] = useState(null); // null = the form column is away; a row action brings it in
  const [adding, setAdding] = useState(null); // the "Add stock item" form, in the same column
  const [msg, setMsg] = useState(null);
  const [note, setNote] = useState("");
  const q = query.trim().toLowerCase();
  const rows = data.rows.filter((r) => (r.active || showInactive) && (!supplier || r.supplierIds.includes(supplier)) && (!q || r.name.toLowerCase().includes(q)) && (!lowOnly || (r.active && isLow(r))));
  const setActive = async (r, active) => {
    try { await api(`/inventory/item/${r.id}/active`, { active }); setNote(`${active ? "Reactivated" : "Deactivated"} ${r.name}.`); if (form?.stockItemId === r.id) close(); await reload(); }
    catch (e) { setNote(e.message); }
  };
  const rowOf = (id) => data.rows.find((r) => r.id === id);

  const show = (r, type) => { setForm({ stockItemId: r.id, type, quantity: "", reason: "", total: "", threshold: qty(r.reorderAt), note: "" }); setAdding(null); setMsg(null); setNote(""); };
  const showAdd = () => { setAdding({ name: "", unitCode: "", threshold: "", supplierId: "" }); setForm(null); setMsg(null); setNote(""); };
  const close = () => { setForm(null); setAdding(null); setMsg(null); };
  const setNew = (patch) => setAdding({ ...adding, ...patch });
  const saveItem = async () => {
    try {
      await api("/inventory/item", { locationId: data.location.id, ...adding });
      setNote(`Added ${adding.name.trim()}. Use Restock to put its first stock in.`);
      close();
      await reload();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
  };
  const set = (patch) => setForm({ ...form, ...patch });
  const pickItem = (id) => set({ stockItemId: id, threshold: rowOf(id) ? qty(rowOf(id).reorderAt) : "" });

  const save = async () => {
    const row = rowOf(form.stockItemId);
    const changed = !row || num(form.threshold) !== row.reorderAt; // only a changed threshold is sent
    try {
      await api("/inventory/change", { locationId: data.location.id, stockItemId: form.stockItemId, type: form.type, quantity: form.quantity,
        reason: form.reason, total: form.total, threshold: changed ? form.threshold : "", note: form.note });
      setNote(`Saved ${data.items.find((i) => i.id === form.stockItemId)?.name}.`);
      close();
      await reload();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
  };
  const restock = form?.type === "restock";
  const side = useRef(null);
  useEffect(() => { // on a narrow page the form sits below the list
    const el = side.current; if (!el || el.getBoundingClientRect().top < window.innerHeight) return;
    el.scrollIntoView({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [!!form, !!adding]);

  return html`<div className="split inv-split">
    <div className="stack grow">
      <section className="pview" aria-label="Inventory">
        <header className="phead"><h2>Inventory</h2>${data.canChange && html`<button className="pbtn" onClick=${showAdd}>Add stock item</button>`}</header>
        <div className="pfilters wrap">
          <${SupplierSelect} data=${data} value=${supplier} onChange=${setSupplier} showInactive=${showInactive} />
          <input className="field" aria-label="Stock item name" placeholder="Stock item name" value=${query} onChange=${(e) => setQuery(e.target.value)} />
          <label className="check"><input type="checkbox" checked=${lowOnly} onChange=${(e) => setLowOnly(e.target.checked)} /> Low stock only</label>
          <${ShowInactive} checked=${showInactive} onChange=${setShowInactive} />
        </div>
        ${note && html`<p className="status" role="status">${note}</p>`}
        <div className="tscroll"><table className=${data.canChange ? "table mg t-stock" : "table mg t-stock noacts"}>
          <colgroup><col style=${{ width: "24%" }} /><col style=${{ width: "13%" }} /><col style=${{ width: "12%" }} /><col style=${{ width: "12%" }} /><col style=${{ width: "11%" }} />${data.canChange && html`<col style=${{ width: 260 }} />`}</colgroup>
          <thead><tr><th>Stock item</th><th className="r">On hand</th><th className="r">Reorder at</th><th className="r">Avg cost</th><th>Status</th>${data.canChange && html`<th>Actions</th>`}</tr></thead>
          <tbody>${rows.map((r) => html`<tr key=${r.id} className=${`${form?.stockItemId === r.id ? "sel" : ""} ${r.active ? "" : "off"}`}>
            <td>${r.name}${!r.active && html`<span className="tag">deactivated</span>`}</td><td className="r">${qty(r.onHand)} ${r.unit}</td><td className="r">${qty(r.reorderAt)}</td><td className="r">${avgMoney(r.avgCost)}</td>
            <td className=${r.active && isLow(r) ? "state low" : "state"}>${!r.active ? "—" : html`<${Status} tone=${isLow(r) ? "warn" : "on"}>${isLow(r) ? "LOW" : "OK"}<//>`}</td>
            ${data.canChange && html`<td><div className="acts">${r.active
              ? html`<${React.Fragment}><button className="act" onClick=${() => show(r, "restock")}>Restock</button><button className="act" onClick=${() => show(r, "adjust")}>Adjust</button>
                  <button className="act danger" onClick=${() => setActive(r, false)}>Deactivate</button><//>`
              : html`<button className="act" onClick=${() => setActive(r, true)}>Reactivate</button>`}</div></td>`}</tr>`)}
            ${!rows.length && html`<tr><td colSpan="6">No stock items match.</td></tr>`}</tbody>
        </table></div>
      </section>
      <section className="pview" aria-label="Recent stock movements">
        <h2>Recent stock movements</h2>
        <div className="tscroll"><table className="table mg t-moves">
          <colgroup><col style=${{ width: "19%" }} /><col style=${{ width: "21%" }} /><col style=${{ width: "14%" }} /><col style=${{ width: "15%" }} /><col style=${{ width: "18%" }} /><col style=${{ width: "13%" }} /></colgroup>
          <thead><tr><th>Date and time</th><th>Stock item</th><th>Type</th><th className="r">Change</th><th>Employee</th><th className="r">Order</th></tr></thead>
          <tbody>${data.movements.map((m, i) => html`<tr key=${i}><td>${when(m.at, data.location.timeZone)}</td><td>${m.item}</td><td>${m.type}</td>
            <td className="r">${delta(m.delta)} ${m.unit}</td><td>${m.by || "—"}</td><td className="r">${m.orderNumber ?? "—"}</td></tr>`)}
            ${!data.movements.length && html`<tr><td colSpan="6">No movements yet.</td></tr>`}</tbody>
        </table></div>
      </section>
    </div>
    ${adding && html`<aside className="pform pside" ref=${side} aria-label="Add stock item">
      <h2>Add stock item</h2>
      <label className="pf"><b>Name</b><input className="field" maxLength="150" value=${adding.name} onChange=${(e) => setNew({ name: e.target.value })} /></label>
      <label className="pf"><b>Unit</b><select className="select" value=${adding.unitCode} onChange=${(e) => setNew({ unitCode: e.target.value })}>
        <option value="">Choose how it is counted</option>${data.units.map((u) => html`<option key=${u.code} value=${u.code}>${u.description} (${u.symbol})</option>`)}</select></label>
      <label className="pf"><b>Reorder threshold</b><input className="field" inputMode="decimal" value=${adding.threshold} onChange=${(e) => setNew({ threshold: e.target.value.replace(/[^\d.]/g, "") })} /></label>
      <label className="pf"><b>Supplier (optional)</b><${SupplierSelect} data=${data} value=${adding.supplierId} onChange=${(v) => setNew({ supplierId: v })} empty="No supplier" label="Supplier for the new item" /></label>
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" onClick=${saveItem}>Save</button><button className="pbtn outline" onClick=${close}>Clear</button></div>
    </aside>`}
    ${form && html`<aside className="pform pside" ref=${side} aria-label="Record stock change">
      <h2>Record stock change</h2>
      <label className="pf"><b>Stock item</b><select className="select" value=${form.stockItemId} onChange=${(e) => pickItem(e.target.value)}>
        ${data.items.map((i) => html`<option key=${i.id} value=${i.id}>${i.name}</option>`)}</select></label>
      <div className="pf"><b>Type</b><div className="segs" role="radiogroup" aria-label="Type">
        ${[["restock", "Restock"], ["adjust", "Adjustment"]].map(([k, label]) => html`<button key=${k} className="tab small" role="radio" aria-checked=${form.type === k} aria-pressed=${form.type === k} onClick=${() => set({ type: k })}>${label}</button>`)}</div></div>
      <label className="pf"><b>Quantity</b><input className="field" inputMode="decimal" value=${form.quantity} onChange=${(e) => set({ quantity: e.target.value.replace(/[^\d.-]/g, "") })} /></label>
      ${restock
        ? html`<label className="pf"><b>Total paid</b><input className="field" inputMode="decimal" value=${form.total} onChange=${(e) => set({ total: e.target.value.replace(/[^\d.]/g, "") })} />
            ${num(form.quantity) > 0 && num(form.total) != null && html`<span className="sub">Unit cost ${unitMoney(num(form.total) / num(form.quantity))} per ${data.items.find((i) => i.id === form.stockItemId)?.unit}</span>`}</label>`
        : html`<label className="pf"><b>Reason</b><select className="select" value=${form.reason} onChange=${(e) => set({ reason: e.target.value })}>
            <option value="">Broken, spoiled, stolen or count correction</option>${REASONS.map(([k, label]) => html`<option key=${k} value=${k}>${label}</option>`)}</select>
            ${form.reason === "correction" && html`<span className="sub">Use + or − : a count correction can add or remove.</span>`}</label>`}
      <label className="pf"><b>Reorder threshold</b><input className="field" inputMode="decimal" value=${form.threshold} onChange=${(e) => set({ threshold: e.target.value.replace(/[^\d.]/g, "") })} /></label>
      <label className="pf"><b>Note (optional)</b><input className="field" maxLength="255" value=${form.note} onChange=${(e) => set({ note: e.target.value })} /></label>
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" onClick=${save}>Save</button><button className="pbtn outline" onClick=${close}>Clear</button></div>
    </aside>`}
  </div>`;
}

function DeliveryTab({ data, reload, showInactive, setShowInactive }) {
  const [pendingId, setPendingId] = useState("");
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [pendingExpanded, setPendingExpanded] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [date, setDate] = useState(data.location.today);
  const [invoice, setInvoice] = useState("");
  const [lines, setLines] = useState([]);
  const [add, setAdd] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newSupplier, setNewSupplier] = useState(null); // the inline "new supplier" form
  const item = (id) => data.items.find((i) => i.id === id);
  const unitCost = (l) => (num(l.quantity) > 0 && num(l.total) != null ? num(l.total) / num(l.quantity) : null);
  const total = lines.reduce((a, l) => a + (num(l.total) || 0), 0);
  const clear = () => { setPendingId(""); setSupplierId(""); setDate(data.location.today); setInvoice(""); setLines([]); setAdd(""); };
  // the supplier's quoted price times the quantity, as a hint for what the total should be
  const quoteHint = (l) => { const q = data.quotes.find((x) => x.stockItemId === l.stockItemId && x.supplierId === supplierId)?.unitCost; return q != null && num(l.quantity) > 0 ? `≈ ${(q * num(l.quantity)).toFixed(2)}` : ""; };
  const setLine = (id, patch) => setLines(lines.map((l) => (l.stockItemId === id ? { ...l, ...patch } : l)));

  const addLine = () => {
    if (!add) return setMsg({ kind: "error", text: "Choose a stock item to add." });
    if (lines.some((l) => l.stockItemId === add)) return setMsg({ kind: "error", text: "That item is already on the delivery." });
    setLines([...lines, { stockItemId: add, quantity: "", total: "" }]); setAdd(""); setMsg(null);
  };
  const pending = data.pendingDeliveries || [];
  const selectedOrder = pending.find((p) => p.id === pendingId);
  const placeOrder = async () => {
    setBusy(true);
    try {
      await api(`/inventory/purchase-order/${pendingId}/supplier`, { locationId: data.location.id, supplierId });
      clear(); await reload(); setMsg({ kind: "ok", text: "Simulated purchase order placed. It is now awaiting delivery." });
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
    setBusy(false);
  };
  const prepare = (p) => {
    setPendingId(p.id); setSupplierId(p.supplierId || ""); setDate(data.location.today); setInvoice("");
    setLines([{ stockItemId: p.stockItemId, quantity: qty(p.quantity), total: p.unitCost == null ? "" : (p.quantity * p.unitCost).toFixed(2) }]);
    setMsg({ kind: "ok", text: p.status === "Needs supplier" ? `Choose a supplier to place ${p.orderNumber}.` : `Receive ${p.orderNumber}: ${p.item}. Check the quantity and actual cost.` });
    document.querySelector('[aria-label="Receive delivery"]')?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const chosen = data.suppliers.find((x) => x.id === supplierId);
  const setSupplierActive = async (active) => {
    try {
      await api(`/inventory/supplier/${supplierId}/active`, { active });
      setMsg({ kind: "ok", text: `${active ? "Reactivated" : "Deactivated"} ${chosen.name}.` });
      if (!active && !showInactive) setSupplierId("");
      await reload();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
  };
  const saveSupplier = async () => {
    try {
      const { id } = await api("/inventory/supplier", newSupplier);
      await reload();
      setSupplierId(id); setNewSupplier(null); setMsg({ kind: "ok", text: `Added supplier ${newSupplier.name.trim()}.` });
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
  };
  const receive = async () => {
    setBusy(true);
    try {
      const r = await api("/inventory/delivery", { locationId: data.location.id, supplierId, deliveredOn: date, invoice, lines, purchaseOrderId: pendingId });
      clear();
      setMsg({ kind: "ok", text: `Delivery received: ${r.lines} ${r.lines === 1 ? "line" : "lines"}, ${fromDollars(r.total)}.` });
      await reload();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
    setBusy(false);
  };

  return html`<div className="split inv-split">
    <section className="pview wide-form" aria-label="Receive delivery">
      <h2>Receive delivery</h2>
      <p className="sub">Receiving at ${data.location.name}</p>
      ${pendingId && html`<p className="status" role="status">${selectedOrder ? `${selectedOrder.orderNumber}: ${selectedOrder.status}. Stock updates when the delivery is received.` : "This order is no longer pending. Clear this form and select another delivery."}</p>`}
      <div className="row2"><label className="pf grow"><b>Supplier</b><span className="inline"><select className="select" disabled=${busy || selectedOrder?.status === "Ordered"} value=${supplierId} onChange=${(e) => setSupplierId(e.target.value)}>
          <option value="">Choose a supplier</option>${visibleSuppliers(data, showInactive).map((s) => html`<option key=${s.id} value=${s.id}>${s.name}${s.active ? "" : " (deactivated)"}</option>`)}</select>
          <button className="pbtn outline" disabled=${busy || selectedOrder?.status === "Ordered"} onClick=${() => { setNewSupplier({ name: "", email: "", phone: "" }); setMsg(null); }}>New supplier</button>
          ${chosen && html`<button className=${chosen.active ? "pbtn outline danger" : "pbtn outline"} disabled=${busy || selectedOrder?.status === "Ordered"} onClick=${() => setSupplierActive(!chosen.active)}>${chosen.active ? "Deactivate" : "Reactivate"}</button>`}</span>
          <${ShowInactive} checked=${showInactive} onChange=${setShowInactive} /></label>
        <label className="pf w210"><b>Delivery date</b><input className="field date" type="date" value=${date} onChange=${(e) => setDate(e.target.value)} /></label></div>
      ${newSupplier && html`<div className="newsupplier" role="group" aria-label="New supplier">
        <h3>New supplier</h3>
        <div className="row2"><label className="pf grow"><b>Name</b><input className="field" maxLength="100" value=${newSupplier.name} onChange=${(e) => setNewSupplier({ ...newSupplier, name: e.target.value })} /></label>
          <label className="pf grow"><b>Email (optional)</b><input className="field" type="email" value=${newSupplier.email} onChange=${(e) => setNewSupplier({ ...newSupplier, email: e.target.value })} /></label>
          <label className="pf grow"><b>Phone (optional)</b><input className="field" maxLength="30" value=${newSupplier.phone} onChange=${(e) => setNewSupplier({ ...newSupplier, phone: e.target.value })} /></label></div>
        <div className="pactions left"><button className="pbtn" onClick=${saveSupplier}>Save supplier</button><button className="pbtn outline" onClick=${() => setNewSupplier(null)}>Cancel</button></div>
      </div>`}
      <label className="pf"><b>Invoice number</b><input className="field" maxLength="50" value=${invoice} onChange=${(e) => setInvoice(e.target.value)} /></label>
      <div className="tscroll"><table className="table mg dlines t-lines">
        <colgroup><col /><col style=${{ width: 44 }} /><col style=${{ width: 106 }} /><col style=${{ width: 96 }} /><col style=${{ width: 104 }} /><col style=${{ width: 84 }} /></colgroup>
        <thead><tr><th>Stock item</th><th>Unit</th><th>Quantity received</th><th className="r">Total paid</th><th className="r">Unit cost</th><th></th></tr></thead>
        <tbody>${lines.map((l) => html`<tr key=${l.stockItemId}><td>${item(l.stockItemId)?.name}</td><td>${item(l.stockItemId)?.unit}</td>
          <td><input className="field cell" aria-label=${`Quantity of ${item(l.stockItemId)?.name}`} inputMode="decimal" value=${l.quantity} onChange=${(e) => setLine(l.stockItemId, { quantity: e.target.value.replace(/[^\d.]/g, "") })} /></td>
          <td className="r"><input className="field cell" aria-label=${`Total paid for ${item(l.stockItemId)?.name}`} inputMode="decimal" placeholder=${quoteHint(l)} value=${l.total} onChange=${(e) => setLine(l.stockItemId, { total: e.target.value.replace(/[^\d.]/g, "") })} /></td>
          <td className="r">${unitCost(l) == null ? "—" : unitMoney(unitCost(l))}</td>
          <td><button className="act" onClick=${() => setLines(lines.filter((x) => x !== l))}>Remove</button></td></tr>`)}
          ${!lines.length && html`<tr><td colSpan="6">No lines yet. Add a stock item below.</td></tr>`}</tbody>
      </table></div>
      <div className="addrow">
        <select className="select grow" aria-label="Stock item" value=${add} onChange=${(e) => setAdd(e.target.value)}>
          <option value="">Stock item</option>${data.items.map((i) => html`<option key=${i.id} value=${i.id}>${i.name}</option>`)}</select>
        <button className="pbtn outline" onClick=${addLine}>Add line</button>
      </div>
      <div className="costline"><span>Delivery total</span><span>${fromDollars(total)}</span></div>
      <${Message} msg=${msg} dashed />
      <div className="pactions left">${selectedOrder?.status === "Needs supplier"
        ? html`<button className="pbtn" disabled=${busy || !chosen?.active} onClick=${placeOrder}>Place simulated order</button>`
        : html`<button className="pbtn" disabled=${busy || (pendingId && !selectedOrder) || (chosen && !chosen.active)} onClick=${receive}>Receive into stock</button>`}<button className="pbtn outline" onClick=${() => { clear(); setMsg(null); }}>Clear</button></div>
    </section>
    <div className="stack grow delivery-dashboard">
    <section className="pview delivery-panel" aria-label="Recent deliveries">
      <header className="phead"><h3>Recent deliveries</h3>
        ${data.deliveries.length > 3 && html`<button className="act delivery-expand" aria-label=${recentExpanded ? "Collapse recent deliveries" : "Expand recent deliveries"} aria-expanded=${recentExpanded} aria-controls="recent-deliveries-list" onClick=${() => setRecentExpanded((v) => !v)}>
          <span>${recentExpanded ? "Show less" : `Show all (${data.deliveries.length})`}</span>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style=${{ transform: recentExpanded ? "rotate(180deg)" : undefined }}><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>`}
      </header>
      <div id="recent-deliveries-list" className=${recentExpanded ? "delivery-list expanded" : "delivery-list"}>
      <table className="table mg t-recent">
        <colgroup><col style=${{ width: 90 }} /><col /><col style=${{ width: 40 }} /><col style=${{ width: 70 }} /></colgroup>
        <thead><tr><th>Date</th><th>Supplier / purchase order</th><th className="r">Lines</th><th className="r">Total</th></tr></thead>
        <tbody>${(recentExpanded ? data.deliveries : data.deliveries.slice(0, 3)).map((d) => html`<tr key=${d.id}><td>${dayOf(d.date)}</td><td>${d.supplier}${d.orderNumber && html`<div className="sub">${d.orderNumber} · ${d.status}</div>`}</td><td className="r">${d.lines}</td><td className="r">${fromDollars(d.total)}</td></tr>`)}
          ${!data.deliveries.length && html`<tr><td colSpan="4">No deliveries yet.</td></tr>`}</tbody>
      </table>
      </div>
    </section>
    <section className="pview delivery-panel" aria-label="Pending deliveries">
      <header className="phead"><h3>Pending deliveries</h3>
        <div className="delivery-heading-actions"><span className="tag">${pending.length} pending</span>
          ${pending.length > 3 && html`<button className="act delivery-expand" aria-label=${pendingExpanded ? "Collapse pending deliveries" : "Expand pending deliveries"} aria-expanded=${pendingExpanded} aria-controls="pending-deliveries-list" onClick=${() => setPendingExpanded((v) => !v)}>
            <span>${pendingExpanded ? "Show less" : `Show all (${pending.length})`}</span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style=${{ transform: pendingExpanded ? "rotate(180deg)" : undefined }}><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>`}
        </div>
      </header>
      <div id="pending-deliveries-list" className=${pendingExpanded ? "delivery-list expanded" : "delivery-list"}>
      <table className="table mg pending-deliveries t-pending">
        <colgroup><col /><col style=${{ width: 92 }} /><col style=${{ width: 80 }} /><col style=${{ width: 96 }} /></colgroup>
        <thead><tr><th>Order / stock item / supplier</th><th>On hand / threshold</th><th>To receive</th><th>Action</th></tr></thead>
        <tbody>${(pendingExpanded ? pending : pending.slice(0, 3)).map((p) => html`<tr key=${p.id} className=${pendingId === p.id ? "sel" : ""}>
          <td><b>${p.orderNumber}</b><div>${p.item}</div><div className="sub">${p.supplier || "Choose a supplier to place this order"}</div><span className="tag">${p.status}</span>${!p.active && html`<span className="tag">deactivated</span>`}</td>
          <td>${qty(p.onHand)} / ${qty(p.reorderAt)} ${p.unit}</td><td>${qty(p.quantity)} ${p.unit}</td>
          <td>${data.canChange && html`<button className="act" disabled=${busy || !p.active || (p.supplierId && !p.supplierActive)} onClick=${() => prepare(p)}>${p.status === "Needs supplier" ? "Assign supplier" : "Receive"}</button>`}</td>
        </tr>`)}${!pending.length && html`<tr><td colSpan="4">No pending deliveries. Purchase orders appear here automatically when stock is low.</td></tr>`}</tbody>
      </table>
      </div>
    </section>
    </div>
  </div>`;
}

function CountTab({ data, reload }) {
  const [supplier, setSupplier] = useState("");
  const [counted, setCounted] = useState({});
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const rows = data.rows.filter((r) => r.active && (!supplier || r.supplierIds.includes(supplier)));
  const figures = rows.map((r) => {
    const c = num(counted[r.id]);
    const diff = c == null ? null : Math.round((c - r.onHand) * 1000) / 1000;
    return { r, c, diff, value: diff == null ? null : diff * (r.avgCost || 0) };
  });
  const done = figures.filter((f) => f.c != null);
  const differ = done.filter((f) => f.diff !== 0).length;
  const totalValue = done.reduce((a, f) => a + f.value, 0);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api("/inventory/count", { locationId: data.location.id, note, counts: done.map((f) => ({ stockItemId: f.r.id, counted: f.c })) });
      setCounted({}); setNote("");
      setMsg({ kind: "ok", text: `Count saved: ${r.counted} counted, ${r.differ} differ, ${moneyDelta(r.value)}.` });
      await reload();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
    setBusy(false);
  };

  return html`<section className="pview count" aria-label="Stock count">
    <header className="phead"><h2>Stock count</h2>
      <div className="pfilters wrap">
        <label className="pf"><b>Supplier</b><${SupplierSelect} data=${data} value=${supplier} onChange=${setSupplier} showInactive=${false} /></label>
        <button className="pbtn outline noprint" onClick=${() => window.print()}>Print count sheet</button></div></header>
    <div className="tscroll"><table className="table mg t-count">
      <colgroup><col /><col style=${{ width: 70 }} /><col style=${{ width: 86 }} /><col style=${{ width: 130 }} /><col style=${{ width: 84 }} /><col style=${{ width: 84 }} /></colgroup>
      <thead><tr><th>Stock item</th><th>Unit</th><th className="r">In system</th><th>Counted</th><th className="r">Difference</th><th className="r">Value</th></tr></thead>
      <tbody>${figures.map(({ r, diff, value }) => html`<tr key=${r.id}><td>${r.name}</td><td>${r.unit}</td><td className="r">${qty(r.onHand)}</td>
        <td><input className="field cell" aria-label=${`Counted ${r.name}`} inputMode="decimal" value=${counted[r.id] ?? ""} onChange=${(e) => setCounted({ ...counted, [r.id]: e.target.value.replace(/[^\d.]/g, "") })} /></td>
        <td className="r">${diff == null ? "[±0]" : delta(diff)}</td><td className="r">${value == null ? "[$0.00]" : moneyDelta(value)}</td></tr>`)}
        ${!rows.length && html`<tr><td colSpan="6">Nothing to count here.</td></tr>`}</tbody>
    </table></div>
    <div className="totals">
      <div className="box"><span>Items counted</span><b>${done.length} of ${rows.length}</b><${CardIcon} label="Items counted" /></div>
      <div className="box"><span>Items that differ</span><b>${differ}</b><${CardIcon} label="Items that differ" /></div>
      <div className="box"><span>Value of difference</span><b>${moneyDelta(totalValue)}</b><${CardIcon} label="Value of difference" /></div>
    </div>
    <label className="pf"><b>Note (optional)</b><input className="field" maxLength="255" value=${note} onChange=${(e) => setNote(e.target.value)} /></label>
    <${Message} msg=${msg} dashed />
    <div className="pactions left noprint"><button className="pbtn" disabled=${busy || !done.length} onClick=${save}>Save count and adjust stock</button>
      <button className="pbtn outline" onClick=${() => { setCounted({}); setNote(""); setMsg(null); }}>Clear</button></div>
  </section>`;
}

function App() {
  const me = useMe();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState(tabFromHash);
  const [showInactive, setShowInactive] = useState(false); // one switch for deactivated stock items and suppliers, on every tab that has it
  const place = useRef("");
  const latest = useRef(0);
  const load = useCallback((id) => {
    if (id !== undefined) place.current = id;
    const n = ++latest.current; // only the newest answer fills the page
    return api(`/inventory?locationId=${encodeURIComponent(place.current)}`).then((d) => { if (n === latest.current) { setData(d); place.current = d.location.id; setError(""); } }).catch((e) => { if (n === latest.current) setError(e.message); });
  }, []);
  useEffect(() => { load(""); }, [load]);
  useEffect(() => { // Back and Forward move between tabs
    const onPop = () => setTab(tabFromHash());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (tab !== "delivery") return;
    const refresh = () => { if (!document.hidden) load(); };
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [tab, load]);
  const go = (k) => { setTab(k); window.history.pushState(null, "", k === "stock" ? window.location.pathname : `#${k}`); };

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Inventory" />
    <section className="main scrolls" aria-label="Inventory">
      <${PageTitle}>Inventory<//>
      ${error ? html`<p className="success" role="alert">${error}</p>` : !data ? html`<p className="success">Loading…</p>` : html`<${React.Fragment}>
        <div className="inventory-toolbar">
          <${Tabs} tab=${tab} onTab=${go} />
          <${LocationSelect} data=${data} onLocation=${load} />
        </div>
        ${tab === "stock" && html`<${StockTab} key=${data.location.id} data=${data} reload=${() => load()} showInactive=${showInactive} setShowInactive=${setShowInactive} />`}
        ${tab === "delivery" && html`<${DeliveryTab} key=${data.location.id} data=${data} reload=${() => load()} showInactive=${showInactive} setShowInactive=${setShowInactive} />`}
        ${tab === "count" && html`<${CountTab} key=${data.location.id} data=${data} reload=${() => load()} />`}
      <//>`}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
