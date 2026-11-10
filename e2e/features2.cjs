// 13단계 (2): 쉘(윗면 누르기)·구멍 피처·패턴·대칭·스윕(선 도구로 경로)·로프트, 순서 바꾸기·되감기 막대, 재질·무게
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
  const vol = () => B(() => window.blueprint3d.app.lastBuild?.volume ?? 0);
  const bbox = () => B(() => window.blueprint3d.app.lastBuild?.bbox ?? null);
  const log = () => B(() => window.blueprint3d.app.featureLog.map((x) => x.state));
  const okBtn = async () => { await page.click('#props [data-feat-ok]'); await waitBuild(page); };
  const setVal = async (key, v) => { const i = await page.$(`#props input[data-key="${key}"]`); await i.fill(String(v)); await i.press('Enter'); await waitBuild(page); };
  const near = (a, b, rel = 0.01) => Math.abs(a - b) / Math.abs(b) < rel;
  const scr = (u, v) => B(([a, b]) => {
    const p = window.blueprint3d.app.board.pane(window.blueprint3d.ui.activeView);
    const r = document.querySelector('#board').getBoundingClientRect();
    const [x, y] = p.toScreen(a, b);
    return [r.left + x, r.top + y];
  }, [u, v]);
  /** 바닥판 60×40×20 */
  const box = () => B(() => window.blueprint3d.store.update((p) => {
    p.features = [
      { id: 's1', name: '스케치 1', kind: 'sketch', plane: { kind: 'base', base: 'XY', offset: 0 }, shapes: [{ id: 'r', kind: 'rect', hole: false, x: 0, y: 0, w: 60, h: 40 }] },
      { id: 'e1', name: '돌출 1', kind: 'extrude', sketch: 's1', op: 'add', extent: 'dist', dist: 20 },
    ];
    delete p.rollback;
  }, '준비'));
  try {
    await fresh(page);
    await waitBuild(page);
    await run('file.new');
    await page.waitForTimeout(300);
    await box();
    await page.keyboard.press('2');
    await waitBuild(page);
    await page.waitForTimeout(600);

    // ---- 쉘: 윗면 누르기 ----
    await page.click('[data-cmd="feat.shell"]');
    await waitBuild(page);
    const top = await B(() => window.blueprint3d.app.lastBuild.topo.faces.find((f) => f.t === 'plane' && f.n[2] > 0.99).c);
    const [tx, ty] = await B((c) => window.blueprint3d.app.viewer.screenOf(c), top);
    await page.mouse.move(tx, ty);
    await page.mouse.click(tx, ty);
    await page.waitForTimeout(300);
    ok('쉘: 3D에서 윗면을 누르면 열 면으로', (await feats()).at(-1).faces.length === 1);
    await setVal('t', 2);
    await okBtn();
    ok('쉘 두께 2 → 부피 = 60·40·20 − 56·36·18', near(await vol(), 48000 - 56 * 36 * 18, 0.003), String(await vol()));
    await page.keyboard.press('Control+z');
    await waitBuild(page);

    // ---- 구멍 피처: 윗면 스케치(원 3개) → 구멍 M4 카운터보어 ----
    await B(() => window.blueprint3d.store.update((p) => {
      p.features.push({ id: 's2', name: '스케치 2', kind: 'sketch', plane: { kind: 'base', base: 'XY', offset: 20 }, shapes: [{ id: 'c1', kind: 'circle', hole: true, cx: 10, cy: 20, r: 1 }] });
    }, '구멍 자리'));
    await page.click('[data-cmd="feat.hole"]');
    await waitBuild(page);
    await page.selectOption('#props select >> nth=3', 'counterbore');
    await waitBuild(page);
    let h = (await feats()).at(-1);
    ok('구멍 피처: 스케치·규격 M4·머리 자리', h.kind === 'hole' && h.sketch === 's2' && h.spec.size === 'M4' && h.spec.head === 'counterbore', JSON.stringify(h.spec));
    await okBtn();
    const v1 = await vol();
    // M4 보통 관통 Ø4.5 × 20 + 카운터보어 Ø8 × 4.4
    const holeVol = Math.PI * 2.25 ** 2 * 20 + Math.PI * (16 - 2.25 ** 2) * 4.4;
    ok('구멍 하나 뚫림 (Ø4.5 관통 + 카운터보어 Ø8×4.4)', near(48000 - v1, holeVol, 0.01), `${(48000 - v1).toFixed(1)} vs ${holeVol.toFixed(1)}`);

    // ---- 패턴: 구멍을 X로 3개, 간격 20 ----
    await page.click('[data-cmd="feat.pattern"]');
    await waitBuild(page);
    let pt = (await feats()).at(-1);
    ok('패턴 기본: 마지막 몸체 피처(구멍)', pt.of.length === 1 && pt.of[0] === h.id, JSON.stringify(pt.of));
    await setVal('count', 3);
    await setVal('spacing', 20);
    await okBtn();
    const v2 = await vol();
    ok('패턴 3개 → 구멍 부피 3배', near(48000 - v2, 3 * (48000 - v1), 0.01), `${(48000 - v2).toFixed(1)} vs ${(3 * (48000 - v1)).toFixed(1)}`);

    // ---- 대칭: 몸체 전체를 YZ 평면에 ----
    await page.click('[data-cmd="feat.mirror"]');
    await waitBuild(page);
    await okBtn();
    let bb = await bbox();
    ok('대칭(몸체 전체, YZ): 가로 −60~60, 부피 2배', bb && Math.abs(bb[0][0] + 60) < 1e-6 && near(await vol(), 2 * v2, 0.002), JSON.stringify(bb));

    // ---- 순서 바꾸기: 대칭을 패턴 위로 (▲) → 대칭이 구멍 패턴 전에 → 결과 같음, 스케치 위로는 못 감 ----
    let names = (await feats()).map((f) => f.name);
    const mi = names.indexOf('대칭 1');
    await page.hover(`#featTree .feat-row[data-feat] >> nth=${mi}`);
    await page.click(`#featTree .feat-row[data-feat] >> nth=${mi} >> button[title="위로"]`);
    await waitBuild(page);
    names = (await feats()).map((f) => f.name);
    ok('▲로 대칭을 패턴 위로', names.indexOf('대칭 1') === mi - 1, names.join(','));
    const vMoved = await vol();
    ok('순서가 바뀌면 결과도 (대칭 뒤 패턴 → 구멍은 한쪽에만)', vMoved > 2 * v2 + 100, `${vMoved.toFixed(0)} vs ${(2 * v2).toFixed(0)}`);
    // 구멍 피처를 스케치 2 위로 옮기려 하면 거절
    const hi = names.indexOf('구멍 1');
    await page.hover(`#featTree .feat-row[data-feat] >> nth=${hi}`);
    await page.click(`#featTree .feat-row[data-feat] >> nth=${hi} >> button[title="위로"]`);
    await page.waitForTimeout(300);
    ok('쓰는 스케치보다 위로는 못 옮김', (await feats()).map((f) => f.name).indexOf('구멍 1') === hi, await page.textContent('.toast, #toast').catch(() => ''));

    // ---- 되감기 막대: 끌어서 돌출 바로 아래로 → 판만 남음, 새 피처는 그 자리에, 끝까지 ----
    const bar = await page.$('#featTree .feat-rollback');
    const target = await page.$('#featTree .feat-row[data-feat] >> nth=1');
    const tb = await target.boundingBox();
    const bb0 = await bar.boundingBox();
    await page.mouse.move(bb0.x + 20, bb0.y + bb0.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + 30, tb.y + tb.height * 0.8, { steps: 8 });
    await page.mouse.up();
    await waitBuild(page);
    let rb = await B(() => window.blueprint3d.store.project.rollback);
    if (rb !== 2) {
      // 브라우저에 따라 끌어 놓기가 안 되면 ⤓ 단추로
      await page.hover('#featTree .feat-row[data-feat] >> nth=1');
      await page.click('#featTree .feat-row[data-feat] >> nth=1 >> button[title^="여기까지만"]');
      await waitBuild(page);
      rb = await B(() => window.blueprint3d.store.project.rollback);
    }
    ok('되감기: 돌출까지만 계산 → 판 하나', rb === 2 && near(await vol(), 48000, 1e-6) && (await log()).slice(2).every((s) => s === 'rolled'), `rollback=${rb} vol=${await vol()}`);
    ok('되감긴 피처는 흐리게', (await page.$$('#featTree .feat-row.rolled')).length >= 4);
    await page.click('#featTree .feat-rollback button');
    await waitBuild(page);
    ok('끝까지 → 원래대로', (await B(() => window.blueprint3d.store.project.rollback)) === undefined && near(await vol(), vMoved, 1e-6));

    // ---- 스윕: XZ 평면 새 스케치 → 선 도구로 경로 → 관 ----
    await box();
    await waitBuild(page);
    await page.click('[data-cmd="feat.sketch"]');
    await page.click('.plane-btn[data-plane="XZ"]');
    await page.waitForTimeout(400);
    await page.keyboard.press('Shift+L');
    for (const [u, v] of [[55, 10], [55, 35], [30, 35]]) {
      const [x, y] = await scr(u, v);
      await page.mouse.click(x, y);
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const path = (await feats()).at(-1).shapes[0];
    ok('선 도구: 열린 선 (점 3개)', path?.kind === 'poly' && path.open === true && path.pts.length === 3, JSON.stringify(path));
    await page.click('#sketchDone');
    await page.waitForTimeout(300);
    await page.click('[data-cmd="feat.sweep"]');
    await waitBuild(page);
    const inner = await page.$('#props input[data-key="pinner"]');
    await inner.fill('8');
    await inner.press('Tab');
    await waitBuild(page);
    await okBtn();
    const sw = (await feats()).at(-1);
    ok('스윕: 경로 + 관(바깥 10, 속 8)', sw.kind === 'sweep' && sw.profile.kind === 'circle' && sw.profile.d === 10 && sw.profile.inner === 8 && (await log()).at(-1) === 'ok', JSON.stringify(sw.profile));
    ok('관이 판에 붙음 (부피가 늘어남, 덩어리 하나)', (await vol()) > 48000 + 500 && (await B(() => window.blueprint3d.app.lastBuild.solidCount)) === 1, String(await vol()));
    await page.screenshot({ path: out('feat-sweep.png') });

    // ---- 로프트: 사각형(바닥) → 원(높이 30) ----
    await B(() => window.blueprint3d.store.update((p) => {
      p.features = [
        { id: 'a', name: '아래', kind: 'sketch', plane: { kind: 'base', base: 'XY', offset: 0 }, shapes: [{ id: 'r', kind: 'rect', hole: false, x: -10, y: -10, w: 20, h: 20 }] },
        { id: 'b', name: '위', kind: 'sketch', plane: { kind: 'base', base: 'XY', offset: 30 }, shapes: [{ id: 'c', kind: 'circle', hole: false, cx: 0, cy: 0, r: 5 }] },
      ];
    }, '로프트 준비'));
    await page.click('[data-cmd="feat.loft"]');
    await waitBuild(page);
    await okBtn();
    bb = await bbox();
    ok('로프트: 사각형 → 원 (높이 30)', (await log()).at(-1) === 'ok' && bb && Math.abs(bb[1][2] - 30) < 1e-6, JSON.stringify(bb));

    // ---- 재질 → 무게 ----
    await box();
    await waitBuild(page);
    await page.waitForSelector('#matSel');
    await page.selectOption('#matSel', 'al6061');
    await waitBuild(page);
    await page.waitForSelector('#massOut');
    ok('재질 알루미늄 → 무게 129.6 g, 무게 중심 (30, 20, 10)', (await page.textContent('#massOut')) === '129.6 g' && /\(30, 20, 10\)/.test(await page.textContent('#comOut')), `${await page.textContent('#massOut')} ${await page.textContent('#comOut')}`);
    await page.screenshot({ path: out('feat-material.png') });

    // ---- 피처 부품의 도면: 자동 치수 + 표제란 재질 ----
    await page.keyboard.press('3');
    await page.waitForFunction(() => document.querySelectorAll('#sheetHost svg g.dim').length > 2, null, { timeout: 60000 });
    const sheetText = await page.textContent('#sheetHost svg');
    ok('피처 부품도 도면 출력: 자동 치수 + 표제란 재질 A6061-T6', /60/.test(sheetText) && /A6061-T6/.test(sheetText), sheetText.slice(0, 80));
  } catch (e) {
    results.push('FAIL exception — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    await page.screenshot({ path: out('feat2-error.png') }).catch(() => {});
  }
  finish(results, errs);
  await browser.close();
})();
