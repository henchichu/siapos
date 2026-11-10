// Reports: one page, a tab per report. Each tab has its filters, Run report, four summary cards, and a table with a Total row.
const TABS = [["revenue", "Revenue"], ["top-sellers", "Top sellers"], ["labor", "Labor cost"], ["losses", "Stock losses"], ["customers", "Customers"]];
const tabFromHash = () => { const h = window.location.hash.slice(1); return TABS.some(([k]) => k === h) ? h : "revenue"; };
const weekday = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { weekday: "short", timeZone: "UTC" });
const shortDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
const query = (o) => new URLSearchParams(o).toString();

function Tabs({ tab, onTab }) {
  return html`<div className="tabs" role="group" aria-label="Reports">
    ${TABS.map(([k, label]) => html`<button key=${k} className="tab" aria-pressed=${tab === k} onClick=${() => onTab(k)}>${label}</button>`)}</div>`;
}

const DateField = ({ label, value, onChange }) => html`<label className="pf"><b>${label}</b>
  <input className="field date" type="date" value=${value} onChange=${(e) => onChange(e.target.value)} /></label>`;

// [label, value, dark, change, icon]: a dark card is the one figure to read first; change is a <Change> under the figure;
// icon overrides the one the label would get (shell.js CARD_ICONS).
// Figures (money, counts, percentages) stay on one line and shrink with the card; words may wrap.
const FIGURE = /^[-−$\d.,%— ]+$/;
function Cards({ cards, className = "" }) {
  return html`<div className=${`rcards ${className}`}>${cards.map(([label, value, dark, change, icon]) => html`<div key=${label} className=${dark ? "rcard dark" : "rcard"}>
    <span>${label}</span><b className=${FIGURE.test(value) ? "fig" : undefined}>${value}</b>${change}
    ${icon ? html`<span className="cicon"><${Icon} name=${icon} /></span>` : html`<${CardIcon} label=${label} />`}</div>`)}</div>`;
}

// ▲/▼ and the % change from the last period. lower: a fall is the good direction (discounts, refunds, cost).
function Change({ now, before, vs, lower, points }) {
  if (before == null || now == null) return null;
  if (points) { // a percentage compares in percentage points
    const d = now - before;
    if (Math.abs(d) < 0.05) return html`<small className="change">No change ${vs}</small>`;
    return html`<small className=${`change ${d > 0 ? "good" : "bad"}`}>${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)} pts <span>${vs}</span></small>`;
  }
  if (!before) return html`<small className="change">${now ? "New" : "No change"} ${vs}</small>`;
  const pct = ((now - before) / Math.abs(before)) * 100;
  if (Math.abs(pct) < 0.05) return html`<small className="change">No change ${vs}</small>`;
  const up = pct > 0, good = lower ? !up : up;
  return html`<small className=${`change ${good ? "good" : "bad"}`} aria-label=${`${up ? "Up" : "Down"} ${Math.abs(pct).toFixed(1)}% ${vs}`}>
    ${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}% <span>${vs}</span></small>`;
}

// The theme's browns and tans, darkest first, for slices and stacked parts. Labels never sit on these colors, they are beside them.
const PALETTE = ["#6F4934", "#CFA77F", "#4A2F20", "#A9764F", "#E8D5C0", "#8C6A55", "#2E1C12", "#B9987A", "#DCC3A8"];
const pctText = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");
const count = (n) => String(Math.round(n * 1000) / 1000);

// A panel with a title and a short message when it has nothing to show
function Panel({ title, legend, note, empty, isEmpty, className = "", children }) {
  return html`<figure className=${`chart rpanel ${className}`} aria-label=${title}>
    <figcaption><h3>${title}</h3>${legend}</figcaption>
    ${isEmpty ? html`<p className="sub">${empty}</p>` : children}
    ${note && html`<p className="sub note">${note}</p>`}
  </figure>`;
}

// Horizontal bars, longest first. bars: [{ key, name, value, parts?: [{ value, name }], extra? }].
// total: what each bar is a % of (its card), or null for no %. fmt: how a value reads. onPick: a bar is a button.
function HBars({ title, bars, total, fmt = money, empty, note, legend, onPick, pickLabel }) {
  const top = Math.max(...bars.map((b) => Math.abs(b.value)), 0);
  const width = (v) => `${top > 0 ? (Math.abs(v) / top) * 100 : 0}%`;
  return html`<${Panel} title=${title} legend=${legend} note=${note} empty=${empty} isEmpty=${!bars.length}>
    <ul className="hbars">${bars.map((b) => {
      const figure = html`<span className="hval">${fmt(b.value)}${total != null && html` · ${pctText(b.value, total)}`}</span>`;
      const bar = html`<span className="htrack">${b.parts
        ? html`<span className="hbar" style=${{ width: width(b.value) }}>${b.parts.map((p, i) => html`<span key=${p.name} className="hpart"
            style=${{ flexGrow: Math.max(0, p.value), background: PALETTE[i] }} title=${`${p.name}: ${fmt(p.value)}`}></span>`)}</span>`
        : html`<span className=${b.value < 0 ? "hbar neg" : "hbar"} style=${{ width: width(b.value) }}></span>`}</span>`;
      const body = html`<${React.Fragment}><span className="hname">${b.name}</span>${figure}${bar}${b.extra && html`<span className="hextra">${b.extra}</span>`}<//>`;
      return html`<li key=${b.key}>${onPick
        ? html`<button type="button" className="hrow pick" onClick=${() => onPick(b)} aria-label=${`${b.name}: ${fmt(b.value)}. ${pickLabel}`}>${body}</button>`
        : html`<div className="hrow">${body}</div>`}</li>`;
    })}</ul>
  <//>`;
}
const Swatches = ({ names }) => html`<span className="swatches">${names.map((n, i) => html`<span key=${n}><i style=${{ background: PALETTE[i] }}></i>${n}</span>`)}</span>`;

// A ring of slices with the total in the middle, and a legend giving each slice's amount and %. Negative slices take no room on the ring.
function Donut({ title, slices, total, empty, note, fmt = money, centre, onPick, picked }) {
  const shown = slices.reduce((a, s) => a + Math.max(0, s.value), 0);
  let at = 0;
  return html`<${Panel} title=${title} note=${note} empty=${empty} isEmpty=${!slices.length}>
    <div className="donut">
      <svg viewBox="0 0 42 42" role="img" aria-label=${`${title}: ${slices.map((s) => `${s.name} ${fmt(s.value)}`).join(", ")}`}>
        <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--hover)" strokeWidth="6" />
        ${shown > 0 && slices.map((s, i) => {
          const len = (Math.max(0, s.value) / shown) * 100;
          const ring = html`<circle key=${s.key} cx="21" cy="21" r="15.915" fill="none" stroke=${PALETTE[i % PALETTE.length]} strokeWidth=${picked === s.key ? 7.5 : 6}
            strokeDasharray=${`${len} ${100 - len}`} strokeDashoffset=${25 - at} className=${onPick ? "pickable" : undefined} onClick=${onPick && (() => onPick(s))} />`;
          at += len;
          return ring;
        })}
        <text x="21" y="20" textAnchor="middle" className="dtotal">${fmt(total)}</text>
        <text x="21" y="25" textAnchor="middle" className="dcap">${centre || "total"}</text>
      </svg>
      <ul className="dlegend">${slices.map((s, i) => {
        const body = html`<${React.Fragment}><i style=${{ background: PALETTE[i % PALETTE.length] }}></i>
          <span className="hname">${s.name}</span><span className="hval">${fmt(s.value)} · ${pctText(s.value, total)}</span><//>`;
        return html`<li key=${s.key}>${onPick
          ? html`<button type="button" className="dpick" aria-pressed=${picked === s.key} onClick=${() => onPick(s)}>${body}</button>` : body}</li>`;
      })}</ul>
    </div>
  <//>`;
}

// How the cards add up: totals stand on zero, each step down floats from the level before it
function Waterfall({ cards, costs, className = "" }) {
  const steps = [["Gross sales", cards.gross, "total"], ["Discounts", -cards.discounts], ["Refunds", -cards.refunds], ["Net sales", cards.net, "total"],
    ...(costs ? [["Cost of goods", -cards.cost], ["Profit", cards.profit, "total"]] : [])];
  let level = 0;
  const bars = steps.map(([name, value, kind]) => {
    const from = kind ? 0 : level, to = kind ? value : level + value;
    level = to;
    return { name, value, kind, lo: Math.min(from, to), hi: Math.max(from, to) };
  });
  const min = Math.min(0, ...bars.map((b) => b.lo)), max = Math.max(0, ...bars.map((b) => b.hi));
  const span = max - min || 1;
  const at = (v) => `${((v - min) / span) * 100}%`;
  return html`<${Panel} title="How it adds up" className=${`waterfall ${className}`}
      legend=${html`<${Swatches} names=${["Total", "Taken off"]} />`}
      note=${costs ? "Cost of goods includes refunded items, since their ingredients were already used." : null}>
    <div className="wplot" role="list">${bars.map((b) => html`<div key=${b.name} className="wcol" role="listitem" aria-label=${`${b.name}: ${b.kind ? "" : "minus "}${money(Math.abs(b.value))}`}>
      <div className="wslot">
        <span className=${b.kind ? "wbar" : "wbar off"} style=${{ bottom: at(b.lo), height: `max(2px, ${((b.hi - b.lo) / span) * 100}%)` }}></span>
        <span className="wval" style=${{ bottom: at(b.hi) }}>${b.kind ? money(b.value) : money(-Math.abs(b.value))}</span>
      </div>
      <span className="wlbl">${b.kind ? b.name : `− ${b.name}`}</span>
    </div>`)}</div>
  <//>`;
}

// Bars on one zero baseline. Hover or focus a bar for its label and amount; the table below has every figure.
// bars: [{ key, label, tip, value }]; label is what sits under the bar (blank to skip it). best: the highest bar is cyan, with a legend saying so.
function BarChart({ title, bars, best, className = "" }) {
  const [tip, setTip] = useState(null);
  const top = Math.max(...bars.map((b) => b.value), 0);
  const bestAt = best && top > 0 ? bars.findIndex((b) => b.value === top) : -1;
  return html`<figure className=${`chart ${className}`} aria-label=${title}>
    <figcaption><h3>${title}</h3>${bestAt >= 0 && html`<span className="legend">${best}</span>`}</figcaption>
    <div className="plot" onMouseLeave=${() => setTip(null)}>
      <div className="axis"><span>${money(top)}</span><span>$0</span></div>
      <div className="bars">${bars.map((b, i) => html`<div key=${b.key} className=${i === bestAt ? "col best" : "col"} tabIndex="0" aria-label=${`${b.tip}: ${money(b.value)}${i === bestAt ? ` (${best})` : ""}`}
          onMouseEnter=${() => setTip(i)} onFocus=${() => setTip(i)} onBlur=${() => setTip(null)}>
        <div className="slot">${tip === i && html`<span className="tip" role="tooltip"><b>${money(b.value)}</b>${b.tip}</span>`}
          <div className="rbar" style=${{ height: `${top > 0 ? Math.max(0, b.value) / top * 100 : 0}%` }}></div></div>
        <span className="lbl">${b.label}</span>
      </div>`)}</div>
    </div>
    ${!bars.length && html`<p className="sub">No sales yet.</p>`}
  </figure>`;
}

function useReport(path, initial) {
  const [filters, setFilters] = useState(initial);
  const [report, setReport] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const applied = useRef(null);
  const go = useCallback(async (f) => {
    setBusy(true); setMsg(null);
    try {
      const result = await api(`/reports/${path}?${query(f)}`);
      applied.current = f;
      setReport(result);
    }
    catch (e) { setMsg({ kind: "error", text: e.message }); }
    setBusy(false);
  }, [path]);
  const run = () => {
    const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
    let error;
    if ("day" in filters && !validDate(filters.day)) error = "Enter a valid Day.";
    else if ("from" in filters && (!validDate(filters.from) || !validDate(filters.to))) error = "Enter valid From and To dates.";
    else if ("from" in filters && filters.from > filters.to) error = "From must not be later than To.";
    else if ("period" in filters && !filters.period) error = "Select a pay period.";
    if (error) { setMsg({ kind: "error", text: error }); return; }
    return go({ ...filters });
  };
  return { filters, set: (patch) => setFilters({ ...filters, ...patch }), report, msg, busy, run,
    refresh: useCallback(() => applied.current && go(applied.current), [go]) };
}
// From and To, then whatever else the tab filters on, then Run report. A tab without dates puts its own first.
function Filters({ r, options, dates = true, first, children }) {
  return html`<${React.Fragment}>
    <form className="pfilters rfilters" onSubmit=${(e) => { e.preventDefault(); r.run(); }}>
      ${first}
      ${dates && html`<${React.Fragment}><${DateField} label="From" value=${r.filters.from} onChange=${(v) => r.set({ from: v })} />
      <${DateField} label="To" value=${r.filters.to} onChange=${(v) => r.set({ to: v })} /><//>`}
      ${children}
      <button className="pbtn" type="submit" disabled=${r.busy}>Run report</button>
    </form>
    ${r.msg && html`<${Message} msg=${r.msg} />`}
    ${!r.report && !r.busy && html`<p className="sub" role="status">Enter report parameters and click Run report.</p>`}<//>`;
}
const dateFilters = (options) => ({ from: "", to: "", location: options.location });
const units = (n) => String(Math.round(n * 1000) / 1000);
const percent = (n) => (n == null ? "—" : `${n.toFixed(1)}%`);

// Revenue: Live (one day so far by hour, or its week by day; asked for again every minute while it is today) and History
// (a From and To by day, month or year). Both show the same figures.
const REFRESH_MS = 60 * 1000;
const hourOf = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
const UNIT = { hour: "Hour", day: "Day", month: "Month", year: "Year" };
const NOTE = { hour: "Hours run from the first sale to the last.", day: "A live week runs from Monday.",
  month: "Months with no sales show as zero.", year: "Years with no sales show as zero." };
const labelOf = (by, k) => (by === "hour" ? hourOf(k) : by === "day" ? `${weekday(k)} ${shortDay(k)}`
  : by === "month" ? new Date(`${k}-01T00:00:00Z`).toLocaleDateString([], { month: "short", year: "numeric", timeZone: "UTC" }) : k);

function GroupBy({ r, options }) {
  return html`<div className="tabs thin" role="group" aria-label="Group by">
    ${options.map(([k, l]) => html`<button key=${k} type="button" className="tab small" aria-pressed=${r.filters.by === k} disabled=${r.busy}
      onClick=${() => r.set({ by: k })}>${l}</button>`)}</div>`;
}

// What the last period is: live, the same day (or week) a week earlier; history, the same number of days just before
function versus(report) {
  const p = report.previous;
  if (p.days) return `vs. previous ${p.days} day${p.days > 1 ? "s" : ""}`;
  if (report.by === "day") return "vs. last week";
  if (!p.until) return `vs. last ${weekday(p.to)}`;
  const [h, m] = p.until.split(":").map(Number);
  return `vs. last ${weekday(p.to)} to ${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// The breakdown grid: what makes up each card. Clicking a category opens Top sellers for it.
function Breakdown({ report, className, onCategory }) {
  const b = report.breakdown, c = report.cards, costs = report.seesCosts;
  const pick = onCategory && ((bar) => onCategory({ category: bar.key, from: report.from, to: report.day }));
  return html`<div className=${`rgrid ${className}`}>
    <${Donut} title="Net sales by channel" slices=${b.channels} total=${c.net} empty="No sales in this period." />
    <${Donut} title="Sales by payment method" slices=${b.payments} total=${c.net} empty="No sales in this period."
      note="Net sales, split across an order's payments by amount. A refund comes off the payment it went back to." />
    <${HBars} title="Gross sales by category" total=${c.gross} empty="No sales in this period." onPick=${pick} pickLabel="Open in Top sellers"
      legend=${html`<${Swatches} names=${["Base price", "Add-ons"]} />`}
      bars=${b.categories.map((x) => ({ ...x, parts: [{ name: "Base price", value: x.base }, { name: "Add-ons", value: x.addons }],
        extra: `Base ${money(x.base)} · Add-ons ${money(x.addons)}` }))}
      note="Add-ons are what the options chosen added to the price. Click a category to see its products." />
    <${HBars} title="Discounts by promotion" total=${c.discounts} bars=${b.discounts} empty="No discounts in this period." />
    <${HBars} title="Refunds by reason" total=${c.refunds} empty="No refunds in this period."
      bars=${b.refunds.map((x) => ({ ...x, extra: `${x.count} refund${x.count > 1 ? "s" : ""}` }))} />
    ${costs && html`<${HBars} title="Cost of goods by ingredient" total=${c.cost} bars=${b.ingredients} empty="No cost of goods in this period."
      note="What each stock item cost when it was used, top 8 first." />`}
    ${costs && html`<${HBars} title="Profit by category" total=${c.profit} empty="No sales in this period." onPick=${pick} pickLabel="Open in Top sellers"
      bars=${b.profit.map((x) => ({ ...x, extra: `${percent(x.marginPct)} margin · Net ${money(x.net)} − Cost ${money(x.cost)}` }))}
      note="Refunds are split across the items that were returned." />`}
  </div>`;
}

// Cards, chart and table for one report
function RevenueReport({ report, live, onCategory }) {
  const [sub, setSub] = useState("summary"); // the part of the report a phone shows
  const costs = report.seesCosts;
  const by = report.by, unit = UNIT[by];
  const label = (k) => labelOf(by, k);
  const cell = (x, k) => html`<td className="r">${money(x[k])}</td>`;
  const vs = versus(report), was = report.previous.cards;
  const card = (name, k, opts = {}) => [name, opts.fmt ? opts.fmt(report.cards[k]) : money(report.cards[k]), opts.dark,
    html`<${Change} now=${report.cards[k]} before=${was[k]} vs=${vs} lower=${opts.lower} />`];
  return html`<${React.Fragment}>
    <${SubTabs} tabs=${[["summary", "Summary"], ["chart", "Chart"], ["breakdown", "Breakdown"], ["table", "Table"]]} value=${sub} onChange=${setSub} label="Report parts" />
    <p className="sub">${report.location} · ${by === "hour" ? dayOf(report.day) : `${dayOf(report.from)} to ${dayOf(report.day)}`}</p>
    <${Cards} className=${`wide ${panelOf("summary", sub)}`} cards=${[card("Gross sales", "gross"), card("Discounts", "discounts", { lower: true }), card("Refunds", "refunds", { lower: true }),
      card(live ? "Net sales so far" : "Net sales", "net", { dark: true }),
      ...(costs ? [card("Cost of goods", "cost", { lower: true }), card("Profit", "profit")] : []), card("Tips", "tips"),
      card("Orders", "orders", { fmt: String }), card("Avg order", "avgOrder")]} />
    <${Waterfall} cards=${report.cards} costs=${costs} className=${panelOf("summary", sub)} />
    <${BarChart} className=${panelOf("chart", sub)} title=${`Net sales by ${unit.toLowerCase()}`} best=${by === "hour" ? undefined : `Best ${unit.toLowerCase()}`}
      bars=${report.rows.map((x, i) => ({ key: x.key, value: x.net, tip: label(x.key),
        label: report.rows.length <= 14 || i % Math.ceil(report.rows.length / 10) === 0 ? label(x.key) : "" }))} />
    <${Breakdown} report=${report} className=${panelOf("breakdown", sub)} onCategory=${onCategory} />
    <div className=${`tablewrap ${panelOf("table", sub)}`}>
      <h3>${`${unit} by ${unit.toLowerCase()}`}</h3>
      <div className="tscroll"><table className="table mg fit rowcards" aria-label=${`${unit} by ${unit.toLowerCase()}`}>
        <thead><tr><th>${unit}</th><th className="r">Orders</th><th className="r">Gross</th><th className="r">Discounts</th><th className="r">Refunds</th>
          <th className="r">Net sales</th>${costs && html`<${React.Fragment}><th className="r">Cost</th><th className="r">Profit</th><//>`}<th className="r">Running net</th></tr></thead>
        <tbody>${report.rows.map((x) => html`<tr key=${x.key}>
          <td>${label(x.key)}</td><td className="r">${x.orders}</td>${cell(x, "gross")}${cell(x, "discounts")}${cell(x, "refunds")}${cell(x, "net")}
          ${costs && html`<${React.Fragment}>${cell(x, "cost")}${cell(x, "profit")}<//>`}${cell(x, "runningNet")}</tr>`)}
          ${!report.rows.length && html`<tr><td colSpan=${costs ? 9 : 7}>No sales yet.</td></tr>`}</tbody>
        <tfoot><tr><td>Total</td><td className="r">${report.total.orders}</td>${cell(report.total, "gross")}${cell(report.total, "discounts")}${cell(report.total, "refunds")}
          ${cell(report.total, "net")}${costs && html`<${React.Fragment}>${cell(report.total, "cost")}${cell(report.total, "profit")}<//>`}<td></td></tr></tfoot>
      </table></div>
      <p className="sub">Net sales are before tax and tips. A refund comes off the ${by === "hour" ? "hour" : "day"} it was paid back. ${NOTE[by]}</p>
    </div><//>`;
}

function LiveSales({ options, onCategory }) {
  const r = useReport("revenue", { day: "", location: options.location, by: "hour" });
  const { report } = r;
  const live = report?.isToday;
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(r.refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [live, r.refresh]);
  return html`<section className="pview report" aria-label="Live sales">
    <${Filters} r=${r} options=${options} dates=${false} first=${html`<${DateField} label="Day" value=${r.filters.day} onChange=${(v) => r.set({ day: v })} />`} />
    <div className="livebar">
      <${GroupBy} r=${r} options=${[["hour", "By hour"], ["day", "By day"]]} />
      ${report && html`<span className="sub" role="status">${live ? "Updated" : "As of"} ${clock(report.updatedAt, report.timeZone)}${live ? " · refreshes every minute" : ""}</span>`}
    </div>
    ${report && html`<${RevenueReport} report=${report} live=${live} onCategory=${onCategory} />`}
  </section>`;
}

function RevenueHistory({ options, onCategory }) {
  const r = useReport("revenue", { from: "", to: "", location: options.location, by: "day" });
  const { report } = r;
  return html`<section className="pview report" aria-label="Revenue history">
    <${Filters} r=${r} options=${options} />
    <div className="livebar"><${GroupBy} r=${r} options=${[["day", "Daily"], ["month", "Monthly"], ["year", "Yearly"]]} /></div>
    ${report && html`<${RevenueReport} report=${report} onCategory=${onCategory} />`}
  </section>`;
}

function Revenue({ options, onCategory }) {
  const [view, setView] = useState("live");
  return html`<${React.Fragment}>
    <div className="tabs thin" role="group" aria-label="Revenue views">
      ${[["live", "Live"], ["history", "History"]].map(([k, l]) => html`<button key=${k} type="button" className="tab small" aria-pressed=${view === k} onClick=${() => setView(k)}>${l}</button>`)}</div>
    ${view === "live" ? html`<${LiveSales} options=${options} onCategory=${onCategory} />` : html`<${RevenueHistory} options=${options} onCategory=${onCategory} />`}
  <//>`;
}

// 2. Top sellers: one ranking, with Category as a column and a filter. preset: a category and dates sent from Revenue, run at once.
const TOP_SELLERS_DAYS = 366; // the most server/reports.js takes
function TopSellers({ options, preset, clipped }) {
  const r = useReport("top-sellers", { ...dateFilters(options), category: "", ...preset });
  const [sub, setSub] = useState("summary"); // the part of the report a phone shows
  const [measure, setMeasure] = useState("units"); // the top 10 by units or by revenue
  const [open, setOpen] = useState(() => new Set()); // the products whose ingredients are shown
  useEffect(() => { if (preset) r.run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { report } = r;
  const costs = report?.seesCosts;
  const toggle = (id) => setOpen((was) => { const next = new Set(was); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const vs = report && `vs. previous ${report.previous.days} day${report.previous.days > 1 ? "s" : ""}`;
  const card = (name, k, fmt, lower) => [name, fmt(report.cards[k]), false,
    html`<${Change} now=${report.cards[k]} before=${report.previous.cards[k]} vs=${vs} lower=${lower} points=${k === "marginPct"} />`];
  const byCategory = report ? Object.values(report.rows.reduce((acc, x) => {
    (acc[x.categoryId] ||= { key: x.categoryId, name: x.category, value: 0 }).value += x.revenue;
    return acc;
  }, {})).sort((a, b) => b.value - a.value) : [];
  const top10 = report ? [...report.rows].sort((a, b) => b[measure] - a[measure] || a.rank - b.rank).slice(0, 10) : [];
  const cols = costs ? 8 : 5;
  return html`<section className="pview report" aria-label="Top sellers">
    <${Filters} r=${r} options=${options}>
      <label className="pf"><b>Category</b>
        <select className="select" aria-label="Category" value=${r.filters.category} onChange=${(e) => r.set({ category: e.target.value })}>
          <option value="">All categories</option>
          ${options.categories.map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
          <option value="none">No category</option></select></label>
    <//>
    ${report && html`<${React.Fragment}>
      <${SubTabs} tabs=${[["summary", "Summary"], ["charts", "Charts"], ["table", "Table"]]} value=${sub} onChange=${setSub} label="Report parts" />
      <p className="sub">${report.location} · ${report.category} · ${dayOf(report.from)} to ${dayOf(report.to)}</p>
      ${clipped && report.from === preset?.from && html`<p className="sub" role="status">Top sellers covers up to ${TOP_SELLERS_DAYS} days, so this starts on ${dayOf(report.from)} instead of ${dayOf(clipped)}.</p>`}
      <${Cards} className=${panelOf("summary", sub)} cards=${[card("Units sold", "units", units), card("Revenue", "revenue", money),
        ...(costs ? [card("Cost of goods", "cost", money, true), card("Margin %", "marginPct", percent)] : [])]} />
      <div className=${`rgrid ${panelOf("charts", sub)}`}>
        <${HBars} title=${`Top 10 products by ${measure === "units" ? "units sold" : "revenue"}`} empty="Nothing sold in these dates."
          total=${report.total[measure]} fmt=${measure === "units" ? (n) => `${count(n)} sold` : money}
          legend=${html`<div className="tabs thin" role="group" aria-label="Rank by">${[["units", "Units"], ["revenue", "Revenue"]].map(([k, l]) =>
            html`<button key=${k} type="button" className="tab small" aria-pressed=${measure === k} onClick=${() => setMeasure(k)}>${l}</button>`)}</div>`}
          bars=${top10.map((x) => ({ key: x.id, name: x.product, value: x[measure], extra: x.category }))} />
        <${Donut} title="Revenue by category" slices=${byCategory} total=${report.total.revenue} empty="Nothing sold in these dates." />
        <${HBars} title="Most popular add-ons and substitutions" empty="No add-ons or substitutions chosen in these dates."
          total=${null} fmt=${(n) => `${count(n)}×`}
          bars=${report.addOns.map((x) => ({ ...x, extra: `${x.kind} · ${x.group} · ${money(x.revenue)} added` }))}
          note="Times chosen, counting each item made. The amount is what they added to the price, before discounts." />
        <${HBars} title="Slowest sellers" empty="No active products." total=${null} fmt=${(n) => `${count(n)} sold`}
          bars=${report.slowest.map((x) => ({ ...x, extra: money(x.revenue) }))}
          note="The five active products that sold least in these dates." />
      </div>
      <div className=${`tablewrap ${panelOf("table", sub)}`}>
        <h3>Top sellers</h3>
        <div className="tscroll"><table className="table mg fit rowcards" aria-label="Top sellers">
          <thead><tr><th>Rank</th><th>Product</th><th>Category</th><th className="r">Units sold</th><th className="r">Revenue</th>
            ${costs && html`<${React.Fragment}><th className="r">Cost</th><th className="r">Margin $</th><th className="r">Margin %</th><//>`}</tr></thead>
          <tbody>${report.rows.map((x) => html`<${React.Fragment} key=${x.rank}><tr>
            <td>${x.rank}</td>
            <td>${costs ? html`<button type="button" className="rowopen" aria-expanded=${open.has(x.id)} onClick=${() => toggle(x.id)}>
              <span aria-hidden="true">${open.has(x.id) ? "▾" : "▸"}</span> ${x.product}</button>` : x.product}</td>
            <td>${x.category}</td><td className="r">${units(x.units)}</td><td className="r">${money(x.revenue)}</td>
            ${costs && html`<${React.Fragment}><td className="r">${money(x.cost)}</td><td className="r">${money(x.margin)}</td><td className="r">${percent(x.marginPct)}</td><//>`}</tr>
            ${costs && open.has(x.id) && html`<tr className="ingr"><td colSpan=${cols}>
              <table className="mini" aria-label=${`What goes into ${x.product}`}>
                <thead><tr><th>Ingredient</th><th className="r">Per item</th><th className="r">Cost per item</th></tr></thead>
                <tbody>${x.ingredients.map((g) => html`<tr key=${g.item}><td>${g.item}</td><td className="r">${count(g.perItem)} ${g.unit}</td><td className="r">${money(g.costPerItem)}</td></tr>`)}
                  ${!x.ingredients.length && html`<tr><td colSpan="3">No ingredients recorded for these sales.</td></tr>`}</tbody>
                <tfoot><tr><td>Cost per item</td><td></td><td className="r">${money(x.costPerItem)}</td></tr></tfoot>
              </table>
              <p className="sub">Averages over the ${units(x.units)} sold, from the stock each one used at the cost on the day, add-ons included.</p>
            </td></tr>`}<//>`)}
            ${!report.rows.length && html`<tr><td colSpan=${cols}>Nothing sold in these dates.</td></tr>`}</tbody>
          <tfoot><tr><td>Total</td><td></td><td></td><td className="r">${units(report.total.units)}</td><td className="r">${money(report.total.revenue)}</td>
            ${costs && html`<${React.Fragment}><td className="r">${money(report.total.cost)}</td><td className="r">${money(report.total.margin)}</td><td className="r">${percent(report.total.marginPct)}</td><//>`}</tr></tfoot>
        </table></div>
        <p className="sub">Ranked by units sold. Revenue is after discounts and before tax, and doesn't take refunds off.${costs ? " Click a product to see what goes into it." : ""}</p>
      </div><//>`}
  </section>`;
}

// 3. Labor cost for one pay period. Overtime is past 40 hours in a Monday to Sunday week, at 1.5x.
const hrs = (n) => n.toFixed(2);
const rateText = (x) => (!x.rates.length ? "—" : x.rates.length === 1 ? money(x.rates[0]) : `${money(x.rates[0])}–${money(x.rates.at(-1))}`) + (x.noRate ? ` (${x.noRate} shift${x.noRate > 1 ? "s" : ""} with no rate)` : "");
const LaborCost = ({ options }) => (options.seesLabor ? html`<${LaborReport} options=${options} />`
  : html`<p className="success" role="status">Labor cost needs permission to see team timecards.</p>`);
function LaborReport({ options }) {
  const r = useReport("labor", { period: "", location: options.location });
  const [sub, setSub] = useState("summary"); // the part of the report a phone shows
  const { report } = r;
  return html`<section className="pview report" aria-label="Labor cost">
    <${Filters} r=${r} options=${options} dates=${false} first=${html`<label className="pf"><b>Pay period</b>
      <select className="select" aria-label="Pay period" value=${r.filters.period} onChange=${(e) => r.set({ period: e.target.value })}>
        <option value="">Select a pay period</option>
        ${options.payPeriods.map((p) => html`<option key=${p.id} value=${p.id}>${dayOf(p.start)} to ${dayOf(p.end)}${p.closed ? " (closed)" : ""}</option>`)}</select></label>`} />
    ${report && html`<${React.Fragment}>
      <${SubTabs} tabs=${[["summary", "Summary"], ["table", "Table"]]} value=${sub} onChange=${setSub} label="Report parts" />
      <p className="sub">${report.location} · Pay period ${dayOf(report.period.start)} to ${dayOf(report.period.end)}</p>
      <${Cards} className=${panelOf("summary", sub)} cards=${[["Hours worked", hrs(report.cards.hours)], ["Labor cost", money(report.cards.cost)], ["Net sales", money(report.cards.net)], ["Labor as % of sales", percent(report.cards.laborPct)]]} />
      <div className=${`tablewrap ${panelOf("table", sub)}`}>
        <h3>Labor cost by employee</h3>
        <div className="tscroll"><table className="table mg fit rowcards" aria-label="Labor cost by employee">
          <thead><tr><th>Employee</th><th>Role</th><th className="r">Shifts</th><th className="r">Regular hours</th><th className="r">Overtime hours</th><th className="r">Hourly rate</th><th className="r">Pay</th></tr></thead>
          <tbody>${report.rows.map((x) => html`<tr key=${x.employee}>
            <td>${x.employee}</td><td>${x.role}</td><td className="r">${x.shifts}</td><td className="r">${hrs(x.regularHours)}</td><td className="r">${hrs(x.overtimeHours)}</td>
            <td className="r">${rateText(x)}</td><td className="r">${money(x.pay)}</td></tr>`)}
            ${!report.rows.length && html`<tr><td colSpan="7">No submitted or approved shifts in this pay period.</td></tr>`}</tbody>
          <tfoot><tr><td>Total</td><td></td><td className="r">${report.total.shifts}</td><td className="r">${hrs(report.total.regularHours)}</td>
            <td className="r">${hrs(report.total.overtimeHours)}</td><td></td><td className="r">${money(report.total.pay)}</td></tr></tfoot>
        </table></div>
        <p className="sub">Submitted and approved shifts, less unpaid breaks, at the rate in force when each shift started. Hours past 40 in a Monday to Sunday week are overtime at 1.5×, counting shifts at every location. Role is the employee's current role.</p>
      </div><//>`}
  </section>`;
}

// 4. Stock losses: by item and reason. Amounts are in each item's own unit, so only Reports and Cost have a total.
function StockLosses({ options }) {
  const r = useReport("losses", { ...dateFilters(options), reason: "" });
  const [sub, setSub] = useState("summary"); // the part of the report a phone shows
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
      <${SubTabs} tabs=${[["summary", "Summary"], ["table", "Table"]]} value=${sub} onChange=${setSub} label="Report parts" />
      <p className="sub">${report.location} · ${report.reason} · ${dayOf(report.from)} to ${dayOf(report.to)}</p>
      <${Cards} className=${panelOf("summary", sub)} cards=${[...(costs ? [["Stock lost at cost", money(report.cards.lost)]] : []), ["Loss reports", String(report.cards.reports)],
        ...(costs ? [["Loss as % of stock used", percent(report.cards.lostPct)]] : []), ["Most common reason", report.cards.commonReason || "—"]]} />
      <div className=${`tablewrap ${panelOf("table", sub)}`}>
        <h3>Stock losses by item and reason</h3>
        <div className="tscroll"><table className="table mg fit rowcards" aria-label="Stock losses by item and reason">
          <thead><tr><th>Stock item</th><th>Reason</th><th className="r">Reports</th><th className="r">Amount lost</th><th>Unit</th>${costs && html`<th className="r">Cost</th>`}</tr></thead>
          <tbody>${report.rows.map((x) => html`<tr key=${`${x.item} ${x.reason}`}>
            <td>${x.item}</td><td>${x.reason}</td><td className="r">${x.reports}</td><td className="r">${units(x.amount)}</td><td>${x.unit}</td>${costs && html`<td className="r">${money(x.cost)}</td>`}</tr>`)}
            ${!report.rows.length && html`<tr><td colSpan=${costs ? 6 : 5}>No losses reported in these dates.</td></tr>`}</tbody>
          <tfoot><tr><td>Total</td><td></td><td className="r">${report.total.reports}</td><td></td><td></td>${costs && html`<td className="r">${money(report.total.cost)}</td>`}</tr></tfoot>
        </table></div>
        <p className="sub">Losses are valued at the average cost on the day they were reported. Stock used is what sales used plus what was lost. Count corrections aren't counted as losses.</p>
      </div><//>`}
  </section>`;
}

// 5. Customers: recency, frequency and spend per customer, over a longer range than the other tabs since people don't come in daily
// The tip is CSS on the header's data-tip, not an element inside it: phone cards take their labels from the header's text.
const SCORE_HEADS = [["Recency", "How recently they ordered (5 = most recent)"], ["Frequency", "How often they order (5 = most often)"], ["Spend", "How much they spend (5 = highest)"]];
const people = (n) => `${n} customer${n === 1 ? "" : "s"}`;

// How scores are given: one bar per customer for each measure, coloured by the score it earned, with the values that earned each score.
// Scores rank customers against each other (fifths, ties sharing), so these ranges come from this report, not fixed thresholds.
const SCORE_COLORS = ["#E8D5C0", "#CFA77F", "#A9764F", "#6F4934", "#2E1C12"]; // 1 lightest to 5 darkest
const MEASURES = [
  ["r", "Recency", "daysSince", (v) => `${v} day${v === 1 ? "" : "s"} ago`, "Fewer days since the last order scores higher."],
  ["f", "Frequency", "orders", (v) => `${v} order${v === 1 ? "" : "s"}`, "More orders scores higher."],
  ["m", "Spend", "spend", money, "More spend scores higher."],
];
function ScoreStrips({ rows, cutoffs }) {
  return html`<${Panel} title="How scores are given" isEmpty=${!rows.length} empty="No customers to score in these dates." className="scores"
      legend=${html`<span className="swatches">${SCORE_COLORS.map((c, i) => html`<span key=${c}><i style=${{ background: c }}></i>${i + 1}</span>`)}</span>`}
      note="Each bar is one customer. Scores rank customers against each other in this report, so the ranges move with the dates.">
    ${MEASURES.map(([k, name, field, fmt, hint]) => {
      const top = Math.max(...rows.map((c) => c[field]), 0);
      const sorted = [...rows].sort((a, b) => a[k] - b[k] || a[field] - b[field]);
      return html`<div key=${k} className="strip">
        <h4>${name} <span className="sub">${hint}</span></h4>
        <div className="sbars" role="list" aria-label=${`${name} for each customer`}>${sorted.map((c) => html`<span key=${c.id} role="listitem" className="sbar"
          title=${`${c.customer}: ${fmt(c[field])}, score ${c[k]}`} aria-label=${`${c.customer}: ${fmt(c[field])}, score ${c[k]}`}
          style=${{ height: `${top > 0 ? Math.max(3, (c[field] / top) * 100) : 3}%`, background: SCORE_COLORS[c[k] - 1] }}></span>`)}</div>
        <p className="cuts"><b>Values that earned each score in this report:</b> ${cutoffs[k].map((x) => html`<span key=${x.score}>
          <i style=${{ background: SCORE_COLORS[x.score - 1] }}></i>${x.score}: ${x.customers ? (x.min === x.max ? fmt(x.min) : `${fmt(x.min)}–${fmt(x.max)}`) : "none"}</span>`)}</p>
      </div>`;
    })}
  <//>`;
}

// One customer's orders in the dates, opened from their row. Its totals are the row's.
function CustomerDetail({ id, filters, cols }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api(`/reports/customers/${encodeURIComponent(id)}?${query({ from: filters.from, to: filters.to, location: filters.location })}`).then(setDetail).catch((e) => setError(e.message));
  }, [id, filters.from, filters.to, filters.location]);
  return html`<tr className="ingr"><td colSpan=${cols}>
    ${error ? html`<p className="sub" role="alert">${error}</p>` : !detail ? html`<p className="sub" role="status">Loading…</p>` : html`<div className="cdetail">
      <p className="csum"><b>${detail.customer}</b> ·${detail.totals.orders} order${detail.totals.orders === 1 ? "" : "s"} · ${money(detail.totals.spend)} spent ·
        ${money(detail.totals.averageOrder)} average order · Points: ${detail.points.earned} earned, ${detail.points.redeemed} redeemed${detail.points.adjusted ? `, ${detail.points.adjusted} adjusted` : ""}</p>
      <div className="cgrid">
        <table className="mini" aria-label=${`${detail.customer}'s orders`}>
          <thead><tr><th>Date</th><th>Items</th><th className="r">Total</th></tr></thead>
          <tbody>${detail.orders.map((o) => html`<tr key=${o.number}><td>${shortDay(o.at.slice(0, 10))} ${o.at.slice(11)}<br /><span className="sub">#${o.number}</span></td>
            <td>${o.items.map((i) => `${units(i.qty)}× ${i.name}`).join(", ")}</td>
            <td className="r">${money(o.spend)}${o.refunded ? html`<br /><span className="sub">after ${money(o.refunded)} refunded</span>` : ""}</td></tr>`)}</tbody>
          <tfoot><tr><td>Total</td><td></td><td className="r">${money(detail.totals.spend)}</td></tr></tfoot>
        </table>
        <div>
          <table className="mini" aria-label=${`${detail.customer}'s spend by category`}>
            <thead><tr><th>Category</th><th className="r">Spend</th></tr></thead>
            <tbody>${detail.byCategory.map((c) => html`<tr key=${c.key}><td>${c.name}</td><td className="r">${money(c.value)}</td></tr>`)}</tbody>
            <tfoot><tr><td>Total</td><td className="r">${money(detail.byCategory.reduce((a, c) => a + c.value, 0))}</td></tr></tfoot>
          </table>
          <h4>Favourites</h4>
          <ol className="favs">${detail.favourites.map((f) => html`<li key=${f.name}>${f.name} <span className="sub">${units(f.units)} bought · ${money(f.sold)}</span></li>`)}</ol>
        </div>
      </div>
      <p className="sub">Refunds come off the order they were made on. Points are those earned or redeemed on these orders, plus any adjustment made in these dates.</p>
    </div>`}
  </td></tr>`;
}

function Customers({ options }) {
  const r = useReport("customers", { from: "", to: "", location: options.location, tier: "" });
  const [sub, setSub] = useState("summary"); // the part of the report a phone shows
  const [segment, setSegment] = useState(""); // the RFM table shows one segment when set
  const [open, setOpen] = useState(() => new Set()); // the customers whose orders are shown
  const { report } = r;
  useEffect(() => { setSegment(""); setOpen(new Set()); }, [report]);
  const pickSegment = (s) => { setSegment((was) => (was === s.key ? "" : s.key)); setSub("table"); };
  const toggle = (id) => setOpen((was) => { const next = new Set(was); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const b = report?.breakdown;
  const rows = report ? report.rows.filter((x) => !segment || x.segment === segment) : [];
  const knownTotal = b ? b.known.reduce((a, x) => a + x.value, 0) : 0;
  return html`<section className="pview report" aria-label="Customers">
    <${Filters} r=${r} options=${options}>
      <label className="pf"><b>Membership</b>
        <select className="select" aria-label="Membership" value=${r.filters.tier} onChange=${(e) => r.set({ tier: e.target.value })}>
          <option value="">All memberships</option>
          ${options.tiers.map((t) => html`<option key=${t.id} value=${t.id}>${t.name}</option>`)}</select></label>
    <//>
    ${report && html`<${React.Fragment}>
      <${SubTabs} tabs=${[["summary", "Summary"], ["breakdown", "Breakdown"], ["table", "Table"]]} value=${sub} onChange=${setSub} label="Report parts" />
      <p className="sub">${report.location} · ${report.membership} · ${dayOf(report.from)} to ${dayOf(report.to)}</p>
      <${Cards} className=${panelOf("summary", sub)} cards=${[["Customers", String(report.cards.customers)], ["Average spend", money(report.cards.averageSpend)],
        ["Average orders", report.cards.averageOrders.toFixed(1), false, null, "receipt"], ["Average days since last order", String(report.cards.averageDays), false, null, "clock"]]} />
      <p className=${`sub ${panelOf("summary", sub)}`}>Nobody is labelled At risk until ${report.minDays.atRisk} days after their last order, or Lapsed until ${report.minDays.lapsed} days.</p>
      <div className=${`tablewrap ${panelOf("summary", sub)}`}>
        <h3>Segments</h3>
        <div className="tscroll"><table className="table mg fit rowcards" aria-label="Segments">
          <thead><tr><th>Segment</th><th className="r">Customers</th><th className="r">% of customers</th><th className="r">Revenue</th><th className="r">% of revenue</th>
            <th className="r">Avg orders</th><th className="r">Avg days since last order</th><th className="r">Avg spend</th></tr></thead>
          <tbody>${b.segments.map((g) => html`<tr key=${g.key} className=${segment === g.key ? "sel" : undefined}>
            <td><button type="button" className="rowopen" aria-pressed=${segment === g.key} onClick=${() => pickSegment(g)}>${g.name}</button></td>
            <td className="r">${g.customers}</td><td className="r">${pctText(g.customers, report.total.customers)}</td>
            <td className="r">${money(g.spend)}</td><td className="r">${pctText(g.spend, report.total.spend)}</td>
            <td className="r">${g.averageOrders == null ? "—" : g.averageOrders.toFixed(1)}</td><td className="r">${g.averageDays ?? "—"}</td>
            <td className="r">${g.averageSpend == null ? "—" : money(g.averageSpend)}</td></tr>`)}</tbody>
          <tfoot><tr><td>Total</td><td className="r">${report.total.customers}</td><td className="r">${report.total.customers ? "100.0%" : "—"}</td>
            <td className="r">${money(report.total.spend)}</td><td className="r">${report.total.spend ? "100.0%" : "—"}</td>
            <td className="r">${report.cards.averageOrders.toFixed(1)}</td><td className="r">${report.cards.averageDays}</td><td className="r">${money(report.cards.averageSpend)}</td></tr></tfoot>
        </table></div>
        <p className="sub">Click a segment to see its customers.</p>
      </div>
      <div className=${`rgrid ${panelOf("breakdown", sub)}`}>
        <${Donut} title="Customers by segment" slices=${b.segments.map((g) => ({ key: g.key, name: g.name, value: g.customers }))} total=${report.total.customers}
          fmt=${String} centre="customers" empty="No customers in these dates." onPick=${pickSegment} picked=${segment} />
        <${Donut} title="Revenue by segment" slices=${b.segments.map((g) => ({ key: g.key, name: g.name, value: g.spend }))} total=${report.total.spend}
          empty="No customers in these dates." onPick=${pickSegment} picked=${segment} />
        <${Donut} title="Spend from known customers vs walk-ins" slices=${b.known} total=${knownTotal} empty="No orders in these dates."
          note="Uses the Customers rules: refunds count against their original order, so this differs from Revenue's Net sales." />
        <${HBars} title="Revenue by membership tier" bars=${b.byTier.map((t) => ({ ...t, extra: people(t.customers) }))} total=${report.total.spend}
          empty="No customers in these dates." legend=${html`<${Swatches} names=${["Champion", "Loyal", "Recent", "Steady", "At risk", "Lapsed"]} />`}
          note="Each bar is split by the segments of that tier's customers." />
        <${HBars} title="Spend by customer" total=${report.total.spend} empty="No customers in these dates."
          legend=${html`<${Swatches} names=${b.categories.map((c) => c.name)} />`}
          bars=${b.byCustomer.map((c) => ({ ...c, extra: c.customers ? people(c.customers) : c.segment }))}
          note="What each customer's spend is made of. Refunds are split across the items that were returned." />
        <${ScoreStrips} rows=${report.rows} cutoffs=${b.cutoffs} />
      </div>
      <div className=${`tablewrap ${panelOf("breakdown", sub)}`}>
        <h3>Customers by membership</h3>
        <div className="tscroll"><table className="table mg fit rowcards rfm" aria-label="Customers by membership">
          <thead><tr><th>Membership</th><th className="r">Customers</th><th className="r">Average spend</th></tr></thead>
          <tbody>${report.byMembership.map((g) => html`<tr key=${g.id}>
            <td>${g.name}</td><td className="r">${g.customers}</td><td className="r">${g.averageSpend == null ? "—" : money(g.averageSpend)}</td></tr>`)}</tbody>
        </table></div>
      </div>
      <div className=${`tablewrap ${panelOf("table", sub)}`}>
        <h3>Customers by RFM score</h3>
        ${segment && html`<div className="chips"><button type="button" className="chip" onClick=${() => setSegment("")} aria-label=${`Showing ${segment} only. Show every segment`}>
          Showing: ${segment} <span aria-hidden="true">✕</span></button></div>`}
        <div className="tscroll"><table className="table mg fit rowcards rfm" aria-label="Customers by RFM score">
          <thead><tr><th>Customer</th><th>Membership</th><th>Segment</th><th>Last order</th><th className="r">Days since</th><th className="r">Orders</th><th className="r">Total spend</th>
            ${SCORE_HEADS.map(([name, tip]) => html`<th key=${name} className="score"><span className="headtip" tabIndex="0" data-tip=${tip} aria-label=${`${name}: ${tip}`}>${name}</span></th>`)}</tr></thead>
          <tbody>${rows.map((x) => html`<${React.Fragment} key=${x.id}><tr>
            <td><button type="button" className="rowopen" aria-expanded=${open.has(x.id)} onClick=${() => toggle(x.id)}>
              <span aria-hidden="true">${open.has(x.id) ? "▾" : "▸"}</span> ${x.customer}</button></td>
            <td>${x.membership}</td><td>${x.segment}</td><td>${shortDay(x.lastOrder)}</td><td className="r">${x.daysSince}</td><td className="r">${x.orders}</td><td className="r">${money(x.spend)}</td>
            <td className="score">${x.r}</td><td className="score">${x.f}</td><td className="score">${x.m}</td></tr>
            ${open.has(x.id) && html`<${CustomerDetail} id=${x.id} filters=${{ from: report.from, to: report.to, location: r.filters.location }} cols=${10} />`}<//>`)}
            ${!rows.length && html`<tr><td colSpan="10">${segment ? `No ${segment} customers in these dates.` : "No customer orders in these dates."}</td></tr>`}</tbody>
          <tfoot><tr><td>Total</td><td></td><td></td><td></td><td></td><td className="r">${rows.reduce((a, x) => a + x.orders, 0)}</td>
            <td className="r">${money(rows.reduce((a, x) => a + x.spend, 0))}</td><td></td><td></td><td></td></tr></tfoot>
        </table></div>
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
  const [preset, setPreset] = useState(null); // a category and dates Revenue sent to Top sellers
  const pick = (k) => { window.history.replaceState(null, "", `#${k}`); setTab(k); };
  const choose = (k) => { setPreset(null); pick(k); };
  // Top sellers covers up to 366 days, Revenue history up to ten years: a longer range opens on its last 366 days
  const openCategory = (p) => {
    const first = new Date(Date.parse(`${p.to}T00:00:00Z`) - (TOP_SELLERS_DAYS - 1) * 864e5).toISOString().slice(0, 10);
    setPreset({ ...p, ...(p.from < first && { from: first, clipped: p.from }), stamp: Date.now() });
    pick("top-sellers");
  };

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Reports" />
    <section className="main scrolls" aria-label="Reports">
      <header className="heading"><${PageTitle}>Reports<//></header>
      <${Tabs} tab=${tab} onTab=${choose} />
      ${error ? html`<p className="success" role="alert">${error}</p>`
        : !options ? html`<p className="success">Loading…</p>`
        : tab === "revenue" ? html`<${Revenue} options=${options} onCategory=${openCategory} />`
        : tab === "top-sellers" ? html`<${TopSellers} key=${preset?.stamp || "own"} options=${options}
            preset=${preset && { category: preset.category, from: preset.from, to: preset.to }} clipped=${preset?.clipped} />`
        : tab === "losses" ? html`<${StockLosses} options=${options} />`
        : tab === "labor" ? html`<${LaborCost} options=${options} />`
        : tab === "customers" ? html`<${Customers} options=${options} />`
        : null}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
