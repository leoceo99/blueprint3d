/**
 * 형상 특징의 자료형 (11단계) — 화면 쪽(도면 치수)과 워커(형상 읽기)가 같이 쓴다.
 * 3D 엔진(replicad)을 불러오지 않도록 계산 코드(features3d.ts)와 나눠 둔다.
 */
export type Axis = 0 | 1 | 2;
export type P3 = [number, number, number];

/** 축 k를 따라 보는 뷰의 가로·세로 축 (측면도 Y·Z, 정면도 X·Z, 평면도 X·Y) */
export const PERP: Record<Axis, [Axis, Axis]> = { 0: [1, 2], 1: [0, 2], 2: [0, 1] };

export interface CylFeat {
  axis: Axis;
  /** 축이 지나는 점 (축 방향 뷰의 가로·세로 좌표) */
  p: [number, number];
  r: number;
  /** 축 방향 범위 */
  t0: number;
  t1: number;
  /** 원호가 차지하는 각도 (축 방향 뷰에서 반시계, 라디안). sweep ≥ 2π·0.98 이면 한 바퀴 */
  a0: number;
  sweep: number;
  /** 오목(구멍·안쪽 필렛) / 볼록(보스·바깥 둥근 모서리) */
  concave: boolean;
  /** 면 위의 한 점 (지시선 끝) */
  mid: P3;
}

export interface ConeFeat {
  axis: Axis;
  p: [number, number];
  t0: number;
  t1: number;
  /** t0·t1에서의 반지름 */
  r0: number;
  r1: number;
  /** 원뿔 반각 (도) */
  semi: number;
  concave: boolean;
  mid: P3;
}

/** 기울어진 평면 (한 축 along과 나란함 → 그 축 방향 뷰에서 비스듬한 선으로 보임) */
export interface SlopeFeat {
  along: Axis;
  /** 면이 걸친 두 축 (작은 번호 먼저)과 각 축 방향 길이 */
  axes: [Axis, Axis];
  legs: [number, number];
  /** 두 축 좌표 범위의 시작 (뷰 좌표) */
  lo: [number, number];
  t0: number;
  t1: number;
  mid: P3;
}

/** 원환 — 회전체 모서리 R (축 방향 단면에서 원호) */
export interface TorusFeat {
  axis: Axis;
  p: [number, number];
  /** 큰 반지름(축에서 관 중심까지), 작은 반지름(= R) */
  R: number;
  r: number;
  /** 관 중심의 축 방향 위치 */
  t: number;
  concave: boolean;
  mid: P3;
}

export interface Features3D {
  /** 축마다 그 축에 수직인 평면이 놓인 위치 (작은 것부터, 모델 끝 포함) */
  levels: [number[], number[], number[]];
  cyl: CylFeat[];
  cones: ConeFeat[];
  slopes: SlopeFeat[];
  tori: TorusFeat[];
  /** 읽지 못한 면 수 (자유 곡면, 비스듬한 원통 등) */
  other: number;
}

const FULL = 2 * Math.PI * 0.98;
export const isFull = (c: CylFeat) => c.sweep >= FULL;
