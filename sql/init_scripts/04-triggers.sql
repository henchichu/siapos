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

-- OrderItem: the variant must have a recipe, and whole-unit variants sell in whole numbers
CREATE PROCEDURE CheckOrderItem(IN pVariantID CHAR(36), IN pQuantity DECIMAL(12,3))
BEGIN
    DECLARE vAllowsFraction BOOLEAN;

    IF NOT EXISTS (SELECT 1 FROM VariantRecipe WHERE VariantID = pVariantID) THEN
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

CREATE TRIGGER TR_Payment_BeforeInsert BEFORE INSERT ON Payment FOR EACH ROW
BEGIN
    CALL CheckPayment(NEW.PaymentID, NEW.OrderID, NEW.Amount, NEW.PaymentStatusCode);
END$$

CREATE TRIGGER TR_Payment_BeforeUpdate BEFORE UPDATE ON Payment FOR EACH ROW
BEGIN
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
END$$

-- Discounts: promotion redemptions and one-off discounts freeze with the order (completion
-- checks they add up to Orders.DiscountAmount); a one-off needs an active manager (2) or owner (1)
CREATE PROCEDURE CheckOrderDiscount(IN pOrderID CHAR(36), IN pApprovedBy CHAR(36))
BEGIN
    CALL CheckOrderOpen(pOrderID);

    IF NOT EXISTS (SELECT 1 FROM Employee
                    WHERE EmployeeID = pApprovedBy AND Active AND RoleCode IN (1, 2)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A one-off discount must be approved by an active manager or owner';
    END IF;
END$$

CREATE TRIGGER TR_OrderDiscount_BeforeInsert BEFORE INSERT ON OrderDiscount FOR EACH ROW
    CALL CheckOrderDiscount(NEW.OrderID, NEW.ApprovedByEmployeeID)$$

CREATE TRIGGER TR_OrderDiscount_BeforeUpdate BEFORE UPDATE ON OrderDiscount FOR EACH ROW
BEGIN
    CALL CheckOrderOpen(OLD.OrderID);
    CALL CheckOrderDiscount(NEW.OrderID, NEW.ApprovedByEmployeeID);
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

CREATE TRIGGER TR_Refund_BeforeInsert BEFORE INSERT ON Refund FOR EACH ROW
BEGIN
    CALL CheckRefund(NEW.RefundID, NEW.PaymentID, NEW.OrderID, NEW.ReturnID,
                     NEW.Amount, NEW.TaxAmount, NEW.RefundStatusCode);
END$$

CREATE TRIGGER TR_Refund_BeforeUpdate BEFORE UPDATE ON Refund FOR EACH ROW
BEGIN
    CALL CheckRefund(NEW.RefundID, NEW.PaymentID, NEW.OrderID, NEW.ReturnID,
                     NEW.Amount, NEW.TaxAmount, NEW.RefundStatusCode);
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

CREATE TRIGGER TR_ReturnItem_BeforeInsert BEFORE INSERT ON ReturnItem FOR EACH ROW
BEGIN
    CALL CheckReturnItem(NEW.ReturnItemID, NEW.OrderItemID, NEW.QuantityReturned, NEW.QuantityRestocked);
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
    CALL CheckReturnNotRefunded(OLD.ReturnID);
    CALL CheckReturnItem(NEW.ReturnItemID, NEW.OrderItemID, NEW.QuantityReturned, NEW.QuantityRestocked);
END$$

CREATE TRIGGER TR_ReturnItem_BeforeDelete BEFORE DELETE ON ReturnItem FOR EACH ROW
BEGIN
    CALL CheckReturnNotRefunded(OLD.ReturnID);
END$$

-- Orders: completed only by UPDATE, once lines and payments add up;
-- the total can never drop below what has been paid
CREATE TRIGGER TR_Orders_BeforeInsert BEFORE INSERT ON Orders FOR EACH ROW
BEGIN
    -- Snapshot the business's pricing convention; changing it later leaves old orders alone
    SET NEW.PricesIncludeTax = (SELECT PricesIncludeTax FROM Business WHERE BusinessID = NEW.BusinessID);

    IF NEW.OrderStatusCode = 5 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Insert the order first, then complete it with an UPDATE';
    END IF;
END$$

-- Completion: every line records what it used, its cost is those components' cost, the SALE
-- ledger moved exactly those quantities, and its modifiers fit each offered group's min/max
CREATE PROCEDURE CheckOrderLines(IN pOrderID CHAR(36))
BEGIN
    IF EXISTS (SELECT 1 FROM OrderItem oi
                WHERE oi.OrderID = pOrderID
                  AND NOT EXISTS (SELECT 1 FROM OrderItemComponent c WHERE c.OrderItemID = oi.OrderItemID)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot complete: every line needs its components recorded';
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

DELIMITER ;
