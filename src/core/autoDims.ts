/**
 * 자동 치수 2.0 (11단계): 형상 특징(features3d)과 구멍 도형으로 도면 치수를 만든다.
 *   ① 높이·단차 위치 → 그 선이 보이는 뷰에 좌표 치수 (SOLIDWORKS 자동 치수처럼 원점 = 뷰 왼쪽 아래)
 *   ② 구멍·보스·장공 중심 → 그 뷰의 좌표 치수
 *   ③ 크기 → 구멍 지시, Ø(보스), R(필렛·회전체 모서리), C(모따기) 지시선 — 글자·뷰와 겹치지 않는 자리를 찾아서
 *   ④ 전체 크기 → 가로·세로 치수
 * 그리고 “무엇이 치수로 있어야 하는지(needs)”를 함께 돌려줘서 빠진 치수를 찾는다(checkNeeds).
 */
import { flatten, isDegenerate, normRect } from "./geometry2d";
import { isFull, PERP, type Axis, type CylFeat, type Features3D, type P3 } from "./featureTypes";
import { renderDim, textBox, overlaps, type Prim, type Pt, type SheetDim, type SheetText } from "./sheetDims";
import { holeLabel } from "./standards";
import type { Project, Shape2D, ViewId } from "./types";
import { VIEW_LABEL } from "./types";
import type { Unit } from "./units";

/** 뷰의 가로·세로가 3D의 어느 축인지 */
export const VIEW_AX: Record<ViewId, [Axis, Axis]> = { front: [0, 2], top: [0, 1], side: [1, 2] };
/** 축 k를 따라 보는 뷰 (원·원호가 그대로 보이는 뷰) */
export const AXIS_VIEW: Record<Axis, ViewId> = { 0: "side", 1: "front", 2: "top" };
/** 축 k가 놓인 뷰들 (그 축 방향 길이가 보이는 뷰) — 먼저 것을 고른다 */
const LEVEL_SIDES: Record<Axis, { view: ViewId; side: "u" | "v" }[]> = {
  0: [
    { view: "front", side: "u" },
    { view: "top", side: "u" },
  ],
  1: [
    { view: "side", side: "u" },
    { view: "top", side: "v" },
  ],
  2: [
    { view: "front", side: "v" },
    { view: "side", side: "v" },
  ],
};
const AXIS_NAME = ["X", "Y", "Z"];

export interface ViewBox {
  min: Pt;
  max: Pt;
}

/** 있어야 할 치수: 한 축의 위치, 또는 크기 글자 */
export type Need = { kind: "pos"; axis: Axis; at: number; label: string } | { kind: "size"; text: string; label: string };

export interface AutoInput {
  /** 구멍·포켓 도형 (스케치 또는 가져온 모델에서 찾은 구멍) */
  feat: Project;
  f3?: Features3D;
  V: Record<ViewId, ViewBox>;
  /** 보이는 투영선 (뷰 좌표) — 높이를 어느 뷰에 잴지 */
  vis: Record<ViewId, Prim[]>;
  P: (v: ViewId, q: Pt) => Pt;
  s: number;
  fmt: (mm: number) => string;
  unit: Unit;
  /** 글자를 놓을 수 있는 용지 영역과 피할 곳 (표제란·뷰 이름 등) */
  area: [number, number, number, number];
  keepOut: [number, number, number, number][];
}

type Row = Map<string, { value: number; p: Pt }>;

const r2 = (x: number) => Math.round(x * 100) / 100;
const key = (x: number) => String(r2(x));

export function autoDims(inp: AutoInput): { dims: SheetDim[]; needs: Need[] } {
  const { feat, f3, V, P, s, fmt } = inp;
  const dims: SheetDim[] = [];
  const needs: Need[] = [];
  const rows: Record<string, Row> = {};
  const row = (v: ViewId, side: "u" | "v") => (rows[`${v}:${side}`] ??= new Map());
  const pushPos = (v: ViewId, p: Pt, label: string) => {
    const [au, av] = VIEW_AX[v];
    if (p[0] > V[v].min[0] + 1e-6) row(v, "u").set(key(p[0]), { value: p[0], p });
    if (p[1] > V[v].min[1] + 1e-6) row(v, "v").set(key(p[1]), { value: p[1], p });
    needs.push({ kind: "pos", axis: au, at: p[0], label: `${label} 위치 (${VIEW_LABEL[v]} ${AXIS_NAME[au]})` });
    needs.push({ kind: "pos", axis: av, at: p[1], label: `${label} 위치 (${VIEW_LABEL[v]} ${AXIS_NAME[av]})` });
  };
  /** 지시선 후보들 (자리 찾기에서 고름) */
  const callouts: Callout[] = [];

  // ---------- ① 높이·단차 ----------
  // 구멍·포켓 깊이로 이미 정해지는 바닥 높이 → 참고 치수 “(17)”
  const implied: Set<string>[] = [new Set(), new Set(), new Set()];
  if (f3) {
    const VAX: Record<ViewId, Axis> = { side: 0, front: 1, top: 2 };
    for (const v of ["front", "top", "side"] as ViewId[]) {
      const k = VAX[v];
      const lo = f3.levels[k][0];
      const hi = f3.levels[k][f3.levels[k].length - 1];
      const from = (d: number) => (v === "front" ? lo + d : hi - d);
      for (const h of feat.views[v]) {
        if (!h.hole) continue;
        if (h.depth !== undefined) implied[k].add(key(from(h.depth)));
        if (h.kind === "circle" && h.spec?.head === "counterbore" && h.spec.cbDepth) implied[k].add(key(from(h.spec.cbDepth)));
      }
    }
  }
  const refText = new Map<string, string>();
  if (f3) {
    for (const k of [0, 1, 2] as Axis[]) {
      const lv = f3.levels[k];
      for (const L of lv.slice(1)) {
        needs.push({ kind: "pos", axis: k, at: L, label: `${AXIS_NAME[k]} 방향 ${fmt(L - lv[0])} 위치의 면` });
        if (L === lv[lv.length - 1]) continue; // 끝은 전체 치수로
        let pick: { view: ViewId; side: "u" | "v"; p: Pt } | null = null;
        for (const c of LEVEL_SIDES[k]) {
          const seg = visibleAt(inp.vis[c.view], c.side, L);
          if (seg) {
            pick = { ...c, p: seg };
            break;
          }
        }
        if (!pick) {
          const c = LEVEL_SIDES[k][0];
          pick = { ...c, p: c.side === "u" ? [L, V[c.view].min[1]] : [V[c.view].min[0], L] };
        }
        row(pick.view, pick.side).set(key(L), { value: L, p: pick.p });
        if (implied[k].has(key(L))) refText.set(`${pick.view}:${pick.side}:${key(L)}`, `(${fmt(L - (pick.side === "u" ? V[pick.view].min[0] : V[pick.view].min[1]))})`);
      }
    }
  }

  // ---------- ② 구멍·포켓 (스케치 또는 가져온 모델의 구멍) ----------
  const sketchSlots: Pt[] = [];
  for (const v of ["side", "top", "front"] as ViewId[]) {
    const holes = feat.views[v].filter(
      (h): h is Extract<Shape2D, { kind: "circle" | "slot" }> => h.hole && !isDegenerate(h) && (h.kind === "circle" || h.kind === "slot"),
    );
    const pockets = feat.views[v].filter((h) => h.hole && !isDegenerate(h) && (h.kind === "rect" || h.kind === "poly"));
    type Group = { label: string; members: Shape2D[]; pcd?: { c: Pt; r: number } };
    const groups = new Map<string, Group>();
    for (const h of holes) {
      if (h.kind === "slot") sketchSlots.push(h.a, h.b);
      const label =
        h.kind === "circle"
          ? holeLabel(h.r * 2, h.spec, h.depth, false, inp.unit)
          : `장공 폭 ${fmt(h.w)} 중심거리 ${fmt(Math.hypot(h.b[0] - h.a[0], h.b[1] - h.a[1]))}${h.depth !== undefined ? ` 깊이 ${fmt(h.depth)}` : " 관통"}`;
      const g = groups.get(label);
      if (g) g.members.push(h);
      else groups.set(label, { label, members: [h] });
    }
    // 볼트 원(PCD)
    for (const g of groups.values()) {
      const cs = g.members.filter((h): h is Extract<Shape2D, { kind: "circle" }> => h.kind === "circle").map((h) => [h.cx, h.cy] as Pt);
      if (cs.length < 3 || cs.length !== g.members.length) continue;
      const c: Pt = [cs.reduce((a, q) => a + q[0], 0) / cs.length, cs.reduce((a, q) => a + q[1], 0) / cs.length];
      const ds = cs.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1]));
      const r = ds.reduce((a, d) => a + d, 0) / ds.length;
      if (r < 1e-6 || ds.some((d) => Math.abs(d - r) > 0.01)) continue;
      const angs = cs.map((q) => Math.atan2(q[1] - c[1], q[0] - c[0])).sort((a, b) => a - b);
      const step = (2 * Math.PI) / angs.length;
      const even = angs.every((a, i) => Math.abs((i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI) - a - step) < 1e-3);
      if (!even) continue;
      g.pcd = { c, r };
      g.label += `, PCD Ø${fmt(r * 2)} 등배치`;
    }
    for (const g of groups.values()) {
      const text = (g.members.length > 1 ? `${g.members.length}×` : "") + g.label;
      needs.push({ kind: "size", text, label: `${g.label} (${VIEW_LABEL[v]})` });
      if (g.pcd) {
        const mid: Pt = [(V[v].min[0] + V[v].max[0]) / 2, (V[v].min[1] + V[v].max[1]) / 2];
        if (Math.abs(g.pcd.c[0] - mid[0]) > 0.01 || Math.abs(g.pcd.c[1] - mid[1]) > 0.01) pushPos(v, g.pcd.c, "볼트 원 중심");
      } else
        for (const h of g.members) {
          if (h.kind === "circle") pushPos(v, [h.cx, h.cy], g.label.split(" ")[0]);
          else if (h.kind === "slot") {
            pushPos(v, h.a, "장공 끝");
            pushPos(v, h.b, "장공 끝");
          }
        }
      callouts.push(shapeCallout(`h:${v}:${g.label}`, v, g.members, text));
    }
    for (const h of pockets) {
      const sz = h.kind === "rect" ? `${fmt(normRect(h).w)}×${fmt(normRect(h).h)} ` : "";
      const label = `${sz}포켓${h.depth !== undefined ? ` 깊이 ${fmt(h.depth)}` : " 관통"}`;
      needs.push({ kind: "size", text: label, label: `${label} (${VIEW_LABEL[v]})` });
      if (h.kind === "rect") {
        const r = normRect(h);
        pushPos(v, [r.x, r.y], "포켓 모서리");
      }
      callouts.push(shapeCallout(`p:${v}:${h.id}`, v, [h], label));
    }
  }

  // ---------- ③ 형상 특징: 보스, 필렛 R, 장공(가져온 모델), 모따기, 회전체 R ----------
  if (f3) {
    const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01;
    const holeText = (c: CylFeat) => {
      const lo = f3.levels[c.axis][0];
      const hi = f3.levels[c.axis][f3.levels[c.axis].length - 1];
      return `Ø${fmt(c.r * 2)} 구멍${c.t0 <= lo + 1e-3 && c.t1 >= hi - 1e-3 ? " 관통" : ` 깊이 ${fmt(c.t1 - c.t0)}`}`;
    };
    const featHoleAt = (v: ViewId, p: Pt) => feat.views[v].some((h) => h.hole && h.kind === "circle" && near([h.cx, h.cy], p));
    // 3D에만 있는 구멍 (회전체의 가운데 구멍 등 — 스케치 구멍과 같은 중심이면 이미 지시함)
    const extraHoles = f3.cyl.filter((c) => c.concave && isFull(c) && !featHoleAt(AXIS_VIEW[c.axis], c.p) && !sketchSlots.some((q) => near(q, c.p)));
    for (const [, list] of groupBy(extraHoles, (c) => `${c.axis}:${holeText(c)}`)) {
      const v = AXIS_VIEW[list[0].axis];
      const text = holeText(list[0]);
      for (const c of list) pushPos(v, c.p, `Ø${fmt(c.r * 2)} 구멍`);
      const full = (list.length > 1 ? `${list.length}×` : "") + text;
      needs.push({ kind: "size", text: full, label: `${text} (${VIEW_LABEL[v]})` });
      callouts.push(radialCallout(`e:${v}:${text}`, v, list, "leader", full));
    }
    // 보스·축 (볼록한 한 바퀴 원통)
    const bosses = f3.cyl.filter((c) => !c.concave && isFull(c));
    for (const [txt, list] of groupBy(bosses, (c) => `${c.axis}:Ø${fmt(c.r * 2)}`)) {
      const v = AXIS_VIEW[list[0].axis];
      for (const c of list) pushPos(v, c.p, `Ø${fmt(c.r * 2)}`);
      const text = `Ø${fmt(list[0].r * 2)}`;
      needs.push({ kind: "size", text, label: `보스·축 ${text} (${VIEW_LABEL[v]})` });
      callouts.push(radialCallout(`b:${txt}`, v, list, "diameter"));
    }
    // 가져온 모델의 장공: 오목한 반원통 둘이 마주 봄
    const partial = f3.cyl.filter((c) => !isFull(c));
    const used = new Set<CylFeat>();
    for (const a of partial) {
      if (used.has(a) || !a.concave || Math.abs(a.sweep - Math.PI) > 0.2) continue;
      const b = partial.find(
        (o) =>
          o !== a &&
          !used.has(o) &&
          o.concave &&
          o.axis === a.axis &&
          Math.abs(o.r - a.r) < 1e-3 &&
          Math.abs(o.sweep - Math.PI) < 0.2 &&
          Math.abs(o.t0 - a.t0) < 1e-3 &&
          Math.abs(o.t1 - a.t1) < 1e-3 &&
          facing(a, o),
      );
      if (!b) continue;
      used.add(a).add(b);
      const v = AXIS_VIEW[a.axis];
      if (sketchSlots.some((q) => near(q, a.p)) && sketchSlots.some((q) => near(q, b.p))) continue; // 스케치 장공이 이미 지시
      const len = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
      const lo = f3.levels[a.axis][0];
      const hi = f3.levels[a.axis][f3.levels[a.axis].length - 1];
      const through = a.t0 <= lo + 1e-3 && a.t1 >= hi - 1e-3;
      const text = `장공 폭 ${fmt(a.r * 2)} 중심거리 ${fmt(len)}${through ? " 관통" : ` 깊이 ${fmt(a.t1 - a.t0)}`}`;
      needs.push({ kind: "size", text, label: `${text} (${VIEW_LABEL[v]})` });
      pushPos(v, a.p, "장공 끝");
      pushPos(v, b.p, "장공 끝");
      callouts.push(radialCallout(`s:${v}:${key(a.p[0])}:${key(a.p[1])}`, v, [a], "leader", text));
    }
    // 필렛·둥근 모서리 (일부 원통) — 스케치 장공 끝·구멍과 겹치는 것은 빼고
    const fillets = partial.filter((c) => !used.has(c) && !(c.concave && (sketchSlots.some((q) => near(q, c.p)) || featHoleAt(AXIS_VIEW[c.axis], c.p))));
    for (const [, list] of groupBy(fillets, (c) => `${c.axis}:R${fmt(c.r)}`)) {
      const v = AXIS_VIEW[list[0].axis];
      const text = `R${fmt(list[0].r)}`;
      needs.push({ kind: "size", text, label: `둥근 모서리 ${text} (${VIEW_LABEL[v]})` });
      callouts.push(radialCallout(`r:${v}:${text}`, v, list, "radius"));
    }
    // 모따기 (기울어진 평면): 그 면이 선으로 보이는 뷰
    for (const [txt, list] of groupBy(f3.slopes, (c) => `${c.along}:${chamferText(c.legs, fmt)}`)) {
      const v = AXIS_VIEW[list[0].along];
      const text = chamferText(list[0].legs, fmt);
      needs.push({ kind: "size", text, label: `모따기 ${text} (${VIEW_LABEL[v]})` });
      callouts.push(pointCallout(`c:${txt}`, v, list.map((c) => viewPt(v, c.mid)), (list.length > 1 ? `${list.length}×` : "") + text));
    }
    // 볼록 원뿔 (축 끝 모따기)
    for (const [txt, list] of groupBy(
      f3.cones.filter((c) => !c.concave),
      (c) => `${c.axis}:${chamferText([Math.abs(c.r1 - c.r0), c.t1 - c.t0], fmt)}`,
    )) {
      const v = sideViewOf(list[0].axis);
      const c0 = list[0];
      const text = chamferText([Math.abs(c0.r1 - c0.r0), c0.t1 - c0.t0], fmt);
      needs.push({ kind: "size", text, label: `모따기 ${text} (${VIEW_LABEL[v]})` });
      callouts.push(pointCallout(`k:${txt}`, v, list.map((c) => viewPt(v, c.mid)), (list.length > 1 ? `${list.length}×` : "") + text));
    }
    // 회전체 모서리 R (원환)
    for (const [txt, list] of groupBy(f3.tori, (t) => `${t.axis}:R${fmt(t.r)}`)) {
      const v = sideViewOf(list[0].axis);
      const text = `R${fmt(list[0].r)}`;
      needs.push({ kind: "size", text, label: `둥근 모서리 ${text} (${VIEW_LABEL[v]})` });
      callouts.push(pointCallout(`t:${txt}`, v, list.map((t) => viewPt(v, t.mid)), (list.length > 1 ? `${list.length}×` : "") + text));
    }
  }

  // ---------- ④ 좌표 치수 줄 + 전체 치수 ----------
  const rowUsed = (v: ViewId, side: "u" | "v") => (rows[`${v}:${side}`]?.size ?? 0) > 0;
  for (const [k, r] of Object.entries(rows)) {
    if (!r.size) continue;
    const [v, side] = k.split(":") as [ViewId, "u" | "v"];
    const origin: Pt = [V[v].min[0], V[v].min[1]];
    const list = [...r.values()].sort((a, b) => a.value - b.value);
    // 줄에서 가장 가까운 끝점으로 (보조선이 짧게)
    dims.push({ id: `o:${v}:${side}:0`, view: v, kind: "ordinate", axis: side, origin, p: origin, line: -5 });
    // 글자가 겹치지 않게 비켜 놓기 (용지에서 축 방향 간격)
    const gapMin = 3.5 * 0.85 + 0.8;
    let last = -Infinity;
    const O = P(v, origin);
    for (const e of list) {
      const F = P(v, e.p);
      const pos = side === "u" ? F[0] : F[1];
      const want = Math.max(pos, (last === -Infinity ? (side === "u" ? O[0] : O[1]) : last) + gapMin);
      last = want;
      const ref = refText.get(`${v}:${side}:${key(e.value)}`);
      dims.push({
        id: `o:${v}:${side}:${key(e.value)}`,
        view: v,
        kind: "ordinate",
        axis: side,
        origin,
        p: e.p,
        line: -5,
        ...(want - pos > 0.05 ? { jog: want - pos } : {}),
        ...(ref ? { text: ref } : {}),
      });
    }
  }
  const bottomOff = (v: ViewId) => -(rowUsed(v, "u") ? 16 : 9);
  const leftOff = (v: ViewId) => -(rowUsed(v, "v") ? 16 : 9);
  const f = V.front;
  const sd = V.side;
  dims.push({ id: "w:front", view: "front", kind: "linear", dir: "h", a: [f.min[0], f.min[1]], b: [f.max[0], f.min[1]], off: bottomOff("front") });
  dims.push({ id: "h:front", view: "front", kind: "linear", dir: "v", a: [f.min[0], f.min[1]], b: [f.min[0], f.max[1]], off: leftOff("front") });
  dims.push({ id: "w:side", view: "side", kind: "linear", dir: "h", a: [sd.min[0], sd.min[1]], b: [sd.max[0], sd.min[1]], off: bottomOff("side") });
  // 평면도에만 보이는 가로(Y) 깊이가 우측면도에 없을 때를 대비: 위치 필요 목록에 끝점 (전체 치수가 맡음)

  // ---------- ⑤ 지시선 자리 찾기 ----------
  // 글자는 뷰·글자와 겹치지 않게, 지시선은 글자를 지나지 않게
  const textObs: number[][] = [...inp.keepOut];
  const viewObs: number[][] = [];
  for (const v of ["front", "top", "side"] as ViewId[]) {
    const a = P(v, V[v].min);
    const b = P(v, V[v].max);
    viewObs.push([a[0] - 0.8, a[1] - 0.8, b[0] + 0.8, b[1] + 0.8]);
  }
  for (const d of dims) for (const t of renderDim(d, (q) => P(d.view, q), s, fmt).texts) textObs.push(textBox(t));
  for (const c of callouts) {
    const best = place(c, inp, textObs, viewObs);
    if (!best) continue;
    dims.push(best.dim);
    textObs.push(...best.boxes);
  }
  return { dims, needs };

  // ---- 지시선 후보 만들기 ----
  function shapeCallout(id: string, v: ViewId, members: Shape2D[], text: string): Callout {
    // 대표: 뷰 바깥쪽에 가까운 것부터 몇 개
    const reps = [...members].sort((a, b) => edgeDist(v, center(a)) - edgeDist(v, center(b))).slice(0, 4);
    return {
      id,
      view: v,
      tips: (dir) =>
        reps.map((h) => {
          if (h.kind === "circle") return [h.cx + h.r * dir[0], h.cy + h.r * dir[1]] as Pt;
          // 바깥선에서 그 방향으로 가장 먼 점
          let best: Pt = flatten(h)[0];
          for (const q of flatten(h)) if (q[0] * dir[0] + q[1] * dir[1] > best[0] * dir[0] + best[1] * dir[1]) best = q;
          return best;
        }),
      make: (tip, knee) => ({ id, view: v, kind: "leader", tip, knee, text }),
    };
  }
  function radialCallout(id: string, v: ViewId, list: CylFeat[], kind: "radius" | "diameter" | "leader", text?: string): Callout {
    const reps = [...list].sort((a, b) => edgeDist(v, a.p) - edgeDist(v, b.p)).slice(0, 4);
    return {
      id,
      view: v,
      tips: (dir) =>
        reps
          .filter((c) => isFull(c) || inArc(c, Math.atan2(dir[1], dir[0])))
          .map((c) => [c.p[0] + c.r * dir[0], c.p[1] + c.r * dir[1]] as Pt),
      make: (tip, knee) => {
        const c = reps.find((q) => Math.abs(Math.hypot(tip[0] - q.p[0], tip[1] - q.p[1]) - q.r) < 1e-6) ?? reps[0];
        if (kind === "leader") return { id, view: v, kind: "leader", tip, knee, text: text! };
        const ang = (Math.atan2(tip[1] - c.p[1], tip[0] - c.p[0]) * 180) / Math.PI;
        return { id, view: v, kind, c: c.p, r: c.r, ang, len: Math.hypot(knee[0], knee[1]), ...(list.length > 1 ? { count: list.length } : {}) };
      },
      // 원호 위 각도만 쓸 수 있는 필렛: 원호 가운데 방향도 후보에
      dirs: reps.filter((c) => !isFull(c)).map((c) => c.a0 + c.sweep / 2),
    };
  }
  function pointCallout(id: string, v: ViewId, pts: Pt[], text: string): Callout {
    return { id, view: v, tips: () => pts.slice(0, 4), make: (tip, knee) => ({ id, view: v, kind: "leader", tip, knee, text }) };
  }
  function edgeDist(v: ViewId, p: Pt) {
    const b = V[v];
    return Math.min(p[0] - b.min[0], b.max[0] - p[0], p[1] - b.min[1], b.max[1] - p[1]);
  }
  function sideViewOf(k: Axis): ViewId {
    return (["front", "top", "side"] as ViewId[]).find((v) => VIEW_AX[v].includes(k))!;
  }
}

interface Callout {
  id: string;
  view: ViewId;
  /** 방향(뷰 좌표 단위 벡터)에 따른 지시선 끝 후보들 */
  tips: (dir: Pt) => Pt[];
  make: (tip: Pt, knee: Pt) => SheetDim;
  /** 꼭 넣어 볼 방향 (라디안) */
  dirs?: number[];
}

/** 겹치지 않는 지시선 자리: 방향 × 끝 × 길이 후보 중 가장 짧은 것 */
function place(c: Callout, inp: AutoInput, textObs: number[][], viewObs: number[][]): { dim: SheetDim; boxes: number[][] } | null {
  const { P, s, fmt, V, area } = inp;
  const v = c.view;
  const box = [P(v, V[v].min), P(v, V[v].max)];
  const mid: Pt = [(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2];
  const angles = [...(c.dirs ?? []), ...Array.from({ length: 16 }, (_, i) => (i * Math.PI) / 8)];
  let best: { dim: SheetDim; boxes: number[][]; score: number } | null = null;
  let fallback: { dim: SheetDim; boxes: number[][]; score: number } | null = null;
  for (const a of angles) {
    const dir: Pt = [Math.cos(a), Math.sin(a)];
    for (const tip of c.tips(dir)) {
      const T = P(v, tip);
      // 뷰 상자를 벗어나는 길이
      const exit = exitLen(T, dir, box);
      for (const extra of [3, 7, 12, 18]) {
        const len = exit + extra;
        const knee: Pt = [dir[0] * len, dir[1] * len];
        const dim = c.make(tip, knee);
        const dr = renderDim(dim, (q) => P(v, q), s, fmt);
        const boxes = dr.texts.map(textBox);
        // 지시선 가로 어깨까지 포함
        const inArea = boxes.every((b) => b[0] >= area[0] && b[1] >= area[1] && b[2] <= area[2] && b[3] <= area[3]);
        let hits = boxes.reduce((n, b) => n + textObs.filter((o) => overlaps(b, o, 0.4)).length + viewObs.filter((o) => overlaps(b, o, 0.4)).length, 0);
        for (const pr of dr.prims) if (pr.t === "line") hits += textObs.filter((o) => segHitsBox(pr.a, pr.b, o)).length;
        // 바깥쪽(뷰 가운데에서 멀어지는 쪽)을 조금 더 좋게
        const outward = (T[0] - mid[0]) * dir[0] + (T[1] - mid[1]) * dir[1] >= 0 ? 0 : 6;
        const score = len + outward;
        if (inArea && !hits) {
          if (!best || score < best.score) best = { dim, boxes, score };
        } else {
          const bad = score + hits * 50 + (inArea ? 0 : 100);
          if (!fallback || bad < fallback.score) fallback = { dim, boxes, score: bad };
        }
      }
    }
  }
  return best ?? fallback;
}

/** 선분이 상자를 지나는지 (상자를 조금 줄여서 — 스치는 것은 봐줌) */
function segHitsBox(a: Pt, b: Pt, o: number[]): boolean {
  const x0 = o[0] + 0.2, y0 = o[1] + 0.2, x1 = o[2] - 0.2, y1 = o[3] - 0.2;
  if (x0 >= x1 || y0 >= y1) return false;
  // Liang–Barsky
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ]) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function exitLen(T: Pt, d: Pt, box: Pt[]): number {
  let t = Infinity;
  for (const k of [0, 1]) {
    if (Math.abs(d[k]) < 1e-9) continue;
    const lim = d[k] > 0 ? box[1][k] : box[0][k];
    t = Math.min(t, (lim - T[k]) / d[k]);
  }
  return Math.max(0, Number.isFinite(t) ? t : 0);
}

/** 그 좌표에 보이는 직선(축에 수직)이 있으면, 줄 쪽 끝점 */
function visibleAt(prims: Prim[], side: "u" | "v", L: number): Pt | null {
  let best: Pt | null = null;
  const tol = 1e-3;
  for (const p of prims) {
    if (p.t !== "line") continue;
    if (side === "u") {
      if (Math.abs(p.a[0] - L) < tol && Math.abs(p.b[0] - L) < tol && Math.abs(p.a[1] - p.b[1]) > tol) {
        const q: Pt = p.a[1] < p.b[1] ? p.a : p.b;
        if (!best || q[1] < best[1]) best = [L, q[1]];
      }
    } else if (Math.abs(p.a[1] - L) < tol && Math.abs(p.b[1] - L) < tol && Math.abs(p.a[0] - p.b[0]) > tol) {
      const q: Pt = p.a[0] < p.b[0] ? p.a : p.b;
      if (!best || q[0] < best[0]) best = [q[0], L];
    }
  }
  return best;
}

function center(h: Shape2D): Pt {
  if (h.kind === "circle") return [h.cx, h.cy];
  if (h.kind === "slot") return [(h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2];
  const pts = flatten(h);
  return [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length];
}

/** 3D 점 → 그 뷰의 좌표 */
function viewPt(v: ViewId, p: P3): Pt {
  const [a, b] = VIEW_AX[v];
  return [p[a], p[b]];
}

function inArc(c: CylFeat, a: number): boolean {
  const t = (((a - c.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return t >= 0.08 && t <= c.sweep - 0.08;
}

/** 두 반원통이 서로 마주 보는지 (장공의 두 끝: 원호가 서로 반대쪽으로 열림) */
function facing(a: CylFeat, b: CylFeat): boolean {
  const d: Pt = [b.p[0] - a.p[0], b.p[1] - a.p[1]];
  const L = Math.hypot(d[0], d[1]);
  if (L < 1e-6) return false;
  const ma = a.a0 + a.sweep / 2;
  const mb = b.a0 + b.sweep / 2;
  // a의 원호 가운데는 b 반대쪽, b의 원호 가운데는 a 반대쪽
  return (Math.cos(ma) * d[0] + Math.sin(ma) * d[1]) / L < -0.9 && (Math.cos(mb) * d[0] + Math.sin(mb) * d[1]) / L > 0.9;
}

function chamferText(legs: [number, number], fmt: (mm: number) => string): string {
  return Math.abs(legs[0] - legs[1]) < 1e-3 ? `C${fmt(legs[0])}` : `${fmt(legs[0])}×${fmt(legs[1])}`;
}

function groupBy<T>(xs: T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const kk = k(x);
    const g = m.get(kk);
    if (g) g.push(x);
    else m.set(kk, [x]);
  }
  return m;
}

/** 치수에서 “어느 축의 어느 위치를 쟀는지” */
export function touched(d: SheetDim): { axis: Axis; at: number }[] {
  const [au, av] = VIEW_AX[d.view];
  if (d.kind === "linear") {
    if (d.dir === "h") return [
      { axis: au, at: d.a[0] },
      { axis: au, at: d.b[0] },
    ];
    if (d.dir === "v") return [
      { axis: av, at: d.a[1] },
      { axis: av, at: d.b[1] },
    ];
    return [];
  }
  if (d.kind === "ordinate") {
    const ax = d.axis === "u" ? au : av;
    const i = d.axis === "u" ? 0 : 1;
    return [
      { axis: ax, at: d.origin[i] },
      { axis: ax, at: d.p[i] },
    ];
  }
  return [];
}

/** 빠진 치수 찾기: 있어야 할 것(needs) 중 지금 치수(dims)에 없는 것의 설명 */
export function checkNeeds(needs: Need[], dims: SheetDim[], fmt: (mm: number) => string): string[] {
  const pos = dims.flatMap(touched);
  const texts = dims.map((d) => (d.kind === "leader" ? d.text : (d.text ?? "")) + (d.suffix ?? ""));
  // 반지름·지름 치수는 그린 글자로
  for (const d of dims) if (d.kind === "radius" || d.kind === "diameter") texts.push(`${d.kind === "radius" ? "R" : "Ø"}${fmt(d.kind === "radius" ? d.r : d.r * 2)}`);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const n of needs) {
    const ok = n.kind === "pos" ? pos.some((q) => q.axis === n.axis && Math.abs(q.at - n.at) < 0.011) : texts.some((t) => t.includes(n.text));
    if (!ok && !seen.has(n.label)) {
      seen.add(n.label);
      missing.push(n.label);
    }
  }
  return missing;
}

export type { SheetText };
