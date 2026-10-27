USE miniworld;

-- Cross-row and cross-table rules that CHECK constraints and foreign keys can't express.
-- Lookup codes used below are fixed by 02-seed.sql:
-- Every rule raises SQLSTATE '45000' with a readable MESSAGE_TEXT.

DELIMITER $$

-- Location: TimeZone must be a name MySQL can convert (tz tables are loaded at init)
CREATE PROCEDURE CheckLocationTimeZone(IN pTimeZone VARCHAR(64))
BEGIN
    IF CONVERT_TZ('2000-01-01 00:00:00', '+00:00', pTimeZone) IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Location.TimeZone is not a known timezone name';
    END IF;
END$$

CREATE TRIGGER TR_Location_BeforeInsert BEFORE INSERT ON Location FOR EACH ROW
BEGIN
    CALL CheckLocationTimeZone(NEW.TimeZone);
END$$

CREATE TRIGGER TR_Location_BeforeUpdate BEFORE UPDATE ON Location FOR EACH ROW
BEGIN
    CALL CheckLocationTimeZone(NEW.TimeZone);
END$$

-- Roles: the owner role can't lose its owner status or be deactivated, so a business keeps its owner
CREATE TRIGGER TR_Role_BeforeUpdate BEFORE UPDATE ON Role FOR EACH ROW
BEGIN
    IF NEW.IsOwner <> OLD.IsOwner THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A role''s owner status is fixed when it is created';
    END IF;

    IF OLD.IsOwner AND NOT NEW.Active THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The owner role cannot be deactivated';
    END IF;
END$$

-- True when the employee and their role are active and the role is the owner's or holds the permission
CREATE FUNCTION HasPermission(pEmployeeID CHAR(36), pPermissionCode TINYINT UNSIGNED) RETURNS BOOLEAN
READS SQL DATA
BEGIN
    RETURN EXISTS (SELECT 1
                     FROM Employee e JOIN Role r ON r.RoleID = e.RoleID
                    WHERE e.EmployeeID = pEmployeeID AND e.Active AND r.Active
                      AND (r.IsOwner OR EXISTS (SELECT 1 FROM RolePermission rp
                                                 WHERE rp.RoleID = r.RoleID
                                                   AND rp.PermissionCode = pPermissionCode)));
END$$

-- Inventory is driven by its ledger: Quantity and AverageUnitCost change only
-- when an InventoryTransaction is inserted, and ledger rows are immutable.
CREATE TRIGGER TR_Inventory_BeforeInsert BEFORE INSERT ON Inventory FOR EACH ROW
BEGIN
    IF NEW.Quantity <> 0 OR NEW.AverageUnitCost IS NOT NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'New Inventory rows start empty; add stock with a RESTOCK or ADJUSTMENT';
    END IF;
END$$

CREATE TRIGGER TR_Inventory_BeforeUpdate BEFORE UPDATE ON Inventory FOR EACH ROW
BEGIN
    IF (NEW.Quantity <> OLD.Quantity OR NOT (NEW.AverageUnitCost <=> OLD.AverageUnitCost))
       AND @siapos_ledger_write IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Inventory quantity and cost change only through InventoryTransaction';
    END IF;
END$$

-- Purchase orders are created in the same transaction as sales, counts and threshold changes.
-- Supplier, quoted cost and ordered quantity are saved at order time, not recomputed for display.
CREATE TRIGGER TR_Inventory_QueueInsert AFTER INSERT ON Inventory FOR EACH ROW
BEGIN
    IF NEW.ReorderThreshold > 0 AND NEW.Quantity <= NEW.ReorderThreshold THEN
        INSERT INTO PurchaseOrder (PurchaseOrderID, InventoryID, Quantity, SupplierID, UnitCost)
        SELECT UUID(), NEW.InventoryID,
               GREATEST(CEIL(2 * NEW.ReorderThreshold - NEW.Quantity), COALESCE(ss.MinOrderQty, 1)),
               ss.SupplierID, ss.UnitCost
          FROM StockItem s
          LEFT JOIN StockItemSupplier ss ON ss.StockItemID = s.StockItemID AND ss.SupplierID = (
              SELECT q.SupplierID FROM StockItemSupplier q JOIN Supplier sp ON sp.SupplierID = q.SupplierID AND sp.Active
               WHERE q.StockItemID = s.StockItemID ORDER BY q.IsPreferred DESC, sp.Name, q.SupplierID LIMIT 1)
         WHERE s.StockItemID = NEW.StockItemID AND s.Active
        ON DUPLICATE KEY UPDATE PurchaseOrderID = PurchaseOrderID;
    END IF;
END$$

CREATE TRIGGER TR_Inventory_QueueUpdate AFTER UPDATE ON Inventory FOR EACH ROW
BEGIN
    IF NEW.ReorderThreshold > 0 AND NEW.Quantity <= NEW.ReorderThreshold THEN
        INSERT INTO PurchaseOrder (PurchaseOrderID, InventoryID, Quantity, SupplierID, UnitCost)
        SELECT UUID(), NEW.InventoryID,
               GREATEST(CEIL(2 * NEW.ReorderThreshold - NEW.Quantity), COALESCE(ss.MinOrderQty, 1)),
               ss.SupplierID, ss.UnitCost
          FROM StockItem s
          LEFT JOIN StockItemSupplier ss ON ss.StockItemID = s.StockItemID AND ss.SupplierID = (
              SELECT q.SupplierID FROM StockItemSupplier q JOIN Supplier sp ON sp.SupplierID = q.SupplierID AND sp.Active
               WHERE q.StockItemID = s.StockItemID ORDER BY q.IsPreferred DESC, sp.Name, q.SupplierID LIMIT 1)
         WHERE s.StockItemID = NEW.StockItemID AND s.Active
        ON DUPLICATE KEY UPDATE PurchaseOrderID = PurchaseOrderID;
    END IF;
END$$

CREATE TRIGGER TR_InventoryTransaction_BeforeInsert BEFORE INSERT ON InventoryTransaction FOR EACH ROW
BEGIN
    DECLARE vQuantity DECIMAL(12,3);

    SELECT Quantity INTO vQuantity
      FROM Inventory
     WHERE LocationID = NEW.LocationID AND StockItemID = NEW.StockItemID
       FOR UPDATE;

    IF vQuantity + NEW.QuantityChange < 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Insufficient stock for this movement';
    END IF;
END$$

CREATE TRIGGER TR_InventoryTransaction_AfterInsert AFTER INSERT ON InventoryTransaction FOR EACH ROW
BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET @siapos_ledger_write = NULL;
        RESIGNAL;
    END;

    SET @siapos_ledger_write = 1;

    -- AverageUnitCost is assigned first so it still sees the old Quantity.
    -- Weighted average on stock coming in at a known cost (RESTOCK, or RETURN at its sale cost).
    UPDATE Inventory
       SET AverageUnitCost = CASE
               WHEN NEW.TransactionTypeCode IN (1, 3)
                    AND NEW.QuantityChange > 0
                    AND NEW.UnitCost IS NOT NULL THEN
                   CASE
                       WHEN Quantity <= 0 OR AverageUnitCost IS NULL THEN NEW.UnitCost
                       ELSE ROUND((Quantity * AverageUnitCost + NEW.QuantityChange * NEW.UnitCost)
                                  / (Quantity + NEW.QuantityChange), 6)
                   END
               ELSE AverageUnitCost
           END,
           Quantity = Quantity + NEW.QuantityChange
     WHERE LocationID = NEW.LocationID AND StockItemID = NEW.StockItemID;

    SET @siapos_ledger_write = NULL;
END$$

CREATE TRIGGER TR_InventoryTransaction_BeforeUpdate BEFORE UPDATE ON InventoryTransaction FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Inventory transactions are immutable; post an ADJUSTMENT instead';
END$$

CREATE TRIGGER TR_InventoryTransaction_BeforeDelete BEFORE DELETE ON InventoryTransaction FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Inventory transactions are immutable; post an ADJUSTMENT instead';
END$$

CREATE FUNCTION IsGiftCardVariant(pVariantID CHAR(36)) RETURNS BOOLEAN
READS SQL DATA
BEGIN
    RETURN EXISTS (SELECT 1 FROM ProductVariant v JOIN Product p ON p.ProductID = v.ProductID
                    WHERE v.VariantID = pVariantID AND p.IsGiftCard);
END$$

-- OrderItem: the variant must have a recipe (gift cards have none), and whole-unit variants sell in whole numbers
CREATE PROCEDURE CheckOrderItem(IN pVariantID CHAR(36), IN pQuantity DECIMAL(12,3))
BEGIN
    DECLARE vAllowsFraction BOOLEAN;

    IF NOT EXISTS (SELECT 1 FROM VariantRecipe WHERE VariantID = pVariantID)
       AND NOT IsGiftCardVariant(pVariantID) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This variant has no recipe, so it cannot be sold';
    END IF;

    SELECT u.AllowsFraction INTO vAllowsFraction
      FROM ProductVariant v
      JOIN UnitOfMeasure u ON u.UnitCode = v.SellUnitCode
     WHERE v.VariantID = pVariantID;

    IF NOT vAllowsFraction AND pQuantity <> FLOOR(pQuantity) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This variant is sold in whole units';
    END IF;
END$$

-- The line's tax category and rate must be the variant's category and the location's
-- current rate. Checked on insert, and on update only when those inputs change, so
-- editing an old line after a rate change doesn't fail.
CREATE PROCEDURE CheckOrderItemTax(IN pOrderID CHAR(36), IN pVariantID CHAR(36),
                                   IN pTaxCategoryID CHAR(36), IN pTaxRate DECIMAL(7,6))
BEGIN
    DECLARE vRate DECIMAL(7,6);

    IF NOT EXISTS (SELECT 1 FROM ProductVariant
                    WHERE VariantID = pVariantID AND TaxCategoryID = pTaxCategoryID) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tax category must match the variant''s tax category';
    END IF;

    SET vRate = (SELECT r.Rate
                   FROM Orders o
                   JOIN LocationTaxRate r ON r.LocationID = o.LocationID
                                         AND r.TaxCategoryID = pTaxCategoryID
                  WHERE o.OrderID = pOrderID);

    IF vRate IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No tax rate is set for this category at the order''s location';
    END IF;

    IF pTaxRate <> vRate THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tax rate must match the location''s rate for this category';
    END IF;
END$$

-- A gift card line sells one card for an amount inside the business's limits, untaxed and undiscounted
CREATE PROCEDURE CheckGiftCardLine(IN pOrderID CHAR(36), IN pVariantID CHAR(36), IN pQuantity DECIMAL(12,3),
                                   IN pUnitPrice DECIMAL(10,2), IN pDiscount DECIMAL(10,2),
                                   IN pTaxRate DECIMAL(7,6), IN pTaxAmount DECIMAL(10,2))
BEGIN
    IF IsGiftCardVariant(pVariantID) THEN
        IF pQuantity <> 1 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A gift card line sells exactly one card';
        END IF;

        IF pDiscount <> 0 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Gift cards can''t be discounted';
        END IF;

        IF pTaxRate <> 0 OR pTaxAmount <> 0 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Gift cards carry no tax';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM Orders o JOIN Business b ON b.BusinessID = o.BusinessID
                        WHERE o.OrderID = pOrderID
                          AND pUnitPrice BETWEEN b.GiftCardMinAmount AND b.GiftCardMaxAmount) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Gift card amount is outside this business''s limits';
        END IF;

        IF EXISTS (SELECT 1 FROM Payment WHERE OrderID = pOrderID AND GiftCardID IS NOT NULL
                      AND PaymentStatusCode <> 4) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A gift card can''t pay for another gift card';
        END IF;
    END IF;
END$$

-- Completed (5) and refunded (7) orders are closed: their lines and payments are frozen
CREATE PROCEDURE CheckOrderOpen(IN pOrderID CHAR(36))
BEGIN
    IF EXISTS (SELECT 1 FROM Orders WHERE OrderID = pOrderID AND OrderStatusCode IN (5, 7)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This order is closed; record changes as a return or refund';
    END IF;
END$$

CREATE TRIGGER TR_OrderItem_BeforeInsert BEFORE INSERT ON OrderItem FOR EACH ROW
BEGIN
    CALL CheckOrderOpen(NEW.OrderID);
    SET NEW.PricesIncludeTax = (SELECT PricesIncludeTax FROM Orders WHERE OrderID = NEW.OrderID);
    CALL CheckOrderItem(NEW.VariantID, NEW.Quantity);
    CALL CheckOrderItemTax(NEW.OrderID, NEW.VariantID, NEW.TaxCategoryID, NEW.TaxRate);
    CALL CheckGiftCardLine(NEW.OrderID, NEW.VariantID, NEW.Quantity, NEW.UnitPrice,
                           NEW.DiscountAmount, NEW.TaxRate, NEW.TaxAmount);
END$$

CREATE TRIGGER TR_OrderItem_BeforeDelete BEFORE DELETE ON OrderItem FOR EACH ROW
BEGIN
    CALL CheckOrderOpen(OLD.OrderID);
END$$

CREATE TRIGGER TR_OrderItem_BeforeUpdate BEFORE UPDATE ON OrderItem FOR EACH ROW
BEGIN
    CALL CheckOrderOpen(OLD.OrderID);
    CALL CheckOrderOpen(NEW.OrderID);
    CALL CheckOrderItem(NEW.VariantID, NEW.Quantity);

    IF NEW.OrderID <> OLD.OrderID OR NEW.VariantID <> OLD.VariantID
       OR NEW.TaxCategoryID <> OLD.TaxCategoryID OR NEW.TaxRate <> OLD.TaxRate THEN
        CALL CheckOrderItemTax(NEW.OrderID, NEW.VariantID, NEW.TaxCategoryID, NEW.TaxRate);
    END IF;
    CALL CheckGiftCardLine(NEW.OrderID, NEW.VariantID, NEW.Quantity, NEW.UnitPrice,
                           NEW.DiscountAmount, NEW.TaxRate, NEW.TaxAmount);
END$$

-- A line's modifiers and components (its cost of goods) freeze with the order
CREATE PROCEDURE CheckOrderItemOpen(IN pOrderItemID CHAR(36))
BEGIN
    CALL CheckOrderOpen((SELECT OrderID FROM OrderItem WHERE OrderItemID = pOrderItemID));
END$$

-- A line's modifier must come from a group its product offers (min/max is checked at completion)
CREATE PROCEDURE CheckModifierOffered(IN pOrderItemID CHAR(36), IN pModifierID CHAR(36))
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM OrderItem oi
                     JOIN ProductVariant v ON v.VariantID = oi.VariantID
                     JOIN ProductModifierGroup pmg ON pmg.ProductID = v.ProductID
                     JOIN Modifier m ON m.ModifierGroupID = pmg.ModifierGroupID
                    WHERE oi.OrderItemID = pOrderItemID AND m.ModifierID = pModifierID) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This product doesn''t offer that modifier''s group';
    END IF;
END$$

CREATE TRIGGER TR_OrderItemModifier_BeforeInsert BEFORE INSERT ON OrderItemModifier FOR EACH ROW
BEGIN
    CALL CheckOrderItemOpen(NEW.OrderItemID);
    CALL CheckModifierOffered(NEW.OrderItemID, NEW.ModifierID);
END$$

CREATE TRIGGER TR_OrderItemModifier_BeforeUpdate BEFORE UPDATE ON OrderItemModifier FOR EACH ROW
BEGIN
    CALL CheckOrderItemOpen(OLD.OrderItemID);
    CALL CheckOrderItemOpen(NEW.OrderItemID);
    CALL CheckModifierOffered(NEW.OrderItemID, NEW.ModifierID);
END$$

CREATE TRIGGER TR_OrderItemModifier_BeforeDelete BEFORE DELETE ON OrderItemModifier FOR EACH ROW
    CALL CheckOrderItemOpen(OLD.OrderItemID)$$

CREATE TRIGGER TR_OrderItemComponent_BeforeInsert BEFORE INSERT ON OrderItemComponent FOR EACH ROW
    CALL CheckOrderItemOpen(NEW.OrderItemID)$$

CREATE TRIGGER TR_OrderItemComponent_BeforeUpdate BEFORE UPDATE ON OrderItemComponent FOR EACH ROW
BEGIN
    CALL CheckOrderItemOpen(OLD.OrderItemID);
    CALL CheckOrderItemOpen(NEW.OrderItemID);
END$$

CREATE TRIGGER TR_OrderItemComponent_BeforeDelete BEFORE DELETE ON OrderItemComponent FOR EACH ROW
    CALL CheckOrderItemOpen(OLD.OrderItemID)$$

-- Payment: non-failed payments can't exceed the order total; a cancelled order takes no
-- live payments (1 PENDING, 2 AUTHORIZED, 3 COMPLETED), though old ones may still be marked REFUNDED
CREATE PROCEDURE CheckPayment(IN pPaymentID CHAR(36), IN pOrderID CHAR(36),
                              IN pAmount DECIMAL(10,2), IN pStatus TINYINT UNSIGNED)
BEGIN
    DECLARE vTotal DECIMAL(10,2);
    DECLARE vOrderStatus TINYINT UNSIGNED;
    DECLARE vPaid DECIMAL(12,2);

    IF pStatus <> 4 THEN
        SELECT Total, OrderStatusCode INTO vTotal, vOrderStatus FROM Orders WHERE OrderID = pOrderID FOR UPDATE;

        IF vOrderStatus = 6 AND pStatus IN (1, 2, 3) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This order is cancelled; it can''t take payments';
        END IF;

        SELECT COALESCE(SUM(Amount), 0) INTO vPaid
          FROM Payment
         WHERE OrderID = pOrderID AND PaymentID <> pPaymentID AND PaymentStatusCode <> 4;

        IF vPaid + pAmount > vTotal THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Payments would exceed the order total';
        END IF;
    END IF;
END$$

-- A gift card pays only for its own business's orders, while active, and never for another gift card
CREATE PROCEDURE CheckGiftCardPayment(IN pOrderID CHAR(36), IN pGiftCardID CHAR(36))
BEGIN
    IF pGiftCardID IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM GiftCard g JOIN Orders o ON o.BusinessID = g.BusinessID
                        WHERE g.GiftCardID = pGiftCardID AND o.OrderID = pOrderID AND g.Active) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This gift card is not active at this business';
        END IF;

        IF EXISTS (SELECT 1 FROM OrderItem WHERE OrderID = pOrderID AND IsGiftCardVariant(VariantID)) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A gift card can''t pay for another gift card';
        END IF;
    END IF;
END$$

-- Writes one trigger-owned gift card ledger row
-- (VALUES, not INSERT ... SELECT FROM GiftCard: the ledger trigger locks GiftCard, error 1442)
CREATE PROCEDURE AddGiftCardEntry(IN pGiftCardID CHAR(36), IN pType TINYINT UNSIGNED, IN pAmount DECIMAL(10,2),
                                  IN pPaymentID CHAR(36), IN pRefundID CHAR(36), IN pReturnItemID CHAR(36),
                                  IN pAt DATETIME)
BEGIN
    DECLARE vBusinessID CHAR(36);
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET @siapos_giftcard_write = NULL;
        RESIGNAL;
    END;

    SET vBusinessID = (SELECT BusinessID FROM GiftCard WHERE GiftCardID = pGiftCardID);
    SET @siapos_giftcard_write = 1;
    INSERT INTO GiftCardTransaction (GiftCardTransactionID, GiftCardID, BusinessID, GiftCardTransactionTypeCode,
                                     Amount, PaymentID, RefundID, ReturnItemID, CreatedAt)
    VALUES (UUID(), pGiftCardID, vBusinessID, pType, pAmount, pPaymentID, pRefundID, pReturnItemID,
            COALESCE(pAt, UTC_TIMESTAMP()));
    SET @siapos_giftcard_write = NULL;
END$$

CREATE TRIGGER TR_Payment_BeforeInsert BEFORE INSERT ON Payment FOR EACH ROW
BEGIN
    CALL CheckPayment(NEW.PaymentID, NEW.OrderID, NEW.Amount, NEW.PaymentStatusCode);
    CALL CheckGiftCardPayment(NEW.OrderID, NEW.GiftCardID);
END$$

-- A completed gift card payment takes its amount off the card
CREATE TRIGGER TR_Payment_AfterInsert AFTER INSERT ON Payment FOR EACH ROW
BEGIN
    IF NEW.GiftCardID IS NOT NULL AND NEW.PaymentStatusCode = 3 THEN
        CALL AddGiftCardEntry(NEW.GiftCardID, 2, -NEW.Amount, NEW.PaymentID, NULL, NULL, NEW.PaymentDateTime);   -- 2 = REDEEM
    END IF;
END$$

CREATE TRIGGER TR_Payment_AfterUpdate AFTER UPDATE ON Payment FOR EACH ROW
BEGIN
    IF NEW.GiftCardID IS NOT NULL AND NEW.PaymentStatusCode = 3 AND OLD.PaymentStatusCode NOT IN (3, 5) THEN
        CALL AddGiftCardEntry(NEW.GiftCardID, 2, -NEW.Amount, NEW.PaymentID, NULL, NULL, NEW.PaymentDateTime);
    END IF;
END$$

CREATE TRIGGER TR_Payment_BeforeUpdate BEFORE UPDATE ON Payment FOR EACH ROW
BEGIN
    -- Once a gift card payment is taken, the card's ledger holds it; only a refund gives it back
    IF OLD.GiftCardID IS NOT NULL AND OLD.PaymentStatusCode IN (3, 5)
       AND (NEW.Amount <> OLD.Amount OR NEW.OrderID <> OLD.OrderID OR NOT (NEW.GiftCardID <=> OLD.GiftCardID)
            OR NEW.PaymentStatusCode NOT IN (3, 5)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A gift card payment can''t change once taken; refund it instead';
    END IF;

    IF NOT (NEW.GiftCardID <=> OLD.GiftCardID) OR NEW.OrderID <> OLD.OrderID THEN
        CALL CheckGiftCardPayment(NEW.OrderID, NEW.GiftCardID);
    END IF;

    -- Status may still change on a closed order (e.g. COMPLETED -> REFUNDED); the money may not
    IF NEW.Amount <> OLD.Amount OR NEW.OrderID <> OLD.OrderID OR NEW.PaymentMethodCode <> OLD.PaymentMethodCode THEN
        CALL CheckOrderOpen(OLD.OrderID);
    END IF;

    -- The tip stays adjustable after the order closes (restaurant style) until it is locked;
    -- a lock is final, and a refunded order's tips are frozen
    IF NEW.TipAmount <> OLD.TipAmount OR NOT (NEW.TipLockedAt <=> OLD.TipLockedAt) THEN
        IF OLD.TipLockedAt IS NOT NULL THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This payment''s tip is locked';
        END IF;

        IF NEW.TipAmount <> OLD.TipAmount
           AND EXISTS (SELECT 1 FROM Orders WHERE OrderID = OLD.OrderID AND OrderStatusCode = 7) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This order is refunded; its tips can no longer change';
        END IF;
    END IF;
    CALL CheckPayment(NEW.PaymentID, NEW.OrderID, NEW.Amount, NEW.PaymentStatusCode);
END$$

CREATE TRIGGER TR_Payment_BeforeDelete BEFORE DELETE ON Payment FOR EACH ROW
BEGIN
    CALL CheckOrderOpen(OLD.OrderID);
    IF OLD.GiftCardID IS NOT NULL AND OLD.PaymentStatusCode IN (3, 5) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A gift card payment can''t change once taken; refund it instead';
    END IF;
END$$

-- Discounts: promotion redemptions and one-off discounts freeze with the order (completion
-- checks they add up to Orders.DiscountAmount). A one-off is signed by someone with permission 4
-- (Approve discounts). A staff discount (StaffEmployeeID) needs no signature unless the business
-- turns that on, and must be for an active employee.
CREATE PROCEDURE CheckOrderDiscount(IN pOrderID CHAR(36), IN pApprovedBy CHAR(36), IN pStaff CHAR(36),
                                    IN pAmount DECIMAL(10,2))
BEGIN
    CALL CheckOrderOpen(pOrderID);

    IF pApprovedBy IS NOT NULL AND NOT HasPermission(pApprovedBy, 4) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A one-off discount must be approved by someone allowed to approve discounts';
    END IF;

    IF pStaff IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM Employee WHERE EmployeeID = pStaff AND Active) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A staff discount is only for an active employee';
        END IF;

        IF pApprovedBy IS NULL
           AND EXISTS (SELECT 1 FROM Business b JOIN Orders o ON o.BusinessID = b.BusinessID
                        WHERE o.OrderID = pOrderID AND b.StaffDiscountsNeedApproval) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This business needs a manager to approve staff discounts';
        END IF;

        -- unsigned staff discounts stay under the business's cap, measured on the order's lines
        IF pApprovedBy IS NULL
           AND EXISTS (SELECT 1 FROM Business b JOIN Orders o ON o.BusinessID = b.BusinessID
                        WHERE o.OrderID = pOrderID
                          AND pAmount * 100 > b.StaffDiscountMaxPercent
                                              * (SELECT COALESCE(SUM(LineTotal), 0) FROM OrderItem WHERE OrderID = pOrderID)) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A staff discount over the business limit needs a manager to approve it';
        END IF;
    END IF;
END$$

CREATE TRIGGER TR_OrderDiscount_BeforeInsert BEFORE INSERT ON OrderDiscount FOR EACH ROW
    CALL CheckOrderDiscount(NEW.OrderID, NEW.ApprovedByEmployeeID, NEW.StaffEmployeeID, NEW.Amount)$$

CREATE TRIGGER TR_OrderDiscount_BeforeUpdate BEFORE UPDATE ON OrderDiscount FOR EACH ROW
BEGIN
    CALL CheckOrderOpen(OLD.OrderID);
    CALL CheckOrderDiscount(NEW.OrderID, NEW.ApprovedByEmployeeID, NEW.StaffEmployeeID, NEW.Amount);
END$$

CREATE TRIGGER TR_OrderDiscount_BeforeDelete BEFORE DELETE ON OrderDiscount FOR EACH ROW
    CALL CheckOrderOpen(OLD.OrderID)$$

CREATE TRIGGER TR_PromotionRedemption_BeforeInsert BEFORE INSERT ON PromotionRedemption FOR EACH ROW
    CALL CheckOrderOpen(NEW.OrderID)$$

CREATE TRIGGER TR_PromotionRedemption_BeforeUpdate BEFORE UPDATE ON PromotionRedemption FOR EACH ROW
BEGIN
    CALL CheckOrderOpen(OLD.OrderID);
    CALL CheckOrderOpen(NEW.OrderID);
END$$

CREATE TRIGGER TR_PromotionRedemption_BeforeDelete BEFORE DELETE ON PromotionRedemption FOR EACH ROW
    CALL CheckOrderOpen(OLD.OrderID)$$

-- Refund: only completed payments; non-failed refunds can't exceed the payment;
-- tax refunded can't exceed tax collected, and merchandise refunded can't exceed
-- net sales, per order and, when tied to a return, per return
CREATE PROCEDURE CheckRefund(IN pRefundID CHAR(36), IN pPaymentID CHAR(36),
                             IN pOrderID CHAR(36), IN pReturnID CHAR(36),
                             IN pAmount DECIMAL(10,2), IN pTaxAmount DECIMAL(10,2),
                             IN pStatus TINYINT UNSIGNED)
BEGIN
    DECLARE vOrderNet DECIMAL(10,2);
    DECLARE vOrderTax DECIMAL(10,2);
    DECLARE vPaid DECIMAL(10,2);
    DECLARE vPaymentStatus TINYINT UNSIGNED;
    DECLARE vRefunded DECIMAL(12,2);
    DECLARE vTaxRefunded DECIMAL(12,2);
    DECLARE vReturnNet DECIMAL(12,2);
    DECLARE vReturnTax DECIMAL(12,2);

    IF pStatus <> 3 THEN
        -- Order first, then payment: the same lock order as CheckPayment
        SELECT Total - Tax, Tax INTO vOrderNet, vOrderTax
          FROM Orders WHERE OrderID = pOrderID FOR UPDATE;

        SELECT Amount, PaymentStatusCode INTO vPaid, vPaymentStatus
          FROM Payment WHERE PaymentID = pPaymentID FOR UPDATE;

        IF vPaymentStatus NOT IN (3, 5) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only completed payments can be refunded';
        END IF;

        SELECT COALESCE(SUM(Amount), 0) INTO vRefunded
          FROM Refund
         WHERE PaymentID = pPaymentID AND RefundID <> pRefundID AND RefundStatusCode <> 3;

        IF vRefunded + pAmount > vPaid THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Refunds would exceed the payment';
        END IF;

        SELECT COALESCE(SUM(Amount), 0), COALESCE(SUM(TaxAmount), 0) INTO vRefunded, vTaxRefunded
          FROM Refund
         WHERE OrderID = pOrderID AND RefundID <> pRefundID AND RefundStatusCode <> 3;

        IF vTaxRefunded + pTaxAmount > vOrderTax THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Refunded tax would exceed the tax collected on the order';
        END IF;

        IF (vRefunded - vTaxRefunded) + (pAmount - pTaxAmount) > vOrderNet THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Refunded merchandise would exceed the order''s net sales';
        END IF;

        IF pReturnID IS NOT NULL THEN
            -- Each returned line contributes its share of net amount and tax
            SELECT COALESCE(SUM(ROUND(oi.NetAmount * ri.QuantityReturned / oi.Quantity, 2)), 0),
                   COALESCE(SUM(ROUND(oi.TaxAmount * ri.QuantityReturned / oi.Quantity, 2)), 0)
              INTO vReturnNet, vReturnTax
              FROM ReturnItem ri
              JOIN OrderItem oi ON oi.OrderItemID = ri.OrderItemID
             WHERE ri.ReturnID = pReturnID;

            SELECT COALESCE(SUM(Amount), 0), COALESCE(SUM(TaxAmount), 0) INTO vRefunded, vTaxRefunded
              FROM Refund
             WHERE ReturnID = pReturnID AND RefundID <> pRefundID AND RefundStatusCode <> 3;

            IF vTaxRefunded + pTaxAmount > vReturnTax THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Refunded tax would exceed the tax on the returned items';
            END IF;

            IF (vRefunded - vTaxRefunded) + (pAmount - pTaxAmount) > vReturnNet THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Refunded merchandise would exceed the value of the returned items';
            END IF;
        END IF;
    END IF;
END$$

-- Refund rules (Business settings): completing a refund over the amount, or on an order completed
-- more than the days ago, needs an approver with permission 3 (Sign refund overrides)
CREATE PROCEDURE CheckRefundOverride(IN pBusinessID CHAR(36), IN pOrderID CHAR(36),
                                     IN pAmount DECIMAL(10,2), IN pApprovedBy CHAR(36))
BEGIN
    IF EXISTS (SELECT 1 FROM Business b JOIN Orders o ON o.OrderID = pOrderID
                WHERE b.BusinessID = pBusinessID
                  AND (pAmount > b.RefundOverrideAmount
                       OR COALESCE(o.CompletedAt, o.OrderDateTime)
                          < UTC_TIMESTAMP() - INTERVAL b.RefundOverrideDays DAY))
       AND NOT HasPermission(pApprovedBy, 3) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This refund breaks a refund rule; a manager must sign the override';
    END IF;
END$$

-- Money back on an order that sold a gift card goes through a return, so the card is cancelled with it
CREATE PROCEDURE CheckGiftCardOrderRefund(IN pOrderID CHAR(36), IN pReturnID CHAR(36))
BEGIN
    IF pReturnID IS NULL
       AND EXISTS (SELECT 1 FROM OrderItem WHERE OrderID = pOrderID AND IsGiftCardVariant(VariantID)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This order sold a gift card; refund it through a return';
    END IF;
END$$

CREATE TRIGGER TR_Refund_BeforeInsert BEFORE INSERT ON Refund FOR EACH ROW
BEGIN
    CALL CheckGiftCardOrderRefund(NEW.OrderID, NEW.ReturnID);
    CALL CheckRefund(NEW.RefundID, NEW.PaymentID, NEW.OrderID, NEW.ReturnID,
                     NEW.Amount, NEW.TaxAmount, NEW.RefundStatusCode);
    IF NEW.RefundStatusCode = 2 THEN
        CALL CheckRefundOverride(NEW.BusinessID, NEW.OrderID, NEW.Amount, NEW.ApprovedByEmployeeID);
    END IF;
END$$

CREATE TRIGGER TR_Refund_BeforeUpdate BEFORE UPDATE ON Refund FOR EACH ROW
BEGIN
    IF OLD.RefundStatusCode = 2 AND (NEW.RefundStatusCode <> 2 OR NEW.Amount <> OLD.Amount
                                     OR NEW.PaymentID <> OLD.PaymentID)
       AND EXISTS (SELECT 1 FROM Payment WHERE PaymentID = OLD.PaymentID AND GiftCardID IS NOT NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A completed refund to a gift card can''t change';
    END IF;
    CALL CheckGiftCardOrderRefund(NEW.OrderID, NEW.ReturnID);
    CALL CheckRefund(NEW.RefundID, NEW.PaymentID, NEW.OrderID, NEW.ReturnID,
                     NEW.Amount, NEW.TaxAmount, NEW.RefundStatusCode);
    IF NEW.RefundStatusCode = 2
       AND (OLD.RefundStatusCode <> 2 OR NEW.Amount <> OLD.Amount
            OR NOT (NEW.ApprovedByEmployeeID <=> OLD.ApprovedByEmployeeID)) THEN
        CALL CheckRefundOverride(NEW.BusinessID, NEW.OrderID, NEW.Amount, NEW.ApprovedByEmployeeID);
    END IF;
END$$

-- A completed refund of a gift card payment goes back onto the card
CREATE PROCEDURE RefundToGiftCard(IN pRefundID CHAR(36), IN pPaymentID CHAR(36), IN pAmount DECIMAL(10,2),
                                  IN pAt DATETIME)
BEGIN
    DECLARE vCard CHAR(36);
    SET vCard = (SELECT GiftCardID FROM Payment WHERE PaymentID = pPaymentID);
    IF vCard IS NOT NULL THEN
        CALL AddGiftCardEntry(vCard, 3, pAmount, NULL, pRefundID, NULL, pAt);                -- 3 = REFUND
    END IF;
END$$

CREATE TRIGGER TR_Refund_AfterInsert AFTER INSERT ON Refund FOR EACH ROW
BEGIN
    IF NEW.RefundStatusCode = 2 THEN
        CALL RefundToGiftCard(NEW.RefundID, NEW.PaymentID, NEW.Amount, NEW.RefundDateTime);
    END IF;
END$$

CREATE TRIGGER TR_Refund_AfterUpdate AFTER UPDATE ON Refund FOR EACH ROW
BEGIN
    IF NEW.RefundStatusCode = 2 AND OLD.RefundStatusCode <> 2 THEN
        CALL RefundToGiftCard(NEW.RefundID, NEW.PaymentID, NEW.Amount, NEW.RefundDateTime);
    END IF;
END$$

-- ReturnItem: only from closed orders (their lines are frozen, so the cap below stays true);
-- total returned can't exceed the quantity ordered; whole units stay whole
CREATE PROCEDURE CheckReturnItem(IN pReturnItemID CHAR(36), IN pOrderItemID CHAR(36),
                                 IN pReturned DECIMAL(12,3), IN pRestocked DECIMAL(12,3))
BEGIN
    DECLARE vOrdered DECIMAL(12,3);
    DECLARE vAllowsFraction BOOLEAN;
    DECLARE vAlready DECIMAL(12,3);
    DECLARE vStatus TINYINT UNSIGNED;

    SELECT oi.Quantity, u.AllowsFraction, o.OrderStatusCode INTO vOrdered, vAllowsFraction, vStatus
      FROM OrderItem oi
      JOIN Orders o ON o.OrderID = oi.OrderID
      JOIN ProductVariant v ON v.VariantID = oi.VariantID
      JOIN UnitOfMeasure u ON u.UnitCode = v.SellUnitCode
     WHERE oi.OrderItemID = pOrderItemID
       FOR UPDATE OF oi;

    IF vStatus NOT IN (5, 7) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only completed orders can have returns';
    END IF;

    IF NOT vAllowsFraction
       AND (pReturned <> FLOOR(pReturned) OR pRestocked <> FLOOR(pRestocked)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This variant is returned in whole units';
    END IF;

    SELECT COALESCE(SUM(QuantityReturned), 0) INTO vAlready
      FROM ReturnItem
     WHERE OrderItemID = pOrderItemID AND ReturnItemID <> pReturnItemID;

    IF vAlready + pReturned > vOrdered THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Total returned would exceed the quantity ordered';
    END IF;
END$$

-- A returned gift card must be unused (its ledger holds only the ISSUE); returning it cancels it
CREATE PROCEDURE CheckGiftCardReturn(IN pOrderItemID CHAR(36))
BEGIN
    DECLARE vCard CHAR(36);
    DECLARE vActive BOOLEAN;

    SELECT GiftCardID, Active INTO vCard, vActive FROM GiftCard WHERE OrderItemID = pOrderItemID FOR UPDATE;

    IF vCard IS NOT NULL
       AND (NOT vActive OR EXISTS (SELECT 1 FROM GiftCardTransaction
                                    WHERE GiftCardID = vCard AND GiftCardTransactionTypeCode <> 1)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This gift card has been used or deactivated; it can''t be returned';
    END IF;
END$$

CREATE PROCEDURE CheckNotGiftCardReturn(IN pOrderItemID CHAR(36))
BEGIN
    IF EXISTS (SELECT 1 FROM GiftCard WHERE OrderItemID = pOrderItemID) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A returned gift card stays cancelled';
    END IF;
END$$

CREATE TRIGGER TR_ReturnItem_BeforeInsert BEFORE INSERT ON ReturnItem FOR EACH ROW
BEGIN
    CALL CheckReturnItem(NEW.ReturnItemID, NEW.OrderItemID, NEW.QuantityReturned, NEW.QuantityRestocked);
    CALL CheckGiftCardReturn(NEW.OrderItemID);
END$$

CREATE TRIGGER TR_ReturnItem_AfterInsert AFTER INSERT ON ReturnItem FOR EACH ROW
BEGIN
    DECLARE vCard CHAR(36);
    DECLARE vAmount DECIMAL(10,2);

    SELECT GiftCardID INTO vCard FROM GiftCard WHERE OrderItemID = NEW.OrderItemID;
    IF vCard IS NOT NULL THEN
        SET vAmount = (SELECT SUM(Amount) FROM GiftCardTransaction WHERE GiftCardID = vCard);
        CALL AddGiftCardEntry(vCard, 4, -vAmount, NULL, NULL, NEW.ReturnItemID, NULL);         -- 4 = CANCEL
        UPDATE GiftCard SET Active = FALSE WHERE GiftCardID = vCard;
    END IF;
END$$

-- Once money has gone back for a return, its items are frozen (CheckRefund priced them)
CREATE PROCEDURE CheckReturnNotRefunded(IN pReturnID CHAR(36))
BEGIN
    IF EXISTS (SELECT 1 FROM Refund WHERE ReturnID = pReturnID AND RefundStatusCode <> 3) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This return has been refunded; its items can no longer change';
    END IF;
END$$

CREATE TRIGGER TR_ReturnItem_BeforeUpdate BEFORE UPDATE ON ReturnItem FOR EACH ROW
BEGIN
    CALL CheckNotGiftCardReturn(OLD.OrderItemID);
    CALL CheckNotGiftCardReturn(NEW.OrderItemID);
    CALL CheckReturnNotRefunded(OLD.ReturnID);
    CALL CheckReturnItem(NEW.ReturnItemID, NEW.OrderItemID, NEW.QuantityReturned, NEW.QuantityRestocked);
END$$

CREATE TRIGGER TR_ReturnItem_BeforeDelete BEFORE DELETE ON ReturnItem FOR EACH ROW
BEGIN
    CALL CheckNotGiftCardReturn(OLD.OrderItemID);
    CALL CheckReturnNotRefunded(OLD.ReturnID);
END$$

-- Orders: completed only by UPDATE, once lines and payments add up;
-- the total can never drop below what has been paid
CREATE TRIGGER TR_Orders_BeforeInsert BEFORE INSERT ON Orders FOR EACH ROW
BEGIN
    -- Snapshot the business's pricing convention; changing it later leaves old orders alone
    SET NEW.PricesIncludeTax = (SELECT PricesIncludeTax FROM Business WHERE BusinessID = NEW.BusinessID);

    -- Next order number; the row lock serialises registers. UpdatedAt = UpdatedAt keeps it unchanged.
    UPDATE Business SET LastOrderNumber = LastOrderNumber + 1, UpdatedAt = UpdatedAt
     WHERE BusinessID = NEW.BusinessID;
    SET NEW.OrderNumber = (SELECT LastOrderNumber FROM Business WHERE BusinessID = NEW.BusinessID);

    IF NEW.OrderStatusCode = 5 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Insert the order first, then complete it with an UPDATE';
    END IF;

    -- Checked only when the order is placed: switching a location off leaves its open orders alone
    IF NEW.ChannelCode = 2 AND NOT EXISTS (SELECT 1 FROM Location WHERE LocationID = NEW.LocationID
                                              AND Active AND AcceptsOnlineOrders) THEN   -- 2 = ONLINE
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This location is not taking online orders';
    END IF;
END$$

-- Completion: every line records what it used, its cost is those components' cost, the SALE
-- ledger moved exactly those quantities, and its modifiers fit each offered group's min/max
CREATE PROCEDURE CheckOrderLines(IN pOrderID CHAR(36))
BEGIN
    IF EXISTS (SELECT 1 FROM OrderItem oi
                WHERE oi.OrderID = pOrderID AND NOT IsGiftCardVariant(oi.VariantID)
                  AND NOT EXISTS (SELECT 1 FROM OrderItemComponent c WHERE c.OrderItemID = oi.OrderItemID)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: every line needs its components recorded';
    END IF;

    IF EXISTS (SELECT 1 FROM OrderItem oi
                WHERE oi.OrderID = pOrderID AND IsGiftCardVariant(oi.VariantID)
                  AND NOT EXISTS (SELECT 1 FROM GiftCard g WHERE g.OrderItemID = oi.OrderItemID)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: every gift card line needs its card';
    END IF;

    IF EXISTS (SELECT 1 FROM OrderItem oi
                WHERE oi.OrderID = pOrderID
                  AND NOT (oi.UnitCost <=> (SELECT ROUND(SUM(c.QuantityUsed * c.UnitCost) / oi.Quantity, 6)
                                              FROM OrderItemComponent c
                                             WHERE c.OrderItemID = oi.OrderItemID))) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: a line''s UnitCost must equal its components'' cost per unit';
    END IF;

    -- SALE rows are negative, so each stock item nets to zero when the ledger matches
    IF EXISTS (SELECT 1
                 FROM (SELECT c.StockItemID, c.QuantityUsed q
                         FROM OrderItemComponent c JOIN OrderItem oi ON oi.OrderItemID = c.OrderItemID
                        WHERE oi.OrderID = pOrderID
                       UNION ALL
                       SELECT StockItemID, QuantityChange
                         FROM InventoryTransaction
                        WHERE OrderID = pOrderID AND TransactionTypeCode = 2) x
                GROUP BY StockItemID
               HAVING SUM(q) <> 0) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: SALE stock movements must match the components used';
    END IF;

    IF EXISTS (SELECT 1
                 FROM OrderItem oi
                 JOIN ProductVariant v ON v.VariantID = oi.VariantID
                 JOIN ProductModifierGroup pmg ON pmg.ProductID = v.ProductID
                 JOIN ModifierGroup g ON g.ModifierGroupID = pmg.ModifierGroupID
                WHERE oi.OrderID = pOrderID
                  AND (SELECT COUNT(*)
                         FROM OrderItemModifier oim JOIN Modifier m ON m.ModifierID = oim.ModifierID
                        WHERE oim.OrderItemID = oi.OrderItemID AND m.ModifierGroupID = g.ModifierGroupID)
                      NOT BETWEEN g.MinSelect AND COALESCE(g.MaxSelect, 255)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: a line''s modifiers are outside a group''s min/max';
    END IF;
END$$

CREATE TRIGGER TR_Orders_BeforeUpdate BEFORE UPDATE ON Orders FOR EACH ROW
BEGIN
    DECLARE vLines INT;
    DECLARE vLineTotal DECIMAL(12,2);
    DECLARE vDiscount DECIMAL(12,2);
    DECLARE vTax DECIMAL(12,2);
    DECLARE vPaid DECIMAL(12,2);

    IF NEW.PricesIncludeTax <> OLD.PricesIncludeTax THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'An order''s pricing convention is fixed when it is created';
    END IF;

    IF NEW.OrderNumber <> OLD.OrderNumber THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'An order''s number is fixed when it is created';
    END IF;

    IF OLD.OrderStatusCode IN (5, 7) THEN
        IF NEW.OrderStatusCode NOT IN (5, 7) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A closed order cannot be reopened';
        END IF;

        IF NEW.Subtotal <> OLD.Subtotal OR NEW.DiscountAmount <> OLD.DiscountAmount
           OR NEW.Tax <> OLD.Tax OR NEW.Total <> OLD.Total THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A closed order''s amounts cannot change; record a return or refund';
        END IF;
    END IF;

    IF NEW.OrderStatusCode = 6 AND OLD.OrderStatusCode <> 6
       AND EXISTS (SELECT 1 FROM Payment WHERE OrderID = NEW.OrderID AND PaymentStatusCode IN (1, 2, 3)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Void or refund the order''s payments before cancelling it';
    END IF;

    IF NEW.Total <> OLD.Total THEN
        SELECT COALESCE(SUM(Amount), 0) INTO vPaid
          FROM Payment WHERE OrderID = NEW.OrderID AND PaymentStatusCode <> 4;

        IF NEW.Total < vPaid THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order total cannot drop below the amount already paid';
        END IF;
    END IF;

    IF NEW.OrderStatusCode = 5 AND OLD.OrderStatusCode <> 5 THEN
        SELECT COUNT(*), COALESCE(SUM(LineTotal), 0), COALESCE(SUM(DiscountAmount), 0), COALESCE(SUM(TaxAmount), 0)
          INTO vLines, vLineTotal, vDiscount, vTax
          FROM OrderItem WHERE OrderID = NEW.OrderID;

        IF vLines = 0 OR vLineTotal <> NEW.Subtotal THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: Subtotal must equal the sum of its order lines';
        END IF;

        IF vDiscount <> NEW.DiscountAmount THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: DiscountAmount must equal the sum of line discounts';
        END IF;

        IF NEW.DiscountAmount <> (SELECT COALESCE(SUM(DiscountAmount), 0) FROM PromotionRedemption WHERE OrderID = NEW.OrderID)
                               + (SELECT COALESCE(SUM(Amount), 0) FROM OrderDiscount WHERE OrderID = NEW.OrderID) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: DiscountAmount must equal promotion redemptions plus one-off discounts';
        END IF;

        IF vTax <> NEW.Tax THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: Tax must equal the sum of line tax';
        END IF;

        SELECT COALESCE(SUM(Amount), 0) INTO vPaid
          FROM Payment WHERE OrderID = NEW.OrderID AND PaymentStatusCode = 3;

        IF vPaid <> NEW.Total THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: completed payments must equal the order total';
        END IF;

        CALL CheckOrderLines(NEW.OrderID);
    END IF;
END$$

-- Completion loads each card sold with its line's amount
CREATE TRIGGER TR_Orders_AfterUpdate AFTER UPDATE ON Orders FOR EACH ROW
BEGIN
    DECLARE vDone BOOLEAN DEFAULT FALSE;
    DECLARE vCard CHAR(36);
    DECLARE vAmount DECIMAL(10,2);
    DECLARE cCards CURSOR FOR
        SELECT g.GiftCardID, oi.LineTotal
          FROM OrderItem oi JOIN GiftCard g ON g.OrderItemID = oi.OrderItemID
         WHERE oi.OrderID = NEW.OrderID;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET vDone = TRUE;

    IF NEW.OrderStatusCode = 5 AND OLD.OrderStatusCode <> 5 THEN
        OPEN cCards;
        issue: LOOP
            FETCH cCards INTO vCard, vAmount;
            IF vDone THEN
                LEAVE issue;
            END IF;
            CALL AddGiftCardEntry(vCard, 1, vAmount, NULL, NULL, NULL, NEW.CompletedAt);                 -- 1 = ISSUE
        END LOOP;
        CLOSE cCards;
    END IF;
END$$

-- Loyalty: a balance never goes below zero, whether by a redemption, an edit or a deleted earning
CREATE PROCEDURE CheckLoyaltyBalance(IN pAccountID CHAR(36), IN pExcludeID CHAR(36), IN pPoints INT)
BEGIN
    DECLARE vLock CHAR(36);
    DECLARE vBalance BIGINT;

    SELECT LoyaltyAccountID INTO vLock FROM LoyaltyAccount WHERE LoyaltyAccountID = pAccountID FOR UPDATE;

    SELECT COALESCE(SUM(PointsChange), 0) INTO vBalance
      FROM LoyaltyTransaction
     WHERE LoyaltyAccountID = pAccountID AND LoyaltyTransactionID <> pExcludeID;

    IF vBalance + pPoints < 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Not enough loyalty points';
    END IF;
END$$

CREATE TRIGGER TR_LoyaltyTransaction_BeforeInsert BEFORE INSERT ON LoyaltyTransaction FOR EACH ROW
BEGIN
    CALL CheckLoyaltyBalance(NEW.LoyaltyAccountID, NEW.LoyaltyTransactionID, NEW.PointsChange);
END$$

CREATE TRIGGER TR_LoyaltyTransaction_BeforeUpdate BEFORE UPDATE ON LoyaltyTransaction FOR EACH ROW
BEGIN
    CALL CheckLoyaltyBalance(OLD.LoyaltyAccountID, OLD.LoyaltyTransactionID, 0);   -- in case it moves accounts
    CALL CheckLoyaltyBalance(NEW.LoyaltyAccountID, NEW.LoyaltyTransactionID, NEW.PointsChange);
END$$

CREATE TRIGGER TR_LoyaltyTransaction_BeforeDelete BEFORE DELETE ON LoyaltyTransaction FOR EACH ROW
BEGIN
    CALL CheckLoyaltyBalance(OLD.LoyaltyAccountID, OLD.LoyaltyTransactionID, 0);
END$$

-- Labor: no overlapping pay rates, pay periods or shifts; shifts fall in their
-- pay period (by the location's local date); closed pay periods are frozen
CREATE PROCEDURE CheckPayRate(IN pPayRateID CHAR(36), IN pEmployeeID CHAR(36),
                              IN pFrom DATETIME, IN pTo DATETIME)
BEGIN
    DECLARE vLock CHAR(36);

    SELECT EmployeeID INTO vLock FROM Employee WHERE EmployeeID = pEmployeeID FOR UPDATE;

    IF EXISTS (
        SELECT 1 FROM EmployeePayRate
         WHERE EmployeeID = pEmployeeID
           AND PayRateID <> pPayRateID
           AND EffectiveFrom < COALESCE(pTo, '9999-12-31')
           AND pFrom < COALESCE(EffectiveTo, '9999-12-31')
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Pay rate overlaps another rate for this employee; close the current rate first';
    END IF;
END$$

CREATE TRIGGER TR_EmployeePayRate_BeforeInsert BEFORE INSERT ON EmployeePayRate FOR EACH ROW
BEGIN
    CALL CheckPayRate(NEW.PayRateID, NEW.EmployeeID, NEW.EffectiveFrom, NEW.EffectiveTo);
END$$

CREATE TRIGGER TR_EmployeePayRate_BeforeUpdate BEFORE UPDATE ON EmployeePayRate FOR EACH ROW
BEGIN
    CALL CheckPayRate(NEW.PayRateID, NEW.EmployeeID, NEW.EffectiveFrom, NEW.EffectiveTo);
END$$

CREATE PROCEDURE CheckPayPeriod(IN pPayPeriodID CHAR(36), IN pBusinessID CHAR(36),
                                IN pStart DATE, IN pEnd DATE)
BEGIN
    DECLARE vLock CHAR(36);

    SELECT BusinessID INTO vLock FROM Business WHERE BusinessID = pBusinessID FOR UPDATE;

    IF EXISTS (
        SELECT 1 FROM PayPeriod
         WHERE BusinessID = pBusinessID
           AND PayPeriodID <> pPayPeriodID
           AND StartDate <= pEnd
           AND pStart <= EndDate
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Pay period overlaps another pay period';
    END IF;
END$$

CREATE TRIGGER TR_PayPeriod_BeforeInsert BEFORE INSERT ON PayPeriod FOR EACH ROW
BEGIN
    CALL CheckPayPeriod(NEW.PayPeriodID, NEW.BusinessID, NEW.StartDate, NEW.EndDate);
END$$

CREATE TRIGGER TR_PayPeriod_BeforeUpdate BEFORE UPDATE ON PayPeriod FOR EACH ROW
BEGIN
    CALL CheckPayPeriod(NEW.PayPeriodID, NEW.BusinessID, NEW.StartDate, NEW.EndDate);
END$$

CREATE PROCEDURE CheckPayPeriodOpen(IN pPayPeriodID CHAR(36))
BEGIN
    IF (SELECT Closed FROM PayPeriod WHERE PayPeriodID = pPayPeriodID) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Pay period is closed';
    END IF;
END$$

CREATE PROCEDURE CheckTimeEntry(IN pTimeEntryID CHAR(36), IN pEmployeeID CHAR(36),
                                IN pLocationID CHAR(36), IN pPayPeriodID CHAR(36),
                                IN pClockIn DATETIME, IN pClockOut DATETIME)
BEGIN
    DECLARE vLock CHAR(36);
    DECLARE vStart DATE;
    DECLARE vEnd DATE;
    DECLARE vLocalDate DATE;

    SELECT EmployeeID INTO vLock FROM Employee WHERE EmployeeID = pEmployeeID FOR UPDATE;

    CALL CheckPayPeriodOpen(pPayPeriodID);

    SELECT StartDate, EndDate INTO vStart, vEnd FROM PayPeriod WHERE PayPeriodID = pPayPeriodID;

    SELECT DATE(CONVERT_TZ(pClockIn, '+00:00', TimeZone)) INTO vLocalDate
      FROM Location WHERE LocationID = pLocationID;

    IF vLocalDate NOT BETWEEN vStart AND vEnd THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Clock-in falls outside the pay period (location local date)';
    END IF;

    IF EXISTS (
        SELECT 1 FROM TimeEntry
         WHERE EmployeeID = pEmployeeID
           AND TimeEntryID <> pTimeEntryID
           AND ClockInAt < COALESCE(pClockOut, '9999-12-31')
           AND pClockIn < COALESCE(ClockOutAt, '9999-12-31')
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Shift overlaps another shift for this employee';
    END IF;
END$$

CREATE TRIGGER TR_TimeEntry_BeforeInsert BEFORE INSERT ON TimeEntry FOR EACH ROW
BEGIN
    CALL CheckTimeEntry(NEW.TimeEntryID, NEW.EmployeeID, NEW.LocationID, NEW.PayPeriodID,
                        NEW.ClockInAt, NEW.ClockOutAt);
END$$

CREATE TRIGGER TR_TimeEntry_BeforeUpdate BEFORE UPDATE ON TimeEntry FOR EACH ROW
BEGIN
    CALL CheckPayPeriodOpen(OLD.PayPeriodID);
    CALL CheckTimeEntry(NEW.TimeEntryID, NEW.EmployeeID, NEW.LocationID, NEW.PayPeriodID,
                        NEW.ClockInAt, NEW.ClockOutAt);
END$$

CREATE TRIGGER TR_TimeEntry_BeforeDelete BEFORE DELETE ON TimeEntry FOR EACH ROW
BEGIN
    CALL CheckPayPeriodOpen(OLD.PayPeriodID);
END$$

-- ---------------------------------------------------------------------------
-- Gift cards
-- ---------------------------------------------------------------------------

-- A gift card product has no recipe or options, and a product can't become or stop being one
CREATE PROCEDURE CheckNotGiftCardProduct(IN pProductID CHAR(36))
BEGIN
    IF EXISTS (SELECT 1 FROM Product WHERE ProductID = pProductID AND IsGiftCard) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A gift card has no recipe or options';
    END IF;
END$$

CREATE TRIGGER TR_Product_BeforeUpdate BEFORE UPDATE ON Product FOR EACH ROW
BEGIN
    IF NEW.IsGiftCard <> OLD.IsGiftCard THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A product''s gift card status is fixed when it is created';
    END IF;
END$$

CREATE TRIGGER TR_VariantRecipe_BeforeInsert BEFORE INSERT ON VariantRecipe FOR EACH ROW
    CALL CheckNotGiftCardProduct((SELECT ProductID FROM ProductVariant WHERE VariantID = NEW.VariantID))$$

CREATE TRIGGER TR_VariantRecipe_BeforeUpdate BEFORE UPDATE ON VariantRecipe FOR EACH ROW
    CALL CheckNotGiftCardProduct((SELECT ProductID FROM ProductVariant WHERE VariantID = NEW.VariantID))$$

CREATE TRIGGER TR_ProductModifierGroup_BeforeInsert BEFORE INSERT ON ProductModifierGroup FOR EACH ROW
    CALL CheckNotGiftCardProduct(NEW.ProductID)$$

CREATE TRIGGER TR_ProductModifierGroup_BeforeUpdate BEFORE UPDATE ON ProductModifierGroup FOR EACH ROW
    CALL CheckNotGiftCardProduct(NEW.ProductID)$$

-- A card is attached to an open gift card line of its own business; afterwards only Active changes,
-- and a card cancelled by a return stays off
CREATE TRIGGER TR_GiftCard_BeforeInsert BEFORE INSERT ON GiftCard FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM OrderItem WHERE OrderItemID = NEW.OrderItemID
                      AND BusinessID = NEW.BusinessID AND IsGiftCardVariant(VariantID)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A gift card must belong to a gift card line of its business';
    END IF;
    CALL CheckOrderItemOpen(NEW.OrderItemID);
END$$

CREATE TRIGGER TR_GiftCard_BeforeUpdate BEFORE UPDATE ON GiftCard FOR EACH ROW
BEGIN
    IF NEW.CodeHash <> OLD.CodeHash OR NEW.Last4 <> OLD.Last4
       OR NEW.OrderItemID <> OLD.OrderItemID OR NEW.BusinessID <> OLD.BusinessID THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A gift card''s code and sale are fixed; only Active can change';
    END IF;

    IF NEW.Active AND NOT OLD.Active
       AND EXISTS (SELECT 1 FROM GiftCardTransaction WHERE GiftCardID = OLD.GiftCardID
                      AND GiftCardTransactionTypeCode = 4) THEN                         -- 4 = CANCEL
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A returned gift card stays cancelled';
    END IF;
END$$

CREATE TRIGGER TR_GiftCard_BeforeDelete BEFORE DELETE ON GiftCard FOR EACH ROW
    CALL CheckOrderItemOpen(OLD.OrderItemID)$$

-- Ledger: only ADJUST is written by hand, by someone with permission 23 (Manage gift cards);
-- a card never goes below zero, and only an active card can be spent
CREATE TRIGGER TR_GiftCardTransaction_BeforeInsert BEFORE INSERT ON GiftCardTransaction FOR EACH ROW
BEGIN
    DECLARE vActive BOOLEAN;
    DECLARE vBalance DECIMAL(12,2);

    IF NEW.GiftCardTransactionTypeCode <> 5 AND @siapos_giftcard_write IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Gift card balances change through sales, payments, refunds and returns; post an ADJUST otherwise';
    END IF;

    IF NEW.GiftCardTransactionTypeCode = 5 AND NOT HasPermission(NEW.EmployeeID, 23) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only someone allowed to manage gift cards can adjust a balance';
    END IF;

    SELECT Active INTO vActive FROM GiftCard WHERE GiftCardID = NEW.GiftCardID FOR UPDATE;

    IF NEW.GiftCardTransactionTypeCode = 2 AND NOT vActive THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This gift card is not active at this business';
    END IF;

    SELECT COALESCE(SUM(Amount), 0) INTO vBalance FROM GiftCardTransaction WHERE GiftCardID = NEW.GiftCardID;

    IF vBalance + NEW.Amount < 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Not enough balance on this gift card';
    END IF;
END$$

CREATE TRIGGER TR_GiftCardTransaction_BeforeUpdate BEFORE UPDATE ON GiftCardTransaction FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Gift card transactions are immutable; post an ADJUST instead';
END$$

CREATE TRIGGER TR_GiftCardTransaction_BeforeDelete BEFORE DELETE ON GiftCardTransaction FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Gift card transactions are immutable; post an ADJUST instead';
END$$

DELIMITER ;
