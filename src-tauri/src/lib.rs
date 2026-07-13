use crate::engine::manager::DownloadManager;
use crate::extractor::clipboard::start_clipboard_polling;
use crate::extractor::native_bridge::{
    start_app_presence, start_native_inbox_polling, ExtensionHealthState, ExternalCaptureQueueState,
};
use crate::ipc::commands::{
    ack_external_capture_request, add_download, delete_download_artifacts, fetch_metadata,
    get_app_diagnostics, get_browser_integration_status, get_extension_health, get_settings,
    get_tooling_status, install_browser_integration, open_browser_extensions_page,
    open_browser_install_page, open_extension_setup_link, open_folder, pause_download,
    reveal_main_window, save_settings, set_external_capture_listener_ready, start_sniffing,
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
use window_activation::{reveal_main_window as reveal_main_window_now, NewDownloadRevealState};

pub mod auth;
pub mod browser_session;
pub mod delete_artifacts;
pub mod engine;
pub mod extension_identity;
pub mod extractor;
pub mod ipc;
pub mod pathing;
pub mod protocols;
pub mod request_context;
pub mod window_activation;
pub mod window_activation_policy;

struct SingleInstanceGuard {
    _listener: TcpListener,
}

const RELEASE_SINGLE_INSTANCE_ADDRESS: &str = "127.0.0.1:43187";
const DEVELOPMENT_SINGLE_INSTANCE_ADDRESS: &str = "127.0.0.1:43188";

fn single_instance_address_for(is_development: bool) -> &'static str {
    if is_development {
        DEVELOPMENT_SINGLE_INSTANCE_ADDRESS
    } else {
        RELEASE_SINGLE_INSTANCE_ADDRESS
    }
}

fn single_instance_address() -> &'static str {
    single_instance_address_for(cfg!(debug_assertions))
}

#[cfg(test)]
mod tests {
    use super::single_instance_address_for;

    #[test]
    fn development_and_release_builds_use_separate_single_instance_addresses() {
        assert_eq!(single_instance_address_for(true), "127.0.0.1:43188");
        assert_eq!(single_instance_address_for(false), "127.0.0.1:43187");
    }
}

fn acquire_single_instance_guard() -> Result<SingleInstanceGuard, std::io::Error> {
    let address = single_instance_address();
    match TcpListener::bind(address) {
        Ok(listener) => Ok(SingleInstanceGuard {
            _listener: listener,
        }),
        Err(bind_err) => {
            if let Ok(mut stream) = TcpStream::connect(address) {
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
        .manage(NewDownloadRevealState::default())
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
                        let _ = reveal_main_window_now(&app_handle, None);
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
                        let _ = reveal_main_window_now(app, None);
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
            delete_download_artifacts,
            ack_external_capture_request,
            set_external_capture_listener_ready,
            reveal_main_window,
            save_settings,
            fetch_metadata,
            install_browser_integration,
            update_tool_binary,
            open_browser_install_page,
            open_browser_extensions_page,
            open_extension_setup_link,
            open_folder,
            start_sniffing
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
