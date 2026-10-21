// Reports: Live sales opens first; the numbered reports run over a date range or a pay period. Money arrives in cents.
const TABS = [["live", "Live sales"], ["sales", "1. Sales by day"], ["top", "2. Top sellers"], ["labor", "3. Labor cost"], ["losses", "4. Stock losses"]];
const tabFromHash = () => { const h = window.location.hash.slice(1); return TABS.some(([k]) => k === h) ? h : "live"; };
const REFRESH_MS = 60 * 1000;

const off = (cents) => money(-cents); // discounts and refunds read as money taken off
const pct = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const hrs = (n) => n.toFixed(2);
const units = (n) => String(Math.round(n * 1000) / 1000);
const hourName = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
const shortDay = (d, weekday) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { weekday: weekday ? "short" : undefined, month: "short", day: "numeric", timeZone: "UTC" });
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Loads one report; only the newest answer fills the page
function useReport(path) {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  const latest = useRef(0);
  const run = useCallback((params) => {
    const n = ++latest.current;
    return api(`${path}?${new URLSearchParams(params)}`)
      .then((d) => { if (n === latest.current) { setData(d); setMsg(null); } })
      .catch((e) => { if (n === latest.current) setMsg({ kind: "error", text: e.message }); });
  }, [path]);
  return { data, msg, run };
}

// ---- pieces every report shares -----------------------------------------------------------------------------------

// A template with several cells side by side: htm hands back an array, which React would want keys for
const frag = (strings, ...values) => {
  const out = html(strings, ...values);
  return Array.isArray(out) ? React.createElement(React.Fragment, null, ...out) : out;
};

const Tile = ({ label, value, dark }) => html`<div className=${dark ? "tile dark" : "tile"}><span>${label}</span><b>${value}</b></div>`;

const Field = ({ label, children }) => html`<label>${label}${children}</label>`;
const DateField = ({ label, value, onChange }) => html`<${Field} label=${label}>
  <input className="field" type="date" value=${value} onChange=${(e) => onChange(e.target.value)} /><//>`;
const Choose = ({ label, value, onChange, options, all }) => html`<${Field} label=${label}>
  <select className="select" value=${value} onChange=${(e) => onChange(e.target.value)}>
    ${all && html`<option value="all">${all}</option>`}
    ${options.map((o) => html`<option key=${o.id} value=${o.id}>${o.name}</option>`)}</select><//>`;

// cols: [width | 0, heading, right-aligned?]; foot: the Total row's cells, or nothing
function Table({ label, cols, children, foot, empty, span }) {
  return html`<table className="table mg" aria-label=${label}>
    <colgroup>${cols.map(([w], i) => html`<col key=${i} style=${w ? { width: w } : undefined} />`)}</colgroup>
    <thead><tr>${cols.map(([, h, right], i) => html`<th key=${i} className=${right ? "r" : ""}>${h}</th>`)}</tr></thead>
    <tbody>${children}${empty && html`<tr><td colSpan=${span || cols.length} className="note">${empty}</td></tr>`}</tbody>
    ${foot && html`<tfoot><tr>${foot}</tr></tfoot>`}
  </table>`;
}

// One bar per point, sized against the biggest. Hovering a bar shows its figures; the table under it lists them all.
function Bars({ label, points }) {
  const [hover, setHover] = useState(null);
  if (!points.length) return html`<div className="empty-chart">No sales yet.</div>`;
  const max = Math.max(...points.map((p) => p.value), 1);
  const every = Math.ceil(points.length / 12); // label every nth bar so the labels never collide
  const edge = (i) => (i < points.length / 4 ? " start" : i >= (points.length * 3) / 4 ? " end" : "");
  return html`<figure className="chart" role="img" aria-label=${`${label}. The table lists every figure.`}>
    <div className="plot" onMouseLeave=${() => setHover(null)}>
      ${points.map((p, i) => html`<div key=${p.key} className="col" onMouseEnter=${() => setHover(i)}>
        <div className="bar" style=${{ height: `${(Math.max(p.value, 0) / max) * 100}%` }}></div>
        ${hover === i && html`<div className=${`tip${edge(i)}`}><b>${p.label}</b>${p.lines.map((l) => html`<span key=${l}>${l}</span>`)}</div>`}
      </div>`)}
    </div>
    <div className="ticks" aria-hidden="true">${points.map((p, i) => html`<span key=${p.key}>${i % every === 0 ? p.tick : ""}</span>`)}</div>
  </figure>`;
}

// ---- Live sales ---------------------------------------------------------------------------------------------------

function LiveTab({ opts }) {
  const { data, msg, run } = useReport("/reports/live");
  const [day, setDay] = useState(opts.today);
  const [where, setWhere] = useState(opts.owner ? "all" : opts.liveLocations[0]?.id || "");
  const [view, setView] = useState("hour");
  useEffect(() => {
    const load = () => run({ day, locationId: where, view });
    load();
    if (day !== opts.today) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS); // today keeps itself up to date
    return () => clearInterval(timer);
  }, [day, where, view, run, opts.today]);

  const t = data?.totals;
  const byDay = data?.view === "day";
  const name = (k) => (byDay ? shortDay(k, true) : hourName(k));
  const costs = opts.canCosts;
  return html`<${React.Fragment}>
    <div className="filters">
      <${DateField} label="Day" value=${day} onChange=${(v) => v && setDay(v)} />
      <${Choose} label="Location" value=${where} onChange=${setWhere} options=${opts.liveLocations} all=${opts.owner && "All locations"} />
      <div className="segs" role="group" aria-label="Show">
        <button className="tab" aria-pressed=${view === "hour"} onClick=${() => setView("hour")}>By hour</button>
        <button className="tab" aria-pressed=${view === "day"} onClick=${() => setView("day")}>By day</button></div>
      ${data && html`<span className="updated">Updated ${clock(data.updatedAt, data.timeZone)}</span>`}
    </div>
    <${Message} msg=${msg} />
    ${data && html`<${React.Fragment}>
      <div className="tiles">
        <${Tile} label="Gross sales" value=${money(t.grossCents)} />
        <${Tile} label="Discounts" value=${off(t.discountCents)} />
        <${Tile} label="Refunds" value=${off(t.refundCents)} />
        <${Tile} label=${data.day === data.today ? "Net sales so far" : "Net sales"} value=${money(t.netCents)} dark />
        ${costs && html`<${Tile} label="Cost of goods" value=${money(t.costCents)} />`}
        ${costs && html`<${Tile} label="Profit" value=${money(t.profitCents)} />`}
        <${Tile} label="Tips" value=${money(t.tipCents)} />
      </div>
      <section className="rsection">
        <h3>${byDay ? "Net sales by day" : "Net sales by hour"}</h3>
        <${Bars} label=${byDay ? "Net sales by day" : "Net sales by hour"} points=${data.rows.map((r) => ({
          key: r.key, label: name(r.key), tick: byDay ? shortDay(r.key, true).split(",")[0] : hourName(r.key), value: r.netCents,
          lines: [`${money(r.netCents)} net`, `${r.orders} order${r.orders === 1 ? "" : "s"}`],
        }))} />
      </section>
      <section className="rsection">
        <h3>${byDay ? "Day by day" : "Hour by hour"}</h3>
        <${Table} label=${byDay ? "Day by day" : "Hour by hour"}
          cols=${[[0, byDay ? "Day" : "Hour"], [72, "Orders", 1], [96, "Gross", 1], [96, "Discounts", 1], [96, "Refunds", 1], [96, "Net sales", 1],
            ...(costs ? [[96, "Cost", 1], [96, "Profit", 1]] : []), [110, "Running net", 1]]}
          empty=${!data.rows.length && "No sales on this day yet."}
          foot=${data.rows.length > 0 && frag`<td>Total</td><td className="r">${t.orders}</td><td className="r">${money(t.grossCents)}</td><td className="r">${off(t.discountCents)}</td>
            <td className="r">${off(t.refundCents)}</td><td className="r">${money(t.netCents)}</td>
            ${costs && frag`<td className="r">${money(t.costCents)}</td><td className="r">${money(t.profitCents)}</td>`}<td></td>`}>
          ${data.rows.map((r) => html`<tr key=${r.key}><td>${name(r.key)}</td><td className="r">${r.orders}</td><td className="r">${money(r.grossCents)}</td>
            <td className="r">${off(r.discountCents)}</td><td className="r">${off(r.refundCents)}</td><td className="r">${money(r.netCents)}</td>
            ${costs && frag`<td className="r">${money(r.costCents)}</td><td className="r">${money(r.profitCents)}</td>`}<td className="r">${money(r.runningNetCents)}</td></tr>`)}
        <//>
      </section>
    <//>`}
  <//>`;
}

// ---- the date-range reports share their filters and a Run report button --------------------------------------------

function useRange(opts) {
  const [from, setFrom] = useState(addDays(opts.today, -6));
  const [to, setTo] = useState(opts.today);
  const [where, setWhere] = useState("all");
  return { from, to, where, params: { from, to, locationId: where }, fields: html`<${React.Fragment}>
    <${DateField} label="From date" value=${from} onChange=${setFrom} />
    <${DateField} label="To date" value=${to} onChange=${setTo} />
    <${Choose} label="Location" value=${where} onChange=${setWhere} options=${opts.locations} all="All locations" /><//>` };
}

function Filters({ children, onRun }) {
  return html`<form className="filters" onSubmit=${(e) => { e.preventDefault(); onRun(); }}>
    ${children}<button className="pbtn" type="submit">Run report</button></form>`;
}

// 1. Sales by day
function SalesTab({ opts }) {
  const { data, msg, run } = useReport("/reports/sales");
  const range = useRange(opts);
  const go = () => run(range.params);
  useEffect(() => { go(); }, []); // first run, with the default dates
  const t = data?.totals;
  return html`<${React.Fragment}>
    <${Filters} onRun=${go}>${range.fields}<//>
    <${Message} msg=${msg} />
    ${data && html`<${React.Fragment}>
      <div className="tiles four">
        <${Tile} label="Net sales" value=${money(t.netCents)} />
        <${Tile} label="Orders" value=${t.orders} />
        <${Tile} label="Average order" value=${money(t.orders ? Math.round(t.salesCents / t.orders) : 0)} />
        <${Tile} label="Tax collected" value=${money(t.taxCents)} />
      </div>
      <div className="duo">
        <section className="rsection">
          <h3>Net sales per day</h3>
          <${Bars} label="Net sales per day" points=${data.chart.map((d) => ({ key: d.date, label: dayOf(d.date), tick: shortDay(d.date), value: d.netCents, lines: [`${money(d.netCents)} net`] }))} />
        </section>
        <section className="rsection">
          <h3>Sales by day and location</h3>
          <${Table} label="Sales by day and location"
            cols=${[[104, "Date"], [0, "Location"], [64, "Orders", 1], [88, "Gross", 1], [88, "Discounts", 1], [88, "Refunds", 1], [88, "Net sales", 1]]}
            empty=${!data.rows.length && "No sales in these dates."}
            foot=${data.rows.length > 0 && frag`<td>Total</td><td></td><td className="r">${t.orders}</td><td className="r">${money(t.grossCents)}</td>
              <td className="r">${off(t.discountCents)}</td><td className="r">${off(t.refundCents)}</td><td className="r">${money(t.netCents)}</td>`}>
            ${data.rows.map((r) => html`<tr key=${r.date + r.location}><td>${dayOf(r.date)}</td><td>${r.location}</td><td className="r">${r.orders}</td>
              <td className="r">${money(r.grossCents)}</td><td className="r">${off(r.discountCents)}</td><td className="r">${off(r.refundCents)}</td><td className="r">${money(r.netCents)}</td></tr>`)}
          <//>
        </section>
      </div>
    <//>`}
  <//>`;
}

// 2. Top sellers: one ranking across every product; the category filter narrows it
function TopTab({ opts }) {
  const { data, msg, run } = useReport("/reports/top-sellers");
  const range = useRange(opts);
  const [category, setCategory] = useState("all");
  const go = () => run({ ...range.params, categoryId: category });
  useEffect(() => { go(); }, []); // first run, with the default dates
  const t = data?.totals;
  const costs = opts.canCosts;
  return html`<${React.Fragment}>
    <${Filters} onRun=${go}>${range.fields}<${Choose} label="Category" value=${category} onChange=${setCategory} options=${opts.categories} all="All categories" /><//>
    <${Message} msg=${msg} />
    ${data && html`<${React.Fragment}>
      <div className="tiles four">
        <${Tile} label="Units sold" value=${units(t.units)} />
        <${Tile} label="Revenue" value=${money(t.revenueCents)} />
        ${costs && html`<${Tile} label="Cost of goods" value=${money(t.costCents)} />`}
        ${costs && html`<${Tile} label="Margin" value=${pct(t.marginPct)} />`}
      </div>
      <section className="rsection">
        <h3>Top sellers</h3>
        <${Table} label="Top sellers"
          cols=${[[56, "Rank", 1], [0, "Product"], [140, "Category"], [88, "Units sold", 1], [96, "Revenue", 1], ...(costs ? [[88, "Cost", 1], [96, "Margin $", 1], [80, "Margin %", 1]] : [])]}
          empty=${!data.rows.length && "Nothing sold in these dates."}
          foot=${data.rows.length > 0 && frag`<td></td><td>Total</td><td></td><td className="r">${units(t.units)}</td><td className="r">${money(t.revenueCents)}</td>
            ${costs && frag`<td className="r">${money(t.costCents)}</td><td className="r">${money(t.marginCents)}</td><td className="r">${pct(t.marginPct)}</td>`}`}>
          ${data.rows.map((r) => html`<tr key=${r.rank}><td className="r">${r.rank}</td><td>${r.product}</td><td>${r.category || "—"}</td><td className="r">${units(r.units)}</td>
            <td className="r">${money(r.revenueCents)}</td>
            ${costs && frag`<td className="r">${money(r.costCents)}</td><td className="r">${money(r.marginCents)}</td><td className="r">${pct(r.marginPct)}</td>`}</tr>`)}
        <//>
        <p className="sub">Revenue is after discounts and before tax and refunds.</p>
      </section>
    <//>`}
  <//>`;
}

// 3. Labor cost for one pay period
function LaborTab({ opts }) {
  const { data, msg, run } = useReport("/reports/labor");
  const [period, setPeriod] = useState("");
  const [where, setWhere] = useState("all");
  useEffect(() => { run({}); }, [run]); // the server picks the pay period covering today
  useEffect(() => { if (data?.period && !period) setPeriod(data.period.id); }, [data, period]);
  const t = data?.totals;
  const periods = (data?.periods || []).map((p) => ({ id: p.id, name: `${dayOf(p.start)} to ${dayOf(p.end)}` }));
  return html`<${React.Fragment}>
    <${Filters} onRun=${() => run({ payPeriodId: period, locationId: where })}>
      <${Choose} label="Pay period" value=${period} onChange=${setPeriod} options=${periods} />
      <${Choose} label="Location" value=${where} onChange=${setWhere} options=${opts.locations} all="All locations" /><//>
    <${Message} msg=${msg} />
    ${data && !data.period && html`<p className="sub">No pay periods are set up yet.</p>`}
    ${data && data.period && html`<${React.Fragment}>
      <div className="tiles four">
        <${Tile} label="Hours worked" value=${hrs(t.hoursWorked)} />
        <${Tile} label="Labor cost" value=${money(t.payCents)} />
        <${Tile} label="Net sales" value=${money(t.netCents)} />
        <${Tile} label="Labor as % of sales" value=${pct(t.laborPct)} />
      </div>
      <section className="rsection">
        <h3>Labor cost by employee</h3>
        <${Table} label="Labor cost by employee"
          cols=${[[0, "Employee"], [140, "Role"], [64, "Shifts", 1], [104, "Regular hours", 1], [112, "Overtime hours", 1], [96, "Hourly rate", 1], [104, "Pay", 1]]}
          empty=${!data.rows.length && "No finished shifts in this pay period."}
          foot=${data.rows.length > 0 && frag`<td>Total</td><td></td><td className="r">${t.shifts}</td><td className="r">${hrs(t.regularHours)}</td>
            <td className="r">${hrs(t.overtimeHours)}</td><td></td><td className="r">${money(t.payCents)}</td>`}>
          ${data.rows.map((r) => html`<tr key=${r.employee}><td>${r.employee}</td><td>${r.role}</td><td className="r">${r.shifts}</td><td className="r">${hrs(r.regularHours)}</td>
            <td className="r">${hrs(r.overtimeHours)}</td><td className="r">${r.rate == null ? "—" : `$${r.rate.toFixed(2)}`}</td>
            <td className="r">${money(r.payCents)}${r.missingRate ? " *" : ""}</td></tr>`)}
        <//>
        <p className="sub">Submitted and approved shifts. Overtime is time over 40 hours in a Monday-to-Sunday week, at 1.5 times the rate.
          ${data.rows.some((r) => r.missingRate) && " * Some shifts have no pay rate on file and are left out of pay."}</p>
      </section>
    <//>`}
  <//>`;
}

// 4. Stock losses
function LossesTab({ opts }) {
  const { data, msg, run } = useReport("/reports/losses");
  const range = useRange(opts);
  const [reason, setReason] = useState("all");
  const go = () => run({ ...range.params, reason });
  useEffect(() => { go(); }, []); // first run, with the default dates
  const t = data?.totals;
  const costs = opts.canCosts;
  return html`<${React.Fragment}>
    <${Filters} onRun=${go}>${range.fields}
      <${Choose} label="Reason" value=${reason} onChange=${setReason} options=${opts.reasons.map((r) => ({ id: r.code, name: r.label }))} all="All reasons" /><//>
    <${Message} msg=${msg} />
    ${data && html`<${React.Fragment}>
      <div className="tiles four">
        ${costs && html`<${Tile} label="Stock lost, at cost" value=${money(t.costCents)} />`}
        <${Tile} label="Loss reports" value=${t.reports} />
        ${costs && html`<${Tile} label="Loss as % of stock used" value=${pct(t.lossPct)} />`}
        <${Tile} label="Most common reason" value=${t.commonReason || "—"} />
      </div>
      <section className="rsection">
        <h3>Stock losses by item and reason</h3>
        <${Table} label="Stock losses by item and reason"
          cols=${[[0, "Stock item"], [170, "Reason"], [80, "Reports", 1], [104, "Amount lost", 1], [64, "Unit"], ...(costs ? [[96, "Cost", 1]] : [])]}
          empty=${!data.rows.length && "No losses reported in these dates."}
          foot=${data.rows.length > 0 && frag`<td>Total</td><td></td><td className="r">${t.reports}</td><td></td><td></td>${costs && frag`<td className="r">${money(t.costCents)}</td>`}`}>
          ${data.rows.map((r) => html`<tr key=${r.item + r.reason}><td>${r.item}</td><td>${r.reason}</td><td className="r">${r.reports}</td>
            <td className="r">${units(r.amount)}</td><td>${r.unit}</td>${costs && frag`<td className="r">${money(r.costCents)}</td>`}</tr>`)}
        <//>
      </section>
    <//>`}
  <//>`;
}

// ---- the page -----------------------------------------------------------------------------------------------------

function App() {
  const me = useMe();
  const [opts, setOpts] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState(tabFromHash);
  useEffect(() => { api("/reports/options").then(setOpts).catch((e) => setError(e.message)); }, []);
  useEffect(() => { // Back and Forward move between tabs
    const onPop = () => setTab(tabFromHash());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (k) => { setTab(k); window.history.pushState(null, "", k === "live" ? window.location.pathname : `#${k}`); };
  const tabs = TABS.filter(([k]) => k !== "labor" || opts?.canLabor);
  const shown = tabs.some(([k]) => k === tab) ? tab : "live";

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Reports" />
    <section className="main scrolls" aria-label="Reports">
      ${error ? html`<p className="success" role="alert">${error}</p>` : !opts ? html`<p className="success">Loading…</p>` : html`<div className="reports">
        <div className="tabs" role="group" aria-label="Reports">
          ${tabs.map(([k, label]) => html`<button key=${k} className="tab" aria-pressed=${shown === k} onClick=${() => go(k)}>${label}</button>`)}</div>
        ${shown === "live" && html`<${LiveTab} opts=${opts} />`}
        ${shown === "sales" && html`<${SalesTab} opts=${opts} />`}
        ${shown === "top" && html`<${TopTab} opts=${opts} />`}
        ${shown === "labor" && html`<${LaborTab} opts=${opts} />`}
        ${shown === "losses" && html`<${LossesTab} opts=${opts} />`}
      </div>`}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
