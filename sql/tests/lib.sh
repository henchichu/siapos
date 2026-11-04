# Setup runs as root (R); every test runs as app_user, like the backend.
R() { MYSQL_PWD=$(cat /run/secrets/db_root_password) mysql -uroot @DB@ -e "$1" 2>&1; }
q() { MYSQL_PWD=$(cat /run/secrets/app_user_password) mysql -uapp_user -h127.0.0.1 @DB@ -e "$1" 2>&1; }
v() { MYSQL_PWD=$(cat /run/secrets/app_user_password) mysql -uapp_user -h127.0.0.1 @DB@ -N -e "$1" 2>&1; }
t() {
  out=$(q "$3")
  if [ -z "$out" ]; then got=ok; else got=fail; fi
  [ "$got" = "$2" ] && r=PASS || r=FAIL
  printf "%s  %-46s %s\n" "$r" "$1" "$(echo "$out" | head -1 | sed 's/^ERROR [0-9]* ([^)]*) at line [0-9]*: //' | cut -c1-75)"
}
# Setup the app never does (locations, pay rates, pay periods, loyalty points) runs as root, like the SQL that sets up a business
s() {
  out=$(R "$3")
  if [ -z "$out" ]; then got=ok; else got=fail; fi
  [ "$got" = "$2" ] && r=PASS || r=FAIL
  printf "%s  %-46s %s\n" "$r" "$1" "$(echo "$out" | head -1 | cut -c1-75)"
}
a() {
  got=$(v "$2")
  [ "$got" = "$3" ] && r=PASS || r=FAIL
  printf "%s  %-46s = %s\n" "$r" "$1" "$got"
}

# Same as 03-privileges.sql
R "GRANT SELECT ON @DB@.* TO 'app_user'@'%';"
for tb in $(R "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='@DB@' AND TABLE_TYPE='BASE TABLE'" | tail -n +2); do
  R "REVOKE ALL PRIVILEGES ON @DB@.\`$tb\` FROM 'app_user'@'%';" >/dev/null   # table grants outlive a dropped database
  case $tb in
    Location|EmployeePayRate|LoyaltyTransaction) continue ;;
    InventoryTransaction|LowStockAlert) g="INSERT" ;;
    ApprovalAction) g="INSERT (ApprovalActionID, BusinessID, ActorEmployeeID, ApproverEmployeeID, LocationID, ActionType, TargetID, Payload)" ;;
    NotificationQueue) g="UPDATE (Status, Error, ProcessedAt)" ;;
    PayPeriod) g="UPDATE (Closed)" ;;
    Inventory) g="INSERT (InventoryID, LocationID, StockItemID, BusinessID, ReorderThreshold), UPDATE (ReorderThreshold)" ;;
    OrderItemModifier|OrderItemComponent|OrderDiscount|PromotionRedemption) g="INSERT" ;;
    OrderItem|TimeEntry) g="INSERT, UPDATE" ;;
    Payment) g="INSERT, UPDATE (PaymentStatusCode)" ;;
    Refund) g="INSERT, UPDATE (RefundStatusCode, RefundDateTime, ApprovedByEmployeeID, UpdatedBy)" ;;
    ReturnItem) g="INSERT, DELETE" ;;
    *) g="INSERT, UPDATE, DELETE" ;;
  esac
  R "GRANT $g ON @DB@.\`$tb\` TO 'app_user'@'%';" >/dev/null
done
