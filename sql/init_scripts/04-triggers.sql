USE miniworld;

-- Cross-row and cross-table rules that CHECK constraints and foreign keys can't express.
-- Lookup codes used below are fixed by 02-seed.sql:
-- Every rule raises SQLSTATE '45000' with a readable MESSAGE_TEXT.

DELIMITER $$

-- shortcut: SQL inventory imports need the backfill in sql/provision/low-stock-alerts.sql; revisit insert handling when adding import writers.
DROP TRIGGER IF EXISTS TR_Inventory_AfterUpdate$$

CREATE TRIGGER TR_Inventory_AfterUpdate AFTER UPDATE ON Inventory FOR EACH ROW
BEGIN
    IF NEW.ReorderThreshold > 0 AND NEW.Quantity <= NEW.ReorderThreshold THEN
        INSERT INTO LowStockAlert (InventoryID) VALUES (NEW.InventoryID)
        ON DUPLICATE KEY UPDATE InventoryID = NEW.InventoryID;
    ELSE
        DELETE FROM LowStockAlert WHERE InventoryID = NEW.InventoryID;
    END IF;
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

DELIMITER ;

-- ApprovalAction dispatch. These routines run with the database owner's rights.
DELIMITER $$
CREATE FUNCTION ApprovalPermission(pEmployee CHAR(36), pBusiness CHAR(36), pCode INT) RETURNS BOOLEAN
READS SQL DATA
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM Employee e JOIN Role r ON r.RoleID = e.RoleID AND r.Active
        JOIN RolePermission rp ON rp.RoleID = r.RoleID AND rp.PermissionCode = pCode
        WHERE e.EmployeeID = pEmployee AND e.BusinessID = pBusiness AND e.Active
    );
END$$

CREATE PROCEDURE ApplyDiscountApproval(IN pBusiness CHAR(36), IN pActor CHAR(36), IN pApprover CHAR(36), IN pOrder CHAR(36), IN pData JSON)
BEGIN
    DECLARE vLocation CHAR(36);
    DECLARE vStatus INT;
    DECLARE vAmount DECIMAL(10,2);
    DECLARE vSubtotal DECIMAL(12,2);
    DECLARE vStaff CHAR(36);
    DECLARE vReason VARCHAR(255);
    DECLARE vNeeds BOOLEAN;
    DECLARE vCap DECIMAL(5,2);
    IF NOT ApprovalPermission(pActor, pBusiness, 1) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Your role cannot use the register.';
    END IF;
    SELECT LocationID, OrderStatusCode INTO vLocation, vStatus FROM Orders
      WHERE OrderID = pOrder AND BusinessID = pBusiness FOR UPDATE;
    IF vLocation IS NULL OR vStatus IN (5, 6, 7) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This order cannot receive a discount.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM EmployeeLocation WHERE EmployeeID = pActor AND LocationID = vLocation AND Active) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'You do not work at this location.';
    END IF;
    SET vAmount = JSON_VALUE(pData, '$.amount' RETURNING DECIMAL(10,2) ERROR ON ERROR);
    SET vReason = JSON_UNQUOTE(JSON_EXTRACT(pData, '$.reason'));
    SET vStaff = JSON_VALUE(pData, '$.staffId' RETURNING CHAR(36));
    SELECT COALESCE(SUM(LineTotal), 0) INTO vSubtotal FROM OrderItem WHERE OrderID = pOrder;
    IF vAmount IS NULL OR vAmount <= 0 OR vAmount > vSubtotal OR vReason IS NULL OR TRIM(vReason) = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid discount amount or reason.';
    END IF;
    IF EXISTS (SELECT 1 FROM OrderDiscount WHERE OrderID = pOrder) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This order already has a one-off discount.';
    END IF;
    IF vStaff IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM Employee e JOIN Role r ON r.RoleID = e.RoleID AND r.Active
                       WHERE e.EmployeeID = vStaff AND e.BusinessID = pBusiness AND e.Active) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A staff discount is only for an active employee.';
        END IF;
        SELECT StaffDiscountsNeedApproval, StaffDiscountMaxPercent INTO vNeeds, vCap FROM Business WHERE BusinessID = pBusiness;
    ELSE
        SET vNeeds = TRUE;
    END IF;
    IF pApprover IS NOT NULL THEN
        IF NOT ApprovalPermission(pApprover, pBusiness, 4) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The approver cannot approve discounts.';
        END IF;
    ELSEIF vNeeds OR vStaff IS NULL OR vAmount * 100 > vCap * vSubtotal THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This discount needs a manager to approve it.';
    END IF;
    INSERT INTO OrderDiscount (OrderDiscountID, OrderID, BusinessID, Amount, Reason, ApprovedByEmployeeID, StaffEmployeeID)
    VALUES (UUID(), pOrder, pBusiness, vAmount, vReason, pApprover, vStaff);
END$$

CREATE PROCEDURE ApplyRefundDecision(IN pBusiness CHAR(36), IN pActor CHAR(36), IN pApprover CHAR(36), IN pRefund CHAR(36), IN pApprove BOOLEAN)
BEGIN
    DECLARE vOrder CHAR(36);
    DECLARE vLocation CHAR(36);
    DECLARE vReturn CHAR(36);
    DECLARE vPayment CHAR(36);
    DECLARE vStatus INT;
    DECLARE vOrderStatus INT;
    DECLARE vPaymentStatus INT;
    DECLARE vAmount DECIMAL(10,2);
    DECLARE vTax DECIMAL(10,2);
    DECLARE vOrderNet DECIMAL(10,2);
    DECLARE vOrderTax DECIMAL(10,2);
    DECLARE vPaid DECIMAL(10,2);
    DECLARE vOther DECIMAL(12,2);
    DECLARE vOtherNet DECIMAL(12,2);
    DECLARE vOtherTax DECIMAL(12,2);
    DECLARE vReturnNet DECIMAL(12,2);
    DECLARE vReturnTax DECIMAL(12,2);
    DECLARE vBreaks BOOLEAN;
    DECLARE vOpen INT;
    IF NOT ApprovalPermission(pActor, pBusiness, 2) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Your role cannot refund orders.';
    END IF;
    SELECT OrderID INTO vOrder FROM Refund WHERE RefundID = pRefund AND BusinessID = pBusiness;
    IF vOrder IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'That refund is not waiting any more.';
    END IF;
    -- Parent order first serializes all refunds against the same payment and merchandise.
    SELECT LocationID, OrderStatusCode, Total - Tax, Tax INTO vLocation, vOrderStatus, vOrderNet, vOrderTax
      FROM Orders WHERE OrderID = vOrder AND BusinessID = pBusiness FOR UPDATE;
    SELECT ReturnID, PaymentID, RefundStatusCode, Amount, TaxAmount INTO vReturn, vPayment, vStatus, vAmount, vTax
      FROM Refund WHERE RefundID = pRefund AND BusinessID = pBusiness FOR UPDATE;
    IF vStatus <> 1 OR vOrderStatus NOT IN (5, 7) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'That refund is not waiting any more.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM EmployeeLocation WHERE EmployeeID = pActor AND LocationID = vLocation AND Active) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'You do not work at that order location.';
    END IF;
    IF NOT pApprove THEN
        IF NOT ApprovalPermission(pActor, pBusiness, 3) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Your role cannot reject refunds.';
        END IF;
        UPDATE Refund SET RefundStatusCode = 3, UpdatedBy = pActor WHERE RefundID = pRefund;
        DELETE FROM ReturnItem WHERE ReturnID = vReturn;
    ELSE
        IF NOT (ApprovalPermission(pApprover, pBusiness, 3) OR ApprovalPermission(pApprover, pBusiness, 4)) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The approver cannot approve refunds.';
        END IF;
        SELECT (b.RefundOverrideAmount IS NOT NULL AND vAmount > b.RefundOverrideAmount)
               OR COALESCE(COALESCE(o.CompletedAt, o.OrderDateTime) < UTC_TIMESTAMP() - INTERVAL b.RefundOverrideDays DAY, FALSE)
          INTO vBreaks FROM Business b JOIN Orders o ON o.OrderID = vOrder WHERE b.BusinessID = pBusiness;
        IF vBreaks AND NOT ApprovalPermission(pApprover, pBusiness, 3) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This refund breaks a refund rule; a manager must sign the override.';
        END IF;
        SELECT Amount, PaymentStatusCode INTO vPaid, vPaymentStatus FROM Payment
          WHERE PaymentID = vPayment AND OrderID = vOrder FOR UPDATE;
        SELECT COALESCE(SUM(Amount), 0) INTO vOther FROM Refund
          WHERE PaymentID = vPayment AND RefundID <> pRefund AND RefundStatusCode <> 3 FOR UPDATE;
        IF vPaid IS NULL OR vPaymentStatus NOT IN (3, 5) OR vAmount + vOther > vPaid THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No payment on this order has enough left to refund.';
        END IF;
        SELECT COALESCE(SUM(Amount - TaxAmount), 0), COALESCE(SUM(TaxAmount), 0) INTO vOtherNet, vOtherTax
          FROM Refund WHERE OrderID = vOrder AND RefundID <> pRefund AND RefundStatusCode <> 3 FOR UPDATE;
        IF vOtherNet + vAmount - vTax > vOrderNet OR vOtherTax + vTax > vOrderTax THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Refunds would exceed the merchandise or tax collected.';
        END IF;
        SELECT COALESCE(SUM(ROUND(oi.NetAmount * ri.QuantityReturned / oi.Quantity, 2)), 0),
               COALESCE(SUM(ROUND(oi.TaxAmount * ri.QuantityReturned / oi.Quantity, 2)), 0)
          INTO vReturnNet, vReturnTax FROM ReturnItem ri JOIN OrderItem oi ON oi.OrderItemID = ri.OrderItemID
          WHERE ri.ReturnID = vReturn;
        IF vReturn IS NOT NULL AND (vAmount - vTax > vReturnNet OR vTax > vReturnTax) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Refund exceeds the returned items value.';
        END IF;
        IF EXISTS (SELECT 1 FROM ReturnItem ri JOIN OrderItem oi ON oi.OrderItemID = ri.OrderItemID
                   JOIN ProductVariant v ON v.VariantID = oi.VariantID
                   WHERE ri.ReturnID = vReturn AND ri.QuantityRestocked > 0 AND NOT v.RestockOnReturn) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'That item cannot go back to stock.';
        END IF;
        INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                          QuantityChange, UnitCost, TransactionTypeCode, OrderID)
        SELECT UUID(), c.BusinessID, c.StockItemID, vLocation, pActor,
               ROUND(c.QuantityUsed * ri.QuantityRestocked / oi.Quantity, 3), c.UnitCost, 3, vOrder
          FROM ReturnItem ri JOIN OrderItem oi ON oi.OrderItemID = ri.OrderItemID
          JOIN OrderItemComponent c ON c.OrderItemID = oi.OrderItemID
          WHERE ri.ReturnID = vReturn AND ROUND(c.QuantityUsed * ri.QuantityRestocked / oi.Quantity, 3) > 0;
        UPDATE Returns SET ApprovedByEmployeeID = pApprover, UpdatedBy = pActor WHERE ReturnID = vReturn;
        UPDATE Refund SET RefundStatusCode = 2, RefundDateTime = UTC_TIMESTAMP(), ApprovedByEmployeeID = pApprover, UpdatedBy = pActor
          WHERE RefundID = pRefund;
        IF vOther + vAmount = vPaid THEN
            UPDATE Payment SET PaymentStatusCode = 5 WHERE PaymentID = vPayment;
        END IF;
        SELECT COUNT(*) INTO vOpen FROM OrderItem oi WHERE oi.OrderID = vOrder
          AND oi.Quantity > COALESCE((SELECT SUM(ri.QuantityReturned) FROM ReturnItem ri WHERE ri.OrderItemID = oi.OrderItemID), 0);
        IF vOpen = 0 AND vOrderStatus = 5 THEN
            UPDATE Orders SET OrderStatusCode = 7 WHERE OrderID = vOrder;
            INSERT INTO OrderStatusHistory (OrderStatusHistoryID, OrderID, BusinessID, OrderStatusCode, ChangedByEmployeeID)
            VALUES (UUID(), vOrder, pBusiness, 7, pActor);
        END IF;
    END IF;
END$$

CREATE PROCEDURE ApplyTimecardDecision(IN pBusiness CHAR(36), IN pActor CHAR(36), IN pEntry CHAR(36), IN pType VARCHAR(32), IN pData JSON)
BEGIN
    DECLARE vPeriod CHAR(36);
    DECLARE vEmployee CHAR(36);
    DECLARE vLocation CHAR(36);
    DECLARE vStatus INT;
    DECLARE vClosed BOOLEAN;
    DECLARE vStart DATE;
    DECLARE vEnd DATE;
    DECLARE vZone VARCHAR(64);
    DECLARE vIn DATETIME;
    DECLARE vOut DATETIME;
    DECLARE vBreak INT;
    DECLARE vLock CHAR(36);
    IF NOT ApprovalPermission(pActor, pBusiness, 18) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Your role cannot approve timecards.';
    END IF;
    SELECT PayPeriodID, EmployeeID, LocationID INTO vPeriod, vEmployee, vLocation
      FROM TimeEntry WHERE TimeEntryID = pEntry AND BusinessID = pBusiness;
    IF vPeriod IS NULL OR NOT EXISTS (SELECT 1 FROM EmployeeLocation WHERE EmployeeID = pActor AND LocationID = vLocation AND Active) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'That timecard is not waiting for approval.';
    END IF;
    SELECT Closed, StartDate, EndDate INTO vClosed, vStart, vEnd FROM PayPeriod WHERE PayPeriodID = vPeriod FOR UPDATE;
    SELECT EmployeeID INTO vLock FROM Employee WHERE EmployeeID = vEmployee FOR UPDATE;
    SELECT TimeEntryStatusCode INTO vStatus FROM TimeEntry WHERE TimeEntryID = pEntry FOR UPDATE;
    IF vClosed THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'That pay period is closed.';
    END IF;
    IF pType = 'TIMECARD_EDIT' THEN
        IF vStatus NOT IN (2, 4) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'That timecard cannot be edited.';
        END IF;
        SELECT TimeZone INTO vZone FROM Location WHERE LocationID = vLocation;
        SET vIn = CONVERT_TZ(JSON_UNQUOTE(JSON_EXTRACT(pData, '$.clockIn')), vZone, '+00:00');
        SET vOut = CONVERT_TZ(JSON_UNQUOTE(JSON_EXTRACT(pData, '$.clockOut')), vZone, '+00:00');
        SET vBreak = JSON_VALUE(pData, '$.breakMinutes' RETURNING SIGNED ERROR ON ERROR);
        IF vIn IS NULL OR vOut IS NULL OR TIMESTAMPDIFF(MINUTE, vIn, vOut) <= 0 THEN
            SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 30001, MESSAGE_TEXT = 'Clock out must be after clock in.';
        END IF;
        IF vOut > UTC_TIMESTAMP() THEN
            SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 30001, MESSAGE_TEXT = 'A shift can''t end in the future.';
        END IF;
        IF JSON_TYPE(JSON_EXTRACT(pData, '$.breakMinutes')) <> 'INTEGER' OR vBreak IS NULL OR vBreak < 0 OR vBreak > TIMESTAMPDIFF(MINUTE, vIn, vOut) THEN
            SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 30001, MESSAGE_TEXT = 'Break can''t be longer than the shift.';
        END IF;
        IF DATE(CONVERT_TZ(vIn, '+00:00', vZone)) NOT BETWEEN vStart AND vEnd THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The clock-in falls outside the pay period.';
        END IF;
        IF EXISTS (SELECT 1 FROM TimeEntry WHERE EmployeeID = vEmployee AND TimeEntryID <> pEntry
                   AND ClockInAt < vOut AND vIn < COALESCE(ClockOutAt, '9999-12-31') FOR UPDATE) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'That shift overlaps another shift for this person.';
        END IF;
        UPDATE TimeEntry SET ClockInAt = vIn, ClockOutAt = vOut, UnpaidBreakMinutes = vBreak, BreakStartedAt = NULL,
                             TimeEntryStatusCode = 2, ApprovedByEmployeeID = NULL WHERE TimeEntryID = pEntry;
    ELSE
        IF vStatus <> 2 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'That timecard is not waiting for approval.';
        END IF;
        UPDATE TimeEntry SET TimeEntryStatusCode = IF(pType = 'TIMECARD_APPROVE', 3, 4),
                             ApprovedByEmployeeID = IF(pType = 'TIMECARD_APPROVE', pActor, NULL) WHERE TimeEntryID = pEntry;
    END IF;
END$$

CREATE PROCEDURE CloseApprovedPayPeriod(IN pBusiness CHAR(36), IN pActor CHAR(36), IN pLocation CHAR(36), IN pPeriod CHAR(36))
BEGIN
    DECLARE vClosed BOOLEAN;
    DECLARE vEnd DATE;
    DECLARE vZone VARCHAR(64);
    DECLARE vWaiting INT;
    DECLARE vMessage VARCHAR(128);
    IF NOT ApprovalPermission(pActor, pBusiness, 18) OR NOT EXISTS (
        SELECT 1 FROM EmployeeLocation WHERE EmployeeID = pActor AND LocationID = pLocation AND Active) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Your role cannot close this pay period.';
    END IF;
    SELECT Closed, EndDate INTO vClosed, vEnd FROM PayPeriod WHERE PayPeriodID = pPeriod AND BusinessID = pBusiness FOR UPDATE;
    IF vEnd IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 30004, MESSAGE_TEXT = 'Pay period not found.';
    END IF;
    IF vClosed THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This pay period is already closed.';
    END IF;
    SELECT TimeZone INTO vZone FROM Location WHERE LocationID = pLocation;
    IF vEnd >= DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', vZone)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This pay period has not ended yet.';
    END IF;
    SELECT COUNT(*) INTO vWaiting FROM TimeEntry WHERE PayPeriodID = pPeriod AND TimeEntryStatusCode IN (1, 2) FOR UPDATE;
    IF vWaiting > 0 THEN
        SET vMessage = CONCAT(vWaiting, IF(vWaiting = 1, ' timecard is', ' timecards are'), ' still open or waiting for approval. Approve or reject them first.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = vMessage;
    END IF;
    UPDATE PayPeriod SET Closed = TRUE WHERE PayPeriodID = pPeriod;
END$$

-- Self-service clock actions get constrained definer rights; app_user cannot edit timecards directly.
CREATE PROCEDURE ChangeTimeEntry(IN pBusiness CHAR(36), IN pEmployee CHAR(36), IN pAction VARCHAR(16))
BEGIN
    DECLARE vPeriod CHAR(36);
    DECLARE vClosed BOOLEAN;
    DECLARE vLock CHAR(36);
    DECLARE vMessage VARCHAR(128);
    SET vMessage = CASE pAction
        WHEN 'BREAK_START' THEN 'You can only start a break while clocked in and not on one.'
        WHEN 'BREAK_END' THEN 'No break is running.'
        ELSE 'You are not clocked in, or the shift started less than a second ago.' END;
    SELECT PayPeriodID INTO vPeriod FROM TimeEntry
      WHERE EmployeeID = pEmployee AND BusinessID = pBusiness AND TimeEntryStatusCode = 1 LIMIT 1;
    IF vPeriod IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = vMessage;
    END IF;
    SELECT Closed INTO vClosed FROM PayPeriod WHERE PayPeriodID = vPeriod FOR UPDATE;
    SELECT EmployeeID INTO vLock FROM Employee WHERE EmployeeID = pEmployee AND BusinessID = pBusiness AND Active FOR UPDATE;
    IF vClosed OR vLock IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'That pay period is closed or the employee is inactive.';
    END IF;
    IF pAction = 'BREAK_START' THEN
        UPDATE TimeEntry SET BreakStartedAt = UTC_TIMESTAMP()
          WHERE EmployeeID = pEmployee AND BusinessID = pBusiness AND TimeEntryStatusCode = 1
            AND ClockOutAt IS NULL AND BreakStartedAt IS NULL;
    ELSEIF pAction = 'BREAK_END' THEN
        UPDATE TimeEntry SET UnpaidBreakMinutes = UnpaidBreakMinutes + ROUND(TIMESTAMPDIFF(SECOND, BreakStartedAt, UTC_TIMESTAMP()) / 60),
                             BreakStartedAt = NULL
          WHERE EmployeeID = pEmployee AND BusinessID = pBusiness AND TimeEntryStatusCode = 1
            AND ClockOutAt IS NULL AND BreakStartedAt IS NOT NULL;
    ELSEIF pAction = 'CLOCK_OUT' THEN
        UPDATE TimeEntry SET UnpaidBreakMinutes = UnpaidBreakMinutes + COALESCE(ROUND(TIMESTAMPDIFF(SECOND, BreakStartedAt, UTC_TIMESTAMP()) / 60), 0),
                             BreakStartedAt = NULL, ClockOutAt = UTC_TIMESTAMP(), TimeEntryStatusCode = 2
          WHERE EmployeeID = pEmployee AND BusinessID = pBusiness AND TimeEntryStatusCode = 1
            AND ClockOutAt IS NULL AND ClockInAt < UTC_TIMESTAMP();
    ELSE
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Unknown clock action.';
    END IF;
    IF ROW_COUNT() = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = vMessage;
    END IF;
END$$
CREATE TRIGGER TR_ApprovalAction_AfterInsert AFTER INSERT ON ApprovalAction FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM Employee e JOIN Role r ON r.RoleID = e.RoleID AND r.Active
                   WHERE e.EmployeeID = NEW.ActorEmployeeID AND e.BusinessID = NEW.BusinessID AND e.Active) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The acting employee is inactive.';
    END IF;
    IF NEW.ActionType IN ('TIMECARD_APPROVE', 'TIMECARD_REJECT', 'TIMECARD_EDIT', 'PAY_PERIOD_CLOSE')
       AND NOT (NEW.ApproverEmployeeID <=> NEW.ActorEmployeeID) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The signed-in employee must make this decision.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM EmployeeLocation WHERE EmployeeID = NEW.ActorEmployeeID AND LocationID = NEW.LocationID AND Active) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'You do not work at this location.';
    END IF;
    CASE
        WHEN NEW.ActionType = 'DISCOUNT_APPLY' THEN
            CALL ApplyDiscountApproval(NEW.BusinessID, NEW.ActorEmployeeID, NEW.ApproverEmployeeID, NEW.TargetID, NEW.Payload);
        WHEN NEW.ActionType IN ('REFUND_APPROVE', 'REFUND_REJECT') THEN
            CALL ApplyRefundDecision(NEW.BusinessID, NEW.ActorEmployeeID, NEW.ApproverEmployeeID, NEW.TargetID, NEW.ActionType = 'REFUND_APPROVE');
        WHEN NEW.ActionType IN ('TIMECARD_APPROVE', 'TIMECARD_REJECT', 'TIMECARD_EDIT') THEN
            CALL ApplyTimecardDecision(NEW.BusinessID, NEW.ActorEmployeeID, NEW.TargetID, NEW.ActionType, NEW.Payload);
        WHEN NEW.ActionType = 'PAY_PERIOD_CLOSE' THEN
            CALL CloseApprovedPayPeriod(NEW.BusinessID, NEW.ActorEmployeeID, NEW.LocationID, NEW.TargetID);
        ELSE
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Unknown approval action.';
    END CASE;
END$$
DELIMITER ;
GRANT EXECUTE ON PROCEDURE miniworld.ChangeTimeEntry TO 'app_user'@'%';