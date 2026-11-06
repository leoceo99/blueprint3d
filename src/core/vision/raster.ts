/**
 * 도면 이미지 처리의 기본 자료형과 연산 (화면과 무관, 테스트 가능).
 * Gray: 밝기 0(검정)~1(흰색), Mask: 1이면 켜짐. 좌표는 픽셀 (x 오른쪽, y 아래).
 */
export interface Gray {
  w: number;
  h: number;
  d: Float32Array;
}
export interface Mask {
  w: number;
  h: number;
  d: Uint8Array;
}
export type P2 = [number, number];

export const gray = (w: number, h: number, fill = 1): Gray => ({ w, h, d: new Float32Array(w * h).fill(fill) });
export const mask = (w: number, h: number): Mask => ({ w, h, d: new Uint8Array(w * h) });

export function grayFromRGBA(rgba: ArrayLike<number>, w: number, h: number): Gray {
  const g = gray(w, h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    // 투명한 곳은 흰 종이로 본다
    const l = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    g.d[i] = l * a + (1 - a);
  }
  return g;
}

/** 크기 바꾸기: 줄일 때는 면적 평균, 키울 때는 쌍선형 */
export function resize(g: Gray, w2: number, h2: number): Gray {
  const out = gray(w2, h2);
  const sx = g.w / w2;
  const sy = g.h / h2;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < h2; y++) {
      const y0 = y * sy;
      const y1 = y0 + sy;
      for (let x = 0; x < w2; x++) {
        const x0 = x * sx;
        const x1 = x0 + sx;
        let sum = 0;
        let area = 0;
        for (let yy = Math.floor(y0); yy < Math.min(g.h, Math.ceil(y1)); yy++) {
          const fy = Math.min(y1, yy + 1) - Math.max(y0, yy);
          for (let xx = Math.floor(x0); xx < Math.min(g.w, Math.ceil(x1)); xx++) {
            const f = fy * (Math.min(x1, xx + 1) - Math.max(x0, xx));
            sum += g.d[yy * g.w + xx] * f;
            area += f;
          }
        }
        out.d[y * w2 + x] = area ? sum / area : 1;
      }
    }
    return out;
  }
  for (let y = 0; y < h2; y++)
    for (let x = 0; x < w2; x++) out.d[y * w2 + x] = sample(g, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
  return out;
}

/** 쌍선형 표본 (밖은 흰색) */
export function sample(g: Gray, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= g.w || yy >= g.h ? 1 : g.d[yy * g.w + xx]);
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy
  );
}

/** 가운데를 중심으로 deg만큼 돌린다 (시계 반대, 화면 기준). 크기는 그대로 */
export function rotate(g: Gray, deg: number): Gray {
  const out = gray(g.w, g.h);
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const cx = (g.w - 1) / 2;
  const cy = (g.h - 1) / 2;
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      // 출력 (x,y) ← 입력: 반대로 돌린 위치 (y가 아래쪽이라 화면에서 시계 반대가 되도록)
      const dx = x - cx;
      const dy = y - cy;
      out.d[y * g.w + x] = sample(g, cx + c * dx - s * dy, cy + s * dx + c * dy);
    }
  return out;
}

/** 90°의 배수로 돌리기 (k = 1이면 시계 방향 90°) */
export function rotate90(g: Gray, k: number): Gray {
  k = ((k % 4) + 4) % 4;
  if (!k) return g;
  const w2 = k % 2 ? g.h : g.w;
  const h2 = k % 2 ? g.w : g.h;
  const out = gray(w2, h2);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const [x2, y2] = k === 1 ? [g.h - 1 - y, x] : k === 2 ? [g.w - 1 - x, g.h - 1 - y] : [y, g.w - 1 - x];
      out.d[y2 * w2 + x2] = g.d[y * g.w + x];
    }
  return out;
}

/** 네 점 → 네 점 원근 변환 (3×3, h[8] = 1) */
export function homography(src: P2[], dst: P2[]): number[] {
  // dst = H · src 를 푼다 (8개 미지수)
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

export function applyH(H: number[], p: P2): P2 {
  const z = H[6] * p[0] + H[7] * p[1] + H[8];
  return [(H[0] * p[0] + H[1] * p[1] + H[2]) / z, (H[3] * p[0] + H[4] * p[1] + H[5]) / z];
}

/** 가우스 소거 (부분 피벗) */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (M[i][i] || 1e-12));
}

/** 원래 이미지의 사각형(왼위, 오위, 오아래, 왼아래)을 w×h 직사각형으로 편다 */
export function warp(g: Gray, quad: P2[], w: number, h: number): Gray {
  const H = homography(
    [
      [0, 0],
      [w - 1, 0],
      [w - 1, h - 1],
      [0, h - 1],
    ],
    quad,
  );
  const out = gray(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [sx, sy] = applyH(H, [x, y]);
      out.d[y * w + x] = sample(g, sx, sy);
    }
  return out;
}

/** 사각형 네 변 길이로 펼친 크기 정하기 (긴 쪽 maxSide) */
export function quadSize(quad: P2[], maxSide: number): [number, number] {
  const len = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const wq = (len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2;
  const hq = (len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2;
  const k = maxSide / Math.max(wq, hq);
  return [Math.max(8, Math.round(wq * k)), Math.max(8, Math.round(hq * k))];
}
