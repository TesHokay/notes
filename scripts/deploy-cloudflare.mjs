import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configureTelegram } from './configure-telegram.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const cli=path.join(root,'node_modules/wrangler/bin/wrangler.js');
function command(args,required=true) {
  const result=spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024,env:process.env});
  if(result.stdout) process.stdout.write(result.stdout);
  if(result.stderr) process.stderr.write(result.stderr);
  if(result.error) throw result.error;
  if(required && result.status!==0) throw new Error('Wrangler command failed: '+args.slice(0,3).join(' '));
  return {...result,output:(result.stdout || '')+'\n'+(result.stderr || '')};
}
try {
  if(process.argv.includes('--dry-run')) {command(['deploy','--dry-run']);process.exit(0);}
  const config=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
  const secretFile=path.join(root,'.cloudflare-secrets.json');
  let secrets=fs.existsSync(secretFile)?JSON.parse(fs.readFileSync(secretFile,'utf8')):{};
  for(const key of ['SESSION_SECRET','SEED_ADMIN_PASSWORD','BACKUP_ADMIN_TOKEN','APP_URL','TELEGRAM_BOT_TOKEN','TELEGRAM_BOT_USERNAME','TELEGRAM_WEBHOOK_SECRET','OUTREACH_API_TOKEN']) if(process.env[key]) secrets[key]=process.env[key];
  if(process.env.CI && (!secrets.SESSION_SECRET || !secrets.SEED_ADMIN_PASSWORD || !secrets.BACKUP_ADMIN_TOKEN)) throw new Error('CI requires SESSION_SECRET, SEED_ADMIN_PASSWORD and BACKUP_ADMIN_TOKEN as stable environment secrets.');
  secrets.BACKUP_ADMIN_TOKEN ||= crypto.randomBytes(32).toString('hex');
  secrets.SESSION_SECRET ||= crypto.randomBytes(48).toString('hex');
  secrets.SEED_ADMIN_PASSWORD ||= crypto.randomBytes(18).toString('base64url');
  if(secrets.TELEGRAM_BOT_TOKEN) secrets.TELEGRAM_WEBHOOK_SECRET ||= crypto.randomBytes(32).toString('hex');
  if(secrets.SESSION_SECRET.length<32 || secrets.SEED_ADMIN_PASSWORD.length<12) throw new Error('SESSION_SECRET needs at least 32 characters and SEED_ADMIN_PASSWORD at least 12.');
  // Keep the same credentials on every later deployment; never print secret values.
  fs.writeFileSync(secretFile,JSON.stringify(secrets,null,2)+'\n',{mode:0o600});
  const deployed=command(['deploy']);
  const address=deployed.output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
  secrets.APP_URL ||= address;
  if(!secrets.APP_URL) throw new Error('Set APP_URL in .cloudflare-secrets.json to the deployed HTTPS address, then run cf:deploy again.');
  fs.writeFileSync(secretFile,JSON.stringify(secrets,null,2)+'\n',{mode:0o600});
  command(['secret','bulk',secretFile]);
  await configureTelegram(secrets);
  const ready=await fetch(secrets.APP_URL.replace(/\/$/,'')+'/login',{signal:AbortSignal.timeout(30000)});
  if(!ready.ok) throw new Error('Deployment uploaded, but /login returned '+ready.status+'. Inspect Worker logs with: npx wrangler tail');
  console.log('\nCRM deployed: '+secrets.APP_URL);
  console.log('Administrator email: '+config.vars.SEED_ADMIN_EMAIL);
  console.log('Administrator password is saved as SEED_ADMIN_PASSWORD in .cloudflare-secrets.json. Keep that file private.');
} catch(error) {console.error(error.message);process.exitCode=1;}
