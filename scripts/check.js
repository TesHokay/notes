// Poor man's "typecheck/lint/build" for a no-bundler app:
// syntax-checks every JS file and compiles every EJS template.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const skip = new Set(['node_modules', 'data', '.git', 'uploads', 'dist', '.wrangler', 'generated', 'tmp']);
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (skip.has(e.name)) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
let failed = 0;
const files = walk(root);
for (const f of files.filter(f => /\.[cm]?js$/.test(f))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { failed++; console.error('JS  ✗', path.relative(root, f), '\n', e.stderr.toString()); }
}
for (const f of files.filter(f => f.endsWith('.ejs'))) {
  try { ejs.compile(fs.readFileSync(f, 'utf8'), { filename: f }); } catch (e) { failed++; console.error('EJS ✗', path.relative(root, f), '\n', e.message); }
}
console.log(failed ? `${failed} file(s) failed` : `OK: ${files.filter(f => /\.([cm]?js|ejs)$/.test(f)).length} files checked`);
process.exit(failed ? 1 : 0);
