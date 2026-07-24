let proxyAgent = null;

async function getProxyAgent() {
  if (proxyAgent) return proxyAgent;
  const { ProxyAgent } = await import('undici').catch(() => ({ ProxyAgent: null }));
  if (!ProxyAgent) return null;
  const proxyUrl = process.env.BRIGHTDATA_PROXY_URL;
  if (proxyUrl) {
    proxyAgent = new ProxyAgent(proxyUrl);
    return proxyAgent;
  }
  const user = process.env.BRIGHT_DATA_USERID;
  const pass = process.env.BRIGHT_DATA_TOKEN;
  if (user && pass) {
    proxyAgent = new ProxyAgent(`http://${user}:${pass}@brd.superproxy.io:33335`);
    return proxyAgent;
  }
  return null;
}

export function reuseProxyAgent() {
  return proxyAgent;
}

export function resetProxyAgent() {
  proxyAgent = null;
}

export async function fetchWithProxyFallback(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    const bodyText = await res.text().catch(() => '');
    console.warn(`[proxy] 429 on ${url} — retrying via Bright Data proxy`);
    return await proxyFetch(url, options);
  } catch (e) {
    console.warn(`[proxy] direct error on ${url}: ${e.message} — retrying via proxy`);
    return await proxyFetch(url, options);
  }
}

export async function proxyFetch(url, options = {}) {
  const agent = await getProxyAgent();
  if (!agent) {
    throw new Error(
      'Bright Data proxy not configured: set BRIGHT_DATA_USERID + BRIGHT_DATA_TOKEN (or BRIGHTDATA_PROXY_URL)',
    );
  }
  try {
    const { fetch: undiciFetch } = await import('undici');
    return await undiciFetch(url, { ...options, dispatcher: agent });
  } catch (e) {
    throw new Error(`Bright Data proxy: ${e.cause?.message || e.message}`);
  }
}
