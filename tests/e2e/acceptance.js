/*
 * Acceptance tests A–I from the UX spec, run in a real Chromium.
 *   npm i -D playwright && npx playwright install chromium
 *   BASE=http://localhost:3000 node tests/e2e/acceptance.js
 * Expects a fresh DB with the fixtures from tests/e2e/fixtures.js.
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || '';
const results = [];
let pageErrors = [];

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function login(page, email, password) {
  await page.goto(BASE + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
}

const col = (page, name) => page.locator('.column', { has: page.locator(`h2.col-name:text-is("${name}")`) });
const card = (page, title) => page.locator('.column-body > .task-card', { has: page.locator(`.tc-title:text-is("${title}")`) });

async function titlesIn(page, name) {
  return col(page, name).locator('.column-body > .task-card .tc-title').allTextContents();
}
async function columnOf(page, title) {
  return page.evaluate(t => {
    const c = [...document.querySelectorAll('.column-body > .task-card')].find(el => el.querySelector('.tc-title').textContent.trim() === t);
    return c ? c.closest('.column').querySelector('.col-name').textContent.trim() : null;
  }, title);
}

async function dragTo(page, title, target) {
  const src = await card(page, title).boundingBox();
  assert(src, `card ${title} not found`);
  const sx = src.x + src.width / 2 + 30;
  const sy = src.y + 12;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sx + (target.x - sx) * i / steps, sy + (target.y - sy) * i / steps);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(350);
}
async function point(locator, where = 'center') {
  const b = await locator.boundingBox();
  if (where === 'top') return { x: b.x + b.width / 2, y: b.y + 4 };
  if (where === 'bottom') return { x: b.x + b.width / 2, y: b.y + b.height - 3 };
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function quickAdd(page, colName, title) {
  const c = col(page, colName);
  const form = c.locator('.column-footer .quick-add-form');
  if (await form.isHidden()) await c.locator('[data-add-task]').click();
  await form.locator('input').fill(title);
  await form.locator('input').press('Enter');
  await card(page, title).waitFor();
}

async function test(name, fn) {
  pageErrors = [];
  try {
    await fn();
    assert(!pageErrors.length, 'page errors: ' + pageErrors.join(' | '));
    results.push([name, 'PASS']);
    console.log('PASS', name);
  } catch (e) {
    results.push([name, 'FAIL: ' + e.message]);
    console.log('FAIL', name, '—', e.message);
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const ctx = await browser.newContext({ viewport: { width: 2560, height: 1000 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) pageErrors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await login(page, 'admin@team.local', 'admin123');
  const board = async () => { await page.goto(BASE + '/spaces/2'); await page.locator('#board').waitFor(); };

  await test('A — move between columns persists (TODO → IN_PROGRESS → REVIEW)', async () => {
    await board();
    await quickAdd(page, 'К выполнению', 'Задача A');
    await page.evaluate(() => { window.__noReload = 1; });
    await dragTo(page, 'Задача A', await point(col(page, 'В работе').locator('.column-body'), 'center'));
    assert(await columnOf(page, 'Задача A') === 'В работе', 'not moved visually');
    assert(await page.evaluate(() => window.__noReload === 1), 'page reloaded during DnD');
    await page.reload();
    assert(await columnOf(page, 'Задача A') === 'В работе', 'after refresh: ' + await columnOf(page, 'Задача A'));
    await dragTo(page, 'Задача A', await point(col(page, 'На проверке').locator('.column-body'), 'center'));
    await page.reload();
    assert(await columnOf(page, 'Задача A') === 'На проверке', 'after refresh #2: ' + await columnOf(page, 'Задача A'));
  });

  await test('B — drop into a new empty column (CHANGES)', async () => {
    await board();
    await page.click('#addSectionBtn');
    await page.fill('#addSectionForm input', 'CHANGES');
    await page.press('#addSectionForm input', 'Enter');
    await col(page, 'CHANGES').waitFor();
    await page.press('#addSectionForm input', 'Escape');
    assert((await titlesIn(page, 'CHANGES')).length === 0, 'CHANGES not empty');
    await dragTo(page, 'Задача A', await point(col(page, 'CHANGES'), 'center'));
    assert(await columnOf(page, 'Задача A') === 'CHANGES', 'not moved into empty column');
    await page.reload();
    assert(await columnOf(page, 'Задача A') === 'CHANGES', 'after refresh: ' + await columnOf(page, 'Задача A'));
  });

  await test('C — reorder inside a column persists (with a hidden completed task in it)', async () => {
    await board();
    await quickAdd(page, 'Backlog', 'Скрытая X');
    await card(page, 'Скрытая X').locator('[data-toggle-done]').click();
    await page.waitForTimeout(900);
    for (const t of ['A', 'B', 'C']) await quickAdd(page, 'Backlog', t);
    await page.reload();
    let order = await titlesIn(page, 'Backlog');
    assert(order.join(',') === 'A,B,C', 'initial order ' + order);
    await dragTo(page, 'C', await point(card(page, 'A'), 'top'));
    order = await titlesIn(page, 'Backlog');
    assert(order.join(',') === 'C,A,B', 'visual order ' + order);
    await page.reload();
    order = await titlesIn(page, 'Backlog');
    assert(order.join(',') === 'C,A,B', 'after refresh ' + order);
  });

  await test('C2 — drop on header / "+ Добавить" button / gap between columns is saved as shown', async () => {
    await board();
    await dragTo(page, 'B', await point(col(page, 'Правки').locator('.column-header')));
    assert(await columnOf(page, 'B') === 'Правки', 'header drop');
    await dragTo(page, 'B', await point(col(page, 'В работе').locator('.add-task-btn')));
    assert(await columnOf(page, 'B') === 'В работе', 'add-button drop');
    const t = (await titlesIn(page, 'В работе'));
    assert(t[t.length - 1] === 'B', 'should be last: ' + t);
    const a = await col(page, 'Готово').boundingBox();
    await dragTo(page, 'B', { x: a.x - 5, y: a.y + 200 });
    const visual = await columnOf(page, 'B');
    await page.reload();
    assert(await columnOf(page, 'B') === visual, `gap drop: visual ${visual} vs saved ${await columnOf(page, 'B')}`);
  });

  await test('Click vs drag: card click opens drawer, checkbox does not', async () => {
    await board();
    await card(page, 'DANMAX — ролик').locator('.tc-project').click();
    await page.locator('#drawer.open').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    assert(!(await page.locator('#drawer.open').count()), 'Esc did not close drawer');
    await card(page, 'C').locator('[data-toggle-done]').click();
    await page.waitForTimeout(150);
    assert(!(await page.locator('#drawer.open').count()), 'checkbox opened drawer');
    await page.waitForTimeout(800);
    assert(!(await card(page, 'C').count()), 'completed task still on active board');
    await page.goto(BASE + '/spaces/2?completed=1');
    assert(await card(page, 'C').count() === 1, 'completed task not in Completed filter');
  });

  if (SHOTS) {
    await board();
    await page.screenshot({ path: SHOTS + '/board.png' });
  }

  await test('D — complete subtask on board card', async () => {
    await board();
    const c = card(page, 'DANMAX — ролик');
    assert((await c.locator('.tc-sub-title').allTextContents()).join('|') === 'Сделать монтаж|Добавить саунд|Сделать обложку', 'initial subs');
    assert((await c.locator('[data-progress-text]').textContent()).trim() === '✓ 0/3', 'initial progress');
    await c.locator('.tc-sub', { hasText: 'Добавить саунд' }).locator('[data-card-subtask-done]').click();
    await page.waitForTimeout(150);
    assert(!(await page.locator('#drawer.open').count()), 'subtask checkbox opened drawer');
    await page.waitForTimeout(700);
    assert((await c.locator('.tc-sub-title').allTextContents()).join('|') === 'Сделать монтаж|Сделать обложку', 'B still visible');
    assert((await c.locator('[data-progress-text]').textContent()).trim() === '✓ 1/3', 'progress not 1/3');
    await c.locator('.tc-title').click();
    await page.locator('#drawer.open #completedSubtasks').waitFor();
    const doneTitles = await page.locator('#subtaskDoneList .st-title').evaluateAll(els => els.map(e => e.value));
    assert(doneTitles.join('|') === 'Добавить саунд', 'completed section: ' + doneTitles);
    const activeTitles = await page.locator('#subtaskList .st-title').evaluateAll(els => els.map(e => e.value));
    assert(activeTitles.join('|') === 'Сделать монтаж|Сделать обложку', 'drawer active: ' + activeTitles);
    if (SHOTS) {
      await page.locator('#completedSubtasks summary').click();
      await page.screenshot({ path: SHOTS + '/drawer.png' });
    }
  });

  await test('E — complete subtask from drawer', async () => {
    await page.locator('#subtaskList .st-row', { has: page.locator('input[value="Сделать обложку"]') }).locator('[data-toggle-subtask]').click();
    await page.waitForTimeout(700);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const c = card(page, 'DANMAX — ролик');
    assert((await c.locator('.tc-sub-title').allTextContents()).join('|') === 'Сделать монтаж', 'board subs: ' + await c.locator('.tc-sub-title').allTextContents());
    assert((await c.locator('[data-progress-text]').textContent()).trim() === '✓ 2/3', 'progress not 2/3');
    await page.reload();
    assert((await card(page, 'DANMAX — ролик').locator('[data-progress-text]').textContent()).trim() === '✓ 2/3', 'progress after refresh');
  });

  await test('F — complete all subtasks', async () => {
    const c = card(page, 'DANMAX — ролик');
    await c.locator('[data-card-subtask-done]').first().click();
    await page.waitForTimeout(800);
    assert(await c.locator('.tc-sub').count() === 0, 'active subtasks still shown');
    assert((await c.locator('[data-progress-text]').textContent()).trim() === '✓ 3/3', 'progress not 3/3');
    await c.locator('.tc-title').click();
    await page.locator('#drawer.open').waitFor();
    const done = await page.locator('#subtaskDoneList .st-title').evaluateAll(els => els.map(e => e.value).sort());
    assert(done.join('|') === 'Добавить саунд|Сделать монтаж|Сделать обложку', 'drawer completed: ' + done);
    await page.keyboard.press('Escape');
  });

  await test('Drawer — add subtasks inline (Enter keeps input ready)', async () => {
    await board();
    await card(page, 'Обложка для трека').locator('.tc-title').click();
    await page.locator('#drawer.open').waitFor();
    await page.click('#addSubtaskBtn');
    await page.fill('#subtaskForm input[name=title]', 'Первая');
    await page.press('#subtaskForm input[name=title]', 'Enter');
    await page.locator('#subtaskList input[value="Первая"]').waitFor();
    assert(await page.evaluate(() => document.activeElement.name === 'title'), 'input lost focus');
    await page.keyboard.type('Вторая');
    await page.keyboard.press('Enter');
    await page.locator('#subtaskList input[value="Вторая"]').waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const subs = await card(page, 'Обложка для трека').locator('.tc-sub-title').allTextContents();
    assert(subs.join('|') === 'Первая|Вторая', 'card subs: ' + subs);
  });

  await test('H — due date + time persists and shows in calendar', async () => {
    await board();
    await quickAdd(page, 'К выполнению', 'Задача H');
    await card(page, 'Задача H').locator('.tc-title').click();
    await page.locator('#drawer.open').waitFor();
    await page.click('[data-dt-picker="task"] > summary');
    await page.fill('[data-dt-date]', '2026-09-26');
    await page.waitForTimeout(200);
    await page.fill('[data-dt-time]', '18:30');
    await page.waitForTimeout(400);
    assert(await page.locator('#drawer.open').count() === 1, 'drawer closed after field change');
    await page.reload();
    await page.locator('#drawer.open').waitFor();
    const label = (await page.locator('[data-dt-label]').textContent()).trim();
    assert(label === '26 сентября 2026, 18:30', 'label: ' + label);
    await page.goto(BASE + '/spaces/2?view=calendar&month=2026-09');
    const cell = page.locator('.cal-day[data-date="2026-09-26"] .cal-task', { hasText: 'Задача H' });
    assert(await cell.count() === 1, 'not in calendar cell');
    assert((await cell.locator('.cal-time').textContent()) === '18:30', 'calendar time');
    if (SHOTS) await page.screenshot({ path: SHOTS + '/calendar.png' });
  });

  await test('I — Sales client: completed child task hidden on card, kept in history', async () => {
    await page.goto(BASE + '/spaces/1');
    const c = card(page, 'Fish Shop');
    await c.locator('.tc-sub', { hasText: 'Send offer' }).locator('[data-card-subtask-done]').click();
    await page.waitForTimeout(800);
    assert((await c.locator('.tc-sub-title').allTextContents()).join('|') === 'Follow-up', 'card: ' + await c.locator('.tc-sub-title').allTextContents());
    await page.reload();
    assert((await card(page, 'Fish Shop').locator('.tc-sub-title').allTextContents()).join('|') === 'Follow-up', 'after refresh');
    await card(page, 'Fish Shop').locator('.tc-title').click();
    await page.locator('#drawer.open').waitFor();
    const done = await page.locator('#subtaskDoneList .st-title').evaluateAll(els => els.map(e => e.value));
    assert(done.join('|') === 'Send offer', 'drawer completed: ' + done);
    if (SHOTS) await page.screenshot({ path: SHOTS + '/sales.png' });
    await page.goto(BASE + '/clients/1');
    assert(await page.locator('.client-actions li.is-done', { hasText: 'Send offer' }).count() === 1, 'client page history');
  });

  await test('G — subtask assigned to user shows on their Home and completes parent\'s subtask', async () => {
    const p2 = await ctx.browser().newPage({ viewport: { width: 1400, height: 900 } });
    p2.on('pageerror', e => pageErrors.push(e.message));
    await login(p2, 'nikita@team.local', 'pass123');
    // "Добавить саунд" was reopened? It was completed in D — create a fresh one assigned to Nikita.
    await page.goto(BASE + '/spaces/2');
    await card(page, 'Обложка для трека').locator('.tc-title').click();
    await page.locator('#drawer.open').waitFor();
    await page.click('#addSubtaskBtn');
    await page.fill('#subtaskForm input[name=title]', 'Экспорт для Никиты');
    await page.selectOption('#subtaskForm select[name=assignee_id]', { label: 'Никита Иванов' });
    await page.press('#subtaskForm input[name=title]', 'Enter');
    await page.locator('#subtaskList input[value="Экспорт для Никиты"]').waitFor();
    await p2.goto(BASE + '/');
    const row = p2.locator('.home-row', { hasText: 'Экспорт для Никиты' });
    assert(await row.count() === 1, 'not on Nikita home');
    if (SHOTS) await p2.screenshot({ path: SHOTS + '/home.png' });
    await row.locator('[data-home-toggle]').click();
    await p2.waitForTimeout(800);
    assert(await row.count() === 0, 'row still in active list');
    await p2.reload();
    assert(await p2.locator('.home-row', { hasText: 'Экспорт для Никиты' }).count() === 0, 'reappeared after refresh');
    await page.reload();
    await page.locator('#drawer.open').waitFor();
    const done = await page.locator('#subtaskDoneList .st-title').evaluateAll(els => els.map(e => e.value));
    assert(done.includes('Экспорт для Никиты'), 'not completed in parent: ' + done);
    await p2.close();
  });


  await test('J — quick due + assignee on a card (without opening it)', async () => {
    await board();
    const c = card(page, 'Сделать ролик Shadow Guard');
    await c.locator('.tc-footer [data-qp="due"]').click();
    await page.locator('.qp-pop:not([hidden]) [data-q="1"]').click();
    await page.locator('.qp-pop:not([hidden]) [data-done]').click();
    await page.waitForTimeout(500);
    assert(!(await page.locator('#drawer.open').count()), 'picker opened drawer');
    assert((await card(page, 'Сделать ролик Shadow Guard').locator('.tc-footer [data-qp="due"]').textContent()).trim() === 'Завтра', 'due label');
    await card(page, 'Сделать ролик Shadow Guard').locator('.tc-footer [data-qp="assignee"]').click();
    await page.locator('.qp-pop:not([hidden]) .qp-user', { hasText: 'Никита Иванов' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.reload();
    const c2 = card(page, 'Сделать ролик Shadow Guard');
    assert((await c2.locator('.tc-footer [data-qp="due"]').textContent()).trim() === 'Завтра', 'due after refresh');
    assert((await c2.locator('.tc-footer [data-qp="assignee"]').getAttribute('data-assignees')) !== '', 'assignee after refresh');
  });

  await test('J2 — quick assignee on a subtask row of a card', async () => {
    await board();
    const row = card(page, 'Обложка для трека').locator('.tc-sub', { hasText: 'Вторая' });
    await row.hover();
    await row.locator('[data-qp="assignee"]').click();
    await page.locator('.qp-pop:not([hidden]) .qp-user', { hasText: 'Admin' }).click();
    await page.waitForTimeout(500);
    const row2 = card(page, 'Обложка для трека').locator('.tc-sub', { hasText: 'Вторая' });
    assert(await row2.locator('[data-qp="assignee"].is-set').count() === 1, 'subtask assignee not shown');
  });

  await test('K — drag a subtask into another column → new card with just that subtask', async () => {
    await board();
    const row = card(page, 'Обложка для трека').locator('.tc-sub', { hasText: 'Первая' });
    const b = await row.locator('.tc-sub-title').boundingBox();
    const target = await point(col(page, 'На проверке').locator('.column-body'));
    await page.mouse.move(b.x + 10, b.y + b.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 14; i++) { await page.mouse.move(b.x + 10 + (target.x - b.x - 10) * i / 14, b.y + (target.y - b.y) * i / 14); await page.waitForTimeout(16); }
    await page.mouse.up();
    await page.waitForTimeout(800);
    assert(!(await page.locator('#drawer.open').count()), 'drag opened drawer');
    const inReview = col(page, 'На проверке').locator('.column-body > .task-card', { has: page.locator('.tc-title:text-is("Обложка для трека")') });
    assert(await inReview.count() === 1, 'new card not in target column');
    assert((await inReview.locator('.tc-sub-title').allTextContents()).join('|') === 'Первая', 'new card subtasks');
    await page.reload();
    const orig = col(page, 'В работе').locator('.column-body > .task-card', { has: page.locator('.tc-title:text-is("Обложка для трека")') });
    assert((await orig.locator('.tc-sub-title').allTextContents()).join('|') === 'Вторая', 'original card subtasks after refresh');
    const moved = col(page, 'На проверке').locator('.column-body > .task-card', { has: page.locator('.tc-title:text-is("Обложка для трека")') });
    assert((await moved.locator('.tc-sub-title').allTextContents()).join('|') === 'Первая', 'new card after refresh');
    await moved.locator('.tc-title').click();
    await page.locator('#drawer.open .linked-chip').first().waitFor();
    if (SHOTS) await page.screenshot({ path: SHOTS + '/split.png' });
    await page.keyboard.press('Escape');
  });

  await test('K2 — clicking a subtask (no drag) still opens the drawer focused on it', async () => {
    await board();
    await card(page, 'Обложка для трека').first().locator('.tc-sub-title', { hasText: 'Вторая' }).click();
    await page.locator('#drawer.open .st-row.is-focused').waitFor({ timeout: 3000 });
    await page.keyboard.press('Escape');
  });

  await test('L — Home: quick due on a row', async () => {
    await page.goto(BASE + '/');
    const row = page.locator('.home-row', { hasText: 'Вторая' }).first();
    await row.locator('[data-qp="due"]').click();
    await page.locator('.qp-pop:not([hidden]) [data-q="7"]').click();
    await page.locator('.qp-pop:not([hidden]) [data-done]').click();
    await page.waitForTimeout(700);
    const sec = await page.locator('.home-section', { has: page.locator('.home-row', { hasText: 'Вторая' }) }).getAttribute('data-home-section');
    assert(sec === 'soon', 'row not moved to "Скоро": ' + sec);
  });

  await test('M — Sales list: useful columns instead of "Сайт"', async () => {
    await page.goto(BASE + '/spaces/1?view=list');
    const head = await page.locator('.lv-head').textContent();
    assert(!head.includes('Сайт'), 'still has Сайт');
    assert(head.includes('Следующее действие') && head.includes('След. контакт'), 'missing columns: ' + head);
    const row = page.locator('.lv-row', { hasText: 'Fish Shop' });
    assert((await row.locator('.lv-next').textContent()).includes('Follow-up'), 'next action');
    if (SHOTS) await page.screenshot({ path: SHOTS + '/sales-list.png' });
  });


  await test('K3 — Sales: drag a subtask into another stage → new deal "Клиент / …" of the same client', async () => {
    await page.goto(BASE + '/spaces/1');
    const row = card(page, 'Fish Shop').locator('.tc-sub', { hasText: 'Follow-up' });
    const b = await row.locator('.tc-sub-title').boundingBox();
    const target = await point(col(page, 'КП / Оффер').locator('.column-body'));
    await page.mouse.move(b.x + 10, b.y + b.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 14; i++) { await page.mouse.move(b.x + 10 + (target.x - b.x - 10) * i / 14, b.y + (target.y - b.y) * i / 14); await page.waitForTimeout(16); }
    await page.mouse.up();
    await page.waitForTimeout(800);
    await page.reload();
    const deal = col(page, 'КП / Оффер').locator('.task-card .tc-title', { hasText: 'Fish Shop / Follow-up' });
    assert(await deal.count() === 1, 'deal card missing');
    assert(await card(page, 'Fish Shop').count() === 1, 'main client card missing');
    assert(await page.evaluate(() => 1) === 1);
    await deal.click();
    await page.locator('#drawer.open .linked-chip', { hasText: 'Fish Shop' }).waitFor();
    const label = (await page.locator('#drawer.open .field-row', { has: page.locator('.linked-list') }).locator('.field-label').textContent()).trim();
    assert(label === 'Другие сделки', 'label: ' + label);
    if (SHOTS) await page.screenshot({ path: SHOTS + '/deals.png' });
    await page.keyboard.press('Escape');
  });


  await test('O — meeting: switch task to "Созвон", link, join button, .ics', async () => {
    await board();
    await card(page, 'Задача H').locator('.tc-title').click();
    await page.locator('#drawer.open #kindSwitch').waitFor();
    await page.click('#kindSwitch [data-kind="meeting"]');
    await page.fill('#f-meeting-url', 'telemost.yandex.ru/j/123');
    await page.press('#f-meeting-url', 'Enter');
    await page.waitForTimeout(500);
    assert((await page.locator('[data-people-label]').textContent()).trim() === 'Участники', 'label');
    assert(await page.locator('#joinMeeting:not([hidden])').getAttribute('href') === 'https://telemost.yandex.ru/j/123', 'join link');
    const ics = await page.evaluate(async id => (await fetch(`/tasks/${id}/ics`)).text(), await page.locator('#taskForm').getAttribute('data-task-id'));
    assert(ics.includes('BEGIN:VEVENT') && ics.includes('telemost'), 'ics');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const c = card(page, 'Задача H');
    assert(await c.locator('.tc-meeting-ico').count() === 1, 'no 📞 on card');
    assert(await c.locator('.tc-join').count() === 1, 'no join button on card');
    await page.reload();
    assert(await card(page, 'Задача H').locator('.tc-join').count() === 1, 'after refresh');
    if (SHOTS) { await card(page, 'Задача H').locator('.tc-title').click(); await page.locator('#drawer.open').waitFor(); await page.waitForTimeout(300); await page.screenshot({ path: SHOTS + '/meeting.png' }); await page.keyboard.press('Escape'); }
  });

  await test('N — Excel import: template → preview → apply', async () => {
    await page.goto(BASE + '/spaces/1/import');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('a[href$="template.xlsx"]')]);
    const file = await dl.path();
    await page.setInputFiles('input[type=file]', { name: 'base.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: require('fs').readFileSync(file) });
    await page.click('.import-upload button[type=submit]');
    await page.locator('.import-table').waitFor();
    assert(await page.locator('.import-table tbody tr').count() === 2, 'preview rows');
    if (SHOTS) await page.screenshot({ path: SHOTS + '/import-preview.png', fullPage: true });
    await page.click('.import-actions button[type=submit]');
    await page.locator('text=Готово').waitFor();
    await page.goto(BASE + '/spaces/1');
    assert(await card(page, 'Кофейня Бодрость').count() === 1, 'imported client card missing');
    const fish = card(page, 'Fish Shop');
    assert(await fish.count() === 1, 'Fish Shop duplicated or missing: ' + await fish.count());
    assert((await fish.locator('.tc-sub-title').allTextContents()).includes('Отправить КП'), 'imported action missing');
  });

  await browser.close();
  const failed = results.filter(r => r[1] !== 'PASS');
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
