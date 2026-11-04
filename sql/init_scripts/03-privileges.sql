REVOKE ALL PRIVILEGES ON miniworld.* FROM 'app_user'@'%';
GRANT SELECT ON miniworld.* TO 'app_user'@'%';

-- What app_user may change is granted table by table (MySQL can't revoke one table from a
-- schema-wide grant). Rules the app never needs to break are enforced by simply not granting:
--   InventoryTransaction  insert only: the ledger is append-only (post an ADJUSTMENT to correct one)
--   Location, EmployeePayRate, LoyaltyTransaction  read only: set up and changed with SQL
--   ApprovalAction is append-only; its trigger owns discount, refund and payroll approval writes.
--   Inventory  new rows (no Quantity or cost) and the reorder level; stock changes only through the
--     ledger, whose trigger writes with its definer's rights
--   OrderItemModifier, OrderItemComponent, PromotionRedemption  insert only
--   TimeEntry  create open shifts; ChangeTimeEntry handles self-service clock actions
--   Payment  insert, and change its status (a refund marks it refunded): its amount, order, method and tip never change
--   Refund and Returns  create pending records; decisions go through ApprovalAction
--   ReturnItem  insert only; the approval trigger releases rejected returns
DELIMITER $$
CREATE PROCEDURE GrantAppUser()
BEGIN
    DECLARE vDone BOOLEAN DEFAULT FALSE;
    DECLARE vTable VARCHAR(64);
    DECLARE vGrant VARCHAR(500);
    DECLARE cTables CURSOR FOR
        SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = 'miniworld' AND TABLE_TYPE = 'BASE TABLE';
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET vDone = TRUE;
    OPEN cTables;
    grants: LOOP
        FETCH cTables INTO vTable;
        IF vDone THEN LEAVE grants; END IF;
        SET vGrant = CASE vTable
            WHEN 'Location' THEN NULL
            WHEN 'EmployeePayRate' THEN NULL
            WHEN 'LoyaltyTransaction' THEN NULL
            WHEN 'InventoryTransaction' THEN 'INSERT'
            WHEN 'LowStockAlert' THEN 'INSERT'
            WHEN 'ApprovalAction' THEN 'INSERT (ApprovalActionID, BusinessID, ActorEmployeeID, ApproverEmployeeID, LocationID, ActionType, TargetID, Payload)'
            WHEN 'Returns' THEN 'INSERT (ReturnID, OrderID, BusinessID, CreatedBy)'
            WHEN 'PayPeriod' THEN NULL
            WHEN 'Inventory' THEN 'INSERT (InventoryID, LocationID, StockItemID, BusinessID, ReorderThreshold), UPDATE (ReorderThreshold)'
            WHEN 'OrderItemModifier' THEN 'INSERT'
            WHEN 'OrderItemComponent' THEN 'INSERT'
            WHEN 'OrderDiscount' THEN NULL
            WHEN 'PromotionRedemption' THEN 'INSERT'
            WHEN 'OrderItem' THEN 'INSERT, UPDATE'
            WHEN 'Payment' THEN 'INSERT, UPDATE (PaymentStatusCode)'
            WHEN 'Refund' THEN 'INSERT (RefundID, PaymentID, ReturnID, OrderID, BusinessID, Amount, TaxAmount, Reason, CreatedBy)'
            WHEN 'ReturnItem' THEN 'INSERT'
            WHEN 'TimeEntry' THEN 'INSERT (TimeEntryID, EmployeeID, LocationID, BusinessID, PayPeriodID, ClockInAt)'
            ELSE 'INSERT, UPDATE, DELETE' END;

        -- REVOKE on miniworld.* leaves table-level grants alone, so a re-run starts each table clean
        BEGIN
            DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
            SET @r = CONCAT('REVOKE ALL PRIVILEGES ON miniworld.`', vTable, '` FROM ''app_user''@''%''');
            PREPARE s FROM @r; EXECUTE s; DEALLOCATE PREPARE s;
        END;

        IF vGrant IS NOT NULL THEN
            SET @g = CONCAT('GRANT ', vGrant, ' ON miniworld.`', vTable, '` TO ''app_user''@''%''');
            PREPARE s FROM @g; EXECUTE s; DEALLOCATE PREPARE s;
        END IF;
    END LOOP;
    CLOSE cTables;
END$$
DELIMITER ;
CALL GrantAppUser();
DROP PROCEDURE GrantAppUser;
