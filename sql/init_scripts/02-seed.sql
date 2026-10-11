USE miniworld;

START TRANSACTION;

INSERT INTO EmployeeRole (RoleCode, Description, Active) 
VALUES 
    (1, 'OWNER', TRUE),
    (2, 'MANAGER', TRUE),
    (3, 'CASHIER', TRUE),
    (4, 'EMPLOYEE', TRUE)
ON DUPLICATE KEY UPDATE
    Description = VALUES(Description),
    Active = VALUES(Active);
    
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
    (4, 'ADJUSTMENT')
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
