async function api(path, body) {
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
