#!/usr/bin/env bash
# Carga el maestro de vehículos del antiguo programa (exportación .xls de Delphi / SQL Server).
# Por defecto SOLO SIMULA. Uso:
#   sudo bash /opt/erp/deploy/importar-vehiculos.sh /ruta/vehiculos.xls [--empresa "Nombre"] [--crear-centros] [--ejecutar]
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f /etc/erp/erp.env ]; then set -a; . /etc/erp/erp.env; set +a; fi
cd "$APP_DIR"
exec node scripts/importar-vehiculos-delphi.js "$@"
