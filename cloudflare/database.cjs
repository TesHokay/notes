const { current } = require('../lib/runtime');
module.exports = new Proxy({}, {
  get(_target, property) {
    const database = current()?.database;
    if (!database) throw new Error('Cloudflare database accessed outside the CRM Durable Object');
    const value = database[property];
    return typeof value === 'function' ? value.bind(database) : value;
  },
});
