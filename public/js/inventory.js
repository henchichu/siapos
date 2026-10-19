const TABS = [["stock", "Stock"], ["delivery", "Receive delivery"], ["count", "Stock count"]];
const tabFromHash = () => { const h = window.location.hash.slice(1); return TABS.some(([k]) => k === h) ? h : "stock"; };
const REASONS = [["broken", "Broken or spilled"], ["spoiled", "Spoiled or expired"], ["stolen", "Stolen"], ["correction", "Count correction"]];

const qty = (n) => String(Math.round(n * 1000) / 1000);
// A unit cost worked out from a total can need many places (a millilitre of milk costs a fraction of a cent)
const unitMoney = (n) => (n == null ? "—" : n >= 0.1 ? `$${n.toFixed(2)}` : `$${n.toFixed(6).replace(/0+$/, "").padEnd(6, "0")}`);
const usd = (n) => `$${n.toFixed(2)}`;
const delta = (n) => (n > 0 ? `+${qty(n)}` : n < 0 ? `−${qty(-n)}` : "±0");
const moneyDelta = (n) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}$${Math.abs(n).toFixed(2)}`;
const when = (iso, tz) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
const dayText = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
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

// ---- Stock ------------------------------------------------------------------------------------------------------

function StockTab({ data, reload, onLocation, showInactive, setShowInactive }) {
  const [supplier, setSupplier] = useState("");
  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
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

  return html`<div className="split">
    <div className="stack grow">
      <section className="pview" aria-label="Inventory">
        <header className="phead"><h2>Inventory</h2>${data.canChange && html`<button className="pbtn" onClick=${showAdd}>Add stock item</button>`}</header>
        <div className="pfilters wrap">
          <${LocationSelect} data=${data} onLocation=${onLocation} />
          <${SupplierSelect} data=${data} value=${supplier} onChange=${setSupplier} showInactive=${showInactive} />
          <input className="field" aria-label="Stock item name" placeholder="Stock item name" value=${query} onChange=${(e) => setQuery(e.target.value)} />
          <label className="check"><input type="checkbox" checked=${lowOnly} onChange=${(e) => setLowOnly(e.target.checked)} /> Low stock only</label>
          <${ShowInactive} checked=${showInactive} onChange=${setShowInactive} />
        </div>
        ${note && html`<p className="status" role="status">${note}</p>`}
        <table className="table mg">
          <colgroup><col /><col style=${{ width: 96 }} /><col style=${{ width: 78 }} /><col style=${{ width: 72 }} /><col style=${{ width: 52 }} />${data.canChange && html`<col style=${{ width: 250 }} />`}</colgroup>
          <thead><tr><th>Stock item</th><th>On hand</th><th className="r">Reorder at</th><th className="r">Avg cost</th><th>Status</th>${data.canChange && html`<th>Actions</th>`}</tr></thead>
          <tbody>${rows.map((r) => html`<tr key=${r.id} className=${`${form?.stockItemId === r.id ? "sel" : ""} ${r.active ? "" : "off"}`}>
            <td>${r.name}${!r.active && html`<span className="tag">deactivated</span>`}</td><td>${qty(r.onHand)} ${r.unit}</td><td className="r">${qty(r.reorderAt)}</td><td className="r">${unitMoney(r.avgCost)}</td>
            <td className=${r.active && isLow(r) ? "state low" : "state"}>${!r.active ? "—" : isLow(r) ? "LOW" : "OK"}</td>
            ${data.canChange && html`<td><div className="acts">${r.active
              ? html`<${React.Fragment}><button className="act" onClick=${() => show(r, "restock")}>Restock</button><button className="act" onClick=${() => show(r, "adjust")}>Adjust</button>
                  <button className="act" onClick=${() => setActive(r, false)}>Deactivate</button><//>`
              : html`<button className="act" onClick=${() => setActive(r, true)}>Reactivate</button>`}</div></td>`}</tr>`)}
            ${!rows.length && html`<tr><td colSpan="6">No stock items match.</td></tr>`}</tbody>
        </table>
      </section>
      <section className="pview" aria-label="Recent stock movements">
        <h2>Recent stock movements</h2>
        <table className="table mg">
          <colgroup><col style=${{ width: 120 }} /><col style=${{ width: 130 }} /><col /><col style=${{ width: 70 }} /><col style=${{ width: 80 }} /><col style=${{ width: 60 }} /></colgroup>
          <thead><tr><th>Date and time</th><th>Stock item</th><th>Type</th><th className="r">Change</th><th>Employee</th><th>Order</th></tr></thead>
          <tbody>${data.movements.map((m, i) => html`<tr key=${i}><td>${when(m.at, data.location.timeZone)}</td><td>${m.item}</td><td>${m.type}</td>
            <td className="r">${delta(m.delta)} ${m.unit}</td><td>${m.by || "—"}</td><td>${m.orderNumber ?? "—"}</td></tr>`)}
            ${!data.movements.length && html`<tr><td colSpan="6">No movements yet.</td></tr>`}</tbody>
        </table>
      </section>
    </div>
    ${adding && html`<aside className="pform pside" aria-label="Add stock item">
      <h2>Add stock item</h2>
      <label className="pf"><b>Name</b><input className="field" maxLength="150" value=${adding.name} onChange=${(e) => setNew({ name: e.target.value })} /></label>
      <label className="pf"><b>Unit</b><select className="select" value=${adding.unitCode} onChange=${(e) => setNew({ unitCode: e.target.value })}>
        <option value="">Choose how it is counted</option>${data.units.map((u) => html`<option key=${u.code} value=${u.code}>${u.description} (${u.symbol})</option>`)}</select></label>
      <label className="pf"><b>Reorder threshold</b><input className="field" inputMode="decimal" value=${adding.threshold} onChange=${(e) => setNew({ threshold: e.target.value.replace(/[^\d.]/g, "") })} /></label>
      <label className="pf"><b>Supplier (optional)</b><${SupplierSelect} data=${data} value=${adding.supplierId} onChange=${(v) => setNew({ supplierId: v })} empty="No supplier" label="Supplier for the new item" /></label>
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" onClick=${saveItem}>Save</button><button className="pbtn outline" onClick=${close}>Clear</button></div>
    </aside>`}
    ${form && html`<aside className="pform pside" aria-label="Record stock change">
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

// ---- Receive delivery -------------------------------------------------------------------------------------------

function DeliveryTab({ data, reload, showInactive, setShowInactive }) {
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
  const clear = () => { setSupplierId(""); setDate(data.location.today); setInvoice(""); setLines([]); setAdd(""); };
  // the supplier's quoted price times the quantity, as a hint for what the total should be
  const quoteHint = (l) => { const q = data.quotes.find((x) => x.stockItemId === l.stockItemId && x.supplierId === supplierId)?.unitCost; return q != null && num(l.quantity) > 0 ? `≈ ${(q * num(l.quantity)).toFixed(2)}` : ""; };
  const setLine = (id, patch) => setLines(lines.map((l) => (l.stockItemId === id ? { ...l, ...patch } : l)));

  const addLine = () => {
    if (!add) return setMsg({ kind: "error", text: "Choose a stock item to add." });
    if (lines.some((l) => l.stockItemId === add)) return setMsg({ kind: "error", text: "That item is already on the delivery." });
    setLines([...lines, { stockItemId: add, quantity: "", total: "" }]); setAdd(""); setMsg(null);
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
      const r = await api("/inventory/delivery", { locationId: data.location.id, supplierId, deliveredOn: date, invoice, lines });
      clear();
      setMsg({ kind: "ok", text: `Delivery received: ${r.lines} ${r.lines === 1 ? "line" : "lines"}, ${usd(r.total)}.` });
      await reload();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
    setBusy(false);
  };

  return html`<div className="split">
    <section className="pview wide-form" aria-label="Receive delivery">
      <h2>Receive delivery</h2>
      <p className="sub">Receiving at ${data.location.name}</p>
      <div className="row2"><label className="pf grow"><b>Supplier</b><span className="inline"><select className="select" value=${supplierId} onChange=${(e) => setSupplierId(e.target.value)}>
          <option value="">Choose a supplier</option>${visibleSuppliers(data, showInactive).map((s) => html`<option key=${s.id} value=${s.id}>${s.name}${s.active ? "" : " (deactivated)"}</option>`)}</select>
          <button className="pbtn outline" onClick=${() => { setNewSupplier({ name: "", email: "", phone: "" }); setMsg(null); }}>New supplier</button>
          ${chosen && html`<button className="pbtn outline" onClick=${() => setSupplierActive(!chosen.active)}>${chosen.active ? "Deactivate" : "Reactivate"}</button>`}</span>
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
      <table className="table mg dlines">
        <colgroup><col /><col style=${{ width: 44 }} /><col style=${{ width: 106 }} /><col style=${{ width: 96 }} /><col style=${{ width: 84 }} /><col style=${{ width: 84 }} /></colgroup>
        <thead><tr><th>Stock item</th><th>Unit</th><th>Quantity received</th><th>Total paid</th><th className="r">Unit cost</th><th></th></tr></thead>
        <tbody>${lines.map((l) => html`<tr key=${l.stockItemId}><td>${item(l.stockItemId)?.name}</td><td>${item(l.stockItemId)?.unit}</td>
          <td><input className="field cell" aria-label=${`Quantity of ${item(l.stockItemId)?.name}`} inputMode="decimal" value=${l.quantity} onChange=${(e) => setLine(l.stockItemId, { quantity: e.target.value.replace(/[^\d.]/g, "") })} /></td>
          <td><input className="field cell" aria-label=${`Total paid for ${item(l.stockItemId)?.name}`} inputMode="decimal" placeholder=${quoteHint(l)} value=${l.total} onChange=${(e) => setLine(l.stockItemId, { total: e.target.value.replace(/[^\d.]/g, "") })} /></td>
          <td className="r">${unitCost(l) == null ? "—" : unitMoney(unitCost(l))}</td>
          <td><button className="act" onClick=${() => setLines(lines.filter((x) => x !== l))}>Remove</button></td></tr>`)}
          ${!lines.length && html`<tr><td colSpan="6">No lines yet. Add a stock item below.</td></tr>`}</tbody>
      </table>
      <div className="addrow">
        <select className="select grow" aria-label="Stock item" value=${add} onChange=${(e) => setAdd(e.target.value)}>
          <option value="">Stock item</option>${data.items.map((i) => html`<option key=${i.id} value=${i.id}>${i.name}</option>`)}</select>
        <button className="pbtn outline" onClick=${addLine}>Add line</button>
      </div>
      <div className="costline"><span>Delivery total</span><span>${usd(total)}</span></div>
      <${Message} msg=${msg} dashed />
      <div className="pactions left"><button className="pbtn" disabled=${busy || (chosen && !chosen.active)} onClick=${receive}>Receive into stock</button><button className="pbtn outline" onClick=${() => { clear(); setMsg(null); }}>Clear</button></div>
    </section>
    <section className="pview grow" aria-label="Recent deliveries">
      <h3>Recent deliveries</h3>
      <table className="table mg">
        <colgroup><col style=${{ width: 90 }} /><col /><col style=${{ width: 40 }} /><col style=${{ width: 70 }} /></colgroup>
        <thead><tr><th>Date</th><th>Supplier</th><th className="r">Lines</th><th className="r">Total</th></tr></thead>
        <tbody>${data.deliveries.map((d) => html`<tr key=${d.id}><td>${dayText(d.date)}</td><td>${d.supplier}</td><td className="r">${d.lines}</td><td className="r">${usd(d.total)}</td></tr>`)}
          ${!data.deliveries.length && html`<tr><td colSpan="4">No deliveries yet.</td></tr>`}</tbody>
      </table>
    </section>
  </div>`;
}

// ---- Stock count ------------------------------------------------------------------------------------------------

function CountTab({ data, reload, onLocation }) {
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
      <div className="pfilters wrap"><label className="pf"><b>Location</b><${LocationSelect} data=${data} onLocation=${onLocation} /></label>
        <label className="pf"><b>Supplier</b><${SupplierSelect} data=${data} value=${supplier} onChange=${setSupplier} showInactive=${false} /></label>
        <button className="pbtn outline noprint" onClick=${() => window.print()}>Print count sheet</button></div></header>
    <table className="table mg">
      <colgroup><col /><col style=${{ width: 70 }} /><col style=${{ width: 86 }} /><col style=${{ width: 130 }} /><col style=${{ width: 84 }} /><col style=${{ width: 84 }} /></colgroup>
      <thead><tr><th>Stock item</th><th>Unit</th><th className="r">In system</th><th>Counted</th><th className="r">Difference</th><th className="r">Value</th></tr></thead>
      <tbody>${figures.map(({ r, diff, value }) => html`<tr key=${r.id}><td>${r.name}</td><td>${r.unit}</td><td className="r">${qty(r.onHand)}</td>
        <td><input className="field cell" aria-label=${`Counted ${r.name}`} inputMode="decimal" value=${counted[r.id] ?? ""} onChange=${(e) => setCounted({ ...counted, [r.id]: e.target.value.replace(/[^\d.]/g, "") })} /></td>
        <td className="r">${diff == null ? "[±0]" : delta(diff)}</td><td className="r">${value == null ? "[$0.00]" : moneyDelta(value)}</td></tr>`)}
        ${!rows.length && html`<tr><td colSpan="6">Nothing to count here.</td></tr>`}</tbody>
    </table>
    <div className="totals">
      <div className="box"><span>Items counted</span><b>${done.length} of ${rows.length}</b></div>
      <div className="box"><span>Items that differ</span><b>${differ}</b></div>
      <div className="box"><span>Value of difference</span><b>${moneyDelta(totalValue)}</b></div>
    </div>
    <label className="pf"><b>Note (optional)</b><input className="field" maxLength="255" value=${note} onChange=${(e) => setNote(e.target.value)} /></label>
    <${Message} msg=${msg} dashed />
    <div className="pactions left noprint"><button className="pbtn" disabled=${busy || !done.length} onClick=${save}>Save count and adjust stock</button>
      <button className="pbtn outline" onClick=${() => { setCounted({}); setNote(""); setMsg(null); }}>Clear</button></div>
  </section>`;
}

// ---- Page -------------------------------------------------------------------------------------------------------

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
    return api(`/inventory?locationId=${encodeURIComponent(place.current)}`).then((d) => { if (n === latest.current) { setData(d); place.current = d.location.id; } }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(""); }, [load]);
  useEffect(() => { // Back and Forward move between tabs
    const onPop = () => setTab(tabFromHash());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (k) => { setTab(k); window.history.pushState(null, "", k === "stock" ? window.location.pathname : `#${k}`); };

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Inventory" />
    <section className="main scrolls" aria-label="Inventory">
      ${error ? html`<p className="success" role="alert">${error}</p>` : !data ? html`<p className="success">Loading…</p>` : html`<${React.Fragment}>
        <${Tabs} tab=${tab} onTab=${go} />
        ${tab === "stock" && html`<${StockTab} key=${data.location.id} data=${data} reload=${() => load()} onLocation=${load} showInactive=${showInactive} setShowInactive=${setShowInactive} />`}
        ${tab === "delivery" && html`<${DeliveryTab} key=${data.location.id} data=${data} reload=${() => load()} showInactive=${showInactive} setShowInactive=${setShowInactive} />`}
        ${tab === "count" && html`<${CountTab} key=${data.location.id} data=${data} reload=${() => load()} onLocation=${load} />`}
      <//>`}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
