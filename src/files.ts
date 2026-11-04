/** 파일 저장: 지원하는 브라우저(Chrome/Edge)에서는 저장 위치 선택 창, 아니면 다운로드 */
export async function saveFile(name: string, data: ArrayBuffer | string, mime: string, ext: string) {
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

export function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "part";
}
