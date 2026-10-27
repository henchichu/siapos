const TABS = [["products", "Products"], ["sizes", "Sizes and recipes"], ["options", "Option groups"], ["promotions", "Promotions"]];
const tabFromHash = () => { const h = window.location.hash.slice(1); return TABS.some(([k]) => k === h) ? h : "products"; };
const usd = (n) => (n == null ? "—" : fromDollars(n));
const picks = (min, max) => (max == null ? (min ? `at least ${min}` : "any number") : min === max ? `exactly ${max}` : min ? `${min} to ${max}` : `up to ${max}`);

function Tabs({ tab, onTab }) {
  return html`<div className="tabs" role="group" aria-label="Product management">
    ${TABS.map(([k, label]) => html`<button key=${k} className="tab" aria-pressed=${tab === k} onClick=${() => onTab(k)}>${label}</button>`)}</div>`;
}

function ProductFilters({ categories, category, setCategory, query, setQuery, children }) {
  return html`<div className="pfilters">
    <select className="select" aria-label="Category" value=${category} onChange=${(e) => setCategory(e.target.value)}>
      <option value="">All categories</option>${categories.map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}</select>
    <input className="field" aria-label="Name or SKU" placeholder="Name or SKU" value=${query} onChange=${(e) => setQuery(e.target.value)} />
    ${children}
  </div>`;
}

const matches = (p, category, query) => (!category || p.categoryId === category) && (!query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase()) || (p.skus || []).some((s) => s.toLowerCase().includes(query.trim().toLowerCase())));

function ReadOnly({ data }) {
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const rows = data.products.filter((p) => matches(p, category, query));
  return html`<section className="pview" aria-label="Products">
    <header className="phead"><h2>Products</h2><div className="cardtools"><span className="filterslot"></span></div>
      <${Filters} popup active=${(category ? 1 : 0) + (query.trim() ? 1 : 0)}><${ProductFilters} categories=${data.categories} category=${category} setCategory=${setCategory} query=${query} setQuery=${setQuery} /><//></header>
    <div className="tscroll"><table className="table ro fit rowcards">
      <thead><tr><th>Product</th><th>Sizes</th><th>Category</th><th className="r">Price from</th><th className="r">Available</th></tr></thead>
      <tbody>${rows.map((p) => html`<tr key=${p.id}><td>${p.name}</td><td>${p.sizes} ${p.sizes === 1 ? "size" : "sizes"}</td><td>${p.category || "—"}</td>
        <td className="r">${usd(p.priceFrom)}</td><td className="r">${p.available ? "yes" : "no"}</td></tr>`)}
        ${!rows.length && html`<tr><td colSpan="5">No products match.</td></tr>`}</tbody>
    </table></div>
  </section>`;
}

const BLANK = { id: null, name: "", description: "", categoryId: "", active: true, hasPhoto: false };

function ProductsTab({ data, reload }) {
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(BLANK);
  const [photo, setPhoto] = useState(null);
  const [msg, setMsg] = useState(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false); // the form column is only there while adding or editing
  const [busy, setBusy] = useState(false);
  const fileRef = useRef();
  const rows = data.products.filter((p) => matches(p, category, query));
  const set = (patch) => setForm({ ...form, ...patch });
  const clear = () => { setForm(BLANK); setPhoto(null); setMsg(null); setOpen(false); };
  const show = (f) => { setForm(f); setPhoto(null); setMsg(null); setNote(""); setOpen(true); };

  const save = async () => {
    setBusy(true);
    try {
      const body = { name: form.name, description: form.description, categoryId: form.categoryId || null, active: form.active };
      const { id } = await api(form.id ? `/products/${form.id}` : "/products", body);
      if (!form.id) setForm((f) => ({ ...f, id })); // so a failed photo upload and a retry update this product instead of adding another
      if (photo) {
        const res = await fetch(`/api/products/${id}/photo`, { method: "POST", headers: { "Content-Type": photo.type }, body: photo });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "The photo wasn't saved.");
      }
      setNote(`${form.id ? "Saved" : "Added"} ${form.name.trim()}.`);
      clear();
      await reload();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
    setBusy(false);
  };
  const toggle = async (p) => {
    try { await api(`/products/${p.id}/active`, { active: !p.active }); await reload(); } catch (e) { setMsg({ kind: "error", text: e.message }); }
  };

  return html`<div className="split">
    <section className="pview grow" aria-label="Products">
      <header className="phead"><h2>Products</h2>
        <${Filters} popup active=${(category ? 1 : 0) + (query.trim() ? 1 : 0)}>
          <${ProductFilters} categories=${data.categories} category=${category} setCategory=${setCategory} query=${query} setQuery=${setQuery} /><//>
        <div className="cardtools"><button className="pbtn" onClick=${() => show(BLANK)}>Add product</button><span className="filterslot"></span></div></header>
      ${note && html`<p className="status" role="status">${note}</p>`}
      <div className="tscroll"><table className="table mg fit rowcards">
        <thead><tr><th>Product</th><th>Category</th><th className="r">Price from</th><th className="r">Cost</th><th className="r">Margin</th><th>Actions</th></tr></thead>
        <tbody>${rows.map((p) => html`<tr key=${p.id} className=${p.active ? "" : "off"}>
          <td>${p.name}${!p.active && html`<span className="tag">inactive</span>`}</td><td>${p.category || "—"}</td><td className="r">${usd(p.priceFrom)}</td>
          <td className="r">${usd(p.cost)}</td><td className="r">${p.margin == null ? "—" : `${p.margin}%`}</td>
          <td><div className="acts"><button className="act" onClick=${() => show({ ...p, categoryId: p.categoryId || "" })}>Edit</button>
            <button className=${p.active ? "act danger" : "act"} onClick=${() => toggle(p)}>${p.active ? "Deactivate" : "Activate"}</button></div></td></tr>`)}
          ${!rows.length && html`<tr><td colSpan="6">No products match.</td></tr>`}</tbody>
      </table></div>
    </section>
    ${open && html`<${Sheet} popup title=${form.id ? "Edit product" : "Add product"} onClose=${clear}>
      <h2>${form.id ? "Edit product" : "Add product"}</h2>
      <label className="pf"><b>Name</b><input className="field" maxLength="150" value=${form.name} onChange=${(e) => set({ name: e.target.value })} /></label>
      <label className="pf"><b>Description</b><input className="field" value=${form.description || ""} onChange=${(e) => set({ description: e.target.value })} /></label>
      <label className="pf"><b>Category</b>
        <select className="select" value=${form.categoryId} onChange=${(e) => set({ categoryId: e.target.value })}>
          <option value="">No category</option>${data.categories.map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}</select></label>
      <div className="pf"><b>Photo</b>
        <input ref=${fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange=${(e) => setPhoto(e.target.files[0] || null)} />
        <button className="pbtn upload" onClick=${() => fileRef.current.click()}>Upload Photo</button>
        ${(photo || form.hasPhoto) && html`<span className="sub">${photo ? photo.name : "A photo is saved"}</span>`}
        ${form.id && form.hasPhoto && !photo && html`<img className="thumb" src=${`/api/products/${form.id}/photo`} alt="" />`}</div>
      <label className="check"><input type="checkbox" checked=${form.active} onChange=${(e) => set({ active: e.target.checked })} /> Active (shown on the register and online menu)</label>
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" disabled=${busy} onClick=${save}>Save</button><button className="pbtn outline" onClick=${clear}>Clear</button></div>
    <//>`}
  </div>`;
}

const BLANK_SIZE = { id: null, name: "", sku: "", price: "", taxCategoryId: "", restock: false };

function SizesTab({ products }) {
  const [productId, setProductId] = useState(products[0]?.id || "");
  const [data, setData] = useState(null);
  const [form, setForm] = useState(BLANK_SIZE);
  const [size, setSize] = useState(null);
  const [lines, setLines] = useState([]);
  const [add, setAdd] = useState({ stockItemId: "", quantity: "" });
  const [msg, setMsg] = useState(null);
  const [recipeMsg, setRecipeMsg] = useState(null);
  const [panel, setPanel] = useState(false); // the right column is only there while adding or editing a size

  // Only the newest request may fill the table, so switching products quickly can't show the old product's sizes
  const latest = useRef(0);
  const load = useCallback(() => {
    if (!productId) return Promise.resolve();
    const n = ++latest.current;
    return api(`/products/${productId}/sizes`).then((d) => { if (n === latest.current) setData(d); });
  }, [productId]);
  useEffect(() => { setPanel(false); setSize(null); setLines([]); setForm(BLANK_SIZE); setMsg(null); setRecipeMsg(null); load().catch((e) => setMsg({ kind: "error", text: e.message })); }, [load]);

  const stock = data?.stock || [];
  const stockOf = (id) => stock.find((s) => s.id === id);
  const cost = lines.reduce((a, l) => a + (stockOf(l.stockItemId)?.unitCost || 0) * Number(l.quantity || 0), 0);

  const closePanel = () => { setPanel(false); setForm(BLANK_SIZE); setSize(null); setLines([]); setMsg(null); setRecipeMsg(null); };
  const pickSize = async (s) => {
    setPanel(true); setSize(s); setForm({ ...s, price: String(s.price) }); setMsg(null); setRecipeMsg(null);
    const r = await api(`/sizes/${s.id}/recipe`);
    setLines(r.lines.map((l) => ({ ...l, quantity: String(l.quantity) })));
  };
  const saveSize = async () => {
    try {
      const body = { name: form.name, sku: form.sku, price: form.price, taxCategoryId: form.taxCategoryId, restock: form.restock };
      const { id } = await api(form.id ? `/sizes/${form.id}` : `/products/${productId}/sizes`, body);
      await load();
      await pickSize({ id, name: form.name.trim(), sku: form.sku.trim(), price: Number(form.price), taxCategoryId: form.taxCategoryId, restock: form.restock });
      setMsg({ kind: "ok", text: `${form.id ? "Saved" : "Added"} ${form.name.trim()}. Now add its recipe.` });
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
  };
  const addLine = () => {
    if (!add.stockItemId || !(Number(add.quantity) > 0)) return setRecipeMsg({ kind: "error", text: "Choose a stock item and a quantity." });
    if (lines.some((l) => l.stockItemId === add.stockItemId)) return setRecipeMsg({ kind: "error", text: "That stock item is already in the recipe." });
    setLines([...lines, add]); setAdd({ stockItemId: "", quantity: "" }); setRecipeMsg(null);
  };
  const saveRecipe = async () => {
    try { await api(`/sizes/${size.id}/recipe`, { lines }); setRecipeMsg({ kind: "ok", text: "Recipe saved." }); await load(); }
    catch (e) { setRecipeMsg({ kind: "error", text: e.message }); }
  };

  return html`<div className="split">
    <section className="pview grow" aria-label="Sizes">
      <header className="phead"><h2>Sizes of</h2>
        <div className="pfilters"><select className="select" aria-label="Product" value=${productId} onChange=${(e) => setProductId(e.target.value)}>
          ${products.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}</select>
          <button className="pbtn" onClick=${() => { closePanel(); setPanel(true); }}>Add size</button></div></header>
      <div className="tscroll"><table className="table mg fit rowcards">
        <thead><tr><th>Size</th><th>SKU</th><th className="r">Price</th><th>Tax category</th><th>Recipe</th><th></th></tr></thead>
        <tbody>${(data?.sizes || []).map((s) => html`<tr key=${s.id} className=${size?.id === s.id ? "sel" : ""}>
          <td>${s.name}</td><td>${s.sku}</td><td className="r">${usd(s.price)}</td><td>${s.taxCategory}</td>
          <td className=${s.recipeItems ? "" : "strong"}>${s.recipeItems ? `${s.recipeItems} items` : "Missing"}</td>
          <td><button className="act" onClick=${() => pickSize(s)}>Edit</button></td></tr>`)}
          ${data && !data.sizes.length && html`<tr><td colSpan="6">No sizes yet.</td></tr>`}</tbody>
      </table></div>
    </section>
    ${panel && html`<${Sheet} popup wide title=${form.id ? "Edit size" : "Add size"} onClose=${closePanel}>
      <section className="pform" aria-label=${form.id ? "Edit size" : "Add size"}>
        <h3>${form.id ? "Edit size" : "Add size"}</h3>
        <div className="row2"><label className="pf grow"><b>Size name</b><input className="field" value=${form.name} onChange=${(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="pf w200"><b>SKU</b><input className="field" value=${form.sku} onChange=${(e) => setForm({ ...form, sku: e.target.value })} /></label></div>
        <div className="row2"><label className="pf w200"><b>Price</b><input className="field" inputMode="decimal" value=${form.price} onChange=${(e) => setForm({ ...form, price: e.target.value.replace(/[^\d.]/g, "") })} /></label>
          <label className="pf grow"><b>Tax category</b><select className="select" value=${form.taxCategoryId} onChange=${(e) => setForm({ ...form, taxCategoryId: e.target.value })}>
            <option value="">Choose…</option>${(data?.taxCategories || []).map((t) => html`<option key=${t.id} value=${t.id}>${t.name}</option>`)}</select></label></div>
        <label className="check"><input type="checkbox" checked=${form.restock} onChange=${(e) => setForm({ ...form, restock: e.target.checked })} /> Goes back into stock when returned</label>
        <${Message} msg=${msg} dashed />
        <div className="pactions"><button className="pbtn" onClick=${saveSize}>Save size</button><button className="pbtn outline" onClick=${closePanel}>Clear</button></div>
      </section>
      ${size && html`<section className="pform recipe" aria-label="Recipe">
        <h2>Recipe for ${size.name}</h2>
        <div className="tscroll"><table className="table mg fit rowcards">
          <thead><tr><th>Stock item</th><th className="r">Quantity</th><th>Unit</th><th></th></tr></thead>
          <tbody>${lines.map((l) => html`<tr key=${l.stockItemId}><td>${stockOf(l.stockItemId)?.name}</td><td className="r">${l.quantity}</td><td>${stockOf(l.stockItemId)?.unit}</td>
            <td><button className="act" onClick=${() => setLines(lines.filter((x) => x !== l))}>Remove</button></td></tr>`)}
            ${!lines.length && html`<tr><td colSpan="4">No stock items yet.</td></tr>`}</tbody>
        </table></div>
        <div className="addrow">
          <select className="select grow" aria-label="Stock item" value=${add.stockItemId} onChange=${(e) => setAdd({ ...add, stockItemId: e.target.value })}>
            <option value="">Stock item</option>${stock.map((s) => html`<option key=${s.id} value=${s.id}>${s.name}</option>`)}</select>
          <input className="field qty" aria-label="Quantity" placeholder="Qty" inputMode="decimal" value=${add.quantity} onChange=${(e) => setAdd({ ...add, quantity: e.target.value.replace(/[^\d.]/g, "") })} />
          <button className="act" onClick=${addLine}>Add</button>
        </div>
        <div className="costline"><span>Cost to make one</span><span>${usd(cost)}</span></div>
        <${Message} msg=${recipeMsg} dashed />
        <button className="pbtn block" onClick=${saveRecipe}>Save recipe</button>
      </section>`}
    <//>`}
  </div>`;
}

const BLANK_GROUP = { id: null, name: "", min: "0", max: "", options: [], productIds: [] };
const BLANK_OPTION = { name: "", priceDelta: "", type: "none", stockItemId: "", toId: "", quantity: "" };

function OptionsTab({ data, reload }) {
  const [form, setForm] = useState(BLANK_GROUP);
  const [opt, setOpt] = useState(BLANK_OPTION);
  const [msg, setMsg] = useState(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false); // the form column is only there while adding or editing
  const close = () => { setForm(BLANK_GROUP); setOpt(BLANK_OPTION); setMsg(null); setOpen(false); };
  const show = (f) => { setForm(f); setOpt(BLANK_OPTION); setMsg(null); setNote(""); setOpen(true); };
  const name = (id) => data.stock.find((s) => s.id === id)?.name || "[stock item]";
  const unit = (id) => data.stock.find((s) => s.id === id)?.unit || "";
  const effectText = (e) => (e.type === "swap" ? `Swaps ${name(e.fromId)} for ${name(e.toId)}` : e.type === "add" ? `Adds ${e.quantity} ${unit(e.stockItemId)} of ${name(e.stockItemId)}` : e.type === "remove" ? `Removes ${name(e.stockItemId)}` : "No stock change");
  const plus = (n) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;

  const addOption = () => {
    const price = opt.priceDelta === "" ? 0 : Number(opt.priceDelta);
    if (!opt.name.trim() || !Number.isFinite(price)) return setMsg({ kind: "error", text: "Enter the option's name and price change." });
    let effect = { type: "none" };
    if (opt.type === "add") effect = { type: "add", stockItemId: opt.stockItemId, quantity: opt.quantity };
    if (opt.type === "remove") effect = { type: "remove", stockItemId: opt.stockItemId };
    if (opt.type === "swap") effect = { type: "swap", fromId: opt.stockItemId, toId: opt.toId };
    if (opt.type !== "none" && !opt.stockItemId) return setMsg({ kind: "error", text: "Choose the stock item." });
    if (opt.type === "swap" && !opt.toId) return setMsg({ kind: "error", text: "Choose what it swaps to." });
    if (opt.type === "add" && !(Number(opt.quantity) > 0)) return setMsg({ kind: "error", text: "Enter the quantity it adds." });
    setForm({ ...form, options: [...form.options, { name: opt.name.trim(), priceDelta: price, effect }] }); setOpt(BLANK_OPTION); setMsg(null);
  };
  const save = async () => {
    try {
      await api(form.id ? `/option-groups/${form.id}` : "/option-groups", { name: form.name, min: form.min, max: form.max, options: form.options, productIds: form.productIds });
      setNote(`Saved ${form.name.trim()}.`); close(); await reload();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
  };
  const stockSelect = (value, onChange, label) => html`<select className="select grow" aria-label=${label} value=${value} onChange=${(e) => onChange(e.target.value)}>
    <option value="">${label}</option>${data.stock.map((s) => html`<option key=${s.id} value=${s.id}>${s.name}</option>`)}</select>`;

  return html`<div className="split">
    <section className="pview grow" aria-label="Option groups">
      <header className="phead"><h2>Option groups</h2><div className="cardtools"><button className="pbtn" onClick=${() => show(BLANK_GROUP)}>Add group</button></div></header>
      ${note && html`<p className="status" role="status">${note}</p>`}
      <div className="tscroll"><table className="table mg fit rowcards">
        <thead><tr><th>Group</th><th>Customer picks</th><th>Offered on</th><th></th></tr></thead>
        <tbody>${data.groups.map((g) => html`<tr key=${g.id} className=${form.id === g.id ? "sel" : ""}><td>${g.name}</td><td>${picks(g.min, g.max)}</td>
          <td>${g.productIds.length} ${g.productIds.length === 1 ? "product" : "products"}</td>
          <td><button className="act" onClick=${() => show({ id: g.id, name: g.name, min: String(g.min), max: g.max == null ? "" : String(g.max), options: g.options, productIds: g.productIds })}>Edit</button></td></tr>`)}</tbody>
      </table></div>
    </section>
    ${open && html`<${Sheet} popup wide title=${form.id ? "Edit group" : "Add group"} onClose=${close}>
      <h2>${form.id ? "Edit group" : "Add group"}</h2>
      <div className="row2"><label className="pf grow"><b>Group name</b><input className="field" value=${form.name} onChange=${(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="pf w200"><b>Fewest choices</b><input className="field" inputMode="numeric" value=${form.min} onChange=${(e) => setForm({ ...form, min: e.target.value.replace(/\D/g, "") })} /></label></div>
      <label className="pf"><b>Most choices (blank = no limit)</b><input className="field" inputMode="numeric" value=${form.max} onChange=${(e) => setForm({ ...form, max: e.target.value.replace(/\D/g, "") })} /></label>
      <h3>Options</h3>
      <div className="tscroll"><table className="table mg fit rowcards">
        <thead><tr><th>Option</th><th className="r">Price change</th><th>Effect on stock</th><th></th></tr></thead>
        <tbody>${form.options.map((o, i) => html`<tr key=${o.id || `new-${i}`}><td>${o.name}</td><td className="r">${plus(o.priceDelta)}</td><td>${effectText(o.effect)}</td>
          <td><button className="act" onClick=${() => setForm({ ...form, options: form.options.filter((x) => x !== o) })}>Remove</button></td></tr>`)}
          ${!form.options.length && html`<tr><td colSpan="4">No options yet.</td></tr>`}</tbody>
      </table></div>
      <div className="addrow wrap">
        <input className="field w126" aria-label="New option" placeholder="New option" value=${opt.name} onChange=${(e) => setOpt({ ...opt, name: e.target.value })} />
        <input className="field w74" aria-label="Price change" placeholder="+0.00" inputMode="decimal" value=${opt.priceDelta} onChange=${(e) => setOpt({ ...opt, priceDelta: e.target.value.replace(/[^\d.-]/g, "") })} />
        <select className="select grow" aria-label="Effect" value=${opt.type} onChange=${(e) => setOpt({ ...opt, type: e.target.value })}>
          <option value="none">No stock change</option><option value="add">Adds</option><option value="swap">Swaps</option><option value="remove">Removes</option></select>
        <button className="act" onClick=${addOption}>Add</button>
      </div>
      ${opt.type !== "none" && html`<div className="addrow">
        ${stockSelect(opt.stockItemId, (v) => setOpt({ ...opt, stockItemId: v }), opt.type === "swap" ? "Swap from" : "Stock item")}
        ${opt.type === "swap" && stockSelect(opt.toId, (v) => setOpt({ ...opt, toId: v }), "Swap to")}
        ${opt.type === "add" && html`<input className="field qty" aria-label="Quantity" placeholder="Qty" inputMode="decimal" value=${opt.quantity} onChange=${(e) => setOpt({ ...opt, quantity: e.target.value.replace(/[^\d.]/g, "") })} />`}</div>`}
      <div className="pf"><b>Offered on products</b><${Multi} options=${data.products} value=${form.productIds} onChange=${(v) => setForm({ ...form, productIds: v })} empty="[one or more products]" /></div>
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" onClick=${save}>Save</button><button className="pbtn outline" onClick=${close}>Clear</button></div>
    <//>`}
  </div>`;
}

const BLANK_PROMO = { id: null, name: "", kind: "percent", value: "", starts: "", ends: "", productIds: [] };

function PromotionsTab({ data, reload }) {
  const [showEnded, setShowEnded] = useState(false);
  const [form, setForm] = useState(BLANK_PROMO);
  const [msg, setMsg] = useState(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false); // the form column is only there while adding or editing
  const close = () => { setForm(BLANK_PROMO); setMsg(null); setOpen(false); };
  const show = (f) => { setForm(f); setMsg(null); setNote(""); setOpen(true); };
  const rows = data.promotions.filter((p) => showEnded || p.status !== "Ended");
  const off = (p) => (p.kind === "percent" ? `${p.value}% off` : `$${p.value.toFixed(2)} off`);

  const save = async () => {
    try {
      await api(form.id ? `/promotions/${form.id}` : "/promotions", { name: form.name, kind: form.kind, value: form.value, starts: form.starts, ends: form.ends, productIds: form.productIds });
      setNote(`Saved ${form.name.trim()}.`); close(); await reload();
    } catch (e) { setMsg({ kind: "error", text: e.message }); }
  };
  const switchTo = async (p, path) => { try { await api(`/promotions/${p.id}/${path}`, {}); await reload(); } catch (e) { setNote(e.message); } };

  return html`<div className="split">
    <section className="pview grow" aria-label="Promotions">
      <header className="phead"><h2>Promotions</h2>
        <${Filters} popup active=${showEnded ? 1 : 0}><div className="pfilters"><label className="check"><input type="checkbox" checked=${showEnded} onChange=${(e) => setShowEnded(e.target.checked)} /> Show ended</label></div><//>
        <div className="cardtools"><button className="pbtn" onClick=${() => show(BLANK_PROMO)}>Add promotion</button><span className="filterslot"></span></div></header>
      ${note && html`<p className="status" role="status">${note}</p>`}
      <div className="tscroll"><table className="table mg fit rowcards">
        <thead><tr><th>Promotion</th><th>Discount</th><th>Applies to</th><th>Starts</th><th>Ends</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((p) => html`<tr key=${p.id} className=${p.status === "Ended" ? "off" : ""}><td>${p.name}</td><td>${off(p)}</td>
          <td>${p.productIds.length} ${p.productIds.length === 1 ? "product" : "products"}</td><td>${dayOf(p.starts)}</td><td>${dayOf(p.ends)}</td><td>${p.status}</td>
          <td><div className="acts"><button className="act" onClick=${() => show({ id: p.id, name: p.name, kind: p.kind, value: String(p.value), starts: p.starts, ends: p.ends, productIds: p.productIds })}>Edit</button>
            ${p.status !== "Ended" && html`<button className="act" onClick=${() => switchTo(p, "end")}>End</button>`}
            ${!p.active && html`<button className="act" onClick=${() => switchTo(p, "activate")}>Activate</button>`}</div></td></tr>`)}
          ${!rows.length && html`<tr><td colSpan="7">No promotions to show.</td></tr>`}</tbody>
      </table></div>
    </section>
    ${open && html`<${Sheet} popup title=${form.id ? "Edit promotion" : "Add promotion"} onClose=${close}>
      <h2>${form.id ? "Edit promotion" : "Add promotion"}</h2>
      <label className="pf"><b>Name</b><input className="field" maxLength="100" value=${form.name} onChange=${(e) => setForm({ ...form, name: e.target.value })} /></label>
      <div className="pf"><b>Discount type</b><div className="segs" role="radiogroup" aria-label="Discount type">
        ${[["percent", "Percent off"], ["amount", "Amount off"]].map(([k, label]) => html`<button key=${k} className="tab small" role="radio" aria-checked=${form.kind === k} aria-pressed=${form.kind === k} onClick=${() => setForm({ ...form, kind: k })}>${label}</button>`)}</div></div>
      <label className="pf"><b>Value</b><input className="field" inputMode="decimal" value=${form.value} onChange=${(e) => setForm({ ...form, value: e.target.value.replace(/[^\d.]/g, "") })} /></label>
      <div className="row2"><label className="pf grow"><b>Starts</b><input className="field date" type="date" value=${form.starts} onChange=${(e) => setForm({ ...form, starts: e.target.value })} /></label>
        <label className="pf grow"><b>Ends</b><input className="field date" type="date" value=${form.ends} onChange=${(e) => setForm({ ...form, ends: e.target.value })} /></label></div>
      <div className="pf"><b>Applies to products</b><${Multi} options=${data.products} value=${form.productIds} onChange=${(v) => setForm({ ...form, productIds: v })} empty="[one or more products]" /></div>
      <${Message} msg=${msg} dashed />
      <div className="pactions"><button className="pbtn" onClick=${save}>Save</button><button className="pbtn outline" onClick=${close}>Clear</button></div>
    <//>`}
  </div>`;
}

function Manage({ data, reloadProducts }) {
  const [tab, setTab] = useState(tabFromHash);
  const [options, setOptions] = useState(null);
  const [promos, setPromos] = useState(null);
  const loadOptions = useCallback(() => api("/option-groups").then(setOptions), []);
  const loadPromos = useCallback(() => api("/promotions").then(setPromos), []);

  useEffect(() => { if (tab === "options") loadOptions(); if (tab === "promotions") loadPromos(); }, [tab]);
  useEffect(() => { // Back and Forward move between tabs
    const onPop = () => setTab(tabFromHash());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (k) => { setTab(k); window.history.pushState(null, "", k === "products" ? window.location.pathname : `#${k}`); };

  return html`<${React.Fragment}>
    <${Tabs} tab=${tab} onTab=${go} />
    ${tab === "products" && html`<${ProductsTab} data=${data} reload=${reloadProducts} />`}
    ${tab === "sizes" && html`<${SizesTab} products=${data.products} />`}
    ${tab === "options" && (options ? html`<${OptionsTab} data=${options} reload=${loadOptions} />` : html`<p className="success">Loading…</p>`)}
    ${tab === "promotions" && (promos ? html`<${PromotionsTab} data=${promos} reload=${loadPromos} />` : html`<p className="success">Loading…</p>`)}
  <//>`;
}

function App() {
  const me = useMe();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => api("/products/list").then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { reload(); }, [reload]);

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current="Products" />
    <section className="main scrolls" aria-label="Products">
      <${PageTitle}>Products<//>
      ${error ? html`<p className="success" role="alert">${error}</p>` : !data ? html`<p className="success">Loading…</p>`
        : data.canEdit ? html`<${Manage} data=${data} reloadProducts=${reload} />` : html`<${ReadOnly} data=${data} />`}
    </section>
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
