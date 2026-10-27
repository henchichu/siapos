const tabFromHash = () => window.location.hash.slice(1);
const day = (iso, tz) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", timeZone: tz });
const localInput = (iso, tz) => new Date(iso).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 16).replace(" ", "T");
const hrs = (h) => (h == null ? "—" : h.toFixed(2));
const STATUSES = [["ALL", "All"], ["OPEN", "Open"], ["SUBMITTED", "Submitted"], ["APPROVED", "Approved"], ["REJECTED", "Rejected"]];

function Tabs({ view, onView }) {
  return html`<div className="tabs" role="group" aria-label="View">
    <button className="tab" aria-pressed=${view === "shift"} onClick=${() => onView("shift")}>My shift</button>
    <button className="tab" aria-pressed=${view === "team"} onClick=${() => onView("team")}>Team timecards</button>
  </div>`;
}

// Messages a view wants to show, newest last; each can be dismissed
function Notices({ items, onDismiss }) {
  if (!items.length) return html`<p className="sr" role="status"></p>`;
  return html`<ul className="notices" role="status">${items.map((n) => html`<li key=${n.id} className=${n.kind}>
    <span>${n.text}</span><button className="link" onClick=${() => onDismiss(n.id)}>Dismiss</button></li>`)}</ul>`;
}

// ---- My shift --------------------------------------------------------------------------------------------------

function MyShift({ data, reload }) {
  const [sub, setSub] = useState("clock"); // the section a phone shows
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { open, timeZone: tz } = data;
  const clockedIn = !!open;

  const act = async (path) => {
    setBusy(true);
    try { await api(`/shift/${path}`, {}); setMsg(null); } catch (e) { setMsg({ kind: "error", text: e.message }); }
    await reload();
    setBusy(false);
  };

  return html`<${React.Fragment}>
    <${SubTabs} tabs=${[["clock", "Clock"], ["sales", "Sales"], ["hours", "Hours"]]} value=${sub} onChange=${setSub} label="My shift sections" />
    <div className="top">
      <section className=${`clock ${panelOf("clock", sub)}`} aria-label="Time clock">
        <h3>Time clock</h3>
        <p className="since">${clockedIn ? `Clocked in since ${clock(open.clockInAt, tz)}` : "Not clocked in"}</p>
        <p className="where">${data.location}</p>
        <div className="stats">
          <div className="stat"><span>Today</span><b>${hrs(data.hours.today)} h</b><${CardIcon} label="Today" /></div>
          <div className="stat"><span>This week</span><b>${hrs(data.hours.week)} h</b><${CardIcon} label="This week" /></div>
          <div className="stat"><span>Pay period</span><b>${hrs(data.hours.period)} h</b><${CardIcon} label="Pay period" /></div>
        </div>
        <div className="pad">
          <button className="tbtn" disabled=${busy || !clockedIn || open.onBreak} onClick=${() => act("break-start")}>Break Start</button>
          <button className="tbtn" disabled=${busy || !clockedIn || !open.onBreak} onClick=${() => act("break-end")}>Break End</button>
          <button className="tbtn" disabled=${busy || clockedIn} onClick=${() => act("clock-in")}>Clock in</button>
          <button className="tbtn" disabled=${busy || !clockedIn} onClick=${() => setConfirm(true)}>Clock out</button>
        </div>
        <${Message} msg=${msg} dashed />
      </section>
      <section className=${`sales ${panelOf("sales", sub)}`} aria-label="Today's sales">
        <h3>Today's sales at ${data.location}</h3>
        <div className="stats">
          <div className="stat" style=${{ width: 130 }}><span>Orders</span><b>${data.sales.orders}</b><${CardIcon} label="Orders" /></div>
          <div className="stat" style=${{ width: 150 }}><span>Net sales</span><b>${money(data.sales.netCents)}</b><${CardIcon} label="Net sales" /></div>
          <div className="stat" style=${{ width: 130 }}><span>Items sold</span><b>${data.sales.items}</b><${CardIcon} label="Items sold" /></div>
        </div>
      </section>
    </div>
    <section className=${`hours ${panelOf("hours", sub)}`} aria-label="My hours">
      <header><h3>My hours</h3>${data.period && html`<p><span>Pay period</span><span>${dayOf(data.period.start)} to ${dayOf(data.period.end)}</span></p>`}</header>
      <div className="tscroll"><table className="table fit rowcards">
        <thead><tr><th>Date</th><th>Clock in</th><th>Clock out</th><th>Break</th><th>Hours</th><th>Status</th></tr></thead>
        <tbody>
          ${data.entries.map((r) => html`<tr key=${r.id}>
            <td>${day(r.clockInAt, r.timeZone)}</td><td>${clock(r.clockInAt, r.timeZone)}</td><td>${clock(r.clockOutAt, r.timeZone) || "—"}</td>
            <td>${r.breakMinutes} min</td><td>${hrs(r.hours)}</td><td className="state">${r.status}</td></tr>`)}
          <tr><td>Total</td><td></td><td></td><td></td><td>${hrs(data.totalHours)}</td><td></td></tr>
        </tbody>
      </table></div>
      <p className="pay-line"><span>Hourly rate: ${data.rate == null ? "—" : `$${data.rate.toFixed(2)}`}</span><span>Estimated pay this period: ${money(data.estimatedCents)}</span></p>
    </section>
    ${confirm && html`<${Confirm} title="Clock out" text="Clock out and submit this shift for approval? You can't undo this."
      label="Clock out" onNo=${() => setConfirm(false)} onYes=${() => { setConfirm(false); act("clock-out"); }} />`}
  <//>`;
}

// ---- Team timecards --------------------------------------------------------------------------------------------

function EditCard({ row, onClose, onSaved }) {
  const tz = row.timeZone;
  const [clockIn, setClockIn] = useState(localInput(row.clockInAt, tz));
  const [clockOut, setClockOut] = useState(localInput(row.clockOutAt, tz));
  const [brk, setBrk] = useState(String(row.breakMinutes));
  const [msg, setMsg] = useState(null);
  const now = localInput(new Date(), tz); // nothing later than this has happened yet
  const save = async () => {
    try { await api(`/team/timecards/${row.id}/edit`, { clockIn, clockOut, breakMinutes: brk }); onSaved(`Updated ${row.employee}'s timecard. It is waiting for approval.`); }
    catch (e) { setMsg({ kind: "error", text: e.message }); }
  };
  return html`<${Modal} title=${`Edit timecard: ${row.employee}`} onClose=${onClose}>
    <div className="editform">
      <label>Clock in<input className="field" type="datetime-local" max=${now} value=${clockIn} onChange=${(e) => setClockIn(e.target.value)} /></label>
      <label>Clock out<input className="field" type="datetime-local" max=${now} value=${clockOut} onChange=${(e) => setClockOut(e.target.value)} /></label>
      <label>Break (minutes)<input className="field" inputMode="numeric" value=${brk} onChange=${(e) => setBrk(e.target.value.replace(/\D/g, ""))} /></label>
      <${Message} msg=${msg} dashed />
      <div className="btns"><button className="btn primary" onClick=${save}>Save</button><button className="btn" onClick=${onClose}>Cancel</button></div>
    </div>
  <//>`;
}

function Team({ onNotice }) {
  const phone = usePhone();
  const [sub, setSub] = useState("cards"); // the section a phone shows
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({ payPeriodId: "", locationId: "all", status: "SUBMITTED" });
  const [editing, setEditing] = useState(null);
  const [confirmClose, setConfirmClose] = useState(false);

  // Show sends the draft to the server; everything below comes from its answer
  const load = useCallback((filters) => {
    const q = new URLSearchParams(filters).toString();
    return api(`/team/timecards?${q}`).then((d) => { setData(d); setDraft(d.selected); }).catch((e) => onNotice(e.message, "error"));
  }, []);
  useEffect(() => { load({ status: "SUBMITTED", payPeriodId: new URLSearchParams(window.location.search).get("payPeriodId") || "" }); }, [load]); // ?payPeriodId= comes from Needs attention

  const run = async (path, body, okText) => {
    try { const r = await api(path, body || {}); onNotice(okText ? okText(r) : r.message); }
    catch (e) { onNotice(e.message, "error"); }
    await load(draft);
  };

  if (!data) return html`<section className="success">Loading…</section>`;
  const { filters, rows, period, canApprove } = data;

  return html`<${React.Fragment}>
    <${ChangeLocation} phoneOnly show=${filters.locations.length > 1} popup=${{ options: [["all", "All locations"], ...filters.locations.map((l) => [l.id, l.name])], value: draft.locationId, onChange: (v) => { const d = { ...draft, locationId: v }; setDraft(d); load(d); } }} />
    <${SubTabs} tabs=${[["cards", "Timecards"], ["close", "Pay period"]]} value=${sub} onChange=${setSub} label="Team sections" />
    <${Filters} popup active=${(draft.status !== "SUBMITTED" ? 1 : 0)}>
    <section className="filters" aria-label="Filters">
      <label className="wide">Pay period
        <select className="select" value=${draft.payPeriodId} onChange=${(e) => setDraft({ ...draft, payPeriodId: e.target.value })}>
          ${filters.periods.map((p) => html`<option key=${p.id} value=${p.id}>${dayOf(p.start)} to ${dayOf(p.end)}${p.closed ? " (closed)" : ""}</option>`)}</select></label>
      ${!phone && html`<label className="loc">Location
          <select className="select" value=${draft.locationId} onChange=${(e) => setDraft({ ...draft, locationId: e.target.value })}>
            <option value="all">All locations</option>${filters.locations.map((l) => html`<option key=${l.id} value=${l.id}>${l.name}</option>`)}</select></label>`}
      <label className="stat-sel">Status
        <select className="select" value=${draft.status} onChange=${(e) => setDraft({ ...draft, status: e.target.value })}>
          ${STATUSES.map(([v, label]) => html`<option key=${v} value=${v}>${label}</option>`)}</select></label>
      <button className="btn primary" data-apply onClick=${() => load(draft)}>Show</button>
    </section>
    <//>
    <section className=${`cards ${panelOf("cards", sub)}`} aria-label="Timecards">
      <header><h3>Timecards</h3><div className="cardtools"><span className="filterslot"></span></div>
        <div className="batch"><span>${data.waiting} waiting for approval</span>
          <button className="btn" disabled=${!canApprove || !data.waiting || period?.closed}
            onClick=${() => run("/team/timecards/approve-all", { payPeriodId: data.selected.payPeriodId, locationId: data.selected.locationId },
              (r) => `Approved ${r.approved} timecard${r.approved === 1 ? "" : "s"}.`)}>Approve all submitted</button></div></header>
      <div className="tscroll"><table className="table fit rowcards">
        <thead><tr><th>Employee</th><th>Date</th><th>Clock in</th><th>Clock out</th><th>Break</th><th>Hours</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr key=${r.id}>
          <td>${r.employee}</td><td>${day(r.clockInAt, r.timeZone)}</td><td>${clock(r.clockInAt, r.timeZone)}</td><td>${clock(r.clockOutAt, r.timeZone) || "—"}</td>
          <td>${r.breakMinutes} min</td><td>${hrs(r.hours)}</td><td className="state">${r.status}</td>
          <td><div className="acts">${r.status === "SUBMITTED" && canApprove && html`<${React.Fragment}>
              <button className="act" onClick=${() => run(`/team/timecards/${r.id}/approve`, {}, () => `Approved ${r.employee}'s timecard.`)}>Approve</button>
              <button className="act" onClick=${() => run(`/team/timecards/${r.id}/reject`, {}, () => `Rejected ${r.employee}'s timecard.`)}>Reject</button>
              <button className="act" onClick=${() => setEditing(r)}>Edit</button><//>`}
            ${r.status === "REJECTED" && canApprove && html`<button className="act" onClick=${() => setEditing(r)}>Edit</button>`}
            ${r.status === "OPEN" && "Still clocked in"}
            ${r.status === "APPROVED" && `Approved by ${r.approvedBy}`}</div></td></tr>`)}
          ${!rows.length && html`<tr><td colSpan="8">No timecards match.</td></tr>`}</tbody>
      </table></div>
    </section>
    <section className=${`closing ${panelOf("close", sub)}`} aria-label="Close pay period">
      <b>Close this pay period</b>
      <button className="btn primary" disabled=${!canApprove || period?.closed} onClick=${() => setConfirmClose(true)}>Close pay period</button>
    </section>
    ${editing && html`<${EditCard} row=${editing} onClose=${() => setEditing(null)} onSaved=${(text) => { setEditing(null); onNotice(text); load(draft); }} />`}
    ${confirmClose && html`<${Confirm} title="Close pay period"
      text=${`Close ${dayOf(period.start)} to ${dayOf(period.end)}? Every shift in it is locked and can't be edited again.`} label="Close pay period"
      onNo=${() => setConfirmClose(false)} onYes=${() => { setConfirmClose(false); run(`/team/pay-periods/${period.id}/close`); }} />`}
  <//>`;
}

// ---- Page -------------------------------------------------------------------------------------------------------

function App() {
  const me = useMe();
  const [shift, setShift] = useState(null);
  const [view, setView] = useState(null);
  const [notices, setNotices] = useState([]);

  const reload = useCallback(() => api("/shift").then(setShift).catch(() => {}), []);
  useEffect(() => { reload(); }, [reload]);

  // Managers start on Team timecards; everyone else has only their own shift
  const start = (canTeam) => (canTeam && tabFromHash() !== "shift" ? "team" : "shift");
  useEffect(() => { if (shift && view === null) setView(start(shift.canTeam)); }, [shift]);
  useEffect(() => {
    const onPop = () => shift && setView(start(shift.canTeam));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [shift]);

  const go = (v) => { setView(v); window.history.pushState(null, "", `#${v}`); };
  const notify = (text, kind = "ok") => setNotices((n) => [...n, { id: Math.random().toString(36).slice(2), text, kind }]);
  const dismiss = (id) => setNotices((n) => n.filter((x) => x.id !== id));

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="My shift" />
    <section className="main scrolls" aria-label=${view === "team" ? "Team timecards" : "My shift"}>
      <${PageTitle}>My shift<//>
      ${shift?.canTeam && html`<${Tabs} view=${view} onView=${go} />`}
      <${Notices} items=${notices} onDismiss=${dismiss} />
      ${!shift ? html`<section className="success">Loading…</section>`
        : view === "team" && shift.canTeam ? html`<${Team} onNotice=${notify} />`
        : view ? html`<${MyShift} data=${shift} reload=${reload} />` : null}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
