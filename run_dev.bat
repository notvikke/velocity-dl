@echo off
set "CARGO_BIN=C:\Users\vikas\.cargo\bin"
set "RUSTUP_BIN=C:\Users\vikas\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"
set "PATH=%CARGO_BIN%;%RUSTUP_BIN%;%PATH%;%AppData%\npm"

echo [1/3] Checking Rust environment...
"%CARGO_BIN%\cargo.exe" --version
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Cargo not found at %CARGO_BIN%\cargo.exe
    pause
    exit /b 1
)

echo [2/3] Checking Node environment...
node --version
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found in PATH.
    pause
    exit /b 1
)

echo [3/3] Launching Tauri CLI...
:: Using tauri.js which is the actual CLI wrapper
node node_modules\@tauri-apps\cli\tauri.js dev
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Tauri dev failed with exit code %ERRORLEVEL%
)

pause
