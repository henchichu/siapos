const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { hasPermission } = require("./pin");
const { requirePermission } = require("./session");

const PERM_SEE = 11;   // See products and prices
const PERM_EDIT = 12;  // Edit products, prices and options
const PERM_COSTS = 13; // See costs and margins
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "../uploads");
const PHOTO_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const PHOTO_MAGIC = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] };

const router = express.Router();
const see = requirePermission(PERM_SEE);
const edit = requirePermission(PERM_EDIT);
const uuid = () => crypto.randomUUID();

// ---- small validators -------------------------------------------------------------------------------------------

const text = (v, label, max, required = true) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw new HttpError(400, `Enter the ${label}.`);
  if (s.length > max) throw new HttpError(400, `The ${label} is too long.`);
  return s;
};
const money = (v, label) => {
  const n = Number(v);
  if (v === "" || v == null || !Number.isFinite(n) || n < 0 || n > 100000 || Math.round(n * 100) / 100 !== n) throw new HttpError(400, `Enter a valid ${label}.`);
  return n;
};
const signedMoney = (v) => {
  const n = Number(v === "" || v == null ? 0 : v);
  if (!Number.isFinite(n) || Math.abs(n) > 10000 || Math.round(n * 100) / 100 !== n) throw new HttpError(400, "Enter a valid price change.");
  return n;
};
const quantity = (v) => {
  const n = Number(v);
  if (!(n > 0) || n > 1000000 || Math.round(n * 1000) / 1000 !== n) throw new HttpError(400, "Enter a quantity above zero.");
  return n;
};
const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(String))] : []);

const owns = async (db, sql, params, message) => {
  const [[row]] = await db.query(sql, params);
  if (!row) throw new HttpError(404, message);
  return row;
};

async function categoryOrNull(businessId, id) {
  if (!id) return null;
  await owns(pool, "SELECT 1 AS ok FROM Category WHERE CategoryID = ? AND BusinessID = ? AND Active", [String(id), businessId], "Choose a category from the list.");
  return String(id);
}

// ---- Products ---------------------------------------------------------------------------------------------------

// Cost to make one: the recipe at today's average stock cost here; null when there is no recipe or a line has no cost yet
const COSTS_SQL = `
  SELECT v.ProductID AS productId, v.Price AS price,
         (SELECT COUNT(*) FROM VariantRecipe vr WHERE vr.VariantID = v.VariantID) AS recipeLines,
         (SELECT COUNT(*) FROM VariantRecipe vr JOIN Inventory i ON i.StockItemID = vr.StockItemID AND i.LocationID = ?
           WHERE vr.VariantID = v.VariantID AND i.AverageUnitCost IS NOT NULL) AS costed,
         (SELECT SUM(vr.QuantityPerUnit * i.AverageUnitCost) FROM VariantRecipe vr JOIN Inventory i ON i.StockItemID = vr.StockItemID AND i.LocationID = ?
           WHERE vr.VariantID = v.VariantID) AS cost
    FROM ProductVariant v WHERE v.BusinessID = ? AND v.Active ORDER BY v.Price`;

router.get("/products/list", see, async (req, res) => {
  const { businessId, locationId, employeeId } = req.session;
  const [rows] = await pool.query(
    `SELECT p.ProductID AS id, p.Name AS name, p.Description AS description, p.ImageKey AS imageKey, p.Active AS active,
            p.CategoryID AS categoryId, c.Name AS category,
            (SELECT COUNT(*) FROM ProductVariant v WHERE v.ProductID = p.ProductID AND v.Active) AS sizes,
            (SELECT MIN(v.Price) FROM ProductVariant v WHERE v.ProductID = p.ProductID AND v.Active) AS priceFrom,
            EXISTS (SELECT 1 FROM ProductVariant v WHERE v.ProductID = p.ProductID AND v.Active
                      AND EXISTS (SELECT 1 FROM VariantRecipe vr WHERE vr.VariantID = v.VariantID)
                      AND NOT EXISTS (SELECT 1 FROM VariantRecipe vr
                                        LEFT JOIN Inventory i ON i.StockItemID = vr.StockItemID AND i.LocationID = ?
                                       WHERE vr.VariantID = v.VariantID AND COALESCE(i.Quantity, 0) < vr.QuantityPerUnit)) AS inStock
       FROM Product p LEFT JOIN Category c ON c.CategoryID = p.CategoryID
      WHERE p.BusinessID = ? AND NOT p.IsGiftCard ORDER BY p.Name`,
    [locationId, businessId]
  );
  const [categories] = await pool.query("SELECT CategoryID AS id, Name AS name FROM Category WHERE BusinessID = ? AND Active ORDER BY Name", [businessId]);
  const [skus] = await pool.query("SELECT ProductID AS productId, SKU AS sku FROM ProductVariant WHERE BusinessID = ? AND Active", [businessId]);

  const canCosts = await hasPermission(pool, employeeId, PERM_COSTS);
  const cheapest = new Map();
  if (canCosts) {
    const [costs] = await pool.query(COSTS_SQL, [locationId, locationId, businessId]);
    for (const c of costs) if (!cheapest.has(c.productId)) cheapest.set(c.productId, c);
  }
  res.json({
    canEdit: await hasPermission(pool, employeeId, PERM_EDIT),
    canCosts,
    categories,
    products: rows.map((r) => {
      const c = cheapest.get(r.id);
      const cost = c && c.recipeLines > 0 && c.costed === c.recipeLines ? Math.round(Number(c.cost) * 100) / 100 : null;
      const price = r.priceFrom == null ? null : Number(r.priceFrom);
      return {
        id: r.id, name: r.name, description: r.description, category: r.category, categoryId: r.categoryId, hasPhoto: !!r.imageKey,
        skus: skus.filter((k) => k.productId === r.id).map((k) => k.sku), sizes: r.sizes, priceFrom: price, active: !!r.active, available: !!r.active && !!r.inStock,
        cost: canCosts ? cost : undefined,
        margin: canCosts && cost != null && price ? Math.round(((price - cost) / price) * 100) : canCosts ? null : undefined,
      };
    }),
  });
});

const productFields = async (req) => ({
  name: text(req.body.name, "name", 150),
  description: text(req.body.description, "description", 5000, false) || null,
  categoryId: await categoryOrNull(req.session.businessId, req.body.categoryId),
  active: req.body.active !== false,
});

router.post("/products", edit, async (req, res) => {
  const f = await productFields(req);
  const id = uuid();
  await pool.query("INSERT INTO Product (ProductID, BusinessID, Name, Description, CategoryID, Active) VALUES (?, ?, ?, ?, ?, ?)",
    [id, req.session.businessId, f.name, f.description, f.categoryId, f.active]);
  res.json({ id });
});

router.post("/products/:id", edit, async (req, res) => {
  const f = await productFields(req);
  const [r] = await pool.query("UPDATE Product SET Name = ?, Description = ?, CategoryID = ?, Active = ? WHERE ProductID = ? AND BusinessID = ? AND NOT IsGiftCard",
    [f.name, f.description, f.categoryId, f.active, req.params.id, req.session.businessId]);
  if (!r.affectedRows) throw new HttpError(404, "Product not found.");
  res.json({ id: req.params.id });
});

router.post("/products/:id/active", edit, async (req, res) => {
  const [r] = await pool.query("UPDATE Product SET Active = ? WHERE ProductID = ? AND BusinessID = ? AND NOT IsGiftCard",
    [req.body.active ? 1 : 0, req.params.id, req.session.businessId]);
  if (!r.affectedRows) throw new HttpError(404, "Product not found.");
  res.json({ ok: true });
});

// The picture is stored on disk and only its key is in the database
router.post("/products/:id/photo", edit, express.raw({ type: Object.keys(PHOTO_TYPES), limit: "2mb" }), async (req, res) => {
  const ext = PHOTO_TYPES[(req.headers["content-type"] || "").split(";")[0]];
  const body = req.body;
  if (!ext || !Buffer.isBuffer(body) || !body.length) throw new HttpError(400, "Choose a PNG, JPEG or WebP picture up to 2 MB.");
  if (!PHOTO_MAGIC[ext].every((b, i) => body[i] === b)) throw new HttpError(400, "That file isn't a real picture.");
  const product = await owns(pool, "SELECT ImageKey FROM Product WHERE ProductID = ? AND BusinessID = ? AND NOT IsGiftCard", [req.params.id, req.session.businessId], "Product not found.");
  const key = `products/${req.params.id}.${ext}`;
  fs.mkdirSync(path.join(UPLOAD_DIR, "products"), { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, key), body);
  await pool.query("UPDATE Product SET ImageKey = ? WHERE ProductID = ?", [key, req.params.id]);
  if (product.ImageKey && product.ImageKey !== key) fs.rmSync(path.join(UPLOAD_DIR, product.ImageKey), { force: true }); // a PNG replaced by a JPEG leaves no orphan
  res.json({ ok: true });
});

router.get("/products/:id/photo", see, async (req, res) => {
  const row = await owns(pool, "SELECT ImageKey FROM Product WHERE ProductID = ? AND BusinessID = ? AND ImageKey IS NOT NULL", [req.params.id, req.session.businessId], "No photo.");
  res.sendFile(path.resolve(UPLOAD_DIR, row.ImageKey), (err) => { if (err && !res.headersSent) res.status(404).json({ error: "No photo." }); });
});

// ---- Sizes and recipes ------------------------------------------------------------------------------------------

router.get("/products/:id/sizes", edit, async (req, res) => {
  const { businessId, locationId } = req.session;
  await owns(pool, "SELECT 1 AS ok FROM Product WHERE ProductID = ? AND BusinessID = ? AND NOT IsGiftCard", [req.params.id, businessId], "Product not found.");
  const [sizes] = await pool.query(
    `SELECT v.VariantID AS id, v.Name AS name, v.SKU AS sku, v.Price AS price, v.TaxCategoryID AS taxCategoryId, t.Name AS taxCategory,
            v.RestockOnReturn AS restock, (SELECT COUNT(*) FROM VariantRecipe vr WHERE vr.VariantID = v.VariantID) AS recipeItems
       FROM ProductVariant v JOIN TaxCategory t ON t.TaxCategoryID = v.TaxCategoryID AND t.BusinessID = v.BusinessID
      WHERE v.ProductID = ? AND v.Active ORDER BY v.Price, v.Name`,
    [req.params.id]
  );
  const [taxCategories] = await pool.query("SELECT TaxCategoryID AS id, Name AS name FROM TaxCategory WHERE BusinessID = ? ORDER BY Name", [businessId]);
  const [stock] = await pool.query(
    `SELECT s.StockItemID AS id, s.Name AS name, u.Symbol AS unit, i.AverageUnitCost AS unitCost
       FROM StockItem s JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode
       LEFT JOIN Inventory i ON i.StockItemID = s.StockItemID AND i.LocationID = ?
      WHERE s.BusinessID = ? AND s.Active ORDER BY s.Name`,
    [locationId, businessId]
  );
  res.json({
    taxCategories,
    stock: stock.map((s) => ({ ...s, unitCost: s.unitCost == null ? null : Number(s.unitCost) })),
    sizes: sizes.map((s) => ({ ...s, price: Number(s.price), restock: !!s.restock })),
  });
});

const sizeFields = async (req) => {
  const tax = String(req.body.taxCategoryId || "");
  await owns(pool, "SELECT 1 AS ok FROM TaxCategory WHERE TaxCategoryID = ? AND BusinessID = ?", [tax, req.session.businessId], "Choose a tax category.");
  return { name: text(req.body.name, "size name", 100), sku: text(req.body.sku, "SKU", 100), price: money(req.body.price, "price"), tax, restock: req.body.restock ? 1 : 0 };
};

router.post("/products/:id/sizes", edit, async (req, res) => {
  const { businessId } = req.session;
  await owns(pool, "SELECT 1 AS ok FROM Product WHERE ProductID = ? AND BusinessID = ? AND NOT IsGiftCard", [req.params.id, businessId], "Product not found.");
  const f = await sizeFields(req);
  const id = uuid();
  await pool.query(
    "INSERT INTO ProductVariant (VariantID, ProductID, BusinessID, Name, SKU, Price, TaxCategoryID, RestockOnReturn) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, req.params.id, businessId, f.name, f.sku, f.price, f.tax, f.restock]
  );
  res.json({ id });
});

router.post("/sizes/:id", edit, async (req, res) => {
  const f = await sizeFields(req);
  const [r] = await pool.query(
    "UPDATE ProductVariant SET Name = ?, SKU = ?, Price = ?, TaxCategoryID = ?, RestockOnReturn = ? WHERE VariantID = ? AND BusinessID = ?",
    [f.name, f.sku, f.price, f.tax, f.restock, req.params.id, req.session.businessId]
  );
  if (!r.affectedRows) throw new HttpError(404, "Size not found.");
  res.json({ id: req.params.id });
});

router.get("/sizes/:id/recipe", edit, async (req, res) => {
  const { businessId } = req.session;
  await owns(pool, "SELECT 1 AS ok FROM ProductVariant WHERE VariantID = ? AND BusinessID = ?", [req.params.id, businessId], "Size not found.");
  const [lines] = await pool.query(
    `SELECT vr.StockItemID AS stockItemId, vr.QuantityPerUnit AS quantity FROM VariantRecipe vr
       JOIN StockItem s ON s.StockItemID = vr.StockItemID WHERE vr.VariantID = ? ORDER BY s.Name`,
    [req.params.id]
  );
  res.json({ lines: lines.map((l) => ({ stockItemId: l.stockItemId, quantity: Number(l.quantity) })) });
});

// The whole recipe is replaced at once, so what is saved is exactly the list on screen
router.post("/sizes/:id/recipe", edit, async (req, res) => {
  const { businessId } = req.session;
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  const seen = new Set();
  const clean = lines.map((l) => {
    const stockItemId = String(l.stockItemId);
    if (seen.has(stockItemId)) throw new HttpError(400, "Each stock item can appear once in a recipe.");
    seen.add(stockItemId);
    return [stockItemId, quantity(l.quantity)];
  });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await owns(conn, "SELECT 1 AS ok FROM ProductVariant WHERE VariantID = ? AND BusinessID = ? FOR UPDATE", [req.params.id, businessId], "Size not found.");
    for (const [stockItemId] of clean) await owns(conn, "SELECT 1 AS ok FROM StockItem WHERE StockItemID = ? AND BusinessID = ? AND Active", [stockItemId, businessId], "Choose stock items from the list.");
    await conn.query("DELETE FROM VariantRecipe WHERE VariantID = ?", [req.params.id]);
    for (const [stockItemId, qty] of clean)
      await conn.query("INSERT INTO VariantRecipe (VariantID, StockItemID, BusinessID, QuantityPerUnit) VALUES (?, ?, ?, ?)", [req.params.id, stockItemId, businessId, qty]);
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// ---- Option groups ----------------------------------------------------------------------------------------------

router.get("/option-groups", edit, async (req, res) => {
  const { businessId } = req.session;
  const [groups] = await pool.query("SELECT ModifierGroupID AS id, Name AS name, MinSelect AS min, MaxSelect AS max FROM ModifierGroup WHERE BusinessID = ? AND Active ORDER BY Name", [businessId]);
  const [mods] = await pool.query("SELECT ModifierID AS id, ModifierGroupID AS groupId, Name AS name, PriceDelta AS priceDelta FROM Modifier WHERE BusinessID = ? AND Active ORDER BY Name", [businessId]);
  const [adds] = await pool.query("SELECT ModifierID AS id, StockItemID AS stockItemId, Quantity AS quantity FROM ModifierAddition WHERE BusinessID = ?", [businessId]);
  const [subs] = await pool.query("SELECT ModifierID AS id, FromStockItemID AS fromId, ToStockItemID AS toId FROM ModifierSubstitution WHERE BusinessID = ?", [businessId]);
  const [offered] = await pool.query("SELECT ModifierGroupID AS groupId, ProductID AS productId FROM ProductModifierGroup WHERE BusinessID = ?", [businessId]);
  const [products] = await pool.query("SELECT ProductID AS id, Name AS name FROM Product WHERE BusinessID = ? AND Active AND NOT IsGiftCard ORDER BY Name", [businessId]);
  const [stock] = await pool.query("SELECT s.StockItemID AS id, s.Name AS name, u.Symbol AS unit FROM StockItem s JOIN UnitOfMeasure u ON u.UnitCode = s.StockUnitCode WHERE s.BusinessID = ? AND s.Active ORDER BY s.Name", [businessId]);

  const effect = (id) => {
    const a = adds.find((x) => x.id === id), s = subs.find((x) => x.id === id);
    if (a) return { type: "add", stockItemId: a.stockItemId, quantity: Number(a.quantity) };
    if (s) return s.toId ? { type: "swap", fromId: s.fromId, toId: s.toId } : { type: "remove", stockItemId: s.fromId };
    return { type: "none" };
  };
  res.json({
    products, stock,
    groups: groups.map((g) => ({
      ...g,
      productIds: offered.filter((o) => o.groupId === g.id).map((o) => o.productId),
      options: mods.filter((m) => m.groupId === g.id).map((m) => ({ id: m.id, name: m.name, priceDelta: Number(m.priceDelta), effect: effect(m.id) })),
    })),
  });
});

async function writeEffect(conn, businessId, modifierId, e) {
  await conn.query("DELETE FROM ModifierAddition WHERE ModifierID = ?", [modifierId]);
  await conn.query("DELETE FROM ModifierSubstitution WHERE ModifierID = ?", [modifierId]);
  if (!e || e.type === "none") return;
  const stock = (id) => owns(conn, "SELECT 1 AS ok FROM StockItem WHERE StockItemID = ? AND BusinessID = ? AND Active", [String(id), businessId], "Choose stock items from the list.");
  if (e.type === "add") {
    await stock(e.stockItemId);
    await conn.query("INSERT INTO ModifierAddition (ModifierID, StockItemID, BusinessID, Quantity) VALUES (?, ?, ?, ?)", [modifierId, String(e.stockItemId), businessId, quantity(e.quantity)]);
  } else if (e.type === "remove") {
    await stock(e.stockItemId);
    await conn.query("INSERT INTO ModifierSubstitution (ModifierID, FromStockItemID, ToStockItemID, BusinessID) VALUES (?, ?, NULL, ?)", [modifierId, String(e.stockItemId), businessId]);
  } else if (e.type === "swap") {
    await stock(e.fromId); await stock(e.toId);
    if (e.fromId === e.toId) throw new HttpError(400, "A swap needs two different stock items.");
    await conn.query("INSERT INTO ModifierSubstitution (ModifierID, FromStockItemID, ToStockItemID, BusinessID) VALUES (?, ?, ?, ?)", [modifierId, String(e.fromId), String(e.toId), businessId]);
  } else throw new HttpError(400, "Choose adds, swaps or removes.");
}

async function saveGroup(req, res, groupId) {
  const { businessId } = req.session;
  const name = text(req.body.name, "group name", 100);
  const min = Number(req.body.min === "" || req.body.min == null ? 0 : req.body.min);
  const max = req.body.max === "" || req.body.max == null ? null : Number(req.body.max);
  if (!Number.isInteger(min) || min < 0 || min > 255) throw new HttpError(400, "Fewest choices must be a whole number.");
  if (max !== null && (!Number.isInteger(max) || max < 1 || max < min || max > 255)) throw new HttpError(400, "Most choices must be at least 1 and at least the fewest.");
  const options = Array.isArray(req.body.options) ? req.body.options : [];
  if (new Set(options.map((o) => String(o.name || "").trim().toLowerCase())).size !== options.length) throw new HttpError(400, "Each option needs its own name.");
  if (min > options.length) throw new HttpError(400, "Fewest choices can't be more than the number of options, or the product could never be sold.");
  const productIds = ids(req.body.productIds);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of productIds) await owns(conn, "SELECT 1 AS ok FROM Product WHERE ProductID = ? AND BusinessID = ? AND NOT IsGiftCard", [p, businessId], "Choose products from the list.");
    let id = groupId;
    if (id) {
      await owns(conn, "SELECT 1 AS ok FROM ModifierGroup WHERE ModifierGroupID = ? AND BusinessID = ? FOR UPDATE", [id, businessId], "Group not found.");
      await conn.query("UPDATE ModifierGroup SET Name = ?, MinSelect = ?, MaxSelect = ? WHERE ModifierGroupID = ?", [name, min, max, id]);
    } else {
      id = uuid();
      await conn.query("INSERT INTO ModifierGroup (ModifierGroupID, BusinessID, Name, MinSelect, MaxSelect) VALUES (?, ?, ?, ?, ?)", [id, businessId, name, min, max]);
    }

    // Options that no longer appear are switched off, not deleted: past orders point at them. They go first, and get
    // a suffix on their name, so another option can take the name they held (names are unique within a group).
    const [existing] = await conn.query("SELECT ModifierID AS id, Name AS name FROM Modifier WHERE ModifierGroupID = ?", [id]);
    const claimed = new Set(options.map((o) => o.id).filter((oid) => existing.some((x) => x.id === oid)));
    const plan = options.map((o) => {
      const oName = text(o.name, "option name", 100);
      const match = existing.find((x) => x.id === o.id) || existing.find((x) => !claimed.has(x.id) && x.name.toLowerCase() === oName.toLowerCase());
      return { o, oName, delta: signedMoney(o.priceDelta), mid: match?.id };
    });
    const keep = new Set(plan.map((p) => p.mid).filter(Boolean));
    const gone = existing.filter((x) => !keep.has(x.id)).map((x) => x.id);
    if (gone.length) {
      await conn.query("UPDATE ModifierGroup SET DefaultModifierID = NULL WHERE ModifierGroupID = ? AND DefaultModifierID IN (?)", [id, gone]);
      await conn.query("UPDATE Modifier SET Active = FALSE, Name = IF(Name LIKE '% [off %]', Name, LEFT(CONCAT(Name, ' [off ', LEFT(ModifierID, 8), ']'), 100)) WHERE ModifierID IN (?)", [gone]);
    }
    // Kept options step aside first, so names can be swapped or passed between options without a clash
    if (keep.size) await conn.query("UPDATE Modifier SET Name = CONCAT('~', ModifierID) WHERE ModifierID IN (?)", [[...keep]]);
    for (const { o, oName, delta, mid: found } of plan) {
      let mid = found;
      if (mid) await conn.query("UPDATE Modifier SET Name = ?, PriceDelta = ?, Active = TRUE WHERE ModifierID = ?", [oName, delta, mid]);
      else { mid = uuid(); await conn.query("INSERT INTO Modifier (ModifierID, ModifierGroupID, BusinessID, Name, PriceDelta) VALUES (?, ?, ?, ?, ?)", [mid, id, businessId, oName, delta]); }
      await writeEffect(conn, businessId, mid, o.effect);
    }

    // Offered on exactly the chosen products
    await conn.query(`DELETE FROM ProductModifierGroup WHERE ModifierGroupID = ? ${productIds.length ? "AND ProductID NOT IN (?)" : ""}`, productIds.length ? [id, productIds] : [id]);
    for (const p of productIds)
      await conn.query("INSERT IGNORE INTO ProductModifierGroup (ProductID, ModifierGroupID, BusinessID) VALUES (?, ?, ?)", [p, id, businessId]);
    await conn.commit();
    res.json({ id });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
router.post("/option-groups", edit, (req, res) => saveGroup(req, res, null));
router.post("/option-groups/:id", edit, (req, res) => saveGroup(req, res, req.params.id));

// ---- Promotions -------------------------------------------------------------------------------------------------

const PERCENT = 1, FIXED = 2;
const DAY = (col) => `DATE_FORMAT(CONVERT_TZ(${col}, '+00:00', l.TimeZone), '%Y-%m-%d')`;

router.get("/promotions", edit, async (req, res) => {
  const { businessId, locationId } = req.session;
  const [rows] = await pool.query(
    `SELECT p.PromotionID AS id, p.Name AS name, p.DiscountTypeCode AS type, p.DiscountValue AS value, ${DAY("p.StartsAt")} AS starts, ${DAY("p.EndsAt")} AS ends,
            p.Active AS active,
            CASE WHEN NOT p.Active OR p.EndsAt < UTC_TIMESTAMP() THEN 'Ended' WHEN p.StartsAt > UTC_TIMESTAMP() THEN 'Scheduled' ELSE 'Running' END AS status
       FROM Promotion p JOIN Location l ON l.LocationID = ? WHERE p.BusinessID = ? ORDER BY p.StartsAt DESC, p.Name`,
    [locationId, businessId]
  );
  const [links] = await pool.query("SELECT PromotionID AS promotionId, ProductID AS productId FROM PromotionProduct WHERE BusinessID = ?", [businessId]);
  const [products] = await pool.query("SELECT ProductID AS id, Name AS name FROM Product WHERE BusinessID = ? AND Active AND NOT IsGiftCard ORDER BY Name", [businessId]);
  res.json({
    products,
    promotions: rows.map((r) => ({ ...r, active: !!r.active, kind: r.type === PERCENT ? "percent" : "amount", value: Number(r.value), productIds: links.filter((l) => l.promotionId === r.id).map((l) => l.productId) })),
  });
});

const DATE = /^\d{4}-\d\d-\d\d$/;
async function savePromotion(req, res, promotionId) {
  const { businessId, locationId } = req.session;
  const name = text(req.body.name, "name", 100);
  const type = req.body.kind === "amount" ? FIXED : PERCENT;
  const value = Number(req.body.value);
  if (!(value > 0) || Math.round(value * 100) / 100 !== value || value > 100000) throw new HttpError(400, "Enter a discount value above zero.");
  if (type === PERCENT && value > 100) throw new HttpError(400, "A percentage can't be more than 100.");
  const { starts, ends } = req.body;
  if (!DATE.test(starts) || !DATE.test(ends)) throw new HttpError(400, "Choose a start and end date.");
  if (ends < starts) throw new HttpError(400, "The promotion can't end before it starts.");
  const productIds = ids(req.body.productIds);
  if (!productIds.length) throw new HttpError(400, "Choose at least one product.");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of productIds) await owns(conn, "SELECT 1 AS ok FROM Product WHERE ProductID = ? AND BusinessID = ? AND NOT IsGiftCard", [p, businessId], "Choose products from the list.");
    const [[{ tz }]] = await conn.query("SELECT TimeZone AS tz FROM Location WHERE LocationID = ?", [locationId]);
    // runs from the start of the first day to the end of the last, café time
    const at = (d, time) => [`${d} ${time}`, tz];
    let id = promotionId;
    if (id) {
      await owns(conn, "SELECT 1 AS ok FROM Promotion WHERE PromotionID = ? AND BusinessID = ? FOR UPDATE", [id, businessId], "Promotion not found.");
      await conn.query(
        "UPDATE Promotion SET Name = ?, DiscountTypeCode = ?, DiscountValue = ?, StartsAt = CONVERT_TZ(?, ?, '+00:00'), EndsAt = CONVERT_TZ(?, ?, '+00:00') WHERE PromotionID = ?",
        [name, type, value, ...at(starts, "00:00:00"), ...at(ends, "23:59:59"), id]
      );
    } else {
      id = uuid();
      await conn.query(
        "INSERT INTO Promotion (PromotionID, BusinessID, Name, DiscountTypeCode, DiscountValue, StartsAt, EndsAt) VALUES (?, ?, ?, ?, ?, CONVERT_TZ(?, ?, '+00:00'), CONVERT_TZ(?, ?, '+00:00'))",
        [id, businessId, name, type, value, ...at(starts, "00:00:00"), ...at(ends, "23:59:59")]
      );
    }
    await conn.query("DELETE FROM PromotionProduct WHERE PromotionID = ?", [id]);
    for (const p of productIds) await conn.query("INSERT INTO PromotionProduct (PromotionID, ProductID, BusinessID) VALUES (?, ?, ?)", [id, p, businessId]);
    await conn.commit();
    res.json({ id });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
router.post("/promotions", edit, (req, res) => savePromotion(req, res, null));
router.post("/promotions/:id", edit, (req, res) => savePromotion(req, res, req.params.id));

// Ending switches it off now (a promotion that hasn't started yet is cancelled the same way). Editing never switches it back on; Activate does.
const setPromotionActive = (active) => async (req, res) => {
  const [r] = await pool.query("UPDATE Promotion SET Active = ? WHERE PromotionID = ? AND BusinessID = ?", [active, req.params.id, req.session.businessId]);
  if (!r.affectedRows) throw new HttpError(404, "Promotion not found.");
  res.json({ ok: true });
};
router.post("/promotions/:id/end", edit, setPromotionActive(false));
router.post("/promotions/:id/activate", edit, setPromotionActive(true));

module.exports = router;
