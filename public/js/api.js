// The front-page tour shows these pages at /tour/<page>.html on recorded sample data (js/tour-demo.json, made by tests/live/capture-tour-data.js):
// nothing reaches the server, and nothing can be saved. Times in the recording are moved forward so the sample looks like today.
const DEMO = window.location.pathname.startsWith("/tour/");
const demoData = DEMO ? fetch("/js/tour-demo.json").then((r) => r.json()) : null;
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d/, ISO_DAY = /^\d{4}-\d\d-\d\d$/;
const moved = (v, ms) => Array.isArray(v) ? v.map((x) => moved(x, ms))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, moved(x, ms)]))
  : typeof v === "string" && ISO_TIME.test(v) ? new Date(Date.parse(v) + ms).toISOString()
  : typeof v === "string" && ISO_DAY.test(v) ? new Date(Date.parse(v) + Math.round(ms / 864e5) * 864e5).toISOString().slice(0, 10) : v;
async function demoApi(path, body) {
  if (body !== undefined) throw new Error("This is a sample: nothing is saved here.");
  const { capturedAt, responses } = await demoData;
  const key = `GET ${path.split("?")[0]}`;
  if (!(key in responses)) throw new Error("This part isn't in the sample.");
  return moved(responses[key], Date.now() - Date.parse(capturedAt));
}

async function api(path, body) {
  if (DEMO) return demoApi(path, body);
  const res = await fetch(`/api${path}`, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Not signed in.");
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

const money = (cents) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const fromDollars = (dollars) => money(Math.round(dollars * 100));
const when = (iso, tz) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }) : "");
const dayOf = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const clock = (iso, tz) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz }) : "");
