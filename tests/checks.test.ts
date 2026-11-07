import { describe, expect, it } from "vitest";
import { runChecks, selfIntersects } from "../src/core/checks";
import { emptyProject, type Project, type Shape2D } from "../src/core/types";

const rect = (id: string, x: number, y: number, w: number, h: number, hole = false): Shape2D => ({ id, kind: "rect", x, y, w, h, hole });
const circle = (id: string, cx: number, cy: number, r: number, hole = true): Shape2D => ({ id, kind: "circle", cx, cy, r, hole });
const codes = (p: Project, build?: any) => runChecks(p, build).map((f) => f.id.split(":")[0]);

describe("규칙 기반 설계 검사", () => {
  it("문제 없는 판재는 경고가 없다", () => {
    const p = emptyProject();
    p.views.top = [rect("a", 0, 0, 50, 50), circle("h", 25, 25, 5)];
    expect(runChecks(p).filter((f) => f.severity !== "info")).toEqual([]);
  });

  it("정면도와 평면도의 폭이 다르면 경고", () => {
    const p = emptyProject();
    p.views.front = [rect("f", 0, 0, 60, 20)];
    p.views.top = [rect("t", 0, 0, 55, 30)];
    const f = runChecks(p).find((x) => x.id === "extent:front:top")!;
    expect(f.severity).toBe("warning");
    expect(f.detail).toContain("0~55");
  });

  it("구멍이 가장자리에 너무 가까우면 경고", () => {
    const p = emptyProject();
    p.views.top = [rect("a", 0, 0, 50, 50), circle("h", 6, 25, 5)]; // 벽 1mm, 권장 2.5mm
    const f = runChecks(p).find((x) => x.id.startsWith("hole-edge"))!;
    expect(f.severity).toBe("warning");
    expect(f.title).toContain("1 mm");
    expect(f.refs[0].shapeId).toBe("h");
  });

  it("몸체 밖 구멍은 오류, 걸친 구멍은 노치 경고", () => {
    const p = emptyProject();
    p.views.top = [rect("a", 0, 0, 50, 50), circle("out", 100, 100, 3), circle("cross", 0, 25, 3)];
    const c = codes(p);
    expect(c).toContain("hole-out");
    expect(c).toContain("hole-cross");
  });

  it("구멍끼리 겹치거나 너무 가까우면 경고", () => {
    const p = emptyProject();
    p.views.top = [rect("a", 0, 0, 80, 40), circle("h1", 20, 20, 5), circle("h2", 28, 20, 5), circle("h3", 50, 20, 5), circle("h4", 61, 20, 5)]; // h3-h4 벽 1mm
    const c = codes(p);
    expect(c).toContain("hole-overlap");
    expect(c).toContain("hole-gap");
  });

  it("깊고 가는 구멍 (드릴 한계)", () => {
    const p = emptyProject();
    p.thickness = 40;
    p.views.top = [rect("a", 0, 0, 30, 30), circle("h", 15, 15, 1.5)];
    expect(codes(p)).toContain("hole-deep");
  });

  it("다각형 자체 교차는 오류", () => {
    expect(selfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]])).not.toBeNull();
    expect(selfIntersects([[0, 0], [10, 0], [10, 10], [0, 10]])).toBeNull();
    const p = emptyProject();
    p.views.front = [{ id: "p", kind: "poly", hole: false, pts: [[0, 0], [10, 10], [10, 0], [0, 10]] }];
    expect(runChecks(p)[0].severity).toBe("error");
  });

  it("떨어진 덩어리는 오류", () => {
    const p = emptyProject();
    p.views.top = [rect("a", 0, 0, 10, 10), rect("b", 20, 0, 10, 10)];
    expect(codes(p, { bbox: [[0, 0, 0], [30, 10, 10]], solidCount: 2 })).toContain("multi-solid");
  });

  it("각진 사각 구멍은 안내, 모서리 R을 주면 사라진다", () => {
    const p = emptyProject();
    p.views.top = [rect("a", 0, 0, 60, 40), rect("h", 20, 10, 20, 10, true)];
    expect(codes(p)).toContain("sharp-corner");
    (p.views.top[1] as any).corners = [0, 1, 2, 3].map(() => ({ kind: "fillet", size: 2 }));
    expect(codes(p)).not.toContain("sharp-corner");
  });

  it("장공 구멍도 가장자리 거리 검사", () => {
    const p = emptyProject();
    p.views.top = [rect("a", 0, 0, 60, 40), { id: "s", kind: "slot", hole: true, a: [10, 3.5], b: [30, 3.5], w: 6 }];
    const f = runChecks(p).find((x) => x.id.startsWith("hole-edge"))!;
    expect(f.title).toContain("0.5 mm");
  });

  it("카운터보어: 자리 지름이 구멍보다 작거나 너무 깊으면 오류", () => {
    const p = emptyProject();
    p.thickness = 6;
    p.views.top = [rect("a", 0, 0, 50, 50), { id: "h", kind: "circle", cx: 25, cy: 25, r: 2.75, hole: true, spec: { size: "M5", purpose: "clearance-normal", head: "counterbore", cbDiameter: 4, cbDepth: 7 } }];
    const c = codes(p);
    expect(c).toContain("cb-dia");
    expect(c).toContain("cb-depth");
  });

  it("머리 자리까지 포함해서 가장자리 거리를 잰다", () => {
    const p = emptyProject();
    // 구멍 Ø5.5는 가장자리에서 3.25mm 떨어져 괜찮지만, 카운터보어 Ø9.5는 1.25mm만 남는다
    const hole = { id: "h", kind: "circle" as const, cx: 6, cy: 25, r: 2.75, hole: true };
    p.views.top = [rect("a", 0, 0, 50, 50), hole];
    expect(codes(p)).not.toContain("hole-edge");
    p.views.top[1] = { ...hole, spec: { size: "M5", purpose: "clearance-normal", head: "counterbore", cbDiameter: 9.5, cbDepth: 5.4 } };
    expect(codes(p)).toContain("hole-edge");
  });

  it("가장자리에 걸친 포켓은 노치 경고가 아니라 단차 안내", () => {
    const p = emptyProject();
    p.views.top = [rect("a", 0, 0, 50, 50), { ...rect("k", -5, -5, 20, 60, true), depth: 3 }];
    const c = codes(p);
    expect(c).toContain("hole-step");
    expect(c).not.toContain("hole-cross");
  });

  it("깊고 좁은 포켓, 얕은 탭, 두께 이상 깊이", () => {
    const p = emptyProject();
    p.thickness = 30;
    p.views.top = [
      rect("a", 0, 0, 60, 60),
      { ...rect("k", 10, 10, 4, 30, true), depth: 20 },
      { id: "t", kind: "circle", cx: 40, cy: 20, r: 3.3 / 2, hole: true, depth: 4, spec: { size: "M4", purpose: "tap", head: "none" } },
      { id: "d", kind: "circle", cx: 40, cy: 45, r: 3, hole: true, depth: 40 },
    ];
    const c = codes(p);
    expect(c).toContain("pocket-deep");
    expect(c).toContain("tap-engage");
    expect(c).toContain("depth-through");
    expect(c).not.toContain("hole-std"); // 규격 탭 Ø3.3은 표준이라 안내하지 않음
  });

  it("몸체 없는 뷰의 구멍은 '몸체 밖' 오류를 내지 않는다", () => {
    const p = emptyProject();
    p.views.top = [rect("a", 0, 0, 50, 50)];
    p.views.side = [circle("x", 25, 5, 2)];
    expect(codes(p)).not.toContain("hole-out");
  });

  it("제조 방식에 따라 기준이 달라진다 (판금: 구멍 ≥ 두께)", () => {
    const p = emptyProject();
    p.thickness = 4;
    p.views.top = [rect("a", 0, 0, 50, 50), circle("h", 25, 25, 1.5)];
    p.process = "cnc";
    expect(codes(p)).not.toContain("hole-vs-t");
    p.process = "laser";
    expect(codes(p)).toContain("hole-vs-t");
  });
});
