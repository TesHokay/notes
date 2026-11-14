const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const source=path.resolve(process.argv[2] || 'data/team-crm.db');
const output=path.resolve(process.argv[3] || 'data/cloudflare-export.json');
const database=new DatabaseSync(source,{readOnly:true});
try {
  const names=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,1)!='_' AND name NOT IN ('crm_runtime_state','crm_telegram_outbox') ORDER BY name").all();
  database.exec('BEGIN');
  const tables=Object.fromEntries(names.map(({name})=>[name,database.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()]));
  database.exec('COMMIT');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify({format:'pulsaura-crm',version:1,createdAt:new Date().toISOString(),tables}),{mode:0o600});
  console.log('CRM export saved: '+output);
} finally {database.close();}
