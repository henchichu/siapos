#!/bin/sh
set -e

# Runs after all seeds: stock that starts out already low, and is never updated again, still gets its alert.
MYSQL_PWD="$(cat /run/secrets/db_root_password)" mysql -uroot <<'SQL'
USE miniworld;

-- Seeded orders have no number yet: number them per business in time order.
UPDATE Orders o JOIN (SELECT OrderID, ROW_NUMBER() OVER (PARTITION BY BusinessID ORDER BY OrderDateTime, OrderID) rn
                        FROM Orders WHERE OrderNumber IS NULL) r ON r.OrderID = o.OrderID
   SET o.OrderNumber = r.rn;
UPDATE Business b SET LastOrderNumber = COALESCE((SELECT MAX(OrderNumber) FROM Orders o WHERE o.BusinessID = b.BusinessID), 0), UpdatedAt = UpdatedAt;

-- Every customer is a member: seeded customers join at the lowest tier, as a sign-up does (server/customer.js).
INSERT INTO LoyaltyAccount (LoyaltyAccountID, CustomerID, TierID, BusinessID)
SELECT UUID(), c.CustomerID, (SELECT t.TierID FROM MembershipTier t WHERE t.BusinessID = c.BusinessID ORDER BY t.MinimumPoints, t.Name LIMIT 1), c.BusinessID
  FROM Customer c
 WHERE NOT EXISTS (SELECT 1 FROM LoyaltyAccount la WHERE la.CustomerID = c.CustomerID)
   AND EXISTS (SELECT 1 FROM MembershipTier t WHERE t.BusinessID = c.BusinessID);

-- Run after demo seeds too, so new rows with no subsequent stock movement are covered.
INSERT INTO LowStockAlert (InventoryID)
SELECT InventoryID FROM Inventory WHERE ReorderThreshold > 0 AND Quantity <= ReorderThreshold
ON DUPLICATE KEY UPDATE InventoryID = VALUES(InventoryID);

DELETE a FROM LowStockAlert a JOIN Inventory i ON i.InventoryID = a.InventoryID
WHERE i.ReorderThreshold = 0 OR i.Quantity > i.ReorderThreshold;
SQL

# Mark ready only after every initialization step succeeded.
touch /var/lib/mysql/.siapos-ready
