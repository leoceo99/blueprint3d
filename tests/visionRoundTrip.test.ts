/**
 * 왕복 시험: 예제 3D → 도면(용지) → 이미지(8 px/mm) → 도면 인식 → 3D. 원래 부품과 같아야 한다.
 * (깊이·카운터보어처럼 한 뷰만 보고는 알 수 없는 정보는 비교하지 않는다)
 */
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAll } from "../src/core/build";
import { buildSheet } from "../src/core/sheet";
import { SAMPLES } from "../src/core/samples";
import { applyExpressions } from "../src/core/params";
import { binarize, normalize } from "../src/core/vision/prep";
import { detect } from "../src/core/vision/detect";
import { buildProject, defaultChoice } from "../src/core/vision/toProject";
import { rasterizeSheet } from "./visionDraw";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

const K = 8;

describe("예제 → 도면 이미지 → 다시 3D", () => {
  for (const sample of SAMPLES) {
    it(sample.name, () => {
      const orig = structuredClone(sample);
      applyExpressions(orig);
      const r0 = buildAll(orig).result;
      const sheet = buildSheet(r0, orig);
      const img = rasterizeSheet(sheet, K);
      const an = detect(binarize(normalize(img.g)));
      // 용지 기준 척도: 1 px = (용지 폭 / 이미지 폭) / 도면 척도
      const mmPerPx = sheet.width / img.w / sheet.scale;
      const { project } = buildProject(an, defaultChoice(an, mmPerPx, sample.name));
      expect(project.mode).toBe(orig.mode);
      const r1 = buildAll(project).result;
      const box0 = r0.bbox.flat().map((v) => Math.round(v * 2) / 2);
      const box1 = r1.bbox.flat().map((v) => Math.round(v * 2) / 2);
      // 위치는 원점을 잡는 방식이 달라 크기만 비교
      const size = (b: number[]) => [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
      expect(size(box1)).toEqual(size(box0));
      // 깊이 정보가 없는 예제는 부피도 같아야 한다
      const hasDepth = (["front", "top", "side"] as const).some((v) => orig.views[v].some((s) => s.depth !== undefined || (s.kind === "circle" && s.spec && s.spec.head !== "none")));
      if (!hasDepth) expect(Math.abs(r1.volume - r0.volume) / r0.volume).toBeLessThan(0.02);
      // 구멍 수: 원래 구멍(관통 기준)과 같은 수
      const holes = (p: typeof orig) => (["front", "top", "side"] as const).reduce((n, v) => n + p.views[v].filter((s) => s.hole).length, 0);
      if (orig.mode !== "revolve") expect(holes(project)).toBe(holes(orig));
    }, 60_000);
  }
});
