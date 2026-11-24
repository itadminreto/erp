# Instalación en servidor Ubuntu 24.04

Guía para el servidor interno (`192.168.0.201`) y, después, para el de producción. Los dos funcionan igual:
el código se descarga con **git** y se actualiza con **git pull**.

Lo que se instala: Node.js 22, MariaDB, la aplicación como servicio (`erp`, arranca sola al reiniciar),
un virtual host en Nginx (o en Apache si ya está funcionando en el servidor) y una copia de seguridad diaria.

---

## 1. Dar acceso al servidor al repositorio (una sola vez por servidor)

El repositorio es privado, así que el servidor necesita una **clave de despliegue** de solo lectura.

En el servidor, como root:

```bash
sudo -i
```

```bash
ssh-keygen -t ed25519 -N "" -C "erp-$(hostname)" -f /root/.ssh/erp_deploy
```

```bash
cat /root/.ssh/erp_deploy.pub
```

Copia la línea que aparece y añádela en GitHub: repositorio **itadminreto/erp → Settings → Deploy keys → Add deploy key**
(ponle de nombre el del servidor y **no** marques *Allow write access*).

Después indica a git que use esa clave con GitHub:

```bash
cat >> /root/.ssh/config <<'EOF'
Host github.com
  IdentityFile /root/.ssh/erp_deploy
  IdentitiesOnly yes
EOF
```

## 2. Descargar la aplicación

Siempre en `/opt/erp` (el servicio no tiene acceso a `/root` ni `/home`):

```bash
git clone -b claude/beautiful-archimedes-9cw7x1 git@github.com:itadminreto/erp.git /opt/erp
```

> Si más adelante fusionáis los cambios en la rama `main`, usa `-b main`.

## 3. Instalar

Cambia el email por el del administrador:

```bash
SERVER_NAME=192.168.0.201 ADMIN_EMAIL=admin@tuempresa.com bash /opt/erp/deploy/instalar.sh
```

Al terminar muestra la **dirección**, el **usuario** y una **contraseña temporal** (apúntala: solo se muestra una vez;
al entrar te obligará a cambiarla).

Abre `http://192.168.0.201` desde cualquier equipo de la red.

### Primeros pasos en la aplicación

1. **Empresas** → crea tu empresa (no se crea ninguna de ejemplo).
2. **Centros** → crea los centros de trabajo / coste.
3. **Usuarios** → crea los usuarios y asígnales empresa › centro › rol.
4. **Ajustes** → configura el correo saliente (SMTP) si vas a enviar contraseñas por email.

---

## Actualizar a una versión nueva

```bash
sudo bash /opt/erp/deploy/actualizar.sh
```

Hace una copia de seguridad, `git pull`, instala dependencias, reinicia el servicio y comprueba que responde.
Si algo falla te indica el comando para volver a la versión anterior.

## Pasar a producción

En el servidor de producción repite los pasos 1, 2 y 3 con su IP o dominio:

```bash
SERVER_NAME="erp.tuempresa.com" ADMIN_EMAIL=admin@tuempresa.com bash /opt/erp/deploy/instalar.sh
```

Si el servidor de producción es accesible desde Internet, activa HTTPS (gratis con Let's Encrypt; el dominio debe apuntar al servidor):

```bash
apt-get install -y certbot python3-certbot-nginx && certbot --nginx -d erp.tuempresa.com
```

Después, en `/etc/erp/erp.env`, pon `COOKIE_SECURE=1` y `PUBLIC_URL=https://erp.tuempresa.com`, y reinicia con `systemctl restart erp`.

### ¿Llevar los datos del servidor interno a producción?

Cada servidor tiene su propia base de datos y su propia clave `APP_SECRET` (en `/etc/erp/erp.env`).
Si quieres trasladar los datos, copia **las dos cosas**: sin la misma `APP_SECRET` las contraseñas guardadas no se pueden descifrar.

```bash
mariadb-dump --single-transaction erp | gzip > erp.sql.gz     # en el servidor interno
```

En producción, antes del primer arranque o con el servicio parado (`systemctl stop erp`):

```bash
zcat erp.sql.gz | mariadb erp
```

Copia el valor de `APP_SECRET` del servidor interno al `/etc/erp/erp.env` de producción y ejecuta `systemctl restart erp`.

---

## Dónde está cada cosa

| Qué | Dónde |
|---|---|
| Código (git) | `/opt/erp` |
| Configuración y claves | `/etc/erp/erp.env` (solo root) — **haz copia** |
| Copias de seguridad diarias del sistema (03:15, 14 días) | `/var/backups/erp` |
| Copias hechas desde la aplicación (*Ajustes → Copias de seguridad*) | `/var/lib/erp/backups` |
| Copia manual | `sudo bash /opt/erp/deploy/backup.sh` |
| Ver registros del servicio | `journalctl -u erp -f` |
| Reiniciar / estado | `systemctl restart erp` · `systemctl status erp` |
| Virtual host | `/etc/nginx/sites-available/erp` (o `/etc/apache2/sites-available/erp.conf`) |

## Problemas frecuentes

- **No abre la página desde otro equipo:** comprueba que el cortafuegos permite el puerto 80 (`ufw status`) y que el
  servicio está activo (`systemctl status erp`).
- **`Permission denied (publickey)` al clonar:** la clave de despliegue no está añadida en GitHub o falta el paso de `/root/.ssh/config`.
- **Error 502 en el navegador:** el servicio no está arrancado; mira `journalctl -u erp -n 50`.
