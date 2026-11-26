# Gestión de Aplicaciones (ERP multi-empresa)

Plataforma web para gestionar **Credenciales, Correo, Fibras, Líneas, Vehículos y Recados** (y cualquier otra
aplicación que se cree desde el panel de super admin, sin programar).

## Puesta en marcha

La aplicación usa **MariaDB** (10.6 o superior) como base de datos y **Node.js ≥ 18**.

### Servidor Ubuntu (recomendado)

Instalador automático con MariaDB, servicio, virtual host Nginx/Apache y copias diarias: ver **[deploy/LEEME.md](deploy/LEEME.md)**.

### Opción A: Docker (MariaDB + aplicación)

```bash
docker compose up -d
```

Abre http://localhost:3000. Cambia antes las claves `DB_PASSWORD`, `DB_ROOT_PASSWORD` y `APP_SECRET` (en un fichero `.env` junto a `docker-compose.yml`).

### Opción B: MariaDB ya instalado

1. Crea la base de datos y un usuario (como root en MariaDB):

```sql
CREATE DATABASE erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'erp'@'%' IDENTIFIED BY 'cambia_esta_clave';
GRANT ALL PRIVILEGES ON erp.* TO 'erp'@'%';
```

2. Copia `.env.example` a `.env`, rellena `DB_HOST`, `DB_USER`, `DB_PASSWORD`… y exporta las variables (o defínelas en el servicio).
3. Instala y arranca:

```bash
npm install
```

```bash
npm start
```

Las tablas se crean solas en el primer arranque. También se crean el super admin `admin@erp.local` / `admin1234`
(se obliga a cambiarla en el primer acceso), una empresa de ejemplo con dos centros, las 6 aplicaciones con sus campos
y tres roles (Admin centro, Editor, Consulta).

### Pruebas

Necesitan un MariaDB accesible; usan (y **borran**) la base de datos `erp_test`, así que el usuario debe tener permiso sobre ella:

```bash
npm test
```

### Variables de entorno

| Variable | Uso |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Conexión a MariaDB (por defecto `127.0.0.1:3306`, base `erp`, usuario `erp`) |
| `DB_CREATE=0` | No intentar `CREATE DATABASE` al arrancar |
| `DB_POOL` | Número máximo de conexiones (10) |
| `PORT` | Puerto HTTP (3000) |
| `APP_SECRET` | Clave para cifrar contraseñas. Si no se indica se genera `data/secret.key` — **haz copia de seguridad**: sin ella no se pueden descifrar las contraseñas guardadas en la BD |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Credenciales del super admin inicial |
| `SEED_DEMO=0` | No crear la empresa de ejemplo |
| `PUBLIC_URL` | URL pública para los enlaces que se envían (también en Ajustes) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | Correo saliente (también en Ajustes) |
| `COOKIE_SECURE=1`, `TRUST_PROXY=1` | Al publicar detrás de HTTPS / proxy inverso |

### Copias de seguridad

```bash
mariadb-dump --single-transaction erp > erp_$(date +%F).sql
```

Guarda también `APP_SECRET` o `data/secret.key`.

## Cómo cubre cada requisito

| Requisito | Implementación |
|---|---|
| **Base de datos** | MariaDB (InnoDB, utf8mb4, transacciones). Los datos de cada registro se guardan en una columna JSON validada, por eso se pueden añadir campos sin tocar la estructura de tablas; las búsquedas, filtros y ordenaciones usan `JSON_VALUE`. |
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
| **Empresas y centros dinámicos** | En *Apps y campos → Datos maestros* se añaden campos propios a empresas y centros (p. ej. cuenta corriente, banco, responsable), con los mismos tipos que las aplicaciones. Incluye el tipo *Cuenta bancaria (IBAN)* con validación de dígitos de control. |
| **Diseñador de formularios** | En *Apps y campos → 🎨 Diseñar formulario*: lienzo con vista previa (ordenador/móvil) para arrastrar campos, cambiar su ancho tirando del borde, agrupar en secciones y mostrarlas como pestañas. La ficha impresa respeta las secciones. |
| **Nº de trabajo** | Cada aplicación numera sus registros por empresa empezando en 1000 (configurable en *Propiedades*); el número no se reutiliza, se busca desde el buscador y sale en listados, exportación y parte impreso. |
| **Firma en pantalla** | Tipo de campo *Firma*: se firma con el dedo, lápiz o ratón; guarda la imagen y la fecha y aparece en el parte impreso. |
| **Imágenes y fotos** | Tipo de campo *Imagen / foto* (una o varias): hacer foto con la cámara del móvil/tableta o subir imágenes (p. ej. firmas escaneadas). Se reducen en el navegador (máx. 1600 px) antes de subirlas, se guardan en la tabla `record_files` y salen en el parte impreso. |
| **Botones de acción** | En el diseñador, «＋ Añadir botón»: rellenar campos (y guardar), abrir enlaces con datos del registro (mapa, llamar, WhatsApp, web), enviar por correo, imprimir parte o duplicar. Con condición de visibilidad, confirmación, color e icono. |
| **Logo de empresa** | Se sube en *Empresas*; aparece en el menú y en la cabecera de todo lo que se imprime. |
| **Imprimir y calendario** | Botón *Imprimir* en cada aplicación (listado filtrado o selección), en cada ficha (los recados incluyen líneas de firma) y en el calendario. Las aplicaciones con campos de fecha tienen vista *Calendario* mensual, coloreada por un campo de lista (p. ej. prioridad); doble clic en un día para crear. |
| **Copias de seguridad** | En *Ajustes*: crear y descargar copia, copia automática diaria (con días de conservación), restaurar una copia del servidor o desde un archivo. Antes de restaurar se guarda automáticamente el estado actual. |
| **Responsive e intuitivo** | Menú lateral plegable, tablas que pasan a tarjetas en móvil, formularios a pantalla completa en móvil, tema claro/oscuro. |
| **Datos generales (super admin)** | Empresas, centros, usuarios, roles, aplicaciones/campos y ajustes (nombre, URL pública, SMTP). |

## Grupos de trabajo por sede

**Super admin → Grupos de trabajo**: cada grupo pertenece a una sede (centro) y tiene código, nombre, notas y estado,
con papelera, auditoría y copia de seguridad como el resto. Sus campos adicionales se crean sin programar en
**Apps y campos → Datos maestros → Grupos de trabajo** (igual que en Empresas y Centros).

## Accesibilidad (usuarios invidentes o con baja visión)

Solo para los usuarios marcados en **Usuarios → ♿ Usuario invidente (modo accesible)**; el resto ve la aplicación igual que siempre.
La pantalla de acceso es accesible para todos (aún no se sabe quién entra).

- Compatible con lectores de pantalla: NVDA, JAWS, Narrador, VoiceOver (Mac/iPhone) y TalkBack (Android).
- Todo se maneja con teclado: «Saltar al contenido» con el primer Tab, foco visible, Esc cierra ventanas y menús,
  flechas en los menús desplegables, el foco queda atrapado en la ventana abierta y vuelve a su sitio al cerrarla.
- Campos con su etiqueta, obligatorios y ayudas anunciados; botones de solo icono con nombre; avisos y errores leídos en voz alta;
  número de resultados anunciado al buscar o filtrar; tablas con título, columnas ordenables con Intro y botón «Abrir» por fila.
- Firma sin dibujar: «Firmar escribiendo el nombre». Columnas reordenables con ▲ ▼ además de arrastrar.
- Menú de usuario → **♿ Accesibilidad**: tamaño de texto (hasta 150 %), alto contraste, subrayar enlaces y quitar animaciones
  (se guarda en cada navegador). El código está en `public/js/a11y.js` y se aplica solo a las pantallas nuevas.

### Asistente por voz («Recoger · Recados»)

Para los usuarios marcados como invidentes aparece en el menú **📞 Recoger · Recados**: una pregunta cada vez,
leída en voz alta por el navegador: todos los campos en el orden del formulario, menos firmas, imágenes y contraseñas.
Se contesta escribiendo o dictando (dictado de Windows: tecla Windows + H; botón 🎤 solo con HTTPS) y se pulsa Intro.
Entiende fechas como «hoy», «mañana», «el lunes», «dentro de 3 días» o «15 de diciembre»; repite teléfono y email
cifra a cifra; Esc vuelve atrás, F2 repite la pregunta; al final lee un resumen (un número corrige ese dato) e Intro guarda.
Qué campos pregunta cada app se configura en **Apps y campos → Propiedades → Asistente por voz**.
Si el usuario ya usa NVDA/JAWS, puede desmarcar «Leer en voz alta» para que no hablen los dos a la vez.

## Estructura

```
server/
  index.js        arranque, login, sesiones, enlaces compartidos
  db.js           conexión a MariaDB (pool, transacciones) y esquema
  auth.js         sesiones y motor de permisos (rol × app × centro)
  fields.js       tipos de campo, validación y conversión
  routes/records.js  registros, papelera, historial, contraseñas, import/export
  routes/admin.js    panel de super admin y auditoría
  seed.js         datos iniciales (apps, campos, roles)
public/           frontend (HTML + JS sin compilación)
test/api.test.js  pruebas de integración (contra MariaDB)
docker-compose.yml  MariaDB + aplicación
```
