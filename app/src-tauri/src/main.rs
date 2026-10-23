//! SWMM Studio desktop application.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod editing;
mod project;
mod session;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running SWMM Studio");
}
