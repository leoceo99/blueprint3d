// 브라우저 시험 공통: 주소, 결과·임시 폴더, 브라우저 띄우기, 결과 요약
const path = require('path');
const os = require('os');
const fs = require('fs');

const URL = process.env.E2E_URL || 'http://localhost:4173/';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b3d-e2e-'));

/** 화면 사진 저장 위치 (e2e/out, 저장소에는 안 올라감) */
const out = (name) => path.join(OUT, name);
/** 시험 중 만드는 파일 */
const tmp = (name) => path.join(TMP, name);

function launch() {
  const { chromium } = require('playwright');
  return chromium.launch({
    args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'],
    ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
  });
}

/** 결과 출력 + 실패가 있으면 종료 코드 1 */
function finish(results, errs) {
  console.log(results.join('\n'));
  const pass = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`\n${pass}/${results.length} PASS`);
  console.log('errors:', errs && errs.length ? errs.slice(0, 10).join('\n') : 'none');
  if (pass !== results.length || !results.length || (errs && errs.length)) process.exitCode = 1;
}

/** zip(.b3d, 백업) 풀기 */
function unzip(buf) {
  const { unzipSync, strFromU8 } = require('fflate');
  const z = unzipSync(new Uint8Array(buf));
  return { files: z, json: (name) => (z[name] ? JSON.parse(strFromU8(z[name])) : null) };
}

/** 저장소 지우고 새로 시작 */
async function fresh(page) {
  await page.goto(URL);
  await page.waitForTimeout(1500);
  await page.evaluate(() => new Promise((r) => { localStorage.clear(); const q = indexedDB.deleteDatabase('blueprint3d'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
}

const waitBuild = async (page) => {
  await page.waitForTimeout(500);
  await page.waitForFunction(() => /✓|⚠|만들어져요/.test(document.querySelector('#buildStatus')?.textContent || ''), null, { timeout: 120000 });
  await page.waitForTimeout(300);
};

module.exports = { URL, out, tmp, launch, finish, unzip, fresh, waitBuild, ROOT: path.join(__dirname, '..') };
