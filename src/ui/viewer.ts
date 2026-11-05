import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MeshData } from "../core/types";

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
    const axes = new THREE.AxesHelper(1);
    axes.name = "axes";
    this.scene.add(axes);
    new ResizeObserver(() => this.resize()).observe(host);
    this.loop();
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
    if (!m) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(m.vertices, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(m.normals, 3));
    g.setIndex(m.triangles);
    this.group.add(new THREE.Mesh(g, this.material));
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
    if (!this.group.children.length) return null;
    const pos = this.camera.position.clone();
    const target = this.controls.target.clone();
    const wasActive = this.active;
    const aspect = this.camera.aspect;
    // 3D 화면이 숨겨져 있어도 찍을 수 있게 정해진 크기로 그린다
    this.renderer.setSize(960, 720, false);
    this.camera.aspect = 960 / 720;
    this.camera.updateProjectionMatrix();
    this.active = true;
    this.resetView();
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL("image/png");
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.active = wasActive;
    this.resize();
    return url.split(",")[1] ?? null;
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    if (!this.active) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
