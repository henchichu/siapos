-- Sets up a real business: names the seeded business and café, adds registers and the first employee.
-- Edit the values in the first block, then run it ONCE against an empty database (see README, "Setting up a business"):
--   docker compose exec -T mysql-db sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mysql -uroot' < sql/provision/provision.sql
-- Nothing in the app creates or edits these rows afterwards: use sql/provision/maintenance.sql for the changes you will need.

USE miniworld;

-- ---- edit these ----------------------------------------------------------------------------------------------------
SET @business_name   = 'Example Coffee';
SET @contact_email   = 'hello@example.com';
SET @contact_phone   = '312-555-0100';
SET @prices_include_tax = FALSE;                 -- TRUE: menu prices already contain tax

SET @location_name   = 'Example Coffee Downtown';
SET @location_addr   = '1 Main St, Chicago, IL';
SET @location_phone  = '312-555-0101';
SET @time_zone       = 'America/Chicago';        -- an IANA name MySQL knows

-- Percent, as a fraction: 0.0825 = 8.25%. One line per tax category below.
SET @rate_standard   = 0.082500;
SET @rate_exempt     = 0.000000;

-- The first employee gets every permission (the "General manager" role). They sign in with the email and password.
-- Password hash:  node sql/provision/hash-password.js 'a long password'      (8 characters or more)
-- The employee number is a non-secret ID; with the approval PIN it signs off discounts and refunds.
-- PIN hash:       node sql/provision/hash-pin.js 246810
SET @first_name      = 'Alex';
SET @last_name       = 'Morgan';
SET @first_email     = 'alex@example.com';
SET @first_number    = '10000001';
SET @password_hash   = 'PASTE-THE-OUTPUT-OF-hash-password.js-HERE';
SET @pin_hash        = 'PASTE-THE-OUTPUT-OF-hash-pin.js-HERE';

SET @first_period_start = '2026-01-05';          -- the first day of the first two-week pay period
-- ---------------------------------------------------------------------------------------------------------------------

SET @biz  = 'biz-brewbean';   -- the business, café and roles come from 02-seed.sql; this fills in their details
SET @loc  = 'loc-downtown';
SET @emp  = UUID();
SET @t_std = UUID();
SET @t_ex  = UUID();

UPDATE Business SET Name = @business_name, ContactEmail = @contact_email, ContactPhone = @contact_phone, PricesIncludeTax = @prices_include_tax
 WHERE BusinessID = @biz;

UPDATE Location SET Name = @location_name, Address = @location_addr, Phone = @location_phone, TimeZone = @time_zone
 WHERE LocationID = @loc;

INSERT INTO Register (RegisterID, LocationID, Name) VALUES (UUID(), @loc, 'Counter');   -- add more rows for more registers

INSERT INTO TaxCategory (TaxCategoryID, BusinessID, Name)
VALUES (@t_std, @biz, 'Standard'), (@t_ex, @biz, 'Exempt');

INSERT INTO LocationTaxRate (LocationID, TaxCategoryID, BusinessID, Rate)
VALUES (@loc, @t_std, @biz, @rate_standard), (@loc, @t_ex, @biz, @rate_exempt);

INSERT INTO Employee (EmployeeID, BusinessID, FirstName, LastName, Email, EmployeeNumber, RoleID)
VALUES (@emp, @biz, @first_name, @last_name, @first_email, @first_number, 'role-gm');
INSERT INTO EmployeeCredential (EmployeeID, PasswordHash, PinHash) VALUES (@emp, @password_hash, @pin_hash);
INSERT INTO EmployeeLocation (EmployeeID, LocationID, BusinessID) VALUES (@emp, @loc, @biz);

INSERT INTO MembershipTier (TierID, BusinessID, Name, MinimumPoints) VALUES (UUID(), @biz, 'Bean', 0);

-- 26 two-week pay periods (a year). Nothing adds more: see "add pay periods" in maintenance.sql.
INSERT INTO PayPeriod (PayPeriodID, BusinessID, StartDate, EndDate)
WITH RECURSIVE n (i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 25)
SELECT UUID(), @biz, @first_period_start + INTERVAL i * 14 DAY, @first_period_start + INTERVAL i * 14 + 13 DAY FROM n;

SELECT 'Done. Sign in at /login.html with this email and the password you hashed' AS note, @first_email AS email;
