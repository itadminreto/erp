#!/usr/bin/env bash
# Copia de seguridad de la base de datos y de la configuración (incluye APP_SECRET). Conserva 14 días.
# Uso: sudo bash deploy/backup.sh
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-/var/backups/erp}"
DB_NAME="$(grep -E '^DB_NAME=' /etc/erp/erp.env | cut -d= -f2 || true)"; DB_NAME="${DB_NAME:-erp}"
STAMP="$(date +%F_%H%M)"
umask 077
install -d -m 0700 "$BACKUP_DIR"
mariadb-dump --single-transaction --routines --triggers "$DB_NAME" | gzip > "$BACKUP_DIR/${DB_NAME}_$STAMP.sql.gz"
cp /etc/erp/erp.env "$BACKUP_DIR/erp.env_$STAMP"
find "$BACKUP_DIR" -type f -mtime +14 -delete
echo "$(date '+%F %T') copia creada: $BACKUP_DIR/${DB_NAME}_$STAMP.sql.gz"
