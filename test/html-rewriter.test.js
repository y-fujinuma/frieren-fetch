import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

test('Workers runtime parses only the target content and rejects missing content', async () => {
  const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: '2026-09-29',
    script: source.replace('export default {', 'const worker = {') + `
      export default { async fetch(request) {
        try { return Response.json({ found: await detect(new Response(await request.text(), {headers:{'Content-Type':'text/html; charset=utf-8'}})) }); }
        catch { return new Response('parse error', {status:422}); }
      } };
    `,
  }));
  try {
    for (const [html, found] of [
      ['<nav>フリーレン</nav><div class="content__main"><p>別作品</p></div>', false],
      ['<div class="content__main"><p>フリ<span>ーレン</span></p></div>', true],
      ['<div class="content__main">&#12501;&#12522;&#12540;&#12524;&#12531;</div>', true],
    ]) {
      const response = await mf.dispatchFetch('https://test/',{method:'POST',body:html});
      assert.equal(response.status,200);
      assert.deepEqual(await response.json(),{found},html);
    }
    for (const html of ['<div>フリーレン</div>', '<div class="content__main"> </div>']) {
      assert.equal((await mf.dispatchFetch('https://test/',{method:'POST',body:html})).status,422);
    }
  } finally { await mf.dispose(); }
});

test('Workers runtime retries interrupted bodies and never publishes partial results', async () => {
  const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: '2026-09-29',
    script: source.replace('export default {', 'const worker = {') + `
      export default { async fetch(request) {
        const mode = new URL(request.url).pathname.slice(1);
        let gets = 0, posts = 0, payload;
        const fetcher = async (_url, options) => {
          if (options.method === 'POST') {
            posts++;
            payload = JSON.parse(options.body);
            return new Response('{}');
          }
          gets++;
          const headers = {'Content-Type':'text/html; charset=utf-8'};
          if (mode === 'missing') return new Response('<div>other</div>', {headers});
          if (mode === 'empty') return new Response('<div class="content__main"> </div>', {headers});
          if ((mode === 'recover' && gets === 3) || (mode === 'signal-timeout' && gets === 2)) {
            return new Response('<div class="content__main">別作品</div>', {headers});
          }
          let sent = false;
          return new Response(new ReadableStream({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(new TextEncoder().encode('<div class="content__main">フリーレン'));
              } else if (mode === 'signal-timeout') {
                return new Promise(resolve => options.signal.addEventListener('abort', () => {
                  controller.error(options.signal.reason);
                  resolve();
                }, {once:true}));
              } else {
                controller.error(mode === 'timeout'
                  ? new DOMException('timed out reading body', 'TimeoutError')
                  : new Error('connection reset reading body'));
              }
            }
          }), {headers});
        };
        try {
          const result = await check({NTFY_TOPIC:'test-only'}, fetcher);
          return Response.json({result, gets, posts, payload});
        } catch (error) {
          return Response.json({error:error.message, gets, posts});
        }
      }};
    `,
  }));
  try {
    const recovered = await (await mf.dispatchFetch('https://test/recover')).json();
    assert.deepEqual(recovered.result, {found:false, notified:true});
    assert.equal(recovered.gets, 3);
    assert.equal(recovered.posts, 1);
    assert.equal(recovered.payload.title, 'フリーレン掲載なし', 'failed attempts must not leak a positive match');
    const timedOut = await (await mf.dispatchFetch('https://test/signal-timeout')).json();
    assert.deepEqual(timedOut.result, {found:false, notified:true});
    assert.equal(timedOut.gets, 2, 'the GET timeout signal must cover body consumption');
    assert.equal(timedOut.posts, 1);
    for (const mode of ['exhaust', 'timeout']) {
      const result = await (await mf.dispatchFetch('https://test/' + mode)).json();
      assert.deepEqual(result, {error:'Source request failed', gets:3, posts:0});
    }
    for (const mode of ['missing', 'empty']) {
      const result = await (await mf.dispatchFetch('https://test/' + mode)).json();
      assert.match(result.error, /Source content missing/);
      assert.equal(result.gets, 1);
      assert.equal(result.posts, 0);
    }
  } finally { await mf.dispose(); }
});
