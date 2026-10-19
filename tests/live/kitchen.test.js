// Needs the dev database. Sells a coffee at Campus, then walks it through the kitchen. Adds test data to the dev DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, unlock, topUp } = require("./env");

let env;
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const find = (tickets, queue, number) => tickets.body.queues[queue].find((t) => t.number === number);

test.before(async () => { env = await start(); await topUp("stk-oat", 3000); }); // the sale below uses oat milk
test.after(async () => { env.server.close(); await pool.end(); });

test("a sale reaches the kitchen, moves New -> Preparing -> Ready -> picked up, and only then can be refunded", async () => {
  const priya = await signIn("10420004", "444444");
  const jordan = await signIn("10420005", "555555");
  const leo = await signIn("10420002", "222222");

  const sale = await priya.call("/register/orders", { items: [{ key: "a", variantId: "var-latte-s", quantity: 1, modifierIds: ["mod-oat"] }], payment: { method: "cash" } });
  assert.equal(sale.status, 200);
  const n = sale.body.orderNumber;

  let t = await jordan.call("/kitchen/tickets");
  const ticket = find(t, "new", n);
  assert.ok(ticket, "new sale shows in New");
  assert.deepEqual(ticket.items[0], { quantity: 1, name: "Latte", size: "Small 12 oz", options: ["Oat milk"] });
  assert.equal(t.body.canPickUp, false);

  assert.equal((await priya.call("/refunds/order?q=" + n)).status, 409, "not refundable before it is picked up");
  assert.equal((await priya.call(`/kitchen/orders/${ticket.id}/start`, {})).status, 403, "a server can see the screen but not start tickets");

  assert.equal((await jordan.call(`/kitchen/orders/${ticket.id}/start`, {})).status, 200);
  assert.equal((await jordan.call(`/kitchen/orders/${ticket.id}/start`, {})).status, 409, "can't start twice");
  t = await jordan.call("/kitchen/tickets");
  assert.equal(find(t, "preparing", n).statusBy, "Jordan");
  assert.equal((await jordan.call(`/kitchen/orders/${ticket.id}/pickup`, {})).status, 403, "baristas don't mark pickups");
  assert.equal((await jordan.call(`/kitchen/orders/${ticket.id}/ready`, {})).status, 200);
  assert.ok(find(await jordan.call("/kitchen/tickets"), "ready", n));

  assert.equal((await leo.call(`/kitchen/orders/${ticket.id}/pickup`, {})).status, 200);
  assert.ok(!find(await jordan.call("/kitchen/tickets"), "ready", n), "picked-up tickets leave the screen");
  assert.equal((await priya.call("/refunds/order?q=" + n)).status, 200);
});

test("report a loss: written to the ledger, listed today, refused for a bad amount or too much", async () => {
  const jordan = await signIn("10420005", "555555");
  const before = await jordan.call("/kitchen/losses");
  const milk = before.body.stock.find((s) => s.name === "Whole milk");
  assert.equal(milk.unit, "ml");
  const loss = (body) => jordan.call("/kitchen/losses", { stockItemId: milk.id, reason: "spoiled", ...body });

  assert.equal((await loss({ amount: "250", note: " Past date " })).status, 200);
  const after = await jordan.call("/kitchen/losses");
  assert.equal(after.body.losses.length, before.body.losses.length + 1);
  // other screens (the inventory tests) report losses too, so look for this one rather than the newest
  assert.ok(after.body.losses.some((l) => l.item === "Whole milk" && l.amount === 250 && l.unit === "ml" && l.reason === "Spoiled or expired" && l.by === "Jordan"));

  assert.equal((await loss({ amount: "0" })).status, 400);
  assert.equal((await loss({ amount: "5", reason: "stolen" })).status, 400);
  assert.equal((await loss({ amount: "99999" })).status, 409, "more than is on hand is refused by the database");
  const croissant = before.body.stock.find((s) => s.name === "Butter croissant");
  if (croissant) assert.equal((await jordan.call("/kitchen/losses", { stockItemId: croissant.id, reason: "broken", amount: "1.5" })).status, 400, "whole units only");
});

test("the kitchen stream tells an open screen when a sale or a ticket move happens", async () => {
  const priya = await signIn("10420004", "444444");
  const jordan = await signIn("10420005", "555555");
  const abort = new AbortController();
  const res = await fetch(env.base + "/api/kitchen/stream", { headers: { cookie: jordan.cookie() }, signal: abort.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader();
  const next = async () => { let text = ""; while (!text.includes("data: changed")) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); } return text; };

  const sale = await priya.call("/register/orders", { items: [{ key: "a", variantId: "var-croissant", quantity: 1 }], payment: { method: "cash" } });
  assert.match(await next(), /data: changed/, "a sale pushes");
  const t = await jordan.call("/kitchen/tickets");
  await jordan.call(`/kitchen/orders/${find(t, "new", sale.body.orderNumber).id}/start`, {});
  assert.match(await next(), /data: changed/, "a ticket move pushes");
  abort.abort();
});
