//! SWMM Studio desktop application.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod commands;
mod editing;
mod export;
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
