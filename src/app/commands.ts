/**
 * 명령 시스템: 앱의 모든 동작을 "명령"(이름·설명·단축키·쓸 수 있는 조건·실행)으로 등록한다.
 * 메뉴·리본 버튼·단축키·명령 찾기(Ctrl+K)가 모두 같은 명령을 부른다.
 * 앞으로 플러그인·대화형 설계도 이 길로만 문서를 바꾸게 한다.
 * (화면과 무관 — 버튼 연결은 commandUI.ts)
 */
import { search } from "../core/fuzzy";
import { isPlainKey, keyOf, normalizeCombo, type KeyLike } from "../core/keys";

export interface Command {
  /** 예: "edit.undo" */
  id: string;
  title: string;
  /** 분류 (명령 찾기에 표시): 파일, 편집, 그리기, 보기 … */
  category: string;
  /** 찾기용 다른 이름 (영어 포함) */
  keywords?: string[];
  /** 기본 단축키 (예: "Ctrl+Shift+Z") */
  keys?: string[];
  /** 지금 이 명령이 의미 있는 곳인지 (예: 2D 설계 화면). 아니면 단축키가 동작하지 않고 찾기에서 뒤로 */
  when?: () => boolean;
  /** 지금 실행할 수 있는지 (예: 선택한 도형이 있어야) */
  enabled?: () => boolean;
  /** 켜고 끄는 명령의 지금 상태 */
  checked?: () => boolean;
  run: () => unknown;
  /** 글을 입력하는 중에도 단축키가 동작 (Ctrl+S 같은) */
  global?: boolean;
  /** 명령 찾기 목록에서 숨김 */
  hidden?: boolean;
  /** 이 명령이 속한 작업 공간 (작업 공간 모듈이 붙임) — 다른 작업 공간의 같은 단축키는 겹침이 아님 */
  scope?: string;
}

export class CommandRegistry {
  private cmds = new Map<string, Command>();
  private overrides: Record<string, string[]> = {};
  private listeners = new Set<() => void>();
  /** 실행할 때마다 (최근 목록, 실행 취소 이름 등) */
  onRun: ((c: Command) => void) | null = null;

  register(list: Command | Command[]): () => void {
    const arr = Array.isArray(list) ? list : [list];
    for (const c of arr) this.cmds.set(c.id, c);
    this.emit();
    return () => {
      for (const c of arr) if (this.cmds.get(c.id) === c) this.cmds.delete(c.id);
      this.emit();
    };
  }

  unregister(id: string) {
    if (this.cmds.delete(id)) this.emit();
  }

  get(id: string) {
    return this.cmds.get(id);
  }

  list(): Command[] {
    return [...this.cmds.values()];
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** 사용자가 바꾼 단축키 (설정에서) */
  setOverrides(o: Record<string, string[]>) {
    this.overrides = { ...o };
    this.emit();
  }

  defaultKeys(id: string): string[] {
    return (this.cmds.get(id)?.keys ?? []).map((k) => normalizeCombo(k)).filter((k): k is string => !!k);
  }

  /** 지금 쓰이는 단축키 (바꾼 것이 있으면 그것) */
  keysOf(id: string): string[] {
    return this.overrides[id] ?? this.defaultKeys(id);
  }

  isCustom(id: string) {
    return id in this.overrides;
  }

  available(c: Command) {
    return !c.when || c.when();
  }
  enabled(c: Command) {
    return this.available(c) && (!c.enabled || c.enabled());
  }

  /** 실행. 없거나 지금 쓸 수 없으면 false */
  run(id: string): boolean {
    const c = this.cmds.get(id);
    if (!c || !this.enabled(c)) return false;
    this.onRun?.(c);
    void c.run();
    return true;
  }

  /**
   * 키 입력에 맞는 명령. typing이면 글자 입력 중 — 글자 키는 무시하고 global 명령만.
   * 조건(when)이 있는 명령을 먼저 본다 (더 구체적인 곳에서 쓰는 것).
   */
  match(e: KeyLike | string, typing = false): Command | null {
    const combo = typeof e === "string" ? normalizeCombo(e) : keyOf(e);
    if (!combo) return null;
    if (typing && isPlainKey(combo)) return null;
    const hits = this.list().filter((c) => this.keysOf(c.id).includes(combo) && (!typing || c.global) && this.available(c));
    if (!hits.length) return null;
    hits.sort((a, b) => Number(!!b.when) - Number(!!a.when));
    return hits.find((c) => this.enabled(c)) ?? hits[0];
  }

  /** 같은 단축키를 쓰는 다른 명령들 (서로 다른 작업 공간에서만 쓰는 명령은 동시에 쓰이지 않으므로 빼고) */
  conflicts(combo: string, exceptId?: string): Command[] {
    const n = normalizeCombo(combo);
    if (!n) return [];
    const scope = exceptId ? this.cmds.get(exceptId)?.scope : undefined;
    return this.list().filter((c) => c.id !== exceptId && this.keysOf(c.id).includes(n) && !(scope && c.scope && c.scope !== scope));
  }

  /** 명령 찾기: 빈 칸이면 최근 쓴 것 → 나머지. 지금 쓸 수 없는 것은 뒤로 */
  search(query: string, recent: string[] = []): Command[] {
    const visible = this.list().filter((c) => !c.hidden);
    const rank = (c: Command) => {
      const r = recent.indexOf(c.id);
      return (r >= 0 ? 12 - Math.min(10, r) : 0) - (this.available(c) ? 0 : 40) - (this.enabled(c) ? 0 : 5);
    };
    if (!query.trim()) {
      return visible
        .map((c, i) => ({ c, i, s: rank(c) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map((x) => x.c);
    }
    return search(visible, query, (c) => [c.title, ...(c.keywords ?? []), c.category, c.id], rank);
  }
}
