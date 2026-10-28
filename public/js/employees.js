// Employees: the staff list, and the add / edit form in a right-hand column that is only there while adding or editing. A PIN only ever travels from the form to the server.
// Owners manage everyone and set pay. Managers manage the staff at their own locations below them, and see pay read-only.
const usd = (n) => (n == null ? "—" : `$${n.toFixed(2)}`);
const empty = (data) => ({ id: null, firstName: "", lastName: "", number: "", email: "", roleId: "", locationIds: [], rate: "", startsOn: data.canPay ? data.today : "", pin: "" });
// Editing starts from their latest pay rate; changing it adds a new rate from Starts on and keeps the old one in history
const fromEmployee = (e) => ({
  id: e.id, firstName: e.firstName, lastName: e.lastName, number: e.number, email: e.email, roleId: e.roleId,
  locationIds: e.locations.map((l) => l.id), rate: e.latest ? e.latest.rate.toFixed(2) : "", startsOn: e.latest?.startsOn || "", pin: "",
});

function StaffTable({ data, rows, busy, onEdit, onAct, editingId }) {
  return html`<div className="tscroll"><table className="table mg fit rowcards" aria-label="Employees">
    <thead><tr><th>Employee</th><th>Role</th><th>Locations</th><th className="r">Pay rate</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${rows.map((e) => html`<tr key=${e.id} className=${`${editingId === e.id ? "sel" : ""} ${e.active ? "" : "off"}`}>
      <td className="person" data-initials=${initials(`${e.firstName} ${e.lastName}`)}><b>${e.firstName} ${e.lastName}</b><span className="sub">No. ${e.number}</span></td>
      <td>${e.role}</td>
      <td>${e.locations.map((l) => l.name).join(", ") || "—"}</td>
      <td className="r">${usd(e.rate)}${e.next && html`<span className="sub" style=${{ display: "block" }}>${usd(e.next.rate)} from ${dayOf(e.next.startsOn)}</span>`}</td>
      <td><${Status} tone=${e.status === "Locked" ? "warn" : e.active ? "on" : "off"}>${e.status}<//></td>
      <td>${!e.manageable ? html`<span className="sub">Owner only</span>` : html`<div className="acts">
        <button className="act" disabled=${busy} onClick=${() => onEdit(e)}>Edit</button>
        ${!e.active ? html`<button className="act" disabled=${busy} onClick=${() => onAct(e, "reactivate")}>Reactivate</button>`
          : e.locked ? html`<button className="act hi" disabled=${busy} onClick=${() => onAct(e, "unlock")}>Unlock</button>`
          : html`<button className="act danger" disabled=${busy || e.id === data.me} title=${e.id === data.me ? "You can't deactivate yourself" : undefined}
              onClick=${() => onAct(e, "deactivate")}>Deactivate</button>`}
      </div>`}</td></tr>`)}
      ${!rows.length && html`<tr><td colSpan="6">No employees match.</td></tr>`}</tbody>
  </table></div>`;
}

function StaffForm({ data, form, setForm, msg, busy, onSave, onClear }) {
  const set = (patch) => setForm({ ...form, ...patch });
  const editing = !!form.id;
  const self = form.id === data.me;
  const digits = (n) => (e) => e.target.value.replace(/\D/g, "").slice(0, n);
  return html`<${Sheet} popup title=${editing ? "Edit employee" : "Add employee"} onClose=${onClear}>
    <h2>${editing ? "Edit employee" : "Add employee"}</h2>
    <form className="stack" style=${{ gap: 16 }} onSubmit=${(e) => { e.preventDefault(); onSave(); }}>
      <label className="pf"><b>First name</b><input className="field" maxLength="50" value=${form.firstName} onChange=${(e) => set({ firstName: e.target.value })} /></label>
      <label className="pf"><b>Last name</b><input className="field" maxLength="50" value=${form.lastName} onChange=${(e) => set({ lastName: e.target.value })} /></label>
      <label className="pf"><b>Employee number (8 digits, used to sign in)</b>
        <input className="field" inputMode="numeric" autoComplete="off" value=${form.number} onChange=${(e) => set({ number: digits(8)(e) })} /></label>
      <label className="pf"><b>Email</b><input className="field" type="email" maxLength="255" value=${form.email} onChange=${(e) => set({ email: e.target.value })} /></label>
      <label className="pf"><b>Role</b>
        <select className="select" value=${form.roleId} disabled=${self} onChange=${(e) => set({ roleId: e.target.value })}>
          <option value="">[one of this business's roles]</option>
          ${data.roles.filter((r) => data.assignable.includes(r.id) || r.id === form.roleId).map((r) => html`<option key=${r.id} value=${r.id}>${r.name}</option>`)}</select>
        ${self && html`<span className="sub">You can't change your own role.</span>`}</label>
      <div className="pf"><b>Locations</b>
        <${Multi} options=${data.locations} value=${form.locationIds} onChange=${(v) => set({ locationIds: v })} empty="[one or more locations]" /></div>
      <div className="row2">
        <label className="pf grow"><b>Hourly rate</b><input className="field" inputMode="decimal" disabled=${!data.canPay} placeholder=${data.canPay ? "" : "—"}
          value=${form.rate} onChange=${(e) => set({ rate: e.target.value.replace(/[^\d.]/g, "") })} /></label>
        <label className="pf grow"><b>Starts on</b><input className="field date" type="date" disabled=${!data.canPay} value=${form.startsOn} onChange=${(e) => set({ startsOn: e.target.value })} /></label>
      </div>
      ${!data.canPay ? html`<span className="sub">Only an owner can set or change pay rates.</span>`
        : editing && html`<span className="sub">To give a new rate, change it and pick when it starts. The current rate stays in the history.</span>`}
      <label className="pf"><b>${editing ? "New PIN (6 digits, leave blank to keep the current one)" : "PIN (6 digits)"}</b>
        <input className="field" type="password" inputMode="numeric" autoComplete="new-password" value=${form.pin} onChange=${(e) => set({ pin: digits(6)(e) })} /></label>
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" type="submit" disabled=${busy}>Save</button>
        <button className="pbtn outline" type="button" onClick=${onClear}>Clear</button></div>
    </form>
  <//>`;
}

function App() {
  const me = useMe();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [role, setRole] = useState("all");
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState(null); // null: the form column is closed
  const [msg, setMsg] = useState(null); // the form's message area
  const [note, setNote] = useState(null); // what a row action did
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api("/employees").then((d) => { setData(d); return d; }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const clear = () => { setForm(null); setMsg(null); };
  const show = (f) => { setForm(f); setMsg(null); setNote(null); };
  const save = async () => {
    setBusy(true);
    try {
      const { id, ...body } = form;
      // pay is the owner's to send; for anyone else the rate shown is only for reading
      const out = await api(id ? `/employees/${id}` : "/employees", data.canPay ? body : { ...body, rate: "", startsOn: "" });
      setNote({ kind: "ok", text: out.message });
      clear();
      await load();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
    setBusy(false);
  };
  const run = async (e, path, body) => {
    setBusy(true);
    try { setNote({ kind: "ok", text: (await api(`/employees/${e.id}/${path}`, body)).message }); await load(); }
    catch (err) { setNote({ kind: "error", text: err.message }); }
    setBusy(false);
  };
  const act = (e, what) => {
    if (what === "deactivate") return setConfirm(e);
    return what === "unlock" ? run(e, "unlock", {}) : run(e, "active", { active: true });
  };

  const rows = (data?.employees || []).filter((e) => (showInactive || e.active) && (role === "all" || e.roleId === role));
  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Employees" />
    <section className="main scrolls" aria-label="Employees">
      <${PageTitle}>Employees<//>
      ${error ? html`<p className="success" role="alert">${error}</p>` : !data ? html`<p className="success">Loading…</p>` : html`<div className="staff">
        <section className="pview">
          <header className="phead end bar">
            <${Filters} popup active=${(role !== "all" ? 1 : 0) + (showInactive ? 1 : 0)}>
              <div className="pfilters">
                <select className="select" aria-label="Role" value=${role} onChange=${(e) => setRole(e.target.value)}>
                  <option value="all">All roles</option>${data.roles.map((r) => html`<option key=${r.id} value=${r.id}>${r.name}</option>`)}</select>
                <label className="check"><input type="checkbox" checked=${showInactive} onChange=${(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
              </div>
            <//>
            <div className="cardtools"><button className="pbtn" onClick=${() => show(empty(data))}>Add employee</button><span className="filterslot"></span></div>
          </header>
          ${note && html`<${Message} msg=${note} />`}
          <${StaffTable} data=${data} rows=${rows} busy=${busy} onEdit=${(e) => show(fromEmployee(e))} onAct=${act} editingId=${form?.id} />
        </section>
        ${form && html`<${StaffForm} data=${data} form=${form} setForm=${setForm} msg=${msg} busy=${busy} onSave=${save} onClear=${clear} />`}
      </div>`}
      ${confirm && html`<${Confirm} title=${`Deactivate ${confirm.firstName} ${confirm.lastName}?`}
        text="They won't be able to sign in until they're reactivated. Their shifts, sales and pay history stay on record." label="Deactivate"
        onNo=${() => setConfirm(null)} onYes=${() => { const e = confirm; setConfirm(null); run(e, "active", { active: false }); }} />`}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
