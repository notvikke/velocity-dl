use crate::engine::manager::DownloadManager;
use crate::extractor::clipboard::start_clipboard_polling;
use crate::extractor::native_bridge::{
    start_app_presence, start_native_inbox_polling, ExtensionHealthState, ExternalCaptureQueueState,
};
use crate::ipc::commands::{
    ack_external_capture_request, add_download, fetch_metadata, get_app_diagnostics,
    get_browser_integration_status, get_extension_health, get_settings, get_tooling_status,
    install_browser_integration, open_browser_extensions_page, open_extension_setup_link, open_folder,
    pause_download, save_settings, set_external_capture_listener_ready, start_sniffing,
    update_tool_binary,
};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::net::TcpStream;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

pub mod auth;
pub mod engine;
pub mod extractor;
pub mod ipc;
pub mod protocols;

struct SingleInstanceGuard {
    _listener: TcpListener,
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn acquire_single_instance_guard() -> Result<SingleInstanceGuard, std::io::Error> {
    match TcpListener::bind("127.0.0.1:43187") {
        Ok(listener) => Ok(SingleInstanceGuard {
            _listener: listener,
        }),
        Err(bind_err) => {
            if let Ok(mut stream) = TcpStream::connect("127.0.0.1:43187") {
                let _ = stream.write_all(b"show");
            }
            Err(bind_err)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DownloadManager::new())
        .manage(auth::store::AuthManager::new())
        .manage(ExtensionHealthState::default())
        .manage(ExternalCaptureQueueState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let guard = match acquire_single_instance_guard() {
                Ok(guard) => guard,
                Err(_) => {
                    std::process::exit(0);
                }
            };
            if let Ok(listener) = guard._listener.try_clone() {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    for incoming in listener.incoming() {
                        let Ok(mut stream) = incoming else {
                            continue;
                        };
                        let mut buf = [0_u8; 16];
                        let _ = stream.read(&mut buf);
                        show_main_window(&app_handle);
                    }
                });
            }
            app.manage(guard);

            let main_window = app.get_webview_window("main").unwrap();
            let _ = main_window.show();

            let presence_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                start_app_presence(presence_handle).await;
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                start_clipboard_polling(handle).await;
            });
            let native_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                start_native_inbox_polling(native_handle).await;
            });

            // Create Tray Menu
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show VelocityDL", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        show_main_window(app);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // In dev builds, close should exit fully so rebuilds do not race a hidden
                // tray-resident process. Keep the tray behavior only for non-dev builds.
                if !cfg!(debug_assertions) && window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            add_download,
            pause_download,
            get_settings,
            get_extension_health,
            get_browser_integration_status,
            get_tooling_status,
            get_app_diagnostics,
            ack_external_capture_request,
            set_external_capture_listener_ready,
            save_settings,
            fetch_metadata,
            install_browser_integration,
            update_tool_binary,
            open_browser_extensions_page,
            open_extension_setup_link,
            open_folder,
            start_sniffing
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
