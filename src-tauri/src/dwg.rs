//! DWG 저장 (12.3): 사용자가 설치한 ODA File Converter로 DXF → DWG.
//! 명령 형식 (ezdxf의 odafc 애드온과 같음):
//!   ODAFileConverter "입력 폴더" "출력 폴더" ACAD2018 DWG 0 1 "파일 이름"
//!   (버전 · 출력 종류 · 하위 폴더 0 · 검사 1 · 입력 파일)
//! 리눅스 변환기는 성공해도 비정상 종료할 때가 있어서, 결과 파일이 생겼는지로 성공을 판단한다.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 고를 수 있는 DWG 버전 (AutoCAD 2018 형식이 2018~최신 AutoCAD에서 그대로 열림)
pub const VERSIONS: &[&str] = &["ACAD2018", "ACAD2013", "ACAD2010", "ACAD2007", "ACAD2004", "ACAD2000"];

/// 변환기 찾기: 직접 지정 → PATH → 기본 설치 위치
pub fn locate(custom: Option<&str>) -> Option<PathBuf> {
    if let Some(c) = custom.map(str::trim).filter(|c| !c.is_empty()) {
        let p = PathBuf::from(c);
        return if p.is_file() { Some(p) } else { None };
    }
    which("ODAFileConverter").or_else(|| default_locations().into_iter().find(|p| p.is_file()))
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: &[&str] = if cfg!(windows) { &[".exe", ""] } else { &[""] };
    for dir in std::env::split_paths(&path) {
        for ext in exts {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// 폴더 안에서 이름이 `prefix`로 시작하는 하위 폴더 (새 버전부터)
fn dirs_starting(base: &Path, prefix: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(base)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir() && p.file_name().map(|n| n.to_string_lossy().starts_with(prefix)).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v.reverse();
    v
}

fn default_locations() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(base) = std::env::var(var) {
                let oda = Path::new(&base).join("ODA");
                // 버전이 붙은 폴더 (예: "ODAFileConverter 25.12.0")
                for d in dirs_starting(&oda, "ODAFileConverter") {
                    out.push(d.join("ODAFileConverter.exe"));
                }
            }
        }
    } else if cfg!(target_os = "macos") {
        out.push("/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter".into());
    } else {
        out.push("/usr/bin/ODAFileConverter".into());
        out.push("/usr/local/bin/ODAFileConverter".into());
        for d in dirs_starting(Path::new("/opt"), "ODAFileConverter") {
            out.push(d.join("ODAFileConverter"));
        }
    }
    out
}

#[tauri::command]
pub fn find_oda(custom: Option<String>) -> Option<String> {
    locate(custom.as_deref()).map(|p| p.to_string_lossy().into_owned())
}

/// DXF 글자 → DWG 파일 (dest). 변환기가 없으면 "ODA_NOT_FOUND"
#[tauri::command]
pub async fn dxf_to_dwg(dxf: String, dest: String, version: String, exe: Option<String>) -> Result<(), String> {
    let exe = locate(exe.as_deref()).ok_or_else(|| "ODA_NOT_FOUND".to_string())?;
    tauri::async_runtime::spawn_blocking(move || convert(&exe, &dxf, Path::new(&dest), &version))
        .await
        .map_err(|e| e.to_string())?
}

pub fn convert(exe: &Path, dxf: &str, dest: &Path, version: &str) -> Result<(), String> {
    if !VERSIONS.contains(&version) {
        return Err(format!("모르는 DWG 버전: {version}"));
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let work = std::env::temp_dir().join(format!("b3d-dwg-{}-{stamp}", std::process::id()));
    let (inp, out) = (work.join("in"), work.join("out"));
    let result = (|| {
        std::fs::create_dir_all(&inp).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        std::fs::write(inp.join("drawing.dxf"), dxf).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(exe);
        cmd.arg(&inp).arg(&out).args([version, "DWG", "0", "1", "drawing.dxf"]);
        cmd.stdin(Stdio::null());
        hide_window(&mut cmd);
        let display = hidden_display(&mut cmd);
        let res = cmd.output();
        if let Some(mut d) = display {
            let _ = d.kill();
            let _ = d.wait();
        }
        let output = res.map_err(|e| format!("변환기를 실행할 수 없습니다: {e}"))?;
        let made = out.join("drawing.dwg");
        if made.is_file() && std::fs::metadata(&made).map(|m| m.len() > 0).unwrap_or(false) {
            std::fs::copy(&made, dest).map(|_| ()).map_err(|e| format!("DWG를 저장할 수 없습니다: {e}"))
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!("변환하지 못했습니다 (종료 코드 {:?}){}", output.status.code(), if err.is_empty() { String::new() } else { format!(": {err}") }))
        }
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// 윈도우: 검은 명령 창이 뜨지 않게
#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide_window(_: &mut Command) {}

/// 리눅스: 변환기가 창을 띄우려 하므로 Xvfb가 있으면 보이지 않는 화면에서
#[cfg(target_os = "linux")]
fn hidden_display(cmd: &mut Command) -> Option<std::process::Child> {
    let xvfb = which("Xvfb")?;
    let display = format!(":{}", 90 + std::process::id() % 400);
    let child = Command::new(xvfb).args([display.as_str(), "-screen", "0", "800x600x24"]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok()?;
    std::thread::sleep(std::time::Duration::from_millis(150));
    cmd.env("DISPLAY", display);
    Some(child)
}
#[cfg(not(target_os = "linux"))]
fn hidden_display(_: &mut Command) -> Option<std::process::Child> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// 가짜 변환기: 인자 순서를 확인하고 입력 DXF를 출력 폴더에 .dwg로 복사
    fn fake(dir: &Path, ok: bool) -> PathBuf {
        let p = dir.join(if ok { "fake-oda" } else { "broken-oda" });
        let body = if ok {
            r#"#!/bin/sh
[ "$3" = "ACAD2018" ] && [ "$4" = "DWG" ] && [ "$5" = "0" ] && [ "$6" = "1" ] && [ "$7" = "drawing.dxf" ] || { echo "bad args: $*" >&2; exit 2; }
cp "$1/$7" "$2/drawing.dwg"
echo "Quit (core dumped)" >&2
exit 134
"#
        } else {
            "#!/bin/sh\necho 'cannot convert' >&2\nexit 1\n"
        };
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("b3d-dwg-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn converts_with_ezdxf_argument_order_even_if_converter_crashes() {
        let d = tmp("ok");
        let exe = fake(&d, true);
        let dest = d.join("도면.dwg");
        convert(&exe, "0\nSECTION\n", &dest, "ACAD2018").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "0\nSECTION\n");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn reports_failure_and_unknown_version() {
        let d = tmp("bad");
        let exe = fake(&d, false);
        let err = convert(&exe, "x", &d.join("a.dwg"), "ACAD2018").unwrap_err();
        assert!(err.contains("cannot convert"), "{err}");
        assert!(convert(&exe, "x", &d.join("a.dwg"), "ACAD1999").unwrap_err().contains("버전"));
        assert!(!d.join("a.dwg").exists());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn locate_prefers_custom_path() {
        let d = tmp("loc");
        let exe = fake(&d, true);
        assert_eq!(locate(Some(exe.to_str().unwrap())), Some(exe.clone()));
        assert_eq!(locate(Some("/no/such/ODAFileConverter")), None);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
