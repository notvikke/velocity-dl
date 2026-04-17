@echo off
setlocal

set "PATH=C:\Users\vikas\.cargo\bin;%PATH%"
powershell -ExecutionPolicy Bypass -File "%~dp0stage-vendor-binaries.ps1"
if errorlevel 1 exit /b %errorlevel%

pushd "%~dp0..\src-tauri"
cargo.exe build --release --bin vdl_native_host
if errorlevel 1 (
  popd
  exit /b %errorlevel%
)
popd

node "%~dp0..\node_modules\@tauri-apps\cli\tauri.js" build --bundles nsis --config src-tauri/tauri.full.conf.json

endlocal
