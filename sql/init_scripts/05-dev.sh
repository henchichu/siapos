#!/bin/sh
set -e

# Demo data and known dev PINs load only when SIAPOS_DEV=1 (docker-compose.dev.yaml sets it and mounts /sql-dev)
if [ "${SIAPOS_DEV:-}" = 1 ]; then
  for f in /sql-dev/*.sql; do
    MYSQL_PWD="$(cat /run/secrets/db_root_password)" mysql -uroot < "$f"
  done
fi
