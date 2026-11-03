
-- ---- employees ---------------------------------------------------------------------------------------------------
SET @emp = UUID();
INSERT INTO Employee (EmployeeID, BusinessID, FirstName, LastName, Email, EmployeeNumber, RoleID)
VALUES (@emp, '<business id>', 'First', 'Last', 'name@example.com', '<8 digits>', '<role id>');
INSERT INTO EmployeeCredential (EmployeeID, PasswordHash, PinHash) VALUES (@emp, '<password hash>', '<pin hash, or NULL>');
INSERT INTO EmployeeLocation (EmployeeID, LocationID, BusinessID) VALUES (@emp, '<location id>', '<business id>');
INSERT INTO EmployeePayRate (PayRateID, EmployeeID, BusinessID, HourlyRate, EffectiveFrom) VALUES (UUID(), @emp, '<business id>', 15.00, UTC_TIMESTAMP());

-- Switch someone off (they are signed out within the minute and cannot sign in), or back on
UPDATE Employee SET Active = FALSE WHERE EmployeeNumber = '<8 digits>';

-- A new password (this also clears a lockout), a new approval PIN, or just clear a lockout after five wrong passwords
UPDATE EmployeeCredential c JOIN Employee e USING (EmployeeID)
   SET c.PasswordHash = '<password hash>', c.FailedPinAttempts = 0, c.LockedUntil = NULL WHERE e.Email = '<email>';
UPDATE EmployeeCredential c JOIN Employee e USING (EmployeeID)
   SET c.PinHash = '<pin hash>' WHERE e.EmployeeNumber = '<8 digits>';
UPDATE EmployeeCredential c JOIN Employee e USING (EmployeeID)
   SET c.FailedPinAttempts = 0, c.LockedUntil = NULL WHERE e.Email = '<email>';
-- Change an email (the sign-in name)
UPDATE Employee SET Email = '<new email>' WHERE EmployeeNumber = '<8 digits>';

-- A raise: end the current rate, start the new one (rates may not overlap)
UPDATE EmployeePayRate SET EffectiveTo = UTC_TIMESTAMP() WHERE EmployeeID = '<employee id>' AND EffectiveTo IS NULL;
INSERT INTO EmployeePayRate (PayRateID, EmployeeID, BusinessID, HourlyRate, EffectiveFrom) VALUES (UUID(), '<employee id>', '<business id>', 16.00, UTC_TIMESTAMP());

-- Move someone to another role, or give them another café (they sign in to the first one alphabetically)
UPDATE Employee SET RoleID = '<role id>' WHERE EmployeeNumber = '<8 digits>';
INSERT INTO EmployeeLocation (EmployeeID, LocationID, BusinessID) VALUES ('<employee id>', '<location id>', '<business id>');

-- ---- roles -------------------------------------------------------------------------------------------------------
INSERT INTO RolePermission (RoleID, BusinessID, PermissionCode) VALUES ('<role id>', '<business id>', 12);
DELETE FROM RolePermission WHERE RoleID = '<role id>' AND PermissionCode = 12;
INSERT INTO Role (RoleID, BusinessID, Name, OpensTo) VALUES (UUID(), '<business id>', 'Shift lead', 'REGISTER');   -- OpensTo: REGISTER, KITCHEN or SHIFT

-- ---- customers who sign in to the kiosk ---------------------------------------------------------------------------------
INSERT INTO CustomerCredential (CustomerID, PasswordHash) VALUES ('<customer id>', '<password hash>');
UPDATE CustomerCredential SET PasswordHash = '<password hash>', FailedAttempts = 0, LockedUntil = NULL WHERE CustomerID = '<customer id>';   -- new password
UPDATE CustomerCredential SET FailedAttempts = 0, LockedUntil = NULL WHERE CustomerID = '<customer id>';                                      -- unlock
DELETE FROM CustomerCredential WHERE CustomerID = '<customer id>';                                                                            -- no more sign-in

-- ---- cafés, registers, tax ---------------------------------------------------------------------------------------
INSERT INTO Location (LocationID, BusinessID, Name, Address, Phone, TimeZone)
VALUES (UUID(), '<business id>', 'Name', 'Address', '312-555-0102', 'America/Chicago');
INSERT INTO Register (RegisterID, LocationID, Name) VALUES (UUID(), '<location id>', 'Counter');
INSERT INTO LocationTaxRate (LocationID, TaxCategoryID, BusinessID, Rate)
SELECT '<location id>', TaxCategoryID, BusinessID, 0.082500 FROM TaxCategory WHERE BusinessID = '<business id>';
UPDATE LocationTaxRate SET Rate = 0.090000 WHERE LocationID = '<location id>' AND TaxCategoryID = '<tax category id>';   -- 0.09 = 9%
UPDATE Location SET Active = FALSE WHERE LocationID = '<location id>';       -- reassign its staff first

-- ---- business settings and menu categories -----------------------------------------------------------------------
UPDATE Business SET RefundOverrideAmount = 25.00, RefundOverrideDays = 7 WHERE BusinessID = '<business id>';
-- Staff discounts: whether they need a manager's signature, and the largest percent without one
UPDATE Business SET StaffDiscountsNeedApproval = FALSE, StaffDiscountMaxPercent = 20.00 WHERE BusinessID = '<business id>';
INSERT INTO Category (CategoryID, BusinessID, Name) VALUES (UUID(), '<business id>', 'Coffee');
UPDATE Category SET Name = 'Hot drinks' WHERE CategoryID = '<category id>';

-- ---- pay periods -------------------------------------------------------------------------------------------------
SELECT MAX(EndDate) AS last_end FROM PayPeriod WHERE BusinessID = '<business id>';
INSERT INTO PayPeriod (PayPeriodID, BusinessID, StartDate, EndDate)
WITH RECURSIVE n (i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 25)
SELECT UUID(), '<business id>', '<last_end>' + INTERVAL 1 DAY + INTERVAL i * 14 DAY, '<last_end>' + INTERVAL 14 DAY + INTERVAL i * 14 DAY FROM n;
