/**
 * 도면 이미지에서 뷰와 구멍 찾기.
 *  1) 선 굵기를 재서 가는 선(치수선·중심선·숨은선·글자)을 지운다 (굵기가 두 가지로 나뉠 때)
 *  2) 연결된 선 덩어리 중 안쪽을 둘러싸는 큰 덩어리 = 뷰의 외형선, 그 안의 작은 고리 = 구멍
 *  3) 3각법 배치(평면도는 정면도 위, 우측면도는 정면도 오른쪽)로 뷰 이름을 정한다
 * 좌표는 모두 픽셀 (x 오른쪽, y 아래).
 */
import type { ViewId } from "../types";
import { fitContour, traceOuter, type Fitted } from "./contour";
import { close, cropComp, dilate, distTo, erode, fillHoles, label, open, openSquare, type Comp } from "./morph";
import { mask, type Mask, type P2 } from "./raster";

export type Box = [number, number, number, number];

export interface Stroke {
  /** 외형선 굵기 (px) */
  thick: number;
  /** 가는 선 굵기 (px). 굵기가 한 가지면 null */
  thin: number | null;
}

export interface Candidate {
  id: string;
  fit: Fitted;
  box: Box;
  /** 처음 상태: 구멍으로 쓸지 */
  on: boolean;
  note?: string;
}

export interface DetectedView {
  id: number;
  /** 외형선(선 가운데 기준)의 경계 상자 */
  box: Box;
  outline: Fitted;
  holes: Candidate[];
  role: ViewId | null;
  /** 도면 테두리로 보임 */
  frame?: boolean;
}

export interface Analysis {
  w: number;
  h: number;
  stroke: Stroke;
  views: DetectedView[];
  /** 회전체(원통형 부품)로 보이면 true */
  revolve: boolean;
}

// ---------------- 선 굵기 ----------------

export function strokeWidths(ink: Mask): Stroke {
  const d = distTo(ink, 0);
  const { w, h } = ink;
  // 능선 픽셀(거리 변환의 극대)에서 굵기: 홀수 굵기는 2d-1, 짝수 굵기는 가운데 두 픽셀이 같은 d라 2d
  const widths: number[] = [];
  const hist = new Float64Array(64);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!ink.d[i]) continue;
      const v = d[i];
      const nb = [d[i - 1], d[i + 1], d[i - w], d[i + w]];
      if (nb.some((u) => u > v)) continue;
      const flat = nb.some((u) => Math.abs(u - v) < 1e-6);
      const wd = flat ? 2 * v : 2 * v - 1;
      widths.push(wd);
      hist[Math.min(63, Math.max(1, Math.round(wd)))]++;
    }
  const total = widths.length || 1;
  const cands: { w: number; mass: number }[] = [];
  for (let i = 1; i < 63; i++)
    if (hist[i] / total > 0.05 && hist[i] >= hist[i - 1] && hist[i] >= hist[i + 1]) cands.push({ w: i, mass: hist[i] / total });
  if (!cands.length) return { thick: 2, thin: null };
  cands.sort((a, b) => b.mass - a.mass);
  const c1 = cands[0];
  const c2 = cands.find((c) => c.w >= c1.w * 1.6 || c.w * 1.6 <= c1.w);
  const thickW = c2 ? Math.max(c1.w, c2.w) : c1.w;
  const thinW = c2 ? Math.min(c1.w, c2.w) : null;
  // 굵은 선의 정확한 평균 굵기 (외곽선 위치 보정용)
  const lo = thinW ? (thickW + thinW) / 2 : thickW * 0.6;
  const hi = thickW * 1.5 + 1;
  let sum = 0;
  let n = 0;
  for (const wd of widths)
    if (wd >= lo && wd <= hi) {
      sum += wd;
      n++;
    }
  return { thick: n ? sum / n : thickW, thin: thinW };
}

/**
 * 가는 선 지우기: 가는 선은 다 사라지고 굵은 선은 남을 만큼 깎아서 "씨앗"을 만든 뒤,
 * 씨앗 가까이에 있는 원래 선만 되살린다 (굵은 선은 원래 굵기 그대로).
 * 비스듬한 굵은 선은 거리 값이 작게 나오므로(√2) 문턱을 가는 선 쪽에 가깝게 둔다.
 */
export function removeThin(ink: Mask, s: Stroke): Mask {
  if (!s.thin) return ink;
  const thinD = Math.ceil(s.thin / 2);
  const thickD = Math.ceil(Math.round(s.thick) / 2);
  const r = thinD + Math.max(0.2, 0.35 * (thickD - thinD));
  const seed = erode(ink, r);
  const near = dilate(seed, thickD + 1);
  const out = mask(ink.w, ink.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = ink.d[i] & near.d[i];
  return out;
}

// ---------------- 뷰와 구멍 ----------------

interface Blob {
  comp: Comp;
  /** 선 + 둘러싸인 곳 (comp 좌표계) */
  filled: Mask;
  enclosed: Mask;
  ox: number;
  oy: number;
  inkArea: number;
  filledArea: number;
  enclosedArea: number;
}

function makeBlob(labels: Int32Array, w: number, c: Comp, pad: number): Blob {
  const { m, ox, oy } = cropComp(labels, w, c, pad);
  const { filled, enclosed } = fillHoles(m);
  let fa = 0;
  let ea = 0;
  for (let i = 0; i < filled.d.length; i++) {
    fa += filled.d[i];
    ea += enclosed.d[i];
  }
  return { comp: c, filled, enclosed, ox, oy, inkArea: c.area, filledArea: fa, enclosedArea: ea };
}

/** 한 덩어리(선)의 평균 굵기: 능선 픽셀의 굵기 평균 */
function localWidth(labels: Int32Array, w: number, c: Comp, fallback: number): number {
  const { m } = cropComp(labels, w, c, 2);
  const d = distTo(m, 0);
  let sum = 0;
  let n = 0;
  for (let y = 1; y < m.h - 1; y++)
    for (let x = 1; x < m.w - 1; x++) {
      const i = y * m.w + x;
      if (!m.d[i]) continue;
      const v = d[i];
      const nb = [d[i - 1], d[i + 1], d[i - m.w], d[i + m.w]];
      if (nb.some((u) => u > v)) continue;
      const wd = nb.some((u) => Math.abs(u - v) < 1e-6) ? 2 * v : 2 * v - 1;
      // 교차점 등 굵게 보이는 곳은 빼고
      if (wd > fallback * 1.8 + 1) continue;
      sum += wd;
      n++;
    }
  return n > 10 ? sum / n : fallback;
}

/** 이미지 좌표 (x,y)가 덩어리의 채운 영역 안인지 */
function inside(b: Blob, x: number, y: number): boolean {
  const lx = Math.round(x) - b.ox;
  const ly = Math.round(y) - b.oy;
  return lx >= 0 && ly >= 0 && lx < b.filled.w && ly < b.filled.h && b.filled.d[ly * b.filled.w + lx] === 1;
}

/**
 * 영역의 외곽선을 맞춘다. 경계(픽셀 모서리)를 따서 offset만큼 안쪽(+) 또는 바깥쪽(-)으로 옮긴 뒤 맞춘다.
 * 선으로 그린 고리의 바깥 경계는 선 가운데보다 굵기 절반만큼 바깥이므로 offset = +굵기/2.
 * spike: 이 반지름보다 가는 돌기(중심선·치수 보조선 끝)는 깎아 낸다.
 */
function regionOutline(
  region: Mask,
  ox: number,
  oy: number,
  spike: number,
  offset: number,
  square = false,
): { fit: Fitted; box: Box } | null {
  // 가는 돌기 깎기: 외형은 정사각형으로 (직각 모서리가 그대로), 구멍은 원판으로 (원이 그대로)
  const m = spike > 0 ? (square ? openSquare(region, Math.ceil(spike)) : open(region, spike)) : region;
  const { labels, comps } = label(m, 4);
  if (!comps.length) return null;
  const big = comps.reduce((a, b) => (b.area > a.area ? b : a));
  if (big.area < 12) return null;
  const only = mask(m.w, m.h);
  for (let i = 0; i < only.d.length; i++) only.d[i] = labels[i] === big.id ? 1 : 0;
  const raw = traceOuter(only);
  if (raw.length < 8) return null;
  const pts = offsetContour(raw, offset).map(([x, y]) => [x + ox, y + oy] as P2);
  const fit = fitContour(pts, { minSeg: Math.max(3, 2 * Math.abs(offset) + 1.5) });
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { fit, box: [x0, y0, x1, y1] };
}

/** 경계 점들을 오른쪽 법선(영역 안쪽) 방향으로 off만큼 옮긴다 */
function offsetContour(p: P2[], off: number): P2[] {
  if (!off) return p;
  const n = p.length;
  const k = Math.min(3, Math.floor(n / 4));
  return p.map((q, i) => {
    const a = p[(i - k + n) % n];
    const b = p[(i + k) % n];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const L = Math.hypot(tx, ty) || 1;
    return [q[0] + (-ty / L) * off, q[1] + (tx / L) * off];
  });
}

const isRectangle = (f: Fitted) =>
  f.kind === "path" &&
  f.prims.length === 4 &&
  f.prims.every((p) => p.t === "line" && (Math.abs(p.a[0] - p.b[0]) < 1e-6 || Math.abs(p.a[1] - p.b[1]) < 1e-6));

export function detect(ink: Mask): Analysis {
  const { w, h } = ink;
  const stroke = strokeWidths(ink);
  let geo = removeThin(ink, stroke);
  geo = close(geo, Math.max(1, stroke.thick * 0.5));
  const thick = stroke.thick;
  const half = thick / 2;
  const { labels, comps } = label(geo, 8);
  const pad = Math.ceil(thick * 2 + 4);
  const minLoop = Math.max(20, (2.5 * thick) ** 2);

  // 고리(안쪽을 둘러싼 덩어리)만 남긴다
  const blobs: Blob[] = [];
  for (const c of comps) {
    if (c.area < 12) continue;
    const bw = c.box[2] - c.box[0] + 1;
    const bh = c.box[3] - c.box[1] + 1;
    if (bw < 3 * thick || bh < 3 * thick) continue;
    const b = makeBlob(labels, w, c, pad);
    if (b.enclosedArea >= minLoop && b.enclosedArea >= 0.3 * b.inkArea) blobs.push(b);
  }
  // 큰 순서
  blobs.sort((a, b) => b.filledArea - a.filledArea);
  const bigMin = 0.0012 * w * h;
  const containerOf = (b: Blob) => blobs.filter((o) => o !== b && o.filledArea > b.filledArea && inside(o, (b.comp.box[0] + b.comp.box[2]) / 2, (b.comp.box[1] + b.comp.box[3]) / 2));

  // 도면 테두리: 이미지 가장자리 가까이의 사각형 + (안에 큰 덩어리 둘 이상 또는 표제란 선)
  const frames = new Set<Blob>();
  for (const b of blobs) {
    const [x0, y0, x1, y1] = b.comp.box;
    const near = x0 < 0.08 * w && y0 < 0.08 * h && x1 > 0.92 * w && y1 > 0.92 * h;
    if (!near) continue;
    const perim = 2 * (x1 - x0 + y1 - y0) * thick;
    const bigInside = blobs.filter((o) => o !== b && o.filledArea >= bigMin && containerOf(o).includes(b)).length;
    if (bigInside >= 2 || b.inkArea > 1.6 * perim) frames.add(b);
  }

  // 뷰: 큰 덩어리 중 테두리가 아닌 다른 덩어리 안에 들어 있지 않은 것
  const viewBlobs = blobs.filter((b) => b.filledArea >= bigMin && !containerOf(b).some((o) => !frames.has(o)));
  const views: DetectedView[] = [];
  let vid = 0;
  let hid = 0;
  for (const b of viewBlobs) {
    const lw = localWidth(labels, w, b.comp, thick);
    // 외형선에 붙은 지시선·중심선 끝과 그 뿌리까지 깎아 내도록 넉넉히
    const out = regionOutline(b.filled, b.ox, b.oy, 1.2 * lw + 1, lw / 2, true);
    if (!out) continue;
    (b as any).lw = lw;
    views.push({ id: vid++, box: out.box, outline: out.fit, holes: [], role: null, frame: frames.has(b) || undefined });
    (views[views.length - 1] as any)._blob = b;
  }
  // 구멍: 각 고리를 그것을 담은 가장 작은 뷰에 준다
  const viewOf = (b: Blob): DetectedView | null => {
    let best: DetectedView | null = null;
    let bestArea = Infinity;
    for (const v of views) {
      const vb = (v as any)._blob as Blob;
      if (vb === b) return null;
      if (vb.filledArea < bestArea && inside(vb, (b.comp.box[0] + b.comp.box[2]) / 2, (b.comp.box[1] + b.comp.box[3]) / 2)) {
        best = v;
        bestArea = vb.filledArea;
      }
    }
    return best;
  };
  for (const b of blobs) {
    if (viewBlobs.includes(b)) continue;
    const v = viewOf(b);
    if (!v) continue;
    const lw = localWidth(labels, w, b.comp, thick);
    const out = regionOutline(b.filled, b.ox, b.oy, Math.max(lw / 2 + 1, 1.5 * lw), lw / 2);
    if (!out) continue;
    v.holes.push({ id: `h${hid++}`, fit: out.fit, box: out.box, on: true });
    // 고리 안쪽에 또 다른 원(카운터보어 안의 구멍 등)이 화살표로 이어져 있으면 따로 찾는다
    const { labels: fl, comps: fc } = label(b.enclosed, 4);
    for (const c of fc) {
      if (c.area < minLoop / 2) continue;
      const { m } = cropComp(fl, b.filled.w, c, pad);
      const inner = regionOutline(m, c.box[0] - pad + b.ox, c.box[1] - pad + b.oy, 1, -lw / 2);
      if (!inner || inner.fit.kind !== "circle") continue;
      const outerR = out.fit.kind === "circle" ? out.fit.r : Math.max(out.box[2] - out.box[0], out.box[3] - out.box[1]) / 2;
      if (inner.fit.r > 0.85 * outerR) continue;
      v.holes.push({ id: `h${hid++}`, fit: inner.fit, box: inner.box, on: true });
    }
  }
  // 외형선 덩어리에 붙은 안쪽 고리 (바깥 경계에 닿지 않는 둘러싸인 곳)
  for (const v of views) {
    const b = (v as any)._blob as Blob;
    if (v.frame) continue;
    const { labels: el, comps: ec } = label(b.enclosed, 4);
    if (ec.length < 2) continue;
    // 바깥 경계 띠: 채운 영역에서 바깥까지 거리가 굵기의 2배 이내
    const dOut = distTo(b.filled, 0);
    const W = b.filled.w;
    const vh = ((b as any).lw ?? thick) / 2;
    const inner = ec.filter((c) => {
      if (c.area < minLoop / 4) return false;
      for (let y = c.box[1]; y <= c.box[3]; y++)
        for (let x = c.box[0]; x <= c.box[2]; x++) {
          const i = y * W + x;
          if (el[i] === c.id && dOut[i] <= thick * 2.2) return false;
        }
      return true;
    });
    if (!inner.length) continue;
    // 가는 선(중심선·지시선)으로 쪼개진 조각들은 이웃끼리 묶는다
    const gap = thick + 2;
    const near = (a: Comp, c: Comp) =>
      a.box[0] - gap <= c.box[2] && c.box[0] - gap <= a.box[2] && a.box[1] - gap <= c.box[3] && c.box[1] - gap <= a.box[3];
    const group = inner.map((_, i) => i);
    const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
    for (let i = 0; i < inner.length; i++)
      for (let j = i + 1; j < inner.length; j++) if (near(inner[i], inner[j]) && touching(el, W, inner[i], inner[j], gap)) group[find(i)] = find(j);
    const clusters = new Map<number, Comp[]>();
    inner.forEach((c, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), c]));
    const add = (out: { fit: Fitted; box: Box } | null, merged: boolean) => {
      if (!out) return;
      const cx = (out.box[0] + out.box[2]) / 2;
      const cy = (out.box[1] + out.box[3]) / 2;
      if (v.holes.some((o) => cx > o.box[0] && cx < o.box[2] && cy > o.box[1] && cy < o.box[3])) return;
      const simple = out.fit.kind === "circle" || isSlot(out.fit);
      v.holes.push({
        id: `h${hid++}`,
        fit: out.fit,
        box: out.box,
        on: simple,
        note: simple ? (merged ? "선이 지나가는 구멍" : undefined) : "안쪽 면 (구멍이 아닐 수 있음)",
      });
    };
    for (const list of clusters.values()) {
      const single = list.map((c) => {
        const { m } = cropComp(el, W, c, pad);
        return regionOutline(m, c.box[0] - pad + b.ox, c.box[1] - pad + b.oy, 1, -vh);
      });
      if (list.length > 1) {
        // 조각을 합친 영역 (사이의 가는 선을 메운다)
        const box: Comp = {
          id: -1,
          area: 0,
          box: [
            Math.min(...list.map((c) => c.box[0])),
            Math.min(...list.map((c) => c.box[1])),
            Math.max(...list.map((c) => c.box[2])),
            Math.max(...list.map((c) => c.box[3])),
          ],
        };
        const ids = new Set(list.map((c) => c.id));
        const ux = box.box[0] - pad;
        const uy = box.box[1] - pad;
        const uw = box.box[2] - box.box[0] + 1 + 2 * pad;
        const uh = box.box[3] - box.box[1] + 1 + 2 * pad;
        const um = mask(uw, uh);
        for (let y = box.box[1]; y <= box.box[3]; y++)
          for (let x = box.box[0]; x <= box.box[2]; x++) if (ids.has(el[y * W + x])) um.d[(y - uy) * uw + (x - ux)] = 1;
        const united = close(um, gap);
        const out = regionOutline(united, ux + b.ox, uy + b.oy, 1, -vh);
        // 합친 것이 원이고, 조각 중에 그보다 확실히 작은 완전한 원이 없으면 하나의 구멍
        const smallerCircle = single.some((o) => o && o.fit.kind === "circle" && out?.fit.kind === "circle" && o.fit.r < 0.8 * out.fit.r);
        if (out && (out.fit.kind === "circle" || isSlot(out.fit)) && !smallerCircle) {
          add(out, true);
          continue;
        }
      }
      for (const o of single) add(o, false);
    }
  }
  // 뷰 밖으로 삐져나간 구멍 후보는 버린다 (지시선·글자가 엉뚱하게 맞춰진 것)
  for (const v of views) {
    const [vx0, vy0, vx1, vy1] = v.box;
    const m = 0.05 * Math.max(vx1 - vx0, vy1 - vy0);
    v.holes = v.holes.filter((hh) => hh.box[0] >= vx0 - m && hh.box[1] >= vy0 - m && hh.box[2] <= vx1 + m && hh.box[3] <= vy1 + m);
  }
  // 빗금이 많은 뷰: 빗금 사이 작은 고리는 구멍이 아닐 가능성이 크다
  for (const v of views) {
    const faces = v.holes.filter((hh) => hh.note?.startsWith("안쪽 면")).length;
    if (faces < 5) continue;
    const size = Math.max(v.box[2] - v.box[0], v.box[3] - v.box[1]);
    for (const hh of v.holes)
      if (Math.max(hh.box[2] - hh.box[0], hh.box[3] - hh.box[1]) < 0.04 * size) {
        hh.on = false;
        hh.note = "안쪽 면 (빗금 사이 작은 고리)";
      }
  }
  // 동심원 바깥쪽(카운터보어·보스일 수 있음)은 기본으로 끈다
  for (const v of views)
    for (const a of v.holes) {
      if (a.fit.kind !== "circle") continue;
      for (const b of v.holes) {
        if (b === a || b.fit.kind !== "circle") continue;
        if (b.fit.r < a.fit.r * 0.95 && Math.hypot(a.fit.c[0] - b.fit.c[0], a.fit.c[1] - b.fit.c[1]) < Math.max(2, 0.1 * a.fit.r)) {
          a.on = false;
          a.note = "동심원 바깥쪽 (카운터보어·보스일 수 있음)";
        }
      }
    }
  for (const v of views) delete (v as any)._blob;
  assignRoles(views);
  return { w, h, stroke, views, revolve: looksRevolved(views) };
}

/** 두 조각이 가는 선 하나 사이로 맞닿는지 (gap 안에 서로의 픽셀이 있는지) */
function touching(labels: Int32Array, W: number, a: Comp, b: Comp, gapF: number): boolean {
  const gap = Math.ceil(gapF);
  const x0 = Math.max(a.box[0], b.box[0] - gap);
  const x1 = Math.min(a.box[2], b.box[2] + gap);
  const y0 = Math.max(a.box[1], b.box[1] - gap);
  const y1 = Math.min(a.box[3], b.box[3] + gap);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (labels[y * W + x] !== a.id) continue;
      for (let dy = -gap; dy <= gap; dy += 1)
        for (let dx = -gap; dx <= gap; dx += 1) {
          if (dx * dx + dy * dy > gap * gap) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W) continue;
          if (labels[yy * W + xx] === b.id) return true;
        }
    }
  return false;
}

export function isSlot(f: Fitted): boolean {
  if (f.kind === "slot") return true;
  if (f.kind !== "path" || f.prims.length !== 4) return false;
  const arcs = f.prims.filter((p) => p.t === "arc");
  if (arcs.length !== 2) return false;
  const [a, b] = arcs as Extract<(typeof f.prims)[number], { t: "arc" }>[];
  const sweep = (p: typeof a) => {
    const chord = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
    return chord / (2 * p.r);
  };
  return Math.abs(a.r - b.r) < 0.15 * a.r && sweep(a) > 0.9 && sweep(b) > 0.9 && f.prims[0].t !== f.prims[1].t;
}

// ---------------- 뷰 이름 (3각법) ----------------

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(1e-9, Math.min(a1 - a0, b1 - b0));

export function assignRoles(views: DetectedView[]) {
  const cand = views.filter((v) => !v.frame);
  for (const v of views) v.role = null;
  if (!cand.length) return;
  if (cand.length === 1) {
    cand[0].role = "top";
    return;
  }
  let best: { f: DetectedView; t: DetectedView | null; s: DetectedView | null; score: number } | null = null;
  const area = (v: DetectedView) => (v.box[2] - v.box[0]) * (v.box[3] - v.box[1]);
  for (const f of cand) {
    const [fx0, fy0, fx1, fy1] = f.box;
    // 위쪽에 있고 가로 범위가 겹치는 것 중 가장 가까운 것
    const tops = cand.filter((o) => o !== f && o.box[3] < fy0 + 0.1 * (fy1 - fy0) && overlap(fx0, fx1, o.box[0], o.box[2]) > 0.7);
    const sides = cand.filter((o) => o !== f && o.box[0] > fx1 - 0.1 * (fx1 - fx0) && overlap(fy0, fy1, o.box[1], o.box[3]) > 0.7);
    const near = (list: DetectedView[], d: (o: DetectedView) => number) => list.sort((a, b) => d(a) - d(b))[0] ?? null;
    const t = near(tops, (o) => fy0 - o.box[3]);
    const s = near(sides, (o) => o.box[0] - fx1);
    const match = (t ? 1 : 0) + (s ? 1 : 0);
    // 가로 길이가 같을수록(같은 물체) 점수가 높다
    const align = (t ? 1 - Math.abs(t.box[2] - t.box[0] - (fx1 - fx0)) / (fx1 - fx0) : 0) + (s ? 1 - Math.abs(s.box[3] - s.box[1] - (fy1 - fy0)) / (fy1 - fy0) : 0);
    const score = match * 10 + align + area(f) / (area(f) + 1e6);
    if (!best || score > best.score) best = { f, t, s, score };
  }
  if (!best || (!best.t && !best.s)) {
    // 짝이 없으면 가장 큰 것 하나만 평면도로
    cand.sort((a, b) => area(b) - area(a))[0].role = "top";
    return;
  }
  best.f.role = "front";
  if (best.t) best.t.role = "top";
  if (best.s) best.s.role = "side";
}

/** 평면도 외형이 원이고 정면도·우측면도가 같은 모양이면 회전체 */
function looksRevolved(views: DetectedView[]): boolean {
  const top = views.find((v) => v.role === "top");
  const front = views.find((v) => v.role === "front");
  if (!top || !front || top.outline.kind !== "circle") return false;
  const side = views.find((v) => v.role === "side");
  if (!side) return true;
  const fw = front.box[2] - front.box[0];
  const sw = side.box[2] - side.box[0];
  return Math.abs(fw - sw) < 0.05 * fw;
}
