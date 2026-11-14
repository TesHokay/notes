const app = require('./app');
const telegram = require('./lib/telegram');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`team-crm запущен: http://localhost:${PORT}`);
  telegram.start();
  const trash = require('./lib/trash');
  trash.purgeExpired();
  setInterval(() => trash.purgeExpired(), 6 * 60 * 60 * 1000).unref();
});
