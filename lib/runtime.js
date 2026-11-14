const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
function current() { return storage.getStore(); }
function background(promise) {
  const context = current();
  if (context && promise) context.waitUntil(Promise.resolve(promise));
  return promise;
}
module.exports = { current, run: (context, fn) => storage.run(context, fn), background };
