USE miniworld;

START TRANSACTION;

INSERT INTO Permission (PermissionCode, Name, GroupName)
VALUES
    (1,  'Use the register', 'Selling'),
    (2,  'Refund an order', 'Selling'),
    (3,  'Sign refund overrides', 'Selling'),
    (4,  'Approve discounts', 'Selling'),
    (5,  'See the kitchen display', 'Kitchen'),
    (6,  'Start and finish tickets', 'Kitchen'),
    (7,  'Mark orders picked up', 'Kitchen'),
    (8,  'Report a stock loss', 'Kitchen'),
    (9,  'Look up and enroll members', 'Rewards'),
    (10, 'Edit and deactivate members', 'Rewards'),
    (11, 'See products and prices', 'Products'),
    (12, 'Edit products, prices and options', 'Products'),
    (13, 'See costs and margins', 'Products'),
    (14, 'See inventory', 'Stock and orders'),
    (15, 'Restock and adjust stock', 'Stock and orders'),
    (16, 'Search orders', 'Stock and orders'),
    (17, 'See team timecards', 'People'),
    (18, 'Approve timecards', 'People'),
    (20, 'See reports', 'Business')
ON DUPLICATE KEY UPDATE
    Name = VALUES(Name),
    GroupName = VALUES(GroupName);
    
INSERT INTO TimeEntryStatus
    (TimeEntryStatusCode, Description, Active)
VALUES
    (1, 'OPEN', TRUE),
    (2, 'SUBMITTED', TRUE),
    (3, 'APPROVED', TRUE),
    (4, 'REJECTED', TRUE)
ON DUPLICATE KEY UPDATE
    Description = VALUES(Description),
    Active = VALUES(Active);

INSERT INTO RegisterStatus (RegStatusCode, Description, Active) 
VALUES 
    (1, 'ACTIVE', TRUE),
    (2, 'INACTIVE', TRUE),
    (3, 'MAINTENANCE', TRUE)
ON DUPLICATE KEY UPDATE
    Description = VALUES(Description),
    Active = VALUES(Active);


INSERT INTO OrderChannel (ChannelCode, Description, Active) 
VALUES 
    (1, 'POS', TRUE),
    (2, 'ONLINE', TRUE),  -- kept for orders with no register
    (3, 'KIOSK', TRUE)   -- a signed-in customer ordering for pickup: no register, no employee
ON DUPLICATE KEY UPDATE 
    Description = VALUES(Description),
    Active = VALUES(Active);


INSERT INTO OrderStatus (OrderStatusCode, Description) 
VALUES 
    (1, 'PENDING_PAYMENT'),
    (2, 'CONFIRMED'),
    (3, 'PREPARING'),
    (4, 'READY'),
    (5, 'COMPLETED'),
    (6, 'CANCELLED'),
    (7, 'REFUNDED')
ON DUPLICATE KEY UPDATE 
    Description = VALUES(Description);


INSERT INTO PaymentMethod (PaymentMethodCode, Description, Active) 
VALUES 
    (1, 'CASH', TRUE),
    (2, 'CARD', TRUE),
    (4, 'OTHER', TRUE),
    (5, 'APPLE_PAY', TRUE),
    (6, 'GOOGLE_PAY', TRUE)
ON DUPLICATE KEY UPDATE 
    Description = VALUES(Description),
    Active = VALUES(Active);


INSERT INTO PaymentStatus (PaymentStatusCode, Description, Active) 
VALUES 
    (1, 'PENDING_PAYMENT', TRUE),
    (2, 'AUTHORIZED', TRUE),
    (3, 'COMPLETED', TRUE),
    (4, 'FAILED', TRUE),
    (5, 'REFUNDED', TRUE)
ON DUPLICATE KEY UPDATE 
    Description = VALUES(Description),
    Active = VALUES(Active);


INSERT INTO InventoryTransactionType (TransactionTypeCode, Description) 
VALUES 
    (1, 'RESTOCK'),
    (2, 'SALE'),
    (3, 'RETURN'),
    (4, 'ADJUSTMENT'),
    (5, 'DAMAGED'),
    (6, 'EXPIRED'),
    (7, 'THEFT'),
    (8, 'COUNT_CORRECTION')
ON DUPLICATE KEY UPDATE 
    Description = VALUES(Description);

INSERT INTO UnitOfMeasure
    (UnitCode, Symbol, Description, BaseUnitCode, ToBaseFactor, AllowsFraction, Active)
VALUES      -- base units come before the units that convert to them
    (1, 'each',  'Each',            1, 1.000000,   FALSE, TRUE),
    (2, 'g',     'Gram',            2, 1.000000,   TRUE,  TRUE),
    (3, 'kg',    'Kilogram',        2, 1000.000000, TRUE, TRUE),
    (4, 'lb',    'Pound',           2, 453.592370, TRUE,  TRUE),
    (5, 'oz',    'Ounce',           2, 28.349523,  TRUE,  TRUE),
    (6, 'ml',    'Millilitre',      6, 1.000000,   TRUE,  TRUE),
    (7, 'l',     'Litre',           6, 1000.000000, TRUE, TRUE),
    (8, 'fl oz', 'US fluid ounce',  6, 29.573530,  TRUE,  TRUE)
ON DUPLICATE KEY UPDATE
    Symbol = VALUES(Symbol),
    Description = VALUES(Description),
    BaseUnitCode = VALUES(BaseUnitCode),
    ToBaseFactor = VALUES(ToBaseFactor),
    AllowsFraction = VALUES(AllowsFraction),
    Active = VALUES(Active);

INSERT INTO DiscountType (DiscountTypeCode, Description, Active)
VALUES
    (1, 'PERCENT', TRUE),
    (2, 'FIXED', TRUE)
ON DUPLICATE KEY UPDATE
    Description = VALUES(Description),
    Active = VALUES(Active);

INSERT INTO LoyaltyTransactionType (LoyaltyTransactionTypeCode, Description, Active)
VALUES
    (1, 'EARN', TRUE),
    (2, 'REDEEM', TRUE),
    (3, 'ADJUST', TRUE)
ON DUPLICATE KEY UPDATE
    Description = VALUES(Description),
    Active = VALUES(Active);

INSERT INTO RefundStatus (RefundStatusCode, Description, Active)
VALUES
    (1, 'PENDING', TRUE),
    (2, 'COMPLETED', TRUE),
    (3, 'FAILED', TRUE)
ON DUPLICATE KEY UPDATE
    Description = VALUES(Description),
    Active = VALUES(Active);

-- The one business, its one café and its roles: the same on every install. sql/provision/provision.sql fills in the real
-- name, details and address; sql/dev/05-dev-seed.sql adds the demo data. Server ids (server/customer.js) name role-customer.
INSERT INTO Business (BusinessID, Name, ContactEmail, ContactPhone, RefundOverrideAmount, RefundOverrideDays)
VALUES ('biz-brewbean', 'Brewbean Coffee', 'hello@brewbean.example.com', '312-555-0100', 25.00, 7)
ON DUPLICATE KEY UPDATE BusinessID = BusinessID;

INSERT INTO Location (LocationID, BusinessID, Name, Address, Phone, TimeZone)
VALUES ('loc-downtown', 'biz-brewbean', 'Brewbean Downtown', '120 Example St, Chicago, IL', '312-555-0101', 'America/Chicago')
ON DUPLICATE KEY UPDATE LocationID = LocationID;

-- OpensTo is the page shown after sign-in
INSERT INTO Role (RoleID, BusinessID, Name, OpensTo)
VALUES
    ('role-gm',       'biz-brewbean', 'General manager',   'REGISTER'),
    ('role-manager',  'biz-brewbean', 'Manager',           'REGISTER'),
    ('role-asst',     'biz-brewbean', 'Assistant manager', 'REGISTER'),
    ('role-server',   'biz-brewbean', 'Server',            'REGISTER'),
    ('role-barista',  'biz-brewbean', 'Chef / barista',    'KITCHEN'),
    ('role-customer', 'biz-brewbean', 'Customer',          'KIOSK')   -- no permissions: customers have their own session and the kiosk routes
ON DUPLICATE KEY UPDATE Name = VALUES(Name), OpensTo = VALUES(OpensTo);

-- Managers add 3 (refund overrides), 18 (approve timecards) and 20 (reports): only the general manager and managers see Reports
INSERT IGNORE INTO RolePermission (RoleID, BusinessID, PermissionCode)
SELECT r.RoleID, 'biz-brewbean', p.PermissionCode
  FROM Role r JOIN Permission p
    ON (r.RoleID = 'role-barista' AND p.PermissionCode IN (5, 6, 8))
    OR (r.RoleID = 'role-server'  AND p.PermissionCode IN (1, 2, 5, 7, 9, 11))
    OR (r.RoleID = 'role-gm'      AND p.PermissionCode BETWEEN 1 AND 20)
    OR (r.RoleID = 'role-asst'    AND p.PermissionCode IN (1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17))
    OR (r.RoleID = 'role-manager' AND p.PermissionCode IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20));

COMMIT;
