#!/usr/bin/env node
// 브라우저 시험 한 번에: 빌드 → 미리 보기 서버 → 시험 모음을 차례로 → 요약
//   npm run e2e                 전부
//   npm run e2e -- core app     골라서
//   E2E_NO_BUILD=1 npm run e2e  빌드 건너뛰기
// 필요: Playwright (npx playwright install chromium). 다른 위치의 Chromium은 PW_CHROMIUM=경로
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SUITES = ['core', 'app', 'library', 'document', 'import3d', 'legacy', 'constraints', 'units', 'dims', 'tablet'];
const PORT = Number(process.env.E2E_PORT || 4173);
const URL = `http://localhost:${PORT}/`;

const ping = () => new Promise((res) => http.get(URL, (r) => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));

(async () => {
  const pick = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const suites = pick.length ? pick : SUITES;
  if (!process.env.E2E_NO_BUILD) {
    console.log('▶ 빌드');
    execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
  }
  let server = null;
  if (!(await ping())) {
    server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 60 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const summary = [];
  for (const s of suites) {
    const t0 = Date.now();
    console.log(`\n▶ ${s}`);
    const r = await new Promise((resolve) => {
      let outText = '';
      const p = spawn(process.execPath, [path.join(__dirname, `${s}.cjs`)], { cwd: ROOT, env: { ...process.env, E2E_URL: URL, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
      p.stdout.on('data', (d) => { outText += d; process.stdout.write(d); });
      p.stderr.on('data', (d) => { outText += d; process.stderr.write(d); });
      p.on('close', (code) => resolve({ code, outText }));
    });
    const m = /(\d+)\/(\d+) PASS/.exec(r.outText);
    summary.push({ s, ok: r.code === 0, pass: m ? m[1] : '?', total: m ? m[2] : '?', sec: ((Date.now() - t0) / 1000).toFixed(0) });
  }
  server?.kill();
  console.log('\n──── 요약 ────');
  for (const x of summary) console.log(`${x.ok ? '✓' : '✗'} ${x.s.padEnd(10)} ${x.pass}/${x.total}  (${x.sec}초)`);
  const bad = summary.filter((x) => !x.ok);
  console.log(bad.length ? `\n실패: ${bad.map((x) => x.s).join(', ')}` : '\n모두 통과');
  process.exit(bad.length ? 1 : 0);
})();
