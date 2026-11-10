/**
 * 설치형 앱(12단계)에서만 쓰는 것: 진짜 파일 열기·저장, 운영체제에서 연 파일, DWG 변환, 창 제목.
 * 웹판에서는 isApp()이 false라 아무것도 하지 않고, Tauri 코드는 앱 안에서만 내려받는다.
 */
export const isApp = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const core = () => import("@tauri-apps/api/core");
const dialog = () => import("@tauri-apps/plugin-dialog");

/** 지금 문서가 연결된 파일 (같은 파일에 바로 저장) — 문서 id별 */
const docPaths = new Map<string, string>();
let lastDir = "";

const MIME: Record<string, string> = {
  b3d: "application/x-blueprint3d",
  json: "application/json",
  step: "model/step",
  stp: "model/step",
  stl: "model/stl",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};
const extOf = (name: string) => (name.match(/\.([^.\\/]+)$/)?.[1] ?? "").toLowerCase();
export const baseOf = (path: string) => path.split(/[\\/]/).pop() ?? path;
const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
const join = (dir: string, name: string) => (dir ? `${dir}${dir.includes("\\") ? "\\" : "/"}${name}` : name);

function remember(path: string) {
  lastDir = dirOf(path);
  // 문서·3D 파일은 최근 파일로
  if (/\.(b3d|step|stp|stl)$/i.test(path)) void import("./prefs").then(({ prefs }) => prefs.set({ recentFiles: [path, ...prefs.get().recentFiles.filter((p) => p !== path)].slice(0, 10) }));
}

/** 파일 저장 (path가 없으면 저장 창). 저장한 경로, 취소면 null */
export async function nativeSave(name: string, data: ArrayBuffer | Uint8Array | string, ext: string, path?: string): Promise<string | null> {
  const target =
    path ??
    (await (await dialog()).save({
      defaultPath: join(lastDir, name),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    }));
  if (!target) return null;
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  await (await core()).invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(target) } });
  remember(target);
  return target;
}

/** 파일 고르기 (열기 창) → File (원래 경로는 pathOf로) */
export async function nativeOpen(accept: string, multiple = false): Promise<File[]> {
  const exts = [...new Set(accept.split(",").map((s) => s.trim()).filter((s) => s.startsWith(".")).map((s) => s.slice(1).toLowerCase()))];
  const r = await (await dialog()).open({
    multiple,
    directory: false,
    ...(lastDir ? { defaultPath: lastDir } : {}),
    filters: exts.length ? [{ name: exts.map((e) => e.toUpperCase()).join(" · "), extensions: exts }] : undefined,
  });
  const paths = r === null ? [] : Array.isArray(r) ? r : [r];
  return Promise.all(paths.map(readAsFile));
}

const filePaths = new WeakMap<File, string>();
/** 앱에서 연 파일의 원래 경로 */
export const pathOf = (f: File | Blob) => (f instanceof File ? filePaths.get(f) : undefined);

export async function readAsFile(path: string): Promise<File> {
  const buf = await (await core()).invoke<ArrayBuffer>("read_file", { path });
  remember(path);
  const name = baseOf(path);
  const f = new File([buf], name, { type: MIME[extOf(name)] ?? "" });
  filePaths.set(f, path);
  return f;
}

export const docPath = (docId: string) => docPaths.get(docId);
export function setDocPath(docId: string, path: string | null) {
  if (path && extOf(path) === "b3d") docPaths.set(docId, path);
  else docPaths.delete(docId);
  void setTitleFor(docId);
}

let titleDoc = "";
let titleName = "";
/** 창 제목: “파일 이름 — 도면3D” */
export async function setTitle(docId: string, docName: string) {
  titleDoc = docId;
  titleName = docName;
  await setTitleFor(docId);
}
async function setTitleFor(docId: string) {
  if (!isApp() || docId !== titleDoc) return;
  const p = docPaths.get(docId);
  const t = `${p ? baseOf(p) : titleName} — 도면3D`;
  document.title = t;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(t);
  } catch {
    /* 제목은 선택 */
  }
}

/** 운영체제에서 연 파일 받기: 시작할 때 + 켜져 있을 때 (두 번 눌러 열기, 이미 켜진 앱으로) */
export async function initNative(open: (f: File) => void) {
  if (!isApp()) return;
  const { invoke } = await core();
  const { listen } = await import("@tauri-apps/api/event");
  const take = async (paths: string[]) => {
    for (const p of paths) {
      try {
        open(await readAsFile(p));
      } catch (e) {
        console.warn("열 수 없는 파일", p, e);
      }
    }
  };
  await listen<string[]>("open-files", (e) => void take(e.payload));
  await take(await invoke<string[]>("startup_files"));
}

/** 링크를 기본 브라우저로 */
export async function openUrl(url: string) {
  if (!isApp()) return void window.open(url, "_blank", "noopener");
  const { openUrl: o } = await import("@tauri-apps/plugin-opener");
  await o(url);
}

// ---------------- DWG (12.3) ----------------

export const DWG_VERSIONS: [string, string][] = [
  ["ACAD2018", "AutoCAD 2018~ (권장)"],
  ["ACAD2013", "AutoCAD 2013~2017"],
  ["ACAD2010", "AutoCAD 2010~2012"],
  ["ACAD2007", "AutoCAD 2007~2009"],
  ["ACAD2004", "AutoCAD 2004~2006"],
  ["ACAD2000", "AutoCAD 2000~2002"],
];
export const ODA_URL = "https://www.opendesign.com/guestfiles/oda_file_converter";

/** 설치된 변환기 위치 (없으면 null) */
export async function findOda(custom: string): Promise<string | null> {
  if (!isApp()) return null;
  return (await core()).invoke<string | null>("find_oda", { custom: custom || null });
}

/** 변환기 고르기 (실행 파일) */
export async function pickOda(): Promise<string | null> {
  const r = await (await dialog()).open({ multiple: false, directory: false, title: "ODA File Converter 실행 파일 고르기" });
  return typeof r === "string" ? r : null;
}

/** DXF → DWG 저장. 저장한 경로, 취소면 null. 변환기가 없으면 Error("ODA_NOT_FOUND") */
export async function saveDwg(dxf: string, name: string, version: string, exe: string): Promise<string | null> {
  const dest = await (await dialog()).save({ defaultPath: join(lastDir, name), filters: [{ name: "DWG (AutoCAD)", extensions: ["dwg"] }] });
  if (!dest) return null;
  await (await core()).invoke("dxf_to_dwg", { dxf, dest, version, exe: exe || null });
  remember(dest);
  return dest;
}
