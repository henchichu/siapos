// Icons are the wireframe's own SVGs, named after the tile: "My shift" -> my-shift.svg
const iconOf = (name) => `/img/home/${name.toLowerCase().replace(/ /g, "-")}.svg`;

// One independent card. Sign out is a button that ends the session; every other card is a link.
function Tile({ name }) {
  const icon = html`<span className="icon"><img src=${iconOf(name)} alt="" /></span>`;
  if (name === "Sign out") return html`<button className="tile" onClick=${signOut}>${icon}<span>${name}</span></button>`;
  return html`<a className="tile" href=${hrefOf(name)}>${icon}<span>${name}</span></a>`;
}

function App() {
  const me = useMe();
  return html`<main className="home">
    <header className="bar">
      <h1>Home</h1>
      <p>${me && [me.registerName, me.locationName].filter(Boolean).join(" - ")}</p>
    </header>
    <nav className="grid" aria-label="Modules">${(me?.tiles || []).map((name) => html`<${Tile} key=${name} name=${name} />`)}</nav>
  </main>`;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
