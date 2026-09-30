const SOURCE = 'https://websunday.net/sunday/next/';
const TARGET = 'フリーレン';

// Text callbacks can split a word across network chunks or inline elements.
export function createDetector() {
  let seen = false, nonempty = false, found = false, tail = '';
  return {
    element() { seen = true; },
    text(chunk) {
      nonempty ||= chunk.text.trim().length > 0;
      const text = tail + chunk.text;
      const decoded = text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, value) => {
        const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      });
      found ||= decoded.includes(TARGET);
      // Retain enough raw text for numeric entities split across chunks.
      tail = text.slice(-128);
    },
    result() {
      if (!seen || !nonempty) throw new Error('Source content missing; refusing to report absence');
      return found;
    },
  };
}

export async function detect(response) {
  const detector = createDetector();
  const parsed = new HTMLRewriter().on('div.content__main', detector).transform(response);
  // Drain the stream without storing the complete document.
  await parsed.body.pipeTo(new WritableStream({ write() {} }));
  return detector.result();
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
  let response;
  // Retry only source GETs. Retrying an ambiguous publish could duplicate notifications.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetcher(SOURCE, { signal: AbortSignal.timeout(15000) });
      if (response.ok) break;
      const status = response.status;
      await response.body?.cancel();
      response = null;
      if (status !== 429 && status < 500) throw new Error(`Source HTTP ${status}`);
      if (attempt === 2) throw new Error(`Source HTTP ${status}`);
    } catch (error) {
      if (error.message?.startsWith('Source HTTP') || attempt === 2) {
        throw new Error('Source request failed');
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  if (!response?.ok) throw new Error('Source request failed');
  if (!response.headers.get('content-type')?.includes('text/html')) {
    await response.body?.cancel();
    throw new Error('Source did not return HTML');
  }
  const found = await parser(response);
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
