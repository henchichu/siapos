USE miniworld;

-- Cross-row and cross-table rules that CHECK constraints and foreign keys can't express.
-- Lookup codes used below are fixed by 02-seed.sql:
-- Every rule raises SQLSTATE '45000' with a readable MESSAGE_TEXT.

DELIMITER $$

-- True when the employee and their role are active and the role holds the permission
CREATE FUNCTION HasPermission(pEmployeeID CHAR(36), pPermissionCode TINYINT UNSIGNED) RETURNS BOOLEAN
READS SQL DATA
BEGIN
    RETURN EXISTS (SELECT 1
                     FROM Employee e JOIN Role r ON r.RoleID = e.RoleID
                    WHERE e.EmployeeID = pEmployeeID AND e.Active AND r.Active
                      AND EXISTS (SELECT 1 FROM RolePermission rp
                                   WHERE rp.RoleID = r.RoleID AND rp.PermissionCode = pPermissionCode));
END$$

-- Inventory is driven by its ledger: Quantity and AverageUnitCost change only here, when an
-- InventoryTransaction is inserted (a trigger writes with its definer's rights, which app_user
-- lacks on those columns). Ledger rows are append-only: app_user has no UPDATE or DELETE on
-- the table. See 03-privileges.sql.
CREATE TRIGGER TR_InventoryTransaction_AfterInsert AFTER INSERT ON InventoryTransaction FOR EACH ROW
BEGIN
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
END$$

-- Completed (5) and refunded (7) orders are closed: their lines and payments are frozen
CREATE PROCEDURE CheckOrderOpen(IN pOrderID CHAR(36))
BEGIN
    IF EXISTS (SELECT 1 FROM Orders WHERE OrderID = pOrderID AND OrderStatusCode IN (5, 7)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This order is closed; record changes as a return or refund';
    END IF;
END$$

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

CREATE TRIGGER TR_Refund_BeforeInsert BEFORE INSERT ON Refund FOR EACH ROW
BEGIN
    CALL CheckRefund(NEW.RefundID, NEW.PaymentID, NEW.OrderID, NEW.ReturnID,
                     NEW.Amount, NEW.TaxAmount, NEW.RefundStatusCode);
    IF NEW.RefundStatusCode = 2 THEN
        CALL CheckRefundOverride(NEW.BusinessID, NEW.OrderID, NEW.Amount, NEW.ApprovedByEmployeeID);
    END IF;
END$$

CREATE TRIGGER TR_Refund_BeforeUpdate BEFORE UPDATE ON Refund FOR EACH ROW
BEGIN
    CALL CheckRefund(NEW.RefundID, NEW.PaymentID, NEW.OrderID, NEW.ReturnID,
                     NEW.Amount, NEW.TaxAmount, NEW.RefundStatusCode);
    IF NEW.RefundStatusCode = 2
       AND (OLD.RefundStatusCode <> 2 OR NEW.Amount <> OLD.Amount
            OR NOT (NEW.ApprovedByEmployeeID <=> OLD.ApprovedByEmployeeID)) THEN
        CALL CheckRefundOverride(NEW.BusinessID, NEW.OrderID, NEW.Amount, NEW.ApprovedByEmployeeID);
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

    -- Next order number; the row lock serialises registers. UpdatedAt = UpdatedAt keeps it unchanged.
    UPDATE Business SET LastOrderNumber = LastOrderNumber + 1, UpdatedAt = UpdatedAt
     WHERE BusinessID = NEW.BusinessID;
    SET NEW.OrderNumber = (SELECT LastOrderNumber FROM Business WHERE BusinessID = NEW.BusinessID);

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

-- Labor: no overlapping shifts; shifts fall in their pay period (by the location's
-- local date); closed pay periods are frozen
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

DELIMITER ;
