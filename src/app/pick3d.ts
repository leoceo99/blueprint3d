/**
 * 3D 화면 고르기 연결 (13단계): 지금 하는 일에 따라 무엇을 고를지 정하고, 고른 것을 피처에 넣는다.
 *  - 새 스케치 평면 고르기 → 평평한 면을 누르면 그 면 위에 스케치
 *  - 필렛·모따기 → 모서리 (면을 누르면 그 면의 모서리 전부), 다시 누르면 빼기
 *  - 쉘·구배 → 면
 * 이런 피처를 고치는 동안에는 그 피처 바로 앞까지만 계산해서 보여 준다 (고를 모서리가 남아 있게).
 * “결과 미리 보기”를 켜면 피처까지 계산한 결과를 보여 주고 고르기는 쉰다.
 */
import { frameOf, toWorld, type EdgeSig, type FaceSig, type Feature } from "../core/featureModel";
import { flatten } from "../core/geometry2d";
import { edgeScore, faceScore, matchEdges, matchFaces, modelSize } from "../core/refMatch";
import type { Part } from "../core/document";
import { store } from "../store";
import type { PickHit, PickMode } from "../ui/viewer";
import { setBuildTransform, scheduleBuildIfChanged } from "./build";
import { app, on, requestRender } from "./context";
import { changeFeature, createSketch, currentFeature, fedit } from "./featureEdit";

const EDGE_KINDS = new Set<Feature["kind"]>(["fillet", "chamfer"]);
const FACE_KINDS = new Set<Feature["kind"]>(["shell", "draft"]);
export const isPickFeature = (f: Feature | undefined) => !!f && (EDGE_KINDS.has(f.kind) || FACE_KINDS.has(f.kind));

/** 지금 고르는 것 */
export function pickModeNow(): PickMode {
  if (app.workspace !== "3d") return "none";
  if (fedit.plane) return "plane";
  const f = currentFeature();
  if (!f || fedit.preview) return "none";
  if (EDGE_KINDS.has(f.kind)) return "faceEdge";
  if (FACE_KINDS.has(f.kind)) return "face";
  return "none";
}

const sizeNow = () => modelSize(app.lastBuild?.bbox as never);

/** 같은 것(거의 같은 지문)이 이미 있으면 그 번호 */
const findEdge = (list: EdgeSig[], sig: EdgeSig) => list.findIndex((x) => edgeScore(x, sig, sizeNow()) < 0.02);
const findFace = (list: FaceSig[], sig: FaceSig) => list.findIndex((x) => faceScore(x, sig, sizeNow()) < 0.02);

function onPick(hit: PickHit) {
  const topo = app.lastBuild?.topo;
  if (!topo) return;
  if (fedit.plane) {
    const sig = topo.faces[hit.index];
    if (hit.kind === "face" && sig?.t === "plane" && sig.n) createSketch({ kind: "face", face: sig, offset: 0 });
    return;
  }
  const f = currentFeature();
  if (!f) return;
  if (f.kind === "fillet" || f.kind === "chamfer") {
    const picked = hit.kind === "edge" ? [hit.index] : (topo.faceEdges?.[hit.index] ?? []);
    const sigs = picked.map((i) => topo.edges[i]).filter(Boolean);
    if (!sigs.length) return;
    changeFeature((g) => {
      const list = (g as typeof f).edges;
      const have = sigs.map((s) => findEdge(list, s));
      // 모두 이미 골랐으면 빼고, 아니면 없는 것만 더함
      if (have.every((k) => k >= 0)) (g as typeof f).edges = list.filter((_, k) => !have.includes(k));
      else sigs.forEach((s, j) => have[j] < 0 && list.push(s));
    });
  } else if (f.kind === "shell" || f.kind === "draft") {
    if (hit.kind !== "face") return;
    const sig = topo.faces[hit.index];
    if (!sig) return;
    changeFeature((g) => {
      const list = (g as typeof f).faces;
      const k = findFace(list, sig);
      if (k >= 0) list.splice(k, 1);
      else list.push(sig);
    });
  }
}

/** 스케치 선 (3D): 꺼진 것·되감기 아래·참조선은 빼고 */
function sketchLines(p: Part): number[] {
  const out: number[] = [];
  const limit = p.rollback ?? p.features?.length ?? 0;
  (p.features ?? []).forEach((f, i) => {
    if (f.kind !== "sketch" || f.suppressed || i >= limit) return;
    const fr = frameOf(f.plane);
    for (const s of f.shapes) {
      if (s.construction) continue;
      const pts = flatten(s, Math.PI / 24);
      const open = s.kind === "poly" && !!s.open;
      if (open) pts.push(s.pts[s.pts.length - 1]);
      const n = open ? pts.length - 1 : pts.length;
      for (let k = 0; k < n; k++) {
        const a = pts[k];
        const b = pts[(k + 1) % pts.length];
        out.push(...toWorld(fr, a[0], a[1]), ...toWorld(fr, b[0], b[1]));
      }
    }
  });
  return out;
}

/** 화면 상태 맞추기: 고르기 방식, 고른 것 강조, 스케치 선 */
export function syncPick() {
  const v = app.viewer;
  v.setPickMode(pickModeNow());
  const topo = app.lastBuild?.topo;
  const f = currentFeature();
  let faces: number[] = [];
  let edges: number[] = [];
  if (topo && f && !fedit.preview) {
    const L = sizeNow();
    if (f.kind === "fillet" || f.kind === "chamfer") edges = matchEdges(f.edges, topo.edges, L).filter((i) => i >= 0);
    if (f.kind === "shell" || f.kind === "draft") faces = matchFaces(f.faces, topo.faces, L).filter((i) => i >= 0);
  }
  v.setSelection(faces, edges);
  v.setOverlay(app.workspace === "3d" ? sketchLines(store.project) : null);
}

export function initPick3d() {
  app.viewer.onPick = (h) => onPick(h);
  app.viewer.isPlanar = (i) => app.lastBuild?.topo?.faces[i]?.t === "plane";
  // 고르는 피처를 고치는 동안에는 그 피처 앞까지만 계산 (미리 보기를 켜면 끝까지)
  setBuildTransform((p) => {
    const f = currentFeature();
    if (app.workspace !== "3d" || !isPickFeature(f) || fedit.preview) return p;
    const idx = (p.features ?? []).findIndex((x) => x.id === f!.id);
    return idx < 0 ? p : { ...p, rollback: Math.min(idx, p.rollback ?? Infinity) };
  });
  const sync = () => {
    syncPick();
    requestRender();
  };
  on("built", sync);
  on("featureEdit", () => {
    scheduleBuildIfChanged();
    sync();
  });
  on("workspace", () => {
    scheduleBuildIfChanged();
    sync();
  });
  store.subscribe(sync);
}
