import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

/** 파일 저장: 앱에서는 공유 시트, 브라우저에서는 다운로드 */
export async function saveFile(name: string, data: ArrayBuffer | string, mime: string) {
  if (Capacitor.isNativePlatform()) {
    const base64 = typeof data === "string" ? utf8ToBase64(data) : bufToBase64(data);
    const res = await Filesystem.writeFile({ path: name, data: base64, directory: Directory.Cache });
    await Share.share({ title: name, url: res.uri, dialogTitle: "파일 저장/공유" });
    return;
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
}

function bufToBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function utf8ToBase64(str: string) {
  return bufToBase64(new TextEncoder().encode(str).buffer as ArrayBuffer);
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
