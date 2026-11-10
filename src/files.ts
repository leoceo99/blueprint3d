import { isApp, nativeOpen, nativeSave } from "./app/native";

/**
 * 파일 저장: 설치형 앱은 운영체제 저장 창(12단계), 브라우저는 저장 위치 선택 창(Chrome/Edge) 아니면 다운로드.
 * 앱에서는 저장한 경로를 돌려준다 (취소면 false).
 */
export async function saveFile(name: string, data: ArrayBuffer | string, mime: string, ext: string): Promise<boolean | string> {
  if (isApp()) return (await nativeSave(name, data, ext)) ?? false;
  const w = window as any;
  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: ext.toUpperCase(), accept: { [mime]: [`.${ext}`] } }],
      });
      const stream = await handle.createWritable();
      await stream.write(data);
      await stream.close();
      return true;
    } catch (e: any) {
      if (e?.name === "AbortError") return false;
      // 그 외 오류면 일반 다운로드로
    }
  }
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

/** 파일 선택 → 텍스트 */
export function pickTextFile(accept: string): Promise<string | null> {
  if (isApp()) return nativeOpen(accept).then(async ([f]) => (f ? f.text() : null));
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? await f.text() : null);
    };
    input.click();
  });
}

/** 파일 고르기 (여러 개도) — 앱에서는 운영체제 열기 창 */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  if (isApp()) return nativeOpen(accept, multiple);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

export function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "part";
}
