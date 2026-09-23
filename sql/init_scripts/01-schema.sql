USE miniworld;

CREATE TABLE IF NOT EXISTS Vendor (
    VendorID CHAR(36) NOT NULL,
    BusinessName VARCHAR(100) NOT NULL,
    ContactEmail VARCHAR(255),
    ContactPhone VARCHAR(30),
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (VendorID),

    INDEX IX_Vendor_BusinessName (BusinessName)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Location (
    LocationID CHAR(36) NOT NULL,
    VendorID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,
    Address VARCHAR(255),
    Phone VARCHAR(30),

    PRIMARY KEY (LocationID),

    CONSTRAINT FK_Location_Vendor
        FOREIGN KEY (VendorID)
        REFERENCES Vendor(VendorID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    INDEX IX_Location_VendorID (VendorID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS EmployeeRole (
    RoleCode TINYINT UNSIGNED NOT NULL,
    Description VARCHAR(100) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (RoleCode)
);

CREATE TABLE IF NOT EXISTS Employee (
    EmployeeID CHAR(36) NOT NULL,
    VendorID CHAR(36) NOT NULL,
    FirstName VARCHAR(50) NOT NULL,
    LastName VARCHAR(50) NOT NULL,
    Email VARCHAR(255) NOT NULL,
    RoleCode TINYINT UNSIGNED NOT NULL,
    PasswordHash VARCHAR(255) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (EmployeeID),

    CONSTRAINT FK_Employee_Vendor
        FOREIGN KEY (VendorID)
        REFERENCES Vendor(VendorID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    
    CONSTRAINT FK_Employee_RoleCode
        FOREIGN KEY (RoleCode)
        REFERENCES EmployeeRole(RoleCode)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
        
    CONSTRAINT UQ_Employee_Vendor_Email
        UNIQUE (VendorID, Email),

    INDEX IX_Employee_VendorID (VendorID)
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS EmployeeLocation (
    EmployeeID CHAR(36) NOT NULL,
    LocationID CHAR(36) NOT NULL,

    PRIMARY KEY (EmployeeID, LocationID),

    CONSTRAINT FK_EmployeeLocation_Employee
        FOREIGN KEY (EmployeeID)
        REFERENCES Employee(EmployeeID)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT FK_EmployeeLocation_Location
        FOREIGN KEY (LocationID)
        REFERENCES Location(LocationID)
        ON UPDATE CASCADE
        ON DELETE CASCADE
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

    CONSTRAINT FK_Register_Location
        FOREIGN KEY (LocationID)
        REFERENCES Location(LocationID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT FK_Register_Status
        FOREIGN KEY (RegStatusCode)
        REFERENCES RegisterStatus(RegStatusCode)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Register_Location_Name
        UNIQUE (LocationID, Name),

    INDEX IX_Register_LocationID (LocationID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Product (
    ProductID CHAR(36) NOT NULL,
    VendorID CHAR(36) NOT NULL,
    SKU VARCHAR(100) NOT NULL,
    Name VARCHAR(150) NOT NULL,
    Description TEXT,
    CurrentPrice DECIMAL(10,2) NOT NULL,
    Active BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (ProductID),

    CONSTRAINT FK_Product_Vendor
        FOREIGN KEY (VendorID)
        REFERENCES Vendor(VendorID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Product_Vendor_SKU
        UNIQUE (VendorID, SKU),

    CONSTRAINT CK_Product_CurrentPrice
        CHECK (CurrentPrice >= 0),

    INDEX IX_Product_VendorID (VendorID),
    INDEX IX_Product_Name (Name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Category (
    CategoryID CHAR(36) NOT NULL,
    VendorID CHAR(36) NOT NULL,
    Name VARCHAR(100) NOT NULL,

    PRIMARY KEY (CategoryID),

    CONSTRAINT FK_Category_Vendor
        FOREIGN KEY (VendorID)
        REFERENCES Vendor(VendorID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Category_Vendor_Name
        UNIQUE (VendorID, Name),

    INDEX IX_Category_VendorID (VendorID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ProductCategory (
    ProductID CHAR(36) NOT NULL,
    CategoryID CHAR(36) NOT NULL,

    PRIMARY KEY (ProductID, CategoryID),

    CONSTRAINT FK_ProductCategory_Product
        FOREIGN KEY (ProductID)
        REFERENCES Product(ProductID)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT FK_ProductCategory_Category
        FOREIGN KEY (CategoryID)
        REFERENCES Category(CategoryID)
        ON UPDATE CASCADE
        ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Inventory (
    InventoryID CHAR(36) NOT NULL,
    LocationID CHAR(36) NOT NULL,
    ProductID CHAR(36) NOT NULL,
    Quantity INT NOT NULL DEFAULT 0,

    PRIMARY KEY (InventoryID),

    CONSTRAINT FK_Inventory_Location
        FOREIGN KEY (LocationID)
        REFERENCES Location(LocationID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT FK_Inventory_Product
        FOREIGN KEY (ProductID)
        REFERENCES Product(ProductID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT UQ_Inventory_Location_Product
        UNIQUE (LocationID, ProductID),

    CONSTRAINT CK_Inventory_Quantity
        CHECK (Quantity >= 0),

    INDEX IX_Inventory_ProductID (ProductID),
    INDEX IX_Inventory_LocationID (LocationID)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Customer (
    CustomerID CHAR(36) NOT NULL,
    VendorID CHAR(36) NOT NULL,
    FirstName VARCHAR(50) NOT NULL,
    LastName VARCHAR(50) NOT NULL,
    Email VARCHAR(255),
    Phone VARCHAR(30),

    PRIMARY KEY (CustomerID),

    CONSTRAINT FK_Customer_Vendor
        FOREIGN KEY (VendorID)
        REFERENCES Vendor(VendorID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    INDEX IX_Customer_VendorID (VendorID),
    INDEX IX_Customer_Email (VendorID, Email)
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
    RegisterID CHAR(36),
    EmployeeID CHAR(36),
    CustomerID CHAR(36),

    ChannelCode TINYINT UNSIGNED NOT NULL,
    OrderDateTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    OrderStatusCode TINYINT UNSIGNED NOT NULL DEFAULT 1, /* 1 should map to pending_payment*/

    Subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    Tax DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    Total DECIMAL(10,2) NOT NULL DEFAULT 0.00,

    PRIMARY KEY (OrderID),

    CONSTRAINT FK_Orders_Location
        FOREIGN KEY (LocationID)
        REFERENCES Location(LocationID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT FK_Orders_Register
        FOREIGN KEY (RegisterID)
        REFERENCES Register(RegisterID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT FK_Orders_Employee
        FOREIGN KEY (EmployeeID)
        REFERENCES Employee(EmployeeID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT FK_Orders_Customer
        FOREIGN KEY (CustomerID)
        REFERENCES Customer(CustomerID)
        ON UPDATE CASCADE
        ON DELETE SET NULL,

    CONSTRAINT FK_Orders_Channel
        FOREIGN KEY (ChannelCode)
        REFERENCES OrderChannel(ChannelCode)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT FK_Orders_Status
        FOREIGN KEY (OrderStatusCode)
        REFERENCES OrderStatus(OrderStatusCode)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT CK_Orders_Amounts
        CHECK (
            Subtotal >= 0
            AND Tax >= 0
            AND Total >= 0
            AND Total = Subtotal + Tax
        ),

    INDEX IX_Orders_LocationID (LocationID),
    INDEX IX_Orders_RegisterID (RegisterID),
    INDEX IX_Orders_EmployeeID (EmployeeID),
    INDEX IX_Orders_CustomerID (CustomerID),
    INDEX IX_Orders_DateTime (OrderDateTime),
    INDEX IX_Orders_Channel_Status (ChannelCode, OrderStatusCode)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS OrderItem (
    OrderItemID CHAR(36) NOT NULL,
    OrderID CHAR(36) NOT NULL,
    ProductID CHAR(36) NOT NULL,

    Quantity INT NOT NULL,
    UnitPrice DECIMAL(10,2) NOT NULL,
    LineTotal DECIMAL(10,2) NOT NULL,

    PRIMARY KEY (OrderItemID),

    CONSTRAINT FK_OrderItem_Order
        FOREIGN KEY (OrderID)
        REFERENCES Orders(OrderID)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT FK_OrderItem_Product
        FOREIGN KEY (ProductID)
        REFERENCES Product(ProductID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT CK_OrderItem_Quantity
        CHECK (Quantity > 0),

    CONSTRAINT CK_OrderItem_UnitPrice
        CHECK (UnitPrice >= 0),

    CONSTRAINT CK_OrderItem_LineTotal
        CHECK (LineTotal = Quantity * UnitPrice),

    INDEX IX_OrderItem_OrderID (OrderID),
    INDEX IX_OrderItem_ProductID (ProductID)
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

    PRIMARY KEY (PaymentID),

    CONSTRAINT FK_Payment_Order
        FOREIGN KEY (OrderID)
        REFERENCES Orders(OrderID)
        ON UPDATE CASCADE
        ON DELETE CASCADE,

    CONSTRAINT FK_Payment_Method
        FOREIGN KEY (PaymentMethodCode)
        REFERENCES PaymentMethod(PaymentMethodCode)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT FK_Payment_Status
        FOREIGN KEY (PaymentStatusCode)
        REFERENCES PaymentStatus(PaymentStatusCode)
        ON UPDATE CASCADE
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

    ProductID CHAR(36) NOT NULL,
    LocationID CHAR(36) NOT NULL,
    EmployeeID CHAR(36),

    QuantityChange INT NOT NULL,
    TransactionTypeCode TINYINT UNSIGNED NOT NULL,

    ReferenceID CHAR(36),
    TransactionDateTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (InventoryTransactionID),

    CONSTRAINT FK_InventoryTransaction_Product
        FOREIGN KEY (ProductID)
        REFERENCES Product(ProductID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT FK_InventoryTransaction_Location
        FOREIGN KEY (LocationID)
        REFERENCES Location(LocationID)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT FK_InventoryTransaction_Employee
        FOREIGN KEY (EmployeeID)
        REFERENCES Employee(EmployeeID)
        ON UPDATE CASCADE
        ON DELETE SET NULL,

    CONSTRAINT FK_InventoryTransaction_Type
        FOREIGN KEY (TransactionTypeCode)
        REFERENCES InventoryTransactionType(TransactionTypeCode)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT CK_InventoryTransaction_Quantity
        CHECK (QuantityChange <> 0),

    INDEX IX_InventoryTransaction_ProductLocation
        (ProductID, LocationID),

    INDEX IX_InventoryTransaction_DateTime
        (TransactionDateTime),

    INDEX IX_InventoryTransaction_ReferenceID
        (ReferenceID)
) ENGINE=InnoDB;
