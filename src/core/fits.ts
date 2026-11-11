/**
 * 끼워맞춤 공차 (ISO 286-1·2 = KS B 0401): 기본 공차 IT5~IT11과 기초 편차로 “Ø20 H7”의 위·아래 치수 허용차를 계산한다.
 * 값은 µm. 지름 범위 0~500 mm. 표에 없는 조합(예: K11)은 null.
 *
 * 구멍: H(아래 0), G·F·E·D(아래 = 같은 글자 축의 위 편차를 뒤집은 값), JS(±IT/2), K7·M7·N7·P7(표)
 * 축:   h(위 0), g·f·e·d(위 편차), js(±IT/2), k·m·n·p(아래 편차, 5~7급)
 */

/** 지름 범위 위쪽 끝 (mm) — 0~3, 3~6, 6~10, … 400~500 */
const SIZES = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];

/** 기본 공차 (µm) */
const IT: Record<number, number[]> = {
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
};

/** 축의 위 편차 es (µm, 음수) */
const ES_SHAFT: Record<string, number[]> = {
  d: [-20, -30, -40, -50, -65, -80, -100, -120, -145, -170, -190, -210, -230],
  e: [-14, -20, -25, -32, -40, -50, -60, -72, -85, -100, -110, -125, -135],
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50, -56, -62, -68],
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20],
  h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

/** 축의 아래 편차 ei (µm) — 5~7급 */
const EI_SHAFT: Record<string, number[]> = {
  k: [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5],
  m: [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68],
};

/** 7급 구멍의 위 편차 ES (µm) — K7·M7·N7·P7 */
const ES_HOLE7: Record<string, number[]> = {
  K: [0, 3, 5, 6, 6, 7, 9, 10, 12, 13, 16, 17, 18],
  M: [-2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  N: [-4, -4, -4, -5, -7, -8, -9, -10, -12, -14, -14, -16, -17],
  P: [-6, -8, -9, -11, -14, -17, -21, -24, -28, -33, -36, -41, -45],
};

/** 자주 쓰는 끼워맞춤 (고르기 목록) */
export const COMMON_FITS = ["H7", "H8", "H9", "H11", "G7", "F8", "JS7", "K7", "N7", "P7", "h6", "h7", "h9", "g6", "f7", "e8", "js6", "k6", "m6", "n6", "p6"];

export interface Deviation {
  /** 위 치수 허용차 (mm) */
  up: number;
  /** 아래 치수 허용차 (mm) */
  lo: number;
}

function sizeIndex(d: number): number {
  // 3D에서 잰 값의 작은 오차(50.000002)가 다음 칸으로 넘어가지 않게
  if (!(d > 0) || d > 500 + 1e-4) return -1;
  return SIZES.findIndex((s) => d <= s + 1e-4);
}

/** “H7”, “g6”, “JS7” → 위·아래 허용차 (mm). 못 구하면 null */
export function fitDeviation(nominal: number, code: string): Deviation | null {
  const m = code.trim().match(/^(js|JS|[a-zA-Z])(\d{1,2})$/);
  if (!m) return null;
  const letter = m[1];
  const grade = Number(m[2]);
  const i = sizeIndex(nominal);
  if (i < 0 || !IT[grade]) return null;
  const it = IT[grade][i];
  const um = (up: number, lo: number): Deviation => ({ up: up / 1000, lo: lo / 1000 });
  if (letter === "js" || letter === "JS") return um(it / 2, -it / 2);
  const hole = letter === letter.toUpperCase();
  const l = letter.toLowerCase();
  if (hole) {
    if (l === "h") return um(it, 0);
    if (ES_SHAFT[l]) {
      const ei = -ES_SHAFT[l][i];
      return um(ei + it, ei);
    }
    if (ES_HOLE7[letter] && grade === 7) {
      const es = ES_HOLE7[letter][i];
      return um(es, es - it);
    }
    return null;
  }
  if (ES_SHAFT[l]) {
    const es = ES_SHAFT[l][i];
    return um(es, es - it);
  }
  if (EI_SHAFT[l] && grade >= 5 && grade <= 7) {
    const ei = EI_SHAFT[l][i];
    return um(ei + it, ei);
  }
  return null;
}

/** 허용차 글자: +0.021 · 0 · −0.007 (mm, 소수 셋째 자리까지, 끝 0은 뺌) */
export function fmtDev(x: number): string {
  if (Math.abs(x) < 5e-7) return "0";
  const s = (Math.round(Math.abs(x) * 1000) / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return (x > 0 ? "+" : "−") + s;
}

/** 일반 공차 (KS B ISO 2768-1) 등급 */
export const GENERAL_TOLERANCES = ["KS B ISO 2768-f", "KS B ISO 2768-m", "KS B ISO 2768-c", "KS B ISO 2768-v"];
