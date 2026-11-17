# AstraZeneca | AZ-Content-Scanner (LATAM)

**AZ-Content-Scanner** es la solución web corporativa diseñada para auditar, detectar y verificar el estado de cumplimiento (*Compliance*) de los códigos **Veeva Approval IDs** en los activos digitales (páginas web, subdominios, imágenes, documentos y videos) desplegados en los portales de AstraZeneca para la región de Latinoamérica (CAMCAR, México, Andean, Brasil y Cono Sur).

---

## 🔍 1. Problematización Encontrada

En las operaciones regionales de AstraZeneca LatAm, la gestión y auditoría de contenidos digitales enfrentaba los siguientes desafíos críticos:

* **Escalabilidad y Redes Masivas de Subdominios:** Portales principales como `azmed.cr` y sus redes de subdominios albergan cientos de subsecciones, páginas internas y portales de campaña cuyos activos y materiales médicos deben cumplir con la regulación estricta de Veeva Vault.
* **Obstrucción Visual en Evidencias (Banners de Cookies):** Los crawlers tradicionales capturaban pantallas en las que los pop-ups de consentimiento de cookies, capas traslucidas (`modal-backdrop`) y banners flotantes (como OneTrust) bloqueaban la visibilidad del contenido médico/comercial, invalidando la prueba visual para auditorías de cumplimiento.
* **Riesgo Regulatorio por Material Vencido:** La falta de una herramienta que cruzara automáticamente los textos, banners, imágenes y videos con las fechas de expiración reales en Veeva Vault exponía a la organización a mantener activos obsoletos o caducados en la web pública.
* **Bloqueos de Red e Infraestructura Corporativa:** Las restricciones de certificados SSL corporativos (proxies, zScaler, VPN) y las redirecciones de pasarelas de autenticación (SSO Identity) interrumpían la ejecución de scripts tradicionales de automatización web.

---

## 💡 2. Solución Propuesta

Para resolver de raíz estas problemáticas, se construyó **AZ-Content-Scanner**, una arquitectura moderna y automatizada basada en Node.js y Playwright que opera bajo los siguientes pilares técnicos:

1. **Descubrimiento Híbrido OSINT y Activo:** Integración pasiva con registros públicos de Transparencia de Certificados (`crt.sh`) para mapear subdominios asociados, combinada con un crawler activo que explora dinámicamente el `Header`, `Main` y `Footer` de cada página.
2. **Limpieza Agresiva Anti-Cookies por CSS y DOM:** Método automatizado de doble acción que hace clic en los botones de aceptación (*"Permitir todas las cookies"*) e inyecta reglas CSS restrictivas (`display: none !important`) para ocultar y eliminar físicamente cualquier contenedor flotante antes de tomar la captura de pantalla real.
3. **Autenticación Unificada Silenciosa (Headless SSO):** Gestor de contexto que autentica de forma transparente y en segundo plano (`headless: true`) en **AstraZeneca Identity (SSO)**, **Veeva Vault Promomats** y **Kaltura Management Console (KMC)**.
4. **Control Interactivo en Tiempo Real:** Interfaz enriquecida con Server-Sent Events (SSE) para el reporte de progreso paso a paso con checkmarks animados, historial persistente corporativo y un botón de cancelación inmediata (`/api/cancel-scan`).

---

## 📈 3. Resultados Obtenidos

* **Cobertura Masiva y Profunda:** Capacidad de barrer decenas de subdominios y subpáginas interconectadas por ejecución, detectando de manera precisa múltiples activos corporativos por ciclo.
* **Evidencias Fotograficas Limpias:** Obtención de capturas de pantalla reales en alta resolución enfocadas exclusivamente en la evidencia comercial y médica del activo auditado, 100% libres de avisos de cookies o capas residuales.
* **Trazabilidad y Colaboración:** Registro global corporativo persistente accesible desde el dashboard mediante modales de visualización ("Ver escaneo") que permiten a cualquier miembro del equipo revisar auditorías pasadas.
* **Optimización de Tiempos:** Reducción drástica del tiempo de auditoría manual de Veeva Approval IDs, pasando de revisiones humanas exhaustivas de días a escaneos automatizados en cuestión de minutos.

---

## 📋 4. Alcance y Parámetros de Escaneo

El motor de exploración combina inteligencia OSINT pasiva con rastreo activo en profundidad para garantizar la cobertura total del ecosistema digital corporativo.

### ⚙️ Parámetros Configurables de Entrada
- **Mercado LatAm Target:**
  - **CAMCAR:** Prefijos `CC-#####` (Sitio base: `https://www.azmed.cr`).
  - **México:** Prefijos `MX-#####` (Sitio base: `https://www.azmed.mx`).
  - **Andean (Colombia, Ecuador, Perú):** Prefijos `CO-#####`, `EC-#####`, `PE-#####` (Sitio base: `https://www.azmed.co`).
  - **Brasil:** Prefijos `BR-#####` (Sitio base: `https://www.azmed.com.br`).
  - **Cono Sur (Argentina, Chile, Uruguay):** Prefijos `AR-#####`, `CL-#####`, `UY-#####`, `XC-#####` (Sitio base: `https://www.azmed.com.ar`).
- **Dominio / URL Objetivo:** Dirección URL raíz o subdominio específico a evaluar.

### 🔍 Alcance del Crawler Masivo y Cobertura de Activos
1. **Descubrimiento de Subdominios (OSINT & DNS):**
   * Consulta automática a los registros de Transparencia de Certificados SSL/TLS (`crt.sh`) para mapear subdominios públicos e internos asociados al dominio corporativo.
2. **Navegación Recursiva Estructurada:**
   * Barrido en árbol que inspecciona elementos de navegación de primer y segundo nivel (`header`, `nav`, `main`, `footer`, botones de acción `[role="button"]` y llamadas a la API/Microservicios).
3. **Formatos y Extensiones Auditadas:**
   * **Texto / DOM:** Párrafos `<p>`, encabezados `<h1>-<h6>`, etiquetas `<span>`, pies de página `<footer>` y avisos legales.
   * **Imágenes y Banners Visuales:** Detección de imágenes incrustadas o dinámicas en extensiones `.jpg`, `.jpeg`, `.png`, `.svg`, `.webp` y `.gif`.
   * **Contenido Multimedia y Streams:** Detección e inspección de reproductores de video embebidos de **Kaltura Management Console (KMC)** e `iframes` interactivos.

---

## 📊 5. Componentes y Especificaciones del Dashboard

El panel principal de la aplicación está estructurado bajo las guías de diseño de **Material Design** e integra la paleta de colores institucional **Magenta de AstraZeneca (`#830051`)**.

+-----------------------------------------------------------------------------------+
|  AstraZeneca | AZ-Content-Scanner                          [ Listo para escanear ]|
+-----------------------------------------------------------------------------------+
|  [ Sidebar Filtros ]    |  [ Monitor de Estado ]                                  |
|  - Mercado LatAm        |  - Mensaje de fase actual                               |
|  - Dominio Objetivo     |  - Barra de progreso interactiva (SSE)                  |
|  - Botón Iniciar        +---------------------------------------------------------+
|                         |  [ Métricas KPIs ]                                      |
|                         |  - Total Analizados | Vigentes | Próx. Vencer | Vencidos  |
|                         +---------------------------------------------------------+
|                         |  [ Tabla de Activos Detectados ]                        |
|                         |  - Tipo | Veeva ID | URL | Expiración | Estado | Acciones |
|                         +---------------------------------------------------------+
|                         |  [ Historial General Corporativo ]                      |
|                         |  - Fecha | Dominio | Mercado | Activos | Ver Escaneo    |
+-----------------------------------------------------------------------------------+


### 📋 Componentes de la Interfaz
1. **Filtros de Entrada:** Permite seleccionar el mercado objetivo (`CAMCAR`, `México`, `Andean`, `Brasil`, `Cono Sur`) y autocompleta el portal base.
2. **Monitor de Progreso SSE:** Muestra la barra de avance porcentual y los detalles del progreso en tiempo real durante las fases del rastreo.
3. **Métricas Globales (KPIs de Compliance):**
   * **Total Analizados:** Cantidad global de Veeva Approval IDs detectados en el sitio y subdominios.
   * 🟢 **Vigentes:** Activos con aprobación activa y margen de expiración mayor a 60 días.
   * 🟡 **Próximos a Vencer:** Activos con fecha de caducidad menor o igual a 60 días.
   * 🔴 **Vencidos:** Activos cuya aprobación ha caducado (requieren retiro o renovación inmediata).
4. **Tabla de Resultados del Último Escaneo:** Listado detallado que especifica el **Tipo** (Texto/DOM, Imagen/Asset, Video Kaltura), **Veeva Approval ID**, **Ubicación exacta / URL**, **Fecha de Expiración**, **Estado** y el botón de acción **"Ver análisis"**.
5. **Modal de "Ver Análisis" (Evidencias Limpias):** Despliega la ficha técnica del activo junto a la **captura de pantalla real libre de cookies**.
6. **Historial General Corporativo:** Tabla ubicada al final del dashboard que almacena los escaneos ejecutados en el servidor y permite revisarlos mediante un pop-up modal ("Ver escaneo").

---

## 🖼️ 6. Modal de "Ver Análisis" (Evidencias Limpias)

Al hacer clic en **"Ver análisis"** en cualquier registro auditado, el sistema despliega un pop-up modal que muestra:
- **Metadatos del Activo:** Veeva Approval ID detectado, Tipo de Activo (Texto/DOM, Imagen/Banner, Video Kaltura), Fecha de Expiración en Vault y URL/Ubicación exacta.
- **Captura de Pantalla Real y Limpia (Anti-Cookies):** 
  - Automatización de clic en el banner de consentimiento de cookies (*"Permitir todas las cookies"* / *"Aceptar"*).
  - **Inyección CSS Dinámica:** Inyección de reglas CSS con `display: none !important` y eliminación física del DOM de cualquier pop-up, modal flotante o capa oscura residual (`.modal-backdrop`, `onetrust-banner-sdk`) antes del renderizado.
  - Captura de pantalla real en alta resolución mostrando únicamente el contenido médico/comercial auditado, sin obstrucciones de banners.

---

## ⚙️ 7. Metodología de Análisis

El proceso de análisis de cumplimiento se ejecuta automáticamente a través de cuatro fases consecutivas:

[ Fase 1: Autenticación ] ──> [ Fase 2: Descubrimiento ] ──> [ Fase 3: Extracción ] ──> [ Fase 4: Vault ]
Identity + Veeva + Kaltura      OSINT (crt.sh) + Header/Main      DOM + Imágenes + Videos       Verificación Fechas


1. **Fase 1: Autenticación SSO Silenciosa:** Apertura del contexto del navegador y login silencioso en AstraZeneca Identity, Veeva Vault y Kaltura KMC.
2. **Fase 2: Descubrimiento y Mapeo:** Consulta pasiva a `crt.sh` para obtener la lista de subdominios, seguida de un crawler activo que extrae enlaces internos navegando por el `Header`, `Main` y `Footer`.
3. **Fase 3: Extracción y Limpieza Visual:** Evaluación de la expresión regular de Veeva IDs (`MX-#####`, `CC-#####`, `CO-#####`, etc.) en textos, reproductores de Kaltura e imágenes (`.jpg`, `.jpeg`, `.png`, `.svg`, `.webp`, `.gif`). Ejecución del script de eliminación de cookies y captura de pantalla.
4. **Fase 4: Validación de Fechas en Vault:** Comparación de los identificadores contra el registro de fechas en Veeva Vault Promomats y clasificación en *Vigente*, *Próximo a vencer* o *Vencido*.

---

## 🛡️ 8. Arquitectura de Seguridad e Infraestructura

**AZ-Content-Scanner** está diseñado para operar en entornos corporativos de alta seguridad e integrarse sin fricción en la red de AstraZeneca.

### 🔑 Autenticación Unificada Silenciosa (Headless SSO)
- **Gestión de Sesiones Complejas:** Mantiene un contexto de navegador aislado (`BrowserContext`) que autentica de manera transparente en tres plataformas corporativas en segundo plano:
  1. **AstraZeneca Identity (SSO):** Pasarela de autenticación corporativa.
  2. **Veeva Vault Promomats:** Repositorio regulatorio de materiales aprobados.
  3. **Kaltura Management Console (KMC):** Servidor de streaming y recursos multimedia.
- **Protección de Credenciales:** Las credenciales de usuario se procesan únicamente en la memoria en tiempo de ejecución del servidor local. La opción de almacenamiento persistente utiliza `localStorage` del navegador cliente encriptado por origen.

### 🌐 Certificados SSL/TLS e Inspección de Red Corporativa
- **Bypass de Inspección de Proxy/VPN:** Opcional con `ALLOW_INSECURE_TLS=true` en `.env` (activa `NODE_TLS_REJECT_UNAUTHORIZED=0` y `--ignore-certificate-errors` en Chromium) para permitir el tráfico a través de proxies corporativos, zScaler y firewalls de la red interna de AstraZeneca sin bloqueos por certificados autofirmados.
- **Manejo de Errores y Cancelación de Escaneo:**
  - Control dinámico de excepciones HTTP que valida códigos de respuesta (`200 OK`) e ignora URLs o protocolos malformados (`mailto:`, `tel:`, `javascript:`).
  - Endpoint de cancelación inmediata (`/api/cancel-scan`) que detiene los procesos de Playwright en ejecución si el usuario cancela la operación desde el frontend.

---

## 🛠️ 9. Herramientas y Programas Utilizados

| Herramienta / Programa | Tipo | Función en la Aplicación Web |
| :--- | :--- | :--- |
| **Node.js (v18+)** | Backend Runtime | Entorno de ejecución para el servidor web, APIs REST y orquestación del motor. |
| **Express.js** | Framework Web | Gestión de rutas HTTP, endpoints de API REST, control de historial y SSE. |
| **Playwright** | Automatización Web | Control del navegador Chromium Headless, renderizado del DOM y captura de imágenes. |
| **crt.sh API** | OSINT / Registro TLS | Servicio pasivo de descubrimiento de subdominios asociados al dominio principal. |
| **Server-Sent Events (SSE)** | Protocolo de Red | Transmisión en tiempo real del progreso del escaneo desde el servidor al frontend. |
| **HTML5 / CSS3 / JavaScript** | Frontend Nivel 1 | Construcción de la interfaz de usuario bajo el diseño **Material Design** y paleta **Magenta AZ**. |

---

## ⚙️ 10. Instalación y Ejecución Local

1. Instalar dependencias (incluye el navegador Chromium de Playwright):
   ```bash
   npm install
   ```
2. Copiar `.env.example` a `.env` y ajustar los valores.
3. Datos de OCR (sin conexión): colocar `eng.traineddata.gz` en `ocr-data/`:
   ```bash
   mkdir -p ocr-data
   curl -L -o ocr-data/eng.traineddata.gz https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz
   ```
4. Iniciar la aplicación:
   ```bash
   npm start
   ```
5. Abrir http://localhost:3000, pulsar **Iniciar sesión** y guardar las sesiones de AzMed, PromoMats y Kaltura.

### Notas de operación
- **Países configurados:** CR (`azmed.cr`), MX (`azmed.com.mx`), BR (`azmed.com.br`), AR (`azmed.com.ar`), CL (`azmed.cl`), UY (`azmed.uy`). Ecuador, Perú y Colombia están retirados: `azmed.ec` y `azmed.pe` no existen y **`azmed.co` no es de AstraZeneca** (es otra empresa). Añadirlos en `server/config.js` y `ALLOWED_DOMAINS` cuando se conozcan las URLs reales.
- **Sesiones:** al pulsar "Abrir" se abre un navegador; la sesión se guarda con "Guardar sesión" o automáticamente al cerrar esa ventana. PromoMats caducado bloquea el escaneo; AzMed caducado solo avisa (las páginas protegidas quedan listadas). La sesión de Kaltura es opcional: los metadatos de video se leen con la API pública.
- **Proxy corporativo (zScaler):** el `fetch` de Node no confía en el certificado del proxy; por eso crt.sh se consulta a través de Chromium. Alternativa global: `NODE_EXTRA_CA_CERTS=/ruta/certificado-raiz-zscaler.pem`.
- **Acceso:** el servidor escucha solo en `127.0.0.1` (variable `HOST`), porque la API usa las sesiones corporativas guardadas.
- **WAF del sitio (CloudFront):** bloquea el user-agent `HeadlessChrome`. El escáner usa el user-agent de un Chrome normal para páginas, sitemaps, PDF e imágenes. Si aparecen páginas "Bloqueadas por WAF", bajar `CRAWL_CONCURRENCY`.
- **Descubrimiento:** se rastrean primero los enlaces encontrados en las páginas (menús, cuerpo, pie, `data-href`, `onclick`, iframes del mismo sitio y Shadow DOM) y después las URLs de `robots.txt` / `sitemap.xml`. Las URLs del sitemap que dan 404 se reportan aparte ("Sitemap obsoletas").
- **Contenido oculto:** se leen también acordeones, pestañas y modales cerrados; la captura intenta desplegarlos.
- **Sesión de AzMed:** se valida contra una página protegida (`AZMED_PROBE_URL` o la aprendida en `data/meta.json`), no contra la home pública.
- **Capturas:** se guardan en `data/shots/<scanId>/` y se borran al salir un escaneo del historial (máx. 10).
- **Diagnóstico:** `/api/capture-test?url=...` (captura sin avisos) y `/api/vault/inspect/<ID>` (lectura de PromoMats).

## 📂 11. Estructura del Directorio del Proyecto

```
az-content-scanner/
├── package.json
├── .env / .env.example       # Configuración
├── server/
│   ├── index.js              # Express: API REST, SSE, historial, revisiones
│   ├── config.js             # Lectura de .env y parámetros
│   ├── authManager.js        # Sesiones guardadas (AzMed, PromoMats, Kaltura) y su validación
│   ├── scannerEngine.js      # Descubrimiento, rastreo paralelo, extracción, capturas
│   ├── vaultClient.js        # Consulta de fechas en Veeva PromoMats
│   ├── kalturaClient.js      # Metadatos de videos Kaltura
│   ├── ocrService.js         # OCR de imágenes (tesseract.js) y lectura de PDF
│   └── storage.js            # Historial, revisiones y capturas en data/
├── public/                   # Interfaz (index.html, css/, js/app.js)
├── data/                     # history.json, reviews.json, meta.json, shots/
└── ocr-data/                 # eng.traineddata.gz
```
