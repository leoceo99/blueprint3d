import { defineConfig, type Plugin } from "vite";

/**
 * 오프라인용 서비스 워커(sw.js)를 빌드할 때 만든다.
 * 빌드 결과 파일 목록(이름에 내용 해시가 들어 있음)을 그대로 넣어서, 설치할 때 전부 미리 받아 둔다.
 */
function serviceWorker(): Plugin {
  return {
    name: "blueprint3d-sw",
    apply: "build",
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map") && f !== "sw.js");
      const extra = ["manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/icon.svg"];
      const list = [...new Set(["index.html", ...extra, ...files])];
      let h = 0;
      for (const ch of list.join("|")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const version = h.toString(36);
      this.emitFile({ type: "asset", fileName: "sw.js", source: swSource(version, list) });
    },
  };
}

function swSource(version: string, files: string[]): string {
  return `/* 도면3D 서비스 워커 — 빌드할 때 자동으로 만들어짐 */
const CACHE = "b3d-${version}";
const FILES = ${JSON.stringify(files)};
const at = (f) => new URL(f, self.registration.scope).href;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(FILES.map(async (f) => {
      try {
        const r = await fetch(at(f), { cache: "reload" });
        if (r.ok) await c.put(at(f), r);
      } catch (err) { /* 하나 실패해도 나머지는 저장 */ }
    }));
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("b3d-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // AI API 같은 바깥 요청은 그대로
  if (req.mode === "navigate") {
    // 페이지: 인터넷이 되면 새로 받고, 안 되면 저장해 둔 것
    e.respondWith(fetch(req).catch(async () => (await caches.match(at("index.html"), { ignoreVary: true })) || Response.error()));
    return;
  }
  e.respondWith((async () => {
    // ignoreVary: 서버가 "Vary: Origin"을 붙이면 crossorigin 스크립트 요청과 맞지 않게 되므로
    const hit = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
    if (hit) return hit;
    return fetch(req);
  })());
});
`;
}

export default defineConfig({
  base: "./",
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  plugins: [serviceWorker()],
  test: { environment: "node", testTimeout: 60000, include: ["tests/**/*.test.ts"] },
} as any);
