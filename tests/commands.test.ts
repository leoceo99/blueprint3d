// 8단계: 단축키 조합, 한글 초성 검색, 명령 시스템, 설정, 실행 취소 기록 2.0
import { describe, expect, it } from "vitest";
import { formatCombo, isPlainKey, keyOf, normalizeCombo } from "../src/core/keys";
import { choseong, matchScore, search } from "../src/core/fuzzy";
import { CommandRegistry, type Command } from "../src/app/commands";
import { defaultSettings, normalizeSettings, pushRecent } from "../src/core/settings";
import { applyOps, diff, History } from "../src/core/history";
import { emptyProject, type Project } from "../src/core/types";

describe("단축키 조합", () => {
  it("키 입력 → 정식 글자 (한글 입력 상태에서도 자판 위치로)", () => {
    expect(keyOf({ key: "z", code: "KeyZ", ctrlKey: true })).toBe("Ctrl+Z");
    expect(keyOf({ key: "ㅋ", code: "KeyZ", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+Z");
    expect(keyOf({ key: "Process", code: "KeyR" })).toBe("R");
    expect(keyOf({ key: "z", code: "KeyZ", metaKey: true })).toBe("Ctrl+Z");
    expect(keyOf({ key: "!", code: "Digit1", shiftKey: true })).toBe("Shift+1");
    expect(keyOf({ key: "Delete", code: "Delete" })).toBe("Delete");
    expect(keyOf({ key: " ", code: "Space" })).toBe("Space");
    expect(keyOf({ key: ",", code: "Comma", ctrlKey: true })).toBe("Ctrl+,");
    expect(keyOf({ key: "Shift", code: "ShiftLeft", shiftKey: true })).toBeNull();
    expect(keyOf({ key: "F1", code: "F1" })).toBe("F1");
  });

  it("사람이 적은 조합 정리", () => {
    expect(normalizeCombo("shift+ctrl+z")).toBe("Ctrl+Shift+Z");
    expect(normalizeCombo("Cmd+K")).toBe("Ctrl+K");
    expect(normalizeCombo("del")).toBe("Delete");
    expect(normalizeCombo("esc")).toBe("Escape");
    expect(normalizeCombo("f2")).toBe("F2");
    expect(normalizeCombo("Ctrl+A+B")).toBeNull();
    expect(normalizeCombo("Ctrl+")).toBeNull();
    expect(normalizeCombo("")).toBeNull();
  });

  it("표시와 글자 키 구분", () => {
    expect(formatCombo("Ctrl+Shift+Z", "short")).toBe("⌃⇧Z");
    expect(formatCombo("Delete", "short")).toBe("Del");
    expect(formatCombo("Ctrl+Shift+O")).toBe("Ctrl+Shift+O");
    expect(isPlainKey("R")).toBe(true);
    expect(isPlainKey("Shift+R")).toBe(true);
    expect(isPlainKey("Ctrl+R")).toBe(false);
    expect(isPlainKey("F1")).toBe(false);
  });
});

describe("검색", () => {
  it("초성", () => {
    expect(choseong("사각형 그리기")).toBe("ㅅㄱㅎ ㄱㄹㄱ");
    expect(matchScore("ㅅㄱㅎ", "사각형")).toBeGreaterThan(0);
    expect(matchScore("ㄷㅁ", "도면 출력")).toBeGreaterThan(0);
    expect(matchScore("ㅎㅅㄱ", "사각형")).toBe(0);
  });
  it("앞부분 > 중간 > 건너뛰기, 띄어쓰기 무시", () => {
    expect(matchScore("실행", "실행 취소")).toBeGreaterThan(matchScore("취소", "실행 취소"));
    expect(matchScore("실행취소", "실행 취소")).toBe(100);
    expect(matchScore("cbr", "counterbore")).toBeGreaterThan(0);
    expect(matchScore("xyz", "counterbore")).toBe(0);
  });
  it("여러 칸 중 가장 잘 맞는 것", () => {
    const items = [
      { t: "실행 취소", k: ["undo"] },
      { t: "다시 실행", k: ["redo"] },
      { t: "삭제", k: ["delete", "remove"] },
    ];
    const r = search(items, "undo", (x) => [x.t, ...x.k]);
    expect(r[0].t).toBe("실행 취소");
    expect(search(items, "실행", (x) => [x.t]).map((x) => x.t)).toEqual(["실행 취소", "다시 실행"]);
  });
});

describe("명령 시스템", () => {
  function make() {
    const reg = new CommandRegistry();
    const log: string[] = [];
    let ws = "design";
    let sel = false;
    const cmd = (c: Partial<Command> & { id: string }): Command => ({ title: c.id, category: "테스트", run: () => log.push(c.id), ...c });
    reg.register([
      cmd({ id: "edit.undo", title: "실행 취소", keys: ["Ctrl+Z"], keywords: ["undo"] }),
      cmd({ id: "edit.delete", title: "삭제", keys: ["Delete", "Backspace"], enabled: () => sel }),
      cmd({ id: "tool.rect", title: "사각형", category: "그리기", keys: ["R"], when: () => ws === "design" }),
      cmd({ id: "file.save", title: "파일로 저장", keys: ["Ctrl+S"], global: true }),
      cmd({ id: "view.reset3d", title: "3D 시점 처음으로", keys: ["R"], when: () => ws === "3d" }),
      cmd({ id: "secret", title: "숨은 명령", hidden: true }),
    ]);
    return { reg, log, setWs: (w: string) => (ws = w), setSel: (v: boolean) => (sel = v) };
  }

  it("단축키 → 명령, 조건(when)과 입력 중 처리", () => {
    const { reg, setWs } = make();
    expect(reg.match({ key: "z", code: "KeyZ", ctrlKey: true })?.id).toBe("edit.undo");
    expect(reg.match("R")?.id).toBe("tool.rect");
    setWs("3d");
    expect(reg.match("R")?.id).toBe("view.reset3d");
    setWs("sheet");
    expect(reg.match("R")).toBeNull();
    // 글을 입력하는 중: 글자 키·일반 명령은 무시, global만
    expect(reg.match("Ctrl+Z", true)).toBeNull();
    expect(reg.match("Ctrl+S", true)?.id).toBe("file.save");
  });

  it("실행: 쓸 수 없으면 실행하지 않음", () => {
    const { reg, log, setSel } = make();
    expect(reg.run("edit.delete")).toBe(false);
    setSel(true);
    expect(reg.run("edit.delete")).toBe(true);
    expect(reg.run("nope")).toBe(false);
    expect(log).toEqual(["edit.delete"]);
  });

  it("단축키 바꾸기와 겹침 찾기", () => {
    const { reg } = make();
    expect(reg.keysOf("edit.delete")).toEqual(["Delete", "Backspace"]);
    reg.setOverrides({ "edit.undo": ["Ctrl+U"], "edit.delete": [] });
    expect(reg.match("Ctrl+Z")).toBeNull();
    expect(reg.match("Ctrl+U")?.id).toBe("edit.undo");
    expect(reg.keysOf("edit.delete")).toEqual([]);
    expect(reg.isCustom("edit.undo")).toBe(true);
    expect(reg.conflicts("r").map((c) => c.id).sort()).toEqual(["tool.rect", "view.reset3d"]);
    expect(reg.conflicts("Ctrl+S", "file.save")).toEqual([]);
  });

  it("찾기: 숨은 것 제외, 최근 쓴 것 먼저, 쓸 수 없는 것은 뒤로", () => {
    const { reg, setWs } = make();
    expect(reg.search("").some((c) => c.id === "secret")).toBe(false);
    expect(reg.search("", ["file.save"])[0].id).toBe("file.save");
    expect(reg.search("ㅅㄱㅎ")[0].id).toBe("tool.rect");
    setWs("3d");
    const r = reg.search("");
    expect(r.indexOf(reg.get("tool.rect")!)).toBeGreaterThan(r.indexOf(reg.get("view.reset3d")!));
    expect(reg.search("undo")[0].id).toBe("edit.undo");
  });

  it("등록 해제와 변경 알림", () => {
    const reg = new CommandRegistry();
    let n = 0;
    reg.onChange(() => n++);
    const off = reg.register({ id: "a", title: "A", category: "x", run: () => {} });
    expect(reg.get("a")).toBeTruthy();
    off();
    expect(reg.get("a")).toBeUndefined();
    expect(n).toBe(2);
  });
});

describe("설정", () => {
  it("깨진 값은 기본값으로, 단축키는 정리", () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings());
    const s = normalizeSettings({ theme: "dark", grid: 7, keys: { a: ["ctrl+k", 3, "Ctrl+K"], b: "x" }, layout: { left: 9999, swapped: true }, showExperimental: false });
    expect(s.theme).toBe("dark");
    expect(s.grid).toBe(1);
    expect(s.keys).toEqual({ a: ["Ctrl+K"] });
    expect(s.layout.left).toBe(560);
    expect(s.layout.swapped).toBe(true);
    expect(s.showExperimental).toBe(false);
  });
  it("최근 목록", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(Array.from({ length: 20 }, (_, i) => `x${i}`), "y")).toHaveLength(20);
  });
});

describe("실행 취소 기록 2.0", () => {
  const rect = (id: string, x = 0) => ({ id, kind: "rect" as const, hole: false, x, y: 0, w: 10, h: 10 });

  it("바뀐 곳만 남기고, 되돌리면 그대로", () => {
    const a = { n: 1, v: { x: [1, 2, 3], s: "a" }, gone: true } as Record<string, unknown>;
    const b = { n: 2, v: { x: [1, 9, 3], s: "a" }, extra: [1] } as Record<string, unknown>;
    const ops = diff(a, b);
    expect(ops.map((o) => o.path.join("."))).toEqual(["n", "v.x.1", "gone", "extra"]);
    const back = applyOps(structuredClone(b), ops, "before");
    expect(back).toEqual(a);
    expect(applyOps(structuredClone(a), ops, "after")).toEqual(b);
  });

  it("begin~commit 사이 여러 번 바뀌어도 한 칸, 안 바뀌면 남기지 않음", () => {
    const h = new History<Project>();
    const p = emptyProject();
    h.begin(p, "이동");
    p.views.front.push(rect("a"));
    (p.views.front[0] as any).x = 5;
    (p.views.front[0] as any).x = 7;
    expect(h.commit(p)).toBe(true);
    h.begin(p, "아무것도");
    expect(h.commit(p)).toBe(false);
    expect(h.entries.map((e) => e.label)).toEqual(["이동"]);
    const u = h.undo(p)!;
    expect(u.label).toBe("이동");
    expect(u.state.views.front).toEqual([]);
    const r = h.redo(u.state)!;
    expect((r.state.views.front[0] as any).x).toBe(7);
  });

  it("되돌린 뒤 새로 고치면 다시 실행 기록은 사라짐, 원하는 칸으로 건너뛰기", () => {
    const h = new History<Project>();
    let p = emptyProject();
    for (const n of ["A", "B", "C", "D"]) {
      h.begin(p, n);
      p.name = n;
      h.commit(p);
    }
    expect(h.position).toBe(4);
    p = h.goto(p, 1);
    expect(p.name).toBe("A");
    expect(h.position).toBe(1);
    expect(h.entries).toHaveLength(4);
    p = h.goto(p, 3);
    expect(p.name).toBe("C");
    p = h.goto(p, 0);
    expect(p.name).toBe("새 부품");
    h.begin(p, "E");
    p.name = "E";
    h.commit(p);
    expect(h.entries.map((e) => e.label)).toEqual(["E"]);
    expect(h.canRedo).toBe(false);
  });

  it("revert: 진행 중인 것을 버리고 처음으로", () => {
    const h = new History<Project>();
    const p = emptyProject();
    h.begin(p, "끌기");
    p.name = "바뀜";
    const back = h.revert(p);
    expect(back.name).toBe("새 부품");
    expect(h.canUndo).toBe(false);
  });

  it("큰 문서: 작은 수정 300번이 문서 크기만큼 쌓이지 않는다", () => {
    const h = new History<Project>();
    const p = emptyProject();
    p.views.top = Array.from({ length: 1000 }, (_, i) => rect(`s${i}`, i * 3));
    const docSize = JSON.stringify(p).length;
    for (let i = 0; i < 300; i++) {
      h.begin(p, "치수 고치기");
      (p.views.top[i] as any).w = 20 + i;
      h.commit(p);
    }
    expect(h.entries).toHaveLength(300);
    // 예전 방식(통째 복사)이면 300 × 문서 크기
    expect(h.bytes).toBeLessThan(docSize);
    expect(h.bytes).toBeLessThan(300 * 200);
  });

  it("크기·칸 수 한도", () => {
    const h = new History<{ s: string }>({ maxEntries: 5, maxBytes: 1_000_000 });
    let st = { s: "" };
    for (let i = 0; i < 12; i++) {
      h.begin(st, `e${i}`);
      st.s = `v${i}`;
      h.commit(st);
    }
    expect(h.entries.map((e) => e.label)).toEqual(["e7", "e8", "e9", "e10", "e11"]);
    const small = new History<{ s: string }>({ maxBytes: 500 });
    st = { s: "" };
    for (let i = 0; i < 20; i++) {
      small.begin(st, "big");
      st.s = "x".repeat(100) + i;
      small.commit(st);
    }
    expect(small.bytes).toBeLessThanOrEqual(500);
    expect(small.entries.length).toBeGreaterThan(0);
  });
});
