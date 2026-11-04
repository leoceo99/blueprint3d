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
    name: "플랜지 (회전)",
    mode: "revolve",
    thickness: 10,
    views: {
      front: [
        { id: "f1", kind: "rect", hole: false, x: 8, y: 0, w: 32, h: 8 },
        { id: "f2", kind: "rect", hole: false, x: 8, y: 0, w: 12, h: 30 },
      ],
      top: [],
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
];
