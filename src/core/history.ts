/**
 * 실행 취소 기록 2.0: 상태 전체를 통째로 복사하지 않고 "바뀐 곳"만 남긴다.
 *  - begin(state, 이름): 바꾸기 직전 상태를 잠깐 들고 있다가
 *  - commit(state): 바뀐 곳(경로, 이전 값, 새 값)만 계산해서 기록 한 칸으로 남긴다
 *  - 끌기처럼 여러 번 바뀌어도 begin~commit 사이는 한 칸
 *  - 기록 전체 크기(바이트)와 칸 수에 한도가 있어 큰 문서에서도 메모리가 일정하다
 */
export type Key = string | number;
export interface Op {
  path: Key[];
  /** undefined = 그 칸이 없었음 */
  before: unknown;
  after: unknown;
}
export interface Entry {
  label: string;
  time: number;
  ops: Op[];
  /** 대략의 크기 (JSON 글자 수) */
  size: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** a → b로 가는 바뀐 곳 목록 (객체는 칸별로, 길이가 같은 배열은 칸별로, 나머지는 통째로) */
export function diff(a: unknown, b: unknown, path: Key[] = [], out: Op[] = []): Op[] {
  if (a === b) return out;
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const av = a[k];
      const bv = b[k];
      if (av === undefined && bv === undefined) continue;
      if (av === undefined || bv === undefined) out.push({ path: [...path, k], before: clone(av), after: clone(bv) });
      else diff(av, bv, [...path, k], out);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], [...path, i], out);
    return out;
  }
  if (deepEqual(a, b)) return out;
  out.push({ path, before: clone(a), after: clone(b) });
  return out;
}

/** 바뀐 곳을 상태에 적용 (dir: "after"면 다시 실행, "before"면 실행 취소). 뿌리를 통째로 바꿀 때는 새 값을 돌려준다 */
export function applyOps<T>(state: T, ops: Op[], dir: "before" | "after"): T {
  let root: unknown = state;
  const list = dir === "before" ? [...ops].reverse() : ops;
  for (const op of list) {
    const v = clone(op[dir]);
    if (!op.path.length) {
      root = v;
      continue;
    }
    let cur = root as Record<Key, unknown>;
    for (let i = 0; i < op.path.length - 1; i++) cur = cur[op.path[i]] as Record<Key, unknown>;
    const last = op.path[op.path.length - 1];
    if (v === undefined && !Array.isArray(cur)) delete cur[last];
    else cur[last] = v;
  }
  return root as T;
}

export interface HistoryOptions {
  maxEntries?: number;
  /** 기록 전체 크기 한도 (JSON 글자 수) */
  maxBytes?: number;
}

export class History<T extends object> {
  private undoList: Entry[] = [];
  private redoList: Entry[] = [];
  private pending: { before: T; label: string; time: number } | null = null;
  readonly maxEntries: number;
  readonly maxBytes: number;

  constructor(opts: HistoryOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 500;
    this.maxBytes = opts.maxBytes ?? 8_000_000;
  }

  /** 바꾸기 직전: 앞의 것을 마무리하고 지금 상태를 잡아 둔다 */
  begin(state: T, label = "편집", now = Date.now()) {
    this.commit(state);
    this.pending = { before: structuredClone(state), label, time: now };
  }

  /** 바뀐 것이 없었다 (예: 눌렀지만 끌지 않음) */
  cancel() {
    this.pending = null;
  }

  get isPending() {
    return !!this.pending;
  }

  /** begin 이후 바뀐 것을 기록 한 칸으로. 바뀐 게 없으면 남기지 않는다 */
  commit(state: T): boolean {
    const p = this.pending;
    if (!p) return false;
    this.pending = null;
    const ops = diff(p.before, state);
    if (!ops.length) return false;
    const size = JSON.stringify(ops).length;
    this.undoList.push({ label: p.label, time: p.time, ops, size });
    this.redoList = [];
    this.trim();
    return true;
  }

  /** begin 직전 상태로 되돌린다 (기록은 남기지 않음). 진행 중인 것이 없으면 마지막 칸을 버리며 되돌림 */
  revert(state: T): T {
    if (this.pending) {
      const before = this.pending.before;
      this.pending = null;
      return before;
    }
    const e = this.undoList.pop();
    return e ? applyOps(state, e.ops, "before") : state;
  }

  undo(state: T): { state: T; label: string } | null {
    this.commit(state);
    const e = this.undoList.pop();
    if (!e) return null;
    this.redoList.push(e);
    return { state: applyOps(state, e.ops, "before"), label: e.label };
  }

  redo(state: T): { state: T; label: string } | null {
    this.commit(state);
    const e = this.redoList.pop();
    if (!e) return null;
    this.undoList.push(e);
    return { state: applyOps(state, e.ops, "after"), label: e.label };
  }

  /** 기록의 pos번째 상태로 (0 = 처음, entries.length = 마지막) */
  goto(state: T, pos: number): T {
    this.commit(state);
    let s = state;
    while (this.undoList.length > pos) s = this.undo(s)!.state;
    while (this.undoList.length < pos && this.redoList.length) s = this.redo(s)!.state;
    return s;
  }

  clear() {
    this.undoList = [];
    this.redoList = [];
    this.pending = null;
  }

  get canUndo() {
    return this.undoList.length > 0 || !!this.pending;
  }
  get canRedo() {
    return this.redoList.length > 0;
  }
  /** 지금 위치 (= 실행 취소할 수 있는 칸 수) */
  get position() {
    return this.undoList.length;
  }
  /** 처음부터 끝까지 (다시 실행할 수 있는 칸 포함) */
  get entries(): Entry[] {
    return [...this.undoList, ...[...this.redoList].reverse()];
  }
  get bytes() {
    return [...this.undoList, ...this.redoList].reduce((n, e) => n + e.size, 0);
  }

  private trim() {
    let total = this.bytes;
    while (this.undoList.length > 1 && (this.undoList.length > this.maxEntries || total > this.maxBytes)) {
      total -= this.undoList.shift()!.size;
    }
  }
}
