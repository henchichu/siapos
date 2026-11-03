-- Sets up a real business: one business, its first café and registers, roles, and the first employee.
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
SET @online_orders   = FALSE;                    -- TRUE: the café's QR order page takes orders

-- Percent, as a fraction: 0.0825 = 8.25%. One line per tax category below.
SET @rate_standard   = 0.082500;
SET @rate_exempt     = 0.000000;

-- The first employee gets every permission (the "General manager" role). Number: 8 digits. PIN hash:
--   node sql/provision/hash-pin.js 246810
SET @first_name      = 'Alex';
SET @last_name       = 'Morgan';
SET @first_email     = 'alex@example.com';
SET @first_number    = '10000001';
SET @pin_hash        = 'PASTE-THE-OUTPUT-OF-hash-pin.js-HERE';

SET @first_period_start = '2026-01-05';          -- the first day of the first two-week pay period
-- ---------------------------------------------------------------------------------------------------------------------

SET @biz  = UUID();
SET @loc  = UUID();
SET @emp  = UUID();
SET @t_std = UUID();
SET @t_ex  = UUID();

INSERT INTO Business (BusinessID, Name, ContactEmail, ContactPhone, PricesIncludeTax)
VALUES (@biz, @business_name, @contact_email, @contact_phone, @prices_include_tax);

INSERT INTO Location (LocationID, BusinessID, Name, Address, Phone, TimeZone, AcceptsOnlineOrders)
VALUES (@loc, @biz, @location_name, @location_addr, @location_phone, @time_zone, @online_orders);

INSERT INTO Register (RegisterID, LocationID, Name) VALUES (UUID(), @loc, 'Counter');   -- add more rows for more registers

INSERT INTO TaxCategory (TaxCategoryID, BusinessID, Name)
VALUES (@t_std, @biz, 'Standard'), (@t_ex, @biz, 'Exempt');

INSERT INTO LocationTaxRate (LocationID, TaxCategoryID, BusinessID, Rate)
VALUES (@loc, @t_std, @biz, @rate_standard), (@loc, @t_ex, @biz, @rate_exempt);

-- Roles. Permission codes are the Permission table's (02-seed.sql); OpensTo is the page shown after sign-in.
SET @r_gm = UUID(); SET @r_mgr = UUID(); SET @r_asst = UUID(); SET @r_srv = UUID(); SET @r_cook = UUID();
INSERT INTO Role (RoleID, BusinessID, Name, OpensTo)
VALUES (@r_gm,   @biz, 'General manager',   'REGISTER'),
       (@r_mgr,  @biz, 'Manager',           'REGISTER'),
       (@r_asst, @biz, 'Assistant manager', 'REGISTER'),
       (@r_srv,  @biz, 'Server',            'REGISTER'),
       (@r_cook, @biz, 'Chef / barista',    'KITCHEN');

INSERT INTO RolePermission (RoleID, BusinessID, PermissionCode)
SELECT r.RoleID, @biz, p.PermissionCode
  FROM Role r JOIN Permission p
    ON (r.RoleID = @r_gm   AND p.PermissionCode BETWEEN 1 AND 20)
    OR (r.RoleID = @r_mgr  AND p.PermissionCode BETWEEN 1 AND 20)
    OR (r.RoleID = @r_asst AND p.PermissionCode IN (1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17))
    OR (r.RoleID = @r_srv  AND p.PermissionCode IN (1, 2, 5, 7, 9, 11))
    OR (r.RoleID = @r_cook AND p.PermissionCode IN (5, 6, 8))
 WHERE r.BusinessID = @biz;

INSERT INTO Employee (EmployeeID, BusinessID, FirstName, LastName, Email, EmployeeNumber, RoleID)
VALUES (@emp, @biz, @first_name, @last_name, @first_email, @first_number, @r_gm);
INSERT INTO EmployeeCredential (EmployeeID, PinHash) VALUES (@emp, @pin_hash);
INSERT INTO EmployeeLocation (EmployeeID, LocationID, BusinessID) VALUES (@emp, @loc, @biz);

INSERT INTO MembershipTier (TierID, BusinessID, Name, MinimumPoints) VALUES (UUID(), @biz, 'Bean', 0);

-- 26 two-week pay periods (a year). Nothing adds more: see "add pay periods" in maintenance.sql.
INSERT INTO PayPeriod (PayPeriodID, BusinessID, StartDate, EndDate)
WITH RECURSIVE n (i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 25)
SELECT UUID(), @biz, @first_period_start + INTERVAL i * 14 DAY, @first_period_start + INTERVAL i * 14 + 13 DAY FROM n;

SELECT 'Done. Sign in at /login.html with employee number' AS note, @first_number AS employee_number;
