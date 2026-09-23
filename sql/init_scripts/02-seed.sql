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

COMMIT;
