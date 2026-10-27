// The front page: the real staff pages, run on sample data (api.js demo mode) in an iframe, and the tour of them (tour-kit.js).
// The last step, Skip tour and Escape all lead to sign-up; with DEMO_MODE (server/demo.js) they show the demo sign-ins instead. Targets are CSS selectors inside the page shown for that step.
const T = (page, target, title, body, placement) => ({ page, target, title, body, placement });
const STEPS = [
  { page: "home", title: "Welcome to ClockIt", body: "A quick walk through every screen your team will use, filled with sample data. Nothing here is saved, and at the end you set up your own business." },
  T("register", ".products .grid", "Register: ring up the order", "Tap a product to add it, choose its size and extras, and filter by category or search by name. Then apply a discount (a supervisor approves it on the spot) and take cash, card or a gift card. The order goes straight to the kitchen.", "bottom"),
  T("register", ".products > header", "Register: kiosk orders and refunds", "Cash orders placed on customers' phones wait here for you to take the money. Refund looks up an order and sends the request for approval.", "bottom"),
  T("kitchen", ".queues", "Kitchen: a live board", "New orders appear by themselves. The team moves each ticket from New to Preparing to Ready, and customers see the change on their phone.", "bottom"),
  T("kitchen", "button.kbtn", "Kitchen: report a loss", "Spilled or spoiled something? Record it here so the stock count and reports stay honest.", "left"),
  T("attention", ".attention", "Needs attention: the manager's to-do list", "Stock losses, pending deliveries, timecards waiting for approval and refunds waiting for an override, all for today in one place.", "top"),
  T("orders", "form.osearch", "Orders: find any order", "Search by number, date, status, payment or channel to answer a customer's question in seconds.", "bottom"),
  T("orders", "section.results", "Orders: open one for the details", "Open an order to see its lines, payments and history, and to ask for a refund on a completed one.", "top"),
  T("rewards", "section.pview", "Rewards: your members", "Look members up, add new ones and see their orders and points. Members who sign in on their phone earn points too.", "bottom"),
  T("products", "div.tabs", "Products: the whole menu", "Products, option groups and promotions live here, each with its own tab. Set sizes, prices, tax and recipes.", "bottom"),
  T("products", "section.pview header", "Products: find and add", "Filter by category or search, switch products on and off, and add new ones without touching anyone's register.", "bottom"),
  T("inventory", "div.tabs", "Inventory: stock, suppliers and counts", "Track what is on hand at each location, record deliveries and counts, and set the reorder level that feeds Needs attention.", "bottom"),
  T("inventory", 'section[aria-label="Inventory"]', "Inventory: every stock item", "Quantities, units and reorder levels, with a log of every movement below.", "top"),
  T("reports", 'div.tabs[aria-label="Reports"]', "Reports: pick a view", "Live sales, sales by day, top sellers, labor cost, stock losses and more, for one location or all of them.", "bottom"),
  T("reports", ".rcards", "Reports: the numbers at a glance", "Summary cards on top, then a chart and a table underneath. Run it again for any location or date range.", "bottom"),
  T("employees", "section.pview", "Employees: your team", "Add people, give each a role and a location, and turn access off the day someone leaves. Everyone signs in with their own number and PIN.", "bottom"),
  T("settings", 'div.tabs[aria-label="Settings"]', "Settings: roles, tax and more", "Roles and permissions, tax rates, refund rules, categories and locations: how your business runs.", "bottom"),
  T("settings", "form.sform", "Settings: your business", "Business details and refund rules are set once and apply everywhere.", "right"),
  T("shift", 'div.tabs[aria-label="View"]', "My shift: timecards", "Staff clock in and out here. Managers review the whole team's timecards and edit mistakes.", "bottom"),
  T("shift", "section.closing", "My shift: close the pay period", "Approve the hours, then close the pay period so payroll is final.", "top"),
  { page: "home", title: "Ready to set up your shop?", body: "Tell us your business name, add your first location and registers, and create the owner account. It takes about two minutes. You'll be given an employee number to keep: you sign in with it.",
    cta: { label: "Set up your business", href: "/signup.html" } },
];

// The sample page behind a step: its own, or the last one a step named
const pageAt = (i) => { for (; i >= 0; i--) if (STEPS[i].page) return STEPS[i].page; return "home"; };

function Screen() {
  const tour = useTour();
  const page = pageAt(tour.index);
  return html`<div className="shell">
    <header className="tbar">
      <a className="logo" href="/"><img src="/img/clockit-logo-light.png" alt="ClockIt" width="120" height="30" /></a>
      <span className="sample">Sample data: nothing here is saved</span>
      <div className="tbar-cta">
        <a className="tour-btn primary" href="/signup.html">Set up your business</a>
      </div>
    </header>
    <iframe id="screen" title=${`Sample ClockIt screen: ${page}`} src=${`/tour/${page}.html`} inert=""></iframe>
  </div>`;
}

// A step's target is looked for only in the page that step shows, never in the one still on its way out
const getRoot = (step) => {
  const doc = document.getElementById("screen")?.contentDocument;
  return doc && doc.readyState !== "loading" && doc.location.pathname === `/tour/${step.page}.html` ? doc : null;
};

// DEMO_MODE: the last step and leaving the tour show these, then go to the dev-seeded shop's sign-in
function DemoLogins({ credentials }) {
  const title = useRef();
  useEffect(() => title.current?.focus(), []);
  return html`<main className="logins">
    <h1 ref=${title} tabIndex="-1">Your demo sign-ins</h1>
    <p className="keep" role="alert"><b>Take a picture of this list or write it down now.</b> You sign in with an employee number and its 6-digit PIN on the next page, and nothing there will remind you.</p>
    <table className="logintable">
      <caption className="sr">Demo employees</caption>
      <thead><tr><th>Name</th><th>Role</th><th>Employee number</th><th>PIN</th></tr></thead>
      <tbody>${credentials.map((c) => html`<tr key=${c.number}><td>${c.name}</td><td>${c.role}</td><td className="mono">${c.number}</td><td className="mono">${c.pin}</td></tr>`)}</tbody>
    </table>
    <a className="tour-btn primary" href="/login.html">Continue to sign-in</a>
  </main>`;
}

function App() {
  const [credentials, setCredentials] = useState(undefined); // undefined: still asking; null: not a demo
  const [logins, setLogins] = useState(false);
  useEffect(() => {
    fetch("/api/demo").then((r) => (r.ok ? r.json() : null)).then((d) => setCredentials(d?.credentials || null)).catch(() => setCredentials(null));
  }, []);
  const steps = useMemo(() => !credentials ? STEPS : [...STEPS.slice(0, -1), { ...STEPS[STEPS.length - 1], title: "Ready to try it?",
    body: "The demo shop is already set up. You'll get a list of demo sign-ins to keep: you sign in with one of them.", cta: { label: "Show demo sign-ins", onClick: () => setLogins(true) } }], [credentials]);
  if (credentials === undefined) return null;
  if (logins) return html`<${DemoLogins} credentials=${credentials} />`;
  return html`<${TourProvider} steps=${steps} getRoot=${getRoot} onClose=${() => (credentials ? setLogins(true) : window.location.assign("/signup.html"))}><${Screen} /><//>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
