import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import esbuild from 'esbuild';
import ejs from 'ejs';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const generated = path.join(root, 'cloudflare/generated');
fs.mkdirSync(generated, { recursive: true });
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
const templates = walk(path.join(root, 'views')).filter(file => file.endsWith('.ejs')).map(file => {
  const name = path.relative(path.join(root, 'views'), file).replaceAll('\\', '/').replace(/\.ejs$/, '');
  const source = fs.readFileSync(file, 'utf8');
  const options = { client: true, compileDebug: false, strict: true, _with: false, filename: name };
  const preliminary = ejs.compile(source, options).toString();
  const ast = parse('(' + preliminary + ')', { ecmaVersion: 2022, ranges: true });
  const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
  const globals = new Set(Reflect.ownKeys(globalThis));
  const names = [...new Set(scopes.globalScope.through.map(ref => ref.identifier.name))].filter(key => !globals.has(key));
  const fn = ejs.compile(source, { ...options, destructuredLocals: names }).toString();
  return JSON.stringify(name) + ': ' + fn;
});
const importTemplate = fs.readFileSync(path.join(root, 'assets/pulsaura-import-template.xlsx')).toString('base64');
fs.writeFileSync(path.join(generated, 'templates.cjs'), 'exports.templates = {\n' + templates.join(',\n') + '\n};\nexports.importTemplate = ' + JSON.stringify(importTemplate) + ';\n');
const publicDir = path.join(root, 'dist/public');
fs.mkdirSync(publicDir, { recursive: true });
for (const name of ['css', 'js', 'icons', 'manifest.webmanifest']) fs.cpSync(path.join(root, 'public', name), path.join(publicDir, name), { recursive: true });
await esbuild.build({
  absWorkingDir: root, entryPoints: ['cloudflare/worker.mjs'], outfile: 'dist/worker.js',
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', sourcemap: true,
  define: { 'process.env.CRM_CLOUDFLARE': '"1"' },
  external: ['cloudflare:*'],
  plugins: [{ name: 'cloudflare-runtime', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.namespace === 'node-builtin') return { path: args.path, external: true };
      const builtin = args.path.replace(/^node:/, '');
      if (builtins.has(builtin)) return { path: 'node:' + builtin, namespace: 'node-builtin' };
      if (args.path.startsWith('.')) {
        const resolved = path.resolve(args.resolveDir, args.path);
        if ([path.join(root, 'db'), path.join(root, 'db/index'), path.join(root, 'db/index.js')].includes(resolved)) return { path: path.join(root, 'cloudflare/database.cjs') };
      }
    });
    build.onLoad({ filter: /.*/, namespace: 'node-builtin' }, args => ({ contents: `import value from ${JSON.stringify(args.path)}; module.exports = value;`, loader: 'js' }));
  } }],
});
console.log(`Cloudflare build ready: ${templates.length} precompiled templates, private uploads excluded from static assets.`);
