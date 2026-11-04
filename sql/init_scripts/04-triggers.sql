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

-- Approvals: the backend records each manager's decision in ApprovalAction and carries it out (server/approvals.js).
-- This trigger only queues it for the worker; the work itself is JavaScript.
DELIMITER $$
CREATE TRIGGER TR_ApprovalAction_AfterInsert AFTER INSERT ON ApprovalAction FOR EACH ROW
BEGIN
    INSERT INTO NotificationQueue (EntityName, EntityID, ActionType, NewData)
    VALUES ('ApprovalAction', NEW.ApprovalActionID, NEW.ActionType,
            JSON_OBJECT('businessId', NEW.BusinessID, 'actorId', NEW.ActorEmployeeID, 'approverId', NEW.ApproverEmployeeID,
                        'locationId', NEW.LocationID, 'targetId', NEW.TargetID, 'payload', NEW.Payload));
END$$
DELIMITER ;
