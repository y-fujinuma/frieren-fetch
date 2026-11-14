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
const barkEnv = {BARK_KEY:'test-Bark_key123'};

test('Bark-only sends the same title/body without ntfy headers and uses a 15s timeout', async (t) => {
  const timeouts = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return timeout(ms); });
  for (const found of [true, false]) {
    const calls = [];
    const result = await check({...barkEnv, NTFY_TOKEN:'private-token'}, async (url, options) => {
      calls.push({url, options});
      return options.method === 'POST' ? Response.json({code:200}) : html();
    }, async () => found);
    assert.deepEqual(result, {found, notified:true});
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, `https://api.day.app/${barkEnv.BARK_KEY}`);
    assert.deepEqual(calls[1].options.headers, {'Content-Type':'application/json'});
    const message = notification(found);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      title:message.title, body:message.message, group:'frieren-fetch',
    });
  }
  assert.deepEqual(timeouts, [15000, 15000, 15000, 15000]);
});

for (const body of [{code:400, message:'private-key'}, {code:'200'}, {}, null, 'invalid JSON']) {
  test(`Bark rejects unsuccessful or invalid JSON: ${JSON.stringify(body)}`, async () => {
    let posts = 0;
    await assert.rejects(check(barkEnv, async (_url, options) => {
      if (options.method !== 'POST') return html();
      posts++;
      return typeof body === 'string' ? new Response(body) : Response.json(body);
    }, async () => true), /Bark notification (rejected|response failed)/);
    assert.equal(posts, 1);
  });
}

for (const failure of [429, 503, 'network', 'timeout', 'body']) {
  test(`Bark ${failure} retries follow publishDelays`, async (t) => {
    const delays = [];
    t.mock.method(globalThis, 'setTimeout', (callback, ms) => { delays.push(ms); callback(); });
    let posts = 0;
    await assert.rejects(check(barkEnv, async (_url, options) => {
      if (options.method !== 'POST') return html();
      posts++;
      if (failure === 'network') throw new TypeError('private-key');
      if (failure === 'timeout') throw new DOMException('private-key', 'TimeoutError');
      if (failure === 'body') return new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError('private-key')); },
      }));
      return new Response('', {status:failure});
    }, async () => true, [1, 2, 3]), /Bark notification/);
    assert.equal(posts, 4);
    assert.deepEqual(delays, [1, 2, 3]);
  });
}

for (const status of [201, 400, 401, 403]) {
  test(`Bark HTTP ${status} is not success and is not retried`, async () => {
    let posts = 0;
    await assert.rejects(check(barkEnv, async (_url, options) => {
      if (options.method !== 'POST') return html();
      posts++;
      return Response.json({code:200}, {status});
    }, async () => false), new RegExp(`Bark notification HTTP ${status}`));
    assert.equal(posts, 1);
  });
}

test('Bark recovers on retry and stops after success', async (t) => {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => { delays.push(ms); callback(); });
  let posts = 0;
  assert.deepEqual(await check(barkEnv, async (_url, options) => {
    if (options.method !== 'POST') return html();
    return ++posts === 1 ? new Response('', {status:429}) : Response.json({code:200});
  }, async () => false, [7, 9]), {found:false, notified:true});
  assert.equal(posts, 2);
  assert.deepEqual(delays, [7]);
});

for (const failed of ['ntfy', 'bark', 'neither', 'both']) {
  test(`dual channels: ${failed} fail, with secret-free outcome logs`, async (t) => {
    const logs = [];
    t.mock.method(console, 'log', line => logs.push(line));
    const calls = [];
    const run = check({...env, ...barkEnv}, async (url, options) => {
      if (options.method !== 'POST') return html();
      const channel = url === 'https://ntfy.sh/' ? 'ntfy' : 'bark';
      calls.push(channel);
      if (failed === channel || failed === 'both') return new Response('', {status:400});
      return Response.json({code:200});
    }, async () => true);
    if (failed === 'both') {
      await assert.rejects(run, /Bark notification HTTP 400/);
      assert.deepEqual(logs, []);
    } else {
      assert.deepEqual(await run, {found:true, notified:true});
      assert.deepEqual(JSON.parse(logs[0]), {event:'check_completed', found:true,
        channels:{ntfy:failed !== 'ntfy', bark:failed !== 'bark'}});
      assert.ok(!logs[0].includes(env.NTFY_TOPIC));
      assert.ok(!logs[0].includes(barkEnv.BARK_KEY));
    }
    assert.deepEqual(calls, ['ntfy', 'bark']);
  });
}

test('dual-channel retries do not resend an already-successful channel', async (t) => {
  const delays = [];
  const posts = {ntfy:0, bark:0};
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => { delays.push(ms); callback(); });
  const result = await check({...env, ...barkEnv}, async (url, options) => {
    if (options.method !== 'POST') return html();
    const channel = url === 'https://ntfy.sh/' ? 'ntfy' : 'bark';
    posts[channel]++;
    return channel === 'ntfy' ? new Response('', {status:429}) : Response.json({code:200});
  }, async () => false, [3, 8]);
  assert.deepEqual(result, {found:false, notified:true});
  assert.deepEqual(posts, {ntfy:3, bark:1});
  assert.deepEqual(delays, [3, 8]);
});

test('invalid channel secrets cannot make network calls when neither is valid', async () => {
  for (const secrets of [{NTFY_TOPIC:'bad/topic'}, {BARK_KEY:'bad/key'},
    {BARK_KEY:'bad key'}, {BARK_KEY:'日本語'}, {BARK_KEY:123}, {BARK_KEY:'key\n'}]) {
    await assert.rejects(check(secrets, async () => assert.fail('unexpected network')), /missing or invalid|BARK_KEY is invalid/);
  }
});

test('a valid channel works when the other secret is invalid', async () => {
  for (const secrets of [{...barkEnv, NTFY_TOPIC:'bad/topic'}, {...env, BARK_KEY:'bad/key'}]) {
    const posts = [];
    await check(secrets, async (url, options) => {
      if (options.method !== 'POST') return html();
      posts.push(url);
      return Response.json({code:200});
    }, async () => true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0], secrets.BARK_KEY === barkEnv.BARK_KEY
      ? `https://api.day.app/${barkEnv.BARK_KEY}` : 'https://ntfy.sh/');
  }
});

test('scheduled handler applies the long publish budget to Bark', async (t) => {
  const delays = [];
  let posts = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => { delays.push(ms); callback(); });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method !== 'POST') return new Response('<div class="content__main">他作品</div>',
      {headers:{'Content-Type':'text/html'}});
    posts++;
    return new Response('', {status:503});
  });
  await assert.rejects(worker.scheduled({}, barkEnv), /Bark notification HTTP 503/);
  assert.equal(posts, 6);
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000]);
});
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
test('ntfy 429 is retried, then surfaced after three attempts', async (t) => {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { delays.push(delay); callback(); });
  let calls=0;
  await assert.rejects(check(env,async()=>++calls===1 ? html() : new Response('',{status:429}),async()=>false),/Notification HTTP 429/);
  assert.equal(calls,4);
  assert.deepEqual(delays,[3000,8000]);
});
test('ntfy permanent 4xx is not retried', async () => {
  let posts=0;
  await assert.rejects(check(env,async(_url,options)=>options.method==='POST' ? (posts++, new Response('',{status:400})) : html(),async()=>true),/Notification HTTP 400/);
  assert.equal(posts,1);
});
test('ntfy publish recovers after 429 and network failures, reusing one X-ID', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (callback) => { callback(); });
  const ids = [];
  let posts=0;
  const result = await check(env, async (_url, options) => {
    if (options.method !== 'POST') return html();
    posts++;
    ids.push(options.headers['X-ID']);
    if (posts === 1) return new Response('',{status:429});
    if (posts === 2) throw new TypeError('connection reset after POST');
    return new Response('{}');
  }, async () => false);
  assert.deepEqual(result,{found:false,notified:true});
  assert.equal(posts,3);
  assert.ok(ids[0]);
  assert.deepEqual(ids,[ids[0],ids[0],ids[0]]);
});
test('X-ID is deterministic per JST date and result across separate runs', async () => {
  const ids = [];
  for (let run = 0; run < 2; run++) {
    await check(env, async (_url, options) => {
      if (options.method === 'POST') { ids.push(options.headers['X-ID']); return new Response('{}'); }
      return html();
    }, async () => false);
  }
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.match(ids[0], /^frieren-\d{4}-\d{2}-\d{2}-absent$/);
});
test('scheduled-style publish budget retries over the given delays', async (t) => {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { delays.push(delay); callback(); });
  let posts = 0;
  await assert.rejects(check(env, async (_url, options) => {
    if (options.method === 'POST') { posts++; return new Response('',{status:522}); }
    return html();
  }, async () => true, [1, 2, 3]), /Notification HTTP 522/);
  assert.equal(posts, 4);
  assert.deepEqual(delays, [1, 2, 3]);
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

test('ambiguous notification network failure is retried three times with one X-ID', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (callback) => { callback(); });
  let gets = 0, posts = 0;
  const ids = new Set();
  await assert.rejects(check(env, async (_url, options) => {
    if (options.method === 'POST') { posts++; ids.add(options.headers['X-ID']); throw new TypeError('connection reset after POST'); }
    gets++; return html();
  }, async () => true), /Notification request failed/);
  assert.equal(gets, 1);
  assert.equal(posts, 3);
  assert.equal(ids.size, 1);
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
