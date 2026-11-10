/**
 * 피처 만들기·고치기 (13단계): 오른쪽 패널에서 값을 바꾸면 바로 3D가 다시 계산되고(미리 보기),
 * “확인”이면 실행 취소 한 칸으로 남고 “취소”면 처음대로. (Onshape 피처 대화 상자처럼)
 */
import { newItemId } from "../core/document";
import { evalExpr, plainNumber } from "../core/expr";
import {
  FEATURE_LABEL,
  FEATURE_VALUES,
  nextFeatureName,
  setFeatureValue,
  sketchOf,
  type Feature,
  type FeatureKind,
  type PlaneRef,
  type SketchFeature,
} from "../core/featureModel";
import { specDiameter } from "../core/standards";
import { evalSite, evaluateParams, paramLookup, projUnit } from "../core/params";
import type { Project } from "../core/types";
import { fromDisplay } from "../core/units";
import { store } from "../store";
import { ui } from "../ui/state";
import { emit, invalidatePanels, requestRender } from "./context";
import { toast } from "./notify";
import { enterSketch } from "./sketchMode";

/** 지금 고치는 피처, 평면 고르기 중인지 */
export const fedit = {
  id: null as string | null,
  isNew: false,
  /** 새 스케치: 평면 고르는 중 */
  plane: false,
  /** 피처 목록에서 고른 피처 */
  sel: null as string | null,
  /** 고르는 피처(필렛·쉘…)를 고치는 동안 결과 미리 보기 (끄면 그 피처 앞까지 보여 주고 고르기) */
  preview: false,
};

export const currentFeature = (): Feature | undefined => (fedit.id ? store.project.features?.find((f) => f.id === fedit.id) : undefined);

/** 새 피처가 들어갈 자리 (되감기 막대가 있으면 그 자리) */
export const insertIndex = (p: Project) => p.rollback ?? p.features?.length ?? 0;

/** idx 앞에 있는 스케치들 */
export function sketchesBefore(p: Project, idx = insertIndex(p)): SketchFeature[] {
  return (p.features ?? []).slice(0, idx).filter((f): f is SketchFeature => f.kind === "sketch");
}

/** 몸체를 만드는 피처 (패턴·대칭의 원본이 될 수 있는 것) */
export const BODY_KINDS: FeatureKind[] = ["extrude", "revolve", "hole", "sweep", "loft", "pattern", "mirror"];

function defaults(kind: FeatureKind, p: Project, idx: number): Feature | string {
  const id = newItemId("f");
  const name = nextFeatureName(p, kind);
  const sks = sketchesBefore(p, idx);
  const last = sks[sks.length - 1];
  const needSketch = "먼저 스케치를 그려 주세요 (스케치 → 평면 고르기)";
  switch (kind) {
    case "extrude": {
      if (!last) return needSketch;
      // 몸체 도형 없이 구멍 표시만 있으면 빼기
      const allHoles = last.shapes.length > 0 && last.shapes.every((s) => s.hole || s.construction);
      return { id, name, kind, sketch: last.id, op: allHoles ? "cut" : "add", extent: allHoles ? "through" : "dist", dist: 10, ...(allHoles && last.plane.kind === "face" ? { flip: true } : {}) };
    }
    case "revolve":
      if (!last) return needSketch;
      return { id, name, kind, sketch: last.id, op: "add", axis: "v", angle: 360 };
    case "fillet":
      return { id, name, kind, edges: [], r: 2 };
    case "chamfer":
      return { id, name, kind, edges: [], d: 1 };
    case "shell":
      return { id, name, kind, faces: [], t: 2 };
    case "draft":
      return { id, name, kind, faces: [], angle: 3, neutral: "XY" };
    case "pattern": {
      const src = (p.features ?? []).slice(0, idx).filter((f) => BODY_KINDS.includes(f.kind)).pop();
      return { id, name, kind, mode: "linear", of: src ? [src.id] : [], axis: "X", count: 3, spacing: 20, angle: 360 };
    }
    case "mirror":
      return { id, name, kind, of: [], plane: "YZ" };
    case "hole": {
      if (!last) return needSketch;
      const spec = structuredClone(ui.hole.spec);
      return { id, name, kind, sketch: last.id, spec, d: specDiameter(spec) ?? ui.hole.d, depth: null };
    }
    case "sweep":
      if (!last) return "먼저 경로 스케치를 그려 주세요 (선 도구 ⇧L)";
      return { id, name, kind, path: last.id, profile: { kind: "circle", d: 10 }, op: "add" };
    case "loft":
      if (sks.length < 2) return "단면 스케치가 두 개 이상 있어야 해요 (서로 다른 평면에)";
      return { id, name, kind, sketches: sks.slice(-2).map((s) => s.id), op: "add" };
    case "sketch":
      return "평면을 먼저 고르세요";
  }
}

function insert(p: Project, f: Feature) {
  const list = (p.features ??= []);
  const idx = insertIndex(p);
  list.splice(idx, 0, f);
  if (p.rollback !== undefined) p.rollback++;
}

/** 열려 있던 편집을 확인으로 닫는다 */
export function finishEdit() {
  if (!fedit.id) return;
  if (store.history.isPending) store.commit();
  fedit.id = null;
  fedit.isNew = false;
  fedit.preview = false;
  emit("featureEdit", null);
  invalidatePanels();
}

/** 열려 있던 편집을 취소 (새로 만든 것이면 없어짐) */
export function cancelEdit() {
  if (!fedit.id) return;
  if (store.history.isPending) store.revert();
  fedit.id = null;
  fedit.isNew = false;
  fedit.preview = false;
  emit("featureEdit", null);
  invalidatePanels();
}

/** 새 스케치: 평면 고르기 시작 (기본 평면 단추, 또는 3D에서 평평한 면) */
export function startPlanePick() {
  finishEdit();
  fedit.plane = true;
  emit("featureEdit", null);
  invalidatePanels();
}

export function stopPlanePick() {
  if (!fedit.plane) return;
  fedit.plane = false;
  emit("featureEdit", null);
  invalidatePanels();
}

/** 그 평면에 새 스케치를 만들고 바로 그리기로 */
export function createSketch(plane: PlaneRef) {
  fedit.plane = false;
  finishEdit();
  const id = newItemId("f");
  store.update((p) => insert(p, { id, name: nextFeatureName(p, "sketch"), kind: "sketch", plane, shapes: [] }), "스케치 만들기");
  fedit.sel = id;
  enterSketch(id);
}

/** 새 피처 (스케치는 평면 고르기부터) */
export function newFeature(kind: FeatureKind): boolean {
  if (kind === "sketch") {
    startPlanePick();
    return true;
  }
  finishEdit();
  fedit.plane = false;
  const p = store.project;
  const f = defaults(kind, p, insertIndex(p));
  if (typeof f === "string") {
    toast(f);
    return false;
  }
  store.checkpoint(`${FEATURE_LABEL[kind]} 만들기`);
  insert(store.project, f);
  fedit.id = f.id;
  fedit.isNew = true;
  fedit.sel = f.id;
  store.changed();
  emit("featureEdit", f.id);
  invalidatePanels();
  return true;
}

/** 피처 고치기 (스케치는 스케치 편집으로) */
export function editFeature(id: string) {
  const f = store.project.features?.find((x) => x.id === id);
  if (!f) return;
  fedit.sel = id;
  if (f.kind === "sketch") {
    finishEdit();
    enterSketch(id);
    return;
  }
  if (fedit.id === id) return;
  finishEdit();
  fedit.plane = false;
  store.checkpoint(`${f.name} 고치기`);
  fedit.id = id;
  fedit.isNew = false;
  emit("featureEdit", id);
  invalidatePanels();
}

/** 고치는 중인 피처를 바꾸고 바로 다시 계산 (확인 전까지 실행 취소 한 칸) */
export function changeFeature(fn: (f: Feature) => void) {
  const f = currentFeature();
  if (!f) return;
  if (!store.history.isPending) store.checkpoint(`${f.name} 고치기`);
  fn(f);
  store.changed();
  requestRender();
}

/**
 * 숫자 칸: 숫자(표시 단위) 또는 식(L/2). 오류면 설명을 돌려준다.
 * 길이는 문서 단위 → mm, 각도는 도, 개수는 정수
 */
export function setFeatureInput(f: Feature, key: string, text: string): string | null {
  const spec = FEATURE_VALUES[f.kind]?.[key];
  if (!spec) return "알 수 없는 값";
  const t = text.trim();
  if (!t) return "값을 넣어 주세요";
  const n = plainNumber(t);
  const p = store.project;
  let v: number;
  if (n !== null) {
    v = spec.site === "len" ? fromDisplay(n) : n;
    if (f.exprs) {
      delete f.exprs[key];
      if (!Object.keys(f.exprs).length) delete f.exprs;
    }
  } else {
    try {
      const pr = evaluateParams(p);
      v = spec.site === "count" ? evalExpr(t, paramLookup(pr), projUnit(p), "none").value : evalSite(p, t, spec.site, pr);
    } catch (e) {
      return (e as Error).message;
    }
    f.exprs = { ...(f.exprs ?? {}), [key]: t };
  }
  if (!Number.isFinite(v)) return "숫자가 아니에요";
  if (spec.min !== undefined && v < spec.min) return spec.site === "count" ? "1 이상이어야 해요" : "0보다 커야 해요";
  setFeatureValue(f, key, v);
  return null;
}

/** 피처 지우기 (이 피처를 쓰는 피처가 있으면 함께 오류가 남는다는 것을 알림) */
export function deleteFeature(id: string) {
  const p = store.project;
  const f = p.features?.find((x) => x.id === id);
  if (!f) return;
  if (fedit.id === id) cancelEdit();
  if (!store.project.features?.some((x) => x.id === id)) return;
  store.update((q) => {
    const list = q.features ?? [];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    if (q.rollback !== undefined && i < q.rollback) q.rollback--;
    if (q.rollback !== undefined && q.rollback >= list.length) delete q.rollback;
    if (!list.length) delete q.features;
  }, `${f.name} 지우기`);
  if (fedit.sel === id) fedit.sel = null;
  const users = (store.project.features ?? []).filter((x) => JSON.stringify(x).includes(`"${id}"`));
  if (users.length) toast(`‘${f.name}’을(를) 쓰던 ${users.map((x) => x.name).join(", ")}에 오류가 생겨요 — Ctrl+Z로 되돌릴 수 있어요`);
}

export function toggleSuppress(id: string) {
  const f = store.project.features?.find((x) => x.id === id);
  if (!f) return;
  finishEdit();
  store.update((q) => {
    const g = q.features?.find((x) => x.id === id);
    if (!g) return;
    if (g.suppressed) delete g.suppressed;
    else g.suppressed = true;
  }, f.suppressed ? `${f.name} 켜기` : `${f.name} 끄기`);
}

export function renameFeature(id: string, name: string) {
  const n = name.trim();
  const f = store.project.features?.find((x) => x.id === id);
  if (!f || !n || n === f.name) return;
  store.update((q) => {
    const g = q.features?.find((x) => x.id === id);
    if (g) g.name = n;
  }, "피처 이름 바꾸기");
}

/** 실행 취소 등으로 고치던 피처가 없어지면 닫기 */
export function syncEditState() {
  if (fedit.id && !store.project.features?.some((f) => f.id === fedit.id)) {
    fedit.id = null;
    fedit.isNew = false;
  }
  if (fedit.sel && !store.project.features?.some((f) => f.id === fedit.sel)) fedit.sel = null;
  if (ui.sketch && !sketchOf(store.project, ui.sketch)) ui.sketch = null;
}
