#!/usr/bin/env bash
# Instalador para Ubuntu 24.04: Node.js 22, MariaDB, servicio systemd, virtual host (Nginx o Apache) y copias diarias.
#
# Uso (como root, desde la carpeta clonada del repositorio):
#   sudo SERVER_NAME=192.168.0.201 ADMIN_EMAIL=admin@empresa.com bash deploy/instalar.sh
#
# Se puede volver a ejecutar sin problema: no regenera claves ni borra datos.
set -euo pipefail

# ---------- parámetros ----------
SERVER_NAME="${SERVER_NAME:-192.168.0.201}"   # IP o dominio del virtual host (varios separados por espacio)
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@erp.local}"
APP_PORT="${APP_PORT:-3000}"
DB_NAME="${DB_NAME:-erp}"
DB_USER="${DB_USER:-erp}"
SERVICE=erp
SVC_USER=erp
ENV_DIR=/etc/erp
ENV_FILE=$ENV_DIR/erp.env
DATA_DIR=/var/lib/erp
BACKUP_DIR=/var/backups/erp
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[aviso] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[error] %s\033[0m\n' "$*" >&2; exit 1; }
rand() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-32}" || true; }

[[ $EUID -eq 0 ]] || die "Ejecuta el script como root: sudo bash deploy/instalar.sh"
if [[ ! -f "$APP_DIR/server/index.js" ]]; then
  # Ejecutado fuera del proyecto (p. ej. una copia suelta del script): se usa /opt/erp si existe.
  if [[ -f /opt/erp/server/index.js ]]; then
    APP_DIR=/opt/erp
  else
    die "No encuentro la aplicación. Descomprime o clona el proyecto en /opt/erp y ejecuta: bash /opt/erp/deploy/instalar.sh"
  fi
fi
case "$APP_DIR" in
  /root/*|/home/*) die "Clona el repositorio en /opt/erp (el servicio no tiene acceso a /root ni /home). Ver deploy/LEEME.md" ;;
esac
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || warn "Probado en Ubuntu 24.04; detectado: ${PRETTY_NAME:-desconocido}"

export DEBIAN_FRONTEND=noninteractive

# ---------- paquetes del sistema ----------
log "Instalando paquetes base y MariaDB"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git mariadb-server mariadb-client
systemctl enable --now mariadb

# ---------- Node.js 22 ----------
NODE_MAJOR=0
command -v node >/dev/null && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  log "Instalando Node.js 22 (repositorio oficial NodeSource)"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
log "Node.js $(node -v)"

# ---------- usuario del servicio ----------
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$DATA_DIR"

# ---------- configuración y claves (solo la primera vez) ----------
install -d -m 0750 -o root -g "$SVC_USER" "$ENV_DIR"
FIRST_INSTALL=0
ADMIN_PASSWORD=""
if [[ ! -f "$ENV_FILE" ]]; then
  FIRST_INSTALL=1
  log "Generando claves en $ENV_FILE"
  DB_PASSWORD="$(rand 32)"
  ADMIN_PASSWORD="$(rand 16)"
  FIRST_NAME="${SERVER_NAME%% *}"
  cat > "$ENV_FILE" <<EOF
# Configuración de la aplicación. NO subir a git. Haz copia de seguridad de este fichero.
NODE_ENV=production
HOST=127.0.0.1
PORT=$APP_PORT
TRUST_PROXY=1
PUBLIC_URL=http://$FIRST_NAME
COOKIE_SECURE=0
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_CREATE=0
DATA_DIR=$DATA_DIR
# Clave que cifra las contraseñas guardadas. Si se pierde, no se pueden descifrar.
# Si llevas la base de datos a otro servidor, copia también esta clave.
APP_SECRET=$(rand 48)
ADMIN_EMAIL=$ADMIN_EMAIL
SEED_DEMO=0
EOF
  chown root:"$SVC_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
fi
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

# ---------- base de datos ----------
log "Preparando la base de datos $DB_NAME"
mariadb <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

# ---------- dependencias de la aplicación ----------
log "Instalando dependencias de la aplicación"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
chmod -R o+rX "$APP_DIR"   # el usuario del servicio solo necesita leer el código

# ---------- servicio systemd ----------
log "Creando el servicio $SERVICE"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=ERP - Gestión de Aplicaciones
After=network.target mariadb.service
Requires=mariadb.service

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=3
# Endurecimiento
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
EOF

# La contraseña inicial del super admin solo se pasa en el primer arranque y luego se elimina.
if (( FIRST_INSTALL )); then
  install -d /etc/systemd/system/$SERVICE.service.d
  printf '[Service]\nEnvironment=ADMIN_PASSWORD=%s\nEnvironment=ADMIN_MUST_CHANGE=1\n' "$ADMIN_PASSWORD" > /etc/systemd/system/$SERVICE.service.d/primer-arranque.conf
  chmod 0600 /etc/systemd/system/$SERVICE.service.d/primer-arranque.conf
fi
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

log "Esperando a que la aplicación arranque"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null || { journalctl -u "$SERVICE" -n 40 --no-pager; die "La aplicación no responde"; }
if (( FIRST_INSTALL )); then
  rm -f /etc/systemd/system/$SERVICE.service.d/primer-arranque.conf
  systemctl daemon-reload
fi

# ---------- virtual host ----------
if systemctl is-active --quiet apache2; then
  log "Apache detectado: creando virtual host"
  a2enmod -q proxy proxy_http headers >/dev/null
  cat > /etc/apache2/sites-available/$SERVICE.conf <<EOF
<VirtualHost *:80>
    ServerName ${SERVER_NAME%% *}
$(for n in ${SERVER_NAME#* }; do [[ "$n" != "${SERVER_NAME%% *}" ]] && echo "    ServerAlias $n"; done)
    ProxyPreserveHost On
    ProxyTimeout 300
    RequestHeader set X-Forwarded-Proto "http"
    ProxyPass        / http://127.0.0.1:$APP_PORT/
    ProxyPassReverse / http://127.0.0.1:$APP_PORT/
    LimitRequestBody 26214400
    ErrorLog \${APACHE_LOG_DIR}/$SERVICE-error.log
    CustomLog \${APACHE_LOG_DIR}/$SERVICE-access.log combined
</VirtualHost>
EOF
  a2ensite -q "$SERVICE" >/dev/null
  apache2ctl configtest
  systemctl reload apache2
else
  log "Instalando Nginx y creando virtual host"
  apt-get install -y -q nginx
  LISTEN6=""
  [[ -s /proc/net/if_inet6 ]] && LISTEN6="listen [::]:80;"   # solo si el servidor tiene IPv6
  cat > /etc/nginx/sites-available/$SERVICE <<EOF
server {
    listen 80;
    $LISTEN6
    server_name $SERVER_NAME;

    client_max_body_size 25m;          # importación de ficheros Excel/CSV
    access_log /var/log/nginx/$SERVICE-access.log;
    error_log  /var/log/nginx/$SERVICE-error.log;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/$SERVICE /etc/nginx/sites-enabled/$SERVICE
  nginx -t
  systemctl enable --now nginx >/dev/null
  systemctl reload nginx
fi

# ---------- cortafuegos (solo si ya está activo) ----------
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && log "Cortafuegos: puerto 80 abierto"
fi

# ---------- copias de seguridad diarias ----------
log "Programando copia de seguridad diaria (03:15) en $BACKUP_DIR"
install -d -m 0700 "$BACKUP_DIR"
cat > /etc/cron.d/$SERVICE-backup <<EOF
# Copia diaria de la base de datos y la configuración del ERP (se guardan 14 días)
15 3 * * * root bash $APP_DIR/deploy/backup.sh >> /var/log/$SERVICE-backup.log 2>&1
EOF
chmod 0644 /etc/cron.d/$SERVICE-backup

# ---------- resumen ----------
URL="http://${SERVER_NAME%% *}"
printf '\n\033[1;32m✔ Instalación completada\033[0m\n'
echo "  Dirección:      $URL"
if (( FIRST_INSTALL )); then
  echo "  Usuario:        $ADMIN_EMAIL"
  echo "  Contraseña:     $ADMIN_PASSWORD   (temporal: te pedirá cambiarla al entrar; no se volverá a mostrar)"
fi
echo "  Configuración:  $ENV_FILE  (contiene APP_SECRET: haz copia de seguridad)"
echo "  Registros:      journalctl -u $SERVICE -f"
echo "  Actualizar:     sudo bash $APP_DIR/deploy/actualizar.sh"
