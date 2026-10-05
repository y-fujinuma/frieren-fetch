import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { findTarget, check, notification } from '../src/worker.js';

test('detects a name split across inline elements', () => {
  assert.equal(findTarget('<div class="content__main">次号にフリ<span>ー</span>レン掲載</div>'), true);
});
test('missing or empty content is an error, not a negative notification', () => {
  assert.throws(() => findTarget('<div>フリーレン</div>'));
  assert.throws(() => findTarget('<div class="content__main"> </div>'));
});
test('valid other content reports absence', () => {
  assert.equal(findTarget('<div class="content__main">他作品</div>'), false);
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

for (const failure of ['network', 'timeout', 429, 500, 503]) {
  for (const recover of [true, false]) {
    test(`${failure} GET failure ${recover ? 'recovers on third attempt' : 'stops after three attempts'}`, async (t) => {
      const delays = [], signals = [];
      t.mock.method(globalThis, 'setTimeout', (callback, delay) => { delays.push(delay); callback(); });
      let gets = 0, posts = 0, parses = 0, cancellations = 0;
      const run = check(env, async (url, options) => {
        if (options.method === 'POST') {
          posts++;
          assert.equal(url, 'https://ntfy.sh/');
          assert.equal(gets, 3);
          return new Response('{}');
        }
        gets++;
        signals.push(options.signal);
        assert.equal(url, 'https://websunday.net/sunday/next/');
        if (recover && gets === 3) return html();
        if (failure === 'network') throw new TypeError('connection reset');
        if (failure === 'timeout') throw new DOMException('timed out', 'TimeoutError');
        return new Response(new ReadableStream({cancel() { cancellations++; }}), {status: failure});
      }, async (response) => { parses++; await response.text(); return false; });
      if (recover) assert.deepEqual(await run, {found:false, notified:true});
      else await assert.rejects(run, /Source request failed/);
      assert.equal(gets, 3);
      assert.equal(posts, recover ? 1 : 0);
      assert.equal(parses, recover ? 1 : 0);
      assert.equal(cancellations, typeof failure === 'number' ? (recover ? 2 : 3) : 0);
      assert.deepEqual(delays, [1000, 2000]);
      assert.equal(new Set(signals).size, 3, 'each GET gets a fresh timeout signal');
    });
  }
}

test('deterministic parser errors are not retried', async () => {
  let gets = 0;
  await assert.rejects(check(env, async () => { gets++; return html(); },
    async () => { throw new Error('invalid content'); }), /invalid content/);
  assert.equal(gets, 1);
});

test('ambiguous notification network failure is never retried', async () => {
  let gets = 0, posts = 0;
  await assert.rejects(check(env, async (_url, options) => {
    if (options.method === 'POST') { posts++; throw new TypeError('connection reset after POST'); }
    gets++; return html();
  }, async () => true), /Notification request failed/);
  assert.equal(gets, 1);
  assert.equal(posts, 1);
});

test('an already-errored HTTP error body cannot suppress retry or change permanent status handling', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (callback) => { callback(); });
  for (const status of [404, 429, 503]) {
    let gets = 0;
    await assert.rejects(check(env, async (_url, options) => {
      assert.notEqual(options.method, 'POST');
      gets++;
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error('connection reset after headers')); },
      }), {status});
    }), /Source request failed/);
    assert.equal(gets, status === 404 ? 1 : 3);
  }
});
