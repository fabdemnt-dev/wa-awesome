import { test, expect } from '@playwright/test';
const base = 'https://fabdemnt-dev.github.io/wa-awesome/';

async function session(browser, info, game) {
  const room = `pw-${game}-${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || 1}`;
  const people = [];
  const events = [];
  for (const name of ['PW-A', 'PW-B', 'PW-C', 'PW-見学']) {
    const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 412, height: 915 }, recordVideo: { dir: info.outputPath('videos') } });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    page.on('dialog', async dialog => { events.push({ name, type: 'dialog', message: dialog.message() }); await dialog.accept(); });
    page.on('pageerror', error => events.push({ name, type: 'pageerror', message: error.message }));
    page.on('console', message => { if (message.type() === 'error') events.push({ name, type: 'console', message: message.text() }); });
    people.push({ name, page, context });
  }
  info.annotations.push({ type: 'room', description: `${game}: ${room}` });
  console.log(`TEST ROOM: ${game} ${room}`);
  return { people, room, async close() {
    for (const { name, page, context } of people) {
      await info.attach(`${name}-screen`, { body: await page.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0)), contentType: 'image/png' });
      await info.attach(`${name}-visible-text`, { body: await page.locator('body').innerText().catch(() => ''), contentType: 'text/plain' });
      const trace = info.outputPath(`${name}-trace.zip`);
      await context.tracing.stop({ path: trace });
      await info.attach(`${name}-trace`, { path: trace, contentType: 'application/zip' });
      const video = page.video();
      await context.close();
      if (video) await info.attach(`${name}-video`, { path: await video.path(), contentType: 'video/webm' });
    }
    await info.attach('events', { body: JSON.stringify(events, null, 2), contentType: 'application/json' });
  }};
}
async function join(person, game, room, spectator = false) {
  await person.page.goto(`${base}${game}.html`);
  await person.page.locator('#player-name').fill(person.name);
  await person.page.locator('#room-id').fill(room);
  if (spectator) await person.page.locator('#spectator-check').check();
  await person.page.locator('#join-btn').click();
  await expect(person.page.locator('#lobby-sec')).toBeVisible();
}
async function roster(people) {
  for (const { page } of people) {
    for (const { name } of people) await expect(page.locator('#player-list')).toContainText(name);
    await expect(page.locator('#player-list .participant-card')).toHaveCount(4);
    await expect(page.locator('#player-list .participant-card-player')).toHaveCount(3);
    await expect(page.locator('#player-list .participant-card-spectator')).toHaveCount(1);
  }
}
async function phase(people, selector) {
  for (const { page } of people) await expect(page.locator(selector)).toBeVisible();
}

test('ポエム：同時参加・素材投稿・非作成者の開始・同時投稿・リアクション・次回', async ({ browser }, info) => {
  const s = await session(browser, info, 'poem');
  const [a,b,c,viewer] = s.people;
  const players = [a,b,c];
  try {
    await test.step('Aが専用ルームを作成、B・C・見学者が同時参加', async () => {
      await join(a, 'poem', s.room);
      await Promise.all([join(b,'poem',s.room), join(c,'poem',s.room), join(viewer,'poem',s.room,true)]);
      await roster(s.people);
      await expect(viewer.page.locator('#start-game-btn')).toBeDisabled();
    });
    await test.step('3人が5素材ずつ同時投稿し、全員に15個反映', async () => {
      for (const p of players) for (let i=0;i<5;i++) await p.page.locator('#word-inputs input').nth(i).fill(`${p.name}のテスト素材${i+1}`);
      await Promise.all(players.map(p => p.page.locator('#add-word-btn').click()));
      for (const p of s.people) await expect(p.page.locator('#material-count')).toContainText('15個');
    });
    await test.step('2番目のBが開始、全員同期・各5枚・見学者の入力非表示', async () => {
      await b.page.locator('#start-game-btn').click();
      await phase(s.people, '#game-sec');
      for (const p of players) await expect(p.page.locator('#hand-list .card')).toHaveCount(5);
      await expect(viewer.page.locator('#poem-composer')).toBeHidden();
      await expect(viewer.page.locator('#next-game-btn')).toBeDisabled();
    });
    await test.step('見学切替・復帰で同じ回の下書きを保持', async () => {
      await c.page.locator('#poem-input-area').fill('PW-Cの下書き');
      await c.page.locator('#role-toggle-btn-game').click();
      await expect(c.page.locator('#poem-composer')).toBeHidden();
      await c.page.locator('#role-toggle-btn-game').click();
      await expect(c.page.locator('#poem-input-area')).toHaveValue('PW-Cの下書き');
    });
    await test.step('3人が同時投稿、全員に3作品、投稿後の再投稿を禁止', async () => {
      for (const p of players) await p.page.locator('#poem-input-area').fill(`${p.name}の多人数テスト作品`);
      await Promise.all(players.map(p => p.page.locator('#poem-submit-btn').click()));
      for (const p of s.people) {
        await expect(p.page.locator('#submission-status-game')).toContainText('3/3');
        await expect(p.page.locator('#board-list .player-board')).toHaveCount(3);
      }
      for (const p of players) await expect(p.page.locator('#poem-submit-btn')).toBeDisabled();
    });
    await test.step('披露が全員に反映、BとCの同時いいねが2件になる', async () => {
      for (const p of players) await a.page.locator('.player-board').filter({ hasText: `${p.name} の作品` }).getByRole('button', { name: '🎁 タップして作品を開く' }).click();
      for (const p of s.people) for (const author of players) await expect(p.page.locator('#board-list')).toContainText(`${author.name}の多人数テスト作品`);
      const board = p => p.page.locator('.player-board').filter({ hasText: 'PW-A の作品' });
      await Promise.all([b,c].map(p => board(p).getByRole('button', { name: 'いいねを送る', exact: true }).click()));
      for (const p of s.people) await expect(board(p).getByRole('button', { name: 'いいねを送る', exact: true })).toContainText('(2)');
    });
    await test.step('次回ロビーへ全員移動、新しい回に投稿内容が残らない', async () => {
      await a.page.locator('#next-game-btn').click();
      await phase(s.people, '#lobby-sec');
      for (const p of s.people) await expect(p.page.locator('#material-count')).toContainText('0個');
      for (const p of players) for (let i=0;i<5;i++) await p.page.locator('#word-inputs input').nth(i).fill(`次回${p.name}-${i}`);
      await Promise.all(players.map(p => p.page.locator('#add-word-btn').click()));
      await expect(a.page.locator('#material-count')).toContainText('15個');
      await b.page.locator('#start-game-btn').click();
      await phase(s.people, '#game-sec');
      for (const p of players) {
        await expect(p.page.locator('#poem-input-area')).toHaveValue('');
        await expect(p.page.locator('#poem-submit-btn')).toBeEnabled();
        await expect(p.page.locator('#board-list .player-board')).toHaveCount(0);
      }
    });
  } finally { await s.close(); }
});

test('ポエムT4・T5：保存後の同期失敗と次回へ遅れて届く投稿', async ({ browser }, info) => {
  const s = await session(browser, info, 'poem-submit');
  const [a,b] = s.people;
  const evidence = [];
  let release;
  try {
    await join(a, 'poem', s.room); await join(b, 'poem', s.room);
    const start = async () => {
      await b.page.locator('#fill-default-btn').click();
      await expect(b.page.locator('#material-count')).toContainText('10個');
      await b.page.locator('#start-game-btn').click();
      await phase([a,b], '#game-sec');
    };
    await start();
    await test.step('T4：保存は実サーバーで成功、投稿後の同期だけをテスト内で失敗させる', async () => {
      await a.page.evaluate(() => {
        window.originalResyncForTest = window.resyncPoemRoom;
        window.resyncPoemRoom = async () => ({ ok: false, error: new Error('T4 controlled sync failure') });
      });
      await a.page.locator('#poem-input-area').fill('T4 保存済みの作品');
      await a.page.locator('#poem-submit-btn').click();
      await expect(a.page.locator('#game-toast')).toContainText('投稿は保存済み');
      await expect(a.page.locator('#poem-submit-btn')).toBeDisabled();
      await expect(a.page.locator('#poem-input-area')).toHaveValue('');
      await expect(b.page.locator('#submission-status-game')).toContainText('1/2');
      await b.page.getByRole('button', { name: '🎁 タップして作品を開く' }).click();
      await expect(b.page.locator('#board-list')).toContainText('T4 保存済みの作品');
      evidence.push({ case: 'T4', injectedFailure: 'resyncPoemRoom result only', serverSavedConfirmedBy: 'B revealed exact text' });
      await info.attach('T4-saved-sync-failure', { body: await a.page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await a.page.evaluate(() => { window.resyncPoemRoom = window.originalResyncForTest; delete window.originalResyncForTest; });
    });
    await b.page.locator('#next-game-btn').click(); await phase([a,b], '#lobby-sec'); await start();
    await test.step('T5：第2幕の手札なしPOSTを保持し、第3幕開始後に同じPOSTを解放する', async () => {
      let held;
      const ready = new Promise(resolve => { held = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      await a.page.route('**/submitPoemSecure', async route => {
        const request = route.request();
        if (request.method() !== 'POST') return route.continue();
        const data = request.postDataJSON().data;
        evidence.push({ case: 'T5', event: 'held', expectedRound: data.expectedRound, text: data.text, usedHands: data.usedHands });
        held(data);
        await gate;
        await route.continue();
      });
      await a.page.locator('#poem-input-area').fill('T5 OLD 手札なし');
      await a.page.locator('#poem-submit-btn').click();
      const data = await ready;
      expect(data.expectedRound).toBe(2); expect(data.usedHands).toEqual([]);
      await b.page.locator('#next-game-btn').click(); await phase([a,b], '#lobby-sec'); await start();
      await expect.poll(() => a.page.evaluate(async () => (await import('./poem-state.js')).default.currentData.roundCount)).toBe(3);
      await a.page.locator('#poem-input-area').fill('T5 NEW 新しい下書き');
      const responsePromise = a.page.waitForResponse(r => r.url().endsWith('/submitPoemSecure') && r.request().method() === 'POST');
      release();
      const response = await responsePromise;
      expect((await response.json()).error.status).toBe('FAILED_PRECONDITION');
      evidence.push({ case: 'T5', event: 'released-response', status: response.status(), result: 'FAILED_PRECONDITION' });
      await expect(a.page.locator('#game-toast')).toContainText('現在の下書きはそのまま');
      await expect(a.page.locator('#poem-input-area')).toHaveValue('T5 NEW 新しい下書き');
      await expect(b.page.locator('#submission-status-game')).toContainText('0/2');
      await info.attach('T5-stale-rejected-draft-kept', { body: await a.page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await a.page.unroute('**/submitPoemSecure');
      await a.page.locator('#poem-submit-btn').click();
      await expect(b.page.locator('#submission-status-game')).toContainText('1/2');
      await b.page.getByRole('button', { name: '🎁 タップして作品を開く' }).click();
      await expect(b.page.locator('#board-list')).toContainText('T5 NEW 新しい下書き');
      await expect(b.page.locator('#board-list')).not.toContainText('T5 OLD');
    });
  } finally {
    release?.();
    await info.attach('T4-T5-safe-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    await s.close();
  }
});

test('俳句：同時参加・手札配布・同時提出・披露同期・次節の親交代', async ({ browser }, info) => {
  const s = await session(browser, info, 'haiku');
  const [a,b,c,viewer] = s.people;
  const players = [a,b,c];
  try {
    await test.step('Aが専用ルームを作成、B・C・見学者が同時参加', async () => {
      await join(a,'haiku',s.room);
      await Promise.all([join(b,'haiku',s.room),join(c,'haiku',s.room),join(viewer,'haiku',s.room,true)]);
      await roster(s.people);
      await expect(viewer.page.locator('#start-game-btn')).toBeHidden();
      await expect(b.page.locator('#start-game-btn')).toBeDisabled();
    });
    await test.step('親が素材補充・開始、全員同期と各人の手札を確認', async () => {
      await a.page.locator('#fill-default-btn').click();
      await expect(a.page.locator('#total-words-5')).toHaveText('30');
      await expect(a.page.locator('#total-words-7')).toHaveText('18');
      await a.page.locator('#start-game-btn').click();
      await phase(s.people,'#game-sec');
      for (const p of players) {
        await expect(p.page.locator('#hand-5-list .card')).toHaveCount(5);
        await expect(p.page.locator('#hand-7-list .card')).toHaveCount(3);
      }
      await expect(viewer.page.locator('#hand-5-list .card')).toHaveCount(0);
    });
    await test.step('3人が句を同時提出、全員3/3・再投稿禁止', async () => {
      for (const p of players) {
        await p.page.locator('#hand-5-list .card').nth(0).click();
        await p.page.locator('#hand-7-list .card').nth(0).click();
        await p.page.locator('#hand-5-list .card').nth(1).click();
      }
      await Promise.all(players.map(p => p.page.locator('#submit-phrase-btn').click()));
      for (const p of s.people) await expect(p.page.locator('#submission-status-game')).toContainText('3/3');
      for (const p of players) await expect(p.page.locator('#submit-phrase-btn')).toBeDisabled();
    });
    await test.step('親が3句を披露、全員が御印受付中になる', async () => {
      for (const p of players) await a.page.getByRole('button', { name: `📜 ${p.name}の句を披露する`, exact:true }).click();
      for (const p of s.people) await expect(p.page.locator('#phase-status-game')).toContainText('御印受付中');
    });
    await test.step('次節へ移動、親交代を全員で確認', async () => {
      await a.page.locator('#next-round-btn').click();
      await phase(s.people,'#lobby-sec');
      // B/Cの同時参加順は非決定的。次の親がA以外で全員一致することを確認。
      const nextHost = await a.page.locator('#host-info-lobby strong').innerText();
      expect(['PW-B','PW-C']).toContain(nextHost);
      for (const p of s.people) await expect(p.page.locator('#host-info-lobby strong')).toHaveText(nextHost);
    });
  } finally { await s.close(); }
});
