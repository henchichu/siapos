const KEY = "orders.filters"; // kept for the tab, so Back to orders lands on the same search
const BLANK = { from: "", to: "", locationId: "all", employeeId: "all", status: "any" };
const saved = () => { try { return { ...BLANK, ...JSON.parse(sessionStorage.getItem(KEY)) }; } catch (err) { return BLANK; } };

function Field({ label, children }) {
  return html`<label className="ofield">${label}${children}</label>`;
}

function App() {
  const me = useMe();
  const [draft, setDraft] = useState(saved);
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (f) => {
    setBusy(true);
    try {
      const d = await api(`/orders?${new URLSearchParams(f)}`);
      setData(d); setMsg(null);
      const applied = { ...f, from: d.from, to: d.to }; // a blank date came back as today
      setDraft(applied);
      try { sessionStorage.setItem(KEY, JSON.stringify(applied)); } catch (err) { /* storage can be blocked */ }
    } catch (err) { setMsg({ kind: "error", text: err.message }); }
    setBusy(false);
  }, []);
  useEffect(() => { search(saved()); }, [search]);

  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const go = (id) => { window.location.href = `/order.html?id=${encodeURIComponent(id)}`; };
  const filters = data?.filters;
  const phone = usePhone();
  // a phone shows the Filters button inside the Results card, like every other list; wider screens keep the form above it
  const searchBox = html`<${Filters} popup active=${(draft.locationId !== "all" ? 1 : 0) + (draft.employeeId !== "all" ? 1 : 0) + (draft.status !== "any" ? 1 : 0)}><form className="osearch" aria-label="Search orders" onSubmit=${(e) => { e.preventDefault(); search(draft); }}>
        <div className="ofilters">
          <${Field} label="From date"><input className="field date" type="date" value=${draft.from} onChange=${set("from")} /><//>
          <${Field} label="To date"><input className="field date" type="date" value=${draft.to} onChange=${set("to")} /><//>
          <${Field} label="Location"><select className="select" value=${draft.locationId} onChange=${set("locationId")}>
            <option value="all">All locations</option>${(filters?.locations || []).map((l) => html`<option key=${l.id} value=${l.id}>${l.name}</option>`)}</select><//>
          <${Field} label="Employee"><select className="select" value=${draft.employeeId} onChange=${set("employeeId")}>
            <option value="all">All employees</option>${(filters?.employees || []).map((e) => html`<option key=${e.id} value=${e.id}>${e.name}</option>`)}</select><//>
          <${Field} label="Status"><select className="select" value=${draft.status} onChange=${set("status")}>
            <option value="any">Any status</option>${(filters?.statuses || []).map((s) => html`<option key=${s.code} value=${s.code}>${s.name}</option>`)}</select><//>
        </div>
        <button className="pbtn" type="submit" disabled=${busy}>Search</button>
      </form><//>`;

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Orders" />
    <section className="main scrolls" aria-label="Orders">
      <header className="ohead"><${PageTitle}>Orders<//></header>
      ${!phone && searchBox}
      <${Message} msg=${msg} dashed />
      ${data && html`<section className="results" aria-label="Results">
        <header><h3>Results</h3><span className="sub" role="status">${data.count} ${data.count === 1 ? "order" : "orders"} found${data.count > data.shown ? ` · showing the newest ${data.shown}` : ""}</span><div className="cardtools"><span className="filterslot"></span></div></header>
        ${phone && searchBox}
        ${data.orders.length === 0 ? html`<p className="sub">No orders match these filters.</p>` : html`<div className="tscroll"><table className="table clickable fit rowcards t-orders">
<thead><tr><th scope="col">Date and time</th><th scope="col">Order</th><th scope="col">Source</th><th scope="col">Employee</th><th scope="col">Member</th><th scope="col">Status</th><th scope="col" className="r">Total</th></tr></thead>
          <tbody>${data.orders.map((o) => html`<tr key=${o.id} onClick=${() => go(o.id)}>
            <td className="nw">${when(o.placedAt, o.timeZone)}</td>
            <td><a href=${`/order.html?id=${encodeURIComponent(o.id)}`} aria-label=${`Order ${o.orderNumber}, details`} onClick=${(e) => e.stopPropagation()}>${o.orderNumber}</a></td>
            <td>${o.source}</td><td>${o.employee || "—"}</td><td>${o.member}</td><td className="nw">${o.status}</td><td className="r">${fromDollars(o.total)}</td></tr>`)}</tbody></table></div>`}
      </section>`}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
