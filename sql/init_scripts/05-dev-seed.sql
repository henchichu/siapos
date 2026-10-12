USE miniworld;

-- Development seed: "Brewbean Coffee", two Chicago cafés with two weeks of trading.
-- Dev only: leave this file out of a production build.
-- It runs after 04-triggers.sql, so every row passes the same rules the backend will.
-- IDs are readable on purpose (the backend will generate UUIDs). Dates are relative to
-- the day the volume is created, so "today" and "last 7 days" always have data.
-- Order history is generated from CRC32 hashes: varied, but identical on every rebuild.

SET @biz = 'biz-brewbean';
SET @tz = 'America/Chicago';
SET @D = DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', @tz));    -- today, café local date

-- ---------------------------------------------------------------------------
-- Business, locations, tax
-- ---------------------------------------------------------------------------
INSERT INTO Business (BusinessID, Name, ContactEmail, ContactPhone)
VALUES (@biz, 'Brewbean Coffee', 'hello@brewbean.example.com', '312-555-0100');

INSERT INTO Location (LocationID, BusinessID, Name, Address, Phone, TimeZone)
VALUES
    ('loc-downtown', @biz, 'Brewbean Downtown', '120 Example St, Chicago, IL', '312-555-0101', @tz),
    ('loc-campus',   @biz, 'Brewbean Campus',   '88 Quad Walk, Chicago, IL',   '312-555-0102', @tz);

INSERT INTO TaxCategory (TaxCategoryID, BusinessID, Name)
VALUES
    ('tax-prepared', @biz, 'Prepared food and drink'),
    ('tax-packaged', @biz, 'Packaged food');

-- Illustrative rates, not tax advice
INSERT INTO LocationTaxRate (LocationID, TaxCategoryID, BusinessID, Rate)
SELECT l.LocationID, t.TaxCategoryID, @biz, IF(t.TaxCategoryID = 'tax-prepared', 0.102500, 0.022500)
  FROM Location l CROSS JOIN TaxCategory t
 WHERE l.BusinessID = @biz AND t.BusinessID = @biz;

INSERT INTO Register (RegisterID, LocationID, Name, RegStatusCode)
VALUES
    ('reg-dt-1', 'loc-downtown', 'Front counter', 1),
    ('reg-dt-2', 'loc-downtown', 'Pickup window', 3),    -- 3 = MAINTENANCE
    ('reg-cp-1', 'loc-campus',   'Counter',       1);

-- ---------------------------------------------------------------------------
-- Staff, pay, shifts
-- ---------------------------------------------------------------------------
-- The default roles from the blueprint's access levels screen; the owner holds every permission
INSERT INTO Role (RoleID, BusinessID, Name, OpensTo, IsOwner)
VALUES
    ('role-owner',   @biz, 'Owner',             'REGISTER', TRUE),
    ('role-manager', @biz, 'Manager',           'REGISTER', FALSE),
    ('role-asst',    @biz, 'Assistant manager', 'REGISTER', FALSE),
    ('role-server',  @biz, 'Server',            'REGISTER', FALSE),
    ('role-barista', @biz, 'Chef / barista',    'KITCHEN',  FALSE);

-- Codes are 02-seed.sql's Permission rows; managers add 3 (refund overrides) and 18 (approve timecards)
INSERT INTO RolePermission (RoleID, BusinessID, PermissionCode)
SELECT r.RoleID, @biz, p.PermissionCode
  FROM Role r JOIN Permission p
    ON (r.RoleID = 'role-barista' AND p.PermissionCode IN (5, 6, 8))
    OR (r.RoleID = 'role-server'  AND p.PermissionCode IN (1, 2, 5, 7, 9, 11))
    OR (r.RoleID = 'role-asst'    AND p.PermissionCode IN (1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20))
    OR (r.RoleID = 'role-manager' AND p.PermissionCode IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20));

INSERT INTO Employee (EmployeeID, BusinessID, FirstName, LastName, Email, EmployeeNumber, RoleID)
VALUES
    ('emp-maya',   @biz, 'Maya',   'Okafor', 'maya@brewbean.example.com',   '10420001', 'role-owner'),
    ('emp-leo',    @biz, 'Leo',    'Brandt', 'leo@brewbean.example.com',    '10420002', 'role-manager'),
    ('emp-sam',    @biz, 'Sam',    'Rivera', 'sam@brewbean.example.com',    '10420003', 'role-server'),
    ('emp-priya',  @biz, 'Priya',  'Shah',   'priya@brewbean.example.com',  '10420004', 'role-server'),
    ('emp-jordan', @biz, 'Jordan', 'Lee',    'jordan@brewbean.example.com', '10420005', 'role-barista');

INSERT INTO EmployeeLocation (EmployeeID, LocationID, BusinessID)
VALUES
    ('emp-maya', 'loc-downtown', @biz), ('emp-maya', 'loc-campus', @biz),
    ('emp-leo',  'loc-downtown', @biz), ('emp-leo',  'loc-campus', @biz),
    ('emp-sam',  'loc-downtown', @biz),
    ('emp-priya', 'loc-campus', @biz),
    ('emp-jordan', 'loc-campus', @biz);

-- Sam got a raise when the current pay period started
INSERT INTO EmployeePayRate (PayRateID, EmployeeID, BusinessID, HourlyRate, EffectiveFrom, EffectiveTo)
VALUES
    ('rate-leo',    'emp-leo',    @biz, 24.00, TIMESTAMP(@D - INTERVAL 180 DAY), NULL),
    ('rate-sam-1',  'emp-sam',    @biz, 16.50, TIMESTAMP(@D - INTERVAL 180 DAY), TIMESTAMP(@D - INTERVAL 13 DAY)),
    ('rate-sam-2',  'emp-sam',    @biz, 17.25, TIMESTAMP(@D - INTERVAL 13 DAY), NULL),
    ('rate-priya',  'emp-priya',  @biz, 16.75, TIMESTAMP(@D - INTERVAL 180 DAY), NULL),
    ('rate-jordan', 'emp-jordan', @biz, 16.00, TIMESTAMP(@D - INTERVAL 90 DAY), NULL);

INSERT INTO PayPeriod (PayPeriodID, BusinessID, StartDate, EndDate)
VALUES
    ('pp-prev', @biz, @D - INTERVAL 27 DAY, @D - INTERVAL 14 DAY),
    ('pp-curr', @biz, @D - INTERVAL 13 DAY, @D);

CREATE TABLE _seed_seq (n INT PRIMARY KEY);
INSERT INTO _seed_seq
SELECT a.n * 10 + b.n
  FROM (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
        UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a
 CROSS JOIN
       (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
        UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b;

-- Five shifts a week each; Leo alternates between the two cafés (LocationID NULL)
CREATE TABLE _seed_shift (EmployeeID CHAR(36), LocationID CHAR(36), StartTime TIME, Minutes INT, DayOffset INT);
INSERT INTO _seed_shift
VALUES
    ('emp-leo',    NULL,           '08:00', 510, 0),
    ('emp-sam',    'loc-downtown', '06:30', 510, 2),
    ('emp-priya',  'loc-campus',   '07:00', 510, 4),
    ('emp-jordan', 'loc-campus',   '11:00', 450, 1);

-- Last pay period: approved. This one: submitted. The manager approves staff; the owner approves the manager.
INSERT INTO TimeEntry (TimeEntryID, EmployeeID, LocationID, BusinessID, PayPeriodID,
                       ClockInAt, ClockOutAt, UnpaidBreakMinutes, TimeEntryStatusCode, ApprovedByEmployeeID)
SELECT CONCAT('te-', SUBSTRING(e.EmployeeID, 5), '-', LPAD(d.n, 2, '0')),
       e.EmployeeID,
       COALESCE(e.LocationID, IF(MOD(d.n, 2) = 0, 'loc-downtown', 'loc-campus')),
       @biz,
       IF(d.n >= 14, 'pp-prev', 'pp-curr'),
       CONVERT_TZ(TIMESTAMP(@D - INTERVAL d.n DAY, e.StartTime), @tz, '+00:00'),
       CONVERT_TZ(TIMESTAMP(@D - INTERVAL d.n DAY, e.StartTime) + INTERVAL e.Minutes MINUTE, @tz, '+00:00'),
       30,
       IF(d.n >= 14, 3, 2),                      -- 3 = APPROVED, 2 = SUBMITTED
       IF(d.n >= 14, IF(e.EmployeeID = 'emp-leo', 'emp-maya', 'emp-leo'), NULL)
  FROM _seed_shift e
  JOIN _seed_seq d ON d.n BETWEEN 1 AND 27
 WHERE MOD(d.n + e.DayOffset, 7) NOT IN (0, 1);

-- Sam is on shift right now
INSERT INTO TimeEntry (TimeEntryID, EmployeeID, LocationID, BusinessID, PayPeriodID, ClockInAt)
VALUES ('te-sam-today', 'emp-sam', 'loc-downtown', @biz, 'pp-curr', UTC_TIMESTAMP() - INTERVAL 1 HOUR);

UPDATE PayPeriod SET Closed = TRUE WHERE PayPeriodID = 'pp-prev';

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
INSERT INTO Category (CategoryID, BusinessID, Name)
VALUES
    ('cat-coffee', @biz, 'Coffee'), ('cat-tea', @biz, 'Tea'),
    ('cat-bakery', @biz, 'Bakery'), ('cat-retail', @biz, 'Retail');

INSERT INTO StockItem (StockItemID, BusinessID, Name, StockUnitCode)
VALUES      -- 1 each, 2 g, 6 ml
    ('stk-beans',     @biz, 'Espresso beans',        2),
    ('stk-milk',      @biz, 'Whole milk',            6),
    ('stk-oat',       @biz, 'Oat milk',              6),
    ('stk-vanilla',   @biz, 'Vanilla syrup',         6),
    ('stk-caramel',   @biz, 'Caramel syrup',         6),
    ('stk-chai',      @biz, 'Chai concentrate',      6),
    ('stk-cup-12',    @biz, '12 oz cup',             1),
    ('stk-cup-16',    @biz, '16 oz cup',             1),
    ('stk-croissant', @biz, 'Butter croissant',      1),
    ('stk-muffin',    @biz, 'Blueberry muffin',      1),
    ('stk-bag',       @biz, 'House blend 12 oz bag', 1);

INSERT INTO Product (ProductID, BusinessID, Name, Description)
VALUES
    ('prd-latte',     @biz, 'Latte',            'Double shot with steamed milk'),
    ('prd-americano', @biz, 'Americano',        'Espresso and hot water'),
    ('prd-chai',      @biz, 'Chai latte',       'Spiced black tea with steamed milk'),
    ('prd-croissant', @biz, 'Butter croissant', NULL),
    ('prd-muffin',    @biz, 'Blueberry muffin', NULL),
    ('prd-bag',       @biz, 'House blend, whole bean', '12 oz bag to brew at home');

INSERT INTO ProductCategory (ProductID, CategoryID, BusinessID)
VALUES
    ('prd-latte', 'cat-coffee', @biz), ('prd-americano', 'cat-coffee', @biz),
    ('prd-chai', 'cat-tea', @biz),
    ('prd-croissant', 'cat-bakery', @biz), ('prd-muffin', 'cat-bakery', @biz),
    ('prd-bag', 'cat-retail', @biz), ('prd-bag', 'cat-coffee', @biz);

INSERT INTO ProductVariant (VariantID, ProductID, BusinessID, Name, SKU, Price, TaxCategoryID, RestockOnReturn)
VALUES
    ('var-latte-s',   'prd-latte',     @biz, 'Small 12 oz', 'LAT-12',  4.25, 'tax-prepared', FALSE),
    ('var-latte-l',   'prd-latte',     @biz, 'Large 16 oz', 'LAT-16',  5.25, 'tax-prepared', FALSE),
    ('var-amer-s',    'prd-americano', @biz, 'Small 12 oz', 'AME-12',  3.25, 'tax-prepared', FALSE),
    ('var-amer-l',    'prd-americano', @biz, 'Large 16 oz', 'AME-16',  3.75, 'tax-prepared', FALSE),
    ('var-chai',      'prd-chai',      @biz, 'Regular',     'CHAI-16', 4.75, 'tax-prepared', FALSE),
    ('var-croissant', 'prd-croissant', @biz, 'Regular',     'BAK-CRO', 3.50, 'tax-prepared', FALSE),
    ('var-muffin',    'prd-muffin',    @biz, 'Regular',     'BAK-MUF', 3.25, 'tax-prepared', FALSE),
    ('var-bag',       'prd-bag',       @biz, 'Regular',     'RET-HB12', 16.00, 'tax-packaged', TRUE);

INSERT INTO VariantRecipe (VariantID, StockItemID, BusinessID, QuantityPerUnit)
VALUES
    ('var-latte-s', 'stk-beans', @biz, 18), ('var-latte-s', 'stk-milk', @biz, 240), ('var-latte-s', 'stk-cup-12', @biz, 1),
    ('var-latte-l', 'stk-beans', @biz, 18), ('var-latte-l', 'stk-milk', @biz, 340), ('var-latte-l', 'stk-cup-16', @biz, 1),
    ('var-amer-s',  'stk-beans', @biz, 18), ('var-amer-s',  'stk-cup-12', @biz, 1),
    ('var-amer-l',  'stk-beans', @biz, 27), ('var-amer-l',  'stk-cup-16', @biz, 1),
    ('var-chai',    'stk-chai',  @biz, 120), ('var-chai',   'stk-milk', @biz, 180), ('var-chai', 'stk-cup-16', @biz, 1),
    ('var-croissant', 'stk-croissant', @biz, 1),
    ('var-muffin',    'stk-muffin',    @biz, 1),
    ('var-bag',       'stk-bag',       @biz, 1);

INSERT INTO ModifierGroup (ModifierGroupID, BusinessID, Name, MinSelect, MaxSelect)
VALUES
    ('mg-milk',    @biz, 'Milk',    0, 1),
    ('mg-flavour', @biz, 'Flavour', 0, 2),
    ('mg-extras',  @biz, 'Extras',  0, NULL);

INSERT INTO Modifier (ModifierID, ModifierGroupID, BusinessID, Name, PriceDelta)
VALUES
    ('mod-oat',        'mg-milk',    @biz, 'Oat milk',   0.75),
    ('mod-vanilla',    'mg-flavour', @biz, 'Vanilla',    0.60),
    ('mod-caramel',    'mg-flavour', @biz, 'Caramel',    0.60),
    ('mod-extra-shot', 'mg-extras',  @biz, 'Extra shot', 1.00);

INSERT INTO ModifierSubstitution (ModifierID, FromStockItemID, ToStockItemID, BusinessID)
VALUES ('mod-oat', 'stk-milk', 'stk-oat', @biz);

INSERT INTO ModifierAddition (ModifierID, StockItemID, BusinessID, Quantity)
VALUES
    ('mod-vanilla',    'stk-vanilla', @biz, 15),
    ('mod-caramel',    'stk-caramel', @biz, 15),
    ('mod-extra-shot', 'stk-beans',   @biz, 9);

INSERT INTO ProductModifierGroup (ProductID, ModifierGroupID, BusinessID, SortOrder)
VALUES
    ('prd-latte', 'mg-milk', @biz, 1), ('prd-latte', 'mg-flavour', @biz, 2), ('prd-latte', 'mg-extras', @biz, 3),
    ('prd-americano', 'mg-flavour', @biz, 1), ('prd-americano', 'mg-extras', @biz, 2),
    ('prd-chai', 'mg-milk', @biz, 1);

-- ---------------------------------------------------------------------------
-- Suppliers and stock: two restocks per item per café, at different costs
-- ---------------------------------------------------------------------------
INSERT INTO Supplier (SupplierID, BusinessID, Name, ContactEmail, LeadTimeDays)
VALUES
    ('sup-roaster', @biz, 'Northside Roasters', 'orders@northside.example.com', 3),
    ('sup-dairy',   @biz, 'Prairie Dairy',      'orders@prairie.example.com',   1),
    ('sup-bakery',  @biz, 'Sunrise Bakery',     'orders@sunrise.example.com',   1),
    ('sup-supply',  @biz, 'Counter Supply Co.', 'orders@counter.example.com',   5);

-- Costs are per stock unit (per g, per ml, per each)
CREATE TABLE _seed_stock (StockItemID CHAR(36), SupplierID CHAR(36), Threshold DECIMAL(12,3),
                          Qty1 DECIMAL(12,3), Cost1 DECIMAL(18,6), Qty2 DECIMAL(12,3), Cost2 DECIMAL(18,6));
INSERT INTO _seed_stock
VALUES
    ('stk-beans',     'sup-roaster', 3000,  6000, 0.021000,  6000, 0.023000),
    ('stk-milk',      'sup-dairy',  15000, 30000, 0.001100, 30000, 0.001200),
    ('stk-oat',       'sup-dairy',   5000, 12000, 0.002400, 12000, 0.002500),
    ('stk-vanilla',   'sup-supply',  1000,  2000, 0.012000,  2000, 0.012000),
    ('stk-caramel',   'sup-supply',  1000,   700, 0.012000,   500, 0.012500),  -- ends below its threshold
    ('stk-chai',      'sup-supply',  4000,  8000, 0.009000,  8000, 0.009000),
    ('stk-cup-12',    'sup-supply',   100,   300, 0.110000,   300, 0.110000),
    ('stk-cup-16',    'sup-supply',   100,   300, 0.130000,   300, 0.130000),
    ('stk-croissant', 'sup-bakery',    20,   100, 1.100000,   100, 1.150000),
    ('stk-muffin',    'sup-bakery',    20,   100, 0.950000,   100, 0.950000),
    ('stk-bag',       'sup-roaster',   10,    24, 7.500000,    24, 7.800000);

INSERT INTO StockItemSupplier (StockItemID, SupplierID, BusinessID, UnitCost, IsPreferred)
SELECT StockItemID, SupplierID, @biz, Cost2, TRUE FROM _seed_stock;

INSERT INTO Inventory (InventoryID, LocationID, StockItemID, BusinessID, ReorderThreshold)
SELECT CONCAT('inv-', IF(l.LocationID = 'loc-downtown', 'dt', 'cp'), '-', SUBSTRING(s.StockItemID, 5)),
       l.LocationID, s.StockItemID, @biz, s.Threshold
  FROM Location l CROSS JOIN _seed_stock s
 WHERE l.BusinessID = @biz;

INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                  QuantityChange, UnitCost, TransactionTypeCode, TransactionDateTime)
SELECT CONCAT('itx-rs', r.n, '-', IF(l.LocationID = 'loc-downtown', 'dt', 'cp'), '-', SUBSTRING(s.StockItemID, 5)),
       @biz, s.StockItemID, l.LocationID, 'emp-leo',
       IF(r.n = 1, s.Qty1, s.Qty2), IF(r.n = 1, s.Cost1, s.Cost2),
       1,                                                       -- 1 = RESTOCK
       CONVERT_TZ(TIMESTAMP(@D - INTERVAL IF(r.n = 1, 20, 6) DAY, '06:00'), @tz, '+00:00')
  FROM Location l CROSS JOIN _seed_stock s
  JOIN _seed_seq r ON r.n IN (1, 2)
 WHERE l.BusinessID = @biz
 ORDER BY r.n;

-- ---------------------------------------------------------------------------
-- Customers, loyalty, promotion
-- ---------------------------------------------------------------------------
INSERT INTO Customer (CustomerID, BusinessID, FirstName, LastName, Email, Phone)
VALUES
    ('cus-ava',   @biz, 'Ava',   'Nguyen', 'ava@example.com',   NULL),
    ('cus-ben',   @biz, 'Ben',   'Carter', NULL,                '312-555-0142'),
    ('cus-chloe', @biz, 'Chloe', 'Moreau', 'chloe@example.com', '312-555-0177'),
    ('cus-diego', @biz, 'Diego', 'Ramos',  'diego@example.com', NULL);

INSERT INTO MembershipTier (TierID, BusinessID, Name, MinimumPoints)
VALUES ('tier-bean', @biz, 'Bean', 0), ('tier-gold', @biz, 'Gold', 500);

INSERT INTO LoyaltyAccount (LoyaltyAccountID, CustomerID, TierID, BusinessID, EnrolledAt)
VALUES
    ('loy-ava',   'cus-ava',   'tier-gold', @biz, UTC_TIMESTAMP() - INTERVAL 200 DAY),
    ('loy-chloe', 'cus-chloe', 'tier-bean', @biz, UTC_TIMESTAMP() - INTERVAL 40 DAY);

INSERT INTO Promotion (PromotionID, BusinessID, Name, DiscountTypeCode, DiscountValue, StartsAt, EndsAt)
VALUES ('promo-morning-pastry', @biz, 'Morning pastry: 20% off before 10am', 1, 20,   -- 1 = PERCENT
        TIMESTAMP(@D - INTERVAL 30 DAY), TIMESTAMP(@D + INTERVAL 60 DAY));

INSERT INTO PromotionProduct (PromotionID, ProductID, BusinessID)
VALUES ('promo-morning-pastry', 'prd-croissant', @biz), ('promo-morning-pastry', 'prd-muffin', @biz);

-- ---------------------------------------------------------------------------
-- Orders: 6-10 a day per café over the last 13 days, 7am-5pm local
-- ---------------------------------------------------------------------------
CREATE TABLE _seed_order (OrderID CHAR(36) PRIMARY KEY, LocationID CHAR(36), h BIGINT,
                          LocalAt DATETIME, UtcAt DATETIME, ChannelCode TINYINT, RegisterID CHAR(36),
                          EmployeeID CHAR(36), CustomerID CHAR(36), PaymentMethodCode TINYINT,
                          Total DECIMAL(10,2), Tip DECIMAL(10,2));
INSERT INTO _seed_order
SELECT x.OrderID, x.LocationID, x.h, x.LocalAt, CONVERT_TZ(x.LocalAt, @tz, '+00:00'),
       IF(MOD(x.h, 10) = 0, 2, 1),                                            -- 1 = POS, 2 = ONLINE
       IF(MOD(x.h, 10) = 0, NULL, IF(x.lc = 'dt', 'reg-dt-1', 'reg-cp-1')),
       IF(MOD(x.h, 10) = 0, NULL, IF(x.lc = 'dt', 'emp-sam', 'emp-priya')),
       IF(MOD(x.h, 10) = 0 OR MOD(x.h, 5) = 0,
          ELT(MOD(x.h, 4) + 1, 'cus-ava', 'cus-ben', 'cus-chloe', 'cus-diego'), NULL),
       IF(MOD(x.h, 10) <> 0 AND MOD(x.h, 3) = 0, 1, 2),                       -- 1 = CASH, 2 = CARD
       NULL, NULL
  FROM (SELECT CONCAT('ord-', lc, '-', LPAD(d.n, 2, '0'), '-', LPAD(s.n, 2, '0')) OrderID,
               l.LocationID, l.lc,
               CRC32(CONCAT(l.lc, d.n, '-', s.n)) h,
               TIMESTAMP(@D - INTERVAL d.n DAY,
                         MAKETIME(7 + s.n, MOD(CRC32(CONCAT(l.lc, d.n, '-', s.n, 'm')), 50), 0)) LocalAt
          FROM (SELECT 'loc-downtown' LocationID, 'dt' lc UNION ALL SELECT 'loc-campus', 'cp') l
          JOIN _seed_seq d ON d.n BETWEEN 1 AND 13
          JOIN _seed_seq s ON s.n < 6 + MOD(CRC32(CONCAT(l.lc, d.n)), 5)) x;

-- Weighted menu: 17 slots
CREATE TABLE _seed_menu (idx INT PRIMARY KEY, VariantID CHAR(36));
INSERT INTO _seed_menu
VALUES
    (0, 'var-latte-s'), (1, 'var-latte-s'), (2, 'var-latte-s'),
    (3, 'var-latte-l'), (4, 'var-latte-l'), (5, 'var-latte-l'),
    (6, 'var-amer-s'), (7, 'var-amer-s'), (8, 'var-amer-l'), (9, 'var-amer-l'),
    (10, 'var-chai'), (11, 'var-chai'),
    (12, 'var-croissant'), (13, 'var-croissant'), (14, 'var-muffin'), (15, 'var-muffin'),
    (16, 'var-bag');

-- 1-3 lines per order
CREATE TABLE _seed_line (OrderItemID CHAR(36) PRIMARY KEY, OrderID CHAR(36), LocationID CHAR(36),
                         VariantID CHAR(36), Quantity DECIMAL(12,3), hl BIGINT,
                         UnitPrice DECIMAL(10,2), UnitCost DECIMAL(18,6), LineTotal DECIMAL(10,2),
                         DiscountAmount DECIMAL(10,2) NOT NULL DEFAULT 0,
                         TaxCategoryID CHAR(36), TaxRate DECIMAL(7,6));
INSERT INTO _seed_line (OrderItemID, OrderID, LocationID, VariantID, Quantity, hl)
SELECT CONCAT(o.OrderID, '-', k.n), o.OrderID, o.LocationID, m.VariantID,
       IF(m.VariantID <> 'var-bag' AND MOD(CRC32(CONCAT(o.OrderID, k.n, 'q')), 7) = 0, 2, 1),
       CRC32(CONCAT(o.OrderID, k.n, 'mod'))
  FROM _seed_order o
  JOIN _seed_seq k ON k.n < 1 + (MOD(o.h, 3) > 0) + (MOD(o.h, 4) = 0)
  JOIN _seed_menu m ON m.idx = MOD(CRC32(CONCAT(o.OrderID, k.n)), 17);

CREATE TABLE _seed_linemod (OrderItemID CHAR(36), ModifierID CHAR(36));
INSERT INTO _seed_linemod
SELECT OrderItemID, 'mod-oat' FROM _seed_line
 WHERE VariantID IN ('var-latte-s', 'var-latte-l', 'var-chai') AND MOD(hl, 4) = 0
UNION ALL
SELECT OrderItemID, 'mod-vanilla' FROM _seed_line
 WHERE (VariantID IN ('var-latte-s', 'var-latte-l') AND MOD(hl, 5) = 0)
    OR (VariantID IN ('var-amer-s', 'var-amer-l') AND MOD(hl, 9) = 0)
UNION ALL
SELECT OrderItemID, 'mod-caramel' FROM _seed_line
 WHERE VariantID IN ('var-latte-s', 'var-latte-l') AND MOD(hl, 6) = 0
UNION ALL
SELECT OrderItemID, 'mod-extra-shot' FROM _seed_line
 WHERE VariantID IN ('var-latte-s', 'var-latte-l', 'var-amer-s', 'var-amer-l') AND MOD(hl, 7) = 0;

-- What each line used: the recipe with substitutions applied, plus additions (the backend's job)
CREATE TABLE _seed_comp (OrderItemID CHAR(36), StockItemID CHAR(36), QuantityUsed DECIMAL(12,3),
                         StockUnitCode TINYINT UNSIGNED, UnitCost DECIMAL(18,6),
                         PRIMARY KEY (OrderItemID, StockItemID));
INSERT INTO _seed_comp (OrderItemID, StockItemID, QuantityUsed)
SELECT u.OrderItemID, u.StockItemID, SUM(u.q)
  FROM (SELECT l.OrderItemID, COALESCE(ms.ToStockItemID, r.StockItemID) StockItemID,
               r.QuantityPerUnit * l.Quantity q
          FROM _seed_line l
          JOIN VariantRecipe r ON r.VariantID = l.VariantID
          LEFT JOIN (_seed_linemod lm JOIN ModifierSubstitution ms ON ms.ModifierID = lm.ModifierID)
                 ON lm.OrderItemID = l.OrderItemID AND ms.FromStockItemID = r.StockItemID
         WHERE NOT (ms.ModifierID IS NOT NULL AND ms.ToStockItemID IS NULL)   -- "no X" removes it
        UNION ALL
        SELECT l.OrderItemID, ma.StockItemID, ma.Quantity * l.Quantity
          FROM _seed_line l
          JOIN _seed_linemod lm ON lm.OrderItemID = l.OrderItemID
          JOIN ModifierAddition ma ON ma.ModifierID = lm.ModifierID) u
 GROUP BY u.OrderItemID, u.StockItemID;

UPDATE _seed_comp c
  JOIN _seed_line l ON l.OrderItemID = c.OrderItemID
  JOIN Inventory i ON i.LocationID = l.LocationID AND i.StockItemID = c.StockItemID
  JOIN StockItem s ON s.StockItemID = c.StockItemID
   SET c.UnitCost = i.AverageUnitCost, c.StockUnitCode = s.StockUnitCode;

-- Price = variant + modifier deltas; cost = components; tax = the café's rate for the category
UPDATE _seed_line l
  JOIN ProductVariant v ON v.VariantID = l.VariantID
  JOIN LocationTaxRate r ON r.LocationID = l.LocationID AND r.TaxCategoryID = v.TaxCategoryID
   SET l.UnitPrice = v.Price + COALESCE((SELECT SUM(m.PriceDelta)
                                           FROM _seed_linemod lm JOIN Modifier m ON m.ModifierID = lm.ModifierID
                                          WHERE lm.OrderItemID = l.OrderItemID), 0),
       l.UnitCost = ROUND((SELECT SUM(c.QuantityUsed * c.UnitCost)
                             FROM _seed_comp c WHERE c.OrderItemID = l.OrderItemID) / l.Quantity, 6),
       l.TaxCategoryID = v.TaxCategoryID,
       l.TaxRate = r.Rate;

UPDATE _seed_line SET LineTotal = ROUND(Quantity * UnitPrice, 2);

-- Morning pastry promotion
UPDATE _seed_line l
  JOIN _seed_order o ON o.OrderID = l.OrderID
   SET l.DiscountAmount = ROUND(l.LineTotal * 0.20, 2)
 WHERE l.VariantID IN ('var-croissant', 'var-muffin') AND HOUR(o.LocalAt) < 10;

-- Same steps the backend takes: open the order, add lines, total it, pay, complete
INSERT INTO Orders (OrderID, LocationID, BusinessID, RegisterID, EmployeeID, CustomerID, ChannelCode, OrderDateTime)
SELECT OrderID, LocationID, @biz, RegisterID, EmployeeID, CustomerID, ChannelCode, UtcAt
  FROM _seed_order
 UNION ALL       -- cancelled below; inserted here so order numbers follow time
SELECT 'ord-cp-cancelled', 'loc-campus', @biz, 'reg-cp-1', 'emp-priya', NULL, 1,
       CONVERT_TZ(TIMESTAMP(@D - INTERVAL 2 DAY, '12:15'), @tz, '+00:00')
 ORDER BY 8, 1;

INSERT INTO OrderItem (OrderItemID, OrderID, VariantID, BusinessID, Quantity, UnitPrice, UnitCost, LineCost,
                       LineTotal, DiscountAmount, TaxCategoryID, TaxRate, TaxAmount)
SELECT OrderItemID, OrderID, VariantID, @biz, Quantity, UnitPrice, UnitCost, ROUND(Quantity * UnitCost, 6),
       LineTotal, DiscountAmount, TaxCategoryID, TaxRate, ROUND((LineTotal - DiscountAmount) * TaxRate, 2)
  FROM _seed_line;

INSERT INTO OrderItemModifier (OrderItemID, ModifierID, BusinessID, PriceDelta)
SELECT lm.OrderItemID, lm.ModifierID, @biz, m.PriceDelta
  FROM _seed_linemod lm JOIN Modifier m ON m.ModifierID = lm.ModifierID;

INSERT INTO OrderItemComponent (OrderItemID, StockItemID, BusinessID, QuantityUsed, StockUnitCode, UnitCost)
SELECT OrderItemID, StockItemID, @biz, QuantityUsed, StockUnitCode, UnitCost FROM _seed_comp;

INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                  QuantityChange, UnitCost, TransactionTypeCode, OrderID, TransactionDateTime)
SELECT CONCAT('itx-', c.OrderItemID, '-', SUBSTRING(c.StockItemID, 5)), @biz, c.StockItemID, o.LocationID,
       o.EmployeeID, -c.QuantityUsed, c.UnitCost, 2, o.OrderID, o.UtcAt               -- 2 = SALE
  FROM _seed_comp c
  JOIN _seed_line l ON l.OrderItemID = c.OrderItemID
  JOIN _seed_order o ON o.OrderID = l.OrderID;

UPDATE Orders o
  JOIN (SELECT OrderID, SUM(LineTotal) st, SUM(DiscountAmount) dc, SUM(TaxAmount) tx
          FROM OrderItem GROUP BY OrderID) t ON t.OrderID = o.OrderID
   SET o.Subtotal = t.st, o.DiscountAmount = t.dc, o.Tax = t.tx, o.Total = t.st - t.dc + t.tx
 WHERE o.BusinessID = @biz;

-- Copied out first: the payment trigger locks Orders, which the INSERT's own SELECT can't also read
UPDATE _seed_order s JOIN Orders o ON o.OrderID = s.OrderID SET s.Total = o.Total;

-- About half of card payments at the counter tip 10-20%, chosen on the terminal (counter style)
UPDATE _seed_order
   SET Tip = IF(ChannelCode = 1 AND PaymentMethodCode = 2 AND MOD(CRC32(CONCAT(OrderID, 'tip')), 2) = 0,
                ROUND(Total * (10 + MOD(CRC32(CONCAT(OrderID, 'pct')), 11)) / 100, 2), 0);

-- ...and the latest tip is still open, as if entered from a slip, so "unlocked tips" has a row
SET @open_tip = (SELECT OrderID FROM _seed_order WHERE Tip > 0 ORDER BY UtcAt DESC LIMIT 1);

INSERT INTO Payment (PaymentID, OrderID, PaymentMethodCode, Amount, TipAmount, TipLockedAt,
                     PaymentStatusCode, PaymentDateTime)
SELECT CONCAT('pay-', SUBSTRING(OrderID, 5)), OrderID, PaymentMethodCode, Total, Tip,
       IF(OrderID = @open_tip, NULL, UtcAt + INTERVAL 2 MINUTE),
       3, UtcAt + INTERVAL 2 MINUTE                                                   -- 3 = COMPLETED
  FROM _seed_order;

-- Before completion: redemptions freeze with the order, and completion checks they add up
INSERT INTO PromotionRedemption (BusinessID, RedemptionID, PromotionID, OrderID, DiscountAmount, RedeemedAt)
SELECT @biz, CONCAT('red-', SUBSTRING(o.OrderID, 5)), 'promo-morning-pastry', o.OrderID, o.DiscountAmount,
       s.UtcAt + INTERVAL 3 MINUTE
  FROM Orders o JOIN _seed_order s ON s.OrderID = o.OrderID
 WHERE o.DiscountAmount > 0;

UPDATE Orders o
  JOIN _seed_order s ON s.OrderID = o.OrderID
   SET o.OrderStatusCode = 5, o.CompletedAt = s.UtcAt + INTERVAL 3 MINUTE;              -- 5 = COMPLETED

INSERT INTO OrderStatusHistory (OrderStatusHistoryID, OrderID, BusinessID, OrderStatusCode, ChangedAt, ChangedByEmployeeID)
SELECT CONCAT('osh-', SUBSTRING(s.OrderID, 5), '-1'), s.OrderID, @biz, 1, s.UtcAt, s.EmployeeID FROM _seed_order s
UNION ALL
SELECT CONCAT('osh-', SUBSTRING(s.OrderID, 5), '-5'), s.OrderID, @biz, 5, s.UtcAt + INTERVAL 3 MINUTE, s.EmployeeID
  FROM _seed_order s;

-- A point per whole dollar for loyalty members
INSERT INTO LoyaltyTransaction (LoyaltyTransactionID, LoyaltyAccountID, OrderID, CustomerID,
                                LoyaltyTransactionTypeCode, PointsChange, TransactionDateTime)
-- (account IDs spelled out: the balance trigger locks LoyaltyAccount, so this SELECT can't read it)
SELECT CONCAT('lt-', SUBSTRING(o.OrderID, 5)), CONCAT('loy-', SUBSTRING(o.CustomerID, 5)), o.OrderID, o.CustomerID,
       1, FLOOR(o.Total), o.CompletedAt                                                 -- 1 = EARN
  FROM Orders o
 WHERE o.CustomerID IN ('cus-ava', 'cus-chloe') AND o.OrderStatusCode = 5 AND FLOOR(o.Total) > 0;

-- ---------------------------------------------------------------------------
-- A cancelled order (row inserted with the history), and an open one at the counter now
-- ---------------------------------------------------------------------------
INSERT INTO OrderItem (OrderItemID, OrderID, VariantID, BusinessID, Quantity, UnitPrice, LineTotal,
                       TaxCategoryID, TaxRate, TaxAmount)
VALUES ('ord-cp-cancelled-0', 'ord-cp-cancelled', 'var-croissant', @biz, 1, 3.50, 3.50, 'tax-prepared', 0.1025, 0.36);
UPDATE Orders SET Subtotal = 3.50, Tax = 0.36, Total = 3.86, OrderStatusCode = 6        -- 6 = CANCELLED
 WHERE OrderID = 'ord-cp-cancelled';

INSERT INTO Orders (OrderID, LocationID, BusinessID, RegisterID, EmployeeID, ChannelCode)
VALUES ('ord-dt-now', 'loc-downtown', @biz, 'reg-dt-1', 'emp-sam', 1);
INSERT INTO OrderItem (OrderItemID, OrderID, VariantID, BusinessID, Quantity, UnitPrice, LineTotal,
                       TaxCategoryID, TaxRate, TaxAmount)
VALUES ('ord-dt-now-0', 'ord-dt-now', 'var-latte-l', @biz, 1, 5.25, 5.25, 'tax-prepared', 0.1025, 0.54);
UPDATE Orders SET Subtotal = 5.25, Tax = 0.54, Total = 5.79 WHERE OrderID = 'ord-dt-now';

-- ---------------------------------------------------------------------------
-- Stock losses and stocktake corrections, losses at the average cost of the day
-- ---------------------------------------------------------------------------
CREATE TABLE _seed_loss (ID CHAR(36), LocationID CHAR(36), StockItemID CHAR(36), EmployeeID CHAR(36),
                         Qty DECIMAL(12,3), TypeCode TINYINT, DaysAgo INT, AtTime TIME,
                         UnitCost DECIMAL(18,6));
INSERT INTO _seed_loss (ID, LocationID, StockItemID, EmployeeID, Qty, TypeCode, DaysAgo, AtTime)
VALUES      -- 5 DAMAGED, 6 EXPIRED, 7 THEFT, 8 COUNT_CORRECTION
    ('itx-loss-01', 'loc-downtown', 'stk-milk',      'emp-sam',    -1890, 5, 11, '08:15'),  -- dropped jug
    ('itx-loss-02', 'loc-campus',   'stk-beans',     'emp-priya',   -340, 5,  9, '10:40'),  -- split bag
    ('itx-loss-03', 'loc-downtown', 'stk-croissant', 'emp-sam',       -4, 6, 10, '17:30'),
    ('itx-loss-04', 'loc-campus',   'stk-croissant', 'emp-priya',     -3, 6,  7, '17:30'),
    ('itx-loss-05', 'loc-downtown', 'stk-muffin',    'emp-sam',       -5, 6,  4, '17:30'),
    ('itx-loss-06', 'loc-campus',   'stk-muffin',    'emp-jordan',    -2, 6,  2, '17:30'),
    ('itx-loss-07', 'loc-downtown', 'stk-milk',      'emp-leo',    -1000, 6,  3, '07:00'),  -- soured
    ('itx-loss-08', 'loc-campus',   'stk-bag',       'emp-leo',       -1, 7,  5, '14:00'),
    ('itx-loss-09', 'loc-downtown', 'stk-cup-16',    'emp-leo',      -12, 8,  1, '18:00'),
    ('itx-loss-10', 'loc-campus',   'stk-cup-12',    'emp-leo',        6, 8,  1, '18:00');

-- Staged: the ledger trigger updates Inventory, so the INSERT can't read Inventory itself.
-- Losses don't move the average, so one lookup holds for every row.
UPDATE _seed_loss s JOIN Inventory i ON i.LocationID = s.LocationID AND i.StockItemID = s.StockItemID
   SET s.UnitCost = IF(s.TypeCode IN (5, 6, 7), i.AverageUnitCost, NULL);

INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                  QuantityChange, UnitCost, TransactionTypeCode, TransactionDateTime)
SELECT ID, @biz, StockItemID, LocationID, EmployeeID, Qty, UnitCost, TypeCode,
       CONVERT_TZ(TIMESTAMP(@D - INTERVAL DaysAgo DAY, AtTime), @tz, '+00:00')
  FROM _seed_loss;

-- ---------------------------------------------------------------------------
-- A return: the first bag of beans sold comes back unopened, goes back on the shelf, is refunded
-- ---------------------------------------------------------------------------
SET @ret_line = (SELECT l.OrderItemID FROM OrderItem l JOIN Orders o ON o.OrderID = l.OrderID
                  WHERE l.VariantID = 'var-bag' AND o.OrderStatusCode = 5
                  ORDER BY o.OrderDateTime LIMIT 1);
SET @ret_order = (SELECT OrderID FROM OrderItem WHERE OrderItemID = @ret_line);
SET @ret_at = (SELECT LEAST(CompletedAt + INTERVAL 1 DAY, UTC_TIMESTAMP()) FROM Orders WHERE OrderID = @ret_order);

INSERT INTO Returns (ReturnID, OrderID, BusinessID, ApprovedByEmployeeID, CreatedAt, CreatedBy)
VALUES ('ret-0001', @ret_order, @biz, 'emp-leo', @ret_at, 'emp-leo');
INSERT INTO ReturnItem (ReturnItemID, ReturnID, OrderID, OrderItemID, QuantityReturned, QuantityRestocked)
VALUES ('ri-0001', 'ret-0001', @ret_order, @ret_line, 1, 1);

INSERT INTO InventoryTransaction (InventoryTransactionID, BusinessID, StockItemID, LocationID, EmployeeID,
                                  QuantityChange, UnitCost, TransactionTypeCode, OrderID, TransactionDateTime)
SELECT 'itx-ret-0001', @biz, 'stk-bag', o.LocationID, 'emp-leo', 1, c.UnitCost, 3, o.OrderID, @ret_at  -- 3 = RETURN
  FROM Orders o JOIN OrderItemComponent c ON c.OrderItemID = @ret_line AND c.StockItemID = 'stk-bag'
 WHERE o.OrderID = @ret_order;

-- Refund = the line's net amount plus its tax, prorated (what CheckRefund caps)
INSERT INTO Refund (RefundID, PaymentID, ReturnID, OrderID, BusinessID, Amount, TaxAmount, RefundDateTime,
                    Reason, RefundStatusCode, ApprovedByEmployeeID, CreatedAt, CreatedBy)
SELECT 'ref-0001', CONCAT('pay-', SUBSTRING(@ret_order, 5)), 'ret-0001', @ret_order, @biz,
       ROUND(NetAmount / Quantity, 2) + ROUND(TaxAmount / Quantity, 2), ROUND(TaxAmount / Quantity, 2),
       @ret_at, 'Unopened bag returned', 2, 'emp-leo', @ret_at, 'emp-leo'                       -- 2 = COMPLETED
  FROM OrderItem WHERE OrderItemID = @ret_line;

DROP TABLE _seed_loss, _seed_comp, _seed_linemod, _seed_line, _seed_menu, _seed_order, _seed_stock, _seed_shift, _seed_seq;

COMMIT;
