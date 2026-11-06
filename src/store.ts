import { applyExpressions } from "./core/params";
import { activePart, docFromProject, fixView, normalizeDoc, setActiveDrawing, setActivePart, type Doc, type Part } from "./core/document";
import { History } from "./core/history";
import { emptyProject, type Project, type Shape2D, type ViewId } from "./core/types";

/** 열린 문서의 즉시 사본 (9단계부터 문서 형식) */
const KEY = "blueprint3d.doc.v2";
/** 8단계까지: 프로젝트(부품 하나) 형식 — 읽기만 하고 문서로 옮긴다 */
const KEY_V1 = "blueprint3d.project.v1";

type Listener = () => void;

const restored = load();

/**
 * 열린 문서 + 실행 취소/다시 실행(바뀐 곳만 기록) + 자동 저장.
 * 문서에는 부품이 여러 개 있을 수 있고, `project`는 지금 편집 중인 부품이다.
 */
class Store {
  doc: Doc = restored?.doc ?? docFromProject(emptyProject());
  /** 보관함(IndexedDB)에서 이 문서의 id. 빈 문자열이면 아직 정해지지 않음 */
  projectId = restored?.id ?? "";
  /** 시작할 때 브라우저에 저장된 작업이 있었는지 */
  readonly restored = !!restored;
  /** 바뀔 때마다 1씩 증가 (화면 갱신 판단용) */
  version = 0;
  readonly history = new History<Doc>({ maxEntries: 500, maxBytes: 8_000_000 });
  private listeners = new Set<Listener>();
  /** 실행 취소·다시 실행이 될 때 (이름 알림용) */
  onUndoRedo: ((kind: "undo" | "redo", label: string) => void) | null = null;

  /** 지금 편집 중인 부품 */
  get project(): Part {
    return activePart(this.doc);
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 변경 직전에 호출해서 실행 취소 지점을 남긴다. 이름은 기록 창에 보인다 */
  checkpoint(label = "편집") {
    this.history.begin(this.doc, label);
  }

  /** 변화가 없었으면 마지막 실행 취소 지점을 버린다. */
  dropCheckpoint() {
    this.history.cancel();
  }

  /** 끌기 등이 끝났을 때: 지금까지 바뀐 것을 기록 한 칸으로 */
  commit() {
    this.history.commit(this.doc);
  }

  /** 마지막 실행 취소 지점으로 되돌리고, 다시 실행 기록은 남기지 않는다. */
  revert() {
    this.doc = this.history.revert(this.doc);
    this.changed();
  }

  /** 변경 후 호출: 저장하고 화면들에 알린다. */
  changed() {
    fixView(this.doc);
    // 변수·식에 묶인 치수를 다시 계산 (묶인 치수는 끌어도 원래 값으로 돌아감 = 잠금)
    applyExpressions(this.project);
    this.version++;
    save(this.doc, this.projectId);
    this.listeners.forEach((l) => l());
  }

  /** 열린 부품 고치기 */
  update(fn: (p: Part) => void, label = "편집") {
    this.checkpoint(label);
    fn(this.project);
    applyExpressions(this.project);
    this.commit();
    this.changed();
  }

  /** 문서 고치기 (부품 추가·삭제, 도면 등) */
  updateDoc(fn: (d: Doc) => void, label = "편집") {
    this.checkpoint(label);
    fn(this.doc);
    fixView(this.doc);
    applyExpressions(this.project);
    this.commit();
    this.changed();
  }

  /** 문서 통째로 바꾸기 (버전 되돌리기) — 실행 취소 가능 */
  replace(d: Doc, label = "바꾸기") {
    this.checkpoint(label);
    this.doc = structuredClone(d);
    fixView(this.doc);
    applyExpressions(this.project);
    this.commit();
    this.changed();
  }

  /** 다른 문서로 바꾸기: 실행 취소 기록도 새로 시작 */
  reset(d: Doc) {
    this.history.clear();
    this.doc = structuredClone(d);
    this.changed();
  }

  /** 편집할 부품 바꾸기 (실행 취소 기록에는 남기지 않음) */
  openPart(id: string) {
    if (id === this.doc.view.part) return;
    this.commit();
    setActivePart(this.doc, id);
    this.changed();
  }

  /** 도면 출력에서 볼 도면 바꾸기 */
  openDrawing(id: string) {
    setActiveDrawing(this.doc, id);
    this.changed();
  }

  undo() {
    const r = this.history.undo(this.doc);
    if (!r) return;
    this.doc = r.state;
    this.changed();
    this.onUndoRedo?.("undo", r.label);
  }

  redo() {
    const r = this.history.redo(this.doc);
    if (!r) return;
    this.doc = r.state;
    this.changed();
    this.onUndoRedo?.("redo", r.label);
  }

  /** 기록의 pos번째 상태로 한 번에 (0 = 처음) */
  goto(pos: number) {
    this.doc = this.history.goto(this.doc, pos);
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
    save(this.doc, this.projectId);
  }

  shapes(view: ViewId): Shape2D[] {
    return this.project.views[view];
  }
}

/** 마지막으로 고친 문서 (모든 탭이 같은 곳에 쓰므로 어느 문서인지 _id로 함께 적는다) */
function load(): { doc: Doc; id: string } | null {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(KEY_V1);
    if (!raw) return null;
    const j = JSON.parse(raw);
    const doc = normalizeDoc(j);
    if (!doc) return null;
    return { doc, id: typeof j?._id === "string" ? j._id : "" };
  } catch {
    return null;
  }
}

/** 자동 저장 실패를 알릴 곳 (저장 공간 부족 등) */
export let onSaveError: ((e: unknown) => void) | null = null;
export function setSaveErrorHandler(fn: (e: unknown) => void) {
  onSaveError = fn;
}

let migrated = false;
function save(d: Doc, id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(id ? { ...d, _id: id } : d));
    if (!migrated) {
      localStorage.removeItem(KEY_V1);
      migrated = true;
    }
  } catch (e) {
    // 보관함(IndexedDB)에는 따로 저장되므로 작업이 사라지지는 않는다
    onSaveError?.(e);
  }
}

export const store = new Store();

/** 예전 프로젝트(부품 하나)도 받아서 문서로 */
export const asDoc = (x: Doc | Project): Doc => ("parts" in x && Array.isArray(x.parts) ? (x as Doc) : docFromProject(x as Project));

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
