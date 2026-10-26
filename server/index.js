import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { config, rootDir } from './core/config.js';
import { db } from './core/db.js';
import { attachUser, csrfGuard } from './auth/sessions.js';
import { authRouter } from './auth/routes.js';
import { pairingRouter } from './auth/pairing.js';
import { apiRouter } from './routes/api.js';
import { runner } from './services/runner.js';

const app = express();
if (config.trustProxy) app.set('trust proxy', config.trustProxyHops);
if (config.trustProxy && !config.publicUrl) {
  console.warn('[security] TRUST_PROXY is enabled without PUBLIC_URL; set PUBLIC_URL to pin OAuth/pairing URLs.');
}

app.disable('x-powered-by');

// Security headers (CSP allows self + inline style vars + data/blob images)
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  // Only advertise HSTS when the deployment is actually HTTPS (SECURE_COOKIES=1).
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https: http:; connect-src 'self' https: http:; font-src 'self'; " +
      "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  }
  next();
});

app.use(express.json({ limit: '2mb' }));

// Brotli/gzip for text responses (SSE must never be buffered).
app.use(compression({
  threshold: 1024,
  filter(req, res) {
    if (req.path === '/api/stream') return false;
    return compression.filter(req, res);
  },
}));

app.use(attachUser);

// static uploads (background images)
app.use('/uploads', express.static(config.uploadsDir, { maxAge: '1h', fallthrough: true }));

// API
app.use('/api', csrfGuard);
app.use('/api', authRouter);
app.use('/api/pair', pairingRouter);
app.use('/api', apiRouter);

// static frontend
const publicDir = path.join(rootDir, 'public');
app.use(express.static(publicDir, {
  index: 'index.html',
  etag: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    // Bundled service icons never change under the same filename — cache them hard.
    if (filePath.includes(`${path.sep}icons${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA fallback for client-side routes
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

// error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err?.status || err?.statusCode || 500;
  if (status >= 500) {
    console.error('[server]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
  res.status(status).json({ error: err?.message || 'Request failed' });
});

runner.reload();
runner.startHeartbeat();

const server = app.listen(config.port, config.host, () => {
  console.log(`HomeDeck listening on http://${config.host}:${config.port}`);
});

// Graceful shutdown: close SSE clients, stop accepting connections, close SQLite.
function shutdown(signal) {
  console.log(`[server] ${signal} received — shutting down`);
  for (const res of runner.clients) { try { res.end(); } catch { /* ignore */ } }
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
