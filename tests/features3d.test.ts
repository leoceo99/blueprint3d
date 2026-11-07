import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { drawRoundedRectangle, makeBaseBox, makeCylinder, setOC, type Shape3D } from "replicad";
import { analyzeShape, isFull } from "../src/core/features3d";
import { readStep } from "../src/core/importModel";
import { buildAll } from "../src/core/build";
import { emptyProject } from "../src/core/types";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

/** STEP으로 저장했다가 다시 읽기 (다른 CAD에서 받은 파일과 같은 길) */
async function viaStep(s: Shape3D): Promise<Shape3D> {
  const buf = await s.blobSTEP().arrayBuffer();
  return readStep(buf);
}

describe("형상 읽기 (B-rep → 특징)", () => {
  it("세로 모서리 R5: 볼록한 1/4 원통 4개, 높이는 바닥·윗면", async () => {
    const s = await viaStep(makeBaseBox(60, 40, 20).fillet(5, (e) => e.inDirection("Z")) as Shape3D);
    const f = analyzeShape(s);
    const fil = f.cyl.filter((c) => !isFull(c));
    expect(fil).toHaveLength(4);
    for (const c of fil) {
      expect(c.axis).toBe(2);
      expect(c.r).toBeCloseTo(5, 6);
      expect(c.concave).toBe(false);
      expect(c.sweep).toBeCloseTo(Math.PI / 2, 3);
    }
    // 오른쪽 위 모서리 R의 중심 (25, 15), 원호는 0°~90°
    const ru = fil.find((c) => c.p[0] > 0 && c.p[1] > 0)!;
    expect(ru.p).toEqual([25, 15]);
    expect(ru.a0).toBeCloseTo(0, 3);
    expect(f.levels[2]).toEqual([0, 20]);
    expect(f.levels[0]).toEqual([-30, 30]);
  });

  it("윗면 가로 모서리 C2: X와 나란한 기울어진 면 2개, 다리 2×2", async () => {
    const s = await viaStep(makeBaseBox(60, 40, 20).chamfer(2, (e) => e.inDirection("X").inPlane("XY", 20)) as Shape3D);
    const f = analyzeShape(s);
    expect(f.slopes).toHaveLength(2);
    for (const c of f.slopes) {
      expect(c.along).toBe(0);
      expect(c.axes).toEqual([1, 2]);
      expect(c.legs[0]).toBeCloseTo(2, 6);
      expect(c.legs[1]).toBeCloseTo(2, 6);
    }
    // 모따기 뒤 윗면은 그대로 20에 있음
    expect(f.levels[2]).toEqual([0, 20]);
  });

  it("단차 + 보스 + 구멍: 높이 목록, 볼록한 원통(보스), 오목한 원통(구멍)", async () => {
    let s = makeBaseBox(60, 40, 10) as Shape3D;
    s = s.fuse(makeBaseBox(30, 40, 10).translate([-15, 0, 10]) as Shape3D) as Shape3D; // 왼쪽 절반이 20까지
    s = s.fuse(makeCylinder(6, 8, [15, 0, 10], [0, 0, 1])) as Shape3D; // 오른쪽에 보스 Ø12, 18까지
    s = s.cut(makeCylinder(2.5, 30, [-20, 10, -5], [0, 0, 1])) as Shape3D; // 관통 구멍 Ø5
    const f = analyzeShape(await viaStep(s));
    expect(f.levels[2]).toEqual([0, 10, 18, 20]);
    expect(f.levels[0]).toEqual([-30, 0, 30]);
    const boss = f.cyl.find((c) => !c.concave && isFull(c))!;
    expect(boss.r).toBeCloseTo(6, 6);
    expect(boss.p).toEqual([15, 0]);
    expect([boss.t0, boss.t1]).toEqual([10, 18]);
    const hole = f.cyl.find((c) => c.concave && isFull(c))!;
    expect(hole.r).toBeCloseTo(2.5, 6);
    expect(hole.p).toEqual([-20, 10]);
  });

  it("장공(둥근 끝 홈): 오목한 반원통 2개", async () => {
    const slot = drawRoundedRectangle(30, 10, 4.999).sketchOnPlane("XY", 5).extrude(10) as Shape3D;
    const s = (makeBaseBox(60, 40, 10) as Shape3D).cut(slot) as Shape3D;
    const f = analyzeShape(await viaStep(s));
    const ends = f.cyl.filter((c) => c.concave && !isFull(c) && c.r > 4.9);
    expect(ends.length).toBeGreaterThanOrEqual(2);
    // 홈 바닥 z=5는 높이로
    expect(f.levels[2]).toContain(5);
  });

  it("구멍 바닥(막힌 구멍)은 높이로 세지 않음", async () => {
    const s = (makeBaseBox(40, 40, 20) as Shape3D).cut(makeCylinder(3, 8, [0, 0, 12], [0, 0, 1])) as Shape3D;
    const f = analyzeShape(await viaStep(s));
    expect(f.levels[2]).toEqual([0, 20]);
    expect(f.cyl.filter((c) => c.concave && isFull(c))).toHaveLength(1);
  });

  it("카운터싱크(우리 구멍 도구로 만든 것): 오목한 원뿔, 반각 45°, 바깥 Ø12", async () => {
    const p = emptyProject();
    p.views.top = [
      { id: "b", kind: "rect", hole: false, x: 0, y: 0, w: 40, h: 30 },
      { id: "h", kind: "circle", hole: true, cx: 20, cy: 15, r: 3.3, spec: { size: "M6", purpose: "custom", head: "countersink", csDiameter: 12, csAngle: 90 } },
    ];
    p.thickness = 10;
    const { shape } = buildAll(p);
    const f = analyzeShape(await viaStep(shape!));
    expect(f.cones).toHaveLength(1);
    expect(f.cones[0].semi).toBeCloseTo(45, 3);
    expect(f.cones[0].concave).toBe(true);
    expect(f.cones[0].r1).toBeCloseTo(6, 3);
    expect(f.cones[0].p).toEqual([20, 15]);
  });
});
