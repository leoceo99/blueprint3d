/**
 * 지금 열린 프로젝트와 보관함(IndexedDB)을 이어 주는 곳.
 *  - 시작할 때: 브라우저에 남은 작업을 보관함에 맞춰 넣는다 (예전 자동 저장도 프로젝트 하나로 옮김)
 *  - 고칠 때마다: 0.8초 모아서 보관함에 저장, 10분이 지났으면 자동 버전도 하나
 *  - 다른 프로젝트 열기 / 새 프로젝트로 열기 / 썸네일
 * 보관함 쓰기는 모두 한 줄로 세워(순서대로) 실행해서 서로 덮어쓰지 않게 한다.
 */
import { SAMPLES } from "./core/samples";
import type { Project } from "./core/types";
import { shouldAutoSnapshot } from "./core/versions";
import { addVersion, cleanup, getProject, listProjects, listVersions, newProjectId, parseProject, saveProject, setThumb } from "./library";
import { store } from "./store";

export interface SessionHooks {
  /** 다른 프로젝트로 바뀐 뒤 (선택 해제·화면 맞추기 등) */
  onSwitched: () => void;
  /** 보관함에 저장됨 */
  onSaved: () => void;
  /** 저장 상태 표시 */
  onState: (s: "saving" | "saved" | "error") => void;
  onError: (e: unknown) => void;
}

export class Session {
  private timer = 0;
  private dirty = false;
  private quiet = false;
  private lastAuto: number | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /** 처음 켰을 때 (브라우저에 남은 작업이 없어서 예제로 시작) */
  private fresh = false;
  /** 지금 프로젝트의 썸네일 (버전에도 함께 남김) */
  thumb: string | undefined;
  readonly ready: Promise<void>;

  constructor(private hooks: SessionHooks) {
    if (!store.projectId) {
      store.projectId = newProjectId();
      if (!store.restored) {
        store.project = structuredClone(SAMPLES[0]);
        this.fresh = true;
      }
      store.saveNow();
    }
    store.subscribe(() => {
      if (!this.quiet) this.touch();
    });
    // 창을 닫거나 다른 앱으로 갈 때 바로 저장 (닫힐 때 다 못 써도 브라우저 저장본에서 다음에 이어 감)
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void this.flush());
    window.addEventListener("pagehide", () => void this.flush());
    this.ready = this.init();
  }

  get id() {
    return store.projectId;
  }

  private async init() {
    try {
      if (this.fresh) {
        // 브라우저 저장본만 지워지고 보관함은 남은 경우: 가장 최근 프로젝트를 연다
        const recent = (await listProjects()).find((p) => !p.deletedAt && parseProject(p.data));
        if (recent) {
          await this.open(recent.id);
          return;
        }
      }
      const rec = await getProject(this.id);
      // 브라우저 저장본이 늘 가장 새것 (고칠 때마다 바로 쓰므로)
      if (!rec || rec.deletedAt || rec.data !== JSON.stringify(store.project)) await this.enqueue(() => saveProject(this.id, store.project));
      this.lastAuto = await lastAutoTime(this.id);
      await cleanup();
    } catch (e) {
      this.fail(e);
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private touch() {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 800);
  }

  /** 기다리는 변경을 보관함에 쓴다 */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.dirty) {
      this.dirty = false;
      const id = this.id;
      const snap = structuredClone(store.project);
      const thumb = this.thumb;
      this.hooks.onState("saving");
      void this.enqueue(async () => {
        await saveProject(id, snap, { thumb });
        const now = Date.now();
        if (shouldAutoSnapshot(this.lastAuto, now)) {
          await addVersion(id, snap, { auto: true, thumb }, now);
          this.lastAuto = now;
        }
      }).then(
        () => {
          this.hooks.onState("saved");
          this.hooks.onSaved();
        },
        (e) => this.fail(e),
      );
    }
    await this.chain;
  }

  private fail(e: unknown) {
    this.hooks.onState("error");
    this.hooks.onError(e);
  }

  /** 큰 변화 직전에 지금 상태를 자동 버전으로 남긴다 */
  async snapshot(label: string) {
    await this.flush();
    const snap = structuredClone(store.project);
    await this.enqueue(() => addVersion(this.id, snap, { auto: true, label, thumb: this.thumb }));
  }

  /** 보관함의 다른 프로젝트 열기 */
  async open(id: string) {
    await this.flush();
    const rec = await getProject(id);
    const p = rec ? parseProject(rec.data) : null;
    if (!rec || !p) throw new Error("프로젝트를 열 수 없습니다.");
    this.load(id, p, rec.thumb);
    this.lastAuto = await lastAutoTime(id);
  }

  /** 다른 탭에서 저장한 내용을 다시 불러오기 */
  async reload() {
    const rec = await getProject(this.id);
    const p = rec ? parseProject(rec.data) : null;
    if (p) this.load(this.id, p, rec?.thumb);
  }

  /** 새 프로젝트로 열기 (새 부품, 예제, 파일 열기, 가져오기). 지금 프로젝트는 보관함에 그대로 남는다 */
  async openAsNew(p: Project) {
    await this.flush();
    const id = newProjectId();
    this.load(id, p);
    this.lastAuto = undefined;
    const snap = structuredClone(store.project);
    await this.enqueue(() => saveProject(id, snap));
  }

  private load(id: string, p: Project, thumb?: string) {
    this.quiet = true;
    try {
      store.projectId = id;
      store.reset(p);
    } finally {
      this.quiet = false;
    }
    this.dirty = false;
    this.thumb = thumb;
    this.hooks.onSwitched();
  }

  /** 3D가 새로 만들어질 때마다 썸네일 바꾸기 */
  setThumbnail(dataUrl: string) {
    this.thumb = dataUrl;
    const id = this.id;
    void this.enqueue(() => setThumb(id, dataUrl)).catch(() => {});
  }
}

async function lastAutoTime(id: string): Promise<number | undefined> {
  return (await listVersions(id)).find((v) => v.auto)?.time;
}
