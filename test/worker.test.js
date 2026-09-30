import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { createDetector, check, notification } from '../src/worker.js';

test('detects a name split across text chunks', () => {
  const d = createDetector(); d.element();
  for (const text of ['次号にフリ', 'ー', 'レン掲載']) d.text({text});
  assert.equal(d.result(), true);
});
test('missing or empty content is an error, not a negative notification', () => {
  const d = createDetector(); assert.throws(() => d.result());
  d.element(); d.text({text: ' \n '}); assert.throws(() => d.result());
});
test('valid other content reports absence', () => {
  const d = createDetector(); d.element(); d.text({text:'他作品'});
  assert.equal(d.result(), false);
});
test('preserves Japanese notification and priority', () => {
  assert.equal(notification(true, 'test').priority, 4);
  assert.equal(notification(false, 'test').title, 'フリーレン掲載なし');
});
const env = {NTFY_TOPIC:'test-only'};
const html = () => new Response('<div>test</div>', {headers:{'Content-Type':'text/html; charset=utf-8'}});
test('publishes JSON to ntfy after successful parsing', async () => {
  const calls=[];
  const result=await check(env, async (url, options) => {
    calls.push({url, options}); return calls.length === 1 ? html() : new Response('{}');
  }, async () => true);
  assert.deepEqual(result,{found:true,notified:true});
  assert.equal(calls[1].url, 'https://ntfy.sh/');
  assert.deepEqual(JSON.parse(calls[1].options.body),notification(true,env.NTFY_TOPIC));
});
test('404 does not publish or retry', async () => {
  let calls=0;
  await assert.rejects(check(env,async()=>{calls++;return new Response('',{status:404});}));
  assert.equal(calls,1);
});
test('wrong content type and parser failure do not publish', async () => {
  let calls=0;
  await assert.rejects(check(env,async()=>{calls++;return new Response('{}');}));
  assert.equal(calls,1);
  await assert.rejects(check(env,async()=>html(),async()=>{throw new Error('missing');}));
});
test('ntfy HTTP failure is surfaced without retry', async () => {
  let calls=0;
  await assert.rejects(check(env,async()=>++calls===1 ? html() : new Response('',{status:429}),async()=>false),/Notification HTTP 429/);
  assert.equal(calls,2);
});
test('missing secret makes no network calls', async () => {
  await assert.rejects(check({},async()=>assert.fail('unexpected network')),/NTFY_TOPIC/);
});
test('HTTP endpoint requires POST and configured authentication', async () => {
  assert.equal((await worker.fetch(new Request('https://test/run'),{})).status,405);
  assert.equal((await worker.fetch(new Request('https://test/run',{method:'POST'}),{})).status,401);
  assert.equal((await worker.fetch(new Request('https://test/'),{})).status,404);
});
