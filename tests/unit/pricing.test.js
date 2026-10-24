// Runs without a database: priceCart gets a fake `db` that answers the three lookups it makes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { priceCart, allocate, taxCents, normalizeDiscount } = require("../../server/pricing");

const variants = [
  { VariantID: "v1", Name: "Regular", Price: "3.50", TaxCategoryID: "t1", ProductID: "p1", ProductName: "Croissant", Rate: "0.102500" },
  { VariantID: "v2", Name: "Regular", Price: "16.00", TaxCategoryID: "t2", ProductID: "p2", ProductName: "Beans", Rate: "0.022500" },
];
const db = {
  query: async (sql) => {
    if (sql.includes("FROM Business")) return [[{ PricesIncludeTax: 0 }]];
    if (sql.includes("FROM ProductVariant")) return [variants];
    if (sql.includes("ProductModifierGroup")) return [[]];
    throw new Error("unexpected query: " + sql.slice(0, 40));
  },
};
const session = { businessId: "b", locationId: "l" };
const cart = [
  { key: "a", variantId: "v1", quantity: 2 },
  { key: "b", variantId: "v2", quantity: 1 },
];

test("tax is worked out per line, in whole cents, like the database", async () => {
  const p = await priceCart(db, session, { items: cart });
  assert.equal(p.subtotalCents, 2300);
  assert.equal(p.taxCents, 72 + 36); // 7.00 x 10.25% = 0.7175 -> 72c; 16.00 x 2.25% = 0.36
  assert.equal(p.totalCents, 2300 + 108);
});

test("a percent discount is split over the lines without losing or adding a cent", async () => {
  const discount = { applyTo: "order", type: "percent", value: 10, reason: "Regular" };
  const p = await priceCart(db, session, { items: cart, discount });
  assert.equal(p.discountCents, 230);
  assert.equal(p.lines.reduce((a, l) => a + l.discountCents, 0), 230);
  assert.equal(p.totalCents, 2300 - 230 + p.taxCents);
});

test("a discount can't be bigger than the items it applies to", async () => {
  const discount = { applyTo: "selected", keys: ["a"], type: "amount", value: 7.01, reason: "Regular" };
  await assert.rejects(priceCart(db, session, { items: cart, discount }), /more than the items/);
});

test("the client can't pick its own price or an unknown item", async () => {
  await assert.rejects(priceCart(db, session, { items: [{ key: "a", variantId: "nope", quantity: 1 }] }), /isn't available/);
  await assert.rejects(priceCart(db, session, { items: [{ key: "a", variantId: "v1", quantity: 0 }] }), /Quantity/);
});

test("allocate and taxCents edge cases", () => {
  const split = allocate(100, [333, 333, 334]);
  assert.equal(split.reduce((a, b) => a + b, 0), 100); // the odd cent lands somewhere, none is lost
  assert.ok(split.every((c, i) => c <= [333, 333, 334][i]));
  assert.deepEqual(allocate(50, [10]), [10]); // never more than the cap
  assert.equal(taxCents(630, "0.102500", false), 65); // 64.575 rounds up
  assert.equal(taxCents(1100, "0.100000", true), 100); // tax already inside the price
});

test("discount terms are checked", () => {
  assert.throws(() => normalizeDiscount({ applyTo: "order", type: "percent", value: 101, reason: "Regular" }), /over 100/);
  assert.throws(() => normalizeDiscount({ applyTo: "order", type: "percent", value: 5, reason: "Nope" }), /reason/);
  assert.throws(() => normalizeDiscount({ applyTo: "selected", type: "amount", value: 5, reason: "Regular", keys: [] }), /Select at least one/);
});
