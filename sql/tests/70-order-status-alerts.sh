echo "--- customer order status alerts ---"
t "business" ok "INSERT INTO Business (BusinessID,Name) VALUES ('B1','Cafe');"
s "location" ok "INSERT INTO Location (LocationID,BusinessID,Name,TimeZone) VALUES ('L1','B1','Main','America/Chicago');"
t "customers" ok "INSERT INTO Customer (CustomerID,BusinessID,Email) VALUES ('C1','B1','one@example.com'),('C2','B1','two@example.com');"
t "new customer order" ok "INSERT INTO Orders (OrderID,LocationID,BusinessID,CustomerID,ChannelCode) VALUES ('O1','L1','B1','C1',3);"
a "initial status alert" "SELECT CONCAT(CustomerID,':',OrderStatusCode,':',ReadAt IS NULL) FROM OrderStatusAlert WHERE OrderID='O1';" 'C1:1:1'
t "unchanged status and note" ok "UPDATE Orders SET OrderStatusCode=1, CustomerNote='Please wait' WHERE OrderID='O1';"
a "no duplicate from unrelated update" "SELECT COUNT(*) FROM OrderStatusAlert WHERE OrderID='O1';" 1
t "status changes" ok "UPDATE Orders SET OrderStatusCode=3 WHERE OrderID='O1'; UPDATE Orders SET OrderStatusCode=4 WHERE OrderID='O1';"
a "each change retains its status" "SELECT GROUP_CONCAT(OrderStatusCode ORDER BY AlertID) FROM OrderStatusAlert WHERE OrderID='O1';" '1,3,4'
t "second customer" ok "INSERT INTO Orders (OrderID,LocationID,BusinessID,CustomerID,ChannelCode) VALUES ('O2','L1','B1','C2',3);"
a "correct recipient" "SELECT COUNT(*) FROM OrderStatusAlert WHERE OrderID='O2' AND CustomerID='C2';" 1
t "guest order" ok "INSERT INTO Orders (OrderID,LocationID,BusinessID,ChannelCode) VALUES ('O3','L1','B1',3); UPDATE Orders SET OrderStatusCode=3 WHERE OrderID='O3';"
a "no guest alerts" "SELECT COUNT(*) FROM OrderStatusAlert WHERE OrderID='O3';" 0
t "transaction rollback" ok "START TRANSACTION; UPDATE Orders SET OrderStatusCode=6 WHERE OrderID='O1'; ROLLBACK;"
a "rolled back alert is absent" "SELECT COUNT(*) FROM OrderStatusAlert WHERE OrderID='O1';" 3
t "mark read" ok "UPDATE OrderStatusAlert SET ReadAt=UTC_TIMESTAMP() WHERE OrderID='O1';"
t "cannot forge an alert" fail "INSERT INTO OrderStatusAlert (OrderID,CustomerID,OrderStatusCode) VALUES ('O2','C2',4);"
t "cannot change recipient" fail "UPDATE OrderStatusAlert SET CustomerID='C2' WHERE OrderID='O1';"
t "cannot erase alerts" fail "DELETE FROM OrderStatusAlert WHERE OrderID='O1';"
