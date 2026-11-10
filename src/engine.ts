import type { BuildResult, ModelSource, Project } from "./core/types";
import type { WorkerRequest, WorkerResponse } from "./worker";

/** 무거운 CAD 연산은 Web Worker에서 실행해 화면이 멈추지 않게 한다. */
class Engine {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private pending = new Map<number, (r: WorkerResponse) => void>();

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const cb = this.pending.get(ev.data.id);
      this.pending.delete(ev.data.id);
      cb?.(ev.data);
    };
  }

  private call(req: Omit<WorkerRequest, "id"> & { type: WorkerRequest["type"] }): Promise<WorkerResponse> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ ...req, id });
    });
  }

  /** keep: false면 내보내기용 모델(지금 편집 중인 부품)은 그대로 두고 결과만 */
  async build(project: Project, keep = true): Promise<BuildResult> {
    const r = await this.call({ type: "build", project, keep } as any);
    if (!r.ok) throw Object.assign(new Error(r.error), r.featureLog ? { featureLog: r.featureLog } : {});
    if (r.type !== "build") throw new Error("unexpected");
    return r.result;
  }

  /** 가져온 3D 파일로 결과 만들기. 워커가 처음 보는 파일이면 내용을 함께 보낸다 */
  async buildImported(source: ModelSource, load: () => Promise<ArrayBuffer | null>, keep = true): Promise<BuildResult> {
    let r = await this.call({ type: "import", source, keep } as any);
    if (!r.ok && r.needData) {
      const data = await load();
      if (!data) throw new Error("가져온 3D 파일을 이 브라우저에서 찾을 수 없습니다. 파일을 다시 가져오세요.");
      r = await this.call({ type: "import", source, data, keep } as any);
    }
    if (!r.ok) throw new Error(r.error);
    if (r.type !== "build") throw new Error("unexpected");
    return r.result;
  }

  async export(format: "stl" | "step"): Promise<ArrayBuffer> {
    const r = await this.call({ type: "export", format } as any);
    if (!r.ok) throw new Error(r.error);
    if (r.type !== "export") throw new Error("unexpected");
    return r.data;
  }
}

export const engine = new Engine();
