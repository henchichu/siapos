const VIEWS = ["kitchen", "loss"];
const viewFromHash = () => {
  const h = decodeURIComponent(window.location.hash.slice(1));
  return VIEWS.includes(h) ? h : "kitchen";
};
const REASONS = [["broken", "Broken or spilled"], ["spoiled", "Spoiled or expired"]];

const minutes = (iso, now) => `${Math.max(0, Math.floor((now - new Date(iso)) / 60000))} min`;

// What the ticket says about its latest step; the time is shown in the café's own time zone
function whenLine(stage, t, tz, now) {
  if (stage === "new") return `placed ${clock(t.placedAt, tz)} · ${minutes(t.placedAt, now)}`;
  const at = t.statusAt || t.placedAt;
  if (stage === "preparing") return `started ${clock(at, tz)}${t.statusBy ? ` by ${t.statusBy}` : ""} · ${minutes(at, now)}`;
  return `ready since ${clock(at, tz)} · ${minutes(at, now)}`;
}

function Ticket({ stage, t, tz, now, action, busy }) {
  const pickup = t.pickupAt ? clock(t.pickupAt, tz) : "ASAP";
  return html`<article className="ticket" aria-label=${`Order ${t.number}`}>
    <div className="top"><b>Order ${t.number}</b><span>${t.online ? `Online · pickup ${pickup}` : "Register"}</span></div>
    <p className="meta">${t.customer} · ${whenLine(stage, t, tz, now)}</p>
    ${t.items.map((i, n) => {
      const detail = [i.size, i.options.join(", ")].filter(Boolean).join(" · ");
      return html`<${React.Fragment} key=${n}>
        <p className="item">${i.quantity} × ${i.name}</p>
        ${detail && html`<p className="opts">${detail}</p>`}
      <//>`;
    })}
    ${t.note && html`<p className="note">Note: ${t.note}</p>`}
    ${action && html`<button className="kbtn block" disabled=${busy} onClick=${() => action.run(t)}>${action.label}</button>`}
  </article>`;
}

const QUEUES = [["new", "New", { label: "Start", path: "start" }], ["preparing", "Preparing", { label: "Ready", path: "ready" }], ["ready", "Ready for pickup", null]];

function Kitchen({ onReport }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [shown, setShown] = useState("new"); // the queue a phone shows; wider screens show all three

  const load = useCallback(() => api("/kitchen/tickets").then((d) => { setData(d); setError(""); }).catch((e) => setError(e.message)), []);
  useEffect(() => {
    load();
    const poll = setInterval(load, 60000); // safety net; the stream below does the real work
    const tick = setInterval(() => setNow(new Date()), 30000);
    const stream = window.EventSource && new EventSource("/api/kitchen/stream");
    if (stream) stream.onmessage = load;
    return () => { clearInterval(poll); clearInterval(tick); stream?.close(); };
  }, [load]);

  const move = async (path, t) => {
    setBusy(true);
    try { await api(`/kitchen/orders/${t.id}/${path}`, {}); } catch (e) { setError(e.message); }
    await load();
    setBusy(false);
  };

  return html`<section className="main" aria-label="Kitchen">
    <div className="bar">
      <${PageTitle}>Kitchen<//>
      <button className="kbtn outline" onClick=${onReport}>Report a loss</button>
    </div>
    ${error && html`<p className="err" role="alert">${error}</p>`}
    <div className="qtabs" role="group" aria-label="Queue">
      ${QUEUES.map(([key, title]) => html`<button key=${key} aria-pressed=${shown === key} onClick=${() => setShown(key)}>
        ${title}<span className="badge">${(data?.queues[key] || []).length}</span></button>`)}
    </div>
    <div className="queues">
      ${QUEUES.map(([key, title, step]) => {
        const tickets = data?.queues[key] || [];
        const action = step ? { label: step.label, run: (t) => move(step.path, t) }
          : data?.canPickUp ? { label: "Picked up", run: (t) => move("pickup", t) } : null;
        return html`<section className=${shown === key ? "queue on" : "queue"} key=${key} aria-label=${title}>
          <header><h3>${title}</h3><span className="badge" aria-label=${`${tickets.length} orders`}>${tickets.length}</span></header>
          ${tickets.map((t) => html`<${Ticket} key=${t.id} stage=${key} t=${t} tz=${data.timeZone} now=${now} action=${action} busy=${busy} />`)}
        </section>`;
      })}
    </div>
  </section>`;
}

function Loss({ onBack }) {
  const [data, setData] = useState(null);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("broken");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api("/kitchen/losses").then(setData).catch((e) => setMsg({ kind: "error", text: e.message })), []);
  useEffect(() => { load(); }, [load]);

  const item = data?.stock.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  const submit = async () => {
    setBusy(true);
    try {
      await api("/kitchen/losses", { stockItemId: item.id, amount, reason, note });
      setMsg({ kind: "ok", text: `Loss recorded: ${amount} ${item.unit} of ${item.name}.` });
      setName(""); setAmount(""); setNote("");
      await load();
    } catch (e) {
      setMsg({ kind: "error", text: e.message });
    }
    setBusy(false);
  };

  return html`<section className="main" aria-label="Report a loss">
    <div className="bar start">
      <button className="kbtn outline" onClick=${onBack}>Back to tickets</button>
      <${PageTitle}>Report a loss<//>
    </div>
    <div className="loss">
      <div className="panel form">
        <h3>What was lost?</h3>
        <label><b>Stock item</b>
          <input className="field" list="stock" placeholder="Stock item, e.g. Whole milk" autoComplete="off" value=${name} onChange=${(e) => setName(e.target.value)} /></label>
        <datalist id="stock">${data?.stock.map((s) => html`<option key=${s.id} value=${s.name} />`)}</datalist>
        <div className="amount">
          <label><b>How much</b>
            <input className="field" inputMode="decimal" autoComplete="off" value=${amount} onChange=${(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} /></label>
          <div className="reasons"><span className="lbl">Unit</span><span className="unit">${item ? item.unit : "—"}</span></div>
        </div>
        <div className="reasons" role="group" aria-label="Reason">
          <span className="lbl">Reason</span>
          <div>${REASONS.map(([key, label]) => html`<button key=${key} className=${`kbtn ${reason === key ? "" : "outline"}`} aria-pressed=${reason === key} onClick=${() => setReason(key)}>${label}</button>`)}</div>
        </div>
        <label><b>Note (optional)</b>
          <input className="field" maxLength="255" autoComplete="off" value=${note} onChange=${(e) => setNote(e.target.value)} /></label>
        ${msg?.text ? html`<p className=${`msg dashed ${msg.kind}`} role="status">${msg.text}</p>` : html`<p className="sr" role="status"></p>`}
        <button className="kbtn block" disabled=${busy || !item || !(Number(amount) > 0)} onClick=${submit}>Report loss</button>
      </div>
      <div className="panel log">
        <h3>Reported today at ${data?.location}</h3>
        <table className="losses">
          <thead><tr><th>Time</th><th>Stock item</th><th>Amount</th><th>Reason</th><th>By</th></tr></thead>
          <tbody>${data?.losses.map((l, n) => html`<tr key=${n}><td>${clock(l.at, data.timeZone)}</td><td>${l.item}</td><td>${l.amount} ${l.unit}</td><td>${l.reason}</td><td>${l.by}</td></tr>`)}</tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function App() {
  const me = useMe();
  const [view, setView] = useState(viewFromHash);

  useEffect(() => { // Back and Forward move between views
    const onPop = () => setView(viewFromHash());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = (v) => {
    setView(v);
    window.history.pushState(null, "", v === "kitchen" ? window.location.pathname : `#${encodeURIComponent(v)}`);
  };
  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Kitchen" />
    ${view === "loss" ? html`<${Loss} onBack=${() => go("kitchen")} />` : html`<${Kitchen} onReport=${() => go("loss")} />`}
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
