; Instalador de escritorio de WeasyTalkie - Inno Setup 6
; Compilar con:  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\WeasyTalkie.iss
;
; Empaqueta la aplicación de Electron generada en dist-desktop\WeasyTalkie-win.
; La aplicación es una ventana que abre la web del servidor; el audio va por
; WebRTC igual que en el navegador.

#define AppName        "WeasyTalkie"
#define AppVersion     "1.2.0"
#define AppPublisher   "WeasyTalkie"
#define AppExe         "WeasyTalkie.exe"
#define SourceDir      "..\dist-desktop\WeasyTalkie-win"

[Setup]
AppId={{7C4E9A18-3B25-4F7D-9E61-0A5D8C2F4B93}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}

; Se instala por usuario: no hace falta ser administrador.
DefaultDirName={localappdata}\{#AppName}
PrivilegesRequired=lowest
DefaultGroupName={#AppName}
AllowNoIcons=yes

OutputDir=dist
OutputBaseFilename=WeasyTalkie_{#AppVersion}_Setup
SetupIconFile=..\public\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}

Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Si la aplicación está abierta, ofrece cerrarla en vez de fallar.
CloseApplications=yes
CloseApplicationsFilter=*.exe

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "Crear un acceso directo en el escritorio"; GroupDescription: "Accesos directos:"
Name: "startup";     Description: "Iniciar automáticamente al encender el equipo"; GroupDescription: "Opciones:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}";             Filename: "{app}\{#AppExe}"
Name: "{group}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";       Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
; Arranque con Windows para el usuario que instala (instalación por usuario).
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
    ValueType: string; ValueName: "WeasyTalkie"; ValueData: """{app}\{#AppExe}"""; \
    Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#AppExe}"; Description: "Abrir {#AppName} ahora"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Datos del navegador integrado (caché, sesión).
Type: filesandordirs; Name: "{userappdata}\WeasyTalkie"


