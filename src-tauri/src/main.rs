// 윈도우에서 검은 명령 창이 같이 뜨지 않게 (배포판)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    blueprint3d_lib::run()
}
