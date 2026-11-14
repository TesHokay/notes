import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { unstable_dev } from 'wrangler';
import { chromium } from 'playwright';
const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(root, 'tmp/cf-test-'));
const base = 'http://127.0.0.1:8788';
const password = 'cloudflare-test-password-123';
const config = JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
delete config.build;
config.main = path.join(root,'dist/worker.js');
config.assets.directory = path.join(root,'dist/public');
config.vars = { ...config.vars, NODE_ENV:'development', SESSION_SECRET:'cloudflare-test-session-secret-12345678901234567890', SEED_ADMIN_PASSWORD:password, APP_URL:base, TELEGRAM_BOT_TOKEN:'', TELEGRAM_WEBHOOK_SECRET:'', BACKUP_ADMIN_TOKEN:'test-backup-admin-token-12345678901234567890' };
const configPath=path.join(scratch,'wrangler.json');
fs.writeFileSync(configPath,JSON.stringify(config));
let worker;
let cookie='';
let checks=0;
function pass(message) { checks++; console.log('PASS '+message); }
async function start() {
  worker=await unstable_dev(config.main,{config:configPath,local:true,port:8788,ip:'127.0.0.1',persistTo:path.join(scratch,'state'),logLevel:'error',experimental:{watch:false,disableExperimentalWarning:true,disableDevRegistry:true,testScheduled:true}});
}
async function request(route, options={}) {
  return fetch(base+route,{redirect:'manual',...options,headers:{...options.headers,...(route.startsWith('/admin/backups')?{'X-CRM-Backup-Token':config.vars.BACKUP_ADMIN_TOKEN}:{}),...(options.anonymous?{}:{cookie})}});
}
async function form(route, values, options={}) { return request(route,{...options,method:'POST',body:new URLSearchParams(values)}); }
async function login() {
  const result=await form('/login',{email:'admin@team.local',password},{anonymous:true});
  assert.equal(result.status,302,await result.text());
  cookie=result.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  assert.ok(cookie.includes('session='));
}
async function html(route) { const result=await request(route,{redirect:'follow'}); const body=await result.text(); assert.equal(result.status,200,route+' '+body.slice(0,400)); return body; }
async function backup() {
  const result=await request('/admin/backups',{method:'POST'}); assert.equal(result.status,201,await result.clone().text());
  const {name}=await result.json(); const file=await request('/admin/backups/'+name); assert.equal(file.status,200); return {name,snapshot:await file.json()};
}
async function restore(snapshot) {
  const body=new FormData(); body.set('backup',new Blob([JSON.stringify(snapshot)],{type:'application/json'}),'backup.json');body.set('password',password);body.set('confirm','RESTORE');
  const result=await request('/admin/backups/restore',{method:'POST',body}); assert.equal(result.status,200,await result.text()); cookie=''; await login();
}
try {
  await start();
  const anonymous=await request('/',{anonymous:true}); assert.equal(anonymous.status,302); pass('anonymous access requires login');
  await login();pass('administrator login');
  for(const route of ['/','/spaces','/spaces/1','/spaces/2','/spaces/3','/spaces/4','/clients','/users','/profile','/trash','/feed/general','/spaces/1/import']) { await html(route);pass('page '+route); }
  const denied=await request('/telegram/webhook',{method:'POST',body:'{}'});assert.equal(denied.status,403);pass('Telegram webhook rejects unsigned requests');
  // Run the original browser acceptance suite against Cloudflare with its own isolated fixtures.
  const fixtureDb=path.join(scratch,'fixtures.db');
  const seeded=spawnSync(process.execPath,['-e',"require('./db/seed').seedDatabase(require('./db'), {quiet:true}); require('./tests/e2e/fixtures');"],{cwd:root,env:{...process.env,DB_PATH:fixtureDb,SEED_ADMIN_PASSWORD:password,NODE_ENV:'development'},encoding:'utf8'});
  assert.equal(seeded.status,0,seeded.stderr);
  const fixtureSqlite=new DatabaseSync(fixtureDb);
  const names=fixtureSqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const tables=Object.fromEntries(names.map(({name})=>[name,fixtureSqlite.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()]));fixtureSqlite.close();
  await restore({format:'pulsaura-crm',version:1,createdAt:new Date().toISOString(),tables});
  let executable=process.env.CHROMIUM || chromium.executablePath();
  if(!fs.existsSync(executable)) {
    const cache=path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'.cache'),'ms-playwright');
    const candidates=fs.existsSync(cache)?fs.readdirSync(cache).filter(n=>/^chromium-/.test(n)).sort().reverse():[];
    executable=candidates.flatMap(n=>['chrome-win64/chrome.exe','chrome-win/chrome.exe','chrome-linux/chrome'].map(p=>path.join(cache,n,p))).find(p=>fs.existsSync(p));
  }
  assert.ok(executable,'Install Chromium with: npx playwright install chromium');
  if(!process.argv.includes('--skip-acceptance')) {
  const browserResult=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['tests/e2e/acceptance.js'],{cwd:root,env:{...process.env,BASE:base,ADMIN_PASSWORD:password,CHROMIUM:executable},stdio:'inherit'});child.on('error',reject);child.on('exit',resolve);
  });
  assert.equal(browserResult,0,'Original browser acceptance suite failed');pass('original browser acceptance suite on Cloudflare');
  }
  await login();
  const created=await request('/sections/9/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Cloudflare persistence check',due_date:'2026-11-20',due_time:'15:00'})});
  assert.equal(created.status,201,await created.clone().text());const {task}=await created.json();
  const calendar=await request('/tasks/'+task.id+'/ics');assert.equal(calendar.status,200);assert.ok((await calendar.text()).includes('DTSTART:20261120T120000Z'));pass('calendar export uses Moscow time rather than Worker UTC');
  const png=fs.readFileSync('public/icons/favicon-48.png');const imageForm=new FormData();imageForm.set('body','Cloudflare R2 persistence');imageForm.set('image',new Blob([png],{type:'image/png'}),'image.png');
  const post=await request('/feed/general',{method:'POST',body:imageForm});assert.equal(post.status,302,await post.text());
  const feed=await html('/feed/general');const imagePath=feed.match(/\/uploads\/feed\/[\w.-]+\.png/)[0];
  const image=await request(imagePath);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  assert.equal((await request(imagePath,{anonymous:true})).status,302);pass('R2 images remain private and retain original bytes');
  const csvForm=new FormData();csvForm.set('file',new Blob(['Клиент;Этап\nКлиент Cloudflare;Новый лид\n'],{type:'text/csv'}),'clients.csv');
  const preview=await request('/spaces/1/import/preview',{method:'POST',body:csvForm});assert.equal(preview.status,200);const previewHtml=await preview.text();
  const token=previewHtml.match(/name="token"\s+value="([a-f0-9]+)"/)?.[1];assert.ok(token,previewHtml.slice(-1500));
  for(let i=0;i<8;i++) assert.equal((await form('/login',{email:'missing@example.test',password:'incorrect'})).status,401);
  await worker.stop();worker=null;await start();
  await login();assert.ok((await html('/tasks/'+task.id)).includes('Cloudflare persistence check'));
  const persistedImage=await request(imagePath);assert.equal(persistedImage.status,200);assert.deepEqual(Buffer.from(await persistedImage.arrayBuffer()),png);pass('SQLite and R2 survive a full runtime restart');
  assert.equal((await form('/login',{email:'missing@example.test',password:'incorrect'})).status,429);pass('login rate limiting survives restart');
  const imported=await form('/spaces/1/import/apply',{token});assert.equal(imported.status,200);assert.ok((await imported.text()).includes('Готово'));assert.ok((await html('/spaces/1')).includes('Клиент Cloudflare'));pass('import preview survives restart and can be applied');
  const protectedBackup=await request('/admin/backups',{anonymous:true});assert.equal(protectedBackup.status,302);
  assert.equal((await fetch(base+'/admin/backups',{headers:{cookie}})).status,403);pass('owner role alone cannot download private workspace backups');
  const saved=await backup();assert.equal(saved.snapshot.format,'pulsaura-crm');assert.ok(saved.snapshot.tables.tasks.some(t=>t.id===task.id));pass('owner can create and download complete backups');
  const space=await form('/spaces',{name:'Cloudflare delete check'});assert.equal(space.status,302);const spacePath=space.headers.get('location');
  const removed=await form(spacePath+'/delete',{confirm_name:'Cloudflare delete check'});assert.equal(removed.status,302,await removed.text());assert.equal((await request(spacePath)).status,404);
  const list=await (await request('/admin/backups')).json();assert.ok(list.backups.some(b=>b.name.includes('before-delete-space-')));pass('destructive operations save an R2 backup first');
  const rename=await request('/tasks/'+task.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Changed after backup'})});assert.equal(rename.status,200);
  await restore(saved.snapshot);assert.ok((await html('/tasks/'+task.id)).includes('Cloudflare persistence check'));pass('backup restores relational data and requires a new login');
  const scheduled=await fetch(base+'/cdn-cgi/local/scheduled?cron=*+*+*+*+*&format=json',{redirect:'manual'});assert.equal(scheduled.status,200,await scheduled.clone().text());assert.equal((await scheduled.json()).outcome,'ok');
  const scheduledBackups=await (await request('/admin/backups')).json();assert.ok(scheduledBackups.backups.some(b=>/Z\.json$/.test(b.name)));pass('scheduled housekeeping and daily backups run in Cloudflare');
  const browser=await chromium.launch({executablePath:executable});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Yekaterinburg'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/login');await page.fill('[name=email]','admin@team.local');await page.fill('[name=password]',password);await Promise.all([page.waitForURL(base+'/'),page.click('button[type=submit]')]);
    assert.equal(await page.evaluate(()=>window.__TZ_OFFSET),180);await page.goto(base+'/spaces/2');assert.ok(await page.getByText('Cloudflare persistence check',{exact:true}).count());
    assert.deepEqual(errors,[]);await page.screenshot({path:path.join(scratch,'cloudflare-board.png'),fullPage:true});pass('browser rendering and CRM timezone after restore');
  } finally {await browser.close();}
  console.log(`Cloudflare integration: ${checks} checks passed. Artifacts: ${path.relative(root,scratch)}`);
} finally {if(worker) await worker.stop();}
