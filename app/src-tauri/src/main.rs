//! SWMM Studio desktop application.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod commands;
mod editing;
mod export;
mod model_views;
mod project;
mod runs;
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
            commands::model::open_model,
            commands::model::model_info,
            commands::model::geometry,
            commands::model::ids,
            commands::model::search_crs,
            commands::model::set_crs,
            commands::model::update_project,
            commands::model::pick,
            commands::model::pick_all,
            commands::model::select_rect,
            commands::model::select_polygon,
            commands::model::find_object,
            commands::model::object_info,
            commands::model::attribute,
            commands::results::open_results,
            commands::results::open_report,
            commands::results::frame,
            commands::results::series,
            commands::results::time_of_max,
            commands::results::next_event,
            commands::results::report_block,
            commands::cache::rebuild_cache,
            commands::results::envelope,
            commands::files::save_file,
            commands::editing::edit,
            commands::editing::undo,
            commands::editing::redo,
            commands::editing::delete_plan,
            commands::editing::names,
            commands::editing::table,
            commands::editing::options,
            commands::model::save_model,
            commands::model::new_model,
            commands::engines::engines,
            commands::engines::add_engine,
            commands::engines::remove_engine,
            commands::engines::set_default_engine,
            commands::engines::set_project_engine,
            commands::run::run_start,
            commands::run::run_cancel,
            commands::analysis::stat_values,
            commands::analysis::stat_unit,
            commands::results::compare_frame,
            commands::results::compare_period,
            commands::results::open_comparison,
            commands::results::close_comparison,
            commands::analysis::aggregate,
            commands::analysis::event_stats,
            commands::analysis::object_events,
            commands::analysis::profile,
            commands::analysis::heads,
            commands::editing::validate_model,
            commands::editing::grid,
            commands::editing::climate,
            commands::editing::sections,
            commands::editing::section_text,
            commands::runs::runs,
            commands::runs::open_run,
            commands::runs::compare_run,
            commands::runs::set_run_label,
            commands::runs::delete_run,
            commands::files::export_table,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SWMM Studio");
}
