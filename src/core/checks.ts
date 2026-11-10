/**
 * 규칙 기반 설계 검사 (즉시 실행, 비용 없음).
 * AI 검토는 이 결과를 함께 받아서 중복 없이 더 깊은 문제를 찾는다.
 */
import { isViewSlot } from "./featureModel";
import { boundsOf, distToBoundary, flatten, isDegenerate, normRect, pointInShape, rectPoints, shapeCenter } from "./geometry2d";
import { analyzeView, KIND_LABEL } from "./constraints";
import { applyExpressions, projUnit } from "./params";
import { fmtLen, fmtLenU, type Unit } from "./units";
import { outerDiameter } from "./standards";
export { distToBoundary };
import type { BuildResult, Finding, FindingRef, Process, Project, Shape2D, ViewId } from "./types";
import { VIEW_AXES, VIEW_IDS, VIEW_LABEL } from "./types";

type Pt = [number, number];

export interface ProcessRules {
  /** 최소 벽 두께 (mm) */
  minWall: number;
  /** 최소 구멍 지름 (mm) */
  minHole: number;
  /** 드릴 가공 가능한 깊이/지름 비 (없으면 검사 안 함) */
  maxDepthRatio?: number;
  /** 엔드밀 가공이라 내부 모서리가 둥글어짐 */
  sharpInnerCornerNote: boolean;
  /** 판재: 구멍 지름 ≥ 두께 × 이 값 */
  holeVsThickness?: number;
  /** 판재: 구멍~가장자리 ≥ 두께 × 이 값 */
  edgeVsThickness?: number;
  /** 포켓 깊이/폭 한계 (엔드밀) */
  maxPocketRatio?: number;
}

export const PROCESS_RULES: Record<Process, ProcessRules> = {
  cnc: { minWall: 1.0, minHole: 1.0, maxDepthRatio: 10, sharpInnerCornerNote: true, maxPocketRatio: 4 },
  print3d: { minWall: 1.2, minHole: 2.0, sharpInnerCornerNote: false },
  laser: { minWall: 1.0, minHole: 1.0, sharpInnerCornerNote: false, holeVsThickness: 1, edgeVsThickness: 1 },
};

const f2 = (n: number) => String(Math.round(n * 100) / 100);
/** 길이 표시 (부품 단위). runChecks가 시작할 때 단위를 정한다 */
let U: Unit = "mm";
const fl = (n: number) => fmtLen(n, U);
const fu = (n: number) => fmtLenU(n, U);

// ---------------- 기하 유틸 ----------------

/** 도형 경계 위의 표본점 (원호 구간 포함) */
export function boundarySamples(s: Shape2D): Pt[] {
  const pts = flatten(s, Math.PI / 12);
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.min(12, Math.ceil(len / 2)));
    for (let j = 0; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  return out;
}

function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function selfIntersects(pts: Pt[]): Pt | null {
  const n = pts.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [a, b] = [pts[i], pts[(i + 1) % n]];
      const [c, d] = [pts[j], pts[(j + 1) % n]];
      if (segIntersect(a, b, c, d)) return [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4];
    }
  return null;
}

function shapeName(s: Shape2D): string {
  if (s.kind === "circle") return `Ø${fl(s.r * 2)} 원`;
  if (s.kind === "rect") {
    const r = normRect(s);
    return `${fl(r.w)}×${fl(r.h)} 사각형`;
  }
  if (s.kind === "slot") return `폭 ${fl(s.w)} 장공`;
  return `다각형(${s.pts.length}점)`;
}

/** 어느 뷰의 시선 방향 축 (그 뷰에서 깊이가 되는 축) */
const DEPTH_AXIS: Record<ViewId, 0 | 1 | 2> = { front: 1, top: 2, side: 0 };

// ---------------- 검사 ----------------

export function runChecks(p: Project, build?: Pick<BuildResult, "bbox" | "solidCount"> | null, buildError?: string): Finding[] {
  U = projUnit(p);
  const rules = PROCESS_RULES[p.process ?? "cnc"];
  const out: Finding[] = [];
  const add = (f: Omit<Finding, "source">) => {
    if (!out.some((o) => o.id === f.id)) out.push({ ...f, source: "rule" });
  };
  const viewsToCheck = VIEW_IDS;

  // 변수·치수 식 오류
  for (const prob of applyExpressions(structuredClone(p)).problems) {
    const isParam = prob.key.startsWith("param:");
    const feat = prob.featureId ? p.features?.find((f) => f.id === prob.featureId) : undefined;
    const where = prob.view === undefined ? "" : isViewSlot(prob.view) ? VIEW_LABEL[prob.view] : (p.features?.find((f) => f.id === prob.view)?.name ?? "스케치");
    add({
      id: `expr:${prob.featureId ?? prob.view ?? ""}:${prob.shapeId ?? ""}:${prob.key}`,
      severity: "error",
      category: "변수",
      title: isParam ? `변수 ${prob.key.slice(6)} 식 오류` : prob.key === "thickness" ? "두께 식 오류" : feat ? `${feat.name} 식 오류` : "치수 식 오류",
      detail: prob.message + (isParam || prob.key === "thickness" ? "" : feat ? ` (${prob.key})` : ` (${where}, ${prob.key})`),
      suggestion: "식이나 변수 이름을 확인하세요. 오류가 난 치수는 마지막으로 계산된 값을 그대로 씁니다.",
      refs: prob.view && isViewSlot(prob.view) && prob.shapeId ? [{ view: prob.view, shapeId: prob.shapeId }] : [],
    });
  }

  // 구속 (10단계): 풀리지 않는 구속은 오류, 필요 없는(중복) 구속은 참고
  for (const v of VIEW_IDS) {
    const list = p.constraints?.[v];
    if (!list?.length) continue;
    const an = analyzeView(p, v);
    const shapesOf = (id: string) =>
      (list.find((c) => c.id === id)?.refs ?? []).filter((r) => !r.s.startsWith("@")).map((r) => ({ view: v, shapeId: r.s }));
    for (const id of an.unsatisfied) {
      const c = list.find((x) => x.id === id)!;
      add({
        id: `cons-bad:${v}:${id}`,
        severity: "error",
        category: "구속",
        title: `지켜지지 않는 구속: ${KIND_LABEL[c.kind]}`,
        detail: `${VIEW_LABEL[v]}의 ‘${KIND_LABEL[c.kind]}’ 구속이 다른 조건과 부딪쳐 풀리지 않아요.`,
        suggestion: "부딪치는 구속을 지우거나 치수 값을 바꾸세요 (구속 기호를 누르고 Delete).",
        refs: shapesOf(id),
      });
    }
    for (const id of an.redundant) {
      if (an.unsatisfied.includes(id)) continue;
      const c = list.find((x) => x.id === id)!;
      add({
        id: `cons-dup:${v}:${id}`,
        severity: "info",
        category: "구속",
        title: `필요 없는 구속: ${KIND_LABEL[c.kind]}`,
        detail: `${VIEW_LABEL[v]}의 ‘${KIND_LABEL[c.kind]}’ 구속은 다른 구속으로 이미 정해져 있어요(중복). 지금은 문제없지만 나중에 값을 바꿀 때 부딪칠 수 있어요.`,
        suggestion: "필요 없으면 지우세요.",
        refs: shapesOf(id),
      });
    }
  }

  if (buildError)
    add({
      id: "build-error",
      severity: "error",
      category: "형상",
      title: "3D 형상을 만들 수 없음",
      detail: buildError,
      refs: [],
    });

  if (build && build.solidCount > 1)
    add({
      id: "multi-solid",
      severity: "error",
      category: "형상",
      title: `서로 떨어진 덩어리 ${build.solidCount}개`,
      detail: "결과 3D가 하나로 이어져 있지 않습니다. 한 부품으로는 만들 수 없어요.",
      suggestion: "떨어진 부분을 잇는 몸체를 추가하거나, 뷰끼리 겹치는 범위를 다시 확인하세요.",
      refs: [],
    });

  // 1) 뷰 사이 치수 일관성 (3각법: 정면-평면은 X, 정면-측면은 Z, 평면-측면은 Y를 공유)
  if (p.mode === "auto") {
    const pairs: [ViewId, ViewId][] = [
      ["front", "top"],
      ["front", "side"],
      ["top", "side"],
    ];
    for (const [a, b] of pairs) {
      const ba = boundsOf(p.views[a]);
      const bb = boundsOf(p.views[b]);
      if (!ba || !bb) continue;
      const shared = VIEW_AXES[a].find((ax) => VIEW_AXES[b].includes(ax))!;
      const ra = VIEW_AXES[a][0] === shared ? [ba[0], ba[2]] : [ba[1], ba[3]];
      const rb = VIEW_AXES[b][0] === shared ? [bb[0], bb[2]] : [bb[1], bb[3]];
      if (Math.abs(ra[0] - rb[0]) > 0.01 || Math.abs(ra[1] - rb[1]) > 0.01) {
        const lo = Math.max(ra[0], rb[0]);
        const hi = Math.min(ra[1], rb[1]);
        const axisName = { X: "폭(X)", Y: "깊이(Y)", Z: "높이(Z)" }[shared];
        add({
          id: `extent:${a}:${b}`,
          severity: "warning",
          category: "도면 일관성",
          title: `${VIEW_LABEL[a]}와 ${VIEW_LABEL[b]}의 ${axisName} 범위가 다름`,
          detail:
            `${VIEW_LABEL[a]} ${shared} ${fl(ra[0])}~${fu(ra[1])}, ${VIEW_LABEL[b]} ${shared} ${fl(rb[0])}~${fu(rb[1])}. ` +
            (lo < hi
              ? `두 뷰가 겹치는 ${fl(lo)}~${fu(hi)} 범위만 3D로 남습니다.`
              : "두 뷰가 전혀 겹치지 않아 3D가 비게 됩니다."),
          suggestion: "같은 축의 치수가 뷰마다 같도록 맞추세요. 주황 점선(다른 뷰 기준선)에 맞춰 그리면 됩니다.",
          refs: [{ view: a }, { view: b }],
        });
      }
    }
  }

  if (p.mode === "auto" && VIEW_IDS.filter((v) => boundsOf(p.views[v])).length === 1 && p.thickness < rules.minWall)
    add({
      id: "thin-plate",
      severity: "warning",
      category: "가공성",
      title: `판 두께 ${fu(p.thickness)}가 너무 얇음`,
      detail: `현재 제조 방식의 최소 두께 기준은 ${fu(rules.minWall)}입니다.`,
      suggestion: `두께를 ${fu(rules.minWall)} 이상으로 늘리세요.`,
      refs: [],
    });

  for (const v of viewsToCheck) {
    const shapes = p.views[v].filter((s) => !isDegenerate(s));
    const solids = shapes.filter((s) => !s.hole);
    const holes = shapes.filter((s) => s.hole);
    const ref = (s: Shape2D, pt?: Pt): FindingRef => ({ view: v, shapeId: s.id, u: pt?.[0], v: pt?.[1] });

    // 2) 다각형 자체 교차, 아주 짧은 변 (꼬인 다각형은 넓이가 0이 될 수 있어 전체 도형에서 검사)
    for (const s of p.views[v]) {
      if (s.kind !== "poly") continue;
      const x = selfIntersects(s.pts);
      if (x)
        add({
          id: `self-x:${v}:${s.id}`,
          severity: "error",
          category: "스케치",
          title: "다각형 선이 서로 교차함",
          detail: `${VIEW_LABEL[v]}의 ${shapeName(s)} 외곽선이 스스로 꼬여 있어 면을 만들 수 없습니다.`,
          suggestion: "꼭짓점 순서를 바로잡아 선이 겹치지 않게 하세요.",
          refs: [ref(s, x)],
        });
      s.pts.forEach((a, i) => {
        const b = s.pts[(i + 1) % s.pts.length];
        if (s.bulges?.[i]) return;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len > 0 && len < 0.2)
          add({
            id: `tiny-edge:${v}:${s.id}:${i}`,
            severity: "info",
            category: "스케치",
            title: `아주 짧은 변 ${fu(len)}`,
            detail: `${VIEW_LABEL[v]}의 ${shapeName(s)}에 실수로 찍힌 것 같은 짧은 변이 있습니다.`,
            suggestion: "의도한 것이 아니면 꼭짓점을 지우세요.",
            refs: [ref(s, a)],
          });
      });
    }

    // 3) 얇은 몸체 (사각형)
    for (const s of solids) {
      if (s.kind !== "rect") continue;
      const r = normRect(s);
      const m = Math.min(r.w, r.h);
      if (m < rules.minWall)
        add({
          id: `thin-rect:${v}:${s.id}`,
          severity: "warning",
          category: "가공성",
          title: `너무 얇은 부분 ${fu(m)}`,
          detail: `${VIEW_LABEL[v]}의 ${shapeName(s)}가 최소 벽 두께 기준(${fu(rules.minWall)})보다 얇습니다.`,
          suggestion: `${fu(rules.minWall)} 이상으로 두껍게 하세요.`,
          refs: [ref(s, [r.x + r.w / 2, r.y + r.h / 2])],
        });
    }

    // 4) 구멍 검사
    // 몸체를 그린 뷰에서만 "구멍이 몸체 안에 있는지"를 따질 수 있다 (회전체 모드는 정면도만)
    const bodyView = solids.length > 0 && (p.mode === "auto" || v === "front");
    const ax = DEPTH_AXIS[v];
    // 그 뷰의 시선 방향으로 잰 부품 두께
    const extent = build ? build.bbox[1][ax] - build.bbox[0][ax] : p.mode === "auto" ? p.thickness : null;
    for (const h of holes) {
      // 머리 자리(카운터보어·카운터싱크)까지 포함한 바깥 모양으로 가장자리를 잰다
      const foot = footprint(h);
      const samples = boundarySamples(foot);
      const inside = samples.map((pt) => solids.filter((s) => pointInShape(pt[0], pt[1], s)));
      const outCount = inside.filter((l) => l.length === 0).length;
      if (!bodyView) {
        // 몸체가 없는 뷰의 구멍은 3D에 바로 뚫으므로 위치 검사 생략
      } else if (outCount === samples.length) {
        add({
          id: `hole-out:${v}:${h.id}`,
          severity: "error",
          category: "구멍",
          title: "몸체 밖에 있는 구멍",
          detail: `${VIEW_LABEL[v]}의 ${shapeName(h)}(구멍)이 몸체와 겹치지 않아 아무 효과가 없습니다.`,
          suggestion: "구멍을 몸체 안으로 옮기거나, 몸체로 바꾸세요.",
          refs: [ref(h, samples[0])],
        });
        continue;
      } else if (outCount > 0) {
        const pt = samples[inside.findIndex((l) => l.length === 0)];
        if (h.depth !== undefined)
          add({
            id: `hole-step:${v}:${h.id}`,
            severity: "info",
            category: "형상",
            title: "가장자리에 걸친 포켓 = 단차(계단)",
            detail: `${VIEW_LABEL[v]}의 ${shapeName(h)}이 가장자리에 걸쳐 있어 깊이 ${fu(h.depth)}의 계단 모양으로 깎입니다.`,
            suggestion: "의도한 단차라면 그대로 두세요.",
            refs: [ref(h, pt)],
          });
        else
          add({
            id: `hole-cross:${v}:${h.id}`,
            severity: "warning",
            category: "구멍",
            title: "구멍이 몸체 가장자리를 벗어남",
            detail: `${VIEW_LABEL[v]}의 ${shapeName(h)}이 가장자리에 걸쳐 있어 구멍이 아니라 홈(노치)이 됩니다.`,
            suggestion: "의도한 홈이면 그대로 두고, 구멍이라면 안쪽으로 옮기세요.",
            refs: [ref(h, pt)],
          });
      }
      // 구멍 ~ 가장자리 벽 두께 (몸체가 여러 개면 가장 여유 있는 쪽 기준)
      let wall = Infinity;
      let at: Pt = samples[0];
      if (bodyView && outCount === 0)
        samples.forEach((pt, i) => {
          const w = Math.max(...inside[i].map((s) => distToBoundary(pt, s)));
          if (w < wall) {
            wall = w;
            at = pt;
          }
        });
      const size = h.kind === "circle" ? h.r * 2 : h.kind === "slot" ? h.w : Math.min(normRectOrBox(h).w, normRectOrBox(h).h);
      const t = p.thickness;
      let minEdge = rules.minWall;
      let why = `최소 벽 두께 ${fu(rules.minWall)}`;
      if (rules.edgeVsThickness && t * rules.edgeVsThickness > minEdge) {
        minEdge = t * rules.edgeVsThickness;
        why = `판 두께(${fu(t)}) 이상`;
      }
      const footSize = foot.kind === "circle" ? foot.r * 2 : size;
      if (h.kind === "circle" && p.process !== "laser" && footSize * 0.5 > minEdge) {
        minEdge = footSize * 0.5;
        why = `${foot !== h ? "머리 자리" : "구멍"} 지름의 0.5배(${fu(minEdge)}) 이상`;
      }
      if (wall < minEdge - 1e-6)
        add({
          id: `hole-edge:${v}:${h.id}`,
          severity: wall < rules.minWall || wall < minEdge * 0.75 ? "warning" : "info",
          category: "구멍",
          title: `구멍과 가장자리 사이가 ${fu(wall)}로 좁음`,
          detail: `${VIEW_LABEL[v]}의 ${shapeName(h)} 바깥 벽이 얇아 가공 중 찢어지거나 휘기 쉽습니다. 권장: ${why}.`,
          suggestion: "구멍을 안쪽으로 옮기거나 구멍을 작게, 또는 몸체를 넓히세요.",
          refs: [ref(h, at)],
        });

      if (size < rules.minHole)
        add({
          id: `hole-small:${v}:${h.id}`,
          severity: "warning",
          category: "구멍",
          title: `너무 작은 구멍 ${fu(size)}`,
          detail: `현재 제조 방식의 최소 구멍 크기는 ${rules.minHole}mm입니다.`,
          suggestion: `${rules.minHole}mm 이상으로 키우세요.`,
          refs: [ref(h, samples[0])],
        });

      if (h.depth !== undefined && extent !== null && h.depth >= extent - 1e-6)
        add({
          id: `depth-through:${v}:${h.id}`,
          severity: "info",
          category: "형상",
          title: `깊이 ${fu(h.depth)}가 두께 ${fu(extent)} 이상이라 관통됨`,
          detail: `${VIEW_LABEL[v]}의 ${shapeName(h)}은 깊이를 지정했지만 부품을 끝까지 뚫습니다.`,
          suggestion: "관통이 맞다면 ‘관통’으로 바꾸고, 아니라면 깊이를 줄이세요.",
          refs: [ref(h, shapeCenter(h))],
        });

      if (h.kind === "circle") {
        const d = h.r * 2;
        // 구멍 깊이 = 지정한 깊이, 없으면 그 뷰의 시선 방향 두께
        const depth: number | null = h.depth !== undefined ? Math.min(h.depth, extent ?? h.depth) : extent;
        const spec = h.spec;
        if (spec?.head === "counterbore") {
          if (!spec.cbDiameter || spec.cbDiameter <= d)
            add({
              id: `cb-dia:${v}:${h.id}`,
              severity: "error",
              category: "구멍",
              title: "카운터보어 지름이 구멍보다 작음",
              detail: `자리 지름 Ø${fl(spec.cbDiameter ?? 0)}가 구멍 Ø${fl(d)}보다 커야 볼트 머리가 들어갑니다.`,
              suggestion: spec.size ? `${spec.size} 표준값으로 바꾸려면 나사 규격을 다시 고르세요.` : "자리 지름을 키우세요.",
              refs: [ref(h, [h.cx, h.cy])],
            });
          if (spec.cbDepth && extent !== null && spec.cbDepth >= extent - 1e-6)
            add({
              id: `cb-depth:${v}:${h.id}`,
              severity: "error",
              category: "구멍",
              title: "카운터보어가 부품을 뚫고 나감",
              detail: `자리 깊이 ${fu(spec.cbDepth)}가 두께 ${fu(extent)} 이상입니다. 볼트가 걸릴 곳이 없습니다.`,
              suggestion: "자리 깊이를 줄이거나 부품을 두껍게 하세요.",
              refs: [ref(h, [h.cx, h.cy])],
            });
        }
        if (spec?.head === "countersink" && (!spec.csDiameter || spec.csDiameter <= d))
          add({
            id: `cs-dia:${v}:${h.id}`,
            severity: "error",
            category: "구멍",
            title: "카운터싱크 지름이 구멍보다 작음",
            detail: `바깥 지름 Ø${fl(spec.csDiameter ?? 0)}가 구멍 Ø${fl(d)}보다 커야 합니다.`,
            suggestion: "바깥 지름을 키우세요.",
            refs: [ref(h, [h.cx, h.cy])],
          });
        if (spec?.purpose === "tap" && h.depth !== undefined) {
          const nominal = parseFloat(spec.size.replace("M", ""));
          if (nominal && h.depth < nominal * 1.5)
            add({
              id: `tap-engage:${v}:${h.id}`,
              severity: "info",
              category: "구멍",
              title: `나사 깊이가 얕음 (${fu(h.depth)} < ${fu(nominal * 1.5)})`,
              detail: `${spec.size} 탭은 보통 호칭 지름의 1.5배 이상 물려야 충분히 조여집니다 (강철 기준, 알루미늄은 2배).`,
              suggestion: `깊이를 ${fu(nominal * 1.5)} 이상으로 하세요.`,
              refs: [ref(h, [h.cx, h.cy])],
            });
        }
        if (rules.maxDepthRatio && depth && depth / d > rules.maxDepthRatio)
          add({
            id: `hole-deep:${v}:${h.id}`,
            severity: "warning",
            category: "구멍",
            title: `깊고 가는 구멍 (깊이/지름 = ${f2(depth / d)})`,
            detail: `Ø${fl(d)} 구멍의 깊이가 ${fu(depth)}입니다. 일반 드릴은 깊이가 지름의 ${rules.maxDepthRatio}배를 넘으면 휘거나 부러지기 쉽습니다.`,
            suggestion: "구멍 지름을 키우거나, 부품을 얇게 하거나, 건드릴 가공을 고려하세요.",
            refs: [ref(h, [h.cx, h.cy])],
          });
        if (rules.holeVsThickness && d < p.thickness * rules.holeVsThickness)
          add({
            id: `hole-vs-t:${v}:${h.id}`,
            severity: "warning",
            category: "구멍",
            title: `판 두께보다 작은 구멍 Ø${fl(d)}`,
            detail: `판금 펀칭/레이저는 구멍 지름이 판 두께(${fu(p.thickness)}) 이상이어야 깨끗하게 뚫립니다.`,
            suggestion: `Ø${fl(p.thickness)} 이상으로 키우거나 후가공(드릴)을 지정하세요.`,
            refs: [ref(h, [h.cx, h.cy])],
          });
        if ((!spec || spec.purpose === "custom") && Math.abs(d * 10 - Math.round(d * 10)) > 1e-6)
          add({
            id: `hole-std:${v}:${h.id}`,
            severity: "info",
            category: "구멍",
            title: `드릴 규격이 아닌 지름 Ø${fl(d)}`,
            detail: "표준 드릴은 0.1mm 단위입니다. 이 지름은 리머·보링 같은 추가 가공이 필요합니다.",
            suggestion: `Ø${(Math.round(d * 10) / 10).toFixed(1)}처럼 0.1mm 단위로 바꾸세요. (예: M3 관통 Ø3.4, M4 관통 Ø4.5, M5 관통 Ø5.5, M6 관통 Ø6.6)`,
            refs: [ref(h, [h.cx, h.cy])],
          });
      } else if (rules.sharpInnerCornerNote && (h.kind === "rect" || h.kind === "poly")) {
        // 모서리 R을 준 꼭짓점은 괜찮다. 나머지 각진 꼭짓점만 알려 준다
        const verts: Pt[] = h.kind === "rect" ? rectPoints(h) : h.pts;
        const sharp = verts.filter((_, i) => h.corners?.[i]?.kind !== "fillet");
        if (sharp.length)
          add({
            id: `sharp-corner:${v}:${h.id}`,
            severity: "info",
            category: "가공성",
            title: `각진 구멍의 안쪽 모서리 ${sharp.length}곳`,
            detail: `${VIEW_LABEL[v]}의 ${shapeName(h)} 구멍은 엔드밀로 가공하면 안쪽 모서리가 공구 반지름만큼 둥글어집니다.`,
            suggestion: "‘모서리(E)’ 도구로 R(예: R1 이상)을 주거나, 와이어/레이저 가공을 지정하세요.",
            refs: [ref(h, sharp[0])],
          });
      }
      // 깊고 좁은 포켓: 엔드밀 길이 한계
      if (h.kind !== "circle" && h.depth !== undefined && rules.maxPocketRatio) {
        const narrow = h.kind === "slot" ? h.w : Math.min(normRectOrBox(h).w, normRectOrBox(h).h);
        const dep = Math.min(h.depth, extent ?? h.depth);
        if (narrow > 0 && dep / narrow > rules.maxPocketRatio)
          add({
            id: `pocket-deep:${v}:${h.id}`,
            severity: "warning",
            category: "가공성",
            title: `깊고 좁은 포켓 (깊이/폭 = ${f2(dep / narrow)})`,
            detail: `폭 ${fu(narrow)}에 깊이 ${fu(dep)}입니다. 엔드밀은 보통 지름의 ${rules.maxPocketRatio}배보다 깊게 깎기 어렵습니다.`,
            suggestion: "포켓을 넓히거나 얕게 하세요.",
            refs: [ref(h, shapeCenter(h))],
          });
      }
    }

    // 5) 구멍끼리 간격/겹침
    const minGap = (a: Shape2D, b: Shape2D) => {
      let m = rules.minWall;
      if (a.kind === "circle" && b.kind === "circle" && p.process !== "laser") m = Math.max(m, Math.min(a.r, b.r));
      if (rules.edgeVsThickness) m = Math.max(m, p.thickness * rules.edgeVsThickness);
      return m;
    };
    // 몸체가 없는 뷰(옆으로 뚫는 구멍)도 구멍끼리 간격은 본다. 단, 깊이가 다르면 겹쳐도 의도일 수 있다
    for (let i = 0; i < holes.length; i++)
      for (let j = i + 1; j < holes.length; j++) {
        if ((holes[i].depth ?? -1) !== (holes[j].depth ?? -1)) continue;
        const a = footprint(holes[i]);
        const b = footprint(holes[j]);
        let gap: number;
        let at: Pt;
        if (a.kind === "circle" && b.kind === "circle") {
          const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
          gap = d - a.r - b.r;
          at = [(a.cx + b.cx) / 2, (a.cy + b.cy) / 2];
        } else {
          gap = Infinity;
          at = [0, 0];
          for (const pt of boundarySamples(a)) {
            const g = pointInShape(pt[0], pt[1], b) ? -distToBoundary(pt, b) : distToBoundary(pt, b);
            if (g < gap) {
              gap = g;
              at = pt;
            }
          }
        }
        if (gap < 0)
          add({
            id: `hole-overlap:${v}:${a.id}:${b.id}`,
            severity: "warning",
            category: "구멍",
            title: "구멍끼리 겹침",
            detail: `${VIEW_LABEL[v]}의 ${shapeName(a)}과 ${shapeName(b)}이 겹쳐 하나의 이상한 모양 구멍이 됩니다.`,
            suggestion: "의도한 장공(긴 구멍)이라면 하나의 도형으로 그리고, 아니면 간격을 띄우세요.",
            refs: [ref(holes[i], at), ref(holes[j])],
          });
        else if (gap < minGap(a, b) - 1e-6)
          add({
            id: `hole-gap:${v}:${a.id}:${b.id}`,
            severity: gap < rules.minWall || gap < minGap(a, b) * 0.75 ? "warning" : "info",
            category: "구멍",
            title: `구멍 사이 벽이 ${fu(gap)}로 얇음`,
            detail: `${VIEW_LABEL[v]}의 두 구멍 사이 벽이 권장 ${fu(minGap(a, b))}(최소 벽 ${fu(rules.minWall)}, 원형 구멍은 작은 지름의 0.5배 이상)보다 얇아 가공 중 찢어지거나 변형되기 쉽습니다.`,
            suggestion: "구멍 간격을 넓히세요.",
            refs: [ref(holes[i], at), ref(holes[j])],
          });
      }

    // 6) 중복 도형
    const seen = new Map<string, Shape2D>();
    for (const s of shapes) {
      const { id: _id, ...rest } = s;
      const key = JSON.stringify(rest);
      const prev = seen.get(key);
      if (prev)
        add({
          id: `dup:${v}:${s.id}`,
          severity: "info",
          category: "스케치",
          title: "똑같은 도형이 겹쳐 있음",
          detail: `${VIEW_LABEL[v]}에 ${shapeName(s)}가 두 번 그려져 있습니다.`,
          suggestion: "하나를 지우세요.",
          refs: [ref(s), ref(prev)],
        });
      else seen.set(key, s);
    }
  }

  if (p.mode === "revolve") {
    const ignored = (["top", "side"] as ViewId[]).flatMap((v) => p.views[v].filter((s) => !s.hole).map((s) => ({ v, s })));
    if (ignored.length)
      add({
        id: "revolve-ignored",
        severity: "info",
        category: "형상",
        title: "회전체 모드: 평면도·우측면도의 몸체는 쓰지 않음",
        detail: "회전체는 정면도 단면으로 만들고, 다른 뷰에서는 구멍만 반영합니다.",
        suggestion: "몸체 도형을 지우거나 ‘구멍’으로 바꾸세요.",
        refs: ignored.map(({ v, s }) => ({ view: v, shapeId: s.id })),
      });
    const left = p.views.front.filter((s) => !isDegenerate(s) && (boundsOf([{ ...s, hole: false }]) ?? [0])[0] < -1e-6);
    if (left.length)
      add({
        id: "revolve-left",
        severity: "info",
        category: "형상",
        title: "회전축 왼쪽 부분은 무시됨",
        detail: "회전체는 축(가로 0) 오른쪽 단면만 사용합니다.",
        suggestion: "단면 절반을 축 오른쪽에만 그리세요.",
        refs: left.map((s) => ({ view: "front" as ViewId, shapeId: s.id })),
      });
  }

  const order = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** 머리 자리까지 포함한 구멍의 바깥 모양 */
function footprint(h: Shape2D): Shape2D {
  if (h.kind !== "circle" || !h.spec) return h;
  const od = outerDiameter(h.r * 2, h.spec);
  return od > h.r * 2 ? { ...h, r: od / 2 } : h;
}

function normRectOrBox(s: Shape2D) {
  const b = boundsOf([{ ...s, hole: false }])!;
  return { w: b[2] - b[0], h: b[3] - b[1] };
}

