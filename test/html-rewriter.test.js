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
