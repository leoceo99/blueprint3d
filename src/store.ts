import { applyExpressions } from "./core/params";
import { normalizeProject } from "./core/project";
import { emptyProject, type Project, type Shape2D, type ViewId } from "./core/types";

const KEY = "blueprint3d.project.v1";

type Listener = () => void;

/** 프로젝트 상태 + 실행 취소/다시 실행 + 자동 저장 */
class Store {
  project: Project = load() ?? emptyProject();
  /** 바뀔 때마다 1씩 증가 (화면 갱신 판단용) */
  version = 0;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 변경 직전에 호출해서 실행 취소 지점을 남긴다. */
  checkpoint() {
    this.undoStack.push(JSON.stringify(this.project));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  /** 변화가 없었으면 마지막 실행 취소 지점을 버린다. */
  dropCheckpoint() {
    this.undoStack.pop();
  }

  /** 마지막 실행 취소 지점으로 되돌리고, 다시 실행 기록은 남기지 않는다. */
  revert() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.project = JSON.parse(s);
    this.changed();
  }

  /** 변경 후 호출: 저장하고 화면들에 알린다. */
  changed() {
    // 변수·식에 묶인 치수를 다시 계산 (묶인 치수는 끌어도 원래 값으로 돌아감 = 잠금)
    applyExpressions(this.project);
    this.version++;
    save(this.project);
    this.listeners.forEach((l) => l());
  }

  update(fn: (p: Project) => void) {
    this.checkpoint();
    fn(this.project);
    this.changed();
  }

  replace(p: Project) {
    this.checkpoint();
    this.project = structuredClone(p);
    this.changed();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(s);
    this.changed();
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(s);
    this.changed();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  shapes(view: ViewId): Shape2D[] {
    return this.project.views[view];
  }
}

function load(): Project | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return normalizeProject(JSON.parse(raw));
  } catch {
    return null;
  }
}

function save(p: Project) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 저장소를 쓸 수 없는 환경이면 무시 */
  }
}

export const store = new Store();

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
