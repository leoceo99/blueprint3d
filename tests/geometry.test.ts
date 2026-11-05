import { describe, expect, it } from "vitest";
import {
  area,
  arcInfo,
  bulgeThrough,
  distToBoundary,
  flatten,
  mirrored,
  pointInShape,
  rotated,
  shapeBounds,
} from "../src/core/geometry2d";
import type { Shape2D } from "../src/core/types";

const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe("원호 (bulge)", () => {
  it("bulge 1은 반원, 양수는 진행 방향 오른쪽으로 볼록", () => {
    const arc = arcInfo({ a: [1, 0], b: [-1, 0], bulge: 1 })!;
    close(arc.r, 1);
    close(arc.center[0], 0);
    close(arc.center[1], 0);
    close(arc.mid[0], 0);
    close(arc.mid[1], 1);
  });

  it("세 점을 지나는 bulge를 거꾸로 구하면 같은 호", () => {
    for (const through of [[0, 1], [0, -0.3], [0.5, 0.2]] as [number, number][]) {
      const k = bulgeThrough([-1, 0], through, [1, 0]);
      const arc = arcInfo({ a: [-1, 0], b: [1, 0], bulge: k })!;
      close(Math.hypot(through[0] - arc.center[0], through[1] - arc.center[1]), arc.r, 1e-9);
    }
    expect(bulgeThrough([0, 0], [1, 0], [2, 0])).toBe(0);
  });
});

describe("도형 넓이 (원호 포함, 정확한 값)", () => {
  it("모서리 R 사각형 = 사각형 − (4 − π)R²", () => {
    const s: Shape2D = { id: "r", kind: "rect", hole: false, x: 0, y: 0, w: 40, h: 20, corners: [0, 1, 2, 3].map(() => ({ kind: "fillet" as const, size: 3 })) };
    close(area(s), 40 * 20 - (4 - Math.PI) * 9);
    expect(pointInShape(0.2, 0.2, s)).toBe(false); // 둥글게 깎인 모서리 바깥
    expect(pointInShape(3, 3, s)).toBe(true);
  });

  it("모따기 사각형 = 사각형 − 2C²", () => {
    const s: Shape2D = { id: "r", kind: "rect", hole: false, x: 0, y: 0, w: 40, h: 20, corners: [0, 1, 2, 3].map(() => ({ kind: "chamfer" as const, size: 2 })) };
    close(area(s), 40 * 20 - 4 * 2);
  });

  it("장공 = 중심거리×폭 + 원", () => {
    const s: Shape2D = { id: "s", kind: "slot", hole: true, a: [0, 0], b: [20, 0], w: 6 };
    close(area(s), 20 * 6 + Math.PI * 9);
    expect(shapeBounds(s).map((v) => Math.round(v * 1000) / 1000)).toEqual([-3, -3, 23, 3]);
    close(distToBoundary([10, 0], s), 3);
    close(distToBoundary([-5, 0], s), 2);
  });

  it("한 변을 반원으로 휜 사각형 (D자)", () => {
    // 오른쪽 변(1→2)을 바깥쪽으로 반원: 진행 방향(위)의 오른쪽 = 바깥 → bulge +1
    const s: Shape2D = { id: "p", kind: "poly", hole: false, pts: [[0, 0], [20, 0], [20, 10], [0, 10]], bulges: [0, 1, 0, 0] };
    close(area(s), 200 + (Math.PI * 25) / 2);
    expect(Math.max(...flatten(s).map((p) => p[0]))).toBeCloseTo(25, 1);
  });
});

describe("대칭·회전", () => {
  const poly: Shape2D = {
    id: "p",
    kind: "poly",
    hole: false,
    pts: [[0, 0], [20, 0], [20, 10], [0, 10]],
    bulges: [0, 1, 0, 0],
    corners: [{ kind: "fillet", size: 2 }, null, null, null],
  };

  it("대칭 복사해도 넓이와 모양이 같다 (원호·모서리 유지)", () => {
    const m = mirrored(poly, "u", 0);
    close(area(m), area(poly));
    const b = shapeBounds(m);
    expect(b[0]).toBeCloseTo(-25, 1);
    expect(b[2]).toBeCloseTo(0, 6);
    // 모서리 R이 있던 원래 (0,0) 꼭짓점 → 대칭 후 (0,0)도 둥글게
    expect(pointInShape(-0.1, 0.1, m)).toBe(false);
  });

  it("사각형 대칭은 모서리 위치도 바뀐다", () => {
    const r: Shape2D = { id: "r", kind: "rect", hole: false, x: 0, y: 0, w: 10, h: 10, corners: [{ kind: "fillet", size: 3 }, null, null, null] };
    const m = mirrored(r, "u", 20) as Extract<Shape2D, { kind: "rect" }>;
    expect(m.x).toBe(30);
    expect(m.corners![1]).toEqual({ kind: "fillet", size: 3 }); // 왼쪽아래 → 오른쪽아래
  });

  it("90° 회전은 사각형 유지, 다른 각도는 다각형", () => {
    const r: Shape2D = { id: "r", kind: "rect", hole: false, x: 10, y: 0, w: 4, h: 2 };
    const r90 = rotated(r, 0, 0, Math.PI / 2);
    expect(r90.kind).toBe("rect");
    expect(shapeBounds(r90).map((v) => Math.round(v))).toEqual([-2, 10, 0, 14]);
    const r30 = rotated(r, 0, 0, Math.PI / 6);
    expect(r30.kind).toBe("poly");
    close(area(r30), 8, 1e-3); // 좌표를 0.0001mm 단위로 반올림하므로
  });
});
