const { HttpError } = require("./errors");

const REASONS = ["Regular", "Employee", "Complaint", "Damaged"];
const cents = (decimalString) => Math.round(parseFloat(decimalString) * 100);
const dollars = (c) => (c / 100).toFixed(2);

// Splits `total` across lines in proportion to their caps; shares sum to total and never pass a cap
function allocate(total, caps) {
  const sum = caps.reduce((a, b) => a + b, 0);
  total = Math.min(total, sum);
  if (total <= 0) return caps.map(() => 0);
  const shares = caps.map((c) => Math.floor((total * c) / sum));
  let rest = total - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0; i = (i + 1) % caps.length) {
    if (shares[i] < caps[i]) {
      shares[i]++;
      rest--;
    }
  }
  return shares;
}

// Integer maths that matches the DB's ROUND(... , 2) and CK_OrderItem_TaxAmount exactly
function taxCents(baseCents, rate, pricesIncludeTax) {
  const ppm = Math.round(parseFloat(rate) * 1e6);
  const den = pricesIncludeTax ? 1e6 + ppm : 1e6;
  return Math.floor((2 * baseCents * ppm + den) / (2 * den));
}

// The one-off discount's terms in one canonical shape, so an approval can be tied to exactly these terms
function normalizeDiscount(d) {
  if (!d) return null;
  const value = Number(d.value);
  const keys = Array.isArray(d.keys) ? [...new Set(d.keys.map(String))].sort() : [];
  const note = String(d.note || "").trim();
  if (!["order", "selected"].includes(d.applyTo)) throw new HttpError(400, "Choose what the discount applies to.");
  if (!["percent", "amount"].includes(d.type)) throw new HttpError(400, "Choose a discount type.");
  if (!REASONS.includes(d.reason)) throw new HttpError(400, "Choose a reason.");
  if (!(value > 0) || !Number.isFinite(value)) throw new HttpError(400, "Enter a discount value above zero.");
  if (d.type === "percent" && value > 100) throw new HttpError(400, "A percent discount can't be over 100.");
  if (d.applyTo === "selected" && !keys.length) throw new HttpError(400, "Select at least one item.");
  if (note.length > 255) throw new HttpError(400, "The note can be 255 characters at most.");
  return {
    applyTo: d.applyTo,
    type: d.type,
    value: Math.round(value * 100) / 100,
    reason: d.reason,
    note,
    keys: d.applyTo === "selected" ? keys : [],
  };
}

// Prices a cart from the database; nothing is trusted from the client but variant, option ids and quantities
async function priceCart(db, session, body) {
  const items = body.items;
  if (!Array.isArray(items) || !items.length || items.length > 50) throw new HttpError(400, "The order has no items.");
  const keys = items.map((i) => String(i.key));
  if (new Set(keys).size !== keys.length) throw new HttpError(400, "Duplicate order lines.");

  const [[biz]] = await db.query("SELECT PricesIncludeTax FROM Business WHERE BusinessID = ?", [session.businessId]);
  const [variants] = await db.query(
    `SELECT v.VariantID, v.Name, v.Price, v.TaxCategoryID, v.ProductID, p.Name AS ProductName, r.Rate
       FROM ProductVariant v
       JOIN Product p ON p.ProductID = v.ProductID AND p.BusinessID = v.BusinessID
       LEFT JOIN LocationTaxRate r ON r.LocationID = ? AND r.TaxCategoryID = v.TaxCategoryID
      WHERE v.VariantID IN (?) AND v.BusinessID = ? AND v.Active AND p.Active AND NOT p.IsGiftCard`,
    [session.locationId, items.map((i) => String(i.variantId)), session.businessId]
  );
  const variantById = Object.fromEntries(variants.map((v) => [v.VariantID, v]));

  const [offered] = await db.query(
    `SELECT pmg.ProductID, g.ModifierGroupID, g.MinSelect, g.MaxSelect, m.ModifierID, m.Name, m.PriceDelta
       FROM ProductModifierGroup pmg
       JOIN ModifierGroup g ON g.ModifierGroupID = pmg.ModifierGroupID AND g.Active
       JOIN Modifier m ON m.ModifierGroupID = g.ModifierGroupID AND m.Active
      WHERE pmg.ProductID IN (?)`,
    [variants.map((v) => v.ProductID).concat("none")]
  );

  const lines = items.map((item) => {
    const v = variantById[item.variantId];
    const quantity = Number(item.quantity);
    if (!v) throw new HttpError(400, "An item in the order isn't available.");
    if (v.Rate == null) throw new HttpError(409, `No tax rate is set for ${v.ProductName} at this location.`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new HttpError(400, "Quantity must be 1 to 99.");

    const rows = offered.filter((o) => o.ProductID === v.ProductID);
    const chosenIds = [...new Set((item.modifierIds || []).map(String))];
    const modifiers = chosenIds.map((id) => {
      const m = rows.find((o) => o.ModifierID === id);
      if (!m) throw new HttpError(400, `${v.ProductName} doesn't offer that option.`);
      return { id, groupId: m.ModifierGroupID, name: m.Name, deltaCents: cents(m.PriceDelta) };
    });
    for (const gid of new Set(rows.map((o) => o.ModifierGroupID))) {
      const g = rows.find((o) => o.ModifierGroupID === gid);
      const n = modifiers.filter((m) => m.groupId === gid).length;
      if (n < g.MinSelect || n > (g.MaxSelect ?? 255)) throw new HttpError(400, `Check the options chosen for ${v.ProductName}.`);
    }

    const unitCents = cents(v.Price) + modifiers.reduce((a, m) => a + m.deltaCents, 0);
    if (unitCents < 0) throw new HttpError(400, "An item can't have a negative price.");
    return {
      key: String(item.key),
      variantId: v.VariantID,
      productId: v.ProductID,
      productName: v.ProductName,
      variantName: v.Name,
      taxCategoryId: v.TaxCategoryID,
      rate: v.Rate,
      quantity,
      modifiers,
      unitCents,
      lineCents: unitCents * quantity,
      promoCents: 0,
      discountCents: 0,
    };
  });

  // Promotion first, then the manager-approved one-off on what is left of each line
  let promotion = null;
  if (body.promotionId) {
    const [[p]] = await db.query(
      `SELECT PromotionID, Name, DiscountTypeCode, DiscountValue FROM Promotion
        WHERE PromotionID = ? AND BusinessID = ? AND Active AND UTC_TIMESTAMP() BETWEEN StartsAt AND EndsAt`,
      [String(body.promotionId), session.businessId]
    );
    if (!p) throw new HttpError(400, "That promotion isn't running.");
    const [pp] = await db.query("SELECT ProductID FROM PromotionProduct WHERE PromotionID = ?", [p.PromotionID]);
    const eligible = lines.filter((l) => !pp.length || pp.some((r) => r.ProductID === l.productId));
    const base = eligible.reduce((a, l) => a + l.lineCents, 0);
    const wanted = p.DiscountTypeCode === 1 ? Math.round((base * parseFloat(p.DiscountValue)) / 100) : cents(p.DiscountValue);
    const shares = allocate(wanted, eligible.map((l) => l.lineCents));
    eligible.forEach((l, i) => (l.promoCents = shares[i]));
    promotion = { id: p.PromotionID, name: p.Name, applies: base > 0 };
  }

  const discount = normalizeDiscount(body.discount);
  if (discount) {
    const eligible = lines.filter((l) => discount.applyTo === "order" || discount.keys.includes(l.key));
    if (!eligible.length) throw new HttpError(400, "Select at least one item that is in the order.");
    const caps = eligible.map((l) => l.lineCents - l.promoCents);
    const base = caps.reduce((a, b) => a + b, 0);
    const wanted = discount.type === "percent" ? Math.round((base * discount.value) / 100) : Math.round(discount.value * 100);
    if (wanted > base) throw new HttpError(400, "The discount is more than the items it applies to.");
    allocate(wanted, caps).forEach((s, i) => (eligible[i].discountCents = s));
  }

  for (const l of lines) {
    l.lineDiscountCents = l.promoCents + l.discountCents;
    l.taxCents = taxCents(l.lineCents - l.lineDiscountCents, l.rate, !!biz.PricesIncludeTax);
  }
  const sum = (f) => lines.reduce((a, l) => a + f(l), 0);
  const subtotalCents = sum((l) => l.lineCents);
  const promotionCents = sum((l) => l.promoCents);
  const discountCents = sum((l) => l.discountCents);
  const tax = sum((l) => l.taxCents);
  return {
    lines,
    promotion,
    discount,
    pricesIncludeTax: !!biz.PricesIncludeTax,
    subtotalCents,
    promotionCents,
    discountCents,
    taxCents: tax,
    totalCents: subtotalCents - promotionCents - discountCents + (biz.PricesIncludeTax ? 0 : tax),
    taxRates: [...new Set(lines.map((l) => (parseFloat(l.rate) * 100).toFixed(2).replace(/\.?0+$/, "")))],
  };
}

module.exports = { priceCart, normalizeDiscount, allocate, taxCents, REASONS, cents, dollars };
