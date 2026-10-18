// Menu items that have no page yet: the shared sidebar and a success panel named after the link
const nameFromHash = () => decodeURIComponent(window.location.hash.slice(1));

function App() {
  const me = useMe();
  const [name, setName] = useState(nameFromHash);
  useEffect(() => {
    const onHash = () => setName(nameFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // a role may only open what its menu or its Home tiles list
  const allowed = me && (me.nav.includes(name) || me.tiles.includes(name)) && !(name in PAGES) && name !== "Sign out";
  useEffect(() => {
    if (me && !allowed) api("/access-violation", { page: name }).catch(() => {}).finally(() => window.location.replace(me.home));
  }, [me, allowed, name]);

  return html`<div className="app kitchen">
    <${Sidebar} me=${me} current=${name} />
    ${allowed && html`<${SuccessPanel} name=${name} />`}
  </div>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
