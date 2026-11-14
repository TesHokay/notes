import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
export async function configureTelegram(secrets) {
  if (!secrets.TELEGRAM_BOT_TOKEN) return;
  const url=String(secrets.APP_URL || '').replace(/\/$/,'');
  if (!url.startsWith('https://')) throw new Error('APP_URL must be the public HTTPS address before configuring Telegram.');
  if (!secrets.TELEGRAM_WEBHOOK_SECRET || secrets.TELEGRAM_WEBHOOK_SECRET.length<24) throw new Error('Set TELEGRAM_WEBHOOK_SECRET (at least 24 characters).');
  async function call(method,payload) {
    const result=await fetch('https://api.telegram.org/bot'+secrets.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
    const body=await result.json();if(!body.ok) throw new Error('Telegram '+method+': '+body.description);
  }
  await call('setWebhook',{url:url+'/telegram/webhook',secret_token:secrets.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','callback_query']});
  await call('setChatMenuButton',{menu_button:{type:'web_app',text:'CRM',web_app:{url:url+'/tg'}}});
  console.log('Telegram webhook and CRM menu configured.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const secrets=JSON.parse(fs.readFileSync('.cloudflare-secrets.json','utf8'));
  await configureTelegram(secrets);
}
