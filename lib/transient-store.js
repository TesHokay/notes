const db = require('../db');
function ensure() {
  db.exec('CREATE TABLE IF NOT EXISTS crm_runtime_state (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(namespace, key))');
}
function createStore(namespace, ttlMs) {
  const chunksNamespace=namespace+':chunks';
  function row(key, ns=namespace) { return db.prepare('SELECT value, expires_at FROM crm_runtime_state WHERE namespace = ? AND key = ?').get(ns,String(key)); }
  function remove(key) {
    const metadata=row(key);
    if(metadata) {
      const value=JSON.parse(metadata.value);
      if(value?.encoding==='crm-chunks-v1') for(let i=0;i<value.count;i++) db.prepare('DELETE FROM crm_runtime_state WHERE namespace=? AND key=?').run(chunksNamespace,key+':'+i);
    }
    db.prepare('DELETE FROM crm_runtime_state WHERE namespace=? AND key=?').run(namespace,String(key));
  }
  return {
    get(key) {
      ensure();const metadata=row(key);
      if(!metadata || metadata.expires_at<=Date.now()) return undefined;
      const value=JSON.parse(metadata.value);
      if(value?.encoding!=='crm-chunks-v1') return value;
      const chunks=[];
      for(let i=0;i<value.count;i++) {const part=row(key+':'+i,chunksNamespace);if(!part) return undefined;chunks.push(part.value);}
      return JSON.parse(chunks.join(''));
    },
    set(key,value) {
      ensure();
      require('./task-service').transaction(() => {
        db.prepare('DELETE FROM crm_runtime_state WHERE expires_at<=?').run(Date.now());remove(key);
        const serialized=JSON.stringify(value),expires=Date.now()+ttlMs;
        const save=db.prepare('INSERT INTO crm_runtime_state(namespace,key,value,expires_at) VALUES(?,?,?,?)');
        if(serialized.length<=100000) save.run(namespace,String(key),serialized,expires);
        else {
          const chunks=[];
          for(let offset=0;offset<serialized.length;) {
            let end=Math.min(serialized.length,offset+100000);
            if(end<serialized.length && serialized.charCodeAt(end-1)>=0xd800 && serialized.charCodeAt(end-1)<=0xdbff) end--;
            chunks.push(serialized.slice(offset,end));offset=end;
          }
          chunks.forEach((chunk,i)=>save.run(chunksNamespace,key+':'+i,chunk,expires));
          save.run(namespace,String(key),JSON.stringify({encoding:'crm-chunks-v1',count:chunks.length}),expires);
        }
      });
    },
    delete(key) {ensure();require('./task-service').transaction(()=>remove(key));},
  };
}
module.exports={createStore};
