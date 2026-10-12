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
    PricesIncludeTax BOOLEAN NOT NULL DEFAULT FALSE,
    
    PRIMARY KEY (BusinessID),

    INDEX IX_Business_Name (Name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS TaxCategory (
    TaxCategoryID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(50) NOT NULL,                 -- 'Standard', 'Grocery', 'Exempt'
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (TaxCategoryID),

    CONSTRAINT UQ_TaxCategory_ID_Business
        UNIQUE (TaxCategoryID, BusinessID),

    CONSTRAINT UQ_TaxCategory_Business_Name
        UNIQUE (BusinessID, Name),

    CONSTRAINT FK_TaxCategory_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT
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

    TimeZone VARCHAR(64) NOT NULL,             -- IANA name, e.g. 'America/Chicago', will reference SQL timezone table, no default should be set per location

    PRIMARY KEY (LocationID),
    
    CONSTRAINT UQ_Location_ID_Business
        UNIQUE (LocationID, BusinessID),

    CONSTRAINT FK_Location_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,

    INDEX IX_Location_BusinessID (BusinessID)
) ENGINE=InnoDB;

-- One row per category a location sells; a missing row blocks the sale (use Rate 0 for exempt)
CREATE TABLE IF NOT EXISTS LocationTaxRate (
    LocationID CHAR(36) NOT NULL,
    TaxCategoryID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Rate DECIMAL(7,6) NOT NULL,                -- 0.082500 = 8.25%, combined state + local

    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (LocationID, TaxCategoryID),

    CONSTRAINT FK_LocationTaxRate_Location
        FOREIGN KEY (LocationID, BusinessID)
        REFERENCES Location(LocationID, BusinessID)
        ON DELETE CASCADE,

    CONSTRAINT FK_LocationTaxRate_TaxCategory
        FOREIGN KEY (TaxCategoryID, BusinessID)
        REFERENCES TaxCategory(TaxCategoryID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_LocationTaxRate_Rate
        CHECK (Rate >= 0 AND Rate <= 1),

    INDEX IX_LocationTaxRate_TaxCategory (TaxCategoryID, BusinessID)
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

CREATE TABLE IF NOT EXISTS UnitOfMeasure (
    UnitCode TINYINT UNSIGNED NOT NULL,
    Symbol VARCHAR(10) NOT NULL,               -- 'kg', 'ml', 'each'
    Description VARCHAR(50) NOT NULL,
    BaseUnitCode TINYINT UNSIGNED NOT NULL,    -- unit it converts to; itself for base units
    ToBaseFactor DECIMAL(18,6) NOT NULL,       -- 1 kg = 1000 g
    AllowsFraction BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE for 'each'; enforced by the backend
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (UnitCode),

    CONSTRAINT UQ_UnitOfMeasure_Symbol
        UNIQUE (Symbol),

    CONSTRAINT FK_UnitOfMeasure_BaseUnit
        FOREIGN KEY (BaseUnitCode)
        REFERENCES UnitOfMeasure(UnitCode)
        ON DELETE RESTRICT,

    CONSTRAINT CK_UnitOfMeasure_Factor
        CHECK (ToBaseFactor > 0),

    CONSTRAINT CK_UnitOfMeasure_BaseFactor
        CHECK (UnitCode <> BaseUnitCode OR ToBaseFactor = 1)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Product (
    ProductID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(150) NOT NULL,
    Description TEXT,
    ImageKey VARCHAR(512),          -- storage path/key of the picture; the backend stores and serves the file
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (ProductID),

    CONSTRAINT FK_Product_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Product_Business
        UNIQUE (ProductID, BusinessID),

    INDEX IX_Product_BusinessID (BusinessID),
    INDEX IX_Product_Name (Name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ProductVariant (
    VariantID CHAR(36) NOT NULL,
    ProductID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL DEFAULT 'Regular',   -- e.g. 'Small', 'Large', 'M / Blue'
    SKU VARCHAR(100) NOT NULL,
    Price DECIMAL(10,2) NOT NULL,              -- per SellUnit
    SellUnitCode TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- 1 = each
    TaxCategoryID CHAR(36) NOT NULL,
    RestockOnReturn BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE for resale goods, FALSE for prepared items
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (VariantID),

    CONSTRAINT FK_ProductVariant_Product
        FOREIGN KEY (ProductID, BusinessID)
        REFERENCES Product(ProductID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_ProductVariant_ID_Business
        UNIQUE (VariantID, BusinessID),

    CONSTRAINT UQ_ProductVariant_Business_SKU
        UNIQUE (BusinessID, SKU),

    CONSTRAINT UQ_ProductVariant_Product_Name
        UNIQUE (ProductID, Name),

    CONSTRAINT FK_ProductVariant_SellUnit
        FOREIGN KEY (SellUnitCode)
        REFERENCES UnitOfMeasure(UnitCode)
        ON DELETE RESTRICT,

    CONSTRAINT FK_ProductVariant_TaxCategory
        FOREIGN KEY (TaxCategoryID, BusinessID)
        REFERENCES TaxCategory(TaxCategoryID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_ProductVariant_Price
        CHECK (Price >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS StockItem (
    StockItemID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(150) NOT NULL,
    StockUnitCode TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- 1 = each
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (StockItemID),

    CONSTRAINT FK_StockItem_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_StockItem_ID_Business
        UNIQUE (StockItemID, BusinessID),

    CONSTRAINT UQ_StockItem_Business_Name
        UNIQUE (BusinessID, Name),

    CONSTRAINT FK_StockItem_StockUnit
        FOREIGN KEY (StockUnitCode)
        REFERENCES UnitOfMeasure(UnitCode)
        ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS VariantRecipe (
    VariantID CHAR(36) NOT NULL,
    StockItemID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    QuantityPerUnit DECIMAL(12,3) NOT NULL,    -- StockItem units used per one SellUnit of the variant

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (VariantID, StockItemID),

    CONSTRAINT FK_VariantRecipe_Variant
        FOREIGN KEY (VariantID, BusinessID)
        REFERENCES ProductVariant(VariantID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_VariantRecipe_StockItem
        FOREIGN KEY (StockItemID, BusinessID)
        REFERENCES StockItem(StockItemID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_VariantRecipe_Quantity
        CHECK (QuantityPerUnit > 0),

    INDEX IX_VariantRecipe_StockItemID (StockItemID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ModifierGroup (
    ModifierGroupID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,                -- e.g. 'Milk', 'Extras'
    MinSelect TINYINT UNSIGNED NOT NULL DEFAULT 0,
    MaxSelect TINYINT UNSIGNED NULL,           -- NULL = no limit
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (ModifierGroupID),

    CONSTRAINT FK_ModifierGroup_Business
        FOREIGN KEY (BusinessID)
        REFERENCES Business(BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_ModifierGroup_ID_Business
        UNIQUE (ModifierGroupID, BusinessID),

    CONSTRAINT UQ_ModifierGroup_Business_Name
        UNIQUE (BusinessID, Name),

    CONSTRAINT CK_ModifierGroup_Select
        CHECK (MaxSelect IS NULL OR (MaxSelect >= 1 AND MaxSelect >= MinSelect))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Modifier (
    ModifierID CHAR(36) NOT NULL,
    ModifierGroupID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,                -- e.g. 'almond milk', 'extra shot'
    PriceDelta DECIMAL(10,2) NOT NULL DEFAULT 0.00,  -- may be negative, e.g. 'no cheese'
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (ModifierID),

    CONSTRAINT FK_Modifier_Group
        FOREIGN KEY (ModifierGroupID, BusinessID)
        REFERENCES ModifierGroup(ModifierGroupID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Modifier_ID_Business
        UNIQUE (ModifierID, BusinessID),

    CONSTRAINT UQ_Modifier_Group_Name
        UNIQUE (ModifierGroupID, Name)
) ENGINE=InnoDB;

-- Modifier adds a fixed amount of stock: 'Extra shot' = +18 g espresso beans
CREATE TABLE IF NOT EXISTS ModifierAddition (
    ModifierID CHAR(36) NOT NULL,
    StockItemID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Quantity DECIMAL(12,3) NOT NULL,

    PRIMARY KEY (ModifierID, StockItemID),

    CONSTRAINT FK_ModifierAddition_Modifier
        FOREIGN KEY (ModifierID, BusinessID)
        REFERENCES Modifier(ModifierID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_ModifierAddition_StockItem
        FOREIGN KEY (StockItemID, BusinessID)
        REFERENCES StockItem(StockItemID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_ModifierAddition_Quantity
        CHECK (Quantity > 0)
) ENGINE=InnoDB;

-- Modifier swaps or removes a recipe line, whatever its size-specific quantity:
-- 'Oat milk' = dairy milk -> oat milk; 'No ice' = ice -> NULL (removed)
CREATE TABLE IF NOT EXISTS ModifierSubstitution (
    ModifierID CHAR(36) NOT NULL,
    FromStockItemID CHAR(36) NOT NULL,
    ToStockItemID CHAR(36) NULL,               -- NULL = remove the line
    BusinessID CHAR(36) NOT NULL,

    PRIMARY KEY (ModifierID, FromStockItemID),

    CONSTRAINT FK_ModifierSubstitution_Modifier
        FOREIGN KEY (ModifierID, BusinessID)
        REFERENCES Modifier(ModifierID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_ModifierSubstitution_From
        FOREIGN KEY (FromStockItemID, BusinessID)
        REFERENCES StockItem(StockItemID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_ModifierSubstitution_To
        FOREIGN KEY (ToStockItemID, BusinessID)
        REFERENCES StockItem(StockItemID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_ModifierSubstitution_Different
        CHECK (ToStockItemID IS NULL OR ToStockItemID <> FromStockItemID)
) ENGINE=InnoDB;

-- Which modifier groups are offered on which products (all variants of the product)
CREATE TABLE IF NOT EXISTS ProductModifierGroup (
    ProductID CHAR(36) NOT NULL,
    ModifierGroupID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    SortOrder TINYINT UNSIGNED NOT NULL DEFAULT 0,

    PRIMARY KEY (ProductID, ModifierGroupID),

    CONSTRAINT FK_ProductModifierGroup_Product
        FOREIGN KEY (ProductID, BusinessID)
        REFERENCES Product(ProductID, BusinessID)
        ON DELETE CASCADE,

    CONSTRAINT FK_ProductModifierGroup_Group
        FOREIGN KEY (ModifierGroupID, BusinessID)
        REFERENCES ModifierGroup(ModifierGroupID, BusinessID)
        ON DELETE CASCADE,

    INDEX IX_ProductModifierGroup_GroupID (ModifierGroupID)
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

CREATE TABLE IF NOT EXISTS StockItemSupplier (
    StockItemID CHAR(36) NOT NULL,
    SupplierID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    SupplierSKU VARCHAR(100),
    UnitCost DECIMAL(18,6),                    -- quoted cost per StockUnit
    MinOrderQty INT NOT NULL DEFAULT 1,
    IsPreferred BOOLEAN NOT NULL DEFAULT FALSE,

    PRIMARY KEY (StockItemID, SupplierID),

    CONSTRAINT FK_StockItemSupplier_StockItem
        FOREIGN KEY (StockItemID, BusinessID)
        REFERENCES StockItem(StockItemID, BusinessID)
        ON DELETE CASCADE,

    CONSTRAINT FK_StockItemSupplier_Supplier
        FOREIGN KEY (SupplierID, BusinessID)
        REFERENCES Supplier(SupplierID, BusinessID)
        ON DELETE CASCADE,

    CONSTRAINT CK_StockItemSupplier_UnitCost
        CHECK (UnitCost IS NULL OR UnitCost >= 0),

    CONSTRAINT CK_StockItemSupplier_MinOrderQty
        CHECK (MinOrderQty > 0),

    -- Non-preferred rows index as NULL, which UNIQUE ignores
    CONSTRAINT UQ_StockItemSupplier_Preferred
        UNIQUE ((IF(IsPreferred, StockItemID, NULL))),

    INDEX IX_StockItemSupplier_SupplierID (SupplierID)
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
    StockItemID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Quantity DECIMAL(12,3) NOT NULL DEFAULT 0,
    ReorderThreshold DECIMAL(12,3) NOT NULL DEFAULT 0,
    AverageUnitCost DECIMAL (18,6) NULL,

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (InventoryID),

    CONSTRAINT FK_Inventory_Location
        FOREIGN KEY (LocationID, BusinessID)
        REFERENCES Location(LocationID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_Inventory_StockItem
        FOREIGN KEY (StockItemID, BusinessID)
        REFERENCES StockItem(StockItemID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Inventory_Location_StockItem
        UNIQUE (LocationID, StockItemID),

    CONSTRAINT CK_Inventory_Quantity
        CHECK (Quantity >= 0),

    CONSTRAINT CK_Inventory_ReorderThreshold
        CHECK (ReorderThreshold >= 0),

    CONSTRAINT CK_Inventory_AverageUnitCost
        CHECK (
            AverageUnitCost IS NULL
            OR AverageUnitCost >= 0 ),

    INDEX IX_Inventory_StockItemID (StockItemID),
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

    CONSTRAINT UQ_Customer_Business_Email
        UNIQUE (BusinessID, Email),            -- NULLs allowed; case-insensitive collation

    INDEX IX_Customer_BusinessID (BusinessID),
    INDEX IX_Customer_Phone (BusinessID, Phone)
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

    Subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,        -- sum of OrderItem.LineTotal
    Tax DECIMAL(10,2) NOT NULL DEFAULT 0.00,             -- sum of OrderItem.TaxAmount; net sales = Total - Tax
    DiscountAmount DECIMAL(10,2) NOT NULL DEFAULT 0.00,  -- sum of OrderItem.DiscountAmount
    Total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    PricesIncludeTax BOOLEAN NOT NULL DEFAULT FALSE,     -- copied from Business by TR_Orders_BeforeInsert

    PRIMARY KEY (OrderID),

    CONSTRAINT UQ_Orders_ID_Business
        UNIQUE (OrderID, BusinessID),
    
    CONSTRAINT UQ_Orders_ID_Customer
        UNIQUE (OrderID, CustomerID),
    
    CONSTRAINT UQ_Orders_ID_Location
        UNIQUE (OrderID, LocationID),

    CONSTRAINT UQ_Orders_ID_PricesIncludeTax
        UNIQUE (OrderID, PricesIncludeTax),
    
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

    CONSTRAINT FK_Orders_EmployeeLocation
        FOREIGN KEY (EmployeeID, LocationID)
        REFERENCES EmployeeLocation(EmployeeID, LocationID)
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
            AND DiscountAmount <= Subtotal
            AND Total >= 0
            AND Tax <= Total
            AND Total = Subtotal - DiscountAmount + IF(PricesIncludeTax, 0, Tax)
        ),

    CONSTRAINT CK_Orders_Completed
        CHECK (OrderStatusCode <> 5 OR CompletedAt IS NOT NULL),   -- 5 = COMPLETED

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
    VariantID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Quantity DECIMAL(12,3) NOT NULL,           -- in the variant's SellUnit
    UnitPrice DECIMAL(10,2) NOT NULL,          -- variant price + modifier deltas, at sale time
    UnitCost DECIMAL(18,6),
    LineCost DECIMAL(18,6),    -- Total cost of the OrderItem row, useful for when Quantity > 1
    LineTotal DECIMAL(10,2) NOT NULL,          -- Quantity x UnitPrice, before discount (tax included if the order's prices include it)
    DiscountAmount DECIMAL(10,2) NOT NULL DEFAULT 0.00,  -- this line's share of all discounts
    TaxCategoryID CHAR(36) NOT NULL,           -- snapshot of the variant's category
    TaxRate DECIMAL(7,6) NOT NULL,             -- snapshot of LocationTaxRate.Rate
    TaxAmount DECIMAL(10,2) NOT NULL,          -- tax on (LineTotal - DiscountAmount)
    PricesIncludeTax BOOLEAN NOT NULL DEFAULT FALSE,  -- copied from the order by TR_OrderItem_BeforeInsert
    NetAmount DECIMAL(10,2) AS
        (LineTotal - DiscountAmount - IF(PricesIncludeTax, TaxAmount, 0)) STORED,  -- revenue before tax

    PRIMARY KEY (OrderItemID),

    CONSTRAINT UQ_OrderItem_ID_Order
        UNIQUE (OrderItemID, OrderID),

    CONSTRAINT FK_OrderItem_Order
        FOREIGN KEY (OrderID, BusinessID)
        REFERENCES Orders(OrderID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_OrderItem_Variant
        FOREIGN KEY (VariantID, BusinessID)
        REFERENCES ProductVariant(VariantID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_OrderItem_Quantity
        CHECK (Quantity > 0),

    CONSTRAINT CK_OrderItem_UnitPrice
        CHECK (UnitPrice >= 0),

    CONSTRAINT CK_OrderItem_LineTotal
        CHECK (LineTotal = ROUND(Quantity * UnitPrice, 2)),

    CONSTRAINT FK_OrderItem_TaxCategory
        FOREIGN KEY (TaxCategoryID, BusinessID)
        REFERENCES TaxCategory(TaxCategoryID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_OrderItem_Discount
        CHECK (DiscountAmount >= 0 AND DiscountAmount <= LineTotal),

    CONSTRAINT CK_OrderItem_TaxRate
        CHECK (TaxRate >= 0 AND TaxRate <= 1),

    -- Tax on top: amount x rate. Tax included: backed out as amount x rate / (1 + rate)
    CONSTRAINT CK_OrderItem_TaxAmount
        CHECK (TaxAmount = ROUND((LineTotal - DiscountAmount) * TaxRate
                                 / IF(PricesIncludeTax, 1 + TaxRate, 1), 2)),

    -- No cascade, so this also stops the order's flag changing once it has lines
    CONSTRAINT FK_OrderItem_OrderPricing
        FOREIGN KEY (OrderID, PricesIncludeTax)
        REFERENCES Orders(OrderID, PricesIncludeTax)
        ON DELETE RESTRICT,

    CONSTRAINT CK_OrderItem_UnitCost
        CHECK (
            UnitCost IS NULL
            OR UnitCost >= 0),

    CONSTRAINT UQ_OrderItem_ID_Business
        UNIQUE (OrderItemID, BusinessID),

    CONSTRAINT CK_OrderItem_LineCost
        CHECK (LineCost IS NULL OR  LineCost >= 0),

    CONSTRAINT CK_OrderItem_CostPair
        CHECK (
            (UnitCost IS NULL AND LineCost IS NULL)
            OR (UnitCost IS NOT NULL AND LineCost IS NOT NULL
                AND LineCost = ROUND(Quantity * UnitCost, 6))
        ),

    INDEX IX_OrderItem_OrderID (OrderID),
    INDEX IX_OrderItem_VariantID (VariantID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS OrderItemModifier (
    OrderItemID CHAR(36) NOT NULL,
    ModifierID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Quantity INT NOT NULL DEFAULT 1,           -- e.g. 2 x 'Extra shot'
    PriceDelta DECIMAL(10,2) NOT NULL,         -- snapshot of Modifier.PriceDelta at sale time

    PRIMARY KEY (OrderItemID, ModifierID),

    CONSTRAINT FK_OrderItemModifier_OrderItem
        FOREIGN KEY (OrderItemID, BusinessID)
        REFERENCES OrderItem(OrderItemID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_OrderItemModifier_Modifier
        FOREIGN KEY (ModifierID, BusinessID)
        REFERENCES Modifier(ModifierID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_OrderItemModifier_Quantity
        CHECK (Quantity > 0),

    INDEX IX_OrderItemModifier_ModifierID (ModifierID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS OrderItemComponent (
    OrderItemID CHAR(36) NOT NULL,
    StockItemID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,

    QuantityUsed DECIMAL(12,3) NOT NULL,                 -- after recipe x quantity and modifiers
    StockUnitCode TINYINT UNSIGNED NOT NULL,   -- snapshot, in case the unit changes later
    UnitCost DECIMAL(18,6) NOT NULL,           -- Inventory.AverageUnitCost at sale time

    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (OrderItemID, StockItemID),

    CONSTRAINT FK_OrderItemComponent_OrderItem
        FOREIGN KEY (OrderItemID, BusinessID)
        REFERENCES OrderItem(OrderItemID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_OrderItemComponent_StockItem
        FOREIGN KEY (StockItemID, BusinessID)
        REFERENCES StockItem(StockItemID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_OrderItemComponent_Quantity
        CHECK (QuantityUsed > 0),

    CONSTRAINT CK_OrderItemComponent_UnitCost
        CHECK (UnitCost >= 0),

    CONSTRAINT FK_OrderItemComponent_StockUnit
        FOREIGN KEY (StockUnitCode)
        REFERENCES UnitOfMeasure(UnitCode)
        ON DELETE RESTRICT,

    INDEX IX_OrderItemComponent_StockItemID (StockItemID)
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
    Amount DECIMAL(10,2) NOT NULL,                  -- this payment's share of Orders.Total
    TipAmount DECIMAL(10,2) NOT NULL DEFAULT 0.00,  -- on top of Amount; not a sale, so not in Total
    TipLockedAt DATETIME NULL,                      -- NULL: tip can still be adjusted (restaurant style)
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

    CONSTRAINT CK_Payment_TipAmount
        CHECK (TipAmount >= 0),

    INDEX IX_Payment_OrderID (OrderID),
    INDEX IX_Payment_Status (PaymentStatusCode),
    INDEX IX_Payment_TipLockedAt (TipLockedAt)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS InventoryTransactionType (
    TransactionTypeCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,

    PRIMARY KEY (TransactionTypeCode)
);

CREATE TABLE IF NOT EXISTS InventoryTransaction (
    InventoryTransactionID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    StockItemID CHAR(36) NOT NULL,
    LocationID CHAR(36) NOT NULL,
    EmployeeID CHAR(36),

    QuantityChange DECIMAL(12,3) NOT NULL,
    UnitCost DECIMAL(18,6),
    TransactionTypeCode TINYINT UNSIGNED NOT NULL,

    OrderID CHAR(36),
    TransactionDateTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (InventoryTransactionID),

    CONSTRAINT FK_InventoryTransaction_StockItem
        FOREIGN KEY (StockItemID, BusinessID)
        REFERENCES StockItem(StockItemID, BusinessID)
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
        FOREIGN KEY (LocationID, StockItemID)
        REFERENCES Inventory(LocationID, StockItemID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_InventoryTransaction_Quantity
        CHECK ((TransactionTypeCode = 1 AND QuantityChange > 0)
                OR (TransactionTypeCode = 2 AND QuantityChange < 0)     
                OR (TransactionTypeCode = 3 AND QuantityChange > 0)
                OR (TransactionTypeCode = 4 AND QuantityChange <> 0)
                OR (TransactionTypeCode IN (5, 6, 7) AND QuantityChange < 0)   -- 5 DAMAGED, 6 EXPIRED, 7 THEFT
                OR (TransactionTypeCode = 8 AND QuantityChange <> 0)),         -- 8 COUNT_CORRECTION

    CONSTRAINT CK_InventoryTransaction_UnitCost
        CHECK (
            UnitCost IS NULL
            OR UnitCost >= 0),

    CONSTRAINT CK_InventoryTransaction_RestockCost
        CHECK (TransactionTypeCode <> 1 OR UnitCost IS NOT NULL),       -- 1 = RESTOCK

    -- Losses carry the average cost at the time, so shrinkage can be reported in money
    CONSTRAINT CK_InventoryTransaction_LossCost
        CHECK (TransactionTypeCode NOT IN (5, 6, 7) OR UnitCost IS NOT NULL),

    CONSTRAINT CK_InventoryTransaction_OrderRequired
        CHECK (TransactionTypeCode NOT IN (2, 3) OR OrderID IS NOT NULL),  -- 2 = SALE, 3 = RETURN

    INDEX IX_InventoryTransaction_LocationStockItem
        (LocationID, StockItemID),

    INDEX IX_InventoryTransaction_DateTime
        (TransactionDateTime),

    INDEX IX_InventoryTransaction_OrderID
        (OrderID)
) ENGINE=InnoDB;
-- Promotions
CREATE TABLE IF NOT EXISTS DiscountType (
    DiscountTypeCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (DiscountTypeCode)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Promotion (
    PromotionID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    DiscountTypeCode TINYINT UNSIGNED NOT NULL,
    DiscountValue DECIMAL(10,2) NOT NULL,
    StartsAt DATETIME NOT NULL,
    EndsAt DATETIME NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (PromotionID),
    FOREIGN KEY (BusinessID) REFERENCES Business(BusinessID) ON DELETE RESTRICT,
    CONSTRAINT UQ_Promotion_Business
        UNIQUE (PromotionID, BusinessID),
    CONSTRAINT FK_Promotion_DiscountType
        FOREIGN KEY (DiscountTypeCode)
        REFERENCES DiscountType(DiscountTypeCode)
        ON DELETE RESTRICT,
    CHECK (DiscountValue > 0),
    CONSTRAINT CK_Promotion_PercentMax
        CHECK (DiscountTypeCode <> 1 OR DiscountValue <= 100),   -- 1 = PERCENT
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

-- A one-off discount outside any promotion; a manager or owner approves it (04-triggers.sql)
CREATE TABLE IF NOT EXISTS OrderDiscount (
    OrderDiscountID CHAR(36) NOT NULL,
    OrderID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Amount DECIMAL(10,2) NOT NULL,
    Reason VARCHAR(255) NOT NULL,
    ApprovedByEmployeeID CHAR(36) NOT NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (OrderDiscountID),

    CONSTRAINT FK_OrderDiscount_Order
        FOREIGN KEY (OrderID, BusinessID)
        REFERENCES Orders(OrderID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT FK_OrderDiscount_ApprovedBy
        FOREIGN KEY (ApprovedByEmployeeID, BusinessID)
        REFERENCES Employee(EmployeeID, BusinessID)
        ON DELETE RESTRICT,

    CONSTRAINT CK_OrderDiscount_Amount
        CHECK (Amount > 0),

    CONSTRAINT CK_OrderDiscount_Reason
        CHECK (TRIM(Reason) <> ''),

    INDEX IX_OrderDiscount_OrderID (OrderID)
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

CREATE TABLE IF NOT EXISTS LoyaltyTransactionType (
    LoyaltyTransactionTypeCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (LoyaltyTransactionTypeCode)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS LoyaltyTransaction (
    LoyaltyTransactionID CHAR(36) NOT NULL,
    LoyaltyAccountID CHAR(36) NOT NULL,
    OrderID CHAR(36),
    CustomerID CHAR(36) NOT NULL,
    LoyaltyTransactionTypeCode TINYINT UNSIGNED NOT NULL,
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
    
    CONSTRAINT FK_LoyaltyTransaction_Type
        FOREIGN KEY (LoyaltyTransactionTypeCode)
        REFERENCES LoyaltyTransactionType(LoyaltyTransactionTypeCode)
        ON DELETE RESTRICT,

    CONSTRAINT CK_LoyaltyTransaction_Points
        CHECK ((LoyaltyTransactionTypeCode = 1 AND PointsChange > 0)       -- EARN
            OR (LoyaltyTransactionTypeCode = 2 AND PointsChange < 0)       -- REDEEM
            OR (LoyaltyTransactionTypeCode = 3 AND PointsChange <> 0))     -- ADJUST
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
    QuantityReturned DECIMAL(12,3) NOT NULL,
    QuantityRestocked DECIMAL(12,3) NOT NULL DEFAULT 0,

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

CREATE TABLE IF NOT EXISTS RefundStatus (
    RefundStatusCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (RefundStatusCode)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Refund (
    RefundID CHAR(36) NOT NULL,
    PaymentID CHAR(36) NOT NULL,
    ReturnID CHAR(36) NULL,
    OrderID CHAR(36) NOT NULL,
    BusinessID CHAR(36) NOT NULL,
    Amount DECIMAL(10,2) NOT NULL,             -- total paid back, tax included
    TaxAmount DECIMAL(10,2) NOT NULL DEFAULT 0.00,  -- the part of Amount that is tax
    RefundDateTime DATETIME NULL,
    Reason VARCHAR(255) NOT NULL,
    RefundStatusCode TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- 1 = PENDING
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

    CONSTRAINT CK_Refund_TaxAmount
        CHECK (TaxAmount >= 0 AND TaxAmount <= Amount),

    CONSTRAINT FK_Refund_Status
        FOREIGN KEY (RefundStatusCode)
        REFERENCES RefundStatus(RefundStatusCode)
        ON DELETE RESTRICT,

    CONSTRAINT CK_Refund_Completed
        CHECK (
            RefundStatusCode <> 2   -- 2 = COMPLETED
            OR (
                RefundDateTime IS NOT NULL
                AND ApprovedByEmployeeID IS NOT NULL
            )
        ),

    INDEX IX_Refund_PaymentID (PaymentID),
    INDEX IX_Refund_ReturnID (ReturnID),
    INDEX IX_Refund_DateTime (RefundDateTime)
) ENGINE=InnoDB;
