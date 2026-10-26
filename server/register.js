const crypto = require("crypto");
const express = require("express");
const pool = require("./database/connection");
const { HttpError } = require("./errors");
const { notify } = require("./watchers");
const { priceCart, normalizeDiscount, cents, dollars } = require("./pricing");
const { codeHash } = require("./giftcard");
const { addOrderLines, fingerprint } = require("./orderlines");
const { charge } = require("./mockpay");
const kioskOrders = require("./kioskorders");
const check = require("./validate");
const { verifyOverride, findStaff, staffRules } = require("./override");
const { requirePermission, grantApproval, checkApproval, releaseApproval, spendApproval, giftAllowed, giftFailed, giftOk } = require("./session");

const PERM_USE_REGISTER = 1;
const PERM_APPROVE_DISCOUNTS = 4;
const METHODS = { cash: 1, card: 2, gift: 3, apple: 5, google: 6 };
const PROCESSED = { 2: "card", 5: "apple", 6: "google" }; // paid through the (mock) processor, and may carry a tip

const router = express.Router();
router.use("/register", requirePermission(PERM_USE_REGISTER));

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
        AND (c.Email = ? OR c.PhoneDigits = ?)`,
    [req.session.businessId, q, q.replace(/\D/g, "").slice(-10) || "#"]
  );
  if (!m) return res.status(404).json({ error: "No rewards member found." });
  res.json({ id: m.CustomerID, name: [m.FirstName, m.LastName].filter(Boolean).join(" "), tier: m.Tier, points: Number(m.Points) });
});

// Kiosk orders waiting to be paid at the counter: the cashier takes the cash, or cancels the order and its stock goes back
router.get("/register/kiosk-orders", async (req, res) => res.json({ orders: await kioskOrders.pendingAt(req.session.locationId), holdMinutes: kioskOrders.HOLD_MINUTES }));
router.post("/register/kiosk-orders/:id/pay", async (req, res) => { await kioskOrders.pay(req.session, String(req.params.id)); res.json({ ok: true }); });
router.post("/register/kiosk-orders/:id/cancel", async (req, res) => { await kioskOrders.cancelAt(req.session, String(req.params.id)); res.json({ ok: true }); });

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

// The same steps the dev seed takes: open the order, add lines, record stock used, total it, pay, complete.
// The page sends a saleId with each sale. A second request with the same saleId and the same contents (the first reply
// was lost, so the cashier pressed again) gets the first receipt instead of a second sale.
// shortcut: remembered per sign-in, in memory; a sale repeated after signing in again isn't recognised.
const SALES_KEPT = 50;
router.post("/register/orders", async (req, res) => {
  const { sales } = req.session;
  const id = String(req.body.saleId || "");
  const contents = fingerprint({ ...req.body, saleId: undefined });
  let sale = id && sales.get(id)?.contents === contents ? sales.get(id).receipt : null;
  if (!sale) {
    sale = completeSale(req);
    if (id) {
      sales.set(id, { contents, receipt: sale });
      sale.catch(() => sales.get(id)?.receipt === sale && sales.delete(id)); // a sale that failed can be tried again
      if (sales.size > SALES_KEPT) sales.delete(sales.keys().next().value);
    }
  }
  res.json(await sale);
});

async function completeSale(req) {
  const { employeeId, businessId, locationId, registerId } = req.session;
  const { payment = {}, customerId } = req.body;
  const methodCode = METHODS[payment.method];
  if (!methodCode) throw new HttpError(400, "Choose a payment method.");
  if (!registerId) throw new HttpError(409, "No register is available at your location.");

  let receipt;
  try {
    receipt = await pool.tx(async (conn) => {
      const priced = await priceCart(conn, req.session, req.body);
      if (req.body.promotionId && !priced.promotion.applies) throw new HttpError(400, "The promotion doesn't apply to this order.");

      let approval = null;
      if (priced.discount) {
        approval = checkApproval(req.session, String(req.body.approvalToken), priced.discount);
        if (!approval) throw new HttpError(403, "The discount approval has expired or no longer matches. Remove it and apply it again.");
      }
      if (customerId) {
        // a deactivated membership can't be used at the register, even though the customer is still on file
        const [[c]] = await conn.query(
          "SELECT 1 AS ok FROM Customer c JOIN LoyaltyAccount la ON la.CustomerID = c.CustomerID AND la.Active WHERE c.CustomerID = ? AND c.BusinessID = ? AND c.Active",
          [String(customerId), businessId]);
        if (!c) throw new HttpError(400, "That rewards member isn't available.");
      }
      const tipCents = PROCESSED[methodCode] ? check.tipCents(payment.tip) : 0;
      if (tipCents && priced.totalCents === 0) throw new HttpError(400, "A tip needs a payment: this sale totals $0.00."); // the tip lives on the payment row
      let giftCardId = null;
      if (methodCode === 3) {
        const code = check.giftCode(payment.giftCardCode); // a mistyped format isn't a guess, so it doesn't count against the limit
        if (!giftAllowed(req.session)) throw new HttpError(429, "Too many wrong gift card codes. Try again in a few minutes.");
        const [[g]] = await conn.query("SELECT GiftCardID FROM GiftCard WHERE BusinessID = ? AND CodeHash = ? AND Active",
          [businessId, codeHash(code)]);
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

      await addOrderLines(conn, { orderId, businessId, locationId, employeeId, priced,
        unavailable: (l) => `${l.productName} can't be sold: no stock cost is recorded here.` });

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
      // Charged last, after every write that can still fail, so a refused sale never leaves a charge behind.
      // shortcut: a deadlock reruns this, charging again; harmless for the mock, a real processor needs an idempotency key
      if (PROCESSED[methodCode] && priced.totalCents > 0) charge(PROCESSED[methodCode], payment.card);
      return { orderNumber: OrderNumber, totalCents: priced.totalCents, tipCents };
    }, () => releaseApproval(req.session, String(req.body.approvalToken))); // a deadlock reruns the sale, which takes the approval again
  } catch (err) {
    releaseApproval(req.session, String(req.body.approvalToken));
    throw err;
  }
  notify(locationId);
  spendApproval(req.session, String(req.body.approvalToken));
  return receipt;
}

module.exports = router;
