#!/bin/bash
# ==========================================================
# MySQL Database Backup Script for MSAP 53rd Freshers' Meet 2026
# ==========================================================
set -e

BACKUP_DIR="./database/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/msap_freshers_backup_${TIMESTAMP}.sql.gz"

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-msap_freshers_2026}"
DB_USER="${DB_USER:-msap_user}"
DB_PASSWORD="${DB_PASSWORD:-}"

mkdir -p "$BACKUP_DIR"

echo "Creating backup for ${DB_NAME} on ${DB_HOST}:${DB_PORT}..."

if [ -z "$DB_PASSWORD" ]; then
  mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
    --single-transaction --quick --routines --triggers "$DB_NAME" | gzip > "$BACKUP_FILE"
else
  MYSQL_PWD="$DB_PASSWORD" mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
    --single-transaction --quick --routines --triggers "$DB_NAME" | gzip > "$BACKUP_FILE"
fi

echo "Backup successful: $BACKUP_FILE"
echo "To restore: gunzip < $BACKUP_FILE | mysql -h $DB_HOST -P $DB_PORT -u $DB_USER -p $DB_NAME"
