import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MeshData } from "../core/types";

/** 3D 화면에서 고르는 것 (13단계): 면 · 모서리 · 둘 다 · 평평한 면(스케치 평면) */
export type PickMode = "none" | "face" | "edge" | "faceEdge" | "plane";
export interface PickHit {
  kind: "face" | "edge";
  index: number;
}

/** 3D 모델 뷰어 (Z가 위쪽인 CAD 좌표계) */
export class Viewer3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private grid: THREE.GridHelper | null = null;
  private material = new THREE.MeshStandardMaterial({
    color: 0x8fb4d9,
    metalness: 0.25,
    roughness: 0.55,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    side: THREE.DoubleSide,
  });
  private edgeMaterial = new THREE.LineBasicMaterial({ color: 0x1d2a3a });
  // ---- 고르기·강조 (13단계) ----
  private model: THREE.Mesh | null = null;
  private meshData: MeshData | null = null;
  /** 삼각형 → 면 번호 */
  private triFace: Int32Array | null = null;
  pickMode: PickMode = "none";
  onPick: ((hit: PickHit, e: PointerEvent) => void) | null = null;
  /** 평평한 면인지 (평면 고르기에서 씀) */
  isPlanar: ((face: number) => boolean) | null = null;
  private hlGroup = new THREE.Group();
  private hoverHit: PickHit | null = null;
  private selFaces: number[] = [];
  private selEdges: number[] = [];
  private overlay: THREE.LineSegments | null = null;
  private selFaceMat = new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide, depthWrite: false });
  private hoverFaceMat = new THREE.MeshBasicMaterial({ color: 0x3d8bfd, transparent: true, opacity: 0.35, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: THREE.DoubleSide, depthWrite: false });
  private selEdgeMat = new THREE.LineBasicMaterial({ color: 0xff6a00, depthTest: false });
  private hoverEdgeMat = new THREE.LineBasicMaterial({ color: 0x1f6fff, depthTest: false });
  private overlayMat = new THREE.LineBasicMaterial({ color: 0x2f7bf6, transparent: true, opacity: 0.9 });
  private downAt: [number, number] | null = null;
  private radius = 50;
  private center = new THREE.Vector3();
  private active = false;
  private pendingReset = false;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -2, 3);
    this.camera.add(key);
    this.scene.add(this.camera);
    this.scene.add(this.group);
    this.scene.add(this.hlGroup);
    const axes = new THREE.AxesHelper(1);
    axes.name = "axes";
    this.scene.add(axes);
    new ResizeObserver(() => this.resize()).observe(host);
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => {
      this.downAt = e.button === 0 ? [e.clientX, e.clientY] : null;
    });
    el.addEventListener("pointerup", (e) => {
      const d = this.downAt;
      this.downAt = null;
      if (!d || this.pickMode === "none" || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 5) return;
      const hit = this.pickAt(e.clientX, e.clientY, e.pointerType === "touch" ? 16 : 8);
      if (hit) this.onPick?.(hit, e);
    });
    el.addEventListener("pointermove", (e) => {
      if (e.buttons || this.pickMode === "none") return;
      const hit = this.pickAt(e.clientX, e.clientY, 8);
      if (JSON.stringify(hit) !== JSON.stringify(this.hoverHit)) {
        this.hoverHit = hit;
        this.renderHighlights();
      }
      el.style.cursor = hit ? "pointer" : "";
    });
    el.addEventListener("pointerleave", () => {
      if (!this.hoverHit) return;
      this.hoverHit = null;
      this.renderHighlights();
    });
    this.loop();
  }

  // ---------------- 고르기 (13단계) ----------------

  setPickMode(m: PickMode) {
    if (m === this.pickMode) return;
    this.pickMode = m;
    this.hoverHit = null;
    if (m === "none") this.renderer.domElement.style.cursor = "";
    this.renderHighlights();
  }

  /** 고른 면·모서리 강조 (번호는 결과의 topo 순서) */
  setSelection(faces: number[], edges: number[]) {
    this.selFaces = faces;
    this.selEdges = edges;
    this.renderHighlights();
  }

  /** 스케치 선 (3D 좌표 선분 쌍) */
  setOverlay(lines: number[] | null) {
    if (this.overlay) {
      this.scene.remove(this.overlay);
      this.overlay.geometry.dispose();
      this.overlay = null;
    }
    if (!lines?.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    this.overlay = new THREE.LineSegments(g, this.overlayMat);
    this.overlay.renderOrder = 2;
    this.scene.add(this.overlay);
  }

  /** 3D 점의 화면 좌표 (시험·안내용) */
  screenOf(p: [number, number, number]): [number, number] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3(...p).project(this.camera);
    return [((v.x + 1) / 2) * rect.width + rect.left, ((1 - v.y) / 2) * rect.height + rect.top];
  }

  /** 화면 좌표의 면·모서리 (모서리는 tol px 안, 가려진 것은 빼고) */
  pickAt(cx: number, cy: number, tol: number): PickHit | null {
    const m = this.meshData;
    if (!this.model || !m || !this.triFace) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObject(this.model, false);
    const faceHit = hits[0];
    const fi = faceHit?.faceIndex;
    const faceIdx = fi !== undefined && fi !== null ? this.triFace[fi] : -1;
    const wantEdge = this.pickMode === "edge" || this.pickMode === "faceEdge";
    if (wantEdge && m.edgeGroups) {
      // 화면에서 가장 가까운 모서리 (가려진 것 제외: 그 점까지 거리가 면보다 멀면 안 됨)
      const pos = m.edges;
      const camPos = this.camera.position;
      // 화면에서 잰 위치는 원근 때문에 3D 위치와 조금 어긋나므로 모델 크기의 5%까지는 보이는 것으로
      const maxDepth = faceHit ? faceHit.distance + this.radius * 0.05 : Infinity;
      const P = new THREE.Vector3();
      const Q = new THREE.Vector3();
      const W = new THREE.Vector3();
      const toScreen = (v: THREE.Vector3) => {
        const p = v.clone().project(this.camera);
        return [((p.x + 1) / 2) * rect.width + rect.left, ((1 - p.y) / 2) * rect.height + rect.top];
      };
      let best = -1;
      let bestD = tol;
      m.edgeGroups.forEach(([start, count], ei) => {
        for (let k = start; k + 1 < start + count; k += 2) {
          P.set(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
          Q.set(pos[k * 3 + 3], pos[k * 3 + 4], pos[k * 3 + 5]);
          const [ax, ay] = toScreen(P);
          const [bx, by] = toScreen(Q);
          const dx = bx - ax;
          const dy = by - ay;
          const L2 = dx * dx + dy * dy;
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / L2)) : 0;
          const d = Math.hypot(cx - (ax + t * dx), cy - (ay + t * dy));
          if (d >= bestD) continue;
          W.copy(P).lerp(Q, t);
          if (W.distanceTo(camPos) > maxDepth) continue;
          bestD = d;
          best = ei;
        }
      });
      if (best >= 0) return { kind: "edge", index: best };
      if (this.pickMode === "edge") return null;
    }
    if (faceIdx < 0) return null;
    if (this.pickMode === "plane" && this.isPlanar && !this.isPlanar(faceIdx)) return null;
    return { kind: "face", index: faceIdx };
  }

  private renderHighlights() {
    for (const c of [...this.hlGroup.children]) {
      this.hlGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const m = this.meshData;
    if (!m || !this.model) return;
    const facesGeo = (list: number[]) => {
      if (!m.faceGroups || !list.length) return null;
      const idx: number[] = [];
      for (const f of list) {
        const g = m.faceGroups[f];
        if (g) for (let k = g[0]; k < g[0] + g[1]; k++) idx.push(m.triangles[k]);
      }
      if (!idx.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", this.model!.geometry.getAttribute("position"));
      geo.setIndex(idx);
      return geo;
    };
    const edgesGeo = (list: number[]) => {
      if (!m.edgeGroups || !list.length) return null;
      const pts: number[] = [];
      for (const e of list) {
        const g = m.edgeGroups[e];
        if (g) for (let k = g[0]; k < g[0] + g[1]; k++) pts.push(m.edges[k * 3], m.edges[k * 3 + 1], m.edges[k * 3 + 2]);
      }
      if (!pts.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      return geo;
    };
    const add = (o: THREE.Object3D | null) => {
      if (!o) return;
      o.renderOrder = 3;
      this.hlGroup.add(o);
    };
    const sf = facesGeo(this.selFaces);
    if (sf) add(new THREE.Mesh(sf, this.selFaceMat));
    const se = edgesGeo(this.selEdges);
    if (se) add(new THREE.LineSegments(se, this.selEdgeMat));
    const h = this.hoverHit;
    if (h?.kind === "face") {
      const g = facesGeo([h.index]);
      if (g) add(new THREE.Mesh(g, this.hoverFaceMat));
    } else if (h?.kind === "edge") {
      const g = edgesGeo([h.index]);
      if (g) add(new THREE.LineSegments(g, this.hoverEdgeMat));
    }
  }

  setActive(a: boolean) {
    this.active = a;
    if (a) {
      this.resize();
      if (this.pendingReset) this.resetView();
    }
  }

  setDark(dark: boolean) {
    this.edgeMaterial.color.set(dark ? 0xdfe8f2 : 0x1d2a3a);
    this.material.color.set(dark ? 0x5d86b0 : 0x8fb4d9);
  }

  setMesh(m: MeshData | null) {
    this.group.clear();
    this.model = null;
    this.meshData = m;
    this.triFace = null;
    this.hoverHit = null;
    this.renderHighlights();
    if (!m) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(m.vertices, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(m.normals, 3));
    g.setIndex(m.triangles);
    this.model = new THREE.Mesh(g, this.material);
    this.group.add(this.model);
    if (m.faceGroups) {
      const tf = new Int32Array(m.triangles.length / 3).fill(-1);
      m.faceGroups.forEach(([start, count], fi) => {
        for (let k = start; k < start + count; k += 3) tf[k / 3] = fi;
      });
      this.triFace = tf;
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.Float32BufferAttribute(m.edges, 3));
    this.group.add(new THREE.LineSegments(eg, this.edgeMaterial));

    g.computeBoundingSphere();
    g.computeBoundingBox();
    const bs = g.boundingSphere!;
    const firstLoad = this.radius === 50 && this.center.lengthSq() === 0;
    const changedALot = Math.abs(bs.radius - this.radius) / this.radius > 0.5;
    this.radius = bs.radius || 1;
    this.center.copy(bs.center);

    if (this.grid) this.scene.remove(this.grid);
    // 모델 크기의 약 3배, 10mm 칸 (너무 넓으면 지평선 쪽 선이 지저분해 보임)
    const step = this.radius > 200 ? 50 : 10;
    const size = Math.max(step * 4, Math.ceil((this.radius * 3) / step) * step * 2);
    this.grid = new THREE.GridHelper(size, Math.min(200, size / step), 0x8899aa, 0xc5ced8);
    this.grid.position.x = this.center.x;
    this.grid.position.y = this.center.y;
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = g.boundingBox!.min.z - 0.01;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(this.grid);
    this.scene.getObjectByName("axes")!.scale.setScalar(this.radius * 0.6);

    if (firstLoad || changedALot) this.resetView();
  }

  resetView(dir: [number, number, number] = [1, -1.4, 0.9]) {
    // 화면이 보이지 않으면 크기를 알 수 없으니, 보일 때 다시 맞춘다
    if (!this.active) {
      this.pendingReset = true;
      return;
    }
    this.pendingReset = false;
    const d = new THREE.Vector3(...dir).normalize();
    // 세로/가로 시야각 중 좁은 쪽 기준으로 모델 전체가 들어오게
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const dist = (this.radius / Math.sin(Math.min(vHalf, hHalf))) * 1.1;
    this.camera.position.copy(this.center).addScaledVector(d, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(this.center);
    this.controls.update();
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** AI 검토용 등각 시점 PNG (base64, 접두어 없이) */
  capture(): string | null {
    return this.snapshot(960, 720)?.split(",")[1] ?? null;
  }

  /**
   * 등각 시점 그림 (data URL). 3D 화면이 숨겨져 있어도 정해진 크기로 그린다.
   * bg를 주면 그 색 바탕에 (JPEG처럼 투명이 없는 형식용)
   */
  snapshot(w: number, h: number, type = "image/png", quality?: number, bg?: string): string | null {
    if (!this.group.children.length) return null;
    const pos = this.camera.position.clone();
    const target = this.controls.target.clone();
    const wasActive = this.active;
    const aspect = this.camera.aspect;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.active = true;
    this.resetView();
    // 축 표시는 그림에 넣지 않는다
    const axes = this.scene.getObjectByName("axes");
    if (axes) axes.visible = false;
    this.renderer.render(this.scene, this.camera);
    if (axes) axes.visible = true;
    let url: string;
    if (bg) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d")!;
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.drawImage(this.renderer.domElement, 0, 0, w, h);
      url = c.toDataURL(type, quality);
    } else url = this.renderer.domElement.toDataURL(type, quality);
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.active = wasActive;
    this.resize();
    return url;
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    if (!this.active) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
