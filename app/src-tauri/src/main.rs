//! SWMM Studio desktop application.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod commands;
mod editing;
mod export;
mod model_views;
mod observed;
mod project;
mod recovery;
mod runs;
mod session;

use tauri::{Manager, State};

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
    // No single-instance lock: each launch (double-click on an .inp, "Open with") is its own
    // process with its own model, so several models can be open side by side.
    tauri::Builder::default()
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
            // Autosave of the open model's unsaved changes (F-FILE-5).
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(recovery::INTERVAL);
                handle.state::<commands::AppState>().autosave();
            });
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
            commands::runs::run_report,
            commands::runs::run_console,
            commands::results::set_overlays,
            commands::runs::set_run_label,
            commands::runs::delete_run,
            commands::files::export_table,
            commands::observed::inspect_observed,
            commands::observed::set_observed,
            commands::observed::observed_series,
            commands::recent::recent_files,
            commands::recent::forget_recent_file,
            commands::recent::recoveries,
            commands::recent::restore_recovery,
            commands::recent::discard_recovery,
        ])
        .build(tauri::generate_context!())
        .expect("error while building SWMM Studio")
        .run(|app, event| {
            // Quitting (the user was asked about unsaved changes): no recovery file is left.
            if let tauri::RunEvent::Exit = event {
                app.state::<commands::AppState>().close();
            }
        });
}
