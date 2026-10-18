const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { notify } = require("./kitchen");
const { priceCart, normalizeDiscount, cents, dollars } = require("./pricing");
const { codeHash } = require("./giftcard");
const { verifyOverride, findStaff, staffRules } = require("./override");
const { requirePermission, grantApproval, checkApproval, releaseApproval, spendApproval, giftAllowed, giftFailed, giftOk } = require("./session");

const PERM_USE_REGISTER = 1;
const PERM_APPROVE_DISCOUNTS = 4;
const METHODS = { cash: 1, card: 2, gift: 3 };

const router = express.Router();
router.use("/register", requirePermission(PERM_USE_REGISTER));

const thousandths = (s) => Math.round(parseFloat(s) * 1000);

router.get("/register/catalog", async (req, res) => {
  const { businessId, locationId } = req.session;
  const [rows] = await pool.query(
    `SELECT p.ProductID, p.Name, c.Name AS Category, v.VariantID, v.Name AS VariantName, v.SKU, v.Price,
            (EXISTS (SELECT 1 FROM VariantRecipe vr WHERE vr.VariantID = v.VariantID)
             AND NOT EXISTS (SELECT 1 FROM VariantRecipe vr
                               LEFT JOIN Inventory i ON i.StockItemID = vr.StockItemID AND i.LocationID = ?
                              WHERE vr.VariantID = v.VariantID AND COALESCE(i.Quantity, 0) < vr.QuantityPerUnit)) AS Available
       FROM Product p
       LEFT JOIN Category c ON c.CategoryID = p.CategoryID AND c.Active
       JOIN ProductVariant v ON v.ProductID = p.ProductID AND v.Active
      WHERE p.BusinessID = ? AND p.Active AND NOT p.IsGiftCard
      ORDER BY p.Name, v.Price`,
    [locationId, businessId]
  );
  const [groups] = await pool.query(
    `SELECT pmg.ProductID, g.ModifierGroupID, g.Name AS GroupName, g.MinSelect, g.MaxSelect, g.DefaultModifierID,
            m.ModifierID, m.Name, m.PriceDelta
       FROM ProductModifierGroup pmg
       JOIN ModifierGroup g ON g.ModifierGroupID = pmg.ModifierGroupID AND g.Active
       JOIN Modifier m ON m.ModifierGroupID = g.ModifierGroupID AND m.Active
      WHERE pmg.BusinessID = ?
      ORDER BY pmg.SortOrder, g.Name, m.PriceDelta, m.Name`,
    [businessId]
  );
  const [promotions] = await pool.query(
    `SELECT PromotionID, Name FROM Promotion
      WHERE BusinessID = ? AND Active AND UTC_TIMESTAMP() BETWEEN StartsAt AND EndsAt ORDER BY Name`,
    [businessId]
  );

  const products = [];
  for (const r of rows) {
    let p = products.find((x) => x.id === r.ProductID);
    if (!p) {
      p = { id: r.ProductID, name: r.Name, category: r.Category, variants: [], groups: [] };
      for (const g of groups.filter((g) => g.ProductID === r.ProductID)) {
        let grp = p.groups.find((x) => x.id === g.ModifierGroupID);
        if (!grp) {
          grp = { id: g.ModifierGroupID, name: g.GroupName, min: g.MinSelect, max: g.MaxSelect, defaultId: g.DefaultModifierID, modifiers: [] };
          p.groups.push(grp);
        }
        grp.modifiers.push({ id: g.ModifierID, name: g.Name, deltaCents: cents(g.PriceDelta) });
      }
      products.push(p);
    }
    p.variants.push({ id: r.VariantID, name: r.VariantName, sku: r.SKU, priceCents: cents(r.Price), available: !!r.Available });
  }
  res.json({
    products,
    categories: [...new Set(products.map((p) => p.category).filter(Boolean))].sort(),
    promotions: promotions.map((p) => ({ id: p.PromotionID, name: p.Name })),
    staffRules: await staffRules(businessId),
  });
});

router.get("/register/member", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const [[m]] = await pool.query(
    `SELECT c.CustomerID, c.FirstName, c.LastName, t.Name AS Tier,
            COALESCE((SELECT SUM(PointsChange) FROM LoyaltyTransaction lt
                       WHERE lt.LoyaltyAccountID = la.LoyaltyAccountID), 0) AS Points
       FROM Customer c
       JOIN LoyaltyAccount la ON la.CustomerID = c.CustomerID AND la.Active
       JOIN MembershipTier t ON t.TierID = la.TierID
      WHERE c.BusinessID = ? AND c.Active
        AND (c.Email = ? OR REGEXP_REPLACE(c.Phone, '[^0-9]', '') = ?)`,
    [req.session.businessId, q, q.replace(/\D/g, "") || "#"]
  );
  if (!m) return res.status(404).json({ error: "No rewards member found." });
  res.json({ id: m.CustomerID, name: [m.FirstName, m.LastName].filter(Boolean).join(" "), tier: m.Tier, points: Number(m.Points) });
});

const clientView = (p) => ({
  lines: p.lines.map((l) => ({ key: l.key, unitCents: l.unitCents, lineCents: l.lineCents, discountCents: l.lineDiscountCents })),
  promotion: p.promotion,
  discount: p.discount && { reason: p.discount.reason },
  subtotalCents: p.subtotalCents,
  promotionCents: p.promotionCents,
  discountCents: p.discountCents,
  taxCents: p.taxCents,
  totalCents: p.totalCents,
  taxRates: p.taxRates,
});

router.post("/register/price", async (req, res) => {
  res.json(clientView(await priceCart(pool, req.session, req.body)));
});

// Checks the manager's credentials and the discount's terms; the approval is only good for these terms
router.post("/register/discount/authorize", async (req, res) => {
  const terms = normalizeDiscount(req.body.discount);
  if (!terms) throw new HttpError(400, "Enter the discount details.");
  // A staff discount names the employee and needs no manager, unless the business has turned that rule on
  const staff = terms.reason === "Employee";
  const staffId = staff ? await findStaff(req.session, String(req.body.employeeNumber)) : null;
  // A staff discount bigger than the business's limit needs a manager too
  let needsManager = !staff;
  if (staff) {
    const rules = await staffRules(req.session.businessId);
    const priced = await priceCart(pool, req.session, { items: req.body.items, promotionId: req.body.promotionId, discount: terms });
    needsManager = rules.needsApproval || priced.discountCents * 100 > rules.maxPercent * priced.subtotalCents;
  }
  const approverId = needsManager
    ? await verifyOverride(req.session, String(req.body.managerNumber), String(req.body.managerPin), [PERM_APPROVE_DISCOUNTS])
    : null;
  res.json({ approvalToken: grantApproval(req.session, terms, approverId, staffId), terms });
});

// Stock a line uses per unit sold: its recipe, minus what substitutions swap out, plus additions (thousandths)
async function components(conn, line) {
  const [recipe] = await conn.query("SELECT StockItemID, QuantityPerUnit FROM VariantRecipe WHERE VariantID = ?", [line.variantId]);
  const used = new Map(recipe.map((r) => [r.StockItemID, thousandths(r.QuantityPerUnit)]));
  const modIds = line.modifiers.map((m) => m.id);
  if (modIds.length) {
    const [subs] = await conn.query("SELECT FromStockItemID, ToStockItemID FROM ModifierSubstitution WHERE ModifierID IN (?)", [modIds]);
    for (const s of subs) {
      if (!used.has(s.FromStockItemID)) continue;
      const amount = used.get(s.FromStockItemID);
      used.delete(s.FromStockItemID);
      if (s.ToStockItemID) used.set(s.ToStockItemID, (used.get(s.ToStockItemID) || 0) + amount);
    }
    const [adds] = await conn.query("SELECT StockItemID, Quantity FROM ModifierAddition WHERE ModifierID IN (?)", [modIds]);
    for (const a of adds) used.set(a.StockItemID, (used.get(a.StockItemID) || 0) + thousandths(a.Quantity));
  }
  return [...used].map(([stockItemId, perUnit]) => [stockItemId, perUnit * line.quantity]);
}

// The same steps the dev seed takes: open the order, add lines, record stock used, total it, pay, complete
router.post("/register/orders", async (req, res) => {
  const { employeeId, businessId, locationId, registerId } = req.session;
  const { payment = {}, customerId } = req.body;
  const methodCode = METHODS[payment.method];
  if (!methodCode) throw new HttpError(400, "Choose a payment method.");
  if (!registerId) throw new HttpError(409, "No register is available at your location.");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const priced = await priceCart(conn, req.session, req.body);
    if (req.body.promotionId && !priced.promotion.applies) throw new HttpError(400, "The promotion doesn't apply to this order.");

    let approval = null;
    if (priced.discount) {
      approval = checkApproval(req.session, String(req.body.approvalToken), priced.discount);
      if (!approval) throw new HttpError(403, "The discount approval has expired or no longer matches. Remove it and apply it again.");
    }
    if (customerId) {
      const [[c]] = await conn.query("SELECT 1 AS ok FROM Customer WHERE CustomerID = ? AND BusinessID = ? AND Active", [String(customerId), businessId]);
      if (!c) throw new HttpError(400, "That rewards member isn't available.");
    }
    const tipCents = methodCode === 2 ? Math.round(Number(payment.tip || 0) * 100) : 0;
    if (!Number.isInteger(tipCents) || tipCents < 0 || tipCents > 1000000) throw new HttpError(400, "Enter a valid tip.");
    if (tipCents && priced.totalCents === 0) throw new HttpError(400, "A tip needs a payment: this sale totals $0.00."); // the tip lives on the payment row
    let giftCardId = null;
    if (methodCode === 3) {
      if (!giftAllowed(req.session)) throw new HttpError(429, "Too many wrong gift card codes. Try again in a few minutes.");
      const [[g]] = await conn.query("SELECT GiftCardID FROM GiftCard WHERE BusinessID = ? AND CodeHash = ? AND Active",
        [businessId, codeHash(String(payment.giftCardCode || "").trim())]);
      if (!g) {
        giftFailed(req.session);
        throw new HttpError(400, "Gift card not found.");
      }
      giftCardId = g.GiftCardID;
      giftOk(req.session);
    }

    const orderId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO Orders (OrderID, LocationID, BusinessID, RegisterID, EmployeeID, CustomerID, ChannelCode)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [orderId, locationId, businessId, registerId, employeeId, customerId || null]
    );

    const sale = new Map(); // stock item -> thousandths used across the whole order
    for (const l of priced.lines) {
      const itemId = crypto.randomUUID();
      await conn.query(
        `INSERT INTO OrderItem (OrderItemID, OrderID, VariantID, BusinessID, Quantity, UnitPrice, LineTotal,
                                DiscountAmount, TaxCategoryID, TaxRate, TaxAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [itemId, orderId, l.variantId, businessId, l.quantity, dollars(l.unitCents), dollars(l.lineCents),
         dollars(l.lineDiscountCents), l.taxCategoryId, l.rate, dollars(l.taxCents)]
      );
      for (const m of l.modifiers)
        await conn.query("INSERT INTO OrderItemModifier (OrderItemID, ModifierID, BusinessID, PriceDelta) VALUES (?, ?, ?, ?)",
          [itemId, m.id, businessId, dollars(m.deltaCents)]);

      const used = await components(conn, l);
      const [costs] = await conn.query(
        `SELECT i.StockItemID, i.AverageUnitCost, s.StockUnitCode, s.Name
           FROM Inventory i JOIN StockItem s ON s.StockItemID = i.StockItemID
          WHERE i.LocationID = ? AND i.StockItemID IN (?)`,
        [locationId, used.map(([id]) => id)]
      );
      for (const [stockItemId, t] of used) {
        const c = costs.find((x) => x.StockItemID === stockItemId);
        if (!c || c.AverageUnitCost == null) throw new HttpError(409, `${l.productName} can't be sold: no stock cost is recorded here.`);
        await conn.query(
          `INSERT INTO OrderItemComponent (OrderItemID, StockItemID, BusinessID, QuantityUsed, StockUnitCode, UnitCost)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [itemId, stockItemId, businessId, (t / 1000).toFixed(3), c.StockUnitCode, c.AverageUnitCost]
        );
        sale.set(stockItemId, { t: (sale.get(stockItemId)?.t || 0) + t, cost: c.AverageUnitCost });
      }
      // The DB checks a line's cost equals its components' cost, so it computes both itself
      await conn.query(
        `UPDATE OrderItem oi
            SET oi.UnitCost = (SELECT ROUND(SUM(c.QuantityUsed * c.UnitCost) / oi.Quantity, 6)
                                 FROM OrderItemComponent c WHERE c.OrderItemID = oi.OrderItemID),
                oi.LineCost = ROUND(oi.Quantity * oi.UnitCost, 6)
          WHERE oi.OrderItemID = ?`,
        [itemId]
      );
    }
    for (const [stockItemId, { t, cost }] of sale)
      await conn.query(
        `INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                           QuantityChange, UnitCost, TransactionTypeCode, OrderID)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, 2, ?)`,
        [businessId, stockItemId, locationId, employeeId, (-t / 1000).toFixed(3), cost, orderId]
      );

    if (priced.promotionCents > 0)
      await conn.query(
        "INSERT INTO PromotionRedemption (BusinessID, RedemptionID, PromotionID, OrderID, DiscountAmount) VALUES (?, UUID(), ?, ?, ?)",
        [businessId, priced.promotion.id, orderId, dollars(priced.promotionCents)]
      );
    if (priced.discountCents > 0) {
      const d = priced.discount;
      await conn.query(
        "INSERT INTO OrderDiscount (OrderDiscountID, OrderID, BusinessID, Amount, Reason, ApprovedByEmployeeID, StaffEmployeeID) VALUES (UUID(), ?, ?, ?, ?, ?, ?)",
        [orderId, businessId, dollars(priced.discountCents), d.note ? `${d.reason}: ${d.note}` : d.reason, approval.approverId, approval.staffId]
      );
    }

    await conn.query("UPDATE Orders SET Subtotal = ?, DiscountAmount = ?, Tax = ?, Total = ? WHERE OrderID = ?",
      [dollars(priced.subtotalCents), dollars(priced.promotionCents + priced.discountCents), dollars(priced.taxCents), dollars(priced.totalCents), orderId]);
    if (priced.totalCents > 0)
      await conn.query(
        `INSERT INTO Payment (PaymentID, OrderID, PaymentMethodCode, Amount, TipAmount, TipLockedAt, PaymentStatusCode, GiftCardID)
         VALUES (UUID(), ?, ?, ?, ?, ${tipCents ? "UTC_TIMESTAMP()" : "NULL"}, 3, ?)`,
        [orderId, methodCode, dollars(priced.totalCents), dollars(tipCents), giftCardId]
      );
    // Paid and confirmed: the kitchen makes it, and it is completed when handed over (server/kitchen.js)
    await conn.query("UPDATE Orders SET OrderStatusCode = 2 WHERE OrderID = ?", [orderId]);
    await conn.query(
      `INSERT INTO OrderStatusHistory (OrderStatusHistoryID, OrderID, BusinessID, OrderStatusCode, ChangedAt, ChangedByEmployeeID)
       SELECT UUID(), OrderID, BusinessID, 1, OrderDateTime, EmployeeID FROM Orders WHERE OrderID = ?
       UNION ALL
       SELECT UUID(), OrderID, BusinessID, 2, UTC_TIMESTAMP(), EmployeeID FROM Orders WHERE OrderID = ?`,
      [orderId, orderId]
    );
    const [[{ OrderNumber }]] = await conn.query("SELECT OrderNumber FROM Orders WHERE OrderID = ?", [orderId]);
    await conn.commit();
    notify(locationId);
    spendApproval(req.session, String(req.body.approvalToken));
    res.json({ orderNumber: OrderNumber, totalCents: priced.totalCents, tipCents });
  } catch (err) {
    await conn.rollback();
    releaseApproval(req.session, String(req.body.approvalToken));
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = router;
