-- MySQL dump 10.13  Distrib 26.7.0, for Linux (x86_64)
--
-- Host: localhost    Database: miniworld
-- ------------------------------------------------------
-- Server version	26.7.0

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Current Database: `miniworld`
--

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `miniworld` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */ /*!80016 DEFAULT ENCRYPTION='N' */;

USE `miniworld`;

--
-- Table structure for table `Category`
--

DROP TABLE IF EXISTS `Category`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Category` (
  `CategoryID` char(36) NOT NULL,
  `VendorID` char(36) NOT NULL,
  `Name` varchar(100) NOT NULL,
  PRIMARY KEY (`CategoryID`),
  UNIQUE KEY `UQ_Category_Vendor_Name` (`VendorID`,`Name`),
  KEY `IX_Category_VendorID` (`VendorID`),
  CONSTRAINT `FK_Category_Vendor` FOREIGN KEY (`VendorID`) REFERENCES `Vendor` (`VendorID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Category`
--

LOCK TABLES `Category` WRITE;
/*!40000 ALTER TABLE `Category` DISABLE KEYS */;
/*!40000 ALTER TABLE `Category` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `Customer`
--

DROP TABLE IF EXISTS `Customer`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Customer` (
  `CustomerID` char(36) NOT NULL,
  `VendorID` char(36) NOT NULL,
  `FirstName` varchar(50) NOT NULL,
  `LastName` varchar(50) NOT NULL,
  `Email` varchar(255) DEFAULT NULL,
  `Phone` varchar(30) DEFAULT NULL,
  PRIMARY KEY (`CustomerID`),
  KEY `IX_Customer_VendorID` (`VendorID`),
  KEY `IX_Customer_Email` (`VendorID`,`Email`),
  CONSTRAINT `FK_Customer_Vendor` FOREIGN KEY (`VendorID`) REFERENCES `Vendor` (`VendorID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Customer`
--

LOCK TABLES `Customer` WRITE;
/*!40000 ALTER TABLE `Customer` DISABLE KEYS */;
/*!40000 ALTER TABLE `Customer` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `Employee`
--

DROP TABLE IF EXISTS `Employee`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Employee` (
  `EmployeeID` char(36) NOT NULL,
  `VendorID` char(36) NOT NULL,
  `FirstName` varchar(50) NOT NULL,
  `LastName` varchar(50) NOT NULL,
  `Email` varchar(255) NOT NULL,
  `RoleCode` tinyint unsigned NOT NULL,
  `PasswordHash` varchar(255) NOT NULL,
  `Active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`EmployeeID`),
  UNIQUE KEY `UQ_Employee_Vendor_Email` (`VendorID`,`Email`),
  KEY `FK_Employee_RoleCode` (`RoleCode`),
  KEY `IX_Employee_VendorID` (`VendorID`),
  CONSTRAINT `FK_Employee_RoleCode` FOREIGN KEY (`RoleCode`) REFERENCES `EmployeeRole` (`RoleCode`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_Employee_Vendor` FOREIGN KEY (`VendorID`) REFERENCES `Vendor` (`VendorID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Employee`
--

LOCK TABLES `Employee` WRITE;
/*!40000 ALTER TABLE `Employee` DISABLE KEYS */;
/*!40000 ALTER TABLE `Employee` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `EmployeeLocation`
--

DROP TABLE IF EXISTS `EmployeeLocation`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `EmployeeLocation` (
  `EmployeeID` char(36) NOT NULL,
  `LocationID` char(36) NOT NULL,
  PRIMARY KEY (`EmployeeID`,`LocationID`),
  KEY `FK_EmployeeLocation_Location` (`LocationID`),
  CONSTRAINT `FK_EmployeeLocation_Employee` FOREIGN KEY (`EmployeeID`) REFERENCES `Employee` (`EmployeeID`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_EmployeeLocation_Location` FOREIGN KEY (`LocationID`) REFERENCES `Location` (`LocationID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `EmployeeLocation`
--

LOCK TABLES `EmployeeLocation` WRITE;
/*!40000 ALTER TABLE `EmployeeLocation` DISABLE KEYS */;
/*!40000 ALTER TABLE `EmployeeLocation` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `EmployeeRole`
--

DROP TABLE IF EXISTS `EmployeeRole`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `EmployeeRole` (
  `RoleCode` tinyint unsigned NOT NULL,
  `Description` varchar(100) NOT NULL,
  `Active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`RoleCode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `EmployeeRole`
--

LOCK TABLES `EmployeeRole` WRITE;
/*!40000 ALTER TABLE `EmployeeRole` DISABLE KEYS */;
INSERT INTO `EmployeeRole` VALUES (1,'OWNER',1),(2,'MANAGER',1),(3,'CASHIER',1),(4,'EMPLOYEE',1);
/*!40000 ALTER TABLE `EmployeeRole` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `Inventory`
--

DROP TABLE IF EXISTS `Inventory`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Inventory` (
  `InventoryID` char(36) NOT NULL,
  `LocationID` char(36) NOT NULL,
  `ProductID` char(36) NOT NULL,
  `Quantity` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`InventoryID`),
  UNIQUE KEY `UQ_Inventory_Location_Product` (`LocationID`,`ProductID`),
  KEY `IX_Inventory_ProductID` (`ProductID`),
  KEY `IX_Inventory_LocationID` (`LocationID`),
  CONSTRAINT `FK_Inventory_Location` FOREIGN KEY (`LocationID`) REFERENCES `Location` (`LocationID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_Inventory_Product` FOREIGN KEY (`ProductID`) REFERENCES `Product` (`ProductID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `CK_Inventory_Quantity` CHECK ((`Quantity` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Inventory`
--

LOCK TABLES `Inventory` WRITE;
/*!40000 ALTER TABLE `Inventory` DISABLE KEYS */;
/*!40000 ALTER TABLE `Inventory` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `InventoryTransaction`
--

DROP TABLE IF EXISTS `InventoryTransaction`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `InventoryTransaction` (
  `InventoryTransactionID` char(36) NOT NULL,
  `ProductID` char(36) NOT NULL,
  `LocationID` char(36) NOT NULL,
  `EmployeeID` char(36) DEFAULT NULL,
  `QuantityChange` int NOT NULL,
  `TransactionTypeCode` tinyint unsigned NOT NULL,
  `ReferenceID` char(36) DEFAULT NULL,
  `TransactionDateTime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`InventoryTransactionID`),
  KEY `FK_InventoryTransaction_Location` (`LocationID`),
  KEY `FK_InventoryTransaction_Employee` (`EmployeeID`),
  KEY `FK_InventoryTransaction_Type` (`TransactionTypeCode`),
  KEY `IX_InventoryTransaction_ProductLocation` (`ProductID`,`LocationID`),
  KEY `IX_InventoryTransaction_DateTime` (`TransactionDateTime`),
  KEY `IX_InventoryTransaction_ReferenceID` (`ReferenceID`),
  CONSTRAINT `FK_InventoryTransaction_Employee` FOREIGN KEY (`EmployeeID`) REFERENCES `Employee` (`EmployeeID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `FK_InventoryTransaction_Location` FOREIGN KEY (`LocationID`) REFERENCES `Location` (`LocationID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_InventoryTransaction_Product` FOREIGN KEY (`ProductID`) REFERENCES `Product` (`ProductID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_InventoryTransaction_Type` FOREIGN KEY (`TransactionTypeCode`) REFERENCES `InventoryTransactionType` (`TransactionTypeCode`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `CK_InventoryTransaction_Quantity` CHECK ((`QuantityChange` <> 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `InventoryTransaction`
--

LOCK TABLES `InventoryTransaction` WRITE;
/*!40000 ALTER TABLE `InventoryTransaction` DISABLE KEYS */;
/*!40000 ALTER TABLE `InventoryTransaction` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `InventoryTransactionType`
--

DROP TABLE IF EXISTS `InventoryTransactionType`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `InventoryTransactionType` (
  `TransactionTypeCode` tinyint unsigned NOT NULL,
  `Description` varchar(100) NOT NULL,
  PRIMARY KEY (`TransactionTypeCode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `InventoryTransactionType`
--

LOCK TABLES `InventoryTransactionType` WRITE;
/*!40000 ALTER TABLE `InventoryTransactionType` DISABLE KEYS */;
INSERT INTO `InventoryTransactionType` VALUES (1,'RESTOCK'),(2,'SALE'),(3,'RETURN'),(4,'ADJUSTMENT');
/*!40000 ALTER TABLE `InventoryTransactionType` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `Location`
--

DROP TABLE IF EXISTS `Location`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Location` (
  `LocationID` char(36) NOT NULL,
  `VendorID` char(36) NOT NULL,
  `Name` varchar(100) NOT NULL,
  `Address` varchar(255) DEFAULT NULL,
  `Phone` varchar(30) DEFAULT NULL,
  PRIMARY KEY (`LocationID`),
  KEY `IX_Location_VendorID` (`VendorID`),
  CONSTRAINT `FK_Location_Vendor` FOREIGN KEY (`VendorID`) REFERENCES `Vendor` (`VendorID`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Location`
--

LOCK TABLES `Location` WRITE;
/*!40000 ALTER TABLE `Location` DISABLE KEYS */;
/*!40000 ALTER TABLE `Location` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `LoyaltyAccount`
--

DROP TABLE IF EXISTS `LoyaltyAccount`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `LoyaltyAccount` (
  `LoyaltyAccountID` char(36) NOT NULL,
  `CustomerID` char(36) NOT NULL,
  `TierID` char(36) NOT NULL,
  `EnrolledAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `Active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`LoyaltyAccountID`),
  UNIQUE KEY `CustomerID` (`CustomerID`),
  KEY `TierID` (`TierID`),
  CONSTRAINT `loyaltyaccount_ibfk_1` FOREIGN KEY (`CustomerID`) REFERENCES `Customer` (`CustomerID`) ON DELETE RESTRICT,
  CONSTRAINT `loyaltyaccount_ibfk_2` FOREIGN KEY (`TierID`) REFERENCES `MembershipTier` (`TierID`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `LoyaltyAccount`
--

LOCK TABLES `LoyaltyAccount` WRITE;
/*!40000 ALTER TABLE `LoyaltyAccount` DISABLE KEYS */;
/*!40000 ALTER TABLE `LoyaltyAccount` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `LoyaltyTransaction`
--

DROP TABLE IF EXISTS `LoyaltyTransaction`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `LoyaltyTransaction` (
  `LoyaltyTransactionID` char(36) NOT NULL,
  `LoyaltyAccountID` char(36) NOT NULL,
  `OrderID` char(36) DEFAULT NULL,
  `TransactionType` varchar(10) NOT NULL,
  `PointsChange` int NOT NULL,
  `TransactionDateTime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`LoyaltyTransactionID`),
  KEY `LoyaltyAccountID` (`LoyaltyAccountID`),
  KEY `OrderID` (`OrderID`),
  CONSTRAINT `loyaltytransaction_ibfk_1` FOREIGN KEY (`LoyaltyAccountID`) REFERENCES `LoyaltyAccount` (`LoyaltyAccountID`) ON DELETE RESTRICT,
  CONSTRAINT `loyaltytransaction_ibfk_2` FOREIGN KEY (`OrderID`) REFERENCES `Orders` (`OrderID`) ON DELETE RESTRICT,
  CONSTRAINT `loyaltytransaction_chk_1` CHECK ((`TransactionType` in (_latin1'EARN',_latin1'REDEEM',_latin1'ADJUST'))),
  CONSTRAINT `loyaltytransaction_chk_2` CHECK ((`PointsChange` <> 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `LoyaltyTransaction`
--

LOCK TABLES `LoyaltyTransaction` WRITE;
/*!40000 ALTER TABLE `LoyaltyTransaction` DISABLE KEYS */;
/*!40000 ALTER TABLE `LoyaltyTransaction` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `MembershipTier`
--

DROP TABLE IF EXISTS `MembershipTier`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `MembershipTier` (
  `TierID` char(36) NOT NULL,
  `VendorID` char(36) NOT NULL,
  `Name` varchar(100) NOT NULL,
  `MinimumPoints` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`TierID`),
  UNIQUE KEY `VendorID` (`VendorID`,`Name`),
  CONSTRAINT `membershiptier_ibfk_1` FOREIGN KEY (`VendorID`) REFERENCES `Vendor` (`VendorID`) ON DELETE RESTRICT,
  CONSTRAINT `membershiptier_chk_1` CHECK ((`MinimumPoints` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `MembershipTier`
--

LOCK TABLES `MembershipTier` WRITE;
/*!40000 ALTER TABLE `MembershipTier` DISABLE KEYS */;
/*!40000 ALTER TABLE `MembershipTier` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `OrderChannel`
--

DROP TABLE IF EXISTS `OrderChannel`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `OrderChannel` (
  `ChannelCode` tinyint unsigned NOT NULL,
  `Description` varchar(100) NOT NULL,
  `Active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`ChannelCode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `OrderChannel`
--

LOCK TABLES `OrderChannel` WRITE;
/*!40000 ALTER TABLE `OrderChannel` DISABLE KEYS */;
INSERT INTO `OrderChannel` VALUES (1,'POS',1),(2,'ONLINE',1);
/*!40000 ALTER TABLE `OrderChannel` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `OrderItem`
--

DROP TABLE IF EXISTS `OrderItem`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `OrderItem` (
  `OrderItemID` char(36) NOT NULL,
  `OrderID` char(36) NOT NULL,
  `ProductID` char(36) NOT NULL,
  `Quantity` int NOT NULL,
  `UnitPrice` decimal(10,2) NOT NULL,
  `LineTotal` decimal(10,2) NOT NULL,
  PRIMARY KEY (`OrderItemID`),
  KEY `IX_OrderItem_OrderID` (`OrderID`),
  KEY `IX_OrderItem_ProductID` (`ProductID`),
  CONSTRAINT `FK_OrderItem_Order` FOREIGN KEY (`OrderID`) REFERENCES `Orders` (`OrderID`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_OrderItem_Product` FOREIGN KEY (`ProductID`) REFERENCES `Product` (`ProductID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `CK_OrderItem_LineTotal` CHECK ((`LineTotal` = (`Quantity` * `UnitPrice`))),
  CONSTRAINT `CK_OrderItem_Quantity` CHECK ((`Quantity` > 0)),
  CONSTRAINT `CK_OrderItem_UnitPrice` CHECK ((`UnitPrice` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `OrderItem`
--

LOCK TABLES `OrderItem` WRITE;
/*!40000 ALTER TABLE `OrderItem` DISABLE KEYS */;
/*!40000 ALTER TABLE `OrderItem` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `Orders`
--

DROP TABLE IF EXISTS `Orders`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Orders` (
  `OrderID` char(36) NOT NULL,
  `LocationID` char(36) NOT NULL,
  `RegisterID` char(36) DEFAULT NULL,
  `EmployeeID` char(36) DEFAULT NULL,
  `CustomerID` char(36) DEFAULT NULL,
  `ChannelCode` tinyint unsigned NOT NULL,
  `OrderDateTime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `OrderStatusCode` tinyint unsigned NOT NULL DEFAULT '1',
  `Subtotal` decimal(10,2) NOT NULL DEFAULT '0.00',
  `Tax` decimal(10,2) NOT NULL DEFAULT '0.00',
  `DiscountAmount` decimal(10,2) NOT NULL DEFAULT '0.00',
  `Total` decimal(10,2) NOT NULL DEFAULT '0.00',
  PRIMARY KEY (`OrderID`),
  KEY `FK_Orders_Status` (`OrderStatusCode`),
  KEY `IX_Orders_LocationID` (`LocationID`),
  KEY `IX_Orders_RegisterID` (`RegisterID`),
  KEY `IX_Orders_EmployeeID` (`EmployeeID`),
  KEY `IX_Orders_CustomerID` (`CustomerID`),
  KEY `IX_Orders_DateTime` (`OrderDateTime`),
  KEY `IX_Orders_Channel_Status` (`ChannelCode`,`OrderStatusCode`),
  CONSTRAINT `FK_Orders_Channel` FOREIGN KEY (`ChannelCode`) REFERENCES `OrderChannel` (`ChannelCode`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_Orders_Customer` FOREIGN KEY (`CustomerID`) REFERENCES `Customer` (`CustomerID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `FK_Orders_Employee` FOREIGN KEY (`EmployeeID`) REFERENCES `Employee` (`EmployeeID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_Orders_Location` FOREIGN KEY (`LocationID`) REFERENCES `Location` (`LocationID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_Orders_Register` FOREIGN KEY (`RegisterID`) REFERENCES `Register` (`RegisterID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_Orders_Status` FOREIGN KEY (`OrderStatusCode`) REFERENCES `OrderStatus` (`OrderStatusCode`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `CK_Orders_Amounts` CHECK (((`Subtotal` >= 0) and (`Tax` >= 0) and (`DiscountAmount` >= 0) and (`Total` >= 0) and (`Total` = ((`Subtotal` + `Tax`) - `DiscountAmount`))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Orders`
--

LOCK TABLES `Orders` WRITE;
/*!40000 ALTER TABLE `Orders` DISABLE KEYS */;
/*!40000 ALTER TABLE `Orders` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `OrderStatus`
--

DROP TABLE IF EXISTS `OrderStatus`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `OrderStatus` (
  `OrderStatusCode` tinyint unsigned NOT NULL,
  `Description` varchar(100) NOT NULL,
  PRIMARY KEY (`OrderStatusCode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `OrderStatus`
--

LOCK TABLES `OrderStatus` WRITE;
/*!40000 ALTER TABLE `OrderStatus` DISABLE KEYS */;
INSERT INTO `OrderStatus` VALUES (1,'PENDING_PAYMENT'),(2,'CONFIRMED'),(3,'PREPARING'),(4,'READY'),(5,'COMPLETED'),(6,'CANCELLED'),(7,'REFUNDED');
/*!40000 ALTER TABLE `OrderStatus` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `Payment`
--

DROP TABLE IF EXISTS `Payment`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Payment` (
  `PaymentID` char(36) NOT NULL,
  `OrderID` char(36) NOT NULL,
  `PaymentMethodCode` tinyint unsigned NOT NULL,
  `Amount` decimal(10,2) NOT NULL,
  `PaymentStatusCode` tinyint unsigned NOT NULL DEFAULT '1',
  `PaymentDateTime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`PaymentID`),
  KEY `FK_Payment_Method` (`PaymentMethodCode`),
  KEY `IX_Payment_OrderID` (`OrderID`),
  KEY `IX_Payment_Status` (`PaymentStatusCode`),
  CONSTRAINT `FK_Payment_Method` FOREIGN KEY (`PaymentMethodCode`) REFERENCES `PaymentMethod` (`PaymentMethodCode`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_Payment_Order` FOREIGN KEY (`OrderID`) REFERENCES `Orders` (`OrderID`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_Payment_Status` FOREIGN KEY (`PaymentStatusCode`) REFERENCES `PaymentStatus` (`PaymentStatusCode`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `CK_Payment_Amount` CHECK ((`Amount` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Payment`
--

LOCK TABLES `Payment` WRITE;
/*!40000 ALTER TABLE `Payment` DISABLE KEYS */;
/*!40000 ALTER TABLE `Payment` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `PaymentMethod`
--

DROP TABLE IF EXISTS `PaymentMethod`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `PaymentMethod` (
  `PaymentMethodCode` tinyint unsigned NOT NULL,
  `Description` varchar(100) NOT NULL,
  `Active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`PaymentMethodCode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `PaymentMethod`
--

LOCK TABLES `PaymentMethod` WRITE;
/*!40000 ALTER TABLE `PaymentMethod` DISABLE KEYS */;
INSERT INTO `PaymentMethod` VALUES (1,'CASH',1),(2,'CARD',1),(3,'GIFT_CARD',1),(4,'OTHER',1);
/*!40000 ALTER TABLE `PaymentMethod` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `PaymentStatus`
--

DROP TABLE IF EXISTS `PaymentStatus`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `PaymentStatus` (
  `PaymentStatusCode` tinyint unsigned NOT NULL,
  `Description` varchar(100) NOT NULL,
  `Active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`PaymentStatusCode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `PaymentStatus`
--

LOCK TABLES `PaymentStatus` WRITE;
/*!40000 ALTER TABLE `PaymentStatus` DISABLE KEYS */;
INSERT INTO `PaymentStatus` VALUES (1,'PENDING_PAYMENT',1),(2,'AUTHORIZED',1),(3,'COMPLETED',1),(4,'FAILED',1),(5,'REFUNDED',1);
/*!40000 ALTER TABLE `PaymentStatus` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `Product`
--

DROP TABLE IF EXISTS `Product`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Product` (
  `ProductID` char(36) NOT NULL,
  `VendorID` char(36) NOT NULL,
  `SKU` varchar(100) NOT NULL,
  `Name` varchar(150) NOT NULL,
  `Description` text,
  `CurrentPrice` decimal(10,2) NOT NULL,
  `Active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`ProductID`),
  UNIQUE KEY `UQ_Product_Vendor_SKU` (`VendorID`,`SKU`),
  KEY `IX_Product_VendorID` (`VendorID`),
  KEY `IX_Product_Name` (`Name`),
  CONSTRAINT `FK_Product_Vendor` FOREIGN KEY (`VendorID`) REFERENCES `Vendor` (`VendorID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `CK_Product_CurrentPrice` CHECK ((`CurrentPrice` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Product`
--

LOCK TABLES `Product` WRITE;
/*!40000 ALTER TABLE `Product` DISABLE KEYS */;
/*!40000 ALTER TABLE `Product` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `ProductCategory`
--

DROP TABLE IF EXISTS `ProductCategory`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ProductCategory` (
  `ProductID` char(36) NOT NULL,
  `CategoryID` char(36) NOT NULL,
  PRIMARY KEY (`ProductID`,`CategoryID`),
  KEY `FK_ProductCategory_Category` (`CategoryID`),
  CONSTRAINT `FK_ProductCategory_Category` FOREIGN KEY (`CategoryID`) REFERENCES `Category` (`CategoryID`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_ProductCategory_Product` FOREIGN KEY (`ProductID`) REFERENCES `Product` (`ProductID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `ProductCategory`
--

LOCK TABLES `ProductCategory` WRITE;
/*!40000 ALTER TABLE `ProductCategory` DISABLE KEYS */;
/*!40000 ALTER TABLE `ProductCategory` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `Promotion`
--

DROP TABLE IF EXISTS `Promotion`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Promotion` (
  `PromotionID` char(36) NOT NULL,
  `VendorID` char(36) NOT NULL,
  `Name` varchar(100) NOT NULL,
  `DiscountType` varchar(10) NOT NULL,
  `DiscountValue` decimal(10,2) NOT NULL,
  `StartsAt` datetime NOT NULL,
  `EndsAt` datetime NOT NULL,
  `Active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`PromotionID`),
  KEY `VendorID` (`VendorID`),
  CONSTRAINT `promotion_ibfk_1` FOREIGN KEY (`VendorID`) REFERENCES `Vendor` (`VendorID`) ON DELETE RESTRICT,
  CONSTRAINT `promotion_chk_1` CHECK ((`DiscountType` in (_latin1'PERCENT',_latin1'FIXED'))),
  CONSTRAINT `promotion_chk_2` CHECK ((`DiscountValue` > 0)),
  CONSTRAINT `promotion_chk_3` CHECK (((`DiscountType` <> _latin1'PERCENT') or (`DiscountValue` <= 100))),
  CONSTRAINT `promotion_chk_4` CHECK ((`EndsAt` > `StartsAt`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Promotion`
--

LOCK TABLES `Promotion` WRITE;
/*!40000 ALTER TABLE `Promotion` DISABLE KEYS */;
/*!40000 ALTER TABLE `Promotion` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `PromotionProduct`
--

DROP TABLE IF EXISTS `PromotionProduct`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `PromotionProduct` (
  `PromotionID` char(36) NOT NULL,
  `ProductID` char(36) NOT NULL,
  PRIMARY KEY (`PromotionID`,`ProductID`),
  KEY `ProductID` (`ProductID`),
  CONSTRAINT `promotionproduct_ibfk_1` FOREIGN KEY (`PromotionID`) REFERENCES `Promotion` (`PromotionID`) ON DELETE RESTRICT,
  CONSTRAINT `promotionproduct_ibfk_2` FOREIGN KEY (`ProductID`) REFERENCES `Product` (`ProductID`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `PromotionProduct`
--

LOCK TABLES `PromotionProduct` WRITE;
/*!40000 ALTER TABLE `PromotionProduct` DISABLE KEYS */;
/*!40000 ALTER TABLE `PromotionProduct` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `PromotionRedemption`
--

DROP TABLE IF EXISTS `PromotionRedemption`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `PromotionRedemption` (
  `RedemptionID` char(36) NOT NULL,
  `PromotionID` char(36) NOT NULL,
  `OrderID` char(36) NOT NULL,
  `DiscountAmount` decimal(10,2) NOT NULL,
  `RedeemedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`RedemptionID`),
  UNIQUE KEY `PromotionID` (`PromotionID`,`OrderID`),
  KEY `OrderID` (`OrderID`),
  CONSTRAINT `promotionredemption_ibfk_1` FOREIGN KEY (`PromotionID`) REFERENCES `Promotion` (`PromotionID`) ON DELETE RESTRICT,
  CONSTRAINT `promotionredemption_ibfk_2` FOREIGN KEY (`OrderID`) REFERENCES `Orders` (`OrderID`) ON DELETE RESTRICT,
  CONSTRAINT `promotionredemption_chk_1` CHECK ((`DiscountAmount` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `PromotionRedemption`
--

LOCK TABLES `PromotionRedemption` WRITE;
/*!40000 ALTER TABLE `PromotionRedemption` DISABLE KEYS */;
/*!40000 ALTER TABLE `PromotionRedemption` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `Register`
--

DROP TABLE IF EXISTS `Register`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Register` (
  `RegisterID` char(36) NOT NULL,
  `LocationID` char(36) NOT NULL,
  `Name` varchar(100) NOT NULL,
  `RegStatusCode` tinyint unsigned NOT NULL DEFAULT '1',
  PRIMARY KEY (`RegisterID`),
  UNIQUE KEY `UQ_Register_Location_Name` (`LocationID`,`Name`),
  KEY `FK_Register_Status` (`RegStatusCode`),
  KEY `IX_Register_LocationID` (`LocationID`),
  CONSTRAINT `FK_Register_Location` FOREIGN KEY (`LocationID`) REFERENCES `Location` (`LocationID`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FK_Register_Status` FOREIGN KEY (`RegStatusCode`) REFERENCES `RegisterStatus` (`RegStatusCode`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Register`
--

LOCK TABLES `Register` WRITE;
/*!40000 ALTER TABLE `Register` DISABLE KEYS */;
/*!40000 ALTER TABLE `Register` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `RegisterStatus`
--

DROP TABLE IF EXISTS `RegisterStatus`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `RegisterStatus` (
  `RegStatusCode` tinyint unsigned NOT NULL,
  `Description` varchar(100) NOT NULL,
  `Active` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`RegStatusCode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `RegisterStatus`
--

LOCK TABLES `RegisterStatus` WRITE;
/*!40000 ALTER TABLE `RegisterStatus` DISABLE KEYS */;
INSERT INTO `RegisterStatus` VALUES (1,'ACTIVE',1),(2,'INACTIVE',1),(3,'MAINTENANCE',1);
/*!40000 ALTER TABLE `RegisterStatus` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `Vendor`
--

DROP TABLE IF EXISTS `Vendor`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `Vendor` (
  `VendorID` char(36) NOT NULL,
  `BusinessName` varchar(100) NOT NULL,
  `ContactEmail` varchar(255) DEFAULT NULL,
  `ContactPhone` varchar(30) DEFAULT NULL,
  `CreatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`VendorID`),
  KEY `IX_Vendor_BusinessName` (`BusinessName`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `Vendor`
--

LOCK TABLES `Vendor` WRITE;
/*!40000 ALTER TABLE `Vendor` DISABLE KEYS */;
/*!40000 ALTER TABLE `Vendor` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping events for database 'miniworld'
--

--
-- Dumping routines for database 'miniworld'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-09-26 17:35:34
