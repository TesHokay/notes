import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import app from '../app.js';
import runtime from '../lib/runtime.js';
import schema from '../db/schema.js';
import seed from '../db/seed.js';
import adapter from './sqlite.cjs';
import telegram from '../lib/telegram.js';
import trash from '../lib/trash.js';
import dates from '../lib/dates.js';
import { timingSafeEqual } from 'node:crypto';
app.listen(3000);
function configurationError(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return 'Set SESSION_SECRET (at least 32 characters) in Cloudflare Worker secrets.';
  if (!env.FILES || !env.CRM) return 'Cloudflare storage bindings are missing.';
  if (env.TELEGRAM_BOT_TOKEN && (!env.TELEGRAM_WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET.length < 24)) return 'Set TELEGRAM_WEBHOOK_SECRET before enabling the Telegram bot.';
  return null;
}
export class CrmDatabase extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = Promise.resolve();
    this.context = { env, database: new adapter.DurableDatabase(ctx.storage, env.FILES), waitUntil: promise => ctx.waitUntil(promise) };
    ctx.blockConcurrencyWhile(async () => runtime.run(this.context, () => {
      const db = this.context.database;
      db.transactionSync(() => {
        schema.initializeSchema(db);
        db.exec('CREATE TABLE IF NOT EXISTS crm_runtime_state (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(namespace,key))');
        db.exec('CREATE TABLE IF NOT EXISTS crm_telegram_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0)');
        if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
          if (!env.SEED_ADMIN_PASSWORD || env.SEED_ADMIN_PASSWORD.length < 12) throw new Error('Set SEED_ADMIN_PASSWORD to at least 12 characters before the first deployment.');
          seed.seedDatabase(db, { quiet: true });
        }
      });
    }));
  }
  exclusive(fn) {
    const result = this.queue.then(() => runtime.run(this.context, fn));
    this.queue = result.catch(() => {});
    return result;
  }
  fetch(request) {
    return this.exclusive(async () => {
      const response = await handleAsNodeRequest(3000, request);
      this.ctx.waitUntil(runtime.run(this.context, () => telegram.flushOutbox()));
      return response;
    });
  }
  tick() {
    return this.exclusive(async () => {
      telegram.checkReminders();
      telegram.checkDueDates();
      telegram.sendOwnerDigest();
      trash.purgeExpired();
      const db = this.context.database;
      db.prepare('DELETE FROM crm_runtime_state WHERE expires_at <= ?').run(Date.now());
      const today = dates.localDate();
      const lastBackup = db.prepare("SELECT value FROM settings WHERE key = 'cloudflare_daily_backup'").get();
      if (!lastBackup || lastBackup.value !== today) {
        await db.makeBackup();
        db.prepare("INSERT INTO settings(key,value) VALUES('cloudflare_daily_backup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(today);
      }
    }).then(() => runtime.run(this.context, () => telegram.flushOutbox()));
  }
  update(update) {
    return this.exclusive(async () => {
      const db = this.context.database;
      const key = 'tg-update:' + update.update_id;
      if (!Number.isSafeInteger(update.update_id)) return;
      const seen = db.prepare('SELECT key FROM crm_runtime_state WHERE namespace = ? AND key = ?').get('telegram', key);
      if (seen) return;
      await telegram.handleUpdate(update);
      db.prepare('INSERT OR IGNORE INTO crm_runtime_state(namespace,key,value,expires_at) VALUES(?,?,?,?)').run('telegram', key, 'true', Date.now()+7*86400000);
      this.ctx.waitUntil(runtime.run(this.context, () => telegram.flushOutbox()));
    });
  }
}
function database(env) { return env.CRM.get(env.CRM.idFromName('team-crm')); }
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (['GET','HEAD'].includes(request.method) && (/^\/(css|js|icons)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest')) return env.ASSETS.fetch(request);
    if (url.pathname === '/health') return Response.json({ ok: true });
    const error = configurationError(env);
    if (error) return new Response(error, { status: 503 });
    if (url.pathname === '/telegram/webhook') {
      const expected = Buffer.from(env.TELEGRAM_WEBHOOK_SECRET || '');
      const provided = Buffer.from(request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '');
      if (!env.TELEGRAM_BOT_TOKEN || expected.length !== provided.length || !expected.length || !timingSafeEqual(expected, provided)) return new Response('Forbidden', { status: 403 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (Number(request.headers.get('content-length') || 0) > 200000) return new Response('Too large', { status: 413 });
      let update;
      try { update = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
      await database(env).update(update);
      return Response.json({ ok: true });
    }
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Proto', url.protocol.slice(0, -1));
    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '127.0.0.1');
    return database(env).fetch(new Request(request, { headers }));
  },
  async scheduled(_controller, env, ctx) {
    if (configurationError(env)) throw new Error('Configure CRM secrets and storage before scheduled jobs run.');
    await database(env).tick();
  },
};
