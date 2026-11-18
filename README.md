# AstraZeneca | AZ Content Scanner (LATAM)

**AZ Content Scanner** audita los sitios AZMED de AstraZeneca LATAM (`azmed.cr`, `.com.mx`, `.com.br`, `.com.ar`, `.cl`, `.uy`): detecta los **Veeva Approval IDs** en texto, imágenes (OCR), PDF y videos Kaltura, consulta cada ID en **PromoMats** y clasifica el material como *vigente*, *por vencer*, *vencido* o *retirado*. Guarda capturas de evidencia y un historial de los últimos 10 escaneos.

Es una herramienta **local**: un servidor Node/Express en tu equipo, una interfaz web en `http://localhost:3000` y Chromium (Playwright) para rastrear.

---

## 1. Instalación y uso

Requisitos: **Node.js 18 o superior**.

```bash
npm install            # instala dependencias y descarga Chromium de Playwright
cp .env.example .env   # y ajusta los valores (ver sección 3)
npm start              # http://localhost:3000
```

- `npm run dev` reinicia el servidor al cambiar archivos.
- `npm test` ejecuta las pruebas; `npm run lint` valida sintaxis y coherencia HTML ↔ JS ↔ CSS; `npm run check` hace ambas; `npm run check:responsive` abre la interfaz en 14 tamaños de pantalla y falla si hay desbordes o botones táctiles pequeños.
- Si `npm install` no puede descargar Chromium (proxy corporativo): `npx playwright install chromium` o configura `NODE_EXTRA_CA_CERTS`.
- OCR sin conexión: coloca `eng.traineddata.gz` en `ocr-data/`:
  ```bash
  mkdir -p ocr-data
  curl -L -o ocr-data/eng.traineddata.gz https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz
  ```

### Flujo de trabajo en la interfaz

La aplicación tiene cuatro vistas (barra lateral):

| Vista | Para qué sirve |
| :--- | :--- |
| **Panel** | KPIs (vencidos, por vencer, vigentes, retirados, por revisar), índice de cumplimiento, distribución, calendario de vencimientos y tabla de materiales con filtros, orden, detalle y revisión manual. Exporta CSV o imprime un informe. |
| **Nuevo escaneo** | Elegir el sitio, **detectar las áreas del menú** (HOME, ONCOLOGÍA, CVRM…) y marcar cuáles analizar, o elegir el sitio completo. El progreso se ve en cualquier vista. |
| **Historial** | Los últimos 10 escaneos; al abrir uno se muestra en el Panel. |
| **Cuentas** | Conectar y comprobar las sesiones de AzMed y PromoMats. |

1. En **Cuentas**, pulsa *Iniciar sesión* en cada servicio: se abre una ventana de Chromium, inicia sesión (incluido MFA) y pulsa *Terminé*.
2. En **Nuevo escaneo**, elige el sitio y pulsa *Iniciar escaneo* (un sitio completo tarda 20–40 min).
3. Revisa los resultados en el **Panel**. En *Detalle* puedes marcar si la detección es correcta (alimenta la precisión/recall) o reportar un ID no detectado.

**Las 2 sesiones (AzMed y PromoMats) son obligatorias**: el servidor no inicia el escaneo si falta alguna o está expirada. Kaltura no necesita sesión (sus metadatos se leen de forma anónima). Sin PromoMats no hay fechas con las que comparar los Approval IDs (antes se escaneaba igual y todo salía «Sin fecha»). Si PromoMats no responde al empezar, el escaneo se detiene en el acto.

### Escaneo por áreas

Los sitios AZMED están detrás de un WAF que bloquea el tráfico automatizado cuando detecta muchas peticiones seguidas, y un rastreo completo supera fácilmente los cientos de páginas. Por eso el flujo por defecto es:

1. **Detectar áreas**: lee el menú (header) de la página principal (1 página + el sitemap) y lista las áreas con una estimación de páginas por área. Los desplegables aparecen como subáreas.
2. **Marcar áreas**: solo se rastrean las ramas elegidas (por ruta: `/es/oncologia` incluye `/es/oncologia/mama`, pero no `/es/oncologia-x`). HOME es solo esa página. Se recomienda **1–2 áreas por escaneo**.
3. En modo áreas no se consulta crt.sh ni los sitemaps de subdominios (menos peticiones).
4. **Sitio completo** sigue disponible, con confirmación.

Las páginas de un área publicadas fuera de su ruta no se rastrean: añádelas en *Opciones avanzadas → URLs adicionales*.

**Cola de áreas.** Con 2 o más áreas marcadas, «Escanear en cola» (activo por defecto) las analiza una por una con una pausa entre ellas (`QUEUE_PAUSE_SECONDS`, 45 s por defecto). Si una área sufre bloqueos del WAF o falla, la pausa se duplica y esa área se reintenta una vez al final. El resultado es un único informe consolidado (IDs deduplicados) con el detalle por área en *Cobertura*.

---

## 2. Cómo funciona

```
Sesiones ─> Descubrimiento ─> Rastreo y extracción ─> Fechas en PromoMats
(Identity,    (páginas, sitemaps,   (texto, imágenes+OCR,     (en paralelo, con caché;
 PromoMats)    crt.sh vía Chromium)  PDF, videos Kaltura,      vigente / por vencer /
                                     capturas de evidencia)    vencido / retirado)
```

- **Detección de IDs** (`server/config.js`): prefijos `MX|CC|CO|EC|PE|BR|AR|CL|UY|XC` + 4–6 dígitos. Acepta IDs dentro de nombres de archivo (`banner_CC-14803.jpg`) y descarta años (`CO-2024`).
- **Un ID, todas sus páginas**: el OCR de cada imagen y la lectura de cada PDF se hacen una vez y el resultado se registra en cada página donde aparece el recurso.
- **Capturas**: se centran en el texto o en el propio recurso, tras aceptar cookies / aviso de profesional de la salud (los botones pulsados quedan listados en la cobertura del escaneo) y ocultar capas bloqueantes.
- **Escaneos interrumpidos**: si falla a mitad, se guarda lo detectado como `PARCIAL`.
- **Cobertura**: cada escaneo informa páginas leídas/fallidas, enlaces rotos, páginas que exigen sesión, imágenes con OCR vs. por nombre, PDF, videos, sitemaps obsoletos y bloqueos del WAF.
- **Fechas de PromoMats**: orden día/mes configurable con `VAULT_DATE_FORMAT` (se deduce solo cuando un componente es > 12); meses en español, inglés y portugués.

---

## 3. Configuración (`.env`)

Ver `.env.example`. Las más relevantes:

| Variable | Para qué |
| :--- | :--- |
| `ALLOWED_DOMAINS` | Dominios que se pueden escanear. |
| `VAULT_HOST` | Host de PromoMats (requerido para obtener fechas). |
| `WARNING_DAYS` | Días para considerar "por vencer" (30). |
| `MAX_PAGES`, `MAX_DEPTH`, `CRAWL_CONCURRENCY`, `VAULT_CONCURRENCY` | Alcance y paralelismo. Si el WAF bloquea páginas, baja `CRAWL_CONCURRENCY`. |
| `OCR_ENABLED`, `OCR_WORKERS`, `MAX_OCR_IMAGES_PER_PAGE` | OCR de imágenes. |
| `VAULT_DATE_FORMAT` | `dmy` (por defecto) o `mdy` para fechas ambiguas. |
| `DATA_DIR` | Dónde se guardan sesiones, historial y capturas. |
| `ENABLE_DIAGNOSTICS` | Activa `/api/vault/inspect/:id` y `/api/capture-test` (desactivados por defecto). |
| `ALLOW_INSECURE_TLS` | Los navegadores ignoran errores de certificado (proxies con inspección TLS). |

### Dónde se guardan los datos

Sesiones (`.sessions/`), historial y capturas (`data/`) contienen **cookies de sesión corporativas**. Si el proyecto está dentro de OneDrive se guardan en `%LOCALAPPDATA%\AZ-Content-Scanner` para que no se sincronicen a la nube; en otro caso, en la carpeta del proyecto. `DATA_DIR` fuerza otra ruta y el servidor la muestra al arrancar. Las sesiones **no están cifradas**: protege el equipo y no compartas esa carpeta.

---

## 4. Seguridad

La API usa las sesiones guardadas, así que el servidor:

- escucha solo en `127.0.0.1` (variable `HOST`);
- valida `Host` (anti DNS-rebinding) y `Origin`, y no tiene CORS: otros sitios abiertos en tu navegador no pueden usarla;
- exige un token por proceso (`X-AZ-Token`, que la interfaz obtiene de `/api/token`) en toda petición que modifica estado;
- envía cabeceras de seguridad (CSP, `X-Frame-Options`, `nosniff`…) y limita el ritmo de peticiones;
- valida `scanId` y `assetKey` (evita contaminación de prototipo) y recorta los textos de revisión;
- neutraliza fórmulas (`= + - @`) en el CSV exportado.

Ante una excepción no controlada, cancela el escaneo en curso (guardando lo detectado) y se cierra.

---

## 5. Interfaz y marca

La interfaz sigue las guías **AstraZeneca OnBrand** (Colour y Typefaces): Mulberry y blanco dominan; Magenta, Gold, Navy y Purple como apoyo; Light Blue y Lime solo como acento. Los estados nunca dependen solo del color (llevan icono y texto) y los contrastes cumplen WCAG AA.

- Tokens de marca: `public/css/tokens.css` · componentes: `public/css/styles.css`.
- Estilo: **glassmorfismo** (tarjetas de cristal esmerilado sobre un fondo con luces Mulberry / Magenta / Navy / Gold). Respeta `prefers-reduced-transparency` y degrada a superficies opacas si el navegador no soporta `backdrop-filter`.
- Tipografía: Nunito (titulares) y Nunito Sans (texto), autoalojadas en `public/fonts/`. Se aparta de la tipografía digital de la guía (Batota Slab / Inter) por comodidad de lectura.
- Responsive: escala por `rem` (la interfaz crece en 1080p/2K/4K), barra lateral completa / compacta / superior según el ancho, tablas como tarjetas en móvil y objetivos táctiles de 44 px. `npm run check:responsive` la verifica en 14 tamaños de pantalla.
- **Logo oficial**: descárgalo del portal OnBrand y guárdalo como `public/img/astrazeneca-logo.svg`. Sin ese archivo se muestra el nombre en texto.
- Los valores aproximados de Platinum / Light Platinum en `tokens.css` deben confirmarse en la página *Colour* de OnBrand.

---

## 6. Estructura

```
az-content-scanner/
├── package.json / .env.example
├── server/
│   ├── index.js          Express: API REST, SSE, historial, revisiones
│   ├── security.js       Host/Origin, token anti-CSRF, cabeceras, límite de peticiones
│   ├── config.js         .env, regiones, regex de IDs, rutas de datos
│   ├── authManager.js    Sesiones guardadas y su validación
│   ├── loginDetect.js    Detección unificada de pantallas de login
│   ├── scannerEngine.js  Descubrimiento, rastreo paralelo, extracción, capturas
│   ├── vaultClient.js    Consulta de fechas en PromoMats (navegador)
│   ├── vaultParse.js     Fechas, vigencia y estado del documento (lógica pura)
│   ├── kalturaClient.js  Metadatos de videos Kaltura
│   ├── ocrService.js     OCR (pool de workers) y lectura de PDF
│   ├── storage.js        Historial, revisiones y capturas
│   └── fsutil.js         Escritura atómica con reintentos (OneDrive/antivirus)
├── public/               index.html, css/ (tokens, styles), js/ (app, csv), fonts/, img/
├── test/                 Pruebas (node:test): regex, fechas, login, CSV, seguridad y API
├── scripts/lint.js       Sintaxis + coherencia HTML ↔ JS ↔ CSS
└── ocr-data/             eng.traineddata.gz
```

## 7. Notas de operación

- **Países**: CR, MX, BR, AR, CL, UY. Ecuador, Perú y Colombia están retirados: `azmed.ec` y `azmed.pe` no existen y `azmed.co` **no es de AstraZeneca**. Añadirlos en `server/config.js` y `ALLOWED_DOMAINS` cuando se conozcan las URLs reales.
- **Proxy corporativo (zScaler)**: Kaltura (lectura anónima de metadatos, con `KALTURA_TIMEOUT_SECONDS`/`KALTURA_RETRIES`) y crt.sh se consultan a través de Chromium/Playwright, que usa la red del navegador. Alternativa global: `NODE_EXTRA_CA_CERTS=/ruta/certificado-raiz.pem`.
- **WAF (CloudFront)**: bloquea el user-agent `HeadlessChrome`; el escáner usa el de un Chrome normal. Si aparecen páginas "Bloqueadas por WAF", baja `CRAWL_CONCURRENCY`.
- **Sesiones que duran**: se guardan cookies, `localStorage` y `sessionStorage`; se renuevan tras cada uso y cada `SESSION_KEEPALIVE_MINUTES` (20 por defecto) se "toca" cada servicio para evitar el cierre por inactividad. La sonda de AzMed es la página «Mi cuenta» del sitio.
- **PromoMats fiable**: los IDs que fallan por causas transitorias se reintentan en una segunda pasada y los resultados con fecha se recuerdan `VAULT_CACHE_HOURS` horas. El informe agrupa los motivos de los IDs sin fecha y queda PARCIAL si falta alguno. Un video de Kaltura que no se pudo leer aparece como «No verificado», no como «Sin ID».
- **Cobertura por áreas**: el informe lista las páginas enlazadas fuera de las áreas elegidas (con botón *Copiar*) para añadirlas en «URLs adicionales».
- **Descubrimiento**: primero los enlaces de las páginas (menús, cuerpo, pie, `data-href`, `onclick`, iframes del mismo sitio, Shadow DOM) y después `robots.txt` / sitemaps. Las URLs de sitemap que dan 404 se reportan aparte.
- **Contenido oculto**: se leen también acordeones, pestañas y modales cerrados.
- **Sesión de AzMed**: se valida contra una página protegida (`AZMED_PROBE_URL` o la aprendida en `data/meta.json`), no contra la home pública.
- **Capturas** en `data/shots/<scanId>/`; se borran (junto con sus revisiones) cuando el escaneo sale del historial (máx. 10).
