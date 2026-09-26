USE miniworld;

-- Update order totals to support discounts
ALTER TABLE Orders
    ADD COLUMN DiscountAmount DECIMAL(10,2) NOT NULL DEFAULT 0.00
    AFTER Tax;

ALTER TABLE Orders
    DROP CHECK CK_Orders_Amounts;

ALTER TABLE Orders
    ADD CONSTRAINT CK_Orders_Amounts
    CHECK (
        Subtotal >= 0
        AND Tax >= 0
        AND DiscountAmount >= 0
        AND Total >= 0
        AND Total = Subtotal + Tax - DiscountAmount
    );

-- Promotions
CREATE TABLE IF NOT EXISTS Promotion (
    PromotionID CHAR(36) NOT NULL,
    VendorID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    DiscountType VARCHAR(10) NOT NULL,
    DiscountValue DECIMAL(10,2) NOT NULL,
    StartsAt DATETIME NOT NULL,
    EndsAt DATETIME NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (PromotionID),
    FOREIGN KEY (VendorID) REFERENCES Vendor(VendorID) ON DELETE RESTRICT,
    CHECK (DiscountType IN ('PERCENT', 'FIXED')),
    CHECK (DiscountValue > 0),
    CHECK (DiscountType <> 'PERCENT' OR DiscountValue <= 100),
    CHECK (EndsAt > StartsAt)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS PromotionProduct (
    PromotionID CHAR(36) NOT NULL,
    ProductID CHAR(36) NOT NULL,
    PRIMARY KEY (PromotionID, ProductID),
    FOREIGN KEY (PromotionID) REFERENCES Promotion(PromotionID) ON DELETE RESTRICT,
    FOREIGN KEY (ProductID) REFERENCES Product(ProductID) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS PromotionRedemption (
    RedemptionID CHAR(36) NOT NULL,
    PromotionID CHAR(36) NOT NULL,
    OrderID CHAR(36) NOT NULL,
    DiscountAmount DECIMAL(10,2) NOT NULL,
    RedeemedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (RedemptionID),
    UNIQUE (PromotionID, OrderID),
    FOREIGN KEY (PromotionID) REFERENCES Promotion(PromotionID) ON DELETE RESTRICT,
    FOREIGN KEY (OrderID) REFERENCES Orders(OrderID) ON DELETE RESTRICT,
    CHECK (DiscountAmount > 0)
) ENGINE=InnoDB;

-- Membership and rewards
CREATE TABLE IF NOT EXISTS MembershipTier (
    TierID CHAR(36) NOT NULL,
    VendorID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    MinimumPoints INT NOT NULL DEFAULT 0,
    PRIMARY KEY (TierID),
    UNIQUE (VendorID, Name),
    FOREIGN KEY (VendorID) REFERENCES Vendor(VendorID) ON DELETE RESTRICT,
    CHECK (MinimumPoints >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS LoyaltyAccount (
    LoyaltyAccountID CHAR(36) NOT NULL,
    CustomerID CHAR(36) NOT NULL,
    TierID CHAR(36) NOT NULL,
    EnrolledAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    Active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (LoyaltyAccountID),
    UNIQUE (CustomerID),
    FOREIGN KEY (CustomerID) REFERENCES Customer(CustomerID) ON DELETE RESTRICT,
    FOREIGN KEY (TierID) REFERENCES MembershipTier(TierID) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS LoyaltyTransaction (
    LoyaltyTransactionID CHAR(36) NOT NULL,
    LoyaltyAccountID CHAR(36) NOT NULL,
    OrderID CHAR(36),
    TransactionType VARCHAR(10) NOT NULL,
    PointsChange INT NOT NULL,
    TransactionDateTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (LoyaltyTransactionID),
    FOREIGN KEY (LoyaltyAccountID) REFERENCES LoyaltyAccount(LoyaltyAccountID) ON DELETE RESTRICT,
    FOREIGN KEY (OrderID) REFERENCES Orders(OrderID) ON DELETE RESTRICT,
    CHECK (TransactionType IN ('EARN', 'REDEEM', 'ADJUST')),
    CHECK (PointsChange <> 0)
) ENGINE=InnoDB;