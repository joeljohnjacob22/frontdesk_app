#!/bin/sh
if ! su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pg/data status" >/dev/null 2>&1; then
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pg/data -o '-p 5433 -k /tmp/pg' -l /tmp/pg/log start" >/dev/null 2>&1
  sleep 3
fi
