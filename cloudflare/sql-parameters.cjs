function literal(value) {
  if(value===null) return 'NULL';
  if(typeof value==='number' && Number.isFinite(value)) return String(value);
  if(typeof value==='bigint') return String(value);
  if(typeof value==='string') return value.includes('\0') ? "CAST(X'"+Buffer.from(value).toString('hex')+"' AS TEXT)" : "'"+value.replaceAll("'","''")+"'";
  if(ArrayBuffer.isView(value)) return "X'"+Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('hex')+"'";
  throw new TypeError('Unsupported SQLite parameter');
}
function expand(sql, parameters) {
  let result='', index=0;
  for(let i=0;i<sql.length;i++) {
    const ch=sql[i];
    if(ch==='\'' || ch==='"' || ch==='`' || ch==='[') {
      const end=ch==='['?']':ch;result+=ch;
      for(i++;i<sql.length;i++) { result+=sql[i];if(sql[i]===end) { if(sql[i+1]===end) {result+=sql[++i];continue;}break;} }
    } else if(sql.slice(i,i+2)==='--') {
      const end=sql.indexOf('\n',i);if(end<0) {result+=sql.slice(i);break;}result+=sql.slice(i,end+1);i=end;
    } else if(sql.slice(i,i+2)==='/*') {
      const end=sql.indexOf('*/',i+2);if(end<0) throw new Error('Unterminated SQL comment');result+=sql.slice(i,end+2);i=end+1;
    } else if(ch==='?') {
      if(index>=parameters.length || /[0-9]/.test(sql[i+1] || '')) throw new Error('Invalid SQLite placeholders');
      result+=literal(parameters[index++]);
    } else result+=ch;
  }
  if(index!==parameters.length) throw new Error('SQLite parameter count mismatch');
  return result;
}
module.exports={expand};
