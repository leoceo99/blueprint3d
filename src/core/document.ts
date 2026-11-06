/**
 * 문서 모델 2.0 (9단계): 한 문서 = 여러 부품 + 여러 도면 (+ 13단계부터 장면).
 *  - 부품(Part): 지금까지의 "프로젝트" 내용(3면도 스케치·변수·가져온 3D 파일)에 고유 id
 *  - 도면(Drawing): 어느 부품을 그릴지(부품 id)와 용지·척도·표제란
 *  - 장면(Scene): 메쉬 객체를 담을 자리 (13단계). 지금은 비어 있음
 *  - view: 지금 열린 부품·도면 (모델이 아닌 화면 상태 — 파일에서는 view.json으로 따로)
 * 이름은 겹쳐도 되고, 참조는 id로 한다 (Blender의 ID·Onshape의 탭 참조처럼).
 * 예전 프로젝트 JSON(부품 1개)은 부품 1개 + 도면 1장 문서로 자동 변환된다.
 */
import { normalizeProject } from "./project";
import { emptyProject, type Project, type SheetInfo } from "./types";
import { diffSummary, fileKeys, summarize } from "./versions";

export type Part = Project & { id: string };

export interface Drawing {
  id: string;
  name: string;
  /** 그릴 부품 */
  partId: string;
  /** 용지·척도·표제란 */
  sheet?: SheetInfo;
}

/** 13단계(메쉬 편집)부터 쓰는 장면 — 지금은 자리만 */
export interface Scene {
  id: string;
  name: string;
  objects: unknown[];
}

export interface DocView {
  /** 지금 편집하는 부품 */
  part: string;
  /** 도면 출력에서 보고 있는 도면 */
  drawing?: string;
}

export interface Doc {
  format: "blueprint3d";
  version: 2;
  name: string;
  parts: Part[];
  drawings: Drawing[];
  scenes: Scene[];
  view: DocView;
}

export const DOC_FORMAT = "blueprint3d";
export const DOC_VERSION = 2;

let seq = 0;
export const newItemId = (prefix: string) => `${prefix}${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cleanSheet(v: unknown): SheetInfo | undefined {
  if (!obj(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string" && x !== "")) as SheetInfo;
  return Object.keys(out).length ? out : undefined;
}

/** 예전 프로젝트(부품 하나) → 문서. id는 정해진 값이라 같은 프로젝트는 같은 문서가 된다 */
export function docFromProject(p: Project, opts: { partId?: string; drawingId?: string } = {}): Doc {
  const partId = opts.partId ?? "part1";
  const drawingId = opts.drawingId ?? "drawing1";
  const { sheet, ...rest } = structuredClone(p);
  const s = cleanSheet(sheet);
  return {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    name: p.name,
    parts: [{ ...(rest as Project), id: partId }],
    drawings: [{ id: drawingId, name: "도면 1", partId, ...(s ? { sheet: s } : {}) }],
    scenes: [],
    view: { part: partId, drawing: drawingId },
  };
}

export const emptyDoc = (name = "새 부품") => {
  const p = emptyProject();
  p.name = name;
  return docFromProject(p);
};

/** 저장된 문서(또는 예전 프로젝트)를 검사해서 쓸 수 있게. 쓸 수 없으면 null */
export function normalizeDoc(raw: unknown): Doc | null {
  if (!obj(raw)) return null;
  if (!Array.isArray(raw.parts)) {
    // 예전 프로젝트 형식
    const p = normalizeProject(raw);
    return p ? docFromProject(p) : null;
  }
  const ids = new Set<string>();
  const uniq = (id: unknown, prefix: string) => {
    let s = typeof id === "string" && id ? id : newItemId(prefix);
    while (ids.has(s)) s = newItemId(prefix);
    ids.add(s);
    return s;
  };
  const parts: Part[] = [];
  const legacySheets = new Map<string, SheetInfo>();
  for (const r of raw.parts) {
    const p = normalizeProject(r);
    if (!p) continue;
    const id = uniq((r as Record<string, unknown>).id, "part");
    const { sheet, ...rest } = p;
    const s = cleanSheet(sheet);
    if (s) legacySheets.set(id, s);
    parts.push({ ...(rest as Project), id });
  }
  if (!parts.length) return null;
  const partIds = new Set(parts.map((p) => p.id));
  const drawings: Drawing[] = [];
  for (const d of Array.isArray(raw.drawings) ? raw.drawings : []) {
    if (!obj(d) || typeof d.partId !== "string" || !partIds.has(d.partId)) continue;
    const s = cleanSheet(d.sheet);
    drawings.push({ id: uniq(d.id, "drawing"), name: typeof d.name === "string" && d.name.trim() ? d.name : "도면", partId: d.partId, ...(s ? { sheet: s } : {}) });
  }
  // 부품 안에 남아 있던 도면 설정은 그 부품의 도면으로
  for (const [pid, s] of legacySheets) {
    const d = drawings.find((x) => x.partId === pid);
    if (d) d.sheet ??= s;
    else drawings.push({ id: uniq(undefined, "drawing"), name: "도면", partId: pid, sheet: s });
  }
  const scenes: Scene[] = (Array.isArray(raw.scenes) ? raw.scenes : [])
    .filter(obj)
    .map((sc) => ({ id: uniq(sc.id, "scene"), name: typeof sc.name === "string" ? sc.name : "장면", objects: Array.isArray(sc.objects) ? sc.objects : [] }));
  const v = obj(raw.view) ? raw.view : {};
  const doc: Doc = {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : parts[0].name,
    parts,
    drawings,
    scenes,
    view: { part: typeof v.part === "string" ? v.part : parts[0].id, ...(typeof v.drawing === "string" ? { drawing: v.drawing } : {}) },
  };
  fixView(doc);
  return doc;
}

/** 열린 부품·도면이 없어졌으면 바로잡는다 (실행 취소·삭제 뒤). 다른 부품의 도면을 보고 있는 것은 그대로 둔다 */
export function fixView(doc: Doc) {
  if (!doc.parts.some((p) => p.id === doc.view.part)) doc.view.part = doc.parts[0].id;
  if (!doc.drawings.some((x) => x.id === doc.view.drawing)) {
    const mine = doc.drawings.find((x) => x.partId === doc.view.part) ?? doc.drawings[0];
    if (mine) doc.view.drawing = mine.id;
    else delete doc.view.drawing;
  }
}

export const activePart = (doc: Doc): Part => doc.parts.find((p) => p.id === doc.view.part) ?? doc.parts[0];
export const activeDrawing = (doc: Doc): Drawing | undefined => doc.drawings.find((d) => d.id === doc.view.drawing);
export const drawingsOf = (doc: Doc, partId: string) => doc.drawings.filter((d) => d.partId === partId);
export const partOf = (doc: Doc, id: string) => doc.parts.find((p) => p.id === id);

/** 겹치지 않는 이름: "부품 2", "부품 3" … */
function freshName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

/** 열린 부품 바꾸기. 보고 있던 도면이 다른 부품 것이면 그 부품의 도면으로 */
export function setActivePart(doc: Doc, id: string) {
  if (!partOf(doc, id)) return;
  doc.view.part = id;
  const d = activeDrawing(doc);
  if (!d || d.partId !== id) {
    const mine = drawingsOf(doc, id)[0];
    if (mine) doc.view.drawing = mine.id;
  }
}

export function setActiveDrawing(doc: Doc, id: string) {
  const d = doc.drawings.find((x) => x.id === id);
  if (d) doc.view.drawing = id;
}

/** 부품 추가 (도면 한 장도 함께). 새 부품이 열린다 */
export function addPart(doc: Doc, from?: Project): Part {
  const p = from ? structuredClone(from) : emptyProject();
  const { sheet, ...rest } = p;
  const id = newItemId("part");
  // 이름 없이 추가하면 순서대로: 두 번째 부품은 "부품 2"
  const name = from ? p.name : freshName(`부품 ${doc.parts.length + 1}`, doc.parts.map((x) => x.name));
  const part: Part = { ...(rest as Project), name, id };
  doc.parts.push(part);
  const s = cleanSheet(sheet);
  addDrawing(doc, id, s);
  setActivePart(doc, id);
  return part;
}

export function duplicatePart(doc: Doc, id: string): Part | null {
  const src = partOf(doc, id);
  if (!src) return null;
  const { id: _, ...rest } = structuredClone(src);
  const sheet = drawingsOf(doc, id)[0]?.sheet;
  const part = addPart(doc, { ...(rest as Project), name: freshName(`${src.name} 복사본`, doc.parts.map((x) => x.name)) });
  const d = drawingsOf(doc, part.id)[0];
  if (d && sheet) d.sheet = structuredClone(sheet);
  return part;
}

/** 부품 지우기 (그 부품의 도면도). 마지막 부품은 지울 수 없다 */
export function removePart(doc: Doc, id: string): boolean {
  const i = doc.parts.findIndex((p) => p.id === id);
  if (doc.parts.length <= 1 || i < 0) return false;
  doc.parts = doc.parts.filter((p) => p.id !== id);
  doc.drawings = doc.drawings.filter((d) => d.partId !== id);
  // 지운 것이 열린 부품이면 바로 앞(없으면 다음) 부품을 연다
  if (doc.view.part === id) setActivePart(doc, doc.parts[Math.max(0, i - 1)].id);
  fixView(doc);
  return true;
}

export function renamePart(doc: Doc, id: string, name: string) {
  const p = partOf(doc, id);
  if (p && name.trim()) p.name = name.trim();
}

export function addDrawing(doc: Doc, partId: string, sheet?: SheetInfo): Drawing {
  const n = doc.drawings.length + 1;
  const d: Drawing = { id: newItemId("drawing"), name: freshName(`도면 ${n}`, doc.drawings.map((x) => x.name)), partId, ...(sheet ? { sheet: structuredClone(sheet) } : {}) };
  doc.drawings.push(d);
  doc.view.drawing = d.id;
  return d;
}

export function removeDrawing(doc: Doc, id: string): boolean {
  if (!doc.drawings.some((d) => d.id === id)) return false;
  doc.drawings = doc.drawings.filter((d) => d.id !== id);
  if (doc.view.drawing === id) delete doc.view.drawing;
  fixView(doc);
  return true;
}

// ---------------- 요약·비교·파일 ----------------

/** 문서가 참조하는 큰 파일(가져온 3D, 밑그림) 키 */
export const docFileKeys = (doc: Doc): string[] => [...new Set(doc.parts.flatMap(fileKeys))];

/** 한 줄 요약. 부품이 하나면 예전처럼 그 부품 요약 */
export function docSummary(doc: Doc): string {
  if (doc.parts.length === 1) {
    const s = summarize(doc.parts[0]);
    return doc.drawings.length > 1 ? `${s} · 도면 ${doc.drawings.length}` : s;
  }
  const shapes = doc.parts.reduce((n, p) => n + Object.values(p.views).reduce((m, l) => m + l.length, 0), 0);
  return `부품 ${doc.parts.length} · 도면 ${doc.drawings.length} · 도형 ${shapes}`;
}

/** 예전(a) → 지금(b) 사이에 바뀐 것 */
export function docDiff(a: Doc, b: Doc): string {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`이름 ‘${a.name}’ → ‘${b.name}’`);
  const ap = new Map(a.parts.map((p) => [p.id, p]));
  const bp = new Map(b.parts.map((p) => [p.id, p]));
  const added = b.parts.filter((p) => !ap.has(p.id));
  const removed = a.parts.filter((p) => !bp.has(p.id));
  if (added.length) out.push(`부품 추가: ${added.map((p) => p.name).join(", ")}`);
  if (removed.length) out.push(`부품 삭제: ${removed.map((p) => p.name).join(", ")}`);
  const multi = a.parts.length > 1 || b.parts.length > 1;
  for (const p of b.parts) {
    const old = ap.get(p.id);
    if (!old) continue;
    // 이름 바뀜은 문서 이름과 같이 움직이는 한 부품 문서에서는 따로 말하지 않는다
    const d = diffSummary({ ...old, name: multi ? old.name : p.name, sheet: undefined }, { ...p, sheet: undefined });
    if (d !== "바뀐 것 없음") out.push(multi ? `${p.name}: ${d}` : d);
  }
  const ad = new Map(a.drawings.map((d) => [d.id, JSON.stringify(d)]));
  const bd = new Map(b.drawings.map((d) => [d.id, JSON.stringify(d)]));
  let dc = 0;
  for (const [id, s] of bd) if (ad.get(id) !== s) dc++;
  for (const id of ad.keys()) if (!bd.has(id)) dc++;
  if (dc) out.push(`도면 ${dc}장 바뀜`);
  return out.length ? out.join(", ") : "바뀐 것 없음";
}

/** 3D 모양을 정하는 것만 모은 열쇠 — 같으면 3D를 다시 만들 필요가 없다 (이름·표제란·제조 방식은 빠짐) */
export function geometryKey(p: Project): string {
  return JSON.stringify([p.views, p.mode, p.thickness, p.thicknessExpr ?? null, p.params ?? null, p.source ?? null]);
}
