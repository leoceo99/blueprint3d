// 10단계: 구속 — 도구로 만들기, 값 고치기, 자유도, 다 정해짐, 중복 거절, 충돌 되돌림, 끌기, 변수 식, 지우기, 실행 취소, 저장
const { URL, out, launch, finish, fresh, waitBuild } = require('./lib.cjs');
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
  const shape = (id) => B((i) => JSON.parse(JSON.stringify(window.blueprint3d.store.project.views.top.find((s) => s.id === i))), id);
  const cons = () => B(() => (window.blueprint3d.store.project.constraints?.top ?? []).map((c) => ({ kind: c.kind, value: c.value, expr: c.expr, id: c.id })));
  const scr = (u, v) => B(([u, v]) => { const [x, y] = window.blueprint3d.board.panes.top.toScreen(u, v); const r = document.querySelector('#board').getBoundingClientRect(); return [r.x + x, r.y + y]; }, [u, v]);
  const click = async (u, v) => { const [x, y] = await scr(u, v); await page.mouse.click(x, y); await page.waitForTimeout(120); };
  const editor = '.dyn-input:visible';
  const type = async (text) => { await page.fill(editor, text); await page.press(editor, 'Enter'); await page.waitForTimeout(250); };
  const badge = async () => { await page.waitForTimeout(120); return page.textContent('#dofBadge'); };
  const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;
  try {
    await fresh(page);
    await waitBuild(page);
    await page.keyboard.press('Control+Alt+n'); await waitBuild(page);
    await B(() => window.blueprint3d.store.update((p) => {
      p.views.top = [
        { id: 'plate', kind: 'rect', hole: false, x: 0, y: 0, w: 80, h: 40, exprs: { x: '0', y: '0', w: '80', h: '40' } },
        { id: 'h', kind: 'circle', hole: true, cx: 25, cy: 18, r: 4 },
        { id: 'h2', kind: 'circle', hole: true, cx: 60, cy: 25, r: 5 },
      ];
    }, '준비'));
    await page.click('[data-focus="top"]'); await page.waitForTimeout(300);
    ok('자유도: 구멍 두 개(위치·지름) = 6', (await badge()) === '자유도 6', await badge());

    // ---- 가로·세로 거리 치수 (리본 → 대상 두 개 → 값 넣기) ----
    await page.click('[data-cmd="cons.distanceX"]');
    await click(0, 0); await click(25, 18);
    ok('치수 구속을 만들면 값 칸이 열림 (지금 값)', (await page.inputValue(editor)) === '25');
    await type('15');
    await page.click('[data-cmd="cons.distanceY"]');
    await click(0, 0); await click(15, 18);
    await type('20');
    let h = await shape('h');
    ok('구멍이 왼쪽 아래에서 15 · 20 으로', near(h.cx, 15) && near(h.cy, 20), `${h.cx}, ${h.cy}`);
    ok('자유도 줄어듦', (await badge()) === '자유도 4', await badge());
    await page.screenshot({ path: out('cons-dims.png') });

    // ---- 판을 넓혀도 구멍은 왼쪽 기준 그대로 ----
    await B(() => window.blueprint3d.store.update((p) => { p.views.top[0].exprs.w = '120'; }, '판 넓히기'));
    h = await shape('h');
    ok('판 가로 120 → 구멍 그대로', near(h.cx, 15) && (await shape('plate')).w === 120);
    await page.click('[data-focus="top"]'); await page.waitForTimeout(300);

    // ---- 중복 구속은 만들지 않음 ----
    await page.keyboard.press('Escape');
    await page.click('[data-cmd="cons.distanceX"]');
    await click(120, 0); await click(15, 20);
    ok('이미 정해진 것에 치수 → 중복이라 거절', /중복 구속/.test(await page.textContent('#toast')) && (await cons()).length === 2, await page.textContent('#toast'));
    await page.keyboard.press('Escape');

    // ---- 같게(지름) → 둘이 같아짐, 잠근 지름끼리 다르면 되돌림 ----
    await page.click('[data-cmd="cons.equal"]');
    await click(15 + 4, 20); // 원 h 둘레
    await click(60 + 5, 25); // 원 h2 둘레
    let r1 = (await shape('h')).r;
    let r2 = (await shape('h2')).r;
    ok('같게: 두 구멍 지름이 같아짐 (가운데 값으로)', near(r1, r2) && near(r1, 4.5), `${r1} ${r2}`);
    await page.keyboard.press('Escape');
    await B(() => window.blueprint3d.store.update((p) => { p.views.top[1].exprs = { d: '8' }; }, '지름 잠금'));
    r2 = (await shape('h2')).r;
    ok('한쪽 지름을 잠그면 다른 쪽이 따라감', near(r2, 4), String(r2));
    const ok2 = await B(() => window.blueprint3d.store.update((p) => { p.views.top[2].exprs = { d: '10' }; }, '다른 지름 잠금'));
    ok('부딪치는 편집은 되돌리고 알림', ok2 === false && near((await shape('h2')).r, 4) && /맞지 않아 되돌렸어요/.test(await page.textContent('#toast')), await page.textContent('#toast'));

    // ---- 다 정해짐: 구멍 h는 위치(치수 2) + 지름(잠금) ----
    await B(() => window.blueprint3d.store.update((p) => { p.views.top[2].exprs = { cx: '60', cy: '25' }; }, 'h2 위치 잠금'));
    ok('모두 정해지면 ✓', (await badge()) === '✓ 다 정해짐', await badge());

    // ---- 다 정해진 구멍은 끌어도 안 움직임 ----
    await page.click('[data-tool="select"]');
    const [hx, hy] = await scr(15, 20 - 3.5);
    await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(hx + 60, hy + 30, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(200);
    h = await shape('h');
    ok('다 정해진 구멍은 끌어도 그대로', near(h.cx, 15) && near(h.cy, 20), `${h.cx}, ${h.cy}`);

    // ---- 변수 식으로 치수 구속 ----
    await B(() => window.blueprint3d.store.update((p) => { p.params = [{ name: 'L', expr: '60' }]; }, '변수'));
    const dx = (await cons()).find((c) => c.kind === 'distanceX');
    await B((id) => {
      const k = window.blueprint3d.store.project.constraints.top.find((c) => c.id === id);
      window.blueprint3d.store.update((p) => { p.constraints.top.find((c) => c.id === id).expr = 'L/4'; }, '식');
      return k;
    }, dx.id);
    ok('치수 구속 = L/4 → 15', near((await shape('h')).cx, 15));
    await B(() => window.blueprint3d.store.update((p) => { p.params[0].expr = '100'; }, 'L 바꾸기'));
    ok('L = 100 → 구멍이 25로', near((await shape('h')).cx, 25), String((await shape('h')).cx));

    // ---- 기호 눌러 고르기 → 속성 패널 → Delete ----
    await page.click('[data-focus="top"]'); await page.waitForTimeout(300);
    const hit = await B(() => window.blueprint3d.board.panes.top.cons.hits.find((x) => x.dim));
    const rect = await B(() => { const r = document.querySelector('#board').getBoundingClientRect(); return [r.x, r.y]; });
    await page.mouse.click(rect[0] + (hit.box[0] + hit.box[2]) / 2, rect[1] + (hit.box[1] + hit.box[3]) / 2);
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    const panel = await page.textContent('#props');
    ok('치수 구속을 누르면 속성 패널에 구속', /구속: (가로|세로) 거리/.test(panel), panel.slice(0, 40));
    const n0 = (await cons()).length;
    await page.click('#board', { position: { x: 5, y: 5 } }).catch(() => {});
    await page.mouse.click(rect[0] + (hit.box[0] + hit.box[2]) / 2, rect[1] + (hit.box[1] + hit.box[3]) / 2);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    ok('Delete로 구속 지우기', (await cons()).length === n0 - 1, `${n0} → ${(await cons()).length}`);
    await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
    ok('Ctrl+Z로 되살리기', (await cons()).length === n0);
    const labels = await B(() => window.blueprint3d.store.history.entries.map((e) => e.label));
    ok('실행 취소 기록에 구속 이름', labels.includes('구속: 가로 거리') && labels.includes('구속: 같게'), labels.slice(0, 6).join(','));

    // ---- 다각형 변: 수평 구속 (명령 찾기에서 “수평”) ----
    await B(() => window.blueprint3d.store.update((p) => { p.views.front = [{ id: 'tri', kind: 'poly', hole: false, pts: [[0, 0], [40, 6], [10, 30]] }]; }, '삼각형'));
    await page.click('[data-focus="front"]'); await page.waitForTimeout(300);
    await page.keyboard.press('Control+k'); await page.fill('.pal-input', 'ㅅㅍ'); await page.waitForTimeout(150);
    const first = await page.$eval('.pal-row .pal-title', (e) => e.textContent);
    await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    const fs = (u, v) => B(([u, v]) => { const [x, y] = window.blueprint3d.board.panes.front.toScreen(u, v); const r = document.querySelector('#board').getBoundingClientRect(); return [r.x + x, r.y + y]; }, [u, v]);
    const [ex, ey] = await fs(20, 3);
    await page.mouse.click(ex, ey); await page.waitForTimeout(200);
    const tri = await B(() => window.blueprint3d.store.project.views.front[0].pts);
    ok('명령 찾기 “ㅅㅍ” → 수평 구속, 다각형 아랫변이 수평', first === '구속: 수평' && near(tri[0][1], tri[1][1]), `${first} ${JSON.stringify(tri)}`);
    await page.keyboard.press('Escape');

    // ---- 저장 → 새로 고침 뒤에도 구속 그대로, 검사 이상 없음 ----
    await page.waitForTimeout(1200);
    const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
    const before = canon(await B(() => window.blueprint3d.store.project.constraints));
    await page.reload(); await waitBuild(page);
    const after = canon(await B(() => window.blueprint3d.store.project.constraints));
    ok('새로 고침 뒤 구속 그대로', before === after && after.length > 50, before === after ? '' : before.slice(0, 300) + ' ≠ ' + after.slice(0, 300));
    const findings = await B(() => [...document.querySelectorAll('#findings .finding')].map((f) => f.textContent).filter((t) => /구속/.test(t)));
    ok('구속 관련 검사 경고 없음', findings.length === 0, findings.join(' | '));
    await page.click('[data-focus="top"]'); await page.waitForTimeout(300);
    await page.screenshot({ path: out('cons-board.png') });
  } catch (e) {
    results.push('FAIL (stopped) ' + String(e).split('\n')[0]);
  }
  finish(results, errs);
  await browser.close();
})();
