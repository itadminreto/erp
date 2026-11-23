# Gestión de Aplicaciones (ERP multi-empresa)

Plataforma web para gestionar **Credenciales, Correo, Fibras, Líneas, Vehículos y Recados** (y cualquier otra
aplicación que se cree desde el panel de super admin, sin programar).

## Puesta en marcha

Requisitos: **Node.js ≥ 22.13** (usa el SQLite integrado de Node, no hace falta servidor de base de datos).

```bash
npm install
```

```bash
npm start
```

Abre http://localhost:3000. En el primer arranque se crea el super admin `admin@erp.local` / `admin1234`
(se obliga a cambiarla en el primer acceso), una empresa de ejemplo con dos centros, las 6 aplicaciones con sus campos
y tres roles (Admin centro, Editor, Consulta).

Pruebas de integración de la API:

```bash
npm test
```

### Variables de entorno (opcionales)

| Variable | Uso |
|---|---|
| `PORT` | Puerto HTTP (3000) |
| `DATA_DIR` | Carpeta de la base de datos y la clave de cifrado (`./data`) |
| `APP_SECRET` | Clave para cifrar contraseñas. Si no se indica se genera `data/secret.key` — **haz copia de seguridad de ese fichero**: sin él no se pueden descifrar las contraseñas |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Credenciales del super admin inicial |
| `SEED_DEMO=0` | No crear la empresa de ejemplo |
| `PUBLIC_URL` | URL pública para los enlaces que se envían (también configurable en Ajustes) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | Correo saliente (también configurable en Ajustes) |
| `COOKIE_SECURE=1`, `TRUST_PROXY=1` | Al publicar detrás de HTTPS / proxy inverso |

## Cómo cubre cada requisito

| Requisito | Implementación |
|---|---|
| **Base de datos** | SQLite (`data/erp.sqlite`). Los datos de cada registro se guardan como JSON, por eso se pueden añadir campos sin migraciones. |
| **Usuarios comunes** | Una única tabla de usuarios para todas las apps y empresas. |
| **Permisos por aplicación dentro de roles** | *Roles y políticas*: matriz rol × aplicación con ver, crear, editar, borrar, ver papelera, restaurar, borrado definitivo, importar, exportar, ver contraseñas, enviar contraseñas, ver historial y «solo sus registros». |
| **Centros de trabajo / coste** | Cada registro pertenece a un centro. Un usuario recibe *asignaciones* empresa › centro (o todos) › rol, así un admin de centro solo ve su centro. |
| **Multi-empresa** | Selector de empresa en el menú; datos, centros y permisos separados por empresa. |
| **Dinámico sin programar** | *Apps y campos*: crear aplicaciones nuevas, añadir/editar/desactivar campos (15 tipos: texto, número, fecha, lista, multiselección, sí/no, email, teléfono, URL, usuario, contraseña cifrada, color…), obligatorios, únicos, ancho, ayuda, orden por defecto. |
| **Campos movibles por el usuario** | En el formulario, «✥ Mover campos» permite arrastrarlos; en el listado se arrastran las columnas o se eligen en «Columnas». El diseño se guarda por usuario y aplicación. |
| **Importar / exportar CSV y Excel** | Asistente con plantilla, mapeo automático de columnas, simulación, actualización de existentes por campo clave y errores por fila. Exportación a .xlsx/.csv de la vista filtrada o de la selección (contraseñas solo si se piden y se tiene permiso). |
| **Contraseñas** | Cifradas con AES-256-GCM. Las ven el super admin y los roles con «Ver contraseñas» (Admin centro). Se pueden copiar, generar y **enviar** por correo, WhatsApp, SMS o con un enlace/código de un solo uso con caducidad. |
| **Trazabilidad** | Cada alta, cambio (campo a campo, antes → después), borrado, restauración, consulta/envío de contraseña, importación, exportación y acceso queda en la auditoría. Pestaña *Historial* en cada registro y vista global filtrable y exportable. |
| **Papelera** | Borrar = enviar a la papelera. La casilla «🗑️ Ver papelera» muestra los borrados **en rojo**, con restaurar y (si se tiene permiso) eliminar definitivamente. También para empresas, centros, usuarios y roles. |
| **Responsive e intuitivo** | Menú lateral plegable, tablas que pasan a tarjetas en móvil, formularios a pantalla completa en móvil, tema claro/oscuro. |
| **Datos generales (super admin)** | Empresas, centros, usuarios, roles, aplicaciones/campos y ajustes (nombre, URL pública, SMTP). |

## Estructura

```
server/
  index.js        arranque, login, sesiones, enlaces compartidos
  db.js           esquema SQLite
  auth.js         sesiones y motor de permisos (rol × app × centro)
  fields.js       tipos de campo, validación y conversión
  routes/records.js  registros, papelera, historial, contraseñas, import/export
  routes/admin.js    panel de super admin y auditoría
  seed.js         datos iniciales (apps, campos, roles)
public/           frontend (HTML + JS sin compilación)
test/api.test.js  pruebas de integración
```
