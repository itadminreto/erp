#!/usr/bin/env bash
# Actualiza la aplicación a la última versión de la rama actual del repositorio.
# Uso: sudo bash deploy/actualizar.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Ejecuta como root: sudo bash deploy/actualizar.sh" >&2; exit 1; }
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

PORT="$(grep -E '^PORT=' /etc/erp/erp.env | cut -d= -f2 || true)"; PORT="${PORT:-3000}"

echo "==> Copia de seguridad previa"
bash "$APP_DIR/deploy/backup.sh"

echo "==> Descargando cambios"
BEFORE="$(git rev-parse HEAD)"
git pull --ff-only
AFTER="$(git rev-parse HEAD)"
if [[ "$BEFORE" == "$AFTER" ]]; then echo "Ya estaba en la última versión ($AFTER)."; fi

echo "==> Dependencias"
npm ci --omit=dev --no-audit --no-fund
chmod -R o+rX "$APP_DIR"

echo "==> Reiniciando el servicio"
systemctl restart erp
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  echo "✔ Actualizado a $(git log -1 --format='%h %s')"
else
  journalctl -u erp -n 40 --no-pager
  echo "✘ La aplicación no responde. Para volver a la versión anterior: git reset --hard $BEFORE && sudo bash deploy/actualizar.sh" >&2
  exit 1
fi
