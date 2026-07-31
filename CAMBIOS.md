# WeasyTalkie — notas de la revisión

## Instaladores (1.1)

Los dos apuntan a **https://weasytalkie.onrender.com**, que es donde está
publicada la web.

| Archivo | Qué es |
|---|---|
| `installer/dist/WeasyTalkie_1.1.0_Setup.exe` (92 MB) | Aplicación de escritorio para Windows |
| `installer/dist/WeasyTalkie_1.1.0.apk` (5 MB) | Aplicación para Android |

**Escritorio (Windows).** Una ventana de Electron que abre la web; el audio va
por WebRTC igual que en el navegador. Concede el permiso de micrófono sin
preguntar en cada arranque y se instala **por usuario, sin pedir administrador**.
Para apuntar a otro servidor (por ejemplo el de la red local) basta con dejar un
archivo `server.txt` junto al programa con la dirección dentro, sin recompilar.

Se genera con:

```
npx electron-builder --win --dir            (o el montaje manual, ver abajo)
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\WeasyTalkie.iss
```

> `electron-builder` falla al crear el instalador en este equipo: al extraer sus
> herramientas de firma intenta crear enlaces simbólicos de macOS y Windows lo
> impide sin permisos de administrador. Por eso el `.exe` final se arma con Inno
> Setup, que ya se usaba para la otra aplicación.

**Android.** APK de depuración (firmado con la clave de depuración, se instala
activando "orígenes desconocidos"). Se le añadieron los permisos que faltaban:
`RECORD_AUDIO` y `MODIFY_AUDIO_SETTINGS` — **sin ellos la aplicación no podía
usar el micrófono**, que es justo lo que hace un walkie-talkie.

Se genera con:

```
npx cap sync android
cd android && gradlew assembleDebug
```

> Requiere `JAVA_HOME` apuntando al JDK de Android Studio y `ANDROID_HOME` al SDK.
> Como la carpeta del usuario lleva una "Ñ", hizo falta `android.overridePathCheck=true`
> en `android/gradle.properties`: Gradle se niega a compilar en rutas no ASCII.
>
> Para publicarlo en Google Play haría falta un APK/AAB **firmado con tu propia
> clave**; el de depuración sirve para instalarlo a mano en los móviles.

## Entrada en servicio de las conexiones (1.1)

Una conexión directa tarda entre uno y varios segundos en establecerse. Durante
ese rato **el mensaje se envía igual**: al soltar el botón viaja el clip completo
por el servidor (o por el canal de datos), así que nadie se queda sin recibirlo.
En cuanto la conexión está lista, se pasa a voz en directo sin más.

Lo que se ha corregido es **el momento del cambio**. Antes, si la conexión
terminaba de negociarse justo mientras estabas hablando, el otro extremo
empezaba a oírte por la mitad de la frase y además recibía el mensaje entero al
soltar. Ahora:

- Una conexión que se completa mientras hablas **no entra en servicio hasta que
  sueltas el botón** (se le corta el envío con `replaceTrack(null)`, que actúa
  sobre esa conexión concreta y no sobre el micrófono, que es común a todas).
- Si seleccionas un contacto nuevo mientras hablas, **su conexión se aplaza** y
  se lanza al terminar.
- En la lista, ese contacto aparece como **"LISTO AL SOLTAR"** para que se vea
  qué está pasando.

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
