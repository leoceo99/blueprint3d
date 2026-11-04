/// <reference lib="webworker" />
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC, type Shape3D } from "replicad";
import { buildAll, BuildError } from "./core/build";
import type { Project } from "./core/types";

export type WorkerRequest =
  | { id: number; type: "build"; project: Project }
  | { id: number; type: "export"; format: "stl" | "step" };

export type WorkerResponse =
  | { id: number; ok: true; type: "build"; result: import("./core/types").BuildResult }
  | { id: number; ok: true; type: "export"; data: ArrayBuffer }
  | { id: number; ok: false; error: string; userError: boolean };

const ready = (async () => {
  const oc = await (opencascade as any)({ locateFile: () => wasmUrl });
  setOC(oc);
})();

let current: Shape3D | null = null;

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    await ready;
    if (msg.type === "build") {
      const { shape, result } = buildAll(msg.project);
      current?.delete?.();
      current = shape;
      post({ id: msg.id, ok: true, type: "build", result });
    } else {
      if (!current) throw new BuildError("먼저 3D 모델을 만들어 주세요.");
      const blob = msg.format === "stl" ? current.blobSTL({ binary: true }) : current.blobSTEP();
      const data = await blob.arrayBuffer();
      (self as any).postMessage({ id: msg.id, ok: true, type: "export", data }, [data]);
    }
  } catch (e: any) {
    const userError = e instanceof BuildError;
    let error = userError ? e.message : String(e?.message ?? e);
    if (!userError) error = "형상을 만들 수 없습니다. 선이 서로 꼬였거나 뷰끼리 맞지 않는지 확인하세요. (" + error + ")";
    post({ id: msg.id, ok: false, error, userError });
  }
};

function post(r: WorkerResponse) {
  (self as any).postMessage(r);
}
