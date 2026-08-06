; installer.iss — builds SeansFontPrototypingFriend-Setup.exe with Inno Setup 6.
;
;   "C:\Users\Zack\AppData\Local\Programs\Inno Setup 6\ISCC.exe" installer.iss
;
; Build the app first (PyInstaller --onedir) and stage fonts\ + README.txt +
; INSTALL.txt into dist\SeansFontPrototypingFriend\, because this script just
; packages that folder verbatim.
;
; WHY IT INSTALLS UNDER %LOCALAPPDATA%\Programs AND NOT "Program Files"
;   The app keeps its fonts in a fonts\ folder next to the exe and writes
;   settings.json there too. Program Files is read-only for a normal user, so an
;   install there would break "Add font..." and lose settings. Installing per-user
;   also means NO admin rights and no UAC prompt, which is what makes this
;   reliable on a locked-down shop PC.

#define AppName "Sean's Font Prototyping Friend"
#define AppExe "SeansFontPrototypingFriend.exe"
#define AppVer "1.0.0"
#define SrcDir "dist\SeansFontPrototypingFriend"

[Setup]
; A fixed AppId means a re-run upgrades in place instead of installing twice.
AppId={{7C3A6E14-9B52-4F0D-8E71-2A5D4C8B1F63}
AppName={#AppName}
AppVersion={#AppVer}
AppVerName={#AppName} {#AppVer}
AppPublisher=ShineOn
DefaultDirName={localappdata}\Programs\SeansFontPrototypingFriend
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=dist_installer
OutputBaseFilename=SeansFontPrototypingFriend-Setup
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; the app itself needs 64-bit Windows 10 or later
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
; the whole PyInstaller folder, exactly as tested
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{group}\Read me first"; Filename: "{app}\README.txt"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; \
    Flags: nowait postinstall skipifsilent

[UninstallDelete]
; settings.json and startup.log are created at run time, so Inno does not know
; about them; remove them so an uninstall leaves nothing behind. Fonts the user
; added to fonts\ are deliberately NOT touched — only the shipped ones are
; removed, and the folder goes only if it ends up empty.
Type: files; Name: "{app}\settings.json"
Type: files; Name: "{app}\startup.log"
Type: dirifempty; Name: "{app}\fonts"
Type: dirifempty; Name: "{app}"
