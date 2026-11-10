#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
DB=zz_siapos_test
root() { docker exec -i posdb sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mysql -uroot'; }

fails=0
for f in "${@:-[0-9]*.sh}"; do
  for g in $f; do
    echo "=== $g"
    # 03-privileges is left out: it would REVOKE app_user's grants on the real database
    {
      echo "DROP DATABASE IF EXISTS $DB; CREATE DATABASE $DB;"
      cat ../init_scripts/01-*.sql ../init_scripts/02-*.sql ../init_scripts/04-*.sql | sed "s/miniworld/$DB/g"
    } | root || {
      echo "build failed"
      exit 1
    }
    # One business per database is a unique index. The other rules are checked with two businesses, to keep the cross-business keys
    # honest, so the index is dropped here, except for the script that tests it.
    [ "$g" = 40-one-business.sh ] || echo "ALTER TABLE $DB.Business DROP INDEX UQ_Business_OnlyOne;" | root
    out=$(cat lib.sh "$g" | sed "s/@DB@/$DB/g" | docker exec -i posdb sh)
    echo "$out"
    fails=$((fails + $(grep -c '^FAIL' <<<"$out")))
  done
done

echo "DROP DATABASE IF EXISTS $DB; REVOKE ALL PRIVILEGES ON $DB.* FROM 'app_user'@'%';" | root
echo "--- $fails failing"
[ "$fails" -eq 0 ]
