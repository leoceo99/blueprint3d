/// <reference lib="webworker" />
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC, type Shape3D } from "replicad";
import { BuildError, projectAll, projectOnPlane, projectView } from "./core/build";
import { buildAllPart, buildPart, clearBuildCache, FeatureBuildError, newBuildCache, type BuildCache } from "./core/featureBuild";
import { orientShape, readStep, readStl, stepResult, stlResult } from "./core/importModel";
import { meshToSTL, rotateQuarter, type Mesh } from "./core/mesh";
import type { ModelSource, Project } from "./core/types";

export type WorkerRequest =
  /** keep: false면 결과만 돌려주고 내보내기용 모델은 그대로 둔다 (다른 부품의 도면 등) */
  | { id: number; type: "build"; project: Project; keep?: boolean; proj?: boolean }
  /** 지금 모델의 3면도 투영 (투영 없이 만든 뒤 2D 설계·도면에서 필요할 때 — 13.8) */
  | { id: number; type: "projections" }
  /** 도면의 추가 뷰 (14단계): useCurrent면 지금 모델, 아니면 project를 만들어서 */
  | { id: number; type: "views"; project: Project; useCurrent: boolean; specs: import("./core/sheetViews").ViewRequest[] }
  /** 가져온 3D 파일로 결과 만들기. data는 이 워커가 그 key를 처음 볼 때만 보낸다 */
  | { id: number; type: "import"; source: ModelSource; data?: ArrayBuffer; keep?: boolean }
  | { id: number; type: "export"; format: "stl" | "step" }
  /** 지금 모델을 스케치 평면에 비춘 모습 (13단계 스케치 밑그림) */
  | { id: number; type: "projectPlane"; n: [number, number, number]; x: [number, number, number] };

export type WorkerResponse =
  | { id: number; ok: true; type: "build"; result: import("./core/types").BuildResult }
  | { id: number; ok: true; type: "export"; data: ArrayBuffer }
  | { id: number; ok: true; type: "projectPlane"; view: import("./core/types").ProjectedView | null }
  | { id: number; ok: true; type: "projections"; projections: import("./core/types").BuildResult["projections"] | null }
  | { id: number; ok: true; type: "views"; views: Record<string, { view: import("./core/types").ProjectedView; hatch?: [number, number][][] }> }
  | { id: number; ok: false; error: string; userError: boolean; needData?: boolean; featureLog?: import("./core/featureModel").FeatureStatus[] };

const ready = (async () => {
  const oc = await (opencascade as any)({ locateFile: () => wasmUrl });
  setOC(oc);
})();

/** 부품마다 앞 피처 결과 기억 (13.8) — 최근 4개 부품만 */
const caches = new Map<string, BuildCache>();
function cacheFor(id: string): BuildCache {
  let c = caches.get(id);
  if (c) {
    caches.delete(id);
    caches.set(id, c);
    return c;
  }
  c = newBuildCache();
  caches.set(id, c);
  while (caches.size > 4) {
    const [old, oc] = caches.entries().next().value as [string, BuildCache];
    clearBuildCache(oc);
    caches.delete(old);
  }
  return c;
}

/** 지금 화면에 있는 모델 (내보내기용) */
let current: Shape3D | null = null;
let currentMesh: Mesh | null = null;
/** 가져온 파일 원본 (돌리기 전). 다시 읽지 않도록 key별로 하나만 둔다 */
let loaded: { key: string; shape?: Shape3D; mesh?: Mesh } | null = null;

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    await ready;
    if (msg.type === "build") {
      const pid = (msg.project as { id?: string }).id ?? "_";
      const { shape, result } = buildAllPart(msg.project, { proj: msg.proj, cache: msg.project.features?.length ? cacheFor(pid) : undefined });
      if (msg.keep === false) shape?.delete?.();
      else setCurrent(shape, null);
      post({ id: msg.id, ok: true, type: "build", result });
    } else if (msg.type === "import") {
      const src = msg.source;
      if (!loaded || loaded.key !== src.key) {
        if (!msg.data) {
          post({ id: msg.id, ok: false, error: "need data", userError: false, needData: true });
          return;
        }
        loaded?.shape?.delete?.();
        loaded = src.kind === "step" ? { key: src.key, shape: await readStep(msg.data) } : { key: src.key, mesh: readStl(msg.data) };
      }
      if (loaded.shape) {
        const shape = orientShape(loaded.shape, src.turns);
        const result = stepResult(shape, src);
        if (msg.keep === false) shape?.delete?.();
        else setCurrent(shape, null);
        post({ id: msg.id, ok: true, type: "build", result });
      } else {
        const mesh = rotateQuarter(loaded.mesh!, src.turns);
        const result = stlResult(mesh, src);
        if (msg.keep !== false) setCurrent(null, mesh);
        post({ id: msg.id, ok: true, type: "build", result });
      }
    } else if (msg.type === "views") {
      let shape: Shape3D | null = null;
      let own = false;
      if (msg.useCurrent && current) shape = current;
      else if (!msg.project.source) {
        const pid = (msg.project as { id?: string }).id ?? "_";
        shape = buildPart(msg.project, msg.project.features?.length ? cacheFor(pid) : undefined).shape;
        own = true;
      }
      const views: Record<string, { view: import("./core/types").ProjectedView; hatch?: [number, number][][] }> = {};
      if (shape)
        for (const r of msg.specs) {
          try {
            views[r.id] = projectView(shape, r);
          } catch {
            /* 그 뷰만 빼고 */
          }
        }
      if (own) shape?.delete?.();
      post({ id: msg.id, ok: true, type: "views", views });
    } else if (msg.type === "projections") {
      post({ id: msg.id, ok: true, type: "projections", projections: current ? projectAll(current) : null });
    } else if (msg.type === "projectPlane") {
      post({ id: msg.id, ok: true, type: "projectPlane", view: current ? projectOnPlane(current, msg.n, msg.x) : null });
    } else {
      let data: ArrayBuffer;
      if (currentMesh) {
        if (msg.format === "step") throw new BuildError("STL에서 가져온 모델은 면 정보가 없어서 STEP으로 저장할 수 없습니다. STL로 저장하세요.");
        data = meshToSTL(currentMesh);
      } else {
        if (!current) throw new BuildError("먼저 3D 모델을 만들어 주세요.");
        const blob = msg.format === "stl" ? current.blobSTL({ binary: true }) : current.blobSTEP();
        data = await blob.arrayBuffer();
      }
      (self as any).postMessage({ id: msg.id, ok: true, type: "export", data }, [data]);
    }
  } catch (e: any) {
    const userError = e instanceof BuildError;
    let error = userError ? e.message : String(e?.message ?? e);
    if (!userError && msg.type === "import") error = `3D 파일을 읽을 수 없습니다. (${error})`;
    else if (!userError) error = "형상을 만들 수 없습니다. 선이 서로 꼬였거나 뷰끼리 맞지 않는지 확인하세요. (" + error + ")";
    post({ id: msg.id, ok: false, error, userError: userError || msg.type === "import", ...(e instanceof FeatureBuildError ? { featureLog: e.log } : {}) });
  }
};

function setCurrent(shape: Shape3D | null, mesh: Mesh | null) {
  if (current && current !== shape) current.delete?.();
  current = shape;
  currentMesh = mesh;
}

function post(r: WorkerResponse) {
  (self as any).postMessage(r);
}
