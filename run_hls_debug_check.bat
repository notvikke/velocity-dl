@echo off
setlocal
cd /d "%~dp0"
set "CARGO_BIN=C:\Users\vikas\.cargo\bin"
set "RUSTUP_BIN=C:\Users\vikas\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"
set "PATH=%CARGO_BIN%;%RUSTUP_BIN%;%PATH%;%AppData%\npm"
set "npm_config_script_shell=cmd.exe"

echo [1/3] Checking Node.js...
node --version
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not available in PATH.
    pause
    exit /b 1
)

echo [2/3] Checking npm...
call npm.cmd --version
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm.cmd is not available in PATH.
    pause
    exit /b 1
)

echo [3/4] Checking Rust...
cargo --version
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Cargo is not available in PATH.
    pause
    exit /b 1
)

echo [4/4] Launching VelocityDL from current source...
echo This runs the updated Rust backend, not the installed .exe.
node node_modules\@tauri-apps\cli\tauri.js dev

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Tauri dev exited with code %ERRORLEVEL%.
)

pause
