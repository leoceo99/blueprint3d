/**
 * 3D → 2D: 투영 결과로 3각법 3면도 도면(SVG, DXF)을 만든다.
 * 순수 함수라서 워커/화면/테스트 어디서든 사용 가능.
 */
import type { BuildResult, ViewId } from "./types";
import { VIEW_LABEL } from "./types";

type Pt = [number, number];
export interface Polyline {
  layer: "VISIBLE" | "HIDDEN" | "DIM";
  pts: Pt[];
}
export interface SheetText {
  at: Pt;
  text: string;
  size: number;
  rotate?: number;
}

export interface Sheet {
  svg: string;
  polylines: Polyline[];
  texts: SheetText[];
  width: number;
  height: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** SVG path(절대좌표 M/L/H/V/C/Q/A/Z)를 점 목록으로 근사. 결과는 SVG 좌표(y 아래). */
export function flattenPath(d: string, segPerCurve = 16): Pt[][] {
  const tokens = d.match(/[MLHVCQAZmlhvcqaz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let p: Pt = [0, 0];
  let start: Pt = [0, 0];
  let i = 0;
  let cmd = "";
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    switch (cmd.toUpperCase()) {
      case "M":
        if (cur.length > 1) out.push(cur);
        p = [num(), num()];
        start = p;
        cur = [p];
        cmd = "L";
        break;
      case "L":
        p = [num(), num()];
        cur.push(p);
        break;
      case "H":
        p = [num(), p[1]];
        cur.push(p);
        break;
      case "V":
        p = [p[0], num()];
        cur.push(p);
        break;
      case "C": {
        const c1: Pt = [num(), num()];
        const c2: Pt = [num(), num()];
        const e: Pt = [num(), num()];
        const s = p;
        for (let k = 1; k <= segPerCurve; k++) {
          const t = k / segPerCurve;
          const a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, dd = t ** 3;
          cur.push([a * s[0] + b * c1[0] + c * c2[0] + dd * e[0], a * s[1] + b * c1[1] + c * c2[1] + dd * e[1]]);
        }
        p = e;
        break;
      }
      case "Q": {
        const c1: Pt = [num(), num()];
        const e: Pt = [num(), num()];
        const s = p;
        for (let k = 1; k <= segPerCurve; k++) {
          const t = k / segPerCurve;
          const a = (1 - t) ** 2, b = 2 * (1 - t) * t, c = t * t;
          cur.push([a * s[0] + b * c1[0] + c * e[0], a * s[1] + b * c1[1] + c * e[1]]);
        }
        p = e;
        break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const e: Pt = [num(), num()];
        cur.push(...arcPoints(p, e, rx, ry, rot, !!large, !!sweep, segPerCurve * 2));
        p = e;
        break;
      }
      case "Z":
        cur.push(start);
        p = start;
        break;
      default:
        i++;
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** SVG 원호(끝점 방식)를 점으로 근사 */
function arcPoints(p0: Pt, p1: Pt, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, n: number): Pt[] {
  if (!rx || !ry) return [p1];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  // 큰 원호도 매끄럽게: 최소 2.5°마다 한 점 (n은 원 한 바퀴 최소 점 수)
  const steps = Math.max(4, Math.ceil((Math.abs(dt) / (2 * Math.PI)) * n), Math.ceil(Math.abs(dt) / (Math.PI / 72)));
  const pts: Pt[] = [];
  for (let k = 1; k <= steps; k++) {
    const t = t1 + (dt * k) / steps;
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    pts.push([cos * x - sin * y + cx, sin * x + cos * y + cy]);
  }
  return pts;
}

/** 3각법 배치: 정면도 기준, 평면도는 위, 우측면도는 오른쪽 */
export function buildSheet(res: BuildResult, title: string): Sheet {
  const pr = res.projections;
  const [[x0, y0, z0], [x1, y1, z1]] = res.bbox;
  const W = x1 - x0, D = y1 - y0, H = z1 - z0;
  const size = Math.max(W, D, H, 1);
  const gap = size * 0.45 + 10;
  const unit = size / 40; // 글자/화살표 크기 기준
  const txt = Math.max(unit * 1.3, 2.5);

  const b = (v: ViewId) => pr[v].bounds ?? [[0, 0], [0, 0]];
  const fb = b("front"), tb = b("top"), sb = b("side");
  // 각 뷰의 (u,v) 이동량 (월드 좌표, v 위쪽)
  const off: Record<ViewId, Pt> = {
    front: [0, 0],
    top: [0, fb[1][1] + gap - tb[0][1]],
    side: [fb[1][0] + gap - sb[0][0], 0],
  };

  const polylines: Polyline[] = [];
  const texts: SheetText[] = [];
  // 투영 경로: SVG 좌표(u, -v) → 월드 좌표로 바꿔서 저장
  for (const v of ["front", "top", "side"] as ViewId[]) {
    const [du, dv] = off[v];
    for (const [layer, paths] of [
      ["HIDDEN", pr[v].hidden],
      ["VISIBLE", pr[v].visible],
    ] as const) {
      for (const d of paths)
        for (const pl of flattenPath(d)) polylines.push({ layer, pts: pl.map(([u, sv]) => [u + du, -sv + dv]) });
    }
  }

  // 치수: 전체 폭/높이/깊이
  const dimGap = unit * 3 + 4;
  const fminU = fb[0][0], fmaxU = fb[1][0], fminV = fb[0][1], fmaxV = fb[1][1];
  addDim(polylines, texts, [fminU, fminV], [fmaxU, fminV], -dimGap, "h", fmt(W), txt);
  addDim(polylines, texts, [fminU, fminV], [fminU, fmaxV], -dimGap, "v", fmt(H), txt);
  const sOff = off.side;
  addDim(polylines, texts, [sb[0][0] + sOff[0], sb[0][1]], [sb[1][0] + sOff[0], sb[0][1]], -dimGap, "h", fmt(D), txt);

  // 뷰 이름
  for (const v of ["front", "top", "side"] as ViewId[]) {
    const bb = b(v);
    texts.push({ at: [(bb[0][0] + bb[1][0]) / 2 + off[v][0], bb[1][1] + off[v][1] + txt * 0.8], text: VIEW_LABEL[v], size: txt });
  }

  // 전체 범위 → 여백 + 표제란
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (const pl of polylines)
    for (const [u, v] of pl.pts) {
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
  for (const t of texts) {
    minU = Math.min(minU, t.at[0] - t.size * 4); maxU = Math.max(maxU, t.at[0] + t.size * 4);
    minV = Math.min(minV, t.at[1] - t.size); maxV = Math.max(maxV, t.at[1] + t.size);
  }
  const margin = unit * 4 + 5;
  const tbH = txt * 5.2, tbW = Math.max(txt * 22, 60);
  minU -= margin; minV -= margin + tbH; maxU += margin; maxV += margin;
  maxU = Math.max(maxU, minU + tbW + margin);
  // 테두리 + 표제란
  const frame = (a: Pt, c: Pt): Pt[] => [a, [c[0], a[1]], c, [a[0], c[1]], a];
  polylines.push({ layer: "DIM", pts: frame([minU + 2, minV + 2], [maxU - 2, maxV - 2]) });
  const tb0: Pt = [maxU - 2 - tbW, minV + 2];
  polylines.push({ layer: "DIM", pts: frame(tb0, [maxU - 2, minV + 2 + tbH]) });
  polylines.push({ layer: "DIM", pts: [[tb0[0], tb0[1] + tbH / 2], [maxU - 2, tb0[1] + tbH / 2]] });
  texts.push({ at: [tb0[0] + tbW / 2, tb0[1] + tbH * 0.75], text: title, size: txt * 1.1 });
  texts.push({ at: [tb0[0] + tbW / 2, tb0[1] + tbH * 0.25], text: "단위 mm · 3각법 · 척도 1:1", size: txt * 0.85 });

  const width = maxU - minU, height = maxV - minV;
  const svg = toSVG(polylines, texts, minU, maxV, width, height, unit);
  return { svg, polylines, texts, width, height };
}

function addDim(pl: Polyline[], tx: SheetText[], a: Pt, b: Pt, offset: number, dir: "h" | "v", label: string, size: number) {
  const arrow = size * 0.8;
  if (dir === "h") {
    const y = a[1] + offset;
    pl.push({ layer: "DIM", pts: [[a[0], a[1] - size * 0.3], [a[0], y - size * 0.4]] });
    pl.push({ layer: "DIM", pts: [[b[0], b[1] - size * 0.3], [b[0], y - size * 0.4]] });
    pl.push({ layer: "DIM", pts: [[a[0], y], [b[0], y]] });
    pl.push({ layer: "DIM", pts: [[a[0] + arrow, y + arrow * 0.3], [a[0], y], [a[0] + arrow, y - arrow * 0.3]] });
    pl.push({ layer: "DIM", pts: [[b[0] - arrow, y + arrow * 0.3], [b[0], y], [b[0] - arrow, y - arrow * 0.3]] });
    tx.push({ at: [(a[0] + b[0]) / 2, y + size * 0.35], text: label, size });
  } else {
    const x = a[0] + offset;
    pl.push({ layer: "DIM", pts: [[a[0] - size * 0.3, a[1]], [x - size * 0.4, a[1]]] });
    pl.push({ layer: "DIM", pts: [[b[0] - size * 0.3, b[1]], [x - size * 0.4, b[1]]] });
    pl.push({ layer: "DIM", pts: [[x, a[1]], [x, b[1]]] });
    pl.push({ layer: "DIM", pts: [[x - arrow * 0.3, a[1] + arrow], [x, a[1]], [x + arrow * 0.3, a[1] + arrow]] });
    pl.push({ layer: "DIM", pts: [[x - arrow * 0.3, b[1] - arrow], [x, b[1]], [x + arrow * 0.3, b[1] - arrow]] });
    tx.push({ at: [x - size * 0.35, (a[1] + b[1]) / 2], text: label, size, rotate: 90 });
  }
}

function fmt(n: number) {
  return String(r2(n));
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function toSVG(pls: Polyline[], texts: SheetText[], minU: number, maxV: number, w: number, h: number, unit: number) {
  // 월드(v 위) → SVG(y 아래): x = u - minU, y = maxV - v
  const P = ([u, v]: Pt) => `${r2(u - minU)},${r2(maxV - v)}`;
  const sw = { VISIBLE: Math.max(unit * 0.12, 0.35), HIDDEN: Math.max(unit * 0.07, 0.2), DIM: Math.max(unit * 0.05, 0.18) };
  const dash = `${r2(unit * 0.6 + 1)} ${r2(unit * 0.35 + 0.6)}`;
  const group = (layer: Polyline["layer"], extra: string) =>
    `<g fill="none" stroke="currentColor" stroke-width="${r2(sw[layer])}" stroke-linecap="round" stroke-linejoin="round" ${extra}>` +
    pls.filter((p) => p.layer === layer).map((p) => `<polyline points="${p.pts.map(P).join(" ")}"/>`).join("") +
    `</g>`;
  const t = texts
    .map((tx) => {
      const [x, y] = P(tx.at).split(",");
      const rot = tx.rotate ? ` transform="rotate(${-tx.rotate} ${x} ${y})"` : "";
      return `<text x="${x}" y="${y}" font-size="${r2(tx.size)}"${rot}>${esc(tx.text)}</text>`;
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(w)}mm" height="${r2(h)}mm" viewBox="0 0 ${r2(w)} ${r2(h)}" style="color:#111;background:#fff">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    group("DIM", `opacity="0.85"`) +
    group("HIDDEN", `stroke-dasharray="${dash}" opacity="0.75"`) +
    group("VISIBLE", "") +
    `<g fill="currentColor" font-family="system-ui, sans-serif" text-anchor="middle" dominant-baseline="middle">${t}</g>` +
    `</svg>`
  );
}

/** AutoCAD R12 호환 DXF (LINE + TEXT, 레이어/선종류 포함) */
export function sheetToDXF(sheet: Sheet): string {
  const out: string[] = [];
  const g = (code: number, v: string | number) => out.push(String(code), String(v));
  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$INSUNITS"); g(70, 4);
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LTYPE"); g(70, 2);
  g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0); g(3, "Solid line"); g(72, 65); g(73, 0); g(40, 0);
  g(0, "LTYPE"); g(2, "HIDDEN"); g(70, 0); g(3, "Hidden __ __ __"); g(72, 65); g(73, 2); g(40, 4.5); g(49, 3); g(49, -1.5);
  g(0, "ENDTAB");
  g(0, "TABLE"); g(2, "LAYER"); g(70, 3);
  for (const [name, color, lt] of [["VISIBLE", 7, "CONTINUOUS"], ["HIDDEN", 8, "HIDDEN"], ["DIM", 3, "CONTINUOUS"]] as const) {
    g(0, "LAYER"); g(2, name); g(70, 0); g(62, color); g(6, lt);
  }
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const pl of sheet.polylines)
    for (let i = 1; i < pl.pts.length; i++) {
      const [a, b] = [pl.pts[i - 1], pl.pts[i]];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      g(0, "LINE"); g(8, pl.layer);
      g(10, r2(a[0])); g(20, r2(a[1])); g(30, 0);
      g(11, r2(b[0])); g(21, r2(b[1])); g(31, 0);
    }
  for (const t of sheet.texts) {
    g(0, "TEXT"); g(8, "DIM");
    g(10, r2(t.at[0])); g(20, r2(t.at[1])); g(30, 0);
    g(40, r2(t.size)); g(1, t.text);
    if (t.rotate) g(50, t.rotate);
    g(72, 1); g(73, 2); g(11, r2(t.at[0])); g(21, r2(t.at[1])); g(31, 0);
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\n") + "\n";
}
