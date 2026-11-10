//! 도면3D 설치형 앱 (12단계): 웹 코드(dist)를 그대로 띄우고, 브라우저가 못 하는 것만 여기서
//!   - 진짜 파일 읽기·쓰기 (files.rs)
//!   - 운영체제에서 연 파일 받기 (명령줄, 이미 켜져 있으면 그 창으로, 맥은 Opened 이벤트)
//!   - DWG 저장 — 설치된 ODA File Converter 실행 (dwg.rs)
mod dwg;
mod files;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// 화면이 준비되기 전에 열린 파일들 (화면이 startup_files로 가져감)
#[derive(Default)]
struct Opened {
    files: Mutex<Vec<String>>,
    ready: Mutex<bool>,
}

/// 명령줄 인자 중 실제 파일 (첫 인자는 앱 자신)
fn file_args(args: &[String]) -> Vec<String> {
    args.iter().skip(1).filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_file()).cloned().collect()
}

/// 화면이 준비됐을 때 한 번: 그 사이 열린 파일들
#[tauri::command]
fn startup_files(state: tauri::State<Opened>) -> Vec<String> {
    *state.ready.lock().unwrap() = true;
    std::mem::take(&mut *state.files.lock().unwrap())
}

/// 앱 이름·버전 (설정 화면)
#[tauri::command]
fn app_info(app: tauri::AppHandle) -> (String, String) {
    let p = app.package_info();
    (p.name.clone(), p.version.to_string())
}

fn deliver(app: &tauri::AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    let state = app.state::<Opened>();
    if *state.ready.lock().unwrap() {
        let _ = app.emit("open-files", files);
    } else {
        state.files.lock().unwrap().extend(files);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // 이미 켜져 있으면 새 창을 띄우지 않고 그 창에서 연다
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            deliver(app, file_args(&args));
        }));
    }
    let opened = Opened::default();
    *opened.files.lock().unwrap() = file_args(&std::env::args().collect::<Vec<_>>());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(opened)
        .invoke_handler(tauri::generate_handler![startup_files, app_info, files::read_file, files::write_file, dwg::find_oda, dwg::dxf_to_dwg])
        .build(tauri::generate_context!())
        .expect("도면3D를 시작할 수 없습니다")
        .run(|_app, _event| {
            // 맥: Finder에서 연 파일은 이벤트로 온다
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                let files = urls.iter().filter_map(|u| u.to_file_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect();
                deliver(_app, files);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::file_args;

    #[test]
    fn only_existing_files_from_args() {
        let f = std::env::temp_dir().join(format!("b3d-arg-{}.b3d", std::process::id()));
        std::fs::write(&f, b"x").unwrap();
        let fs = f.to_string_lossy().into_owned();
        let args = vec!["blueprint3d".into(), "--flag".into(), fs.clone(), "/no/such.b3d".into()];
        assert_eq!(file_args(&args), vec![fs]);
        std::fs::remove_file(&f).unwrap();
    }
}
