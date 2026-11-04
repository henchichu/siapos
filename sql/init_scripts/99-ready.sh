#!/bin/sh
set -e

# Runs after all seeds; SQL imports can rerun the backfill in sql/provision/low-stock-alerts.sql.
MYSQL_PWD="$(cat /run/secrets/db_root_password)" mysql -uroot <<'SQL'
USE miniworld;

-- Run after demo seeds too, so new rows with no subsequent stock movement are covered.
INSERT INTO LowStockAlert (InventoryID)
SELECT InventoryID FROM Inventory WHERE ReorderThreshold > 0 AND Quantity <= ReorderThreshold
ON DUPLICATE KEY UPDATE InventoryID = VALUES(InventoryID);

DELETE a FROM LowStockAlert a JOIN Inventory i ON i.InventoryID = a.InventoryID
WHERE i.ReorderThreshold = 0 OR i.Quantity > i.ReorderThreshold;
SQL

# Mark ready only after every initialization step succeeded.
touch /var/lib/mysql/.siapos-ready
