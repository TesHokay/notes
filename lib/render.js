// Render a view to an HTML string (app.locals such as `fmt` are included).
function renderToString(req, view, locals) {
  return new Promise((resolve, reject) => {
    req.app.render(view, locals, (err, html) => (err ? reject(err) : resolve(html)));
  });
}
module.exports = { renderToString };
