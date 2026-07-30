# WeasyTalkie — notas de la revisión

## Qué era "lo que se implementó" para arreglar el audio

El código conserva el rastro de tres intentos:

1. **MediaRecorder → trozos WebM por el servidor → MSE en quien escucha.** Los
   fragmentos de MediaRecorder no son archivos independientes; al reproducirlos
   se oía entrecortado.
2. **PCM en crudo por Socket.IO**, con `ScriptProcessor`, remuestreo a 16 kHz y un
   búfer adaptativo de jitter. Mejor, pero seguía dependiendo del servidor.
3. **WebRTC entre navegadores** — lo que hay ahora. El audio va directo por SRTP
   con Opus, que ya se encarga del jitter y de las pérdidas. El acierto está en
   que la conexión se abre **al seleccionar el contacto**, no al pulsar el botón:
   hablar se limita a activar el micrófono (`track.enabled`), y por eso es
   instantáneo. El servidor quedó solo para la señalización y para guardar el
   clip del historial.

## Lo que se ha corregido

### Impedían usar la aplicación

| Problema | Qué pasaba |
|---|---|
| Socket.IO se cargaba desde un CDN de internet | Sin conexión exterior la web no arrancaba, aunque el servidor estuviera en la red local. Ahora la librería va incluida en `public/vendor/`. |
| `capacitor.config.json` apuntaba a `https://TU-DOMINIO.onrender.com` | El APK no se conectaba a ningún sitio. Ahora la dirección del servidor **se escribe desde la propia app** y queda guardada. |
| El botón de hablar se bloqueaba si WebRTC no conectaba | En redes con firewall o entre datos móviles el walkie se quedaba mudo. Ahora siempre se puede hablar: lo que no va en directo se envía al soltar el botón. |
| Solo había servidores STUN | Se puede añadir un TURN desde `.env` (`TURN_URL`), que el cliente lee de `/ice-config`. |
| El micrófono no se soltaba al perder la conexión | El indicador de grabación del móvil o del navegador se quedaba encendido. |
| El manifiesto pedía iconos que no existían | La PWA no se podía instalar. Se han generado `icon-192.png` y `icon-512.png` y se ha corregido el nombre del archivo (`manifiest.json` → `manifest.json`). |
| El mismo usuario en dos sitios | La señalización iba siempre al primer socket encontrado y la sesión nueva se quedaba muda. Ahora la sesión anterior se cierra avisando. |

### Restos de los intentos anteriores

- Se han borrado **455 líneas** de código que ya no se usaba (`startPcmLiveCapture`,
  `playPcmChunk`, `appendLiveChunkMSE`, `clearLiveMSE`, los conversores PCM/WAV…).
  Ninguna de esas funciones se llamaba desde el flujo real, y entre todas
  referenciaban **23 variables que no existían en ninguna parte**: el día que
  alguien hubiera llamado a una de ellas, habría reventado.
- El selector **"Perfil de audio" no hacía nada** desde el cambio a WebRTC. Ahora
  ajusta de verdad el códec: bitrate, DTX, FEC y tamaño de paquete de Opus.
  - *Red mala*: 16 kbps, paquetes de 40 ms, con DTX y corrección de errores.
  - *Balanceado*: 24 kbps.
  - *Baja latencia*: 32 kbps, paquetes de 10 ms.

### Seguridad

- El comentario del servidor prometía protección HTTP Basic **que no existía**:
  cualquiera con acceso a la red podía abrir la aplicación. Ahora se activa de
  verdad con `WEB_AUTH=true`.
- El **registro estaba abierto** a cualquiera y sin límite. Ahora se controla con
  `ALLOW_REGISTRATION` y, si se quiere, con un `REGISTRATION_CODE` de invitación.
- **Límites de uso** por conexión: intentos de clave, registros y ritmo de audio.
- Los mensajes de audio se descartan si pasan de 2 MB (antes se aceptaban 8 MB).
- Los orígenes permitidos se pueden fijar con `ALLOWED_ORIGINS` en vez de `*`.
- Aviso al arrancar si `AUTH_PASS` se quedó con el valor de ejemplo.

> El cifrado extremo a extremo (ECDH P-256 + AES-GCM) estaba bien planteado y no
> se ha tocado. Su límite conocido: como las claves públicas se intercambian por
> el propio servidor y no se verifican, un servidor malicioso podría colocarse en
> medio. Es lo normal sin una verificación fuera de banda.

### Interfaz y rendimiento

- El audio del historial **ya no se guarda dentro del HTML** (`data-audio` con el
  base64 completo): con 20 mensajes eran varios MB metidos en el DOM y duplicados
  en memoria. Ahora se guardan aparte y el botón solo referencia un identificador.
- La lista de usuarios **ya no se reconstruye entera** en cada actualización, así
  que deja de perderse el indicador de quién está hablando.
- Al marcharse alguien del canal se **cierra su conexión** (antes quedaban una
  `RTCPeerConnection` y un `<audio>` vivos por cada persona que se iba).
- Los nombres de usuario se pintan como texto, no como HTML.
- Los `alert()` se han sustituido por avisos que no bloquean la pantalla.
- El botón de hablar ya no arrastra la página ni selecciona texto en el móvil
  (`touch-action`, `user-select`).
- El botón indica si la voz va en directo o si el mensaje se enviará al soltar.

## Pruebas

De 28 a **55 pruebas automáticas** (`npm test`):

- `tests/server-core.test.js` — lógica pura del servidor (ya existía).
- `tests/server-flow-state.test.js` — estado de canales (ya existía).
- `tests/client-app.test.js` — **nuevo**: carga la interfaz en un DOM simulado y
  comprueba el historial, la lista de usuarios, los avisos, los perfiles de audio
  y el estado del botón de hablar.
- `tests/server-e2e.test.js` — **nuevo**: arranca el servidor de verdad y conecta
  clientes reales para probar acceso, canales, señalización, límites y el cierre
  de la sesión duplicada.

## Configuración

Todos los ajustes nuevos están documentados en `.env.example`. Los importantes:

```
WEB_AUTH=false            # true = pide usuario y clave para abrir la web
ALLOW_REGISTRATION=true   # false = solo el administrador crea cuentas
REGISTRATION_CODE=        # si se rellena, hace falta para registrarse
ALLOWED_ORIGINS=*         # limita desde qué webs se puede conectar
TURN_URL=                 # servidor TURN para redes difíciles
```

## Pendiente / ideas

- **Los canales que se crean son locales**: aparecen solo en el navegador de quien
  los crea. Falta que el servidor mantenga y reparta la lista.
- El transporte está fijado a `websocket`; en redes con proxies que lo bloqueen
  habría que permitir `polling` como respaldo.
- Las fuentes siguen viniendo de Google Fonts. Si no hay internet se usan las de
  respaldo y la aplicación se ve bien igualmente, pero se podrían incluir.
- Un TURN propio (coturn) haría la conexión directa fiable en cualquier red.
