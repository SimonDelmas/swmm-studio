//! SWMM Studio desktop application.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod commands;
mod editing;
mod export;
mod project;
mod session;

use tauri::{Emitter, Manager, State};

struct LaunchFile(Option<String>);

/// The model file the app was started with, if any.
#[tauri::command]
fn launch_file(f: State<'_, LaunchFile>) -> Option<String> {
    f.0.clone()
}

/// The first `.inp` path among the command-line arguments (file association / "Open with").
fn inp_arg(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter().skip(1).find(|a| a.to_ascii_lowercase().ends_with(".inp") && std::path::Path::new(a).is_file())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A second launch (double-click on another .inp) hands its file to this window.
            let file = inp_arg(args).map(|a| {
                let p = std::path::PathBuf::from(&a);
                if p.is_absolute() {
                    a
                } else {
                    std::path::Path::new(&cwd).join(p).to_string_lossy().into_owned()
                }
            });
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(f) = file {
                let _ = app.emit("open-file", f);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .manage(LaunchFile(inp_arg(std::env::args())))
        .setup(|app| {
            // The main window is built here (not from the config) so that its User-Agent, which the
            // OSM tile policy requires, carries the crate version.
            let config = app.config().app.windows.iter().find(|w| w.label == "main").expect("main window config");
            tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
                .user_agent(&format!(
                    "SwmmStudio/{} (+https://github.com/SimonDelmas/swmm-studio)",
                    env!("CARGO_PKG_VERSION")
                ))
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launch_file,
            commands::open_model,
            commands::model_info,
            commands::geometry,
            commands::ids,
            commands::search_crs,
            commands::set_crs,
            commands::update_project,
            commands::pick,
            commands::select_rect,
            commands::select_polygon,
            commands::find_object,
            commands::object_info,
            commands::attribute,
            commands::open_results,
            commands::open_report,
            commands::frame,
            commands::series,
            commands::time_of_max,
            commands::next_event,
            commands::report_block,
            commands::rebuild_cache,
            commands::envelope,
            commands::save_file,
            commands::edit,
            commands::undo,
            commands::redo,
            commands::delete_plan,
            commands::names,
            commands::table,
            commands::options,
            commands::save_model,
            commands::new_model,
            commands::engines,
            commands::add_engine,
            commands::remove_engine,
            commands::set_default_engine,
            commands::set_project_engine,
            commands::run_start,
            commands::run_cancel,
            commands::stat_values,
            commands::stat_unit,
            commands::compare_frame,
            commands::compare_period,
            commands::open_comparison,
            commands::close_comparison,
            commands::aggregate,
            commands::event_stats,
            commands::object_events,
            commands::profile,
            commands::heads,
            commands::validate_model,
            commands::grid,
            commands::climate,
            commands::sections,
            commands::section_text,
            commands::runs,
            commands::open_run,
            commands::compare_run,
            commands::set_run_label,
            commands::delete_run,
            commands::export_table,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SWMM Studio");
}
