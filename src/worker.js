const SOURCE = 'https://websunday.net/sunday/next/';
const TARGET = 'フリーレン';
const CONTAINER_CLASS = 'content__main';
const MAX_SOURCE_BYTES = 512 * 1024;

class SourceReadError extends Error {}
class SourceSizeError extends Error {}
class SourceFormatError extends Error {}

// Source-specific tokenizer for observed HTML structures. A global expression locates
// markup tokens while text between them is scanned using native string operations.
// This is not a complete HTML5 parser; known unsupported constructs fail closed.

// Next markup token: a start/end tag (groups 1-3) or `<!`, `<?`, `</` (group 4).
// A `<` followed by anything else is text, so the search skips it natively.
// Quotes only open after `=`, so `<a b"c>` has no quoted value. Every non-`>`
// character starts an attribute token.
const MARKUP_RE = /<(?:(\/?)([a-zA-Z][^\t\n\f\r />]*)((?:[\t\n\f\r /]+|[^\t\n\f\r />][^\t\n\f\r />=]*(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"]*"|'[^']*'|[^\t\n\f\r >]*))?)*)(?:>|$)|([!?/]))/g;
const ATTR_RE = /([^\t\n\f\r />][^\t\n\f\r />=]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r >]*)))?/g;
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Elements whose content is text until the matching end tag (RAWTEXT, RCDATA, script data).
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const rawTextEndCache = new Map();
const ENTITY_RE = /&#(x[0-9a-f]+|[0-9]+);/gi;
const CHARSET_RE = /charset\s*=\s*"?([^\s";]+)/i;

function decodeNumericEntities(text) {
  return text.replace(ENTITY_RE, (entity, value) => {
    const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function untilGreaterThan(html, from) {
  const gt = html.indexOf('>', from);
  return gt < 0 ? html.length : gt + 1;
}

// `<!--` comment: `<!-->` and `<!--->` close immediately, otherwise `-->` or `--!>`.
function commentEnd(html, from) {
  if (html.startsWith('>', from)) return from + 1;
  if (html.startsWith('->', from)) return from + 2;
  const a = html.indexOf('-->', from), b = html.indexOf('--!>', from);
  if (a < 0 && b < 0) return html.length;
  return a < 0 || (b >= 0 && b < a) ? b + 4 : a + 3;
}

// Raw text ends at `</name` followed by whitespace, `/` or `>` (any case).
function rawTextEnd(html, name, from) {
  let re = rawTextEndCache.get(name);
  if (!re) rawTextEndCache.set(name, re = new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi'));
  re.lastIndex = from;
  return re.exec(html)?.index ?? html.length;
}

function hasContainerClass(attrs) {
  ATTR_RE.lastIndex = 0;
  let attr;
  while ((attr = ATTR_RE.exec(attrs))) {
    // Duplicate attributes are dropped, so the first class attribute wins.
    if (attr[1].toLowerCase() !== 'class') continue;
    return (attr[2] ?? attr[3] ?? attr[4] ?? '').split(/[\t\n\f\r ]+/).includes(CONTAINER_CLASS);
  }
  return false;
}

function isSelfClosing(attrs) {
  if (!attrs.endsWith('/')) return false;
  ATTR_RE.lastIndex = 0;
  let attr;
  while ((attr = ATTR_RE.exec(attrs))) {
    // A slash inside an unquoted value is not a self-closing flag.
    if (attr.index + attr[0].length === attrs.length) return false;
  }
  return true;
}

export function findTarget(html) {
  // Open-element stack as HTMLRewriter tracks it: an end tag pops up to the
  // nearest same-name element and is ignored when none is open.
  const stack = [];
  const parts = [];
  let container = -1; // stack index of the open container, -1 when outside
  let foreign = 0; // open <svg>/<math>, where `/>` self-closes and raw text does not apply
  let seen = false, textStart = 0, token;

  MARKUP_RE.lastIndex = 0;
  while ((token = MARKUP_RE.exec(html))) {
    const lt = token.index;
    if (container >= 0 && lt > textStart) parts.push(html.slice(textStart, lt));
    if (token[4]) {
      if (foreign > 0 && html.startsWith('<![CDATA[', lt)) {
        throw new SourceFormatError('Unsupported foreign CDATA');
      }
      // `<!--` comment; `<!`, `<?` and `</` + non-letter are bogus comments up to `>`.
      const end = html.startsWith('<!--', lt) ? commentEnd(html, lt + 4) : untilGreaterThan(html, lt + 2);
      MARKUP_RE.lastIndex = textStart = end;
      continue;
    }
    const tag = token;
    const end = textStart = MARKUP_RE.lastIndex;
    if (end === html.length && !html.endsWith('>')) break; // EOF inside a tag drops the tag

    const name = tag[2].toLowerCase();
    if (tag[1]) {
      const index = stack.lastIndexOf(name);
      if (index < 0) continue;
      for (let i = index; i < stack.length; i++) if (stack[i] === 'svg' || stack[i] === 'math') foreign--;
      stack.length = index;
      if (container >= index) container = -1;
      continue;
    }

    if (foreign > 0 && ['foreignobject', 'desc', 'title', 'annotation-xml', 'mi', 'mo', 'mn', 'ms', 'mtext'].includes(name)) {
      throw new SourceFormatError('Unsupported foreign HTML integration point');
    }
    if (name === 'script') {
      const close = rawTextEnd(html, name, end);
      const escape = html.indexOf('<!--', end);
      if (escape >= 0 && escape < close) {
        throw new SourceFormatError('Unsupported script escape syntax');
      }
    }
    if (VOID_ELEMENTS.has(name) || ((foreign > 0 || name === 'svg' || name === 'math') && isSelfClosing(tag[3]))) continue;
    stack.push(name);
    if (name === 'svg' || name === 'math') foreign++;
    if (container < 0 && name === 'div' && tag[3].includes(CONTAINER_CLASS) && hasContainerClass(tag[3])) {
      container = stack.length - 1;
      seen = true;
    }
    if (foreign > 0) continue;
    if (name === 'plaintext') {
      if (container >= 0) parts.push(html.slice(end));
      textStart = html.length;
      break;
    }
    if (RAW_TEXT_ELEMENTS.has(name)) {
      // Raw text is text to HTMLRewriter too; its end tag is handled next iteration.
      const close = rawTextEnd(html, name, end);
      if (container >= 0) parts.push(html.slice(end, close));
      MARKUP_RE.lastIndex = textStart = close;
    }
  }
  if (container >= 0) parts.push(html.slice(textStart));

  const text = parts.join('');
  if (!seen || !text.trim()) throw new Error('Source content missing; refusing to report absence');
  return text.includes(TARGET) || (text.includes('&#') && decodeNumericEntities(text).includes(TARGET));
}

// Count bytes actually read from the decoded fetch body; never trust Content-Length.
// A fixed buffer keeps retained source bytes bounded even for misleading headers.
export async function readBoundedBody(response) {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const buffer = new Uint8Array(MAX_SOURCE_BYTES);
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_SOURCE_BYTES - size) {
        await reader.cancel().catch(() => {});
        throw new SourceSizeError('Source exceeds 512 KiB');
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
  } catch (error) {
    if (error instanceof SourceSizeError) throw error;
    throw new SourceReadError('Source body read failed');
  } finally {
    reader.releaseLock();
  }
  return buffer.subarray(0, size);
}

export async function detect(response) {
  const bytes = await readBoundedBody(response);
  const charset = CHARSET_RE.exec(response.headers.get('content-type') || '')?.[1] || 'utf-8';
  let html;
  try {
    html = new TextDecoder(charset).decode(bytes);
  } catch {
    // Unsupported charset: refuse rather than scan mis-decoded text.
    throw new Error('Unsupported source charset');
  }
  // Content validation is deterministic and must not trigger another GET.
  return findTarget(html);
}

export function notification(found, topic) {
  return {
    topic,
    title: found ? 'フリーレン掲載あり' : 'フリーレン掲載なし',
    message: found ? '次号のサンデーにフリーレンが掲載されます！' : '次号のサンデーにフリーレンの掲載はありません',
    priority: found ? 4 : 3,
    tags: [found ? 'sparkles' : 'eyes'],
  };
}

export async function check(env, fetcher = fetch, parser = detect) {
  if (!env.NTFY_TOPIC || !/^[A-Za-z0-9_-]+$/.test(env.NTFY_TOPIC)) {
    throw new Error('NTFY_TOPIC is missing or invalid');
  }
  let found;
  // Retry only source GETs. Retrying an ambiguous publish could duplicate notifications.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let response;
      try {
        response = await fetcher(SOURCE, { signal: AbortSignal.timeout(15000) });
      } catch {
        throw new SourceReadError('Source connection failed');
      }
      if (!response.ok) {
        const status = response.status;
        // Cleanup must not mask the HTTP status if the body has already failed.
        await response.body?.cancel().catch(() => {});
        if (status === 429 || status >= 500) throw new SourceReadError(`Source HTTP ${status}`);
        throw new Error('Source request failed');
      }
      if (!response.headers.get('content-type')?.includes('text/html')) {
        await response.body?.cancel();
        throw new Error('Source did not return HTML');
      }
      // Complete the streamed read inside the retry, with a fresh detector per attempt.
      found = await parser(response);
      break;
    } catch (error) {
      if (!(error instanceof SourceReadError)) throw error;
      if (attempt === 2) throw new Error('Source request failed');
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  let published;
  try {
    published = await fetcher('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notification(found, env.NTFY_TOPIC)),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Notification request failed');
  }
  if (!published.ok) {
    const status = published.status;
    await published.body?.cancel();
    throw new Error(`Notification HTTP ${status}`);
  }
  await published.body?.cancel();
  // Never log the topic or the ntfy response (both may contain the secret).
  console.log(JSON.stringify({ event: 'check_completed', found }));
  return { found, notified: true };
}

export default {
  async scheduled(_event, env) {
    await check(env); // Throw on error so Cloudflare records a failed invocation.
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/run') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!env.RUN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.RUN_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    try {
      return Response.json(await check(env));
    } catch {
      console.error('Manual check failed; inspect source availability and secret settings');
      return Response.json({ error: 'Check failed' }, { status: 502 });
    }
  },
};
