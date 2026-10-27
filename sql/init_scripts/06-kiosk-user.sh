#!/bin/sh
set -e

# The public order server's own database login. It can read the menu and the customer's own orders and write new orders, and
# nothing else: no staff, roles, PINs, pay, timecards, refunds or settings. (Triggers run with their definer's rights, so the
# stock and numbering rules still apply to what it writes.)
# Runs on a fresh database; on an existing one: docker compose exec mysql-db sh /docker-entrypoint-initdb.d/06-kiosk-user.sh
PW="$(cat /run/secrets/kiosk_user_password)"
MYSQL_PWD="$(cat /run/secrets/db_root_password)" mysql -uroot <<SQL
CREATE USER IF NOT EXISTS 'kiosk_user'@'%' IDENTIFIED BY '$PW';
ALTER USER 'kiosk_user'@'%' IDENTIFIED BY '$PW';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'kiosk_user'@'%';
GRANT SELECT ON miniworld.Business TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.Location TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.Register TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.Product TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.ProductVariant TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.Category TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.VariantRecipe TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.Inventory TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.StockItem TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.ProductModifierGroup TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.ModifierGroup TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.Modifier TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.ModifierSubstitution TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.ModifierAddition TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.LocationTaxRate TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.Promotion TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.PromotionProduct TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.Customer TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.LoyaltyAccount TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.MembershipTier TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.LoyaltyTransaction TO 'kiosk_user'@'%';
GRANT SELECT ON miniworld.OrderStatus TO 'kiosk_user'@'%';
GRANT SELECT, INSERT, UPDATE ON miniworld.Orders TO 'kiosk_user'@'%';
GRANT SELECT, INSERT, UPDATE ON miniworld.OrderItem TO 'kiosk_user'@'%';
GRANT SELECT, INSERT ON miniworld.OrderItemComponent TO 'kiosk_user'@'%';
GRANT INSERT ON miniworld.OrderItemModifier TO 'kiosk_user'@'%';
GRANT INSERT ON miniworld.InventoryTransaction TO 'kiosk_user'@'%';
GRANT INSERT ON miniworld.OrderStatusHistory TO 'kiosk_user'@'%';
GRANT INSERT ON miniworld.Payment TO 'kiosk_user'@'%';
SQL
