USE miniworld;

CREATE TABLE IF NOT EXISTS Business (
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    ContactEmail VARCHAR(255),
    ContactPhone VARCHAR(30),
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
              ON UPDATE CURRENT_TIMESTAMP,
    Active BOOLEAN NOT NULL DEFAULT TRUE,
    
    PRIMARY KEY (BusinessID),

    INDEX IX_Business_Name (Name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Location (
    LocationID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    Address VARCHAR(255),
    Phone VARCHAR(30),
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

    TimeZone VARCHAR(64) NOT NULL DEFAULT 'America/Chicago',
    TaxRate DECIMAL(7,6) NOT NULL DEFAULT 0,

    PRIMARY KEY (LocationID),
    
    CONSTRAINT UQ_Location_ID_Business
        UNIQUE (LocationID, BusinessID),

    CONSTRAINT CK_Location_TaxRate
        CHECK (TaxRate >= 0 AND TaxRate <= 1),

    CONSTRAINT FK_Location_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,

    INDEX IX_Location_BusinessID (BusinessID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS EmployeeRole (
    RoleCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (RoleCode)
);

CREATE TABLE IF NOT EXISTS Employee (
    EmployeeID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    FirstName VARCHAR(50) NOT NULL,
    LastName VARCHAR(50) NOT NULL,
    Email VARCHAR(255) NOT NULL,
    RoleCode TINYINT UNSIGNED NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (EmployeeID),
    
    CONSTRAINT UQ_Employee_ID_Business
        UNIQUE (EmployeeID, BusinessID),
        
 
    CONSTRAINT FK_Employee_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,
    
    CONSTRAINT FK_Employee_RoleCode
        FOREIGN KEY (RoleCode)
        REFERENCES EmployeeRole(RoleCode)
        ON DELETE RESTRICT,
        
    CONSTRAINT UQ_Employee_Business_Email
        UNIQUE (BusinessID, Email),

    INDEX IX_Employee_BusinessID (BusinessID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS EmployeeCredential (
    EmployeeID CHAR(36) NOT NULL,
    PasswordHash VARCHAR(255) NOT NULL,
    
    PasswordUpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP 
    ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (EmployeeID),
    
    CONSTRAINT FK_EmployeeCredential_Employee
        FOREIGN KEY (EmployeeID)
        REFERENCES Employee(EmployeeID)
        ON DELETE RESTRICT
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS EmployeeLocation (
    EmployeeID CHAR(36) NOT NULL,
    LocationID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,

    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (EmployeeID, LocationID),

    CONSTRAINT FK_EmployeeLocation_Employee
        FOREIGN KEY (EmployeeID, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_EmployeeLocation_Location
        FOREIGN KEY (LocationID, BusinessID)
        REFERENCES Location(LocationID, BusinessID)
        ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS TimeEntryStatus (
    TimeEntryStatusCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (TimeEntryStatusCode)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS EmployeePayRate (
    PayRateID CHAR(36) NOT NULL,
    EmployeeID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    HourlyRate DECIMAL(10,2) NOT NULL,
    EffectiveFrom DATETIME NOT NULL,
    EffectiveTo DATETIME NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (PayRateID),

    CONSTRAINT FK_EmployeePayRate_Employee
        FOREIGN KEY (EmployeeID, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_EmployeePayRate_Employee_EffectiveFrom
        UNIQUE (EmployeeID, EffectiveFrom),

    CONSTRAINT CK_EmployeePayRate_HourlyRate
        CHECK (HourlyRate >= 0),

    CONSTRAINT CK_EmployeePayRate_EffectiveDates
        CHECK (
            EffectiveTo IS NULL
            OR EffectiveTo > EffectiveFrom
        )
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS PayPeriod (
    PayPeriodID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    StartDate DATE NOT NULL,
    EndDate DATE NOT NULL,
    Closed BOOLEAN NOT NULL DEFAULT FALSE,

    PRIMARY KEY (PayPeriodID),

    CONSTRAINT FK_PayPeriod_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_PayPeriod_Business_StartDate
        UNIQUE (BusinessID, StartDate),

    CONSTRAINT UQ_PayPeriod_ID_Business
        UNIQUE (PayPeriodID, BusinessID),

    CONSTRAINT CK_PayPeriod_Dates
        CHECK (EndDate > StartDate)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS TimeEntry (
    TimeEntryID CHAR(36) NOT NULL,
    EmployeeID CHAR(36) NOT NULL,
    LocationID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    PayPeriodID CHAR(36) NOT NULL,

    ClockInAt DATETIME NOT NULL,
    ClockOutAt DATETIME NULL,
    UnpaidBreakMinutes INT NOT NULL DEFAULT 0,
    TimeEntryStatusCode TINYINT UNSIGNED NOT NULL DEFAULT 1,
    ApprovedByEmployeeID CHAR(36),
    Notes TEXT,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (TimeEntryID),

    CONSTRAINT FK_TimeEntry_Employee
        FOREIGN KEY (EmployeeID, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_TimeEntry_Location
        FOREIGN KEY (LocationID, BusinessID)
        REFERENCES Location(LocationID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_TimeEntry_PayPeriod
        FOREIGN KEY (PayPeriodID, BusinessID)
        REFERENCES PayPeriod(PayPeriodID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_TimeEntry_Approver
        FOREIGN KEY (ApprovedByEmployeeID, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_TimeEntry_EmployeeLocation
        FOREIGN KEY (EmployeeID, LocationID)
        REFERENCES EmployeeLocation(EmployeeID, LocationID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_TimeEntry_Status
        FOREIGN KEY (TimeEntryStatusCode)
        REFERENCES TimeEntryStatus(TimeEntryStatusCode)
        ON DELETE RESTRICT,

    CONSTRAINT CK_TimeEntry_Times
        CHECK (
            ClockOutAt IS NULL
            OR ClockOutAt > ClockInAt
        ),

    CONSTRAINT CK_TimeEntry_UnpaidBreakMinutes
        CHECK (UnpaidBreakMinutes >= 0),

    CONSTRAINT CK_TimeEntry_Approved
        CHECK (
            TimeEntryStatusCode <> 3
            OR (
                ApprovedByEmployeeID IS NOT NULL
                AND ClockOutAt IS NOT NULL
            )
        ),

    INDEX IX_TimeEntry_Employee_ClockInAt
        (EmployeeID, ClockInAt),

    INDEX IX_TimeEntry_PayPeriodID
        (PayPeriodID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS RegisterStatus (
    RegStatusCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (RegStatusCode)
);

CREATE TABLE IF NOT EXISTS Register (
    RegisterID CHAR(36) NOT NULL,
    LocationID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    RegStatusCode TINYINT UNSIGNED NOT NULL DEFAULT 1,

    PRIMARY KEY (RegisterID),

    CONSTRAINT UQ_Register_RegisterID_LocationID
        UNIQUE (RegisterID, LocationID),

    CONSTRAINT FK_Register_Location
        FOREIGN KEY (LocationID)
        REFERENCES Location(LocationID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Register_Status
        FOREIGN KEY (RegStatusCode)
        REFERENCES RegisterStatus(RegStatusCode)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Register_Location_Name
        UNIQUE (LocationID, Name),

    INDEX IX_Register_LocationID (LocationID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Product (
    ProductID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    SKU VARCHAR(100) NOT NULL,
    Name VARCHAR(150) NOT NULL,
    Description TEXT,
    StockUnit VARCHAR(10) NOT NULL DEFAULT 'each',
    CurrentPrice DECIMAL(10,2), -- allow null for when the product is an ingredient that isnt for sale
    Active BOOLEAN NOT NULL DEFAULT TRUE,
    IsSellable BOOLEAN NOT NULL DEFAULT TRUE,
    IsRecipeBased BOOLEAN NOT NULL DEFAULT FALSE, -- Will help decide if the Cost will be based on ingredients or just its own cost.

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (ProductID),

    CONSTRAINT FK_Product_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Product_Business_SKU
        UNIQUE (BusinessID, SKU),

    CONSTRAINT CK_Product_CurrentPrice
        CHECK (CurrentPrice IS NULL OR CurrentPrice >= 0),

    CONSTRAINT UQ_Product_Business
        UNIQUE (ProductID, BusinessID),

    CONSTRAINT CK_Product_StockUnit
        CHECK (StockUnit IN ('g','ml','each')),

    CONSTRAINT CK_Product_SellablePrice
        CHECK (IsSellable = FALSE OR CurrentPrice IS NOT NULL),

    INDEX IX_Product_BusinessID (BusinessID),
    INDEX IX_Product_Name (Name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ProductRecipe (
    ProductID CHAR(36) NOT NULL,
    IngredientID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    QuantityPerUnit INT NOT NULL,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (ProductID, IngredientID),

    CONSTRAINT FK_ProductRecipe_Product
        FOREIGN KEY (ProductID, BusinessID)
        REFERENCES Product(ProductID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_ProductRecipe_Ingredient
        FOREIGN KEY (IngredientID, BusinessID)
        REFERENCES Product(ProductID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_ProductRecipe_Quantity
        CHECK (QuantityPerUnit > 0),

    CONSTRAINT CK_ProductRecipe_DifferentProducts
        CHECK (ProductID <> IngredientID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Supplier (
    SupplierID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    ContactEmail VARCHAR(255),
    ContactPhone VARCHAR(30),
    AccountNumber VARCHAR(50),
    LeadTimeDays INT,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (SupplierID),

    CONSTRAINT UQ_Supplier_ID_Business
        UNIQUE (SupplierID, BusinessID),

    CONSTRAINT UQ_Supplier_Business_Name
        UNIQUE (BusinessID, Name),

    CONSTRAINT FK_Supplier_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_Supplier_LeadTimeDays
        CHECK (LeadTimeDays IS NULL OR LeadTimeDays >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ProductSupplier (
    ProductID CHAR(36) NOT NULL,
    SupplierID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    SupplierSKU VARCHAR(100),
    UnitCost DECIMAL(10,2),
    MinOrderQty INT NOT NULL DEFAULT 1,
    IsPreferred BOOLEAN NOT NULL DEFAULT FALSE,

    PRIMARY KEY (ProductID, SupplierID),

    CONSTRAINT FK_ProductSupplier_Product
        FOREIGN KEY (ProductID, BusinessID)
        REFERENCES Product(ProductID, BusinessID)
        ON DELETE CASCADE,

    CONSTRAINT FK_ProductSupplier_Supplier
        FOREIGN KEY (SupplierID, BusinessID)
        REFERENCES Supplier(SupplierID, BusinessID)
        ON DELETE CASCADE,

    CONSTRAINT CK_ProductSupplier_UnitCost
        CHECK (UnitCost IS NULL OR UnitCost >= 0),

    CONSTRAINT CK_ProductSupplier_MinOrderQty
        CHECK (MinOrderQty > 0),

    INDEX IX_ProductSupplier_SupplierID (SupplierID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Category (
    CategoryID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,
    
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
              ON UPDATE CURRENT_TIMESTAMP, 

    PRIMARY KEY (CategoryID),

    CONSTRAINT FK_Category_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Category_Business_Name
        UNIQUE (BusinessID, Name),
    
       CONSTRAINT UQ_Category_Business
        UNIQUE (CategoryID, BusinessID),
    

    INDEX IX_Category_BusinessID (BusinessID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ProductCategory (
    ProductID CHAR(36) NOT NULL,
    CategoryID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,

    PRIMARY KEY (ProductID, CategoryID),

    CONSTRAINT FK_ProductCategory_Product
        FOREIGN KEY (ProductID, BusinessID)
        REFERENCES Product(ProductID, BusinessID)
        ON DELETE CASCADE,

    CONSTRAINT FK_ProductCategory_Category
        FOREIGN KEY (CategoryID, BusinessID)
        REFERENCES Category(CategoryID, BusinessID)
        ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Inventory (
    InventoryID CHAR(36) NOT NULL,
    LocationID CHAR(36) NOT NULL,
    ProductID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Quantity INT NOT NULL DEFAULT 0,
    ReorderThreshold INT NOT NULL DEFAULT 0,
    AverageUnitCost DECIMAL (18,6) NULL,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (InventoryID),

    CONSTRAINT FK_Inventory_Location
        FOREIGN KEY (LocationID, BusinessID)
        REFERENCES Location(LocationID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Inventory_Product
        FOREIGN KEY (ProductID, BusinessID)
        REFERENCES Product(ProductID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Inventory_Location_Product
        UNIQUE (LocationID, ProductID),

    CONSTRAINT CK_Inventory_Quantity
        CHECK (Quantity >= 0),
    
    CONSTRAINT CK_Inventory_ReorderThreshold
        CHECK (ReorderThreshold >= 0),

    CONSTRAINT CK_Inventory_AverageUnitCost
        CHECK (
            AverageUnitCost IS NULL
            OR AverageUnitCost >= 0 ),

    INDEX IX_Inventory_ProductID (ProductID),
    INDEX IX_Inventory_LocationID (LocationID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Customer (
    CustomerID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    FirstName VARCHAR(50),
    LastName VARCHAR(50),
    Email VARCHAR(255),
    Phone VARCHAR(30),
    Active BOOLEAN NOT NULL DEFAULT TRUE,
    
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (CustomerID),

    CONSTRAINT UQ_Customer_ID_Business
        UNIQUE(CustomerID, BusinessID),

    CONSTRAINT FK_Customer_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,
    
    CONSTRAINT CK_Customer_Contactable
        CHECK (
            Email IS NOT NULL
            OR Phone IS NOT NULL
        ),

    INDEX IX_Customer_BusinessID (BusinessID),
    INDEX IX_Customer_Email (BusinessID, Email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS OrderStatus (
    OrderStatusCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,

    PRIMARY KEY (OrderStatusCode)
);

CREATE TABLE IF NOT EXISTS OrderChannel (
    ChannelCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (ChannelCode)
);

CREATE TABLE IF NOT EXISTS Orders (
    OrderID CHAR(36) NOT NULL,
    LocationID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    RegisterID CHAR(36),
    EmployeeID CHAR(36),
    CustomerID CHAR(36),

    ChannelCode TINYINT UNSIGNED NOT NULL,
    OrderDateTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
    CompletedAt DATETIME NULL,
    OrderStatusCode TINYINT UNSIGNED NOT NULL DEFAULT 1, /* 1 should map to pending_payment*/

    Subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    Tax DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    DiscountAmount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    Total DECIMAL(10,2) NOT NULL DEFAULT 0.00,

    PRIMARY KEY (OrderID),

    CONSTRAINT UQ_Orders_ID_Business
        UNIQUE (OrderID, BusinessID),
    
    CONSTRAINT UQ_Orders_ID_Customer
        UNIQUE (OrderID, CustomerID),
    
    CONSTRAINT UQ_Orders_ID_Location
        UNIQUE (OrderID, LocationID),
    
    CONSTRAINT FK_Orders_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Orders_Location
        FOREIGN KEY (LocationID, BusinessID)
        REFERENCES Location(LocationID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Orders_Register
        FOREIGN KEY (RegisterID, LocationID)
        REFERENCES Register(RegisterID, LocationID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Orders_Employee
        FOREIGN KEY (EmployeeID, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Orders_Customer
        FOREIGN KEY (CustomerID, BusinessID)
        REFERENCES Customer(CustomerID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Orders_Channel
        FOREIGN KEY (ChannelCode)
        REFERENCES OrderChannel(ChannelCode)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Orders_Status
        FOREIGN KEY (OrderStatusCode)
        REFERENCES OrderStatus(OrderStatusCode)
        ON DELETE RESTRICT,

    CONSTRAINT CK_Orders_POS_Register
        CHECK (
            ChannelCode <> 1
            OR RegisterID IS NOT NULL
        ),

    CONSTRAINT CK_Orders_Amounts
        CHECK (
            Subtotal >= 0
            AND Tax >= 0
            AND DiscountAmount >= 0
            AND Total >= 0
            AND Total = Subtotal + Tax - DiscountAmount
        ),

    INDEX IX_Orders_LocationID (LocationID),
    INDEX IX_Orders_RegisterID (RegisterID),
    INDEX IX_Orders_EmployeeID (EmployeeID),
    INDEX IX_Orders_CustomerID (CustomerID),
    INDEX IX_Orders_DateTime (OrderDateTime),
    INDEX IX_Orders_Channel_Status (ChannelCode, OrderStatusCode)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS OrderStatusHistory (
    OrderStatusHistoryID CHAR(36) NOT NULL,
    OrderID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    OrderStatusCode TINYINT UNSIGNED NOT NULL,
    ChangedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ChangedByEmployeeID CHAR(36) NULL,

    PRIMARY KEY (OrderStatusHistoryID),
 
    CONSTRAINT FK_OrderStatusHistory_Order
        FOREIGN KEY (OrderID, BusinessID)
        REFERENCES Orders(OrderID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_OrderStatusHistory_Employee
        FOREIGN KEY (ChangedByEmployeeID, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,
    
    CONSTRAINT FK_OrderStatusHistory_Status
        FOREIGN KEY (OrderStatusCode)
        REFERENCES OrderStatus(OrderStatusCode)
        ON DELETE RESTRICT,

    INDEX IX_OrderStatusHistory_Order_Time
        (OrderID, ChangedAt)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS OrderItem (
    OrderItemID CHAR(36) NOT NULL,
    OrderID CHAR(36) NOT NULL,
    ProductID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Quantity INT NOT NULL,
    UnitPrice DECIMAL(10,2) NOT NULL,
    UnitCost DECIMAL(18,6),
    LineCost DECIMAL(18,6),    -- Total cost of the OrderItem row, useful for when Quantity > 1
    LineTotal DECIMAL(10,2) NOT NULL, -- Total Price of the row, we may choose to include tax.

    PRIMARY KEY (OrderItemID),

    CONSTRAINT UQ_OrderItem_ID_Order
        UNIQUE (OrderItemID, OrderID),

    CONSTRAINT FK_OrderItem_Order
        FOREIGN KEY (OrderID, BusinessID)
        REFERENCES Orders(OrderID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_OrderItem_Product
        FOREIGN KEY (ProductID, BusinessID)
        REFERENCES Product(ProductID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_OrderItem_Quantity
        CHECK (Quantity > 0),

    CONSTRAINT CK_OrderItem_UnitPrice
        CHECK (UnitPrice >= 0),

    CONSTRAINT CK_OrderItem_LineTotal
        CHECK (LineTotal = Quantity * UnitPrice),

    CONSTRAINT CK_OrderItem_UnitCost
        CHECK (
            UnitCost IS NULL
            OR UnitCost >= 0),

    CONSTRAINT UQ_OrderItem_ID_Business
        UNIQUE (OrderItemID, BusinessID),

    CONSTRAINT CK_OrderItem_LineCost
        CHECK (LineCost IS NULL OR  LineCost >= 0),

    INDEX IX_OrderItem_OrderID (OrderID),
    INDEX IX_OrderItem_ProductID (ProductID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS OrderItemIngredient (
    OrderItemID CHAR(36) NOT NULL,
    IngredientID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,

    QuantityUsed INT NOT NULL,
    StockUnit VARCHAR(10) NOT NULL, -- Primarily for preserving the unit in case it is later changed.
    UnitCost DECIMAL(18,6) NOT NULL,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (OrderItemID, IngredientID),

    CONSTRAINT FK_OrderItemIngredient_OrderItem
        FOREIGN KEY (OrderItemID, BusinessID)
        REFERENCES OrderItem(OrderItemID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_OrderItemIngredient_Ingredient
        FOREIGN KEY (IngredientID, BusinessID)
        REFERENCES Product(ProductID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_OrderItemIngredient_Quantity
        CHECK (QuantityUsed > 0),

    CONSTRAINT CK_OrderItemIngredient_UnitCost
        CHECK (UnitCost >= 0),

    CONSTRAINT CK_OrderItemIngredient_StockUnit
        CHECK (StockUnit IN ('g', 'ml', 'each'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS PaymentMethod (
    PaymentMethodCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (PaymentMethodCode)
);

CREATE TABLE IF NOT EXISTS PaymentStatus (
    PaymentStatusCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (PaymentStatusCode)
);

CREATE TABLE IF NOT EXISTS Payment (
    PaymentID CHAR(36) NOT NULL,
    OrderID CHAR(36) NOT NULL,

    PaymentMethodCode TINYINT UNSIGNED NOT NULL,
    Amount DECIMAL(10,2) NOT NULL,
    PaymentStatusCode TINYINT UNSIGNED NOT NULL DEFAULT 1,
    PaymentDateTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
              ON UPDATE CURRENT_TIMESTAMP,
    
    PRIMARY KEY (PaymentID),

    CONSTRAINT UQ_Payment_ID_Order
        UNIQUE (PaymentID, OrderID),

    CONSTRAINT FK_Payment_Order
        FOREIGN KEY (OrderID)
        REFERENCES Orders(OrderID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Payment_Method
        FOREIGN KEY (PaymentMethodCode)
        REFERENCES PaymentMethod(PaymentMethodCode)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Payment_Status
        FOREIGN KEY (PaymentStatusCode)
        REFERENCES PaymentStatus(PaymentStatusCode)
        ON DELETE RESTRICT,

    CONSTRAINT CK_Payment_Amount
        CHECK (Amount > 0),

    INDEX IX_Payment_OrderID (OrderID),
    INDEX IX_Payment_Status (PaymentStatusCode)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS InventoryTransactionType (
    TransactionTypeCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,

    PRIMARY KEY (TransactionTypeCode)
);

CREATE TABLE IF NOT EXISTS InventoryTransaction (
    InventoryTransactionID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    ProductID CHAR(36) NOT NULL,
    LocationID CHAR(36) NOT NULL,
    EmployeeID CHAR(36),

    QuantityChange INT NOT NULL,
    UnitCost DECIMAL(18,6),
    TransactionTypeCode TINYINT UNSIGNED NOT NULL,

    OrderID CHAR(36),
    TransactionDateTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (InventoryTransactionID),

    CONSTRAINT FK_InventoryTransaction_Product
        FOREIGN KEY (ProductID, BusinessID)
        REFERENCES Product(ProductID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_InventoryTransaction_Location
        FOREIGN KEY (LocationID, BusinessID)
        REFERENCES Location(LocationID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_InventoryTransaction_Employee
        FOREIGN KEY (EmployeeID, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_InventoryTransaction_Order
        FOREIGN KEY (OrderID, LocationID)
        REFERENCES Orders(OrderID, LocationID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_InventoryTransaction_Type
        FOREIGN KEY (TransactionTypeCode)
        REFERENCES InventoryTransactionType(TransactionTypeCode)
        ON DELETE RESTRICT,

    CONSTRAINT FK_InventoryTransaction_Inventory
        FOREIGN KEY (LocationID, ProductID)
        REFERENCES Inventory(LocationID, ProductID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_InventoryTransaction_Quantity
        CHECK ((TransactionTypeCode = 1 AND QuantityChange > 0)
                OR (TransactionTypeCode = 2 AND QuantityChange < 0)     
                OR (TransactionTypeCode = 3 AND QuantityChange > 0)
                OR (TransactionTypeCode = 4 AND QuantityChange <> 0)),

    CONSTRAINT CK_InventoryTransaction_UnitCost
        CHECK (
            UnitCost IS NULL
            OR UnitCost >= 0),

    INDEX IX_InventoryTransaction_LocationProduct
        (LocationID, ProductID),

    INDEX IX_InventoryTransaction_DateTime
        (TransactionDateTime),

    INDEX IX_InventoryTransaction_OrderID
        (OrderID)
) ENGINE=InnoDB;
-- Promotions
CREATE TABLE IF NOT EXISTS Promotion (
    PromotionID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    DiscountType VARCHAR(10) NOT NULL,
    DiscountValue DECIMAL(10,2) NOT NULL,
    StartsAt DATETIME NOT NULL,
    EndsAt DATETIME NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (PromotionID),
    FOREIGN KEY (BusinessID) REFERENCES Business(BusinessID) ON DELETE RESTRICT,
    CONSTRAINT UQ_Promotion_Business
        UNIQUE (PromotionID, BusinessID),
    CHECK (DiscountType IN ('PERCENT', 'FIXED')),
    CHECK (DiscountValue > 0),
    CHECK (DiscountType <> 'PERCENT' OR DiscountValue <= 100),
    CHECK (EndsAt > StartsAt)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS PromotionProduct (
    PromotionID CHAR(36) NOT NULL,
    ProductID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    PRIMARY KEY (PromotionID, ProductID),
    FOREIGN KEY (PromotionID, BusinessID) REFERENCES Promotion(PromotionID, BusinessID) ON DELETE RESTRICT,
    FOREIGN KEY (ProductID, BusinessID) REFERENCES Product(ProductID, BusinessID) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS PromotionRedemption (
    BusinessID CHAR(36) NOT NULL,
    RedemptionID CHAR(36) NOT NULL,
    PromotionID CHAR(36) NOT NULL,
    OrderID CHAR(36) NOT NULL,
    DiscountAmount DECIMAL(10,2) NOT NULL,
    RedeemedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (RedemptionID),
    
    CONSTRAINT UQ_PromotionRedemption_Promotion_Order
        UNIQUE (PromotionID, OrderID),

    CONSTRAINT FK_PromotionRedemption_Promotion
        FOREIGN KEY (PromotionID, BusinessID)
        REFERENCES Promotion(PromotionID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_PromotionRedemption_Order
        FOREIGN KEY (OrderID, BusinessID)
        REFERENCES Orders(OrderID, BusinessID)
        ON DELETE RESTRICT,

    CHECK (DiscountAmount > 0)
) ENGINE=InnoDB;

-- Membership and rewards
CREATE TABLE IF NOT EXISTS MembershipTier (
    TierID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    MinimumPoints INT NOT NULL DEFAULT 0,
    PRIMARY KEY (TierID),
    
    CONSTRAINT UQ_MembershipTier_ID_Business
        UNIQUE (TierID, BusinessID),
    
    CONSTRAINT UQ_MembershipTier_Business_Name
        UNIQUE (BusinessID, Name),

    CONSTRAINT FK_PromotionRedemption_Business
        FOREIGN KEY (BusinessID) REFERENCES Business(BusinessID) ON DELETE RESTRICT,
    
    CHECK (MinimumPoints >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS LoyaltyAccount (
    LoyaltyAccountID CHAR(36) NOT NULL,
    CustomerID CHAR(36) NOT NULL,
    TierID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    EnrolledAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    Active BOOLEAN NOT NULL DEFAULT TRUE,
    
    PRIMARY KEY (LoyaltyAccountID),
    
    CONSTRAINT UQ_LoyaltyAccount_Customer
        UNIQUE (CustomerID),

    CONSTRAINT UQ_LoyaltyAccount_ID_Customer
        UNIQUE (LoyaltyAccountID, CustomerID),

    CONSTRAINT FK_LoyaltyAccount_Customer
        FOREIGN KEY (CustomerID, BusinessID)
        REFERENCES Customer(CustomerID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_LoyaltyAccount_Tier
        FOREIGN KEY (TierID, BusinessID)
        REFERENCES MembershipTier(TierID, BusinessID)
        ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS LoyaltyTransaction (
    LoyaltyTransactionID CHAR(36) NOT NULL,
    LoyaltyAccountID CHAR(36) NOT NULL,
    OrderID CHAR(36),
    CustomerID CHAR(36) NOT NULL,
    TransactionType VARCHAR(10) NOT NULL,
    PointsChange INT NOT NULL,
    TransactionDateTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY (LoyaltyTransactionID),
    
    CONSTRAINT FK_LoyaltyTransaction_Account
        FOREIGN KEY (LoyaltyAccountID, CustomerID)
        REFERENCES LoyaltyAccount(LoyaltyAccountID, CustomerID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_LoyaltyTransaction_Order
        FOREIGN KEY (OrderID, CustomerID)
        REFERENCES Orders(OrderID, CustomerID)
        ON DELETE RESTRICT,
    
    CHECK (TransactionType IN ('EARN', 'REDEEM', 'ADJUST')),
    
    CHECK (PointsChange <> 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Returns (
    ReturnID CHAR(36) NOT NULL,
    OrderID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    ApprovedByEmployeeID CHAR(36) NULL,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CreatedBy CHAR(36) NOT NULL,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
    UpdatedBy CHAR(36) NULL,

    PRIMARY KEY (ReturnID),
    
    CONSTRAINT UQ_Returns_ID_Order
        UNIQUE (ReturnID, OrderID),
    
    CONSTRAINT FK_Returns_OrderID
        FOREIGN KEY (OrderID, BusinessID)
        REFERENCES Orders(OrderID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Returns_ApprovedByEmployee
        FOREIGN KEY (ApprovedByEmployeeID, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Returns_CreatedBy
        FOREIGN KEY (CreatedBy, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Returns_UpdatedBy
        FOREIGN KEY (UpdatedBy, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ReturnItem (
    ReturnItemID CHAR(36) NOT NULL,
    ReturnID CHAR(36) NOT NULL,
    OrderID CHAR(36) NOT NULL,
    OrderItemID CHAR(36) NOT NULL,
    QuantityReturned INT NOT NULL,
    QuantityRestocked INT NOT NULL DEFAULT 0,

    PRIMARY KEY (ReturnItemID),

    CONSTRAINT UQ_ReturnItem_Return_OrderItem
        UNIQUE (ReturnID, OrderItemID),

    CONSTRAINT FK_ReturnItem_Return
        FOREIGN KEY (ReturnID, OrderID)
        REFERENCES Returns(ReturnID, OrderID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_ReturnItem_OrderItem
        FOREIGN KEY (OrderItemID, OrderID)
        REFERENCES OrderItem(OrderItemID, OrderID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_ReturnItem_Quantities
        CHECK (
            QuantityReturned > 0
            AND QuantityRestocked >= 0
            AND QuantityRestocked <= QuantityReturned
        )
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Refund (
    RefundID CHAR(36) NOT NULL,
    PaymentID CHAR(36) NOT NULL,
    ReturnID CHAR(36) NULL,
    OrderID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Amount DECIMAL(10,2) NOT NULL,
    RefundDateTime DATETIME NULL,
    Reason VARCHAR(255) NOT NULL,
    Status VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    ApprovedByEmployeeID CHAR(36) NULL,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CreatedBy CHAR(36) NOT NULL,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
    UpdatedBy CHAR(36) NULL,

    PRIMARY KEY (RefundID),

    CONSTRAINT FK_Refund_Order
        FOREIGN KEY (OrderID, BusinessID)
        REFERENCES Orders(OrderID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Refund_Payment
        FOREIGN KEY (PaymentID, OrderID)
        REFERENCES Payment(PaymentID, OrderID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Refund_Return
        FOREIGN KEY (ReturnID, OrderID)
        REFERENCES Returns(ReturnID, OrderID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Refund_ApprovedBy
        FOREIGN KEY (ApprovedByEmployeeID, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Refund_CreatedBy
        FOREIGN KEY (CreatedBy, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Refund_UpdatedBy
        FOREIGN KEY (UpdatedBy, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_Refund_Amount
        CHECK (Amount > 0),

    CONSTRAINT CK_Refund_Status
        CHECK (Status IN ('PENDING', 'COMPLETED', 'FAILED')),

    CONSTRAINT CK_Refund_Completed
        CHECK (
            Status <> 'COMPLETED'
            OR (
                RefundDateTime IS NOT NULL
                AND ApprovedByEmployeeID IS NOT NULL
            )
        ),

    INDEX IX_Refund_PaymentID (PaymentID),
    INDEX IX_Refund_ReturnID (ReturnID),
    INDEX IX_Refund_DateTime (RefundDateTime)
) ENGINE=InnoDB;
