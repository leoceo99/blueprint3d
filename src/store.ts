import { applyExpressions, evalSite, evaluateParams } from "./core/params";
import { getVar, KIND_LABEL, pruneConstraints, shapeVarKeys, solveView } from "./core/constraints";
import { activePart, docFromProject, fixView, normalizeDoc, setActiveDrawing, setActivePart, type Doc, type Part } from "./core/document";
import { History } from "./core/history";
import { emptyProject, type Project, type Shape2D } from "./core/types";
import { allSlots, slotCons, slotShapes, type SlotId } from "./core/featureModel";

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
  /** 구속을 지킬 수 없어 되돌렸을 때 (안내용) */
  onConstraintError: ((message: string, ids: string[]) => void) | null = null;
  /** 마지막으로 구속을 푼 뒤의 도형 값 — 다음 편집에서 “사용자가 바꾼 값”을 찾는 기준 */
  private baseline = new Map<string, number>();
  /** 기준을 잡을 때의 구속 목록 (구속을 더하거나 지우면 다시 풀어야 함) */
  private baseCons = "";
  /** 마지막 편집이 구속 때문에 되돌려졌는지 */
  rejected = false;

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
    this.snapBaseline();
    this.changed();
  }

  /** 변경 후 호출: 구속을 지키고, 저장하고, 화면들에 알린다. */
  changed() {
    fixView(this.doc);
    // 변수·식에 묶인 치수를 다시 계산 (묶인 치수는 끌어도 원래 값으로 돌아감 = 잠금)
    applyExpressions(this.project);
    // 끌기처럼 이어지는 편집: 풀 수 없으면 이번에 바꾼 값만 되돌린다 (도형이 더 안 움직임)
    if (!this.solveEdit()) this.restoreBaseline();
    this.version++;
    save(this.doc, this.projectId);
    this.listeners.forEach((l) => l());
  }

  /** 열린 부품 고치기. 구속을 지킬 수 없으면 되돌리고 false */
  update(fn: (p: Part) => void, label = "편집"): boolean {
    this.checkpoint(label);
    fn(this.project);
    return this.finishEdit();
  }

  /** 문서 고치기 (부품 추가·삭제, 도면 등) */
  updateDoc(fn: (d: Doc) => void, label = "편집"): boolean {
    this.checkpoint(label);
    fn(this.doc);
    fixView(this.doc);
    return this.finishEdit();
  }

  private finishEdit(): boolean {
    applyExpressions(this.project);
    if (!this.solveEdit()) {
      // 편집 전체를 되돌린다
      this.doc = this.history.revert(this.doc);
      this.snapBaseline();
      this.rejected = true;
      this.changed();
      return false;
    }
    this.rejected = false;
    this.commit();
    this.changed();
    return true;
  }

  // ---------------- 구속 (10단계) ----------------

  /** 구속이 있는 뷰의 도형 값 */
  private snapshotVars(): Map<string, number> {
    const m = new Map<string, number>();
    const p = this.project;
    for (const v of allSlots(p)) {
      if (!slotCons(p, v)?.length) continue;
      for (const sh of slotShapes(p, v)) for (const k of shapeVarKeys(sh)) m.set(`${v}|${sh.id}|${k}`, getVar(sh, k));
    }
    return m;
  }

  /** 지금 상태를 기준으로 (실행 취소·다른 부품·새 문서 뒤) */
  snapBaseline() {
    this.baseline = this.snapshotVars();
    this.baseCons = consKey(this.project);
  }

  /** 기준에서 바뀐 값은 고정하고 나머지를 풀어 구속을 지킨다. 풀 수 없으면 false (도형은 그대로) */
  private solveEdit(): boolean {
    const p = this.project;
    pruneConstraints(p);
    const slots = allSlots(p).filter((v) => slotCons(p, v)?.length);
    if (!slots.length) {
      this.baseline.clear();
      this.baseCons = consKey(p);
      return true;
    }
    const now = this.snapshotVars();
    const consNow = consKey(p);
    // 바뀐 값도, 구속도 그대로면 풀 필요 없음
    // (식으로 값을 정한 치수 구속은 변수가 바뀌면 값도 바뀌므로 늘 다시 푼다)
    let moved = consNow !== this.baseCons || slots.some((v) => slotCons(p, v)?.some((c) => c.expr));
    if (!moved) for (const [k, v] of now) if (this.baseline.get(k) !== v) {
      moved = true;
      break;
    }
    if (!moved) return true;
    const values = constraintValues(p);
    for (const v of slots) {
      const fixed = new Set<string>();
      for (const [key, val] of now) {
        if (!key.startsWith(`${v}|`)) continue;
        const old = this.baseline.get(key);
        if (old !== undefined && Math.abs(old - val) > 1e-9) fixed.add(key.slice(v.length + 1).replace("|", ":"));
      }
      const r = solveView(p, v, { fixed, values });
      if (!r.ok) {
        const names = r.conflicting.map((id) => slotCons(p, v)?.find((c) => c.id === id)).filter(Boolean).map((c) => KIND_LABEL[c!.kind]);
        this.onConstraintError?.(r.invalid ? `구속 조건을 지키면 ${r.invalid} — 되돌렸어요.` : `구속 조건과 맞지 않아 되돌렸어요${names.length ? ` (${[...new Set(names)].join(", ")})` : ""}.`, r.conflicting);
        return false;
      }
    }
    this.snapBaseline();
    return true;
  }

  /** 이번에 바뀐 도형 값만 기준으로 되돌린다 (끌기 중 풀 수 없을 때) */
  private restoreBaseline() {
    const p = this.project;
    for (const v of allSlots(p))
      for (const sh of slotShapes(p, v))
        for (const k of shapeVarKeys(sh)) {
          const old = this.baseline.get(`${v}|${sh.id}|${k}`);
          if (old !== undefined && Math.abs(old - getVar(sh, k)) > 1e-9) setShapeVar(sh, k, old);
        }
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
    this.snapBaseline();
    this.changed();
  }

  /** 편집할 부품 바꾸기 (실행 취소 기록에는 남기지 않음) */
  openPart(id: string) {
    if (id === this.doc.view.part) return;
    this.commit();
    setActivePart(this.doc, id);
    this.snapBaseline();
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
    this.snapBaseline();
    this.changed();
    this.onUndoRedo?.("undo", r.label);
  }

  redo() {
    const r = this.history.redo(this.doc);
    if (!r) return;
    this.doc = r.state;
    this.snapBaseline();
    this.changed();
    this.onUndoRedo?.("redo", r.label);
  }

  /** 기록의 pos번째 상태로 한 번에 (0 = 처음) */
  goto(pos: number) {
    this.doc = this.history.goto(this.doc, pos);
    this.snapBaseline();
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

  shapes(view: SlotId): Shape2D[] {
    return slotShapes(this.project, view);
  }
}

/** 구속 목록 전체 (3면도 + 스케치 피처) — 바뀌었는지 비교용 */
function consKey(p: Project): string {
  return JSON.stringify(allSlots(p).map((v) => slotCons(p, v) ?? null));
}

/** 치수 구속의 식 값 (변수 L 등) */
function constraintValues(p: Project): Map<string, number> | undefined {
  const all = allSlots(p).flatMap((v) => slotCons(p, v) ?? []).filter((c) => c.expr);
  if (!all.length) return undefined;
  const pr = evaluateParams(p);
  const out = new Map<string, number>();
  for (const c of all) {
    try {
      const v = evalSite(p, c.expr!, c.kind === "angle" ? "angle" : "len", pr);
      c.value = v;
      out.set(c.id, v);
    } catch {
      /* 식 오류 — 저장된 값 그대로 */
    }
  }
  return out;
}

function setShapeVar(s: Shape2D, key: string, v: number) {
  if (s.kind === "rect") (s as unknown as Record<string, number>)[key] = v;
  else if (s.kind === "circle") (s as unknown as Record<string, number>)[key] = v;
  else if (s.kind === "slot") {
    if (key === "w") s.w = v;
    else if (key[0] === "a") s.a = key === "ax" ? [v, s.a[1]] : [s.a[0], v];
    else s.b = key === "bx" ? [v, s.b[1]] : [s.b[0], v];
  } else {
    const i = Number(key.slice(1));
    const q = s.pts[i];
    s.pts[i] = key[0] === "x" ? [v, q[1]] : [q[0], v];
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
