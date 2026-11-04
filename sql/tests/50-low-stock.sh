s "low-stock setup" ok "INSERT INTO Business (BusinessID,Name) VALUES ('B1','Cafe'); INSERT INTO Location (LocationID,BusinessID,Name,TimeZone) VALUES ('L1','B1','Main','America/Chicago'); INSERT INTO StockItem (StockItemID,BusinessID,Name,StockUnitCode) VALUES ('S1','B1','Beans',2);"
t "new inventory" ok "INSERT INTO Inventory (InventoryID,LocationID,StockItemID,BusinessID,ReorderThreshold) VALUES ('I1','L1','S1','B1',10);"
t "backend initializes alert" ok "INSERT INTO LowStockAlert (InventoryID) SELECT InventoryID FROM Inventory WHERE LocationID='L1' AND StockItemID='S1';"
a "new empty item is low" "SELECT COUNT(*) FROM LowStockAlert" 1
s "timestamp fixture" ok "UPDATE LowStockAlert SET CreatedAt='2000-01-01' WHERE InventoryID='I1';"
t "restock to threshold" ok "INSERT INTO InventoryTransaction (InventoryTransactionID,BusinessID,StockItemID,LocationID,QuantityChange,UnitCost,TransactionTypeCode) VALUES ('T1','B1','S1','L1',10,1,1);"
a "threshold equality remains low" "SELECT COUNT(*) FROM LowStockAlert" 1
a "repeated low update preserves timestamp" "SELECT YEAR(CreatedAt) FROM LowStockAlert WHERE InventoryID='I1'" 2000
t "restock above threshold" ok "INSERT INTO InventoryTransaction (InventoryTransactionID,BusinessID,StockItemID,LocationID,QuantityChange,UnitCost,TransactionTypeCode) VALUES ('T2','B1','S1','L1',1,1,1);"
a "restock clears alert" "SELECT COUNT(*) FROM LowStockAlert" 0
t "raising threshold creates alert" ok "UPDATE Inventory SET ReorderThreshold=12 WHERE InventoryID='I1';"
a "threshold edit detected" "SELECT COUNT(*) FROM LowStockAlert" 1
t "rollback threshold edit" ok "START TRANSACTION; UPDATE Inventory SET ReorderThreshold=0 WHERE InventoryID='I1'; ROLLBACK;"
a "rollback restores alert" "SELECT COUNT(*) FROM LowStockAlert" 1
t "disable monitoring" ok "UPDATE Inventory SET ReorderThreshold=0 WHERE InventoryID='I1';"
a "disabled clears alert" "SELECT COUNT(*) FROM LowStockAlert" 0
t "rollback new alert" ok "START TRANSACTION; UPDATE Inventory SET ReorderThreshold=20 WHERE InventoryID='I1'; ROLLBACK;"
a "rollback removes new alert" "SELECT COUNT(*) FROM LowStockAlert" 0
t "app cannot dismiss alerts directly" fail "DELETE FROM LowStockAlert;"
t "app cannot edit alert history" fail "UPDATE LowStockAlert SET CreatedAt=NOW();"