@echo off
setlocal

set "PATH=C:\Users\vikas\.cargo\bin;%PATH%"
npm.cmd run build
if errorlevel 1 exit /b %errorlevel%

node "%~dp0..\node_modules\@tauri-apps\cli\tauri.js" build --bundles nsis --config src-tauri/tauri.bundle.conf.json

endlocal
