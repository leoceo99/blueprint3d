import type { Project } from "./types";

/** 앱에서 바로 불러볼 수 있는 예제 부품 */
export const SAMPLES: Project[] = [
  {
    version: 1,
    name: "L 브래킷 (정면+평면+측면)",
    mode: "auto",
    thickness: 10,
    views: {
      front: [
        { id: "f1", kind: "poly", hole: false, pts: [[0, 0], [60, 0], [60, 8], [8, 8], [8, 45], [0, 45]] },
      ],
      top: [
        { id: "t1", kind: "rect", hole: false, x: 0, y: 0, w: 60, h: 40 },
        { id: "t2", kind: "circle", hole: true, cx: 38, cy: 20, r: 5 },
      ],
      side: [
        { id: "s1", kind: "rect", hole: false, x: 0, y: 0, w: 40, h: 45 },
        { id: "s2", kind: "circle", hole: true, cx: 20, cy: 30, r: 6 },
      ],
    },
  },
  {
    version: 1,
    name: "플랜지 (회전체 + 볼트 구멍)",
    mode: "revolve",
    thickness: 10,
    views: {
      front: [
        { id: "f1", kind: "rect", hole: false, x: 8, y: 0, w: 32, h: 8 },
        { id: "f2", kind: "rect", hole: false, x: 8, y: 0, w: 12, h: 30 },
      ],
      // 평면도에는 구멍만: 볼트 원 지름 60에 M6 관통 구멍 6개
      top: Array.from({ length: 6 }, (_, i) => ({
        id: `b${i}`,
        kind: "circle" as const,
        hole: true,
        cx: Math.round(30 * Math.cos((i * Math.PI) / 3) * 1e4) / 1e4,
        cy: Math.round(30 * Math.sin((i * Math.PI) / 3) * 1e4) / 1e4,
        r: 3.3,
        spec: { size: "M6", purpose: "clearance-normal" as const, head: "none" as const },
      })),
      side: [],
    },
  },
  {
    version: 1,
    name: "마운팅 플레이트 (평면도 1개)",
    mode: "auto",
    thickness: 6,
    views: {
      front: [],
      top: [
        { id: "t1", kind: "poly", hole: false, pts: [[0, 0], [80, 0], [80, 50], [55, 50], [40, 35], [0, 35]] },
        { id: "t2", kind: "circle", hole: true, cx: 8, cy: 8, r: 3 },
        { id: "t3", kind: "circle", hole: true, cx: 72, cy: 8, r: 3 },
        { id: "t4", kind: "circle", hole: true, cx: 72, cy: 42, r: 3 },
        { id: "t5", kind: "rect", hole: true, x: 25, y: 12, w: 30, h: 10 },
      ],
      side: [],
    },
  },
  {
    version: 1,
    name: "모터 마운트 (모서리 R · 장공 · 배열)",
    mode: "auto",
    process: "cnc",
    thickness: 5,
    views: {
      front: [],
      top: [
        { id: "m1", kind: "rect", hole: false, x: 0, y: 0, w: 80, h: 60, corners: [0, 1, 2, 3].map(() => ({ kind: "fillet" as const, size: 6 })) },
        { id: "m2", kind: "circle", hole: true, cx: 40, cy: 30, r: 11 },
        { id: "m3", kind: "slot", hole: true, a: [40, 47], b: [40, 51], w: 3.4 },
        { id: "m4", kind: "slot", hole: true, a: [23, 30], b: [19, 30], w: 3.4 },
        { id: "m5", kind: "slot", hole: true, a: [40, 13], b: [40, 9], w: 3.4 },
        { id: "m6", kind: "slot", hole: true, a: [57, 30], b: [61, 30], w: 3.4 },
        { id: "m7", kind: "circle", hole: true, cx: 7, cy: 7, r: 2.25 },
        { id: "m8", kind: "circle", hole: true, cx: 73, cy: 7, r: 2.25 },
        { id: "m9", kind: "circle", hole: true, cx: 73, cy: 53, r: 2.25 },
        { id: "m10", kind: "circle", hole: true, cx: 7, cy: 53, r: 2.25 },
      ],
      side: [],
    },
  },
  {
    version: 1,
    name: "가이드 블록 (깊이·카운터보어·가로 탭)",
    mode: "auto",
    process: "cnc",
    thickness: 10,
    views: {
      front: [{ id: "g1", kind: "rect", hole: false, x: 0, y: 0, w: 80, h: 25 }],
      top: [
        { id: "g2", kind: "rect", hole: false, x: 0, y: 0, w: 80, h: 40 },
        { id: "g3", kind: "circle", hole: true, cx: 12, cy: 20, r: 3.3, spec: { size: "M6", purpose: "clearance-normal", head: "counterbore", cbDiameter: 11, cbDepth: 6.5 } },
        { id: "g4", kind: "circle", hole: true, cx: 68, cy: 20, r: 3.3, spec: { size: "M6", purpose: "clearance-normal", head: "counterbore", cbDiameter: 11, cbDepth: 6.5 } },
        { id: "g5", kind: "rect", hole: true, x: 25, y: 10, w: 30, h: 20, depth: 8, corners: [0, 1, 2, 3].map(() => ({ kind: "fillet" as const, size: 3 })) },
      ],
      // 오른쪽 면에서 M5 탭 깊이 12
      side: [{ id: "g6", kind: "circle", hole: true, cx: 20, cy: 12.5, r: 2.1, depth: 12, spec: { size: "M5", purpose: "tap", head: "none", drillPoint: true } }],
    },
  },
  {
    version: 1,
    name: "변수로 만드는 판 (L·W·t·e를 바꿔 보세요)",
    mode: "auto",
    process: "cnc",
    thickness: 6,
    thicknessExpr: "t",
    params: [
      { name: "L", expr: "100" },
      { name: "W", expr: "60" },
      { name: "t", expr: "6" },
      { name: "e", expr: "8" },
    ],
    views: {
      front: [],
      top: [
        { id: "p1", kind: "rect", hole: false, x: 0, y: 0, w: 100, h: 60, exprs: { x: "0", y: "0", w: "L", h: "W" }, corners: [0, 1, 2, 3].map(() => ({ kind: "fillet" as const, size: 4 })) },
        ...([["e", "e"], ["L-e", "e"], ["L-e", "W-e"], ["e", "W-e"]] as const).map(([cx, cy], i) => ({
          id: `p${i + 2}`,
          kind: "circle" as const,
          hole: true,
          cx: 0,
          cy: 0,
          r: 2.75,
          exprs: { cx, cy },
          spec: { size: "M5", purpose: "clearance-normal" as const, head: "none" as const },
        })),
        { id: "p6", kind: "slot", hole: true, a: [0, 0], b: [0, 0], w: 10, exprs: { ax: "L/2 - L/6", ay: "W/2", bx: "L/2 + L/6", by: "W/2", w: "W/6" } },
      ],
      side: [],
    },
  },
];

