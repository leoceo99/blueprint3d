/**
 * 프로젝트 보관함과 버전 기록 (IndexedDB).
 *  - 프로젝트: 여러 개, 썸네일, 휴지통(30일)
 *  - 버전: 자동(편집 중 10분마다·큰 변화 직전) + 직접 저장(이름), 자동 버전은 최근 50개
 *  - 백업: 모든 프로젝트·버전·파일을 한 파일로 내보내고 가져오기
 * 지금 열린 프로젝트 id는 store.projectId (브라우저 저장본에 함께 적힘).
 */
import { idbAll, idbByIndex, idbDelete, idbGet, idbPut } from "./db";
import { gcFiles, getFile, getText, putFile } from "./fileStore";
import { docFileKeys, docFromProject, docSummary, normalizeDoc, type Doc } from "./core/document";
import type { Project } from "./core/types";
import { pruneAuto, trashExpired } from "./core/versions";
import { fromBase64, toBase64 } from "./core/bytes";
import { isZip, readBackupZip, writeBackupZip, type FileData } from "./core/b3d";

export { fromBase64, toBase64 };

/** 문서 (예전 프로젝트도 받는다) */
type DocLike = Doc | Project;
const asDoc = (x: DocLike): Doc => ("parts" in x && Array.isArray((x as Doc).parts) ? (x as Doc) : docFromProject(x as Project));

export interface ProjectRec {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 문서 JSON (8단계까지는 프로젝트 JSON — 읽을 때 문서로 바꿈) */
  data: string;
  summary: string;
  /** 작은 썸네일 (JPEG data URL) */
  thumb?: string;
  /** 휴지통에 넣은 시각 */
  deletedAt?: number;
}

export interface VersionRec {
  id: string;
  projectId: string;
  time: number;
  label: string;
  auto: boolean;
  data: string;
  summary: string;
  thumb?: string;
}

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const newProjectId = () => uid("p");

/** 저장된 글자 → 문서 (예전 프로젝트 형식이면 부품 1개 문서로) */
export const parseProject = (data: string): Doc | null => {
  try {
    return normalizeDoc(JSON.parse(data));
  } catch {
    return null;
  }
};

// ---------------- 프로젝트 ----------------

export async function listProjects(): Promise<ProjectRec[]> {
  const all = await idbAll<ProjectRec>("projects");
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getProject = (id: string) => idbGet<ProjectRec>("projects", id);

/** 프로젝트 저장 (없으면 새로 만든다). 썸네일을 주지 않으면 있던 것, 만든 시각은 그대로 */
export async function saveProject(id: string, x: DocLike, opts: { now?: number; thumb?: string } = {}): Promise<ProjectRec> {
  const p = asDoc(x);
  const now = opts.now ?? Date.now();
  const data = JSON.stringify(p);
  const old = await getProject(id);
  const thumb = opts.thumb ?? old?.thumb;
  const rec: ProjectRec = {
    id,
    name: p.name,
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
    data,
    summary: docSummary(p),
    ...(thumb ? { thumb } : {}),
  };
  await idbPut("projects", rec);
  return rec;
}

export async function setThumb(id: string, thumb: string) {
  const rec = await getProject(id);
  if (rec) await idbPut("projects", { ...rec, thumb });
}

export async function renameProject(id: string, name: string) {
  const rec = await getProject(id);
  if (!rec) return;
  const p = parseProject(rec.data);
  if (p) {
    p.name = name;
    // 부품이 하나뿐이면 부품 이름도 (표제란에 쓰임)
    if (p.parts.length === 1) p.parts[0].name = name;
  }
  await idbPut("projects", { ...rec, name, data: p ? JSON.stringify(p) : rec.data });
}

export async function duplicateProject(id: string): Promise<string | null> {
  const rec = await getProject(id);
  if (!rec) return null;
  const p = parseProject(rec.data);
  if (!p) return null;
  p.name = `${p.name} (복사본)`;
  if (p.parts.length === 1) p.parts[0].name = p.name;
  const nid = newProjectId();
  await saveProject(nid, p, { thumb: rec.thumb });
  return nid;
}

export async function trashProject(id: string) {
  const rec = await getProject(id);
  if (rec) await idbPut("projects", { ...rec, deletedAt: Date.now() });
}

export async function restoreProject(id: string) {
  const rec = await getProject(id);
  if (rec) {
    const { deletedAt: _, ...rest } = rec;
    await idbPut("projects", rest);
  }
}

/** 영구 삭제 (버전 기록도 함께) */
export async function purgeProject(id: string) {
  for (const v of await listVersions(id)) await idbDelete("versions", v.id);
  await idbDelete("projects", id);
}

/** 휴지통에서 30일 지난 것 영구 삭제 + 아무도 안 쓰는 파일 정리 */
export async function cleanup(now = Date.now()) {
  for (const p of await idbAll<ProjectRec>("projects")) if (p.deletedAt && trashExpired(p.deletedAt, now)) await purgeProject(p.id);
  const keep = new Set<string>();
  for (const p of await idbAll<ProjectRec>("projects")) for (const k of keysOf(p.data)) keep.add(k);
  for (const v of await idbAll<VersionRec>("versions")) for (const k of keysOf(v.data)) keep.add(k);
  await gcFiles(keep);
}

const keysOf = (data: string) => {
  const p = parseProject(data);
  return p ? docFileKeys(p) : [];
};

// ---------------- 버전 ----------------

export async function listVersions(projectId: string): Promise<VersionRec[]> {
  const all = await idbByIndex<VersionRec>("versions", "byProject", projectId);
  return all.sort((a, b) => b.time - a.time);
}

export async function addVersion(projectId: string, x: DocLike, opts: { label?: string; auto: boolean; thumb?: string }, now = Date.now()) {
  const p = asDoc(x);
  const rec: VersionRec = {
    id: uid("v"),
    projectId,
    time: now,
    label: opts.label ?? (opts.auto ? "자동 저장" : "버전"),
    auto: opts.auto,
    data: JSON.stringify(p),
    summary: docSummary(p),
    ...(opts.thumb ? { thumb: opts.thumb } : {}),
  };
  await idbPut("versions", rec);
  for (const id of pruneAuto(await listVersions(projectId))) await idbDelete("versions", id);
  return rec;
}

export async function renameVersion(id: string, label: string) {
  const v = await idbGet<VersionRec>("versions", id);
  if (v) await idbPut("versions", { ...v, label, auto: false });
}

export const deleteVersion = (id: string) => idbDelete("versions", id);

// ---------------- 백업 ----------------
// 9단계부터 백업은 zip(.b3dbackup): backup.json(문서·버전 목록) + files/(3D 파일·이미지 원본, base64 아님).
// 7~8단계의 JSON 백업도 그대로 가져올 수 있다.

export interface Backup {
  format: "blueprint3d-backup";
  version: 1;
  exportedAt: number;
  projects: ProjectRec[];
  versions: VersionRec[];
  /** 파일: 문자열(data URL)이나 base64(이진) */
  files: Record<string, { text?: string; base64?: string }>;
}

/** 보관함 전체 (휴지통 제외)와 그 문서들이 쓰는 파일 원본 */
async function collect(): Promise<{ projects: ProjectRec[]; versions: VersionRec[]; files: Record<string, FileData> }> {
  const projects = (await idbAll<ProjectRec>("projects")).filter((p) => !p.deletedAt);
  const ids = new Set(projects.map((p) => p.id));
  const versions = (await idbAll<VersionRec>("versions")).filter((v) => ids.has(v.projectId));
  const keys = new Set<string>();
  for (const r of [...projects, ...versions]) for (const k of keysOf(r.data)) keys.add(k);
  const files: Record<string, FileData> = {};
  for (const k of keys) {
    const t = await getText(k);
    if (t) files[k] = t;
    else {
      const b = await getFile(k);
      if (b) files[k] = b;
    }
  }
  return { projects, versions, files };
}

/** 예전 형식(JSON, 파일은 base64) — 시험·호환용 */
export async function exportAll(): Promise<Backup> {
  const { projects, versions, files } = await collect();
  const out: Backup["files"] = {};
  for (const [k, f] of Object.entries(files)) out[k] = typeof f === "string" ? { text: f } : { base64: toBase64(f) };
  return { format: "blueprint3d-backup", version: 1, exportedAt: Date.now(), projects, versions, files: out };
}

/** 전체 백업 zip */
export async function exportAllZip(): Promise<{ bytes: Uint8Array; projects: number; versions: number }> {
  const { projects, versions, files } = await collect();
  const bytes = writeBackupZip({ format: "blueprint3d-backup", version: 2, exportedAt: Date.now(), projects, versions }, files);
  return { bytes, projects: projects.length, versions: versions.length };
}

/** 백업 파일(zip 또는 예전 JSON) 가져오기 */
export async function importBackupBytes(bytes: Uint8Array): Promise<{ projects: number; versions: number }> {
  if (isZip(bytes)) {
    const { meta, files } = readBackupZip(bytes);
    const b = meta as Partial<Backup>;
    if (!b || b.format !== "blueprint3d-backup" || !Array.isArray(b.projects)) throw new Error("도면3D 백업 파일이 아닙니다.");
    return importRecords(b.projects, b.versions ?? [], files);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("도면3D 백업 파일이 아닙니다.");
  }
  return importAll(raw);
}

/** 예전 JSON 백업 가져오기 */
export async function importAll(raw: unknown): Promise<{ projects: number; versions: number }> {
  const b = raw as Backup;
  if (!b || b.format !== "blueprint3d-backup" || !Array.isArray(b.projects)) throw new Error("도면3D 백업 파일이 아닙니다.");
  const files: Record<string, FileData> = {};
  for (const [k, f] of Object.entries(b.files ?? {})) {
    if (f.text) files[k] = f.text;
    else if (f.base64) files[k] = fromBase64(f.base64);
  }
  return importRecords(b.projects, b.versions ?? [], files);
}

/** 같은 id가 이미 있고 내용이 같으면 건너뛰고, 다르면 새 id로 복사 */
async function importRecords(projects: ProjectRec[], versions: VersionRec[], files: Record<string, FileData>) {
  for (const [k, f] of Object.entries(files)) await putFile(k, f);
  const idMap = new Map<string, string>();
  let np = 0;
  for (const p of projects) {
    if (!parseProject(p.data)) continue;
    const old = await getProject(p.id);
    if (old && old.updatedAt >= p.updatedAt && old.data === p.data) {
      idMap.set(p.id, p.id);
      continue;
    }
    const id = old ? newProjectId() : p.id;
    idMap.set(p.id, id);
    await idbPut("projects", { ...p, id, name: old ? `${p.name} (백업)` : p.name });
    np++;
  }
  let nv = 0;
  for (const v of versions) {
    const pid = idMap.get(v.projectId);
    if (!pid || (await idbGet("versions", v.id))) continue;
    await idbPut("versions", { ...v, projectId: pid });
    nv++;
  }
  return { projects: np, versions: nv };
}
