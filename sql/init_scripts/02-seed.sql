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
    (19, 'Manage employees and pay rates', 'People'),
    (20, 'See reports', 'Business'),
    (21, 'Change settings', 'Business'),
    (22, 'Manage roles', 'Business')
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
    (2, 'ONLINE', TRUE)
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
    (3, 'GIFT_CARD', TRUE),
    (4, 'OTHER', TRUE)
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

COMMIT;
