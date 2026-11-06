/**
 * 이미지 한 장 → 인식 결과까지 한 번에: 90° 돌리기 → (사진이면) 종이 펴기 → 조명 고르게 → 기울기 바로잡기 → 흑백 → 뷰·구멍 찾기.
 */
import { detect, type Analysis } from "./detect";
import { binarize, findPaper, normalize, skewAngle } from "./prep";
import { quadSize, resize, rotate, rotate90, warp, type Gray, type Mask, type P2 } from "./raster";

export interface PipelineOptions {
  /** 종이 네 모서리 (입력 이미지를 rotate90만큼 돌린 좌표). "auto"면 찾아 보고, null이면 펴지 않는다 */
  quad?: P2[] | "auto" | null;
  /** 시계 방향 90° 회전 횟수 */
  rotate90?: number;
  /** 기울기 바로잡기 (기본: 켬) */
  deskew?: boolean;
  /** 편 종이를 A 용지 비율(√2)에 맞추기 (기본: 비율이 비슷하면 맞춤) */
  paperAspect?: boolean;
  /** 처리 해상도: 긴 변 픽셀 (기본 3000) */
  maxSide?: number;
}

export interface PipelineResult {
  /** 처리된(편, 바로잡은, 고르게 한) 영상 */
  gray: Gray;
  ink: Mask;
  /** 쓴 종이 모서리 (돌린 입력 좌표). 펴지 않았으면 null */
  quad: P2[] | null;
  /** 바로잡은 기울기 (도) */
  angle: number;
  analysis: Analysis;
}

export function runPipeline(input: Gray, opts: PipelineOptions = {}): PipelineResult {
  const maxSide = opts.maxSide ?? 3000;
  let g = rotate90(input, opts.rotate90 ?? 0);
  const quad = opts.quad === "auto" || opts.quad === undefined ? findPaper(g) : opts.quad;
  if (quad) {
    let [w, h] = quadSize(quad, Math.min(maxSide, Math.max(g.w, g.h) * 1.1));
    // 비스듬히 찍으면 먼 쪽이 짧아 보여 가로세로 비가 틀어진다. A 용지(√2)에 가까우면 √2로 맞춘다
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (opts.paperAspect !== false && Math.abs(ratio - Math.SQRT2) / Math.SQRT2 < 0.15) {
      if (w >= h) h = Math.round(w / Math.SQRT2);
      else w = Math.round(h / Math.SQRT2);
    }
    g = warp(g, quad, w, h);
  } else if (Math.max(g.w, g.h) > maxSide) {
    const k = maxSide / Math.max(g.w, g.h);
    g = resize(g, Math.round(g.w * k), Math.round(g.h * k));
  }
  let n = normalize(g);
  let ink = binarize(n);
  let angle = 0;
  if (opts.deskew !== false) {
    angle = skewAngle(ink);
    if (angle) {
      n = rotate(n, -angle);
      ink = binarize(n);
    }
  }
  const analysis = detect(ink);
  return { gray: n, ink, quad, angle, analysis };
}
