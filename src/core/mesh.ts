/**
 * 삼각형 메쉬(STL) 다루기: 읽기, 꼭짓점 합치기, 돌리기, 부피, 그리고 3면도 투영(숨은선 포함).
 * STL에는 원·면 정보가 없으므로 "모서리 선"을 직접 고른다:
 *  - 두 면이 25° 넘게 꺾이는 모서리, 열린 가장자리, 그 뷰에서 앞면·뒷면이 바뀌는 윤곽선
 * 보이는지 숨는지는 깊이 버퍼(z-buffer)로 판단한다.
 */
import type { MeshData, ProjectedView, ViewId } from "./types";

export interface Mesh {
  /** 꼭짓점 xyz */
  pos: Float64Array;
  /** 삼각형 꼭짓점 번호 */
  tri: Uint32Array;
}

// ---------------- 읽기 ----------------

export function parseSTL(buf: ArrayBuffer): Mesh {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(512, bytes.length)));
  const n = bytes.length >= 84 ? new DataView(buf).getUint32(80, true) : 0;
  const isBinary = bytes.length === 84 + n * 50;
  if (!isBinary && /^\s*solid/i.test(head)) return parseAscii(new TextDecoder().decode(bytes));
  if (bytes.length < 84 + n * 50 || n === 0) throw new Error("STL 파일을 읽을 수 없습니다.");
  const dv = new DataView(buf);
  const raw = new Float64Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) raw[i * 9 + k] = dv.getFloat32(o + k * 4, true);
  }
  return weld(raw);
}

function parseAscii(text: string): Mesh {
  const nums: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) nums.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  if (nums.length < 9 || nums.some((v) => !Number.isFinite(v))) throw new Error("STL 파일을 읽을 수 없습니다.");
  return weld(Float64Array.from(nums.slice(0, nums.length - (nums.length % 9))));
}

/** 같은 자리의 꼭짓점 합치기 (삼각형마다 따로 적힌 STL → 공유 꼭짓점) */
export function weld(raw: Float64Array): Mesh {
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < raw.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], raw[i + k]);
      hi[k] = Math.max(hi[k], raw[i + k]);
    }
  const tol = Math.max(1e-9, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1e-7);
  const map = new Map<string, number>();
  const pos: number[] = [];
  const tri: number[] = [];
  const nt = raw.length / 9;
  for (let t = 0; t < nt; t++) {
    const ids: number[] = [];
    for (let c = 0; c < 3; c++) {
      const o = t * 9 + c * 3;
      const key = `${Math.round(raw[o] / tol)},${Math.round(raw[o + 1] / tol)},${Math.round(raw[o + 2] / tol)}`;
      let id = map.get(key);
      if (id === undefined) {
        id = pos.length / 3;
        map.set(key, id);
        pos.push(raw[o], raw[o + 1], raw[o + 2]);
      }
      ids.push(id);
    }
    // 넓이 0인 삼각형은 버린다
    if (ids[0] !== ids[1] && ids[1] !== ids[2] && ids[0] !== ids[2]) tri.push(...ids);
  }
  lo = hi = [];
  return { pos: Float64Array.from(pos), tri: Uint32Array.from(tri) };
}

// ---------------- 변환과 측정 ----------------

/** 90° 단위 돌리기: X축으로 rx번, 그다음 Y축 ry번, Z축 rz번 (오른손 법칙) */
export function rotateQuarter(m: Mesh, turns: [number, number, number]): Mesh {
  const pos = m.pos.slice();
  const rot = (axis: 0 | 1 | 2, k: number) => {
    k = ((k % 4) + 4) % 4;
    for (let s = 0; s < k; s++)
      for (let i = 0; i < pos.length; i += 3) {
        const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
        if (axis === 0) (pos[i + 1] = -z), (pos[i + 2] = y);
        else if (axis === 1) (pos[i] = z), (pos[i + 2] = -x);
        else (pos[i] = -y), (pos[i + 1] = x);
      }
  };
  rot(0, turns[0]);
  rot(1, turns[1]);
  rot(2, turns[2]);
  return { pos, tri: m.tri };
}

export function meshBBox(m: Mesh): [[number, number, number], [number, number, number]] {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], m.pos[i + k]);
      hi[k] = Math.max(hi[k], m.pos[i + k]);
    }
  return [lo, hi];
}

/** 부피 (닫힌 메쉬의 부호 있는 사면체 합) */
export function meshVolume(m: Mesh): number {
  let v = 0;
  const p = m.pos;
  for (let t = 0; t < m.tri.length; t += 3) {
    const a = m.tri[t] * 3;
    const b = m.tri[t + 1] * 3;
    const c = m.tri[t + 2] * 3;
    v +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
  }
  return Math.abs(v);
}

/** 서로 이어지지 않은 덩어리 수 */
export function meshComponents(m: Mesh): number {
  const parent = new Int32Array(m.pos.length / 3).map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let t = 0; t < m.tri.length; t += 3) {
    const a = find(m.tri[t]);
    parent[find(m.tri[t + 1])] = a;
    parent[find(m.tri[t + 2])] = a;
  }
  const used = new Set<number>();
  for (let t = 0; t < m.tri.length; t++) used.add(find(m.tri[t]));
  return used.size;
}

function faceNormals(m: Mesh): Float64Array {
  const nt = m.tri.length / 3;
  const out = new Float64Array(nt * 3);
  const p = m.pos;
  for (let t = 0; t < nt; t++) {
    const a = m.tri[t * 3] * 3;
    const b = m.tri[t * 3 + 1] * 3;
    const c = m.tri[t * 3 + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    out[t * 3] = nx / L;
    out[t * 3 + 1] = ny / L;
    out[t * 3 + 2] = nz / L;
  }
  return out;
}

interface Edge {
  a: number;
  b: number;
  faces: number[];
}

function edges(m: Mesh): Edge[] {
  const map = new Map<number, Edge>();
  const nv = m.pos.length / 3;
  for (let t = 0; t < m.tri.length / 3; t++)
    for (let k = 0; k < 3; k++) {
      const i = m.tri[t * 3 + k];
      const j = m.tri[t * 3 + ((k + 1) % 3)];
      const a = Math.min(i, j);
      const b = Math.max(i, j);
      const key = a * nv + b;
      const e = map.get(key);
      if (e) e.faces.push(t);
      else map.set(key, { a, b, faces: [t] });
    }
  return [...map.values()];
}

const SHARP = Math.cos((25 * Math.PI) / 180);

/** 3D 화면용: 면마다 따로 꼭짓점(평평한 음영) + 꺾인 모서리 선 */
export function meshForViewer(m: Mesh): MeshData {
  const fn = faceNormals(m);
  const nt = m.tri.length / 3;
  const vertices: number[] = [];
  const normals: number[] = [];
  const triangles: number[] = [];
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = m.tri[t * 3 + k] * 3;
      vertices.push(m.pos[v], m.pos[v + 1], m.pos[v + 2]);
      normals.push(fn[t * 3], fn[t * 3 + 1], fn[t * 3 + 2]);
      triangles.push(t * 3 + k);
    }
  }
  const lines: number[] = [];
  for (const e of edges(m)) {
    const [f1, f2] = e.faces;
    const sharp = e.faces.length !== 2 || fn[f1 * 3] * fn[f2 * 3] + fn[f1 * 3 + 1] * fn[f2 * 3 + 1] + fn[f1 * 3 + 2] * fn[f2 * 3 + 2] < SHARP;
    if (!sharp) continue;
    lines.push(m.pos[e.a * 3], m.pos[e.a * 3 + 1], m.pos[e.a * 3 + 2], m.pos[e.b * 3], m.pos[e.b * 3 + 1], m.pos[e.b * 3 + 2]);
  }
  return { vertices, normals, triangles, edges: lines };
}

// ---------------- 투영 ----------------

/** 뷰 좌표 (u, v)와 보는 사람 쪽으로 가까울수록 큰 깊이 */
function viewMap(view: ViewId): (x: number, y: number, z: number) => [number, number, number] {
  if (view === "front") return (x, y, z) => [x, z, -y];
  if (view === "top") return (x, y, z) => [x, y, z];
  return (x, y, z) => [y, z, x];
}
const VIEW_DIR: Record<ViewId, [number, number, number]> = { front: [0, -1, 0], top: [0, 0, 1], side: [1, 0, 0] };

/**
 * 3면도 한 뷰. 결과 경로는 replicad 투영과 같은 형식 (SVG 좌표 = (u, -v)).
 * res: 깊이 버퍼 해상도 (긴 변 픽셀)
 */
export function projectMesh(m: Mesh, view: ViewId, res = 1400): ProjectedView {
  const map = viewMap(view);
  const nv = m.pos.length / 3;
  const P = new Float64Array(nv * 3);
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  let d0 = Infinity;
  let d1 = -Infinity;
  for (let i = 0; i < nv; i++) {
    const q = map(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]);
    P[i * 3] = q[0];
    P[i * 3 + 1] = q[1];
    P[i * 3 + 2] = q[2];
    u0 = Math.min(u0, q[0]);
    u1 = Math.max(u1, q[0]);
    v0 = Math.min(v0, q[1]);
    v1 = Math.max(v1, q[1]);
    d0 = Math.min(d0, q[2]);
    d1 = Math.max(d1, q[2]);
  }
  if (!nv) return { visible: [], hidden: [], bounds: null };
  const span = Math.max(u1 - u0, v1 - v0, 1e-9);
  const k = res / span;
  const W = Math.ceil((u1 - u0) * k) + 3;
  const H = Math.ceil((v1 - v0) * k) + 3;
  const zb = new Float32Array(W * H).fill(-Infinity);
  const X = (u: number) => (u - u0) * k + 1;
  const Y = (v: number) => (v1 - v) * k + 1;
  // 깊이 버퍼 채우기
  const nt = m.tri.length / 3;
  for (let t = 0; t < nt; t++) {
    const a = m.tri[t * 3] * 3;
    const b = m.tri[t * 3 + 1] * 3;
    const c = m.tri[t * 3 + 2] * 3;
    rasterTri(zb, W, H, X(P[a]), Y(P[a + 1]), P[a + 2], X(P[b]), Y(P[b + 1]), P[b + 2], X(P[c]), Y(P[c + 1]), P[c + 2]);
  }
  // 그릴 모서리
  const fn = faceNormals(m);
  const vd = VIEW_DIR[view];
  const eps = (d1 - d0 + span) * 0.0015;
  const visible: string[] = [];
  const hidden: string[] = [];
  const f = (n: number) => Math.round(n * 1e4) / 1e4;
  const seg = (out: string[], ua: number, va: number, ub: number, vb: number) => {
    if (Math.hypot(ub - ua, vb - va) < 1e-6) return;
    out.push(`M ${f(ua)} ${f(-va)} L ${f(ub)} ${f(-vb)}`);
  };
  for (const e of edges(m)) {
    let draw = e.faces.length !== 2;
    if (!draw) {
      const [f1, f2] = e.faces;
      const n1 = [fn[f1 * 3], fn[f1 * 3 + 1], fn[f1 * 3 + 2]];
      const n2 = [fn[f2 * 3], fn[f2 * 3 + 1], fn[f2 * 3 + 2]];
      const dot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
      const s1 = n1[0] * vd[0] + n1[1] * vd[1] + n1[2] * vd[2];
      const s2 = n2[0] * vd[0] + n2[1] * vd[1] + n2[2] * vd[2];
      draw = dot < SHARP || (s1 > 1e-6 && s2 < -1e-6) || (s1 < -1e-6 && s2 > 1e-6);
    }
    if (!draw) continue;
    const ua = P[e.a * 3];
    const va = P[e.a * 3 + 1];
    const da = P[e.a * 3 + 2];
    const ub = P[e.b * 3];
    const vb = P[e.b * 3 + 1];
    const db = P[e.b * 3 + 2];
    const L = Math.hypot(X(ub) - X(ua), Y(vb) - Y(va));
    const steps = Math.max(1, Math.ceil(L * 1.5));
    // 표본마다 보이는지: 둘레 3×3 픽셀 중 하나라도 이 선보다 앞에 아무것도 없으면 보임
    let runStart = 0;
    let runVis: boolean | null = null;
    const visAt = (s: number) => {
      const t = s / steps;
      const u = ua + (ub - ua) * t;
      const v = va + (vb - va) * t;
      const d = da + (db - da) * t;
      const px = Math.round(X(u));
      const py = Math.round(Y(v));
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) return true;
          if (zb[y * W + x] <= d + eps) return true;
        }
      return false;
    };
    for (let s = 0; s <= steps; s++) {
      const vis = visAt(s);
      if (runVis === null) runVis = vis;
      if (vis !== runVis || s === steps) {
        const end = vis !== runVis ? s : steps;
        const t0 = runStart / steps;
        const t1 = end / steps;
        seg(runVis ? visible : hidden, ua + (ub - ua) * t0, va + (vb - va) * t0, ua + (ub - ua) * t1, va + (vb - va) * t1);
        runStart = end;
        runVis = vis;
      }
    }
  }
  return {
    visible: mergeSegments(visible),
    hidden: mergeSegments(hidden),
    bounds: [
      [u0, v0],
      [u1, v1],
    ],
  };
}

/** 깊이 버퍼에 삼각형 하나 (화면 좌표, 가까울수록 큰 깊이) */
function rasterTri(zb: Float32Array, W: number, H: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-12) return;
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const px = x;
      const py = y;
      const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
      const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const z = w0 * z0 + w1 * z1 + w2 * z2;
      const i = y * W + x;
      if (z > zb[i]) zb[i] = z;
    }
}

/** 한 직선 위에서 이어지는 조각들을 하나로 (도면 선 수 줄이기) */
function mergeSegments(paths: string[]): string[] {
  type S = { a: [number, number]; b: [number, number] };
  const segs: S[] = paths.map((p) => {
    const n = p.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)!.map(Number);
    return { a: [n[0], n[1]], b: [n[2], n[3]] };
  });
  const key = (p: [number, number]) => `${p[0]},${p[1]}`;
  const byEnd = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const p of [s.a, s.b]) byEnd.set(key(p), [...(byEnd.get(key(p)) ?? []), i]);
  });
  const used = new Uint8Array(segs.length);
  const out: string[] = [];
  const seen = new Set<string>();
  const collinear = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) <= 1e-6 * (Math.hypot(q[0] - p[0], q[1] - p[1]) * Math.hypot(r[0] - p[0], r[1] - p[1]) + 1e-12);
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let { a, b } = segs[i];
    // 양쪽으로 같은 직선의 조각을 이어 붙인다
    for (const dir of [0, 1]) {
      for (;;) {
        const end = dir ? b : a;
        const other = dir ? a : b;
        // 같은 직선 위에서 끝점 바깥쪽으로 이어지는 조각만 (겹쳐서 되돌아오는 조각은 따로 둔다)
        const farOf = (j: number) => (key(segs[j].a) === key(end) ? segs[j].b : segs[j].a);
        const next = (byEnd.get(key(end)) ?? []).find((j) => {
          if (used[j]) return false;
          const far = farOf(j);
          const forward = (far[0] - end[0]) * (end[0] - other[0]) + (far[1] - end[1]) * (end[1] - other[1]) > 0;
          return forward && collinear(other, end, far);
        });
        if (next === undefined) break;
        used[next] = 1;
        const far = key(segs[next].a) === key(end) ? segs[next].b : segs[next].a;
        if (dir) b = far;
        else a = far;
      }
    }
    // 똑같은 선(앞뒤 모서리가 겹쳐 보이는 것)은 한 번만
    const id = [key(a), key(b)].sort().join("|");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(`M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}`);
  }
  return out;
}

/** 이진 STL로 쓰기 */
export function meshToSTL(m: Mesh): ArrayBuffer {
  const nt = m.tri.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, nt, true);
  const fn = faceNormals(m);
  for (let t = 0; t < nt; t++) {
    const o = 84 + t * 50;
    for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, fn[t * 3 + k], true);
    for (let c = 0; c < 3; c++) {
      const v = m.tri[t * 3 + c] * 3;
      for (let k = 0; k < 3; k++) dv.setFloat32(o + 12 + c * 12 + k * 4, m.pos[v + k], true);
    }
  }
  return buf;
}
