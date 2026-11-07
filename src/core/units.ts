/**
 * 길이 단위 (10단계): 안에서는 늘 mm로 저장하고, 화면 표시·입력만 문서 단위(mm 또는 inch)로.
 */
export type Unit = "mm" | "inch";
export const MM_PER_INCH = 25.4;

/** 지금 단위를 알려 주는 곳 (앱은 지금 부품의 단위로 연결한다) */
let source: () => Unit = () => "mm";
export const displayUnit = (): Unit => source();
export function setUnitSource(fn: () => Unit) {
  source = fn;
}
export const unitLabel = (u: Unit = source()) => (u === "inch" ? "in" : "mm");
/** mm → 표시 단위 */
export const toDisplay = (mm: number, u: Unit = source()) => (u === "inch" ? mm / MM_PER_INCH : mm);
/** 표시 단위 → mm */
export const fromDisplay = (v: number, u: Unit = source()) => (u === "inch" ? v * MM_PER_INCH : v);
/** 길이 숫자 (단위 글자 없이): mm는 소수 둘째, inch는 셋째 자리까지 */
export function fmtLen(mm: number, u: Unit = source()): string {
  const d = u === "inch" ? 1000 : 100;
  return String(Math.round(toDisplay(mm, u) * d) / d);
}
/** 길이 + 단위 글자 ("80 mm", "3.15 in") */
export const fmtLenU = (mm: number, u: Unit = source()) => `${fmtLen(mm, u)} ${unitLabel(u)}`;
/** 부피: mm는 cm³, inch는 in³ */
export function fmtVol(mm3: number, u: Unit = source()): string {
  if (u === "inch") return `${Math.round((mm3 / MM_PER_INCH ** 3) * 1000) / 1000} in³`;
  return `${Math.round((mm3 / 1000) * 100) / 100} cm³`;
}
/** 그냥 수 (각도 등) — 소수 둘째 자리 */
export const fmtNum = (n: number) => String(Math.round(n * 100) / 100);
