// Kronos ML Auth Server — Replit
// Roda em https://kronos-ml-auth.SEU-USUARIO.repl.co

const http = require('http');
const https = require('https');
const url = require('url');

const APP_ID     = '6521968317073769';
const APP_SECRET = 'EDiRnSC3fjRg2KabqeV8qdFIzXDFuitm';
const KRONOS_URL = 'https://stellar-chebakia-dfcb81.netlify.app';

// A redirect_uri registrada no ML deve ser a URL deste servidor + /callback
// Ex: https://kronos-ml-auth.SEU-USUARIO.repl.co/callback
// Atualize esta variável com a URL do seu Replit:
const SERVER_URL = process.env.REPL_URL || 'https://kronos-ml-auth.onrender.com';
const REDIRECT_URI = SERVER_URL + '/callback';

function postToML(params) {
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
      res.on('data', chunk => data += chunk);
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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // ── GET /callback — ML redireciona aqui com ?code= ──────────────
  if (path === '/callback') {
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
      const result = await postToML({
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

  // ── POST /refresh — Kronos pede novo token ──────────────────────
  if (path === '/refresh' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { refresh_token } = JSON.parse(body);
        if (!refresh_token) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'refresh_token obrigatorio' })); return;
        }
        const result = await postToML({
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

  // ── GET / — health check ────────────────────────────────────────
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Kronos ML Auth Server — OK\nRedirect URI: ' + REDIRECT_URI);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Kronos ML Auth Server rodando na porta', PORT);
  console.log('Redirect URI para o ML:', REDIRECT_URI);
});
