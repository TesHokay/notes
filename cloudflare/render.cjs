const path = require('node:path').posix;
const { templates } = require('./generated/templates.cjs');
function render(view, locals, parent = '') {
  const name = path.normalize(path.join(path.dirname(parent || '.'), view)).replace(/\.ejs$/, '');
  const template = templates[name] || templates[view.replace(/\.ejs$/, '')];
  if (!template) throw new Error('Unknown template: ' + name);
  return template(locals, undefined, (include, extra) => render(include, { ...locals, ...extra }, name));
}
function install(app) {
  app.render = (view, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const locals = { ...app.locals, ...options?._locals, ...options };
    try { callback(null, render(view, locals)); } catch (error) { callback(error); }
  };
}
module.exports = { install, render };
