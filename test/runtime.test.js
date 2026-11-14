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

test('Workers fetch enforces decoded gzip size and never notifies on overflow', async () => {
  const {createServer} = await import('node:http');
  const {gzipSync} = await import('node:zlib');
  const cap = 512 * 1024;
  const valid = '<div class="content__main">他作品</div>';
  let html = valid + ' '.repeat(cap - Buffer.byteLength(valid));
  const server = createServer((_request, response) => {
    const compressed = gzipSync(html);
    assert.ok(compressed.byteLength < cap);
    response.writeHead(200, {'Content-Type':'text/html; charset=UTF-8',
      'Content-Encoding':'gzip', 'Content-Length':compressed.byteLength});
    response.end(compressed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port + '/';
  const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules:true, compatibilityDate:'2026-09-29',
    script:source.replace('export default {', 'const worker = {') + `
      export default {async fetch() {
        let gets=0, posts=0;
        try {
          const result=await check({NTFY_TOPIC:'test-only'},async(url,options)=>{
            if(url==='https://ntfy.sh/' && options.method==='POST'){posts++;return new Response('{}');}
            if(url!=='https://websunday.net/sunday/next/' || options.method)throw new Error('Unexpected request');
            gets++;return fetch(${JSON.stringify(origin)},options);
          });
          return Response.json({result,gets,posts});
        }catch(error){return Response.json({error:error.message,gets,posts});}
      }};
    `,
  }));
  try {
    const exact = await (await mf.dispatchFetch('https://test/')).json();
    assert.deepEqual(exact, {result:{found:false,notified:true}, gets:1, posts:1});
    html += ' ';
    const over = await (await mf.dispatchFetch('https://test/')).json();
    assert.deepEqual(over, {error:'Source exceeds 512 KiB', gets:1, posts:0});
  } finally {
    await mf.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});
