// Reports: one page, a tab per report. Each tab has its filters, Run report, four summary cards, and a table with a Total row.
const TABS = [["live", "Live sales"], ["sales-by-day", "1. Sales by day"], ["top-sellers", "2. Top sellers"], ["labor", "3. Labor cost"], ["losses", "4. Stock losses"]];
const tabFromHash = () => { const h = window.location.hash.slice(1); return TABS.some(([k]) => k === h) ? h : "live"; };
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { weekday: "short", timeZone: "UTC" });
const shortDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
const query = (o) => new URLSearchParams(o).toString();

function Tabs({ tab, onTab }) {
  return html`<div className="tabs" role="group" aria-label="Reports">
    ${TABS.map(([k, label]) => html`<button key=${k} className="tab" aria-pressed=${tab === k} onClick=${() => onTab(k)}>${label}</button>`)}</div>`;
}

function LocationSelect({ options, value, onChange }) {
  return html`<select className="select" aria-label="Location" value=${value} disabled=${!options.canPickAll && options.locations.length < 2} onChange=${(e) => onChange(e.target.value)}>
    ${options.canPickAll && html`<option value="all">All locations</option>`}
    ${options.locations.map((l) => html`<option key=${l.id} value=${l.id}>${l.name}</option>`)}</select>`;
}

const DateField = ({ label, value, onChange }) => html`<label className="pf"><b>${label}</b>
  <input className="field date" type="date" value=${value} onChange=${(e) => onChange(e.target.value)} /></label>`;

// [label, value, dark]: a dark card is the one figure to read first
function Cards({ cards }) {
  return html`<div className="rcards">${cards.map(([label, value, dark]) => html`<div key=${label} className=${dark ? "rcard dark" : "rcard"}><span>${label}</span><b>${value}</b></div>`)}</div>`;
}

// Bars on one zero baseline. Hover or focus a bar for its label and amount; the table below has every figure.
// bars: [{ key, label, tip, value }]; label is what sits under the bar (blank to skip it)
function BarChart({ title, bars }) {
  const [tip, setTip] = useState(null);
  const top = Math.max(...bars.map((b) => b.value), 0);
  return html`<figure className="chart" aria-label=${title}>
    <figcaption><h3>${title}</h3></figcaption>
    <div className="plot" onMouseLeave=${() => setTip(null)}>
      <div className="axis"><span>${money(top)}</span><span>$0</span></div>
      <div className="bars">${bars.map((b, i) => html`<div key=${b.key} className="col" tabIndex="0" aria-label=${`${b.tip}: ${money(b.value)}`}
          onMouseEnter=${() => setTip(i)} onFocus=${() => setTip(i)} onBlur=${() => setTip(null)}>
        <div className="slot">${tip === i && html`<span className="tip" role="tooltip"><b>${money(b.value)}</b>${b.tip}</span>`}
          <div className="rbar" style=${{ height: `${top > 0 ? Math.max(0, b.value) / top * 100 : 0}%` }}></div></div>
        <span className="lbl">${b.label}</span>
      </div>`)}</div>
    </div>
    ${!bars.length && html`<p className="sub">No sales yet.</p>`}
  </figure>`;
}

// One bar per day; past two weeks, only every few days are labelled so the names don't collide
const dayBars = (days) => days.map((d, i) => ({ key: d.day, value: d.net, tip: `${weekday(d.day)} ${shortDay(d.day)}`,
  label: days.length <= 14 || i % Math.ceil(days.length / 10) === 0 ? (days.length > 7 ? shortDay(d.day) : weekday(d.day)) : "" }));

// A tab's filters and its last result. The report runs once on opening, then on Run report.
// run(patch) changes filters and runs at once (a toggle); refresh() runs the last report again, not unsaved edits.
function useReport(path, initial) {
  const [filters, setFilters] = useState(initial);
  const [report, setReport] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(true); // the mount effect runs a report at once
  const applied = useRef(initial);
  const go = useCallback(async (f) => {
    applied.current = f;
    setBusy(true); setMsg(null);
    try { setReport(await api(`/reports/${path}?${query(f)}`)); }
    catch (e) { setMsg({ kind: "error", text: e.message }); }
    setBusy(false);
  }, [path]);
  useEffect(() => { go(initial); }, []);
  const run = (patch) => { const f = { ...filters, ...patch }; if (patch) setFilters(f); return go(f); };
  return { filters, set: (patch) => setFilters({ ...filters, ...patch }), report, msg, busy, run, refresh: useCallback(() => go(applied.current), [go]) };
}

// From, To and Location, then whatever else the tab filters on, then Run report. A tab without dates puts its own first.
function Filters({ r, options, dates = true, first, children }) {
  return html`<${React.Fragment}>
    <form className="pfilters rfilters" onSubmit=${(e) => { e.preventDefault(); r.run(); }}>
      ${first}
      ${dates && html`<${React.Fragment}><${DateField} label="From" value=${r.filters.from} onChange=${(v) => r.set({ from: v })} />
      <${DateField} label="To" value=${r.filters.to} onChange=${(v) => r.set({ to: v })} /><//>`}
      <label className="pf"><b>Location</b><${LocationSelect} options=${options} value=${r.filters.location} onChange=${(v) => r.set({ location: v })} /></label>
      ${children}
      <button className="pbtn" type="submit" disabled=${r.busy}>Run report</button>
    </form>
    ${r.msg && html`<${Message} msg=${r.msg} />`}<//>`;
}
const lastWeek = (options) => ({ from: addDays(options.today, -6), to: options.today, location: options.location });
const units = (n) => String(Math.round(n * 1000) / 1000);
const percent = (n) => (n == null ? "—" : `${n.toFixed(1)}%`);

// Live sales: one day so far, by hour or by day of its week, asked for again every minute while it is today
const REFRESH_MS = 60 * 1000;
const hourOf = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
function LiveSales({ options }) {
  const r = useReport("live", { day: options.today, location: options.location, by: "hour" });
  const { report } = r;
  const live = report?.isToday;
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(r.refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [live, r.refresh]);
  const costs = report?.seesCosts;
  const byHour = report?.by !== "day";
  const label = (k) => (byHour ? hourOf(k) : `${weekday(k)} ${shortDay(k)}`);
  const cell = (x, k) => html`<td className="r">${money(x[k])}</td>`;

  return html`<section className="pview report" aria-label="Live sales">
    <${Filters} r=${r} options=${options} dates=${false} first=${html`<${DateField} label="Day" value=${r.filters.day} onChange=${(v) => r.set({ day: v })} />`} />
    <div className="livebar">
      <div className="tabs thin" role="group" aria-label="Group by">
        ${[["hour", "By hour"], ["day", "By day"]].map(([k, l]) => html`<button key=${k} type="button" className="tab small" aria-pressed=${r.filters.by === k} disabled=${r.busy}
          onClick=${() => r.run({ by: k })}>${l}</button>`)}</div>
      ${report && html`<span className="sub" role="status">${live ? "Updated" : "As of"} ${clock(report.updatedAt, report.timeZone)}${live ? " · refreshes every minute" : ""}</span>`}
    </div>
    ${report && html`<${React.Fragment}>
      <p className="sub">${report.location} · ${byHour ? dayOf(report.day) : `${dayOf(report.from)} to ${dayOf(report.day)}`}</p>
      <${Cards} cards=${[["Gross sales", money(report.cards.gross)], ["Discounts", money(report.cards.discounts)], ["Refunds", money(report.cards.refunds)],
        [live ? "Net sales so far" : "Net sales", money(report.cards.net), true],
        ...(costs ? [["Cost of goods", money(report.cards.cost)], ["Profit", money(report.cards.profit)]] : []), ["Tips", money(report.cards.tips)]]} />
      <${BarChart} title=${byHour ? "Net sales by hour" : "Net sales by day"} bars=${report.rows.map((x) => ({ key: x.key, value: x.net, tip: label(x.key), label: label(x.key) }))} />
      <div className="tablewrap">
        <h3>${byHour ? "Hour by hour" : "Day by day"}</h3>
        <table className="table mg" aria-label=${byHour ? "Hour by hour" : "Day by day"}>
          <colgroup><col style=${{ width: byHour ? 80 : 112 }} /><col style=${{ width: 64 }} /><col /><col /><col />
            <col />${costs && html`<${React.Fragment}><col /><col /><//>`}<col /></colgroup>
          <thead><tr><th>${byHour ? "Hour" : "Day"}</th><th className="r">Orders</th><th className="r">Gross</th><th className="r">Discounts</th><th className="r">Refunds</th>
            <th className="r">Net sales</th>${costs && html`<${React.Fragment}><th className="r">Cost</th><th className="r">Profit</th><//>`}<th className="r">Running net</th></tr></thead>
          <tbody>${report.rows.map((x) => html`<tr key=${x.key}>
            <td>${label(x.key)}</td><td className="r">${x.orders}</td>${cell(x, "gross")}${cell(x, "discounts")}${cell(x, "refunds")}${cell(x, "net")}
            ${costs && html`<${React.Fragment}>${cell(x, "cost")}${cell(x, "profit")}<//>`}${cell(x, "runningNet")}</tr>`)}
            ${!report.rows.length && html`<tr><td colSpan=${costs ? 9 : 7}>No sales yet.</td></tr>`}</tbody>
          <tfoot><tr><td>Total</td><td className="r">${report.total.orders}</td>${cell(report.total, "gross")}${cell(report.total, "discounts")}${cell(report.total, "refunds")}
            ${cell(report.total, "net")}${costs && html`<${React.Fragment}>${cell(report.total, "cost")}${cell(report.total, "profit")}<//>`}<td></td></tr></tfoot>
        </table>
        <p className="sub">Net sales are before tax and tips. A refund comes off the hour it was paid back. ${byHour ? "Hours run from the first sale to the last." : "The week runs from Monday."}</p>
      </div><//>`}
  </section>`;
}

// 1. Sales by day
function SalesByDay({ options }) {
  const r = useReport("sales-by-day", lastWeek(options));
  const { report } = r;
  return html`<section className="pview report" aria-label="Sales by day">
    <${Filters} r=${r} options=${options} />
    ${report && html`<${React.Fragment}>
      <p className="sub">${report.location} · ${dayOf(report.from)} to ${dayOf(report.to)}</p>
      <${Cards} cards=${[["Net sales", money(report.cards.net)], ["Orders", String(report.cards.orders)], ["Average order", money(report.cards.average)], ["Tax collected", money(report.cards.tax)]]} />
      <${BarChart} title="Net sales per day" bars=${dayBars(report.days)} />
      <div className="tablewrap">
        <h3>Sales by day and location</h3>
        <table className="table mg" aria-label="Sales by day and location">
          <colgroup><col style=${{ width: 128 }} /><col /><col style=${{ width: 72 }} /><col style=${{ width: 96 }} /><col style=${{ width: 96 }} /><col style=${{ width: 96 }} /><col style=${{ width: 104 }} /></colgroup>
          <thead><tr><th>Date</th><th>Location</th><th className="r">Orders</th><th className="r">Gross</th><th className="r">Discounts</th><th className="r">Refunds</th><th className="r">Net sales</th></tr></thead>
          <tbody>${report.rows.map((x) => html`<tr key=${`${x.day} ${x.location}`}>
            <td>${weekday(x.day)} ${shortDay(x.day)}</td><td>${x.location}</td><td className="r">${x.orders}</td><td className="r">${money(x.gross)}</td>
            <td className="r">${money(x.discounts)}</td><td className="r">${money(x.refunds)}</td><td className="r">${money(x.net)}</td></tr>`)}
            ${!report.rows.length && html`<tr><td colSpan="7">No sales in these dates.</td></tr>`}</tbody>
          <tfoot><tr><td>Total</td><td></td><td className="r">${report.total.orders}</td><td className="r">${money(report.total.gross)}</td>
            <td className="r">${money(report.total.discounts)}</td><td className="r">${money(report.total.refunds)}</td><td className="r">${money(report.total.net)}</td></tr></tfoot>
        </table>
        <p className="sub">Net sales are before tax and tips. A refund comes off the day it was paid back. Gift cards count when they're spent, not when they're sold.</p>
      </div><//>`}
  </section>`;
}

// 2. Top sellers: one ranking, with Category as a column and a filter
function TopSellers({ options }) {
  const r = useReport("top-sellers", { ...lastWeek(options), category: "" });
  const { report } = r;
  const costs = report?.seesCosts;
  return html`<section className="pview report" aria-label="Top sellers">
    <${Filters} r=${r} options=${options}>
      <label className="pf"><b>Category</b>
        <select className="select" aria-label="Category" value=${r.filters.category} onChange=${(e) => r.set({ category: e.target.value })}>
          <option value="">All categories</option>
          ${options.categories.map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
          <option value="none">No category</option></select></label>
    <//>
    ${report && html`<${React.Fragment}>
      <p className="sub">${report.location} · ${report.category} · ${dayOf(report.from)} to ${dayOf(report.to)}</p>
      <${Cards} cards=${[["Units sold", units(report.cards.units)], ["Revenue", money(report.cards.revenue)],
        ...(costs ? [["Cost of goods", money(report.cards.cost)], ["Margin %", percent(report.cards.marginPct)]] : [])]} />
      <div className="tablewrap">
        <h3>Top sellers</h3>
        <table className="table mg" aria-label="Top sellers">
          <colgroup><col style=${{ width: 56 }} /><col /><col style=${{ width: 150 }} /><col style=${{ width: 88 }} /><col style=${{ width: 100 }} />
            ${costs && html`<${React.Fragment}><col style=${{ width: 96 }} /><col style=${{ width: 96 }} /><col style=${{ width: 88 }} /><//>`}</colgroup>
          <thead><tr><th>Rank</th><th>Product</th><th>Category</th><th className="r">Units sold</th><th className="r">Revenue</th>
            ${costs && html`<${React.Fragment}><th className="r">Cost</th><th className="r">Margin $</th><th className="r">Margin %</th><//>`}</tr></thead>
          <tbody>${report.rows.map((x) => html`<tr key=${x.rank}>
            <td>${x.rank}</td><td>${x.product}</td><td>${x.category}</td><td className="r">${units(x.units)}</td><td className="r">${money(x.revenue)}</td>
            ${costs && html`<${React.Fragment}><td className="r">${money(x.cost)}</td><td className="r">${money(x.margin)}</td><td className="r">${percent(x.marginPct)}</td><//>`}</tr>`)}
            ${!report.rows.length && html`<tr><td colSpan=${costs ? 8 : 5}>Nothing sold in these dates.</td></tr>`}</tbody>
          <tfoot><tr><td>Total</td><td></td><td></td><td className="r">${units(report.total.units)}</td><td className="r">${money(report.total.revenue)}</td>
            ${costs && html`<${React.Fragment}><td className="r">${money(report.total.cost)}</td><td className="r">${money(report.total.margin)}</td><td className="r">${percent(report.total.marginPct)}</td><//>`}</tr></tfoot>
        </table>
        <p className="sub">Ranked by units sold. Revenue is after discounts and before tax, and doesn't take refunds off. Gift cards aren't listed.</p>
      </div><//>`}
  </section>`;
}

// 3. Labor cost for one pay period. Overtime is past 40 hours in a Monday to Sunday week, at 1.5x.
const hrs = (n) => n.toFixed(2);
const rateText = (x) => (!x.rates.length ? "—" : x.rates.length === 1 ? money(x.rates[0]) : `${money(x.rates[0])}–${money(x.rates.at(-1))}`) + (x.noRate ? ` (${x.noRate} shift${x.noRate > 1 ? "s" : ""} with no rate)` : "");
const LaborCost = ({ options }) => (options.seesLabor ? html`<${LaborReport} options=${options} />`
  : html`<p className="success" role="status">Labor cost needs permission to see team timecards.</p>`);
function LaborReport({ options }) {
  const r = useReport("labor", { period: options.payPeriod || "", location: options.location });
  const { report } = r;
  return html`<section className="pview report" aria-label="Labor cost">
    <${Filters} r=${r} options=${options} dates=${false} first=${html`<label className="pf"><b>Pay period</b>
      <select className="select" aria-label="Pay period" value=${r.filters.period} onChange=${(e) => r.set({ period: e.target.value })}>
        ${options.payPeriods.map((p) => html`<option key=${p.id} value=${p.id}>${dayOf(p.start)} to ${dayOf(p.end)}${p.closed ? " (closed)" : ""}</option>`)}</select></label>`} />
    ${report && html`<${React.Fragment}>
      <p className="sub">${report.location} · Pay period ${dayOf(report.period.start)} to ${dayOf(report.period.end)}</p>
      <${Cards} cards=${[["Hours worked", hrs(report.cards.hours)], ["Labor cost", money(report.cards.cost)], ["Net sales", money(report.cards.net)], ["Labor as % of sales", percent(report.cards.laborPct)]]} />
      <div className="tablewrap">
        <h3>Labor cost by employee</h3>
        <table className="table mg" aria-label="Labor cost by employee">
          <colgroup><col /><col style=${{ width: 140 }} /><col style=${{ width: 72 }} /><col style=${{ width: 104 }} /><col style=${{ width: 112 }} /><col style=${{ width: 120 }} /><col style=${{ width: 104 }} /></colgroup>
          <thead><tr><th>Employee</th><th>Role</th><th className="r">Shifts</th><th className="r">Regular hours</th><th className="r">Overtime hours</th><th className="r">Hourly rate</th><th className="r">Pay</th></tr></thead>
          <tbody>${report.rows.map((x) => html`<tr key=${x.employee}>
            <td>${x.employee}</td><td>${x.role}</td><td className="r">${x.shifts}</td><td className="r">${hrs(x.regularHours)}</td><td className="r">${hrs(x.overtimeHours)}</td>
            <td className="r">${rateText(x)}</td><td className="r">${money(x.pay)}</td></tr>`)}
            ${!report.rows.length && html`<tr><td colSpan="7">No submitted or approved shifts in this pay period.</td></tr>`}</tbody>
          <tfoot><tr><td>Total</td><td></td><td className="r">${report.total.shifts}</td><td className="r">${hrs(report.total.regularHours)}</td>
            <td className="r">${hrs(report.total.overtimeHours)}</td><td></td><td className="r">${money(report.total.pay)}</td></tr></tfoot>
        </table>
        <p className="sub">Submitted and approved shifts, less unpaid breaks, at the rate in force when each shift started. Hours past 40 in a Monday to Sunday week are overtime at 1.5×, counting shifts at every location. Role is the employee's current role.</p>
      </div><//>`}
  </section>`;
}

// 4. Stock losses: by item and reason. Amounts are in each item's own unit, so only Reports and Cost have a total.
function StockLosses({ options }) {
  const r = useReport("losses", { ...lastWeek(options), reason: "" });
  const { report } = r;
  const costs = report?.seesCosts;
  return html`<section className="pview report" aria-label="Stock losses">
    <${Filters} r=${r} options=${options}>
      <label className="pf"><b>Reason</b>
        <select className="select" aria-label="Reason" value=${r.filters.reason} onChange=${(e) => r.set({ reason: e.target.value })}>
          <option value="">All reasons</option>
          ${options.reasons.map((x) => html`<option key=${x.id} value=${x.id}>${x.name}</option>`)}</select></label>
    <//>
    ${report && html`<${React.Fragment}>
      <p className="sub">${report.location} · ${report.reason} · ${dayOf(report.from)} to ${dayOf(report.to)}</p>
      <${Cards} cards=${[...(costs ? [["Stock lost at cost", money(report.cards.lost)]] : []), ["Loss reports", String(report.cards.reports)],
        ...(costs ? [["Loss as % of stock used", percent(report.cards.lostPct)]] : []), ["Most common reason", report.cards.commonReason || "—"]]} />
      <div className="tablewrap">
        <h3>Stock losses by item and reason</h3>
        <table className="table mg" aria-label="Stock losses by item and reason">
          <colgroup><col /><col style=${{ width: 170 }} /><col style=${{ width: 88 }} /><col style=${{ width: 120 }} /><col style=${{ width: 72 }} />${costs && html`<col style=${{ width: 104 }} />`}</colgroup>
          <thead><tr><th>Stock item</th><th>Reason</th><th className="r">Reports</th><th className="r">Amount lost</th><th>Unit</th>${costs && html`<th className="r">Cost</th>`}</tr></thead>
          <tbody>${report.rows.map((x) => html`<tr key=${`${x.item} ${x.reason}`}>
            <td>${x.item}</td><td>${x.reason}</td><td className="r">${x.reports}</td><td className="r">${units(x.amount)}</td><td>${x.unit}</td>${costs && html`<td className="r">${money(x.cost)}</td>`}</tr>`)}
            ${!report.rows.length && html`<tr><td colSpan=${costs ? 6 : 5}>No losses reported in these dates.</td></tr>`}</tbody>
          <tfoot><tr><td>Total</td><td></td><td className="r">${report.total.reports}</td><td></td><td></td>${costs && html`<td className="r">${money(report.total.cost)}</td>`}</tr></tfoot>
        </table>
        <p className="sub">Losses are valued at the average cost on the day they were reported. Stock used is what sales used plus what was lost. Count corrections aren't counted as losses.</p>
      </div><//>`}
  </section>`;
}

function App() {
  const me = useMe();
  const [tab, setTab] = useState(tabFromHash);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { api("/reports/options").then(setOptions).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const pick = (k) => { window.history.replaceState(null, "", `#${k}`); setTab(k); };

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Reports" />
    <section className="main scrolls" aria-label="Reports">
      <header className="heading"><h2>Reports</h2></header>
      <${Tabs} tab=${tab} onTab=${pick} />
      ${error ? html`<p className="success" role="alert">${error}</p>`
        : !options ? html`<p className="success">Loading…</p>`
        : tab === "live" ? html`<${LiveSales} options=${options} />`
        : tab === "sales-by-day" ? html`<${SalesByDay} options=${options} />`
        : tab === "top-sellers" ? html`<${TopSellers} options=${options} />`
        : tab === "losses" ? html`<${StockLosses} options=${options} />`
        : tab === "labor" ? html`<${LaborCost} options=${options} />`
        : null}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
