//! 진짜 파일 읽기·쓰기 (12.2). 경로는 사용자가 열기·저장 창에서 고른 것.
use tauri::ipc::{InvokeBody, Request, Response};

/// 파일 내용을 바이트 그대로 (JSON으로 바꾸지 않아 큰 STEP도 빠름)
#[tauri::command]
pub fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path).map(Response::new).map_err(|e| format!("{path}: {e}"))
}

/// 본문은 바이트 그대로, 경로는 머리글 `x-path` (URL 인코딩 — 한글 경로)
#[tauri::command]
pub fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(pct_decode)
        .ok_or("저장할 경로가 없습니다")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("저장할 내용이 없습니다".into());
    };
    write_atomic(&path, bytes)
}

/// 같은 폴더의 임시 파일에 다 쓴 뒤 바꿔 넣는다 — 쓰는 도중에 꺼져도 원래 파일이 깨지지 않게
pub fn write_atomic(path: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = format!("{path}.b3d-saving");
    std::fs::write(&tmp, bytes).map_err(|e| format!("저장할 수 없습니다: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("저장할 수 없습니다: {e}")
    })
}

/// %XX 풀기 (encodeURIComponent의 반대)
pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_korean_path() {
        assert_eq!(pct_decode("C%3A%5C%EB%8F%84%EB%A9%B4%20%EC%98%88.b3d"), "C:\\도면 예.b3d");
        assert_eq!(pct_decode("plain"), "plain");
        assert_eq!(pct_decode("bad%zz%"), "bad%zz%");
    }

    #[test]
    fn atomic_write_replaces_existing() {
        let dir = std::env::temp_dir().join(format!("b3d-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("문서.b3d");
        let ps = p.to_string_lossy().into_owned();
        write_atomic(&ps, b"one").unwrap();
        write_atomic(&ps, b"two").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        assert!(!dir.join("문서.b3d.b3d-saving").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
