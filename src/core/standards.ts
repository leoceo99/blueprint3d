/**
 * 미터 나사용 구멍 규격표.
 * - 볼트 관통 구멍: ISO 273 (KS B 1007과 같은 값) 정밀(fine)·보통(medium)·거침(coarse)
 * - 탭 기초 구멍: 보통 나사(coarse pitch)의 드릴 지름 = 호칭 − 피치
 * - 카운터보어: 육각 구멍붙이 볼트(ISO 4762) 머리용 자리파기 (JIS B 1176 관례값)
 * - 카운터싱크: 접시머리 볼트(ISO 10642) 머리 지름 기준 90°
 * 기본값이며, 속성 패널에서 직접 고칠 수 있다.
 */
import type { HoleSpec } from "./types";

export interface ThreadRow {
  size: string;
  nominal: number;
  pitch: number;
  clearance: [fine: number, medium: number, coarse: number];
  tapDrill: number;
  cbDiameter: number;
  cbDepth: number;
  csDiameter: number;
}

export const THREADS: ThreadRow[] = [
  { size: "M2", nominal: 2, pitch: 0.4, clearance: [2.2, 2.4, 2.6], tapDrill: 1.6, cbDiameter: 4.4, cbDepth: 2.4, csDiameter: 4.4 },
  { size: "M2.5", nominal: 2.5, pitch: 0.45, clearance: [2.7, 2.9, 3.1], tapDrill: 2.05, cbDiameter: 5.5, cbDepth: 2.9, csDiameter: 5.5 },
  { size: "M3", nominal: 3, pitch: 0.5, clearance: [3.2, 3.4, 3.6], tapDrill: 2.5, cbDiameter: 6.5, cbDepth: 3.3, csDiameter: 6.8 },
  { size: "M4", nominal: 4, pitch: 0.7, clearance: [4.3, 4.5, 4.8], tapDrill: 3.3, cbDiameter: 8, cbDepth: 4.4, csDiameter: 9 },
  { size: "M5", nominal: 5, pitch: 0.8, clearance: [5.3, 5.5, 5.8], tapDrill: 4.2, cbDiameter: 9.5, cbDepth: 5.4, csDiameter: 11.3 },
  { size: "M6", nominal: 6, pitch: 1, clearance: [6.4, 6.6, 7], tapDrill: 5, cbDiameter: 11, cbDepth: 6.5, csDiameter: 13.5 },
  { size: "M8", nominal: 8, pitch: 1.25, clearance: [8.4, 9, 10], tapDrill: 6.8, cbDiameter: 14, cbDepth: 8.6, csDiameter: 18 },
  { size: "M10", nominal: 10, pitch: 1.5, clearance: [10.5, 11, 12], tapDrill: 8.5, cbDiameter: 17.5, cbDepth: 10.8, csDiameter: 22.5 },
  { size: "M12", nominal: 12, pitch: 1.75, clearance: [13, 13.5, 14.5], tapDrill: 10.2, cbDiameter: 20, cbDepth: 13, csDiameter: 27 },
  { size: "M16", nominal: 16, pitch: 2, clearance: [17, 17.5, 18.5], tapDrill: 14, cbDiameter: 26, cbDepth: 17.5, csDiameter: 33.6 },
  { size: "M20", nominal: 20, pitch: 2.5, clearance: [21, 22, 24], tapDrill: 17.5, cbDiameter: 32, cbDepth: 21.5, csDiameter: 40.3 },
];

export const PURPOSE_LABEL: Record<HoleSpec["purpose"], string> = {
  "clearance-close": "볼트 관통 (정밀)",
  "clearance-normal": "볼트 관통 (보통)",
  "clearance-loose": "볼트 관통 (거침)",
  tap: "탭 (나사)",
  custom: "직접 지정",
};

export const HEAD_LABEL: Record<HoleSpec["head"], string> = {
  none: "없음",
  counterbore: "카운터보어",
  countersink: "카운터싱크",
};

export function threadRow(size: string): ThreadRow | undefined {
  return THREADS.find((t) => t.size === size);
}

/** 규격에서 정해지는 구멍 지름. 직접 지정이면 null */
export function specDiameter(spec: HoleSpec): number | null {
  const t = threadRow(spec.size);
  if (!t || spec.purpose === "custom") return null;
  if (spec.purpose === "tap") return t.tapDrill;
  const i = spec.purpose === "clearance-close" ? 0 : spec.purpose === "clearance-normal" ? 1 : 2;
  return t.clearance[i];
}

/** 규격을 바꿀 때 머리 자리 치수를 표 값으로 채운다 */
export function withTableHead(spec: HoleSpec): HoleSpec {
  const t = threadRow(spec.size);
  if (!t) return spec;
  return { ...spec, cbDiameter: t.cbDiameter, cbDepth: t.cbDepth, csDiameter: t.csDiameter, csAngle: spec.csAngle ?? 90 };
}

/** 머리 자리를 포함한 가장 바깥 지름 (가장자리 거리 검사용) */
export function outerDiameter(d: number, spec?: HoleSpec): number {
  if (!spec) return d;
  if (spec.head === "counterbore" && spec.cbDiameter) return Math.max(d, spec.cbDiameter);
  if (spec.head === "countersink" && spec.csDiameter) return Math.max(d, spec.csDiameter);
  return d;
}

/**
 * 구멍 이름.
 * 자세히: "M5 관통구멍 Ø5.5 관통 · 카운터보어 Ø9.5 깊이 5.4", "M4 탭 깊이 8"
 * 짧게(트리용): "M5 관통구멍 · 카운터보어", "M4 탭 깊이 8"
 */
export function holeLabel(d: number, spec: HoleSpec | undefined, depth: number | undefined, short = false): string {
  const f = (n: number) => String(Math.round(n * 100) / 100);
  const dep = depth !== undefined ? ` 깊이 ${f(depth)}` : short ? "" : " 관통";
  const head = !spec ? "" : short ? (spec.head === "none" ? "" : ` · ${HEAD_LABEL[spec.head]}`) : headLabel(spec);
  if (!spec || spec.purpose === "custom") return `Ø${f(d)} 구멍${dep}${head}`;
  if (spec.purpose === "tap") return `${spec.size} 탭${dep}${head}`;
  return `${spec.size} 관통구멍${short ? "" : ` Ø${f(d)}`}${dep}${head}`;
}

function headLabel(spec: HoleSpec): string {
  const f = (n: number) => String(Math.round(n * 100) / 100);
  if (spec.head === "counterbore") return ` · 카운터보어 Ø${f(spec.cbDiameter ?? 0)} 깊이 ${f(spec.cbDepth ?? 0)}`;
  if (spec.head === "countersink") return ` · 카운터싱크 Ø${f(spec.csDiameter ?? 0)}×${f(spec.csAngle ?? 90)}°`;
  return "";
}
