-- Changes the app no longer has screens for. Copy the statement you need, fill in the values, run it against the live database:
--   docker compose exec mysql-db sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mysql -uroot miniworld'
-- Look up ids first (SELECT RoleID, Name FROM Role; SELECT LocationID, Name FROM Location; ...). Ids are UUIDs.
-- The database refuses changes that break its rules (an overlapping pay rate, a shift in a closed pay period) with a plain message.

-- ---- employees ---------------------------------------------------------------------------------------------------
-- Add one. PIN hash: node sql/provision/hash-pin.js 246810. Number: 8 digits, unique. Pay rate: dollars an hour.
SET @emp = UUID();
INSERT INTO Employee (EmployeeID, BusinessID, FirstName, LastName, Email, EmployeeNumber, RoleID)
VALUES (@emp, '<business id>', 'First', 'Last', 'name@example.com', '<8 digits>', '<role id>');
INSERT INTO EmployeeCredential (EmployeeID, PinHash) VALUES (@emp, '<pin hash>');
INSERT INTO EmployeeLocation (EmployeeID, LocationID, BusinessID) VALUES (@emp, '<location id>', '<business id>');
INSERT INTO EmployeePayRate (PayRateID, EmployeeID, BusinessID, HourlyRate, EffectiveFrom) VALUES (UUID(), @emp, '<business id>', 15.00, UTC_TIMESTAMP());

-- Switch someone off (they are signed out within the minute and cannot sign in), or back on
UPDATE Employee SET Active = FALSE WHERE EmployeeNumber = '<8 digits>';

-- A new PIN, and clear a lockout after five wrong PINs
UPDATE EmployeeCredential c JOIN Employee e USING (EmployeeID)
   SET c.PinHash = '<pin hash>', c.FailedPinAttempts = 0, c.LockedUntil = NULL WHERE e.EmployeeNumber = '<8 digits>';
UPDATE EmployeeCredential c JOIN Employee e USING (EmployeeID)
   SET c.FailedPinAttempts = 0, c.LockedUntil = NULL WHERE e.EmployeeNumber = '<8 digits>';

-- A raise: end the current rate, start the new one (rates may not overlap)
UPDATE EmployeePayRate SET EffectiveTo = UTC_TIMESTAMP() WHERE EmployeeID = '<employee id>' AND EffectiveTo IS NULL;
INSERT INTO EmployeePayRate (PayRateID, EmployeeID, BusinessID, HourlyRate, EffectiveFrom) VALUES (UUID(), '<employee id>', '<business id>', 16.00, UTC_TIMESTAMP());

-- Move someone to another role, or give them another café (they sign in to the first one alphabetically)
UPDATE Employee SET RoleID = '<role id>' WHERE EmployeeNumber = '<8 digits>';
INSERT INTO EmployeeLocation (EmployeeID, LocationID, BusinessID) VALUES ('<employee id>', '<location id>', '<business id>');

-- ---- roles -------------------------------------------------------------------------------------------------------
-- Permission codes: SELECT * FROM Permission. Changes apply at the person's next sign-in.
INSERT INTO RolePermission (RoleID, BusinessID, PermissionCode) VALUES ('<role id>', '<business id>', 12);
DELETE FROM RolePermission WHERE RoleID = '<role id>' AND PermissionCode = 12;
INSERT INTO Role (RoleID, BusinessID, Name, OpensTo) VALUES (UUID(), '<business id>', 'Shift lead', 'REGISTER');   -- OpensTo: REGISTER, KITCHEN or SHIFT

-- ---- cafés, registers, tax ---------------------------------------------------------------------------------------
-- A new café needs its tax rates before it can take a sale; every tax category needs a row.
INSERT INTO Location (LocationID, BusinessID, Name, Address, Phone, TimeZone, AcceptsOnlineOrders)
VALUES (UUID(), '<business id>', 'Name', 'Address', '312-555-0102', 'America/Chicago', FALSE);
INSERT INTO Register (RegisterID, LocationID, Name) VALUES (UUID(), '<location id>', 'Counter');
INSERT INTO LocationTaxRate (LocationID, TaxCategoryID, BusinessID, Rate)
SELECT '<location id>', TaxCategoryID, BusinessID, 0.082500 FROM TaxCategory WHERE BusinessID = '<business id>';
UPDATE LocationTaxRate SET Rate = 0.090000 WHERE LocationID = '<location id>' AND TaxCategoryID = '<tax category id>';   -- 0.09 = 9%
UPDATE Location SET AcceptsOnlineOrders = TRUE WHERE LocationID = '<location id>';
UPDATE Location SET Active = FALSE WHERE LocationID = '<location id>';       -- reassign its staff first
-- The café's order link is https://<KIOSK_HOST>/order/<location id>

-- ---- business settings and menu categories -----------------------------------------------------------------------
-- Refund limits (NULL turns one off): a manager must sign a refund over this amount, or on an order older than this many days
UPDATE Business SET RefundOverrideAmount = 25.00, RefundOverrideDays = 7 WHERE BusinessID = '<business id>';
-- Staff discounts: whether they need a manager's signature, and the largest percent without one
UPDATE Business SET StaffDiscountsNeedApproval = FALSE, StaffDiscountMaxPercent = 20.00 WHERE BusinessID = '<business id>';
INSERT INTO Category (CategoryID, BusinessID, Name) VALUES (UUID(), '<business id>', 'Coffee');
UPDATE Category SET Name = 'Hot drinks' WHERE CategoryID = '<category id>';

-- ---- pay periods -------------------------------------------------------------------------------------------------
-- provision.sql makes 26 (a year). When they run out, nobody can clock in: add the next year, starting the day after the last ends.
SELECT MAX(EndDate) AS last_end FROM PayPeriod WHERE BusinessID = '<business id>';
INSERT INTO PayPeriod (PayPeriodID, BusinessID, StartDate, EndDate)
WITH RECURSIVE n (i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 25)
SELECT UUID(), '<business id>', '<last_end>' + INTERVAL 1 DAY + INTERVAL i * 14 DAY, '<last_end>' + INTERVAL 14 DAY + INTERVAL i * 14 DAY FROM n;
