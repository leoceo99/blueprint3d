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
    expect(f.title).toContain("1mm");
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
