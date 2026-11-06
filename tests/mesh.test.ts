import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAll } from "../src/core/build";
import { SAMPLES } from "../src/core/samples";
import { meshBBox, meshComponents, meshVolume, parseSTL, projectMesh, rotateQuarter } from "../src/core/mesh";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

const sample = (name: string) => structuredClone(SAMPLES.find((s) => s.name.startsWith(name))!);

async function stlOf(name: string, binary = true) {
  const { shape, result } = buildAll(sample(name));
  const blob = (shape as any).blobSTL({ binary, tolerance: 0.01, angularTolerance: 0.1 }) as Blob;
  return { buf: await blob.arrayBuffer(), result };
}

describe("STL 읽기", () => {
  it("이진 STL: 크기·부피가 CAD 결과와 같다", async () => {
    const { buf, result } = await stlOf("가이드");
    const m = parseSTL(buf);
    const bb = meshBBox(m);
    for (let i = 0; i < 2; i++) for (let k = 0; k < 3; k++) expect(bb[i][k]).toBeCloseTo(result.bbox[i][k], 2);
    expect(Math.abs(meshVolume(m) - result.volume) / result.volume).toBeLessThan(0.01);
    expect(meshComponents(m)).toBe(1);
  });

  it("텍스트 STL", async () => {
    const { buf, result } = await stlOf("L 브래킷", false);
    const m = parseSTL(buf);
    expect(Math.abs(meshVolume(m) - result.volume) / result.volume).toBeLessThan(0.01);
  });

  it("90° 돌리기: Z축으로 한 번 돌리면 X 길이와 Y 길이가 바뀐다", async () => {
    const { buf } = await stlOf("가이드");
    const m = parseSTL(buf);
    const [lo, hi] = meshBBox(rotateQuarter(m, [0, 0, 1]));
    expect(hi[0] - lo[0]).toBeCloseTo(40, 3);
    expect(hi[1] - lo[1]).toBeCloseTo(80, 3);
  });
});

describe("메쉬 3면도 (숨은선)", () => {
  it("외곽 크기가 CAD 투영과 같고, 구멍은 평면도에서 보이고 정면도에서 숨는다", async () => {
    const { buf, result } = await stlOf("마운팅");
    const m = parseSTL(buf);
    for (const v of ["front", "top", "side"] as const) {
      const p = projectMesh(m, v);
      const a = p.bounds!.flat().map((x) => Math.round(x * 10) / 10 + 0);
      const b = result.projections[v].bounds!.flat().map((x) => Math.round(x * 10) / 10 + 0);
      expect(a).toEqual(b);
      expect(p.visible.length).toBeGreaterThan(3);
    }
    // 평면도: 구멍 3개와 사각 구멍 → 보이는 선이 많다. 정면도: 구멍은 숨은선
    expect(projectMesh(m, "top").visible.length).toBeGreaterThan(30);
    expect(projectMesh(m, "front").hidden.length).toBeGreaterThan(2);
    expect(projectMesh(m, "top").hidden.length).toBe(0);
  });
});
