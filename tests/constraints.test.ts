// 10단계: 스케치 구속 — 도형 매개변수로 풀기, 잠근 치수 고정, 자유도·다 정해짐, 충돌, 정리, 저장
import { describe, expect, it } from "vitest";
import { analyzeView, matchSignature, measure, newConstraintId, pruneConstraints, refPoint, solveView } from "../src/core/constraints";
import { normalizeProject } from "../src/core/project";
import { emptyProject, type Constraint, type ConsKind, type CRef, type Project, type Shape2D } from "../src/core/types";

const R = (s: string, k: string): CRef => ({ s, k });
const C = (kind: ConsKind, refs: CRef[], extra: Partial<Constraint> = {}): Constraint => ({ id: newConstraintId(), kind, refs, ...extra });

function part(shapes: Shape2D[], cons: Constraint[] = []): Project {
  const p = emptyProject();
  p.views.top = shapes;
  if (cons.length) p.constraints = { top: cons };
  return p;
}
const rect = (id: string, x: number, y: number, w: number, h: number, extra: object = {}): Shape2D => ({ id, kind: "rect", hole: false, x, y, w, h, ...extra });
const circle = (id: string, cx: number, cy: number, r: number, extra: object = {}): Shape2D => ({ id, kind: "circle", hole: true, cx, cy, r, ...extra });
const get = (p: Project, id: string) => p.views.top.find((s) => s.id === id)! as any;

describe("스케치 구속", () => {
  it("구멍 중심을 사각형 중심에 (동심 대신 일치) — 구멍이 움직이고 판은 그대로(판을 잠갔을 때)", () => {
    const p = part(
      [rect("plate", 0, 0, 80, 40, { exprs: { x: "0", y: "0", w: "80", h: "40" } }), circle("h", 30, 15, 5)],
      [C("coincident", [R("h", "c"), R("plate", "c")])],
    );
    expect(solveView(p, "top").ok).toBe(true);
    expect([get(p, "h").cx, get(p, "h").cy].map((v: number) => +v.toFixed(9))).toEqual([40, 20]);
    expect(get(p, "plate").w).toBe(80);
  });

  it("가로 거리 치수: 구멍을 왼쪽 변에서 15 mm, 판을 늘리면 구멍은 그대로(왼쪽 기준)", () => {
    const p = part([rect("plate", 0, 0, 80, 40, { exprs: { x: "0", y: "0" } }), circle("h", 22, 20, 4)]);
    const m = measure(p, "top", "distanceX", [R("plate", "v0"), R("h", "c")]);
    expect(m).toEqual({ value: 22, side: 1 });
    p.constraints = { top: [C("distanceX", [R("plate", "v0"), R("h", "c")], { value: 15, side: 1 })] };
    expect(solveView(p, "top").ok).toBe(true);
    expect(get(p, "h").cx).toBeCloseTo(15, 9);
    // 판 가로를 바꾼다 (사용자가 바꾼 값은 고정) → 구멍은 왼쪽 변 기준이라 그대로
    get(p, "plate").w = 120;
    expect(solveView(p, "top", { fixed: new Set(["plate:w"]) }).ok).toBe(true);
    expect(get(p, "plate").w).toBe(120);
    expect(get(p, "h").cx).toBeCloseTo(15, 9);
  });

  it("같게·평행·직각·수평 (다각형), 대칭 (원 두 개를 세로축에 대칭)", () => {
    const tri: Shape2D = { id: "t", kind: "poly", hole: false, pts: [[0, 0], [10, 1], [2, 8]] };
    const p = part(
      [tri],
      [C("horizontal", [R("t", "e0")]), C("perpendicular", [R("t", "e0"), R("t", "e2")]), C("equal", [R("t", "e0"), R("t", "e2")])],
    );
    expect(solveView(p, "top").ok).toBe(true);
    const [a, b, c] = get(p, "t").pts;
    expect(a[1]).toBeCloseTo(b[1], 9);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(Math.hypot(a[0] - c[0], a[1] - c[1]), 7);
    expect((b[0] - a[0]) * (a[0] - c[0]) + (b[1] - a[1]) * (a[1] - c[1])).toBeCloseTo(0, 6);
    const q = part([circle("l", -18, 3, 3), circle("r", 22, 5, 3)], [C("symmetric", [R("l", "c"), R("r", "c"), R("@y", "")])]);
    expect(solveView(q, "top").ok).toBe(true);
    expect(get(q, "l").cx).toBeCloseTo(-get(q, "r").cx, 9);
    expect(get(q, "l").cy).toBeCloseTo(get(q, "r").cy, 9);
  });

  it("접선: 원이 사각형 윗변에 닿게 (만든 쪽 그대로), 원끼리 바깥 접", () => {
    const p = part([rect("b", 0, 0, 50, 20, { exprs: { x: "0", y: "0", w: "50", h: "20" } }), circle("c", 25, 30, 6, { hole: false })]);
    const m = measure(p, "top", "tangent", [R("b", "e2"), R("c", "o")]);
    p.constraints = { top: [C("tangent", [R("b", "e2"), R("c", "o")], { side: m.side })] };
    expect(solveView(p, "top").ok).toBe(true);
    const c = get(p, "c");
    expect(c.cy - c.r).toBeCloseTo(20, 7);
    const q = part([circle("a", 0, 0, 5, { exprs: { cx: "0", cy: "0", d: "10" } }), circle("b", 20, 0, 4)]);
    const s = measure(q, "top", "tangent", [R("a", "o"), R("b", "o")]).side;
    q.constraints = { top: [C("tangent", [R("a", "o"), R("b", "o")], { side: s })] };
    expect(solveView(q, "top").ok).toBe(true);
    const bb = get(q, "b");
    expect(Math.hypot(bb.cx, bb.cy)).toBeCloseTo(5 + bb.r, 7);
  });

  it("각도 치수, 점-선 위, 가운데, 고정", () => {
    const L: Shape2D = { id: "L", kind: "poly", hole: false, pts: [[0, 0], [30, 0], [25, 20]] };
    const p = part([L, circle("h", 13, 4, 2)], [C("horizontal", [R("L", "e0")]), C("angle", [R("L", "e0"), R("L", "e1")], { value: 120 }), C("midpoint", [R("h", "c"), R("L", "e0")]), C("fix", [R("L", "v0")], { at: [0, 0] })]);
    expect(solveView(p, "top").ok).toBe(true);
    const m = measure(p, "top", "angle", [R("L", "e0"), R("L", "e1")]);
    expect(m.value).toBeCloseTo(120, 6);
    expect(refPoint(p, "top", R("h", "c"))[0]).toBeCloseTo(get(p, "L").pts[1][0] / 2, 7);
    expect(get(p, "L").pts[0][0]).toBeCloseTo(0, 9);
    expect(get(p, "L").pts[0][1]).toBeCloseTo(0, 9);
  });

  it("자유도: 판 + 구멍, 구속을 더할수록 줄고 다 정해지면 0", () => {
    const p = part([rect("plate", 0, 0, 80, 40), circle("h", 20, 20, 4)]);
    expect(analyzeView(p, "top").dof).toBe(7); // 사각형 4 + 원 3
    p.views.top[0].exprs = { x: "0", y: "0", w: "80", h: "40" };
    p.views.top[1].exprs = { d: "8" };
    let a = analyzeView(p, "top");
    expect(a.dof).toBe(2);
    expect(a.shapes.get("plate")).toBe("full");
    expect(a.shapes.get("h")).toBe("partial");
    p.constraints = { top: [C("distanceX", [R("plate", "v0"), R("h", "c")], { value: 20, side: 1 })] };
    a = analyzeView(p, "top");
    expect(a.dof).toBe(1);
    p.constraints.top!.push(C("distanceY", [R("plate", "v0"), R("h", "c")], { value: 20, side: 1 }));
    a = analyzeView(p, "top");
    expect(a.dof).toBe(0);
    expect(a.shapes.get("h")).toBe("full");
    expect(a.redundant).toEqual([]);
  });

  it("충돌: 풀 수 없으면 도형을 그대로 두고 부딪치는 구속을 알려 줌", () => {
    const p = part([rect("plate", 0, 0, 80, 40, { exprs: { x: "0", y: "0", w: "80", h: "40" } }), circle("h", 20, 20, 4)]);
    const c1 = C("distanceX", [R("plate", "v0"), R("h", "c")], { value: 20, side: 1 });
    const c2 = C("distanceX", [R("plate", "v1"), R("h", "c")], { value: 20, side: -1 }); // 80 − 20 = 60 ≠ 20
    p.constraints = { top: [c1, c2] };
    const before = JSON.stringify(p.views);
    const r = solveView(p, "top");
    expect(r.ok).toBe(false);
    expect(r.conflicting).toContain(c2.id);
    expect(JSON.stringify(p.views)).toBe(before);
    // 크기가 0 이하가 되는 해는 받지 않음
    const q = part([rect("a", 0, 0, 10, 10)], [C("distance", [R("a", "v0"), R("a", "v1")], { value: 0.0000001 })]);
    expect(solveView(q, "top").ok).toBe(false);
  });

  it("고를 수 있는 대상 순서 (서명)", () => {
    expect(matchSignature("distance", ["point"])).toBe("partial");
    expect(matchSignature("distance", ["point", "line"])).toBe("full");
    expect(matchSignature("tangent", ["line", "line"])).toBe("no");
    expect(matchSignature("symmetric", ["point", "point", "line"])).toBe("full");
  });

  it("정리·저장: 지운 도형·사라진 꼭짓점·휜 변의 구속은 빠지고, 저장 후에도 그대로", () => {
    const poly: Shape2D = { id: "p", kind: "poly", hole: false, pts: [[0, 0], [10, 0], [10, 10]], bulges: [0, 0.4, 0] };
    const p = part(
      [rect("a", 0, 0, 10, 10), poly],
      [C("horizontal", [R("p", "e0")]), C("vertical", [R("p", "e1")]), C("coincident", [R("a", "v2"), R("p", "v5")]), C("coincident", [R("a", "v2"), R("gone", "c")]), C("fix", [R("a", "v0")], { at: [0, 0] })],
    );
    expect(pruneConstraints(p)).toBe(true);
    expect(p.constraints!.top!.map((c) => c.kind)).toEqual(["horizontal", "fix"]);
    const back = normalizeProject(JSON.parse(JSON.stringify(p)))!;
    expect(back.constraints).toEqual(p.constraints);
    const broken = normalizeProject({ ...JSON.parse(JSON.stringify(p)), constraints: { top: [{ id: 1 }, { id: "x", kind: "nope", refs: [] }] } })!;
    expect(broken.constraints).toBeUndefined();
  });
});
