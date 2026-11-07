USE miniworld;

DELIMITER $$

-- Low Stock Alerts
CREATE TRIGGER TR_Inventory_AfterUpdate AFTER UPDATE ON Inventory FOR EACH ROW
BEGIN
    IF NEW.ReorderThreshold > 0 AND NEW.Quantity <= NEW.ReorderThreshold THEN
        INSERT INTO LowStockAlert (InventoryID) VALUES (NEW.InventoryID)
        ON DUPLICATE KEY UPDATE InventoryID = NEW.InventoryID;
    ELSE
        DELETE FROM LowStockAlert WHERE InventoryID = NEW.InventoryID;
    END IF;
END$$

-- Approvals: the backend records each manager's decision in ApprovalAction and carries it out (server/approvals.js).
DELIMITER $$
CREATE TRIGGER TR_ApprovalAction_AfterInsert AFTER INSERT ON ApprovalAction FOR EACH ROW
BEGIN
    INSERT INTO NotificationQueue (EntityName, EntityID, ActionType, NewData)
    VALUES ('ApprovalAction', NEW.ApprovalActionID, NEW.ActionType,
            JSON_OBJECT('businessId', NEW.BusinessID, 'actorId', NEW.ActorEmployeeID, 'approverId', NEW.ApproverEmployeeID,
                        'locationId', NEW.LocationID, 'targetId', NEW.TargetID, 'payload', NEW.Payload));
END$$

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

-- Only orders linked to a customer produce customer notifications.
CREATE TRIGGER TR_Orders_AlertInsert AFTER INSERT ON Orders FOR EACH ROW
BEGIN
    IF NEW.CustomerID IS NOT NULL THEN
        INSERT INTO OrderStatusAlert (OrderID, CustomerID, OrderStatusCode)
        VALUES (NEW.OrderID, NEW.CustomerID, NEW.OrderStatusCode);
    END IF;
END$$

CREATE TRIGGER TR_Orders_AlertUpdate AFTER UPDATE ON Orders FOR EACH ROW
BEGIN
    IF NEW.CustomerID IS NOT NULL AND NEW.OrderStatusCode <> OLD.OrderStatusCode THEN
        INSERT INTO OrderStatusAlert (OrderID, CustomerID, OrderStatusCode)
        VALUES (NEW.OrderID, NEW.CustomerID, NEW.OrderStatusCode);
    END IF;
END$$
