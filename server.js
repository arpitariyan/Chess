'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { GameService } = require('./server/game-service');
const { JsonGameStore } = require('./server/persistence');

const ROOT = path.resolve(__dirname);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function jsonResponse(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function requestToken(request) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function safeStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch (error) {
    return null;
  }
  if (decoded === '/') decoded = '/index.html';
  if (decoded.includes('..') || decoded.includes('\\') || decoded.startsWith('/server')) return null;
  const fullPath = path.resolve(ROOT, `.${decoded}`);
  if (fullPath !== ROOT && !fullPath.startsWith(`${ROOT}${path.sep}`)) return null;
  return fullPath;
}

function serveStatic(request, response) {
  const filePath = safeStaticPath(request.url || '/');
  if (!filePath) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

function createApplication(options) {
  const config = options || {};
  const store = config.store || new JsonGameStore(config.historyPath || path.join(ROOT, 'data', 'games.json'));
  const service = config.service || new GameService(Object.assign({}, config, { store }));
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (requestUrl.pathname === '/health') {
      jsonResponse(response, 200, {
        ok: true,
        service: 'chess',
        activeRooms: Array.from(service.rooms.values()).filter((room) => ['WAITING', 'READY', 'PLAYING'].includes(room.status)).length,
        activeGames: Array.from(service.games.values()).filter((game) => game.status === 'PLAYING').length,
        connectedPlayers: Array.from(service.sessions.values()).filter((session) => session.sockets.size > 0).length,
        metrics: service.metrics
      });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/session') {
      const ip = request.socket.remoteAddress || 'unknown';
      if (!service.checkRateLimit(`http-session:${ip}`, 30, 60 * 1000)) {
        jsonResponse(response, 429, { code: 'RATE_LIMITED', message: 'Too many session requests. Please wait a moment.' });
        return;
      }
      const session = service.createSession();
      jsonResponse(response, 200, session);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/history') {
      const session = service.resolveSession(requestToken(request));
      if (!session) {
        jsonResponse(response, 401, { code: 'UNAUTHORIZED', message: 'An online session is required.' });
        return;
      }
      jsonResponse(response, 200, { games: service.historyForUser(session.userId) });
      return;
    }
    const historyMatch = request.method === 'GET' && requestUrl.pathname.match(/^\/api\/history\/([^/]+)$/);
    if (historyMatch) {
      const session = service.resolveSession(requestToken(request));
      if (!session) {
        jsonResponse(response, 401, { code: 'UNAUTHORIZED', message: 'An online session is required.' });
        return;
      }
      const game = service.historyRecordForUser(historyMatch[1], session.userId);
      if (!game) {
        jsonResponse(response, 404, { code: 'GAME_NOT_FOUND', message: 'Game history could not be found.' });
        return;
      }
      jsonResponse(response, 200, game);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      jsonResponse(response, 404, { code: 'NOT_FOUND', message: 'Not found.' });
      return;
    }
    serveStatic(request, response);
  });

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  websocketServer.on('connection', (socket, request) => service.attachSocket(socket, request));
  server.on('upgrade', (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    } catch (error) {
      socket.destroy();
      return;
    }
    if (requestUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      websocketServer.emit('connection', client, request);
    });
  });

  service.start();
  return {
    server,
    service,
    websocketServer,
    close(callback) {
      service.stop();
      websocketServer.close();
      server.close(callback);
    }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const application = createApplication();
  application.server.listen(port, host, () => {
    console.log(`Chess server listening on http://${host}:${port}`);
    console.log('Realtime endpoint: /ws');
  });
  const shutdown = () => application.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = { createApplication };
