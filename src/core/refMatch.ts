/**
 * 면·모서리 참조 다시 찾기 (결정 29): 저장해 둔 기하 지문과 지금 형상의 지문을 비교해 가장 닮은 것을 고른다.
 * 형상 엔진 없이 숫자만 — 단위 시험과 화면(고른 것 강조)에서도 쓴다.
 */
import type { EdgeSig, FaceSig, P3 } from "./featureModel";

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);

/** 이 값보다 점수가 크면 “못 찾음” */
export const MATCH_LIMIT = 0.5;

/**
 * 위치 차이: 방향 n이 있으면 그 방향 성분(면이 앞뒤로 움직임)을 크게, 옆으로 움직인 것(면이 넓어짐)은 작게 본다
 */
function posPenalty(a: P3, b: P3, n: P3 | undefined, L: number): number {
  const d = sub(a, b);
  if (!n) return len(d) / L;
  const along = Math.abs(dot(d, n));
  const side = Math.sqrt(Math.max(0, dot(d, d) - along * along));
  return (1.5 * along + 0.5 * side) / L;
}

const sizePenalty = (a: number, b: number) => (a > 0 && b > 0 ? Math.min(1, 0.3 * Math.abs(Math.log(a / b))) : 0);

export function faceScore(a: FaceSig, b: FaceSig, L: number): number {
  if (a.t !== b.t) return Infinity;
  let s = 0;
  if (a.n && b.n) {
    const d = dot(a.n, b.n);
    const dd = a.t === "plane" ? d : Math.abs(d);
    if (dd < 0.95) return Infinity;
    s += 2 * (1 - dd);
  }
  if (a.r !== undefined && b.r !== undefined) s += Math.abs(a.r - b.r) / Math.max(a.r, b.r, 1e-9);
  s += sizePenalty(a.a, b.a);
  // 평면은 법선 방향, 원통은 축에 수직인 방향(축을 따라 길어진 것은 작게)
  s += a.t === "plane" ? posPenalty(a.c, b.c, a.n, L) : posPenalty(a.c, b.c, undefined, L);
  return s;
}

export function edgeScore(a: EdgeSig, b: EdgeSig, L: number): number {
  if (a.t !== b.t) return Infinity;
  let s = 0;
  if (a.d && b.d) {
    const dd = Math.abs(dot(a.d, b.d));
    if (dd < 0.95) return Infinity;
    s += 2 * (1 - dd);
  }
  if (a.r !== undefined && b.r !== undefined) s += Math.abs(a.r - b.r) / Math.max(a.r, b.r, 1e-9);
  s += sizePenalty(a.l, b.l);
  // 직선 모서리는 길이 방향으로 늘어나도 괜찮게 (가운데 점이 움직임)
  if (a.t === "line" && a.d) {
    const d = sub(a.c, b.c);
    const along = Math.abs(dot(d, a.d));
    const side = Math.sqrt(Math.max(0, dot(d, d) - along * along));
    s += (side + 0.3 * along) / L;
  } else s += len(sub(a.c, b.c)) / L;
  return s;
}

/**
 * 대상마다 후보 하나씩 (서로 겹치지 않게, 점수가 낮은 짝부터). 못 찾으면 -1
 */
export function matchAll<T>(targets: T[], cands: T[], score: (a: T, b: T) => number, limit = MATCH_LIMIT): number[] {
  const pairs: [number, number, number][] = [];
  targets.forEach((t, i) =>
    cands.forEach((c, j) => {
      const s = score(t, c);
      if (s <= limit) pairs.push([s, i, j]);
    }),
  );
  pairs.sort((a, b) => a[0] - b[0]);
  const out = targets.map(() => -1);
  const used = new Set<number>();
  for (const [, i, j] of pairs) {
    if (out[i] !== -1 || used.has(j)) continue;
    out[i] = j;
    used.add(j);
  }
  return out;
}

export const matchFaces = (targets: FaceSig[], cands: FaceSig[], L: number) => matchAll(targets, cands, (a, b) => faceScore(a, b, L));
export const matchEdges = (targets: EdgeSig[], cands: EdgeSig[], L: number) => matchAll(targets, cands, (a, b) => edgeScore(a, b, L));

/** 모델 크기 (대각선 길이, 최소 1) — 위치 차이를 이것으로 나눈다 */
export function modelSize(bbox: [P3, P3] | null | undefined): number {
  if (!bbox) return 100;
  return Math.max(1, len(sub(bbox[1], bbox[0])));
}
