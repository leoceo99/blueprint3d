// 13단계: 피처 기반 부품 — 새 스케치(평면 고르기) → 사각형 → 스케치 끝내기 → 돌출(값 바꾸기·확인) → 실행 취소,
// 면 위 스케치 → 빼기 돌출, 피처 끄기·이름 바꾸기·지우기, 3면도 + 피처, 저장 왕복
const { out, launch, finish, fresh, waitBuild } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  const results = [];
  const ok = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const B = (fn, arg) => page.evaluate(fn, arg);
  const run = (id) => B((i) => window.blueprint3d.commands.run(i), id);
  const feats = () => B(() => JSON.parse(JSON.stringify(window.blueprint3d.store.project.features ?? [])));
  const info = () => page.textContent('#info3d');
  const bbox = () => B(() => window.blueprint3d.app.lastBuild?.bbox ?? null);
  const rows = () => B(() => [...document.querySelectorAll('#featTree .feat-row[data-feat]')].map((r) => r.querySelector('.fname')?.textContent + (r.classList.contains('off') ? '(off)' : '') + (r.classList.contains('error') ? '(err)' : '')));
  /** 스케치 평면 좌표(mm) → 화면 */
  const scr = (u, v) => B(([a, b]) => {
    const app = window.blueprint3d.app;
    const p = app.board.pane(window.blueprint3d.ui.activeView);
    const r = document.querySelector('#board').getBoundingClientRect();
    const [x, y] = p.toScreen(a, b);
    return [r.left + x, r.top + y];
  }, [u, v]);
  try {
    await fresh(page);
    await waitBuild(page);
    await run('file.new');
    await page.waitForTimeout(400);
    await page.keyboard.press('2');
    await page.waitForTimeout(400);
    ok('3D 설계: 피처 리본·기본 평면', await page.isVisible('#ribbon3d') && (await page.$$('#featTree .feat-row.plane')).length === 3);

    // ---- 새 스케치 → 평면 고르기 ----
    await page.click('[data-cmd="feat.sketch"]');
    await page.waitForSelector('.plane-btn[data-plane="XY"]');
    await page.click('.plane-btn[data-plane="XY"]');
    await page.waitForTimeout(500);
    ok('평면 고르면 스케치 편집 (2D 설계, 스케치 띠)', await page.isVisible('#sketchBar') && (await B(() => window.blueprint3d.app.workspace)) === 'design', await page.textContent('#sketchBar'));

    // ---- 사각형: 한 번 누르고 치수 입력 ----
    await page.keyboard.press('r');
    const [x0, y0] = await scr(0, 0);
    await page.mouse.click(x0, y0);
    await page.keyboard.type('60,40');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    let f = await feats();
    const sh = f[0]?.shapes?.[0];
    ok('스케치에 사각형 60×40 (3면도에는 안 들어감)', f.length === 1 && sh?.kind === 'rect' && Math.abs(Math.abs(sh.w) - 60) < 1e-6 && Math.abs(Math.abs(sh.h) - 40) < 1e-6 && (await B(() => window.blueprint3d.store.project.views.top.length)) === 0, JSON.stringify(sh));
    await page.screenshot({ path: out('feat-sketch.png') });

    // ---- 스케치 끝내기 → 돌출 ----
    await page.click('#sketchDone');
    await page.waitForTimeout(400);
    ok('스케치 끝내기 → 3D 설계', (await B(() => window.blueprint3d.app.workspace)) === '3d');
    await page.click('[data-cmd="feat.extrude"]');
    await waitBuild(page);
    let bb = await bbox();
    ok('돌출 10 (미리 보기)', bb && Math.abs(bb[1][2] - bb[0][2] - 10) < 1e-6 && Math.abs(bb[1][0] - bb[0][0] - 60) < 1e-6, JSON.stringify(bb));
    const dist = await page.$('#props input[data-key="dist"]');
    await dist.fill('25');
    await dist.press('Enter');
    await waitBuild(page);
    bb = await bbox();
    ok('거리 25로 바꾸면 바로 다시 계산', bb && Math.abs(bb[1][2] - bb[0][2] - 25) < 1e-6, JSON.stringify(bb));
    await page.click('#props [data-feat-ok]');
    await page.waitForTimeout(300);
    ok('피처 목록: 스케치 1, 돌출 1', JSON.stringify(await rows()) === JSON.stringify(['스케치 1', '돌출 1']), JSON.stringify(await rows()));
    await page.screenshot({ path: out('feat-extrude.png') });

    // ---- 실행 취소 한 번 = 돌출(만들기+값 바꾸기)이 통째로 ----
    await page.keyboard.press('Control+z');
    await waitBuild(page);
    ok('실행 취소 한 번에 돌출 피처가 없어짐', (await feats()).length === 1);
    await page.keyboard.press('Control+Shift+z');
    await waitBuild(page);
    bb = await bbox();
    ok('다시 실행 → 25 그대로', (await feats()).length === 2 && bb && Math.abs(bb[1][2] - 25) < 1e-6);

    // ---- 식: 거리 = L ----
    await page.dblclick('#featTree .feat-row[data-feat] >> nth=1');
    await page.waitForSelector('#props input[data-key="dist"]');
    await B(() => window.blueprint3d.store.update((p) => (p.params = [{ name: 'L', expr: '12' }]), '변수'));
    await page.waitForTimeout(200);
    await page.dblclick('#featTree .feat-row[data-feat] >> nth=1');
    const d2 = await page.waitForSelector('#props input[data-key="dist"]');
    await d2.fill('L*2');
    await d2.press('Enter');
    await waitBuild(page);
    bb = await bbox();
    ok('거리 = L*2 (변수 L=12 → 24)', bb && Math.abs(bb[1][2] - 24) < 1e-6 && (await feats())[1].exprs?.dist === 'L*2', JSON.stringify(bb));
    await page.click('#props [data-feat-ok]');

    // ---- 끄기·이름 바꾸기 ----
    await page.hover('#featTree .feat-row[data-feat] >> nth=1');
    await page.click('#featTree .feat-row[data-feat] >> nth=1 >> button[title^="끄기"]');
    await waitBuild(page);
    ok('끄면 몸체 없음(오류 아님) + 목록에 취소선', !(await B(() => window.blueprint3d.app.buildError)) && /돌출/.test(await page.textContent('#buildStatus')) && (await rows())[1].includes('(off)'), await page.textContent('#buildStatus'));
    await page.hover('#featTree .feat-row[data-feat] >> nth=1');
    await page.click('#featTree .feat-row[data-feat] >> nth=1 >> button[title="켜기"]');
    await waitBuild(page);
    await page.hover('#featTree .feat-row[data-feat] >> nth=1');
    await page.click('#featTree .feat-row[data-feat] >> nth=1 >> button[title="이름 바꾸기"]');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('바닥판');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    ok('이름 바꾸기', (await feats())[1].name === '바닥판');

    // ---- 스케치 다시 고치기 (두 번 누르기) → 사각형 크기 바꾸면 3D도 ----
    await page.dblclick('#featTree .feat-row[data-feat] >> nth=0');
    await page.waitForTimeout(400);
    ok('스케치 두 번 누르기 → 스케치 편집', await page.isVisible('#sketchBar'));
    await B(() => window.blueprint3d.store.update((p) => { p.features[0].shapes[0].w = 80; }, '가로 80'));
    await page.click('#sketchDone');
    await waitBuild(page);
    bb = await bbox();
    ok('스케치를 고치면 돌출도 따라감 (가로 80)', bb && Math.abs(bb[1][0] - bb[0][0] - 80) < 1e-6, JSON.stringify(bb));

    // ---- 저장 왕복 (.b3d) ----
    const back = await B(async () => {
      const { store } = window.blueprint3d;
      return JSON.stringify(store.project.features.map((x) => x.kind));
    });
    ok('피처 목록이 문서에 저장됨', back === '["sketch","extrude"]', back);
    await page.screenshot({ path: out('feat-tree.png') });
  } catch (e) {
    results.push('FAIL exception — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    await page.screenshot({ path: out('feat-error.png') }).catch(() => {});
  }
  finish(results, errs);
  await browser.close();
})();
