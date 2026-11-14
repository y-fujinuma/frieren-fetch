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

export async function check(env, fetcher = fetch, parser = detect, publishDelays = [3000, 8000]) {
  const validSecret = value => typeof value === 'string' && value.length > 0 && !/[^A-Za-z0-9_-]/.test(value);
  const useNtfy = validSecret(env.NTFY_TOPIC);
  const useBark = validSecret(env.BARK_KEY);
  if (!useNtfy && !useBark) {
    // Preserve the existing error for configurations without Bark.
    throw new Error(env.BARK_KEY ? 'BARK_KEY is invalid; NTFY_TOPIC is missing or invalid' : 'NTFY_TOPIC is missing or invalid');
  }
  let found;
  // Source retries are independent of the per-channel publish budgets.
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
  // Publish with bounded retries. Two distinct problems affect publishes
  // from Workers, both verified live:
  // - ntfy's anonymous per-IP daily quota rejects some attempts with
  //   HTTP 429 ("daily message quota reached") because Worker requests
  //   leave through Cloudflare's shared egress IPs. Setting NTFY_TOKEN
  //   (an ntfy.sh account access token) moves quota to the account.
  // - ntfy.sh silently drops some Cloudflare egress IPs (fail2ban against
  //   abuse from other Workers; see binwiederhier/ntfy issue #1832), so
  //   other attempts hang until the Workers runtime reports HTTP 522
  //   after ~19 s, or time out — while a successful publish can also be
  //   slow (~19 s), hence the generous per-attempt timeout. Bans are
  //   per-IP and rotating, so retries over minutes can land on a clean
  //   egress IP; the scheduled handler passes a longer budget.
  // A 429 means the message was not accepted, so retrying cannot
  // duplicate it. For ambiguous failures every attempt resends the same
  // X-ID, which ntfy uses to drop duplicates of an already-stored
  // message. The ID is deterministic per JST date and result, so a
  // manual run and the scheduled run on the same day cannot double-send.
  const jstDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const headers = {
    'Content-Type': 'application/json',
    'X-ID': `frieren-${jstDate}-${found ? 'found' : 'absent'}`,
  };
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  const message = notification(found, env.NTFY_TOPIC);
  const channels = {};
  let lastError;
  // Start both channels independently so an ntfy timeout cannot delay Bark.
  await Promise.all([
    ...(useNtfy ? ['ntfy'] : []),
    ...(useBark ? ['bark'] : []),
  ].map(async channel => {
    try {
      await publish(channel, env, message, headers, fetcher, publishDelays);
      channels[channel] = true;
    } catch (error) {
      channels[channel] = false;
      lastError = error;
    }
  }));
  if (!Object.values(channels).some(Boolean)) throw lastError;
  // Log only channel names/results, never keys, topics or response bodies.
  console.log(JSON.stringify({ event: 'check_completed', found, channels }));
  return { found, notified: true };
}

async function publish(channel, env, message, ntfyHeaders, fetcher, publishDelays) {
  const bark = channel === 'bark';
  const url = bark ? `https://api.day.app/${env.BARK_KEY}` : 'https://ntfy.sh/';
  const headers = bark ? { 'Content-Type': 'application/json' } : ntfyHeaders;
  const body = JSON.stringify(bark
    ? { title: message.title, body: message.message, group: 'frieren-fetch' }
    : message);
  const label = bark ? 'Bark notification' : 'Notification';
  let notificationError;
  for (let attempt = 0; attempt <= publishDelays.length; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, publishDelays[attempt - 1]));
    let published;
    try {
      published = await fetcher(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(bark ? 15000 : 30000),
      });
    } catch {
      notificationError = new Error(`${label} request failed`);
      continue;
    }
    if (bark && published.status === 200) {
      let result;
      try {
        result = await published.json();
      } catch (error) {
        notificationError = new Error('Bark notification response failed');
        // Invalid JSON is deterministic; interrupted body reads may recover.
        if (error instanceof SyntaxError) break;
        continue;
      }
      if (result?.code === 200) return;
      // Do not include the response code/message: it may contain secrets.
      notificationError = new Error('Bark notification rejected');
      break;
    }
    if (!bark && published.ok) {
      await published.body?.cancel();
      return;
    }
    const status = published.status;
    await published.body?.cancel().catch(() => {});
    notificationError = new Error(`${label} HTTP ${status}`);
    // Other 4xx responses are permanent rejections; do not retry them.
    if (status !== 429 && status < 500) break;
  }
  throw notificationError;
}

export default {
  async scheduled(_event, env) {
    // A failed invocation is recorded by Cloudflare. The publish budget is
    // longer here than for manual runs: spreading attempts over ~2 minutes
    // of delays rides out ntfy.sh's rotating per-IP egress bans.
    await check(env, fetch, detect, [5000, 10000, 20000, 40000, 60000]);
  },
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/run') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!env.RUN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.RUN_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    try {
      return Response.json(await check(env));
    } catch (error) {
      // Error messages name the failing step and status only; they never
      // contain the topic, the token, the Bark key, or a response body.
      console.error(JSON.stringify({ event: 'manual_check_failed', error: String(error && error.message || error) }));
      return Response.json({ error: 'Check failed' }, { status: 502 });
    }
  },
};
