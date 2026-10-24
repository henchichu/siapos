// Needs the dev database. Creates its own product, size, option group and promotions (they stay in the dev DB, switched off or ended at the end).
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { start, client, pool, removeCatalog } = require("./env");

let env, leo, sam, jordan, stamp;
const created = { products: [], groups: [], promotions: [] }; // removed again at the end
const signIn = async (number, pin) => { const c = client(env.base); const r = await c.call("/login/pin", { employeeNumber: number, pin }); assert.equal(r.status, 200); return c; };
const page = (c, path) => fetch(env.base + path, { headers: { cookie: c.cookie() }, redirect: "manual" });
// smallest valid PNG: the 8-byte signature plus a header, enough for the magic-byte check
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a9d6b7f50000000049454e44ae426082", "hex");
const upload = (c, id, body, type) => fetch(`${env.base}/api/products/${id}/photo`, { method: "POST", headers: { cookie: c.cookie(), "content-type": type }, body });

test.before(async () => {
  env = await start();
  leo = await signIn("10420002", "222222"); sam = await signIn("10420003", "333333"); jordan = await signIn("10420005", "555555");
  stamp = Date.now().toString(36);
});
test.after(async () => { await removeCatalog(created); env.server.close(); await pool.end(); });

test("who sees which Products view", async () => {
  const server = await sam.call("/products/list");
  assert.equal(server.status, 200);
  assert.equal(server.body.canEdit, false);
  assert.ok(server.body.products.length > 0 && server.body.products.every((p) => p.cost === undefined && p.margin === undefined), "a server sees no costs");
  assert.ok(!server.body.products.some((p) => p.name === "Gift card"), "gift cards aren't catalog products");
  assert.equal((await sam.call("/products", { name: "x" })).status, 403);
  assert.equal((await sam.call("/option-groups")).status, 403);
  assert.equal((await sam.call("/promotions")).status, 403);
  assert.equal((await jordan.call("/products/list")).status, 403, "a barista has no Products access");
  assert.equal((await page(jordan, "/products.html")).headers.get("location"), "/kitchen.html");
  assert.equal((await page(sam, "/products.html")).status, 200);

  const manager = await leo.call("/products/list");
  assert.equal(manager.body.canEdit, true);
  assert.equal(manager.body.canCosts, true);
  const latte = manager.body.products.find((p) => p.name === "Latte");
  assert.equal(latte.sizes, 2);
  assert.equal(latte.priceFrom, 4.25);
  assert.equal(latte.available, true);
  assert.ok(latte.cost > 0 && Number.isInteger(latte.margin));
  assert.ok(latte.skus.length === 2);
});

test("products: add, edit, deactivate, photo", async () => {
  const name = `Test cookie ${stamp}`;
  assert.equal((await leo.call("/products", { name: "  ", categoryId: "cat-bakery" })).status, 400);
  assert.equal((await leo.call("/products", { name, categoryId: "no-such" })).status, 404);
  const made = await leo.call("/products", { name, description: "Chewy", categoryId: "cat-bakery", active: true });
  assert.equal(made.status, 200);
  const id = made.body.id;
  created.products.push(id);
  const find = async () => (await leo.call("/products/list")).body.products.find((p) => p.id === id);

  assert.equal((await find()).available, false, "no sizes or recipe yet, so not available");
  assert.equal((await leo.call(`/products/${id}`, { name: `${name} XL`, description: "", categoryId: "cat-bakery", active: true })).status, 200);
  assert.equal((await find()).name, `${name} XL`);
  assert.equal((await leo.call(`/products/${id}/active`, { active: false })).status, 200);
  assert.equal((await find()).active, false);
  assert.equal((await leo.call(`/products/${id}/active`, { active: true })).status, 200);

  assert.equal((await upload(leo, id, Buffer.from("not an image at all"), "image/png")).status, 400, "bytes must match the type");
  assert.equal((await upload(leo, id, Buffer.from("hello"), "text/plain")).status, 400);
  assert.equal((await upload(leo, id, PNG, "image/png")).status, 200);
  assert.equal((await find()).hasPhoto, true);
  const photo = await fetch(`${env.base}/api/products/${id}/photo`, { headers: { cookie: sam.cookie() } });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/png");
  assert.equal((await upload(sam, id, PNG, "image/png")).status, 403);
  // replacing the PNG with a JPEG removes the PNG file
  const dir = path.join(__dirname, "../../uploads/products");
  assert.equal((await upload(leo, id, Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex"), "image/jpeg")).status, 200);
  assert.ok(fs.existsSync(path.join(dir, `${id}.jpg`)) && !fs.existsSync(path.join(dir, `${id}.png`)), "no orphan PNG left");
  global.productId = id;
});

test("sizes and recipes", async () => {
  const id = global.productId;
  const size = (body) => leo.call(`/products/${id}/sizes`, { name: "Regular", sku: `T-${stamp}`, price: "3.50", taxCategoryId: "tax-prepared", restock: true, ...body });
  assert.equal((await size({ price: "-1" })).status, 400);
  assert.equal((await size({ price: "3.555" })).status, 400);
  assert.equal((await size({ taxCategoryId: "nope" })).status, 404);
  const made = await size({});
  assert.equal(made.status, 200);
  assert.equal((await size({ name: "Large" })).status, 409, "SKU must be unique");

  let sizes = await leo.call(`/products/${id}/sizes`);
  assert.equal(sizes.body.sizes.length, 1);
  assert.equal(sizes.body.sizes[0].recipeItems, 0);
  assert.equal(sizes.body.sizes[0].restock, true);
  assert.equal((await leo.call(`/sizes/${made.body.id}`, { name: "Regular", sku: `T-${stamp}`, price: "3.75", taxCategoryId: "tax-prepared", restock: false })).status, 200);

  const recipe = (lines) => leo.call(`/sizes/${made.body.id}/recipe`, { lines });
  assert.equal((await recipe([{ stockItemId: "stk-croissant", quantity: 0 }])).status, 400);
  assert.equal((await recipe([{ stockItemId: "stk-croissant", quantity: 1 }, { stockItemId: "stk-croissant", quantity: 2 }])).status, 400, "one line per stock item");
  assert.equal((await recipe([{ stockItemId: "nope", quantity: 1 }])).status, 404);
  assert.equal((await recipe([{ stockItemId: "stk-croissant", quantity: 1 }, { stockItemId: "stk-cup-12", quantity: 2 }])).status, 200);
  const saved = (await leo.call(`/sizes/${made.body.id}/recipe`)).body.lines;
  assert.deepEqual(saved.map((l) => [l.stockItemId, l.quantity]).sort(), [["stk-croissant", 1], ["stk-cup-12", 2]]);

  sizes = await leo.call(`/products/${id}/sizes`);
  assert.equal(sizes.body.sizes[0].recipeItems, 2);
  assert.equal(sizes.body.sizes[0].price, 3.75);
  const listed = (await leo.call("/products/list")).body.products.find((p) => p.id === id);
  assert.equal(listed.sizes, 1);
  assert.equal(listed.priceFrom, 3.75);
  assert.ok(listed.cost > 0);
  assert.equal((await recipe([])).status, 200, "a recipe can be emptied");
});

test("option groups: options, stock effects, rules, offered products", async () => {
  const id = global.productId;
  const group = (body) => leo.call("/option-groups", { name: `Test group ${stamp}`, min: "0", max: "2", productIds: [id], options: [
    { name: "Vanilla test", priceDelta: "0.60", effect: { type: "add", stockItemId: "stk-vanilla", quantity: "5" } },
    { name: "Oat test", priceDelta: "0.75", effect: { type: "swap", fromId: "stk-milk", toId: "stk-oat" } },
    { name: "Plain", priceDelta: "0", effect: { type: "none" } }], ...body });
  assert.equal((await group({ min: "3", max: "2" })).status, 400, "most can't be below fewest");
  assert.equal((await group({ max: "0" })).status, 400);
  assert.equal((await group({ min: "4", max: "" })).status, 400, "fewest more than the 3 options would make the product unsellable");
  assert.equal((await group({ productIds: ["prd-giftcard"] })).status, 404, "gift cards take no options");
  assert.equal((await group({ options: [{ name: "A", priceDelta: "0", effect: { type: "swap", fromId: "stk-milk", toId: "stk-milk" } }] })).status, 400);
  const made = await group({});
  assert.equal(made.status, 200);
  created.groups.push(made.body.id);

  const find = async () => (await leo.call("/option-groups")).body.groups.find((g) => g.id === made.body.id);
  let g = await find();
  assert.equal(g.options.length, 3);
  assert.deepEqual(g.productIds, [id]);
  assert.deepEqual(g.options.find((o) => o.name === "Vanilla test").effect, { type: "add", stockItemId: "stk-vanilla", quantity: 5 });
  assert.deepEqual(g.options.find((o) => o.name === "Oat test").effect, { type: "swap", fromId: "stk-milk", toId: "stk-oat" });

  // rename one option onto the name of another that is being removed in the same save
  const oat = g.options.find((o) => o.name === "Oat test");
  const swapNames = await leo.call(`/option-groups/${made.body.id}`, { name: g.name, min: "0", max: "2", productIds: [id], options: [{ ...oat, name: "Vanilla test" }] });
  assert.equal(swapNames.status, 200, JSON.stringify(swapNames.body));
  g = await find();
  assert.deepEqual(g.options.map((o) => [o.name, o.effect.type]), [["Vanilla test", "swap"]], "the renamed option keeps its own effect");
  assert.equal((await leo.call(`/option-groups/${made.body.id}`, { name: g.name, min: "0", max: "2", productIds: [id], options: [
    { name: "Vanilla test", priceDelta: "0.60", effect: { type: "add", stockItemId: "stk-vanilla", quantity: "5" } },
    { id: oat.id, name: "Oat test", priceDelta: "0.75", effect: { type: "swap", fromId: "stk-milk", toId: "stk-oat" } }] })).status, 200);
  g = await find();
  // edit: drop Plain, change Vanilla to a removal, move the group to Latte as well
  const keep = g.options.filter((o) => o.name !== "Plain").map((o) => (o.name === "Vanilla test" ? { ...o, effect: { type: "remove", stockItemId: "stk-vanilla" } } : o));
  assert.equal((await leo.call(`/option-groups/${made.body.id}`, { name: g.name, min: "1", max: "", options: keep, productIds: [id, "prd-latte"] })).status, 200);
  g = await find();
  assert.deepEqual([g.min, g.max], [1, null]);
  assert.deepEqual(g.options.map((o) => o.name).sort(), ["Oat test", "Vanilla test"], "a removed option is switched off");
  assert.deepEqual(g.options.find((o) => o.name === "Vanilla test").effect, { type: "remove", stockItemId: "stk-vanilla" });
  assert.deepEqual(g.productIds.sort(), [id, "prd-latte"].sort());
  // taking the group off Latte again leaves the real catalog as it was
  assert.equal((await leo.call(`/option-groups/${made.body.id}`, { name: g.name, min: "1", max: "", options: g.options, productIds: [id] })).status, 200);
  assert.deepEqual((await find()).productIds, [id]);
});

test("promotions: validate, add, edit, end, show ended", async () => {
  const [[{ today }]] = await pool.query("SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', 'America/Chicago'), '%Y-%m-%d') AS today");
  const plus = async (n) => (await pool.query("SELECT DATE_FORMAT(? + INTERVAL ? DAY, '%Y-%m-%d') AS d", [today, n]))[0][0].d;
  const [week, later, later2] = [await plus(7), await plus(30), await plus(40)];
  const promo = (body) => leo.call("/promotions", { name: `Test promo ${stamp}`, kind: "percent", value: "15", starts: today, ends: week, productIds: [global.productId], ...body });

  assert.equal((await promo({ value: "150" })).status, 400, "percent over 100");
  assert.equal((await promo({ value: "0" })).status, 400);
  assert.equal((await promo({ ends: await plus(-1) })).status, 400, "ends before it starts");
  assert.equal((await promo({ productIds: [] })).status, 400);
  assert.equal((await promo({ productIds: ["prd-giftcard"] })).status, 404);
  assert.equal((await sam.call("/promotions", {})).status, 403);

  const running = await promo({});
  const scheduled = await promo({ name: `Test later ${stamp}`, kind: "amount", value: "2.50", starts: later, ends: later2 });
  assert.equal(running.status, 200);
  created.promotions.push(running.body.id, scheduled.body.id);
  const list = async () => (await leo.call("/promotions")).body.promotions;
  let rows = await list();
  const r = rows.find((p) => p.id === running.body.id), s = rows.find((p) => p.id === scheduled.body.id);
  assert.deepEqual([r.status, r.kind, r.value, r.starts, r.ends], ["Running", "percent", 15, today, week]);
  assert.deepEqual([s.status, s.kind, s.value], ["Scheduled", "amount", 2.5]);

  assert.equal((await leo.call(`/promotions/${running.body.id}`, { name: `Test promo ${stamp}!`, kind: "amount", value: "1", starts: today, ends: later, productIds: [global.productId, "prd-latte"] })).status, 200);
  const edited = (await list()).find((p) => p.id === running.body.id);
  assert.deepEqual([edited.name, edited.kind, edited.productIds.length], [`Test promo ${stamp}!`, "amount", 2]);

  assert.equal((await leo.call(`/promotions/${running.body.id}/end`, {})).status, 200);
  assert.equal((await leo.call(`/promotions/${scheduled.body.id}/end`, {})).status, 200);
  // editing a cancelled promotion must not bring it back; Activate does
  const sched = { name: `Test later ${stamp}`, kind: "amount", value: "2.50", starts: later, ends: later2, productIds: [global.productId] };
  assert.equal((await leo.call(`/promotions/${scheduled.body.id}`, { ...sched, name: `Test later ${stamp}!` })).status, 200);
  assert.equal((await list()).find((p) => p.id === scheduled.body.id).status, "Ended", "still cancelled after an edit");
  assert.equal((await leo.call(`/promotions/${scheduled.body.id}/activate`, {})).status, 200);
  assert.equal((await list()).find((p) => p.id === scheduled.body.id).status, "Scheduled");
  assert.equal((await leo.call(`/promotions/${scheduled.body.id}/end`, {})).status, 200);
  rows = await list();
  assert.equal(rows.find((p) => p.id === running.body.id).status, "Ended");
  assert.equal(rows.find((p) => p.id === scheduled.body.id).status, "Ended");
  const cat = await sam.call("/products/list"); // the register catalog only offers running promotions
  assert.equal(cat.status, 200);
});
