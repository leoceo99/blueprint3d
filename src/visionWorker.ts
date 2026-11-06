/// <reference lib="webworker" />
/** 도면 이미지 인식을 백그라운드에서 (큰 이미지도 화면이 멈추지 않게) */
import type { Analysis } from "./core/vision/detect";
import { runPipeline, type PipelineOptions } from "./core/vision/pipeline";
import { grayFromRGBA, rotate90, type P2 } from "./core/vision/raster";

export interface VisionRequest {
  id: number;
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  opts: PipelineOptions;
}

export type VisionResponse =
  | {
      id: number;
      ok: true;
      /** 처리한 영상 (밝기 0~255) */
      gray: Uint8ClampedArray;
      ink: Uint8Array;
      w: number;
      h: number;
      /** 돌린 입력 크기 */
      inW: number;
      inH: number;
      quad: P2[] | null;
      angle: number;
      analysis: Analysis;
      ms: number;
    }
  | { id: number; ok: false; error: string };

self.onmessage = (ev: MessageEvent<VisionRequest>) => {
  const { id, rgba, w, h, opts } = ev.data;
  const t0 = performance.now();
  try {
    const input = grayFromRGBA(rgba, w, h);
    const rot = rotate90(input, opts.rotate90 ?? 0);
    const r = runPipeline(input, opts);
    const gray = new Uint8ClampedArray(r.gray.d.length);
    for (let i = 0; i < gray.length; i++) gray[i] = r.gray.d[i] * 255;
    const msg: VisionResponse = {
      id,
      ok: true,
      gray,
      ink: r.ink.d,
      w: r.gray.w,
      h: r.gray.h,
      inW: rot.w,
      inH: rot.h,
      quad: r.quad,
      angle: r.angle,
      analysis: r.analysis,
      ms: Math.round(performance.now() - t0),
    };
    (self as unknown as Worker).postMessage(msg, [gray.buffer, r.ink.d.buffer]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((e as Error)?.message ?? e) } satisfies VisionResponse);
  }
};
