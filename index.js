const http = require('http');
const https = require('https');
const url = require('url');

const APP_ID      = '6521968317073769';
const APP_SECRET  = 'EDiRnSC3fjRg2KabqeV8qdFIzXDFuitm';
const KRONOS_URL  = 'https://stellar-chebakia-dfcb81.netlify.app';
const SERVER_URL  = 'https://kronos-ml-auth.onrender.com';
const REDIRECT_URI = SERVER_URL + '/callback';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function mlPost(params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const options = {
      hostname: 'api.mercadolibre.com',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Proxy GET request to ML API
function mlProxyGet(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.mercadolibre.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;

  // CORS headers on every response
  Object.entries(corsHeaders()).forEach(([k,v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // ── GET / — health check ────────────────────────────────────────
  if (path === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Kronos ML Auth Server — OK\nRedirect URI: ' + REDIRECT_URI);
    return;
  }

  // ── GET /callback — OAuth callback from ML ──────────────────────
  if (path === '/callback' && req.method === 'GET') {
    const code  = parsed.query.code;
    const state = parsed.query.state || '';
    const error = parsed.query.error;

    if (error) {
      res.writeHead(302, { Location: KRONOS_URL + '/#ml_error=' + encodeURIComponent(error) });
      res.end(); return;
    }
    if (!code) {
      res.writeHead(302, { Location: KRONOS_URL + '/#ml_error=no_code' });
      res.end(); return;
    }

    try {
      const result = await mlPost({
        grant_type:    'authorization_code',
        client_id:     APP_ID,
        client_secret: APP_SECRET,
        code,
        redirect_uri:  REDIRECT_URI,
      });
      const data = result.body;
      if (!data.access_token) {
        const msg = encodeURIComponent(data.message || data.error || 'token_error');
        res.writeHead(302, { Location: KRONOS_URL + '/#ml_error=' + msg });
        res.end(); return;
      }
      const hash = 'ml_access_token='  + encodeURIComponent(data.access_token)
        + '&ml_refresh_token=' + encodeURIComponent(data.refresh_token || '')
        + '&ml_expires_in='   + (data.expires_in || 21600)
        + '&ml_user_id='      + (data.user_id || '')
        + '&ml_state='        + encodeURIComponent(state);
      res.writeHead(302, { Location: KRONOS_URL + '/#' + hash });
      res.end();
    } catch(e) {
      res.writeHead(302, { Location: KRONOS_URL + '/#ml_error=' + encodeURIComponent(e.message) });
      res.end();
    }
    return;
  }

  // ── POST /refresh — refresh token ───────────────────────────────
  if (path === '/refresh' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { refresh_token } = JSON.parse(body);
        if (!refresh_token) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'refresh_token obrigatorio' })); return;
        }
        const result = await mlPost({
          grant_type:    'refresh_token',
          client_id:     APP_ID,
          client_secret: APP_SECRET,
          refresh_token,
        });
        const data = result.body;
        if (!data.access_token) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.message || 'refresh_failed' })); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token:  data.access_token,
          refresh_token: data.refresh_token,
          expires_in:    data.expires_in || 21600,
        }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /api/* — proxy para ML API ──────────────────────────────
  // Ex: /api/users/me → api.mercadolibre.com/users/me
  // Ex: /api/orders/search?... → api.mercadolibre.com/orders/search?...
  if (path.startsWith('/api/') && req.method === 'GET') {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token nao informado' })); return;
    }
    // Rebuild path with query string
    const mlPath = '/' + path.slice(5) + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
    try {
      const result = await mlProxyGet(mlPath, token);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Kronos ML Auth Server porta', PORT);
  console.log('Redirect URI:', REDIRECT_URI);
});
