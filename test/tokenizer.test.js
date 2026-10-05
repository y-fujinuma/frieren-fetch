import test from 'node:test';
import assert from 'node:assert/strict';
import {findTarget, detect, check} from '../src/worker.js';

const cap=512*1024;
const env={NTFY_TOPIC:'test-only'};
const response=(body,headers={})=>new Response(body,{headers:{'Content-Type':'text/html; charset=UTF-8',...headers}});
const fixtures=[
  ['Japanese','<div class="content__main">フリーレン</div>',true],
  ['inline','<div class="content__main">フリ<span>ーレン</span></div>',true],
  ['decimal entities','<div class="content__main">&#12501;&#12522;&#12540;&#12524;&#12531;</div>',true],
  ['hex entities','<div class="content__main">&#x30d5;&#x30ea;&#x30fc;&#x30ec;&#x30f3;</div>',true],
  ['outside target','<nav>フリーレン</nav><div class="content__main">別作品</div>',false],
  ['comment fake container','<!-- <div class="content__main">フリーレン</div> --><div class="content__main">別作品</div>',false],
  ['script fake container',"<script>const s='<div class=\"content__main\">フリーレン</div>';</script><div class=\"content__main\">別作品</div>",false],
  ['quoted attribute keyword','<div class="content__main" data-note=">フリーレン">別作品</div>',false],
  ['quoted closing div','<div class="content__main"><span title="</div>">フリーレン</span></div>',true],
  ['textarea fake container','<textarea><div class="content__main">フリーレン</div></textarea><div class="content__main">別作品</div>',false],
  ['duplicate class','<div class="other" class="content__main">フリーレン</div><div class="content__main">別作品</div>',false],
  ['uppercase','<DIV CLASS="content__main">フリーレン</DIV>',true],
  ['literal less-than','<div class="content__main">1 < 3 フリーレン</div>',true],
  ['multiple target scopes','<div class="content__main">フリ</div><div class="content__main">ーレン</div>',true],
  ['unclosed div as in HTMLRewriter','<div class="content__main">フリーレン',true],
];
for(const[label,body,found]of fixtures){
  test(label+' preserves target semantics',()=>assert.equal(findTarget(body),found));
}

const failures=[
  ['missing target','<div>フリーレン</div>'],
  ['empty target','<div class="content__main"> </div>'],
  ['fake class attribute',"<div data-note=' class=\"content__main\"'>フリーレン</div>"],
  ['script escaped state','<script><!--<script></script><div class="content__main">フリーレン</div></script><div class="content__main">別作品</div>'],
  ['script escape after positive match','<div class="content__main">フリーレン</div><script><!-- legacy script --></script>'],
  ['SVG CDATA','<div class="content__main">フリーレン</div><svg><![CDATA[<div>text</div>]]></svg>'],
  ['MathML CDATA','<math><![CDATA[text]]></math><div class="content__main">別作品</div>'],
];
for(const[label,body]of failures){
  test(label+' fails closed without retry or publication',async()=>{
    let gets=0;
    await assert.rejects(check(env,async(_url,options)=>{
      assert.notEqual(options.method,'POST');gets++;return response(body);
    }));
    assert.equal(gets,1);
  });
}
test('markers in ordinary comments or quoted attributes are not rejected',()=>{
  assert.equal(findTarget('<!-- <script><!-- --> <div class="content__main" data-x="<![CDATA[">フリーレン</div>'),true);
});
test('byte-split UTF-8 and entity boundaries survive full body read',async()=>{
  const bytes=new TextEncoder().encode('<div class="content__main">フリ<span>&#12540;</span>レン</div>');
  let offset=0;
  const body=new ReadableStream({pull(controller){
    if(offset===bytes.length)return controller.close();
    controller.enqueue(bytes.slice(offset,++offset));
  }});
  assert.equal(await detect(response(body)),true);
});
test('preserves Shift_JIS charset',async()=>{
  const prefix=new TextEncoder().encode('<div class="content__main">');
  const suffix=new TextEncoder().encode('</div>');
  const keyword=new Uint8Array([131,116,131,138,129,91,131,140,131,147]);
  const bytes=new Uint8Array(prefix.length+keyword.length+suffix.length);
  bytes.set(prefix);bytes.set(keyword,prefix.length);bytes.set(suffix,prefix.length+keyword.length);
  assert.equal(await detect(response(bytes,{'Content-Type':'text/html; charset=Shift_JIS'})),true);
});
test('unsupported charset is deterministic and cannot publish',async()=>{
  let gets=0;
  await assert.rejects(check(env,async(_url,options)=>{
    assert.notEqual(options.method,'POST');gets++;return response('other',{'Content-Type':'text/html; charset=unsupported-charset'});
  }),/Unsupported source charset/);
  assert.equal(gets,1);
});
const valid='<div class="content__main">他作品</div>';
for(const declared of [undefined,'1','9999999']){
  const headers=declared===undefined?{}:{'Content-Length':declared};
  test('accepts exact512KiB with Content-Length '+declared,async()=>{
    assert.equal(await detect(response(valid+' '.repeat(cap-Buffer.byteLength(valid)),headers)),false);
  });
  test('over512KiB cancels and neither retries nor publishes, Content-Length '+declared,async()=>{
    let gets=0,cancelled=0;
    await assert.rejects(check(env,async(_url,options)=>{
      assert.notEqual(options.method,'POST');gets++;
      return response(new ReadableStream({start(controller){
        controller.enqueue(new TextEncoder().encode('<div class="content__main">フリーレン</div>'));
        controller.enqueue(new Uint8Array(cap));
      },cancel(){cancelled++;}}),headers);
    }),/Source exceeds 512 KiB/);
    assert.equal(gets,1);assert.equal(cancelled,1);
  });
}
test('counts actual multibyte bytes instead of string characters',async()=>{
  const body='<div class="content__main">'+'日'.repeat(Math.ceil(cap/3))+'</div>';
  assert.ok(body.length<cap);
  await assert.rejects(detect(response(body)),/Source exceeds 512 KiB/);
});
for(const recover of[true,false]){
  test('positive prefix then body interruption '+(recover?'recovers with fresh result':'exhausts without publication'),async(t)=>{
    t.mock.method(globalThis,'setTimeout',callback=>callback());
    let gets=0,posts=0,payload;
    const run=check(env,async(_url,options)=>{
      if(options.method==='POST'){posts++;payload=JSON.parse(options.body);return new Response('{}');}
      gets++;
      if(recover&&gets===3)return response(valid);
      let sent=false;
      return response(new ReadableStream({pull(controller){
        if(!sent){sent=true;controller.enqueue(new TextEncoder().encode('<div class="content__main">フリーレン'));return;}
        controller.error(new TypeError('body connection reset'));
      }}));
    });
    if(recover){assert.deepEqual(await run,{found:false,notified:true});assert.equal(payload.title,'フリーレン掲載なし');}
    else await assert.rejects(run,/Source request failed/);
    assert.equal(gets,3);assert.equal(posts,recover?1:0);
  });
}
test('a deterministic parser error after a transient GET is not retried or published',async(t)=>{
  t.mock.method(globalThis,'setTimeout',callback=>callback());
  let gets=0;
  await assert.rejects(check(env,async(_url,options)=>{
    assert.notEqual(options.method,'POST');
    if(++gets===1)throw new TypeError('temporary network failure');
    return response('<div>missing target</div>');
  }),/Source content missing/);
  assert.equal(gets,2);
});

for (const prefix of ['<svg/>','<math/>','<svg data-x="x"/>']) {
  test('self-closing foreign root cannot bypass script guard: '+prefix,async()=>{
    let calls=0;
    await assert.rejects(check(env,async(_url,options)=>{
      assert.notEqual(options.method,'POST');calls++;
      return response(prefix+'<div class="content__main">フリーレン</div><script><!-- legacy --></script>');
    }),/Unsupported script escape syntax/);
    assert.equal(calls,1);
  });
}
for(const foreign of ['<svg><foreignObject>','<math><annotation-xml>','<math><mtext>']) {
  test('foreign HTML integration point fails closed: '+foreign,async()=>{
    let calls=0;
    await assert.rejects(check(env,async(_url,options)=>{
      assert.notEqual(options.method,'POST');calls++;
      return response('<div class="content__main">フリーレン</div>'+foreign+'<script>"<div class=content__main>フリーレン</div>"</script>');
    }),/Unsupported foreign HTML integration point/);
    assert.equal(calls,1);
  });
}
test('slash in unquoted foreign attribute is not a self-close and cannot bypass CDATA guard',()=>{
  assert.throws(()=>findTarget('<svg data-x=value/><![CDATA[text]]></svg><div class="content__main">フリーレン</div>'),/Unsupported foreign CDATA/);
});
