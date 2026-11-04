-- Stop application writers during this upgrade. Run as root:
-- docker compose exec -T mysql-db sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mysql -uroot' < sql/provision/low-stock-alerts.sql
-- This targeted migration preserves existing trigger definitions for other tables.
USE miniworld;

CREATE TABLE IF NOT EXISTS LowStockAlert (
    InventoryID CHAR(36) NOT NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (InventoryID),
    CONSTRAINT FK_LowStockAlert_Inventory FOREIGN KEY (InventoryID)
        REFERENCES Inventory(InventoryID) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- shortcut: SQL inventory imports need the backfill below; revisit insert handling when adding import writers.
DROP TRIGGER IF EXISTS TR_Inventory_AfterUpdate;
DELIMITER $$
CREATE TRIGGER TR_Inventory_AfterUpdate AFTER UPDATE ON Inventory FOR EACH ROW
BEGIN
    IF NEW.ReorderThreshold > 0 AND NEW.Quantity <= NEW.ReorderThreshold THEN
        INSERT INTO LowStockAlert (InventoryID) VALUES (NEW.InventoryID)
        ON DUPLICATE KEY UPDATE InventoryID = NEW.InventoryID;
    ELSE
        DELETE FROM LowStockAlert WHERE InventoryID = NEW.InventoryID;
    END IF;
END$$
DELIMITER ;

USE miniworld;

-- Run after demo seeds too, so new rows with no subsequent stock movement are covered.
INSERT INTO LowStockAlert (InventoryID)
SELECT InventoryID FROM Inventory WHERE ReorderThreshold > 0 AND Quantity <= ReorderThreshold
ON DUPLICATE KEY UPDATE InventoryID = VALUES(InventoryID);

DELETE a FROM LowStockAlert a JOIN Inventory i ON i.InventoryID = a.InventoryID
WHERE i.ReorderThreshold = 0 OR i.Quantity > i.ReorderThreshold;
GRANT SELECT, INSERT ON miniworld.LowStockAlert TO 'app_user'@'%';
