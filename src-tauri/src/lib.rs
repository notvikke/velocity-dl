use crate::engine::manager::DownloadManager;
use crate::extractor::clipboard::start_clipboard_polling;
use crate::extractor::native_bridge::start_native_inbox_polling;
use crate::ipc::commands::{
    add_download, fetch_metadata, get_app_diagnostics, get_settings, open_folder, pause_download,
    save_settings, start_sniffing,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub mod auth;
pub mod engine;
pub mod extractor;
pub mod ipc;
pub mod protocols;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DownloadManager::new())
        .manage(auth::store::AuthManager::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let main_window = app.get_webview_window("main").unwrap();
            let _ = main_window.show();

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                start_clipboard_polling(handle).await;
            });
            let native_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
                start_native_inbox_polling(native_handle).await;
            });

            // Create Tray Menu
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show VelocityDL", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button_state: _, ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
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
            get_app_diagnostics,
            save_settings,
            fetch_metadata,
            open_folder,
            start_sniffing
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
