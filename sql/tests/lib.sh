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
a() {
  got=$(v "$2")
  [ "$got" = "$3" ] && r=PASS || r=FAIL
  printf "%s  %-46s = %s\n" "$r" "$1" "$got"
}

R "GRANT SELECT, INSERT, UPDATE, DELETE ON @DB@.* TO 'app_user'@'%';"
