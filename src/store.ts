import { applyExpressions } from "./core/params";
import { normalizeProject } from "./core/project";
import { History } from "./core/history";
import { emptyProject, type Project, type Shape2D, type ViewId } from "./core/types";

const KEY = "blueprint3d.project.v1";

type Listener = () => void;

const restored = load();

/** 프로젝트 상태 + 실행 취소/다시 실행(바뀐 곳만 기록) + 자동 저장 */
class Store {
  project: Project = restored?.project ?? emptyProject();
  /** 보관함(IndexedDB)에서 이 프로젝트의 id. 빈 문자열이면 아직 정해지지 않음 */
  projectId = restored?.id ?? "";
  /** 시작할 때 브라우저에 저장된 작업이 있었는지 */
  readonly restored = !!restored;
  /** 바뀔 때마다 1씩 증가 (화면 갱신 판단용) */
  version = 0;
  readonly history = new History<Project>({ maxEntries: 500, maxBytes: 8_000_000 });
  private listeners = new Set<Listener>();
  /** 실행 취소·다시 실행이 될 때 (이름 알림용) */
  onUndoRedo: ((kind: "undo" | "redo", label: string) => void) | null = null;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 변경 직전에 호출해서 실행 취소 지점을 남긴다. 이름은 기록 창에 보인다 */
  checkpoint(label = "편집") {
    this.history.begin(this.project, label);
  }

  /** 변화가 없었으면 마지막 실행 취소 지점을 버린다. */
  dropCheckpoint() {
    this.history.cancel();
  }

  /** 끌기 등이 끝났을 때: 지금까지 바뀐 것을 기록 한 칸으로 */
  commit() {
    this.history.commit(this.project);
  }

  /** 마지막 실행 취소 지점으로 되돌리고, 다시 실행 기록은 남기지 않는다. */
  revert() {
    this.project = this.history.revert(this.project);
    this.changed();
  }

  /** 변경 후 호출: 저장하고 화면들에 알린다. */
  changed() {
    // 변수·식에 묶인 치수를 다시 계산 (묶인 치수는 끌어도 원래 값으로 돌아감 = 잠금)
    applyExpressions(this.project);
    this.version++;
    save(this.project, this.projectId);
    this.listeners.forEach((l) => l());
  }

  update(fn: (p: Project) => void, label = "편집") {
    this.checkpoint(label);
    fn(this.project);
    applyExpressions(this.project);
    this.commit();
    this.changed();
  }

  replace(p: Project, label = "바꾸기") {
    this.checkpoint(label);
    this.project = structuredClone(p);
    applyExpressions(this.project);
    this.commit();
    this.changed();
  }

  /** 다른 프로젝트로 바꾸기: 실행 취소 기록도 새로 시작 */
  reset(p: Project) {
    this.history.clear();
    this.project = structuredClone(p);
    this.changed();
  }

  undo() {
    const r = this.history.undo(this.project);
    if (!r) return;
    this.project = r.state;
    this.changed();
    this.onUndoRedo?.("undo", r.label);
  }

  redo() {
    const r = this.history.redo(this.project);
    if (!r) return;
    this.project = r.state;
    this.changed();
    this.onUndoRedo?.("redo", r.label);
  }

  /** 기록의 pos번째 상태로 한 번에 (0 = 처음) */
  goto(pos: number) {
    this.project = this.history.goto(this.project, pos);
    this.changed();
  }

  get canUndo() {
    return this.history.canUndo;
  }
  get canRedo() {
    return this.history.canRedo;
  }

  /** 지금 상태를 브라우저(localStorage)에 바로 저장 */
  saveNow() {
    save(this.project, this.projectId);
  }

  shapes(view: ViewId): Shape2D[] {
    return this.project.views[view];
  }
}

/** 마지막으로 고친 프로젝트 (모든 탭이 같은 곳에 쓰므로 어느 프로젝트인지 _id로 함께 적는다) */
function load(): { project: Project; id: string } | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    const project = normalizeProject(j);
    if (!project) return null;
    delete (project as Project & { _id?: string })._id;
    return { project, id: typeof j?._id === "string" ? j._id : "" };
  } catch {
    return null;
  }
}

/** 자동 저장 실패를 알릴 곳 (저장 공간 부족 등) */
export let onSaveError: ((e: unknown) => void) | null = null;
export function setSaveErrorHandler(fn: (e: unknown) => void) {
  onSaveError = fn;
}

function save(p: Project, id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(id ? { ...p, _id: id } : p));
  } catch (e) {
    // 보관함(IndexedDB)에는 따로 저장되므로 작업이 사라지지는 않는다
    onSaveError?.(e);
  }
}

export const store = new Store();

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
