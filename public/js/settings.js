// Settings: General (business, refund rules, categories, locations) and Roles and permissions. A form to add or edit
// opens in a column beside the list only while it is needed, like the other pages.
const TABS = [["general", "General"], ["roles", "Roles and permissions"]];
// The browser's own list of IANA time zones (the server checks the choice again). An old browser without it gets the US zones.
const ZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone")
  : ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];
// A short label for the table, like "Central (Chicago)": the US zone name, else the region, with the zone's city
const US_ZONES = { "America/New_York": "Eastern", "America/Chicago": "Central", "America/Denver": "Mountain", "America/Phoenix": "Arizona",
  "America/Los_Angeles": "Pacific", "America/Anchorage": "Alaska", "Pacific/Honolulu": "Hawaii" };
const zoneLabel = (z) => { const parts = z.split("/"); const city = parts[parts.length - 1].replace(/_/g, " ");
  return parts.length < 2 ? z : `${US_ZONES[z] || parts[0]} (${city})`; };
const NEW_CATEGORY = { name: "" };
const NEW_LOCATION = { name: "", address: "", phone: "", timeZone: "America/Chicago", active: true, online: false, rates: {}, registers: [{ name: "Register 1" }] };
const NEW_ROLE = { name: "", active: true, permissions: [] };

function Field({ label, value, onChange, type = "text", ...rest }) {
  return html`<label className="pf"><b>${label}</b>
    <input className="field" type=${type} value=${value ?? ""} step=${type === "number" ? "any" : undefined} min=${type === "number" ? "0" : undefined}
      onChange=${(e) => onChange(e.target.value)} ...${rest} /></label>`;
}

const Tag = ({ off }) => (off ? html`<span className="tag">inactive</span>` : null);

// ---- General --------------------------------------------------------------------------------------------------------

function CategoryForm({ form, set, msg, busy, onSave, onClose }) {
  const title = form.id ? "Rename category" : "Add category";
  return html`<${Sheet} popup title=${title} onClose=${onClose}>
    <h2>${title}</h2>
    <form className="stack" style=${{ gap: 16 }} onSubmit=${(e) => { e.preventDefault(); onSave(); }}>
      <${Field} label="Category name" required maxLength="100" value=${form.name} onChange=${(v) => set({ name: v })} />
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" type="submit" disabled=${busy}>Save</button>
        <button className="pbtn outline" type="button" onClick=${onClose}>Cancel</button></div>
    </form>
  <//>`;
}

function LocationForm({ data, form, set, msg, busy, onSave, onClose }) {
  const title = form.id ? "Edit location" : "Add location";
  const setRegisters = (registers) => set({ registers });
  return html`<${Sheet} popup wide title=${title} onClose=${onClose}>
    <h2>${title}</h2>
    <form className="stack" style=${{ gap: 16 }} onSubmit=${(e) => { e.preventDefault(); onSave(); }}>
      <${Field} label="Location name" required maxLength="100" value=${form.name} onChange=${(v) => set({ name: v })} />
      <${Field} label="Address" maxLength="255" value=${form.address} onChange=${(v) => set({ address: v })} />
      <${Field} label="Phone" maxLength="30" value=${form.phone} onChange=${(v) => set({ phone: v })} />
      <label className="pf"><b>IANA time zone</b>
        <select className="select" required value=${form.timeZone} onChange=${(e) => set({ timeZone: e.target.value })}>
          ${(ZONES.includes(form.timeZone) ? ZONES : [form.timeZone, ...ZONES]).map((z) => html`<option key=${z} value=${z}>${z}</option>`)}</select></label>
      <label className="check"><input type="checkbox" checked=${form.online} onChange=${(e) => set({ online: e.target.checked })} /> Accept online orders</label>
      ${form.id && html`<label className="pf"><b>Phone order link (make the café's QR code from this)</b>
        <input className="field" readOnly value=${`${data.orderBase}/order/${form.id}`} onFocus=${(e) => e.target.select()} /></label>`}
      <h3>Tax rates (%)</h3>
      ${data.taxes.map((t) => html`<${Field} key=${t.id} label=${t.name} type="number" required value=${form.rates[t.id] ?? ""}
        onChange=${(v) => set({ rates: { ...form.rates, [t.id]: v } })} />`)}
      <span className="sub">Enter percentages, such as 8.25. Use 0 for exempt.</span>
      <h3>Registers</h3>
      ${form.registers.map((r, i) => html`<div className="regrow" key=${r.id || i}>
        <${Field} label=${`Register ${i + 1}`} required maxLength="100" value=${r.name}
          onChange=${(v) => setRegisters(form.registers.map((g, j) => (i === j ? { ...g, name: v } : g)))} />
        ${!r.id && html`<button className="pbtn outline" type="button" onClick=${() => setRegisters(form.registers.filter((_, j) => i !== j))}>Remove</button>`}</div>`)}
      <div><button className="pbtn outline" type="button" onClick=${() => setRegisters([...form.registers, { name: "" }])}>Add register</button></div>
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" type="submit" disabled=${busy}>Save location</button>
        <button className="pbtn outline" type="button" onClick=${onClose}>Cancel</button></div>
    </form>
  <//>`;
}

function General({ data, run, fail, busy, ask, markDirty, markClean }) {
  const [business, setBusiness] = useState({ ...data.business, includesTax: !!data.business.includesTax });
  const [refund, setRefund] = useState({ amount: data.business.amount ?? "", days: data.business.days ?? "" });
  const [panel, setPanel] = useState(null); // null: the form column is closed; else { kind: "category" | "location", form }
  const [msg, setMsg] = useState(null); // the open form's errors
  const [sub, setSub] = useState("business"); // the section a phone shows

  const change = (setter, old) => (patch) => { markDirty(); setter({ ...old, ...patch }); };
  const saveInline = (path, body) => async (e) => { e.preventDefault(); const err = await run(path, body); if (err) fail(err); else markClean(); };
  const open = (kind, form) => { setPanel({ kind, form }); setMsg(null); };
  const close = () => { setPanel(null); setMsg(null); markClean(); };
  const setForm = (patch) => { markDirty(); setPanel({ ...panel, form: { ...panel.form, ...patch } }); };
  const savePanel = async (path) => { const err = await run(path, panel.form); if (err) setMsg({ kind: "error", text: err }); else close(); };
  const toggle = (what, path, row) => ask({
    title: `${row.active ? "Deactivate" : "Reactivate"} ${row.name}?`, text: what, label: row.active ? "Deactivate" : "Reactivate",
    onYes: async () => { const err = await run(path, { ...row, active: !row.active, online: !!row.online }); if (err) fail(err); },
  });
  const editing = panel?.form.id;

  return html`<div className="staff">
    <${SubTabs} tabs=${[["business", "Business"], ["refunds", "Refunds"], ["categories", "Categories"], ["locations", "Locations"]]} value=${sub} onChange=${setSub} label="Settings sections" />
    <section className="pview">
      <div className=${`stack ${panelOf("business", sub)}`}>
        <h3>Business</h3>
        <form className="sform" onSubmit=${saveInline("/settings/business", business)}>
          <div className="sgrid">
            <${Field} label="Business name" required maxLength="100" value=${business.name} onChange=${(v) => change(setBusiness, business)({ name: v })} />
            <${Field} label="Contact email" type="email" maxLength="255" value=${business.email} onChange=${(v) => change(setBusiness, business)({ email: v })} />
            <${Field} label="Contact phone" maxLength="30" value=${business.phone} onChange=${(v) => change(setBusiness, business)({ phone: v })} />
          </div>
          <label className="check"><input type="checkbox" checked=${business.includesTax} onChange=${(e) => change(setBusiness, business)({ includesTax: e.target.checked })} /> Menu prices already include tax</label>
          <div><button className="pbtn" type="submit" disabled=${busy}>Save business</button></div>
        </form>
      </div>

      <div className=${`stack ${panelOf("refunds", sub)}`}>
        <h3>Refund rules</h3>
        <form className="sform" onSubmit=${saveInline("/settings/refunds", refund)}>
          <span className="sub">A refund override signer is required when a refund exceeds either limit. Leave a limit blank to disable it.</span>
          <div className="sgrid">
            <${Field} label="Over this amount" type="number" value=${refund.amount} onChange=${(v) => change(setRefund, refund)({ amount: v })} />
            <${Field} label="Older than this many days" type="number" value=${refund.days} onChange=${(v) => change(setRefund, refund)({ days: v })} />
          </div>
          <div><button className="pbtn" type="submit" disabled=${busy}>Save refund rules</button></div>
        </form>
      </div>

      <div className=${`stack ${panelOf("categories", sub)}`}>
        <header className="phead"><h3>Categories</h3><div className="cardtools"><button className="pbtn" onClick=${() => open("category", NEW_CATEGORY)}>Add category</button></div></header>
        <div className="tscroll"><table className="table mg cats fit rowcards" aria-label="Categories">
          <thead><tr><th>Category</th><th>Actions</th></tr></thead>
          <tbody>${data.categories.map((c) => html`<tr key=${c.id} className=${`${panel?.kind === "category" && editing === c.id ? "sel" : ""} ${c.active ? "" : "off"}`}>
            <td>${c.name}<${Tag} off=${!c.active} /></td>
            <td><div className="acts">
              <button className="act" disabled=${busy} onClick=${() => open("category", { ...c, active: !!c.active })}>Rename</button>
              <button className=${c.active ? "act danger" : "act"} disabled=${busy} onClick=${() => toggle("Products in it keep their category.", "/settings/categories", c)}>${c.active ? "Deactivate" : "Reactivate"}</button>
            </div></td></tr>`)}</tbody>
        </table></div>
      </div>

      <div className=${`stack ${panelOf("locations", sub)}`}>
        <header className="phead"><h3>Locations</h3><div className="cardtools"><button className="pbtn" onClick=${() => open("location", NEW_LOCATION)}>Add location</button></div></header>
        <div className="tscroll"><table className="table mg locs fit rowcards" aria-label="Locations">
          <thead><tr><th>Location</th><th>Time zone</th><th>Tax rates</th><th>Registers</th><th>Online orders</th><th>Actions</th></tr></thead>
          <tbody>${data.locations.map((l) => html`<tr key=${l.id} className=${`${panel?.kind === "location" && editing === l.id ? "sel" : ""} ${l.active ? "" : "off"}`}>
            <td>${l.name}<${Tag} off=${!l.active} /><span className="sub">${l.address}</span></td>
            <td title=${l.timeZone} data-zone=${l.timeZone}>${zoneLabel(l.timeZone)}</td>
            <td className="rates">${data.taxes.map((t) => html`<div key=${t.id}>${t.name}: <span className="nw">${l.rates[t.id] == null ? "Not set" : `${l.rates[t.id]}%`}</span></div>`)}</td>
            <td>${l.registers.length}</td><td>${l.online ? "On" : "Off"}</td>
            <td><div className="acts">
              <button className="act" disabled=${busy} onClick=${() => open("location", { ...l, active: !!l.active, online: !!l.online, registers: l.registers.map((r) => ({ ...r })), rates: { ...l.rates } })}>Edit</button>
              <button className=${l.active ? "act danger" : "act"} disabled=${busy} onClick=${() => toggle("Staff must be reassigned first.", "/settings/locations", l)}>${l.active ? "Deactivate" : "Reactivate"}</button>
            </div></td></tr>`)}</tbody>
        </table></div>
      </div>
    </section>
    ${panel?.kind === "category" && html`<${CategoryForm} form=${panel.form} set=${setForm} msg=${msg} busy=${busy} onSave=${() => savePanel("/settings/categories")} onClose=${close} />`}
    ${panel?.kind === "location" && html`<${LocationForm} data=${data} form=${panel.form} set=${setForm} msg=${msg} busy=${busy} onSave=${() => savePanel("/settings/locations")} onClose=${close} />`}
  </div>`;
}

// ---- Roles and permissions ------------------------------------------------------------------------------------------

function RoleForm({ data, form, setForm, msg, busy, onSave, onClose }) {
  const title = form.id ? "Edit role" : "Add role";
  const groups = [...new Set(data.permissions.map((p) => p.groupName))];
  const toggle = (code, on) => setForm({ permissions: on ? [...form.permissions, code] : form.permissions.filter((c) => c !== code) });
  return html`<${Sheet} popup wide title=${title} onClose=${onClose}>
    <h2>${title}</h2>
    <form className="stack" style=${{ gap: 16 }} onSubmit=${(e) => { e.preventDefault(); onSave(); }}>
      <${Field} label="Role name" required maxLength="50" value=${form.name} onChange=${(v) => setForm({ name: v })} />
      <h3>What this role can do</h3>
      <div className="permissions">${groups.map((g) => html`<section key=${g}><h3>${g}</h3>
        ${data.permissions.filter((p) => p.groupName === g).map((p) => html`<label className="check" key=${p.code}>
          <input type="checkbox" checked=${form.permissions.includes(p.code)} onChange=${(e) => toggle(p.code, e.target.checked)} /> ${p.name}</label>`)}</section>`)}</div>
      <span className="sub">Saving signs affected staff out. Reassign staff before deactivating their role.</span>
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" type="submit" disabled=${busy}>Save role</button>
        <button className="pbtn outline" type="button" onClick=${onClose}>Cancel</button></div>
    </form>
  <//>`;
}

function Roles({ data, run, fail, busy, ask, markDirty, markClean }) {
  const [form, setForm] = useState(null); // null: the form column is closed
  const [msg, setMsg] = useState(null);

  const open = (r) => { setForm(r); setMsg(null); };
  const close = () => { setForm(null); setMsg(null); markClean(); };
  const set = (patch) => { markDirty(); setForm({ ...form, ...patch }); };
  const save = async () => { const err = await run("/settings/roles", form); if (err) setMsg({ kind: "error", text: err }); else close(); };
  const toggle = (r) => ask({
    title: `${r.active ? "Deactivate" : "Reactivate"} ${r.name}?`, text: "Staff using this role will be signed out.", label: r.active ? "Deactivate" : "Reactivate",
    onYes: async () => { const err = await run("/settings/roles", { ...r, active: !r.active }); if (err) fail(err); },
  });

  return html`<div className="staff">
    <section className="pview">
      <header className="phead"><h2>Roles</h2><div className="cardtools"><button className="pbtn" onClick=${() => open(NEW_ROLE)}>Add role</button></div></header>
      <div className="tscroll"><table className="table mg fit rowcards" aria-label="Roles">
        <thead><tr><th>Role</th><th>Staff</th><th>Actions</th></tr></thead>
        <tbody>${data.roles.map((r) => html`<tr key=${r.id} className=${`${form?.id === r.id ? "sel" : ""} ${r.active ? "" : "off"}`}>
          <td>${r.name}<${Tag} off=${!r.active} /></td><td>${r.staff}</td>
          <td>${r.owner ? "Every permission, locked" : html`<div className="acts">
            <button className="act" disabled=${busy} onClick=${() => open({ ...r, active: !!r.active, permissions: [...r.permissions] })}>Edit</button>
            <button className=${r.active ? "act danger" : "act"} disabled=${busy} onClick=${() => toggle(r)}>${r.active ? "Deactivate" : "Reactivate"}</button></div>`}</td></tr>`)}</tbody>
      </table></div>
      <span className="sub">Only owners change pay rates, use owner-only location views, and manage senior roles. Non-owners remain limited to their assigned locations.</span>
    </section>
    ${form && html`<${RoleForm} data=${data} form=${form} setForm=${set} msg=${msg} busy=${busy} onSave=${save} onClose=${close} />`}
  </div>`;
}

// ---- the page -------------------------------------------------------------------------------------------------------

function App() {
  const me = useMe();
  const [access, setAccess] = useState(null);
  const [tab, setTab] = useState("general");
  const [data, setData] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const dirty = useRef(false); // a form has edits that aren't saved
  const markDirty = () => { dirty.current = true; };
  const markClean = () => { dirty.current = false; };

  useEffect(() => {
    const warn = (e) => { if (dirty.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => { api("/settings/access").then((a) => { setAccess(a); setTab(a.general ? "general" : "roles"); }).catch((e) => setNote({ kind: "error", text: e.message })); }, []);
  const load = useCallback(() => api(`/settings/${tab}`).then(setData), [tab]);
  useEffect(() => {
    let cancelled = false;
    if (access) { setData(null); api(`/settings/${tab}`).then((d) => { if (!cancelled) setData(d); }).catch((e) => { if (!cancelled) setNote({ kind: "error", text: e.message }); }); }
    return () => { cancelled = true; };
  }, [access, tab]);

  // Saves, reloads and says so. Resolves to the error's text, or null when it worked.
  const run = async (path, body) => {
    setBusy(true); setNote(null);
    try { const out = await api(path, body); await load(); setNote({ kind: "ok", text: out.message }); return null; }
    catch (e) { return e.message; }
    finally { setBusy(false); }
  };
  const fail = (text) => setNote({ kind: "error", text });
  const ask = (c) => setConfirm(c);
  const pick = (k) => {
    if (k === tab) return;
    const go = () => { markClean(); setNote(null); setData(null); setTab(k); }; // no data until the new tab's arrives: it has another shape
    if (dirty.current) ask({ title: "Switch tabs?", text: "Changes you haven't saved will be discarded.", label: "Switch", onYes: go });
    else go();
  };
  const shared = { run, fail, busy, ask, markDirty, markClean };

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Settings" />
    <section className="main scrolls" aria-label="Settings">
      <header className="heading"><${PageTitle}>Settings<//></header>
      <div className="tabs" role="group" aria-label="Settings">
        ${TABS.filter(([k]) => access?.[k]).map(([k, label]) => html`<button key=${k} className="tab" aria-pressed=${tab === k} disabled=${busy} onClick=${() => pick(k)}>${label}</button>`)}</div>
      <${Message} msg=${note} />
      ${data ? (tab === "general" ? html`<${General} data=${data} ...${shared} />` : html`<${Roles} data=${data} ...${shared} />`)
        : !note?.kind || note.kind !== "error" ? html`<p className="success">Loading…</p>` : null}
    </section>
    ${confirm && html`<${Confirm} title=${confirm.title} text=${confirm.text} label=${confirm.label}
      onNo=${() => setConfirm(null)} onYes=${() => { const c = confirm; setConfirm(null); c.onYes(); }} />`}
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
