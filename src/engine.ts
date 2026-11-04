import type { BuildResult, Project } from "./core/types";
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

  async build(project: Project): Promise<BuildResult> {
    const r = await this.call({ type: "build", project } as any);
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
