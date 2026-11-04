#!/bin/sh
: "${PCBV_APP_DIR:=/usr/share/pcbv/app}"
export PCBV_APP_DIR
exec /opt/pcbv/python/bin/python3 -I -m pcbv "$@"
