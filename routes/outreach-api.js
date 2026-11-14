// POST /api/outreach/events — the cold outreach bot reports warm leads here.
// Auth: header "Authorization: Bearer <OUTREACH_API_TOKEN>" (or "X-Api-Key: <token>").
// Answers: 200 {ok:true,...} accepted (duplicate:true = already had it) · 400 {ok:false,error} bad data,
// don't resend as is · 401 wrong token · 503 intake switched off · 500 our error, resend later.
const crypto = require('node:crypto');
const express = require('express');
const outreach = require('../lib/outreach');

const router = express.Router();
router.use(express.json({ limit: '100kb' }));

function tokenOk(req) {
  const expected = process.env.OUTREACH_API_TOKEN || '';
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const given = Buffer.from((m ? m[1] : req.headers['x-api-key'] || '').trim());
  const want = Buffer.from(expected);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

router.post('/events', (req, res) => {
  if (!process.env.OUTREACH_API_TOKEN) return res.status(503).json({ ok: false, error: 'intake_disabled' });
  if (!tokenOk(req)) return res.status(401).json({ ok: false, error: 'bad_token' });
  try {
    res.json(outreach.handleEvent(req.body));
  } catch (err) {
    if (err instanceof outreach.InputError) return res.status(400).json({ ok: false, error: err.message });
    console.error('[outreach]', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.get('/ping', (req, res) => {
  if (!process.env.OUTREACH_API_TOKEN) return res.status(503).json({ ok: false, error: 'intake_disabled' });
  if (!tokenOk(req)) return res.status(401).json({ ok: false, error: 'bad_token' });
  res.json({ ok: true, stages: outreach.STAGES, events: Object.keys(outreach.EVENTS) });
});

module.exports = router;
