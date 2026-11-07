-- Apply once to an existing database; does not backfill old orders.
USE miniworld;

-- Customer notifications are created only by the Orders triggers.
CREATE TABLE IF NOT EXISTS OrderStatusAlert (
    AlertID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    OrderID CHAR(36) NOT NULL,
    CustomerID CHAR(36) NOT NULL,
    OrderStatusCode TINYINT UNSIGNED NOT NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ReadAt DATETIME NULL,
    PRIMARY KEY (AlertID),
    CONSTRAINT FK_OrderStatusAlert_OrderCustomer FOREIGN KEY (OrderID, CustomerID)
        REFERENCES Orders(OrderID, CustomerID) ON DELETE RESTRICT,
    CONSTRAINT FK_OrderStatusAlert_Status FOREIGN KEY (OrderStatusCode)
        REFERENCES OrderStatus(OrderStatusCode) ON DELETE RESTRICT,
    INDEX IX_OrderStatusAlert_Customer_Time (CustomerID, CreatedAt, AlertID)
) ENGINE=InnoDB;

DELIMITER $$
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
DELIMITER ;
GRANT SELECT, UPDATE (ReadAt) ON miniworld.OrderStatusAlert TO 'app_user'@'%';
