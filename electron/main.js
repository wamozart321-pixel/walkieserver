// Aplicación de escritorio: una ventana que abre la web del servidor.
// El audio va por WebRTC igual que en el navegador.
const { app, BrowserWindow, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Servidor por defecto. Se puede cambiar sin recompilar creando un archivo
// server.txt junto al ejecutable, o con la variable WEASYTALKIE_URL.
const URL_POR_DEFECTO = 'https://weasytalkie.onrender.com';

function leerServidor() {
  if (process.env.WEASYTALKIE_URL) return process.env.WEASYTALKIE_URL.trim();

  try {
    const archivo = path.join(path.dirname(app.getPath('exe')), 'server.txt');
    if (fs.existsSync(archivo)) {
      const url = fs.readFileSync(archivo, 'utf8').trim();
      if (url) return url;
    }
  } catch (_) {
    // Si no se puede leer, se usa el servidor por defecto.
  }

  return URL_POR_DEFECTO;
}

let ventana = null;

function crearVentana() {
  const url = leerServidor();

  ventana = new BrowserWindow({
    width: 900,
    height: 940,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#12100a',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'public', 'icon-512.png'),
    webPreferences: {
      // La página es remota: se aísla del sistema por completo.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // El micrófono se concede sin preguntar: es una aplicación de walkie-talkie
  // y el permiso se pediría en cada arranque.
  session.defaultSession.setPermissionRequestHandler((webContents, permiso, permitir) => {
    permitir(permiso === 'media' || permiso === 'audioCapture');
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permiso) =>
    permiso === 'media' || permiso === 'audioCapture');

  ventana.loadURL(url);

  // Los enlaces externos se abren en el navegador, no dentro de la aplicación.
  ventana.webContents.setWindowOpenHandler(({ url: destino }) => {
    shell.openExternal(destino);
    return { action: 'deny' };
  });

  ventana.webContents.on('did-fail-load', (e, codigo, descripcion) => {
    const mensaje = `No se pudo conectar con ${url}\n\n${descripcion} (${codigo})`;
    ventana.webContents.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(`
        <body style="background:#12100a;color:#f6ead7;font-family:Segoe UI,sans-serif;
                     display:grid;place-items:center;height:100vh;margin:0;text-align:center">
          <div>
            <h2 style="color:#ffcf75">Sin conexión con el servidor</h2>
            <p style="white-space:pre-line">${mensaje}</p>
            <p style="color:#8b785c;font-size:14px">
              Crea un archivo <b>server.txt</b> junto al programa con otra dirección
              si el servidor está en otro sitio.
            </p>
            <button onclick="location.reload()"
                    style="padding:10px 22px;border:0;border-radius:10px;
                           background:#f09f1a;color:#1b1105;font-weight:700;cursor:pointer">
              Reintentar
            </button>
          </div>
        </body>`)
    );
  });

  ventana.on('closed', () => { ventana = null; });
}

// Una sola instancia: si se abre otra vez, se trae al frente la que ya está.
const bloqueo = app.requestSingleInstanceLock();
if (!bloqueo) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (ventana) {
      if (ventana.isMinimized()) ventana.restore();
      ventana.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    crearVentana();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) crearVentana();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
