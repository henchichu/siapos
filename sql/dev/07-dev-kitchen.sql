USE miniworld;

-- DEV ONLY. A few open tickets at Campus (where Jordan works) so the kitchen screen has something on it:
-- two New, two Preparing, one Ready, plus one stock loss reported today.
SET @biz = 'biz-brewbean';

-- Campus stopped taking online orders at the end of 05-dev-seed.sql; switch it on just for this insert
UPDATE Location SET AcceptsOnlineOrders = TRUE WHERE LocationID = 'loc-campus';

INSERT INTO Orders (OrderID, LocationID, BusinessID, RegisterID, EmployeeID, CustomerID, ChannelCode, OrderDateTime, PickupAt, CustomerNote, OrderStatusCode)
VALUES
    ('ord-kds-1', 'loc-campus', @biz, NULL,       NULL,        'cus-ava', 2, UTC_TIMESTAMP() - INTERVAL 6 MINUTE,  UTC_TIMESTAMP() + INTERVAL 14 MINUTE, 'Extra hot, please', 2),
    ('ord-kds-2', 'loc-campus', @biz, 'reg-cp-1', 'emp-priya', NULL,       1, UTC_TIMESTAMP() - INTERVAL 3 MINUTE,  NULL, NULL, 2),
    ('ord-kds-3', 'loc-campus', @biz, 'reg-cp-1', 'emp-priya', 'cus-ben',  1, UTC_TIMESTAMP() - INTERVAL 11 MINUTE, NULL, NULL, 3),
    ('ord-kds-4', 'loc-campus', @biz, NULL,       NULL,        'cus-chloe', 2, UTC_TIMESTAMP() - INTERVAL 15 MINUTE, UTC_TIMESTAMP() + INTERVAL 5 MINUTE, NULL, 3),
    ('ord-kds-5', 'loc-campus', @biz, 'reg-cp-1', 'emp-priya', NULL,       1, UTC_TIMESTAMP() - INTERVAL 20 MINUTE, NULL, NULL, 4);

UPDATE Location SET AcceptsOnlineOrders = FALSE WHERE LocationID = 'loc-campus';

INSERT INTO OrderItem (OrderItemID, OrderID, VariantID, BusinessID, Quantity, UnitPrice, LineTotal, TaxCategoryID, TaxRate, TaxAmount)
VALUES
    ('kds-1-0', 'ord-kds-1', 'var-latte-l',   @biz, 2, 6.00, 12.00, 'tax-prepared', 0.1025, 1.23),
    ('kds-1-1', 'ord-kds-1', 'var-croissant', @biz, 1, 3.50,  3.50, 'tax-prepared', 0.1025, 0.36),
    ('kds-2-0', 'ord-kds-2', 'var-chai',      @biz, 1, 4.75,  4.75, 'tax-prepared', 0.1025, 0.49),
    ('kds-3-0', 'ord-kds-3', 'var-amer-s',    @biz, 1, 3.25,  3.25, 'tax-prepared', 0.1025, 0.33),
    ('kds-3-1', 'ord-kds-3', 'var-latte-s',   @biz, 3, 4.25, 12.75, 'tax-prepared', 0.1025, 1.31),
    ('kds-4-0', 'ord-kds-4', 'var-muffin',    @biz, 1, 3.25,  3.25, 'tax-prepared', 0.1025, 0.33),
    ('kds-5-0', 'ord-kds-5', 'var-amer-l',    @biz, 1, 3.75,  3.75, 'tax-prepared', 0.1025, 0.38);

INSERT INTO OrderItemModifier (OrderItemID, ModifierID, BusinessID, PriceDelta)
VALUES
    ('kds-1-0', 'mod-oat', @biz, 0.50),
    ('kds-1-0', 'mod-extra-shot', @biz, 0.75),
    ('kds-3-1', 'mod-vanilla', @biz, 0.00);

UPDATE Orders o
   SET Subtotal = (SELECT SUM(LineTotal) FROM OrderItem WHERE OrderID = o.OrderID),
       Tax      = (SELECT SUM(TaxAmount) FROM OrderItem WHERE OrderID = o.OrderID),
       Total    = (SELECT SUM(LineTotal + TaxAmount) FROM OrderItem WHERE OrderID = o.OrderID)
 WHERE o.OrderID LIKE 'ord-kds-%';

-- Copied out first: the payment trigger locks Orders, which the INSERT's own SELECT can't also read
CREATE TEMPORARY TABLE _kds_total AS SELECT OrderID, Total FROM Orders WHERE OrderID LIKE 'ord-kds-%';
INSERT INTO Payment (PaymentID, OrderID, PaymentMethodCode, Amount, PaymentStatusCode)
SELECT CONCAT('pay-', OrderID), OrderID, 2, Total, 3 FROM _kds_total;
DROP TEMPORARY TABLE _kds_total;

-- Like a real sale, each line records the stock it uses and the SALE ledger moves it; completing an order at pickup
-- checks both. Recipes only: modifiers don't change the stock here, which is fine for demo tickets.
CREATE TEMPORARY TABLE _kds_comp AS
SELECT oi.OrderItemID, oi.OrderID, vr.StockItemID, vr.QuantityPerUnit * oi.Quantity AS Qty, s.StockUnitCode, i.AverageUnitCost AS Cost
  FROM OrderItem oi
  JOIN VariantRecipe vr ON vr.VariantID = oi.VariantID
  JOIN StockItem s ON s.StockItemID = vr.StockItemID
  JOIN Inventory i ON i.StockItemID = vr.StockItemID AND i.LocationID = 'loc-campus'
 WHERE oi.OrderID LIKE 'ord-kds-%';
INSERT INTO OrderItemComponent (OrderItemID, StockItemID, BusinessID, QuantityUsed, StockUnitCode, UnitCost)
SELECT OrderItemID, StockItemID, @biz, Qty, StockUnitCode, Cost FROM _kds_comp;
UPDATE OrderItem oi
   SET oi.UnitCost = (SELECT ROUND(SUM(c.QuantityUsed * c.UnitCost) / oi.Quantity, 6) FROM OrderItemComponent c WHERE c.OrderItemID = oi.OrderItemID),
       oi.LineCost = ROUND(oi.Quantity * oi.UnitCost, 6)
 WHERE oi.OrderID LIKE 'ord-kds-%';
INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID, QuantityChange, UnitCost, TransactionTypeCode, OrderID)
SELECT UUID(), @biz, k.StockItemID, 'loc-campus', 'emp-priya', -SUM(k.Qty), k.Cost, 2, k.OrderID
  FROM _kds_comp k GROUP BY k.OrderID, k.StockItemID, k.Cost;
DROP TEMPORARY TABLE _kds_comp;

-- History: placed, confirmed, then started and ready by the people on shift
INSERT INTO OrderStatusHistory (OrderStatusHistoryID, OrderID, BusinessID, OrderStatusCode, ChangedAt, ChangedByEmployeeID)
SELECT CONCAT('h1-', OrderID), OrderID, @biz, 1, OrderDateTime, EmployeeID FROM Orders WHERE OrderID LIKE 'ord-kds-%'
UNION ALL
SELECT CONCAT('h2-', OrderID), OrderID, @biz, 2, OrderDateTime, EmployeeID FROM Orders WHERE OrderID LIKE 'ord-kds-%'
UNION ALL
SELECT CONCAT('h3-', OrderID), OrderID, @biz, 3, OrderDateTime + INTERVAL 2 MINUTE, 'emp-jordan' FROM Orders WHERE OrderID IN ('ord-kds-3', 'ord-kds-4', 'ord-kds-5')
UNION ALL
SELECT CONCAT('h4-', OrderID), OrderID, @biz, 4, OrderDateTime + INTERVAL 9 MINUTE, 'emp-jordan' FROM Orders WHERE OrderID = 'ord-kds-5';

-- One loss already reported today at Campus (cost read first: the ledger trigger updates Inventory)
SET @milk_cost = (SELECT AverageUnitCost FROM Inventory WHERE LocationID = 'loc-campus' AND StockItemID = 'stk-milk');
INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID, QuantityChange, UnitCost, TransactionTypeCode, Note)
VALUES ('kds-loss-1', @biz, 'stk-milk', 'loc-campus', 'emp-jordan', -500, @milk_cost, 5, 'Dropped the jug');
