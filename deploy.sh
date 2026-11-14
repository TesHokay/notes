#!/usr/bin/env bash
# Обновление CRM на сервере: бэкап базы → свежий код с GitHub → зависимости → перезапуск.
# Запуск на сервере из папки проекта:  ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "→ Бэкап базы"
[ -f data/team-crm.db ] && node scripts/backup.js deploy || echo "  (базы ещё нет — пропускаю)"

echo "→ Забираю код с GitHub"
git fetch --quiet origin
git reset --hard origin/main   # код = ровно то, что на GitHub (data/ и .env не трогаются — они не в git)

echo "→ Зависимости"
npm ci --omit=dev --no-audit --no-fund

echo "→ Проверка"
npm run -s check

echo "→ Перезапуск"
# Beget (Passenger) перезапускает приложение по touch tmp/restart.txt;
# если используется pm2 — перезапускаем через него.
if command -v pm2 >/dev/null 2>&1 && pm2 describe team-crm >/dev/null 2>&1; then
  pm2 restart team-crm --update-env
else
  mkdir -p tmp && touch tmp/restart.txt
fi
echo "✓ Готово"
