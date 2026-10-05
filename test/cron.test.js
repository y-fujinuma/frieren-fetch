import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Cloudflare Cron is Tuesday 22:15 UTC, Wednesday 07:15 JST', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, ['15 22 * * TUE']);
  // Cloudflare weekdays are 1=SUN..7=SAT, unlike GitHub's 0=SUN.
  // https://developers.cloudflare.com/workers/configuration/cron-triggers/
  const [minute, hour, day, month, weekday] = config.triggers.crons[0].split(' ');
  assert.equal(day, '*');
  assert.equal(month, '*');
  const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  for (const date of ['2026-09-29', '2026-12-29', '2027-01-05']) {
    const utc = new Date(`${date}T${hour}:${minute}:00Z`);
    assert.equal(weekdays[utc.getUTCDay()], weekday);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tokyo', weekday: 'short', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(utc).map(({type, value}) => [type, value]));
    assert.deepEqual([parts.weekday, parts.hour, parts.minute], ['Wed', '07', '15']);
  }
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(`cron=${config.triggers.crons[0].replaceAll(' ', '+')}`));
});

test('setup deployment remains Cron-free', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.setup.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, []);
});
