/**
 * 재질과 밀도 (13.7): 부품 무게 = 부피 × 밀도. 밀도는 흔히 쓰는 대표값 (g/cm³).
 * sheet는 도면 표제란에 쓰는 재질 기호.
 */
import type { Project } from "./types";

export interface Material {
  label: string;
  density: number;
  sheet: string;
}

export const MATERIALS: Record<string, Material> = {
  steel: { label: "철 — 탄소강 S45C", density: 7.85, sheet: "S45C" },
  ss400: { label: "철 — 일반 구조용강 SS275(SS400)", density: 7.85, sheet: "SS275" },
  sus304: { label: "스테인리스 SUS304", density: 7.93, sheet: "SUS304" },
  cast: { label: "주철 GC250 (FC250)", density: 7.2, sheet: "GC250" },
  al6061: { label: "알루미늄 A6061", density: 2.7, sheet: "A6061-T6" },
  al5052: { label: "알루미늄 A5052 (판금)", density: 2.68, sheet: "A5052" },
  brass: { label: "황동 C3604", density: 8.5, sheet: "C3604" },
  copper: { label: "구리 C1100", density: 8.96, sheet: "C1100" },
  ti: { label: "티타늄 Ti-6Al-4V", density: 4.43, sheet: "Ti-6Al-4V" },
  abs: { label: "ABS (플라스틱)", density: 1.04, sheet: "ABS" },
  pla: { label: "PLA (3D 프린팅)", density: 1.24, sheet: "PLA" },
  petg: { label: "PETG (3D 프린팅)", density: 1.27, sheet: "PETG" },
  pa6: { label: "나일론 PA6", density: 1.14, sheet: "PA6" },
  pom: { label: "POM (아세탈)", density: 1.41, sheet: "POM" },
  pmma: { label: "아크릴 PMMA", density: 1.18, sheet: "PMMA" },
  pc: { label: "폴리카보네이트 PC", density: 1.2, sheet: "PC" },
  rubber: { label: "고무 NBR", density: 1.0, sheet: "NBR" },
  glass: { label: "유리", density: 2.5, sheet: "GLASS" },
  wood: { label: "목재 (참나무)", density: 0.75, sheet: "WOOD" },
};

/** 부품의 밀도 (g/cm³). 재질이 없으면 null */
export function densityOf(p: Project): number | null {
  if (p.material === "custom") return p.density && p.density > 0 ? p.density : null;
  return p.material ? (MATERIALS[p.material]?.density ?? null) : null;
}

/** 표제란에 쓸 재질 기호 */
export function materialSheet(p: Project): string {
  if (p.material === "custom") return p.density ? `ρ ${p.density}` : "";
  return p.material ? (MATERIALS[p.material]?.sheet ?? "") : "";
}

/** 무게 (g): 부피 mm³ × 밀도 g/cm³ ÷ 1000 */
export const massOf = (volumeMm3: number, density: number) => (volumeMm3 * density) / 1000;

export function fmtMass(g: number): string {
  if (g >= 1000) return `${(g / 1000).toFixed(g >= 100000 ? 1 : 3)} kg`;
  return `${g >= 100 ? g.toFixed(1) : g.toFixed(2)} g`;
}

/** 저장된 값 검사 */
export function normalizeMaterial(out: Record<string, unknown>) {
  const m = out.material;
  if (!(typeof m === "string" && (m === "custom" || m in MATERIALS))) delete out.material;
  if (!(out.material === "custom" && typeof out.density === "number" && out.density > 0 && Number.isFinite(out.density))) delete out.density;
}
