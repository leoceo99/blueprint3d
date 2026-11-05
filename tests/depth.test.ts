import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAll } from "../src/core/build";
import { emptyProject, type HoleSpec, type Project } from "../src/core/types";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

const PI = Math.PI;
const near = (actual: number, expected: number, rel = 0.004) => expect(Math.abs(actual - expected) / expected).toBeLessThan(rel);

/** 50×50×10 판 (평면도, z 0~10) */
function plate(): Project {
  const p = emptyProject();
  p.thickness = 10;
  p.views.top.push({ id: "b", kind: "rect", x: 0, y: 0, w: 50, h: 50, hole: false });
  return p;
}
const PLATE = 50 * 50 * 10;

describe("깊이 있는 구멍·포켓", () => {
  it("막힌 원형 구멍 (평평한 바닥): 윗면부터 깊이 4", () => {
    const p = plate();
    p.views.top.push({ id: "h", kind: "circle", cx: 25, cy: 25, r: 5, hole: true, depth: 4 });
    const r = buildAll(p).result;
    near(r.volume, PLATE - PI * 25 * 4);
    expect(r.bbox[1][2]).toBeCloseTo(10, 3); // 바닥은 뚫리지 않음
  });

  it("드릴 끝 118°가 있는 막힌 구멍", () => {
    const p = plate();
    const spec: HoleSpec = { size: "M6", purpose: "custom", head: "none", drillPoint: true };
    p.views.top.push({ id: "h", kind: "circle", cx: 25, cy: 25, r: 3, hole: true, depth: 6, spec });
    const cone = (PI * 9 * (3 / Math.tan((59 * PI) / 180))) / 3;
    near(buildAll(p).result.volume, PLATE - PI * 9 * 6 - cone);
  });

  it("사각 포켓 깊이 3 (윗면부터)", () => {
    const p = plate();
    p.views.top.push({ id: "k", kind: "rect", x: 10, y: 10, w: 20, h: 15, hole: true, depth: 3 });
    near(buildAll(p).result.volume, PLATE - 20 * 15 * 3);
  });

  it("가장자리에 걸친 포켓 = 단차(계단)", () => {
    const p = plate();
    p.views.top.push({ id: "k", kind: "rect", x: -5, y: -5, w: 25, h: 60, hole: true, depth: 4 });
    near(buildAll(p).result.volume, PLATE - 20 * 50 * 4);
  });

  it("카운터보어 관통 구멍: 몸통 + 자리파기", () => {
    const p = plate();
    const spec: HoleSpec = { size: "M5", purpose: "clearance-normal", head: "counterbore", cbDiameter: 9.5, cbDepth: 5.4 };
    p.views.top.push({ id: "h", kind: "circle", cx: 25, cy: 25, r: 2.75, hole: true, spec });
    const bore = PI * 2.75 ** 2 * 10;
    const cb = PI * (4.75 ** 2 - 2.75 ** 2) * 5.4;
    near(buildAll(p).result.volume, PLATE - bore - cb);
  });

  it("카운터싱크 90° 관통 구멍", () => {
    const p = plate();
    const spec: HoleSpec = { size: "M4", purpose: "clearance-normal", head: "countersink", csDiameter: 9, csAngle: 90 };
    p.views.top.push({ id: "h", kind: "circle", cx: 25, cy: 25, r: 2.25, hole: true, spec });
    const h = 4.5 - 2.25; // 90°면 높이 = 반지름 차이
    const frustum = (PI * h * (4.5 ** 2 + 4.5 * 2.25 + 2.25 ** 2)) / 3;
    near(buildAll(p).result.volume, PLATE - (PI * 2.25 ** 2 * (10 - h) + frustum));
  });

  it("정면도의 포켓은 앞면(Y 최소)부터 판다", () => {
    const p = emptyProject();
    p.thickness = 20;
    p.views.front.push({ id: "b", kind: "rect", x: 0, y: 0, w: 40, h: 30, hole: false });
    p.views.front.push({ id: "k", kind: "circle", cx: 20, cy: 15, r: 5, hole: true, depth: 8 });
    const r = buildAll(p).result;
    near(r.volume, 40 * 30 * 20 - PI * 25 * 8);
  });

  it("몸체 없이 우측면도에만 그린 구멍 = 옆으로 뚫는 가로 구멍", () => {
    const p = plate();
    // 판의 옆면(Y–Z): 판 두께 방향 z 0~10 가운데를 Y=25에서 X 방향으로 관통
    p.views.side.push({ id: "x", kind: "circle", cx: 25, cy: 5, r: 2, hole: true });
    near(buildAll(p).result.volume, PLATE - PI * 4 * 50);
  });

  it("우측면도 막힌 구멍은 오른쪽 면(X 최대)부터", () => {
    const p = plate();
    p.views.side.push({ id: "x", kind: "circle", cx: 25, cy: 5, r: 2, hole: true, depth: 12 });
    near(buildAll(p).result.volume, PLATE - PI * 4 * 12);
  });

  it("회전체 플랜지 + 평면도 볼트 구멍 6개", () => {
    const p = emptyProject();
    p.mode = "revolve";
    p.views.front.push({ id: "f", kind: "rect", x: 0, y: 0, w: 40, h: 8, hole: false });
    for (let i = 0; i < 6; i++) {
      const a = (i * PI) / 3;
      p.views.top.push({ id: `h${i}`, kind: "circle", cx: 30 * Math.cos(a), cy: 30 * Math.sin(a), r: 3, hole: true });
    }
    const r = buildAll(p).result;
    near(r.volume, PI * 1600 * 8 - 6 * PI * 9 * 8, 0.01);
  });
});
