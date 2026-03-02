import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

function getRelayBaseUrl() {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '');
}

function getRelayHeaders(baseHeaders = {}) {
  const headers = { ...baseHeaders };
  const relaySecret = process.env.RELAY_SHARED_SECRET || '';
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
    headers.Authorization = `Bearer ${relaySecret}`;
  }
  return headers;
}

async function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Direct OpenSky Network API fallback (no relay needed)
async function fetchFromOpenSkyDirect(searchParams, corsHeaders) {
  const lamin = searchParams.get('lamin');
  const lamax = searchParams.get('lamax');
  const lomin = searchParams.get('lomin');
  const lomax = searchParams.get('lomax');

  const params = new URLSearchParams();
  if (lamin) params.set('lamin', lamin);
  if (lamax) params.set('lamax', lamax);
  if (lomin) params.set('lomin', lomin);
  if (lomax) params.set('lomax', lomax);

  const openSkyUrl = `https://opensky-network.org/api/states/all?${params.toString()}`;

  // Use OpenSky credentials if available for higher rate limits
  const headers = { Accept: 'application/json' };
  const username = process.env.OPENSKY_USERNAME || '';
  const password = process.env.OPENSKY_PASSWORD || '';
  if (username && password) {
    headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`;
  }

  const response = await fetchWithTimeout(openSkyUrl, { headers }, 15000);

  if (!response.ok) {
    return new Response(JSON.stringify({
      error: 'OpenSky API error',
      status: response.status,
    }), {
      status: response.status === 429 ? 429 : 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const body = await response.text();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=10',
      'X-Source': 'opensky-direct',
      ...corsHeaders,
    },
  });
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const requestUrl = new URL(req.url);

  // Try relay first if configured
  const relayBaseUrl = getRelayBaseUrl();
  if (relayBaseUrl) {
    try {
      const relayUrl = `${relayBaseUrl}/opensky${requestUrl.search || ''}`;
      const response = await fetchWithTimeout(relayUrl, {
        headers: getRelayHeaders({ Accept: 'application/json' }),
      });

      const body = await response.text();
      const headers = {
        'Content-Type': response.headers.get('content-type') || 'application/json',
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60',
        ...corsHeaders,
      };
      const xCache = response.headers.get('x-cache');
      if (xCache) headers['X-Cache'] = xCache;

      return new Response(body, {
        status: response.status,
        headers,
      });
    } catch (error) {
      // Relay failed, fall through to direct OpenSky
      console.warn('Relay failed, falling back to direct OpenSky:', error?.message);
    }
  }

  // Fallback: call OpenSky Network API directly
  try {
    return await fetchFromOpenSkyDirect(requestUrl.searchParams, corsHeaders);
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return new Response(JSON.stringify({
      error: isTimeout ? 'OpenSky timeout' : 'OpenSky request failed',
      details: error?.message || String(error),
    }), {
      status: isTimeout ? 504 : 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
