// Rewards: the members list, with the Enroll / Edit form opening beside it only when Add new member or Edit asks for it, and one member's history of orders and points.
// The address keeps the search, Show inactive and the member open, so Back to members (and the browser's Back) return to them.
const EMPTY = { id: null, firstName: "", lastName: "", email: "", phone: "" };
const SEARCH_DELAY = 250; // ms after the last keystroke
const params = () => new URLSearchParams(window.location.search);
const contactOf = (m) => m.email || m.phone || "—";
const whenAt = (iso, tz) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
const dateAt = (iso, tz) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: tz });
const plus = (n) => (n > 0 ? `+${n}` : "0");
const minus = (n) => (n > 0 ? `−${n}` : "0");

// ---- members list ---------------------------------------------------------------------------------------------------

function MemberTable({ data, busy, editingId, onEdit, onHistory, onAct }) {
  return html`<div className="tscroll"><table className="table mg fit rowcards" aria-label="Members">
    <thead><tr><th>Name</th><th>Contact</th><th>Tier</th><th className="r">Points</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${data.members.map((m) => html`<tr key=${m.id} className=${`${editingId === m.id ? "sel" : ""} ${m.active ? "" : "off"}`}>
      <td>${m.firstName} ${m.lastName}</td>
      <td className="contact">${contactOf(m)}${m.email && m.phone && html`<span className="sub">${m.phone}</span>`}</td>
      <td>${m.tier}</td>
      <td className="r">${m.points}</td>
      <td><${Status} tone=${m.active ? "on" : "off"}>${m.active ? "Active" : "Inactive"}<//></td>
      <td><div className="acts">
        ${data.canEdit && html`<button className="act" disabled=${busy} onClick=${() => onEdit(m)}>Edit</button>`}
        <button className="act" onClick=${() => onHistory(m)}>History</button>
        ${data.canEdit && (m.active
          ? html`<button className="act danger" disabled=${busy} onClick=${() => onAct(m, false)}>Deactivate</button>`
          : html`<button className="act" disabled=${busy} onClick=${() => onAct(m, true)}>Reactivate</button>`)}
      </div></td></tr>`)}
      ${!data.members.length && html`<tr><td colSpan="6">No members match.</td></tr>`}</tbody>
  </table></div>`;
}

function MemberForm({ form, setForm, msg, busy, onSave, onClear }) {
  const set = (patch) => setForm({ ...form, ...patch });
  const title = form.id ? "Edit member" : "Enroll member";
  const field = (label, key, type = "text", extra = {}) => html`<label className="pf"><b>${label}</b>
    <input className="field" type=${type} value=${form[key]} onChange=${(e) => set({ [key]: e.target.value })} ...${extra} /></label>`;
  return html`<${Sheet} popup title=${title} onClose=${onClear}>
    <h2>${title}</h2>
    <form className="stack" style=${{ gap: 16 }} onSubmit=${(e) => { e.preventDefault(); onSave(); }}>
      ${field("First name", "firstName", "text", { maxLength: 50 })}
      ${field("Last name", "lastName", "text", { maxLength: 50 })}
      ${field("Email", "email", "email", { maxLength: 255, autoComplete: "off" })}
      ${field("Phone", "phone", "tel", { maxLength: 20, autoComplete: "off" })}
      <span className="sub">Email or phone is required (at least one).</span>
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" type="submit" disabled=${busy}>Save</button>
        <button className="pbtn outline" type="button" onClick=${onClear}>Clear</button></div>
    </form>
  <//>`;
}

function Members({ q, inactive, onFilters, onHistory }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null); // null: the form column is closed
  const [msg, setMsg] = useState(null); // the form's message area: errors only
  const [note, setNote] = useState(null); // above the table: what a save or row action did
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0); // only the newest search may fill the table

  const load = useCallback(async () => {
    const n = ++latest.current;
    try {
      const d = await api(`/rewards/members?${new URLSearchParams({ q, inactive: inactive ? "1" : "0" })}`);
      if (n === latest.current) { setData(d); setError(""); }
    } catch (e) { if (n === latest.current) setError(e.message); }
  }, [q, inactive]);
  // searched on the server, a moment after typing stops
  useEffect(() => { const t = setTimeout(load, data ? SEARCH_DELAY : 0); return () => clearTimeout(t); }, [load]);

  const clear = () => { setForm(null); setMsg(null); };
  const show = (f) => { setForm(f); setMsg(null); setNote(null); };
  const edit = (m) => show({ id: m.id, firstName: m.firstName, lastName: m.lastName, email: m.email || "", phone: m.phone || "" });
  const save = async () => {
    setBusy(true);
    try {
      const { id, ...body } = form;
      const out = await api(id ? `/rewards/members/${id}` : "/rewards/members", body);
      setNote({ kind: "ok", text: out.message });
      clear();
      await load();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
    setBusy(false);
  };
  const setActive = async (m, active) => {
    setBusy(true);
    try { setNote({ kind: "ok", text: (await api(`/rewards/members/${m.id}/active`, { active })).message }); await load(); }
    catch (e) { setNote({ kind: "error", text: e.message }); }
    setBusy(false);
  };

  return html`<${React.Fragment}><${PageTitle}>Rewards members<//><div className="staff">
    <section className="pview">
      <header className="phead end bar">
        <${Filters} popup active=${(q.trim() ? 1 : 0) + (inactive ? 1 : 0)}>
          <div className="pfilters">
            <label className="check search">Search
              <input className="field" type="search" placeholder="Name, email or phone" value=${q} onChange=${(e) => onFilters({ q: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked=${inactive} onChange=${(e) => onFilters({ inactive: e.target.checked })} /> Show inactive</label>
          </div>
        <//>
        <div className="cardtools"><button className="pbtn" onClick=${() => show(EMPTY)}>Add new member</button><span className="filterslot"></span></div>
      </header>
      ${note && html`<${Message} msg=${note} />`}
      ${error ? html`<p className="success" role="alert">${error}</p>` : !data ? html`<p className="success">Loading…</p>` : html`<${React.Fragment}>
        <${MemberTable} data=${data} busy=${busy} editingId=${form?.id} onEdit=${edit} onHistory=${onHistory}
          onAct=${(m, active) => (active ? setActive(m, true) : setConfirm(m))} />
        ${data.more && html`<p className="sub">Showing the first 100 members. Search to narrow the list.</p>`}<//>`}
    </section>
    ${form && html`<${MemberForm} form=${form} setForm=${setForm} msg=${msg} busy=${busy} onSave=${save} onClear=${clear} />`}
    ${confirm && html`<${Confirm} title=${`Deactivate ${confirm.firstName} ${confirm.lastName}?`}
      text="They won't be able to earn or redeem points at the register until they're reactivated. Their points and history are kept." label="Deactivate"
      onNo=${() => setConfirm(null)} onYes=${() => { const m = confirm; setConfirm(null); setActive(m, false); }} />`}
  </div><//>`;
}

// ---- one member's history -------------------------------------------------------------------------------------------

function OrderDialog({ id, onClose }) {
  const [o, setO] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { api(`/rewards/orders/${id}`).then(setO).catch((e) => setError(e.message)); }, [id]);
  const line = (label, cents, strong) => html`<div className=${strong ? "sumline strong" : "sumline"}><span>${label}</span><span>${money(cents)}</span></div>`;
  return html`<${Modal} title=${o ? `Order ${o.number}` : "Order"} onClose=${onClose}>
    ${error ? html`<p className="msg error" role="alert">${error}</p>` : !o ? html`<p>Loading…</p>` : html`<div className="stack odetail">
      <p className="sub">${whenAt(o.at, o.tz)} · ${o.location} · ${o.source}${o.staff ? ` · ${o.staff}` : ""} · ${o.status}</p>
      <table className="table" aria-label="Items">
        <colgroup><col style=${{ width: 56 }} /><col /><col style=${{ width: 96 }} /></colgroup>
        <thead><tr><th>Qty</th><th>Item</th><th className="r">Amount</th></tr></thead>
        <tbody>${o.lines.map((l, i) => html`<tr key=${i}><td>${l.qty}</td>
          <td>${l.name}${l.options.length > 0 && html`<span className="sub">${l.options.join(", ")}</span>`}
            ${l.discountCents > 0 && html`<span className="sub">Discount ${money(-l.discountCents)}</span>`}</td>
          <td className="r">${money(l.lineCents)}</td></tr>`)}</tbody>
      </table>
      <div className="sums">
        ${line("Subtotal", o.subtotalCents)}
        ${o.discountCents > 0 && line("Discount", -o.discountCents)}
        ${line(o.taxIncluded ? "Tax (included)" : "Tax", o.taxCents)}
        ${line("Total", o.totalCents, true)}
      </div>
      ${o.payments.length > 0 && html`<div><h3>Paid</h3>${o.payments.map((p, i) => html`<p key=${i}>${p.method} ${money(p.amountCents)}${p.tipCents ? ` + tip ${money(p.tipCents)}` : ""}${p.status !== "Completed" ? ` (${p.status.toLowerCase()})` : ""}</p>`)}</div>`}
      ${o.refunds.length > 0 && html`<div><h3>Refunds</h3>${o.refunds.map((r, i) => html`<p key=${i}>${money(-r.amountCents)} on ${dateAt(r.at, o.tz)} · ${r.reason}${r.status !== "Completed" ? ` (${r.status.toLowerCase()})` : ""}</p>`)}</div>`}
      <div><h3>Points</h3>${o.points.length ? o.points.map((p, i) => html`<p key=${i}>${p.type}: ${p.points > 0 ? `+${p.points}` : `−${-p.points}`}</p>`) : html`<p className="sub">No points on this order.</p>`}</div>
    </div>`}
    <div className="btns"><button className="btn" onClick=${onClose}>Close</button></div>
  <//>`;
}

function HistoryRows({ rows, onView }) {
  return html`<div className="tscroll"><table className="table mg fit rowcards" aria-label="Orders and points">
    <thead><tr><th>Date</th><th>Order</th><th>Source</th><th>Items</th><th className="r">Total</th><th className="r">Points earned</th><th className="r">Points redeemed</th><th></th></tr></thead>
    <tbody>${rows.map((r) => r.kind === "adjust"
      ? html`<tr key=${r.id}><td>${whenAt(r.at, r.tz)}</td><td>${r.number ?? "—"}</td><td>Points adjustment</td><td></td><td></td>
          <td className="r">${plus(r.earned)}</td><td className="r">${minus(r.redeemed)}</td><td></td></tr>`
      : html`<tr key=${r.id} className=${r.state === "Cancelled" ? "off" : ""}>
          <td>${whenAt(r.at, r.tz)}</td>
          <td>${r.number}${r.state && html`<span className="sub">${r.state}</span>`}</td>
          <td>${r.source}</td>
          <td>${r.items} ${r.items === 1 ? "item" : "items"}</td>
          <td className="r">${money(r.totalCents)}${r.refundedCents > 0 && html`<span className="sub">${money(-r.refundedCents)} refunded</span>`}
            ${r.pendingCents > 0 && html`<span className="sub">${money(-r.pendingCents)} refund pending</span>`}</td>
          <td className="r">${plus(r.earned)}</td>
          <td className="r">${minus(r.redeemed)}</td>
          <td><button className="act" onClick=${() => onView(r.id)}>View</button></td></tr>`)}
      ${!rows.length && html`<tr><td colSpan="8">No orders yet.</td></tr>`}</tbody>
  </table></div>`;
}

function History({ id, onBack }) {
  const [h, setH] = useState(null);
  const [error, setError] = useState("");
  const [view, setView] = useState(null);
  useEffect(() => { api(`/rewards/members/${id}`).then(setH).catch((e) => setError(e.message)); }, [id]);
  const m = h?.member;
  return html`<div className="pview history">
    <header className="hhead"><button className="pbtn outline" onClick=${onBack}>Back to members</button><${PageTitle}>Member history<//></header>
    ${error ? html`<p className="success" role="alert">${error}</p>` : !h ? html`<p className="success">Loading…</p>` : html`<${React.Fragment}>
      <div className="mcards">
        <div><span>${m.firstName} ${m.lastName}${!m.active ? " (inactive)" : ""}</span><b>${m.tier}</b><${CardIcon} label="member" /></div>
        <div><span>Points balance</span><b>${m.points}</b><${CardIcon} label="Points" /></div>
        <div><span>Orders</span><b>${h.orders}</b><${CardIcon} label="Orders" /></div>
        <div><span>Total spent</span><b>${money(h.spentCents)}</b><${CardIcon} label="Total spent" /></div>
      </div>
      <div className="phead"><h2>Orders and points</h2>
        <span className="sub">${[m.email, m.phone].filter(Boolean).join(" · ")} · member since ${dateAt(m.since, h.tz)}</span></div>
      <div className="tablewrap"><${HistoryRows} rows=${h.rows} onView=${setView} /></div><//>`}
    ${view && html`<${OrderDialog} id=${view} onClose=${() => setView(null)} />`}
  </div>`;
}

// ---- the page -------------------------------------------------------------------------------------------------------

const fromAddress = () => { const p = params(); return { q: p.get("q") || "", inactive: p.get("inactive") === "1", member: p.get("member") }; };
const addressOf = ({ q, inactive, member }) => {
  const p = new URLSearchParams();
  if (member) p.set("member", member);
  if (q) p.set("q", q);
  if (inactive) p.set("inactive", "1");
  return `${window.location.pathname}${p.toString() ? `?${p}` : ""}`;
};

function App() {
  const me = useMe();
  const [state, setState] = useState(fromAddress);
  useEffect(() => {
    const onPop = () => setState(fromAddress());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // typing only replaces the address; opening a member adds a step, so the browser's Back works too
  const go = (next, push) => {
    const s = { ...state, ...next };
    window.history[push ? "pushState" : "replaceState"](null, "", addressOf(s));
    setState(s);
    if (push) window.scrollTo(0, 0);
  };
  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Rewards" />
    <section className="main scrolls" aria-label="Rewards">
      ${state.member
        ? html`<${History} key=${state.member} id=${state.member} onBack=${() => go({ member: null }, true)} />`
        : html`<${Members} q=${state.q} inactive=${state.inactive} onFilters=${(f) => go(f)} onHistory=${(m) => go({ member: m.id }, true)} />`}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
