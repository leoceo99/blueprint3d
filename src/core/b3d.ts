/**
 * 문서 파일 .b3d (9단계): zip 압축 묶음.
 *   document.json   모델 (부품·도면·장면) + 형식 정보 — FreeCAD의 Document.xml에 해당
 *   view.json       화면 상태 (열린 부품·도면) — GuiDocument.xml에 해당
 *   files.json      큰 파일 목록 (키 → 종류)
 *   files/<키>      가져온 3D 파일·밑그림 이미지 원본 (이진 그대로, base64 아님)
 *   thumbnail.jpg   미리 보기 그림 (있으면)
 * 예전 .json 프로젝트 파일(밑그림·3D 파일을 base64로 품은 것)도 읽는다.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { fromBase64, parseDataUrl, toDataUrl } from "./bytes";
import { docFileKeys, normalizeDoc, type Doc } from "./document";

export const B3D_EXT = ".b3d";
export const B3D_MIME = "application/x-blueprint3d";

/** 큰 파일: 이진(가져온 3D 파일) 또는 data URL 글자(밑그림 이미지) */
export type FileData = ArrayBuffer | string;

export interface B3dContent {
  doc: Doc;
  files: Record<string, FileData>;
  thumbnail?: Uint8Array;
}

interface FileEntry {
  /** 이미지면 MIME (읽을 때 data URL로 되돌림), 이진이면 "binary" */
  type: string;
  size: number;
}

/** 이미 압축된 것(이미지)은 다시 압축하지 않는다 */
const STORED = /^image\/(png|jpe?g|webp|gif)$/;

export function writeB3d({ doc, files, thumbnail }: B3dContent): Uint8Array {
  const { view, ...model } = doc;
  const entries: Zippable = {
    "document.json": strToU8(JSON.stringify({ ...model, app: "도면3D", savedAt: new Date().toISOString() })),
    "view.json": strToU8(JSON.stringify(view)),
  };
  const list: Record<string, FileEntry> = {};
  for (const key of docFileKeys(doc)) {
    const f = files[key];
    if (f === undefined) continue;
    if (typeof f === "string") {
      const d = parseDataUrl(f);
      if (!d) continue;
      list[key] = { type: d.mime, size: d.bytes.length };
      entries[`files/${key}`] = [d.bytes, { level: STORED.test(d.mime) ? 0 : 6 }];
    } else {
      const b = new Uint8Array(f);
      list[key] = { type: "binary", size: b.length };
      entries[`files/${key}`] = [b, { level: 6 }];
    }
  }
  entries["files.json"] = strToU8(JSON.stringify(list));
  if (thumbnail) entries["thumbnail.jpg"] = [thumbnail, { level: 0 }];
  return zipSync(entries, { level: 6 });
}

export const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

export function readB3d(bytes: Uint8Array): B3dContent {
  let z: Record<string, Uint8Array>;
  try {
    z = unzipSync(bytes);
  } catch {
    throw new Error("도면3D 문서(.b3d)를 열 수 없습니다. 파일이 깨졌을 수 있어요.");
  }
  if (!z["document.json"]) throw new Error("도면3D 문서(.b3d)가 아닙니다.");
  const raw = JSON.parse(strFromU8(z["document.json"]));
  if (typeof raw.version === "number" && raw.version > 2) throw new Error("더 새 버전의 도면3D에서 만든 문서예요. 앱을 업데이트하세요.");
  if (z["view.json"]) {
    try {
      raw.view = JSON.parse(strFromU8(z["view.json"]));
    } catch {
      /* 화면 상태는 없어도 된다 */
    }
  }
  const doc = normalizeDoc(raw);
  if (!doc) throw new Error("문서 내용을 읽을 수 없습니다.");
  const list: Record<string, FileEntry> = z["files.json"] ? JSON.parse(strFromU8(z["files.json"])) : {};
  const files: Record<string, FileData> = {};
  for (const [name, data] of Object.entries(z)) {
    if (!name.startsWith("files/")) continue;
    const key = name.slice(6);
    const type = list[key]?.type ?? "binary";
    files[key] = type === "binary" ? data.slice().buffer : toDataUrl(type, data);
  }
  return { doc, files, thumbnail: z["thumbnail.jpg"] };
}

/**
 * 예전 프로젝트 .json (5~8단계): 밑그림 이미지는 underlay.data(data URL), 3D 파일은 source.data(base64)에 들어 있다.
 * 9단계 문서를 JSON으로 저장한 것도 읽는다.
 */
export function readLegacyJson(text: string): B3dContent {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("프로젝트 파일을 읽을 수 없습니다.");
  }
  const files: Record<string, FileData> = {};
  const take = (p: any) => {
    if (p?.underlay && typeof p.underlay.data === "string") {
      if (p.underlay.data.startsWith("data:image/") && typeof p.underlay.key === "string") files[p.underlay.key] = p.underlay.data;
      delete p.underlay.data;
    }
    if (p?.source && typeof p.source.data === "string") {
      if (typeof p.source.key === "string") files[p.source.key] = fromBase64(p.source.data);
      delete p.source.data;
    }
  };
  if (Array.isArray(raw?.parts)) raw.parts.forEach(take);
  else take(raw);
  const doc = normalizeDoc(raw);
  if (!doc) throw new Error("프로젝트 파일을 읽을 수 없습니다.");
  return { doc, files };
}

/** 파일 내용으로 어느 형식인지 보고 읽는다 */
export function readDocFile(bytes: Uint8Array): B3dContent {
  if (isZip(bytes)) return readB3d(bytes);
  return readLegacyJson(new TextDecoder().decode(bytes));
}

// ---------------- 전체 백업 zip ----------------

/** 보관함 전체 백업: backup.json(문서·버전 목록) + files.json + files/<키> */
export function writeBackupZip(meta: object, files: Record<string, FileData>): Uint8Array {
  const entries: Zippable = { "backup.json": strToU8(JSON.stringify(meta)) };
  const list: Record<string, FileEntry> = {};
  for (const [key, f] of Object.entries(files)) {
    if (typeof f === "string") {
      const d = parseDataUrl(f);
      if (!d) continue;
      list[key] = { type: d.mime, size: d.bytes.length };
      entries[`files/${key}`] = [d.bytes, { level: STORED.test(d.mime) ? 0 : 6 }];
    } else {
      const b = new Uint8Array(f);
      list[key] = { type: "binary", size: b.length };
      entries[`files/${key}`] = [b, { level: 6 }];
    }
  }
  entries["files.json"] = strToU8(JSON.stringify(list));
  return zipSync(entries, { level: 6 });
}

export function readBackupZip(bytes: Uint8Array): { meta: unknown; files: Record<string, FileData> } {
  let z: Record<string, Uint8Array>;
  try {
    z = unzipSync(bytes);
  } catch {
    throw new Error("백업 파일을 열 수 없습니다. 파일이 깨졌을 수 있어요.");
  }
  if (!z["backup.json"]) throw new Error("도면3D 백업 파일이 아닙니다.");
  const meta = JSON.parse(strFromU8(z["backup.json"]));
  const list: Record<string, FileEntry> = z["files.json"] ? JSON.parse(strFromU8(z["files.json"])) : {};
  const files: Record<string, FileData> = {};
  for (const [name, data] of Object.entries(z)) {
    if (!name.startsWith("files/")) continue;
    const key = name.slice(6);
    const type = list[key]?.type ?? "binary";
    files[key] = type === "binary" ? data.slice().buffer : toDataUrl(type, data);
  }
  return { meta, files };
}
