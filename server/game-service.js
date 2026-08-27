'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const ChessEngine = require('../shared/chess-engine');

const WAITING_ROOM_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROOM_CODE_MIN = 100000;
const ROOM_CODE_MAX = 999999;

const TIME_CONTROLS = Object.freeze({
  none: { label: 'No clock', initialMs: null, incrementMs: 0 },
  '1+0': { label: '1 + 0', initialMs: 60 * 1000, incrementMs: 0 },
  '3+0': { label: '3 + 0', initialMs: 3 * 60 * 1000, incrementMs: 0 },
  '3+2': { label: '3 + 2', initialMs: 3 * 60 * 1000, incrementMs: 2 * 1000 },
  '5+0': { label: '5 + 0', initialMs: 5 * 60 * 1000, incrementMs: 0 },
  '5+3': { label: '5 + 3', initialMs: 5 * 60 * 1000, incrementMs: 3 * 1000 },
  '10+0': { label: '10 + 0', initialMs: 10 * 60 * 1000, incrementMs: 0 },
  '10+5': { label: '10 + 5', initialMs: 10 * 60 * 1000, incrementMs: 5 * 1000 },
  '15+10': { label: '15 + 10', initialMs: 15 * 60 * 1000, incrementMs: 10 * 1000 },
  '30+0': { label: '30 + 0', initialMs: 30 * 60 * 1000, incrementMs: 0 }
});

const ERROR_MESSAGES = Object.freeze({
  INVALID_ROOM_CODE: 'Enter the six-digit room code.',
  ROOM_NOT_FOUND: 'That room could not be found.',
  ROOM_EXPIRED: 'That room has expired. Create a new room to play.',
  ROOM_FULL: 'That room already has two players.',
  GAME_ALREADY_STARTED: 'That game has already started.',
  UNAUTHORIZED: 'Your online session is no longer valid. Please reconnect.',
  FORBIDDEN: 'You do not have permission to do that.',
  GAME_NOT_FOUND: 'That game is no longer available.',
  GAME_FINISHED: 'This game has already finished.',
  NOT_YOUR_TURN: 'It is not your turn.',
  INVALID_MOVE: 'That move is not legal.',
  PROMOTION_REQUIRED: 'Choose a piece for promotion.',
  DUPLICATE_MOVE: 'That move was already submitted.',
  STATE_OUT_OF_SYNC: 'Your board was out of date. It has been synchronized.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
  DRAW_ALREADY_OFFERED: 'You already have a draw offer pending.',
  NO_DRAW_OFFER: 'There is no draw offer to respond to.',
  REMATCH_NOT_AVAILABLE: 'A rematch is available after the game ends.',
  INVALID_ACTION: 'That action is not available right now.'
});

function nowIso(timestamp) {
  return new Date(timestamp).toISOString();
}

function safeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeColor(value) {
  if (value === 'black' || value === 'BLACK') return 'BLACK';
  if (value === 'random' || value === 'RANDOM') return 'RANDOM';
  return 'WHITE';
}

function normalizeSettings(input) {
  const settings = input && typeof input === 'object' ? input : {};
  const requestedTime = typeof settings.timeControl === 'string' ? settings.timeControl : '10+5';
  const timeControl = TIME_CONTROLS[requestedTime] ? requestedTime : '10+5';
  return {
    gameType: 'CASUAL',
    timeControl,
    color: settings.color == null ? 'RANDOM' : normalizeColor(settings.color),
    allowSpectators: false,
    allowChat: false
  };
}

function publicColor(color) {
  return color === 'w' || color === 'WHITE' ? 'WHITE' : 'BLACK';
}

function engineColor(color) {
  return color === 'WHITE' || color === 'w' ? 'w' : 'b';
}

function otherColor(color) {
  return color === 'WHITE' ? 'BLACK' : 'WHITE';
}

function resultForWinner(color) {
  return color === 'WHITE' ? 'WHITE_WINS' : 'BLACK_WINS';
}

function resultReasonLabel(reason) {
  return String(reason || '').replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

class GameService {
  constructor(options) {
    const config = options || {};
    this.store = config.store;
    this.now = config.now || (() => Date.now());
    this.waitingRoomMs = config.waitingRoomMs || WAITING_ROOM_MS;
    this.sessionTtlMs = config.sessionTtlMs || SESSION_TTL_MS;
    this.rooms = new Map();
    this.roomsByCode = new Map();
    this.games = new Map();
    this.sessions = new Map();
    this.rateBuckets = new Map();
    this.metrics = {
      roomsCreated: 0,
      roomsJoined: 0,
      joinFailures: 0,
      movesAccepted: 0,
      movesRejected: 0,
      reconnects: 0,
      socketFailures: 0
    };
    this.tickTimer = null;
  }

  start() {
    if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick(), 250);
    return this;
  }

  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  createSession() {
    const token = crypto.randomBytes(32).toString('base64url');
    const userId = safeId('user');
    this.sessions.set(token, {
      token,
      userId,
      createdAt: this.now(),
      lastSeenAt: this.now(),
      sockets: new Set()
    });
    return { token, userId };
  }

  resolveSession(token) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 200) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (this.now() - session.lastSeenAt > this.sessionTtlMs) {
      this.sessions.delete(token);
      return null;
    }
    session.lastSeenAt = this.now();
    return session;
  }

  checkRateLimit(key, limit, windowMs) {
    const timestamp = this.now();
    const bucket = this.rateBuckets.get(key) || { startedAt: timestamp, count: 0 };
    if (timestamp - bucket.startedAt >= windowMs) {
      bucket.startedAt = timestamp;
      bucket.count = 0;
    }
    bucket.count += 1;
    this.rateBuckets.set(key, bucket);
    return bucket.count <= limit;
  }

  attachSocket(socket, request) {
    socket._connectionId = safeId('connection');
    socket._authenticated = false;
    socket._session = null;
    socket._ip = request && request.socket && request.socket.remoteAddress ? request.socket.remoteAddress : 'unknown';
    socket._memberships = new Set();
    socket._authTimer = setTimeout(() => {
      if (!socket._authenticated && typeof socket.close === 'function') socket.close(4001, 'authentication required');
    }, 10000);

    socket.on('message', (raw) => {
      try {
        if (raw.length > 16 * 1024) {
          this.sendError(socket, 'INVALID_ACTION', 'That request is too large.');
          return;
        }
        const packet = JSON.parse(raw.toString());
        this.handlePacket(socket, packet);
      } catch (error) {
        this.sendError(socket, 'INVALID_ACTION', 'We could not understand that request.');
      }
    });

    socket.on('close', () => this.detachSocket(socket));
    socket.on('error', () => { this.metrics.socketFailures += 1; });
  }

  handlePacket(socket, packet) {
    if (!packet || typeof packet !== 'object' || typeof packet.type !== 'string') {
      this.sendError(socket, 'INVALID_ACTION', 'A realtime event type is required.');
      return;
    }
    if (packet.type === 'auth') {
      this.authenticateSocket(socket, packet);
      return;
    }
    if (!socket._authenticated) {
      this.sendError(socket, 'UNAUTHORIZED', ERROR_MESSAGES.UNAUTHORIZED, packet.requestId);
      return;
    }

    const actionKey = `${socket._session.userId}:${packet.type}`;
    const limit = packet.type === 'room:join' ? 12 : packet.type === 'game:move' ? 120 : 60;
    if (!this.checkRateLimit(actionKey, limit, 60 * 1000) ||
        (packet.type === 'room:join' && !this.checkRateLimit(`ip:${socket._ip}:room:join`, 30, 60 * 1000))) {
      this.sendError(socket, 'RATE_LIMITED', ERROR_MESSAGES.RATE_LIMITED, packet.requestId);
      return;
    }

    switch (packet.type) {
      case 'room:create': return this.createRoom(socket, packet);
      case 'room:join': return this.joinRoom(socket, packet);
      case 'room:cancel': return this.cancelRoom(socket, packet);
      case 'room:sync': return this.syncRoom(socket, packet);
      case 'game:move': return this.submitMove(socket, packet);
      case 'game:sync': return this.syncGame(socket, packet);
      case 'game:resign': return this.resign(socket, packet);
      case 'game:draw:offer': return this.offerDraw(socket, packet);
      case 'game:draw:respond': return this.respondToDraw(socket, packet);
      case 'game:rematch': return this.rematch(socket, packet);
      default:
        this.sendError(socket, 'INVALID_ACTION', 'That realtime action is not supported.', packet.requestId);
    }
  }

  authenticateSocket(socket, packet) {
    if (socket._authenticated) {
      this.send(socket, 'session:authenticated', { userId: socket._session.userId }, packet.requestId);
      return;
    }
    const session = this.resolveSession(packet.token);
    if (!session) {
      this.sendError(socket, 'UNAUTHORIZED', ERROR_MESSAGES.UNAUTHORIZED, packet.requestId);
      return;
    }
    socket._authenticated = true;
    clearTimeout(socket._authTimer);
    socket._session = session;
    session.sockets.add(socket);
    this.send(socket, 'session:authenticated', { userId: session.userId }, packet.requestId);

    // A reconnect uses the same server-issued session token. Re-registering
    // the socket and sending a complete snapshot makes missed events harmless.
    let resumed = false;
    for (const room of this.rooms.values()) {
      const player = this.playerForUser(room, session.userId);
      if (!player) continue;
      resumed = true;
      player.connections.add(socket);
      player.connectionId = socket._connectionId;
      player.connected = true;
      player.lastSeenAt = this.now();
      socket._memberships.add(room.roomId);
      if (room.status === 'WAITING') this.send(socket, 'room:state', { room: this.roomSnapshot(room, session.userId) });
      if (room.gameId) {
        const game = this.games.get(room.gameId);
        if (game && game.status === 'PLAYING') {
          this.send(socket, 'player:reconnected', { gameId: game.gameId, color: player.color });
          this.send(socket, 'game:sync', { state: this.gameSnapshot(game, session.userId) });
          this.broadcastPresence(game, player.color, true, socket);
        } else if (game) {
          this.send(socket, 'game:sync', { state: this.gameSnapshot(game, session.userId) });
        }
      }
    }
    if (resumed) this.metrics.reconnects += 1;
  }

  detachSocket(socket) {
    clearTimeout(socket._authTimer);
    if (!socket._session) return;
    socket._session.sockets.delete(socket);
    for (const room of this.rooms.values()) {
      const player = this.playerForUser(room, socket._session.userId);
      if (!player) continue;
      player.connections.delete(socket);
      if (player.connections.size === 0) {
        player.connectionId = null;
        player.connected = false;
        player.lastSeenAt = this.now();
        if (room.gameId) {
          const game = this.games.get(room.gameId);
          if (game && game.status === 'PLAYING') {
            this.broadcastPresence(game, player.color, false);
            this.sendGameStates(game);
          }
        }
      }
    }
  }

  newRoomCode() {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const code = String(crypto.randomInt(ROOM_CODE_MIN, ROOM_CODE_MAX + 1));
      const existing = this.roomsByCode.get(code);
      if (!existing || !['WAITING', 'READY', 'PLAYING'].includes(existing.status)) return code;
    }
    throw new Error('Unable to allocate a room code');
  }

  createRoom(socket, packet) {
    const settings = normalizeSettings(packet.settings);
    let color = settings.color;
    if (color === 'RANDOM') color = crypto.randomInt(0, 2) === 0 ? 'WHITE' : 'BLACK';
    const roomId = safeId('room');
    const roomCode = this.newRoomCode();
    const timestamp = this.now();
    const creator = this.makePlayer(socket._session.userId, color, timestamp);
    const room = {
      roomId,
      roomCode,
      status: 'WAITING',
      ownerUserId: socket._session.userId,
      settings,
      createdAt: timestamp,
      expiresAt: timestamp + this.waitingRoomMs,
      updatedAt: timestamp,
      players: { white: null, black: null },
      gameId: null
    };
    room.players[color.toLowerCase()] = creator;
    this.rooms.set(roomId, room);
    this.roomsByCode.set(roomCode, room);
    creator.connections.add(socket);
    creator.connectionId = socket._connectionId;
    creator.connected = true;
    creator.lastSeenAt = this.now();
    socket._memberships.add(roomId);
    this.metrics.roomsCreated += 1;
    this.send(socket, 'room:created', { room: this.roomSnapshot(room, socket._session.userId) }, packet.requestId);
  }

  joinRoom(socket, packet) {
    const rawCode = packet.roomCode == null ? packet.code : packet.roomCode;
    const roomCode = String(rawCode == null ? '' : rawCode).replace(/\s/g, '');
    if (!/^\d{6}$/.test(roomCode)) {
      this.metrics.joinFailures += 1;
      this.sendError(socket, 'INVALID_ROOM_CODE', ERROR_MESSAGES.INVALID_ROOM_CODE, packet.requestId);
      return;
    }
    const room = this.roomsByCode.get(roomCode);
    if (!room) {
      this.metrics.joinFailures += 1;
      this.sendError(socket, 'ROOM_NOT_FOUND', ERROR_MESSAGES.ROOM_NOT_FOUND, packet.requestId);
      return;
    }
    if (room.status === 'EXPIRED') {
      this.metrics.joinFailures += 1;
      this.sendError(socket, 'ROOM_EXPIRED', ERROR_MESSAGES.ROOM_EXPIRED, packet.requestId);
      return;
    }
    if (room.status === 'CANCELLED' || room.status === 'CLOSED') {
      this.metrics.joinFailures += 1;
      this.sendError(socket, 'ROOM_NOT_FOUND', ERROR_MESSAGES.ROOM_NOT_FOUND, packet.requestId);
      return;
    }
    if (room.status !== 'WAITING') {
      this.metrics.joinFailures += 1;
      const code = room.status === 'PLAYING' ? 'GAME_ALREADY_STARTED' : 'ROOM_FULL';
      this.sendError(socket, code, ERROR_MESSAGES[code], packet.requestId);
      return;
    }
    if (this.playerForUser(room, socket._session.userId)) {
      this.metrics.joinFailures += 1;
      this.sendError(socket, 'ROOM_FULL', 'You are already a player in this room.', packet.requestId);
      return;
    }

    const existingColor = room.players.white ? 'WHITE' : 'BLACK';
    const joinColor = otherColor(existingColor);
    const player = this.makePlayer(socket._session.userId, joinColor, this.now());
    room.players[joinColor.toLowerCase()] = player;
    room.status = 'READY';
    room.expiresAt = null;
    room.updatedAt = this.now();
    player.connections.add(socket);
    player.connectionId = socket._connectionId;
    player.connected = true;
    player.lastSeenAt = this.now();
    socket._memberships.add(room.roomId);
    const game = this.createGame(room);
    room.status = 'PLAYING';
    this.metrics.roomsJoined += 1;

    this.send(socket, 'room:joined', { room: this.roomSnapshot(room, socket._session.userId) }, packet.requestId);
    this.broadcastRoom(room, 'room:ready', { room: this.roomSnapshot(room) });
    this.broadcastGame(game, 'game:start');
    this.sendGameStates(game);
  }

  makePlayer(userId, color, timestamp) {
    return {
      userId,
      color,
      joinedAt: timestamp,
      lastSeenAt: timestamp,
      connectionId: null,
      connected: false,
      connections: new Set()
    };
  }

  createGame(room) {
    const timestamp = this.now();
    const time = TIME_CONTROLS[room.settings.timeControl];
    const game = {
      gameId: safeId('game'),
      roomId: room.roomId,
      status: 'PLAYING',
      whitePlayerId: room.players.white.userId,
      blackPlayerId: room.players.black.userId,
      engine: new ChessEngine(),
      moveHistory: [],
      processedMoves: new Map(),
      revision: 0,
      result: null,
      resultReason: null,
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: null,
      lastMoveAt: null,
      drawOffer: null,
      rematch: new Set(),
      lastAcceptedMove: null,
      lastClockBroadcastAt: 0,
      clock: {
        enabled: time.initialMs !== null,
        whiteRemaining: time.initialMs,
        blackRemaining: time.initialMs,
        increment: time.incrementMs,
        activeColor: 'w',
        lastTurnTimestamp: timestamp
      },
      room
    };
    room.gameId = game.gameId;
    this.games.set(game.gameId, game);
    this.persistGame(game);
    return game;
  }

  playerForUser(room, userId) {
    if (!room || !userId) return null;
    return [room.players.white, room.players.black].find((player) => player && player.userId === userId) || null;
  }

  playerForGame(game, userId) {
    if (!game || !userId) return null;
    if (game.whitePlayerId === userId) return game.room.players.white;
    if (game.blackPlayerId === userId) return game.room.players.black;
    return null;
  }

  cancelRoom(socket, packet) {
    const room = this.roomFromPacket(socket, packet);
    if (!room) return;
    if (room.status !== 'WAITING') {
      this.sendError(socket, 'GAME_ALREADY_STARTED', ERROR_MESSAGES.GAME_ALREADY_STARTED, packet.requestId);
      return;
    }
    if (room.ownerUserId !== socket._session.userId) {
      this.sendError(socket, 'FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, packet.requestId);
      return;
    }
    room.status = 'CANCELLED';
    room.updatedAt = this.now();
    this.broadcastRoom(room, 'room:cancelled', { roomCode: room.roomCode });
    this.cleanupRoomMemberships(room);
  }

  roomFromPacket(socket, packet) {
    const roomId = typeof packet.roomId === 'string' ? packet.roomId : null;
    const room = roomId ? this.rooms.get(roomId) : this.roomsByCode.get(String(packet.roomCode || '').replace(/\s/g, ''));
    if (!room || !this.playerForUser(room, socket._session.userId)) {
      this.sendError(socket, 'FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, packet.requestId);
      return null;
    }
    return room;
  }

  syncRoom(socket, packet) {
    const room = this.roomFromPacket(socket, packet);
    if (!room) return;
    this.send(socket, 'room:state', { room: this.roomSnapshot(room, socket._session.userId) }, packet.requestId);
  }

  submitMove(socket, packet) {
    const game = this.gameForPacket(socket, packet);
    if (!game) return;
    const requestId = packet.requestId;
    const moveId = typeof packet.moveId === 'string' ? packet.moveId.trim() : '';
    if (!moveId || moveId.length > 100) {
      this.sendError(socket, 'INVALID_MOVE', ERROR_MESSAGES.INVALID_MOVE, requestId);
      return;
    }
    const signature = JSON.stringify({
      from: packet.from,
      to: packet.to,
      promotion: packet.promotion || null
    });
    const duplicate = game.processedMoves.get(moveId);
    if (duplicate) {
      if (duplicate.signature !== signature) {
        this.sendError(socket, 'DUPLICATE_MOVE', ERROR_MESSAGES.DUPLICATE_MOVE, requestId);
      } else {
        this.send(socket, 'game:move:accepted', {
          gameId: game.gameId,
          move: duplicate.move,
          revision: duplicate.revision,
          state: this.gameSnapshot(game, socket._session.userId),
          replayed: true
        }, requestId);
      }
      return;
    }
    if (game.status !== 'PLAYING') {
      this.sendError(socket, 'GAME_FINISHED', ERROR_MESSAGES.GAME_FINISHED, requestId, { state: this.gameSnapshot(game, socket._session.userId) });
      return;
    }
    const player = this.playerForGame(game, socket._session.userId);
    if (!player) {
      this.sendError(socket, 'FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, requestId);
      return;
    }

    const timestamp = this.now();
    if (this.clockExpired(game, timestamp)) return;
    if (game.engine.turn !== engineColor(player.color)) {
      this.metrics.movesRejected += 1;
      this.sendError(socket, 'NOT_YOUR_TURN', ERROR_MESSAGES.NOT_YOUR_TURN, requestId, { state: this.gameSnapshot(game, socket._session.userId) });
      return;
    }
    const clientRevision = Number(packet.clientRevision);
    if (!Number.isInteger(clientRevision) || clientRevision !== game.revision) {
      this.metrics.movesRejected += 1;
      this.sendError(socket, 'STATE_OUT_OF_SYNC', ERROR_MESSAGES.STATE_OUT_OF_SYNC, requestId, {
        revision: game.revision,
        state: this.gameSnapshot(game, socket._session.userId)
      });
      return;
    }

    const validation = game.engine.validateMove({ from: packet.from, to: packet.to, promotion: packet.promotion });
    if (!validation.ok) {
      this.metrics.movesRejected += 1;
      const code = validation.code === 'PROMOTION_REQUIRED' ? 'PROMOTION_REQUIRED' : 'INVALID_MOVE';
      this.sendError(socket, code, validation.message || ERROR_MESSAGES[code], requestId, { state: this.gameSnapshot(game, socket._session.userId) });
      return;
    }

    // The JavaScript event loop processes this handler synchronously. The
    // revision check above plus the single engine transition makes simultaneous
    // requests atomic from the point of view of both players.
    const activeColor = game.engine.turn;
    if (game.clock.enabled) {
      game.clock[activeColor === 'w' ? 'whiteRemaining' : 'blackRemaining'] = this.remainingFor(game, activeColor, timestamp);
    }
    const engineResult = game.engine.makeMove(validation.move);
    if (!engineResult.ok) {
      this.metrics.movesRejected += 1;
      this.sendError(socket, 'INVALID_MOVE', engineResult.message || ERROR_MESSAGES.INVALID_MOVE, requestId);
      return;
    }
    if (game.clock.enabled) {
      const clockKey = activeColor === 'w' ? 'whiteRemaining' : 'blackRemaining';
      game.clock[clockKey] = Math.max(0, game.clock[clockKey] + game.clock.increment);
      game.clock.activeColor = game.engine.turn;
      game.clock.lastTurnTimestamp = timestamp;
    }
    // Playing a move is an implicit decline of an opponent's pending offer.
    if (game.drawOffer && game.drawOffer !== socket._session.userId) game.drawOffer = null;
    game.revision += 1;
    game.lastMoveAt = timestamp;
    const moveRecord = {
      moveId,
      number: engineResult.san ? Math.ceil((game.moveHistory.length + 1) / 2) : game.moveHistory.length + 1,
      color: publicColor(activeColor),
      from: engineResult.move.from,
      to: engineResult.move.to,
      promotion: engineResult.move.promotion || null,
      san: engineResult.san,
      fen: engineResult.fen,
      playedAt: nowIso(timestamp)
    };
    game.moveHistory.push(moveRecord);
    game.lastAcceptedMove = moveRecord;
    game.processedMoves.set(moveId, { signature, move: moveRecord, revision: game.revision });
    this.metrics.movesAccepted += 1;

    if (engineResult.result && engineResult.result.finished) {
      this.finishGame(game, engineResult.result.result, engineResult.result.reason, timestamp, false);
    } else {
      this.persistGame(game);
    }
    this.broadcastGame(game, 'game:move:accepted', (viewerId) => ({
      gameId: game.gameId,
      move: moveRecord,
      revision: game.revision,
      state: this.gameSnapshot(game, viewerId)
    }));
    this.sendGameStates(game);
    if (game.status === 'FINISHED') this.broadcastGame(game, 'game:end', (viewerId) => ({ state: this.gameSnapshot(game, viewerId) }));
  }

  gameForPacket(socket, packet) {
    const gameId = typeof packet.gameId === 'string' ? packet.gameId : '';
    const game = this.games.get(gameId);
    if (!game || !this.playerForGame(game, socket._session.userId)) {
      this.sendError(socket, 'FORBIDDEN', ERROR_MESSAGES.FORBIDDEN, packet.requestId);
      return null;
    }
    return game;
  }

  syncGame(socket, packet) {
    const game = this.gameForPacket(socket, packet);
    if (!game) return;
    this.send(socket, 'game:sync', { state: this.gameSnapshot(game, socket._session.userId) }, packet.requestId);
  }

  resign(socket, packet) {
    const game = this.gameForPacket(socket, packet);
    if (!game) return;
    if (game.status !== 'PLAYING') {
      this.sendError(socket, 'GAME_FINISHED', ERROR_MESSAGES.GAME_FINISHED, packet.requestId);
      return;
    }
    const player = this.playerForGame(game, socket._session.userId);
    this.finishGame(game, resultForWinner(otherColor(player.color)), 'RESIGNATION', this.now(), true);
  }

  offerDraw(socket, packet) {
    const game = this.gameForPacket(socket, packet);
    if (!game) return;
    if (game.status !== 'PLAYING') {
      this.sendError(socket, 'GAME_FINISHED', ERROR_MESSAGES.GAME_FINISHED, packet.requestId);
      return;
    }
    if (game.drawOffer) {
      this.sendError(socket, 'DRAW_ALREADY_OFFERED', ERROR_MESSAGES.DRAW_ALREADY_OFFERED, packet.requestId);
      return;
    }
    game.drawOffer = socket._session.userId;
    this.broadcastGame(game, 'game:draw:offered', (viewerId) => ({
      gameId: game.gameId,
      from: viewerId === game.drawOffer ? 'YOU' : 'OPPONENT',
      state: this.gameSnapshot(game, viewerId)
    }));
    this.sendGameStates(game);
  }

  respondToDraw(socket, packet) {
    const game = this.gameForPacket(socket, packet);
    if (!game) return;
    if (game.status !== 'PLAYING') {
      this.sendError(socket, 'GAME_FINISHED', ERROR_MESSAGES.GAME_FINISHED, packet.requestId);
      return;
    }
    if (!game.drawOffer || game.drawOffer === socket._session.userId) {
      this.sendError(socket, 'NO_DRAW_OFFER', ERROR_MESSAGES.NO_DRAW_OFFER, packet.requestId);
      return;
    }
    const accepted = packet.accept === true;
    if (accepted) {
      game.drawOffer = null;
      this.finishGame(game, 'DRAW', 'DRAW_AGREEMENT', this.now(), true);
    } else {
      game.drawOffer = null;
      this.broadcastGame(game, 'game:draw:declined', (viewerId) => ({ state: this.gameSnapshot(game, viewerId) }));
      this.sendGameStates(game);
    }
  }

  rematch(socket, packet) {
    const game = this.gameForPacket(socket, packet);
    if (!game) return;
    if (game.status !== 'FINISHED') {
      this.sendError(socket, 'REMATCH_NOT_AVAILABLE', ERROR_MESSAGES.REMATCH_NOT_AVAILABLE, packet.requestId);
      return;
    }
    const action = packet.action === 'decline' ? 'decline' : 'accept';
    if (action === 'decline') {
      game.rematch.clear();
      this.broadcastGame(game, 'game:rematch:declined', (viewerId) => ({ state: this.gameSnapshot(game, viewerId) }));
      return;
    }
    game.rematch.add(socket._session.userId);
    if (game.rematch.size < 2) {
      this.broadcastGame(game, 'game:rematch:pending', (viewerId) => ({
        acceptedByYou: game.rematch.has(viewerId),
        acceptedByOpponent: game.rematch.has(this.opponentId(game, viewerId)),
        state: this.gameSnapshot(game, viewerId)
      }));
      return;
    }
    const room = game.room;
    // Reuse the room and swap colors deterministically. The old game remains
    // immutable in history while the new game gets a fresh internal id.
    const previousWhite = room.players.white;
    room.players.white = room.players.black;
    room.players.black = previousWhite;
    room.players.white.color = 'WHITE';
    room.players.black.color = 'BLACK';
    room.status = 'PLAYING';
    room.updatedAt = this.now();
    const nextGame = this.createGame(room);
    game.rematch.clear();
    this.broadcastGame(game, 'game:rematch:started', { gameId: nextGame.gameId });
    this.broadcastGame(nextGame, 'game:start');
    this.sendGameStates(nextGame);
  }

  opponentId(game, userId) {
    return game.whitePlayerId === userId ? game.blackPlayerId : game.whitePlayerId;
  }

  finishGame(game, result, reason, timestamp, broadcastImmediately) {
    if (!game || game.status === 'FINISHED') return;
    if (game.clock.enabled) {
      const active = game.engine.turn;
      game.clock[active === 'w' ? 'whiteRemaining' : 'blackRemaining'] = this.remainingFor(game, active, timestamp);
      if (reason === 'TIMEOUT') game.clock[active === 'w' ? 'whiteRemaining' : 'blackRemaining'] = 0;
      game.clock.lastTurnTimestamp = timestamp;
    }
    game.status = 'FINISHED';
    game.result = result;
    game.resultReason = reason;
    game.finishedAt = timestamp;
    game.drawOffer = null;
    game.room.status = 'FINISHED';
    game.room.updatedAt = timestamp;
    this.persistGame(game);
    if (broadcastImmediately) {
      this.broadcastGame(game, 'game:end', (viewerId) => ({ state: this.gameSnapshot(game, viewerId) }));
      this.sendGameStates(game);
    }
  }

  clockExpired(game, timestamp) {
    if (!game.clock.enabled || game.status !== 'PLAYING') return false;
    const active = game.engine.turn;
    if (this.remainingFor(game, active, timestamp) > 0) return false;
    const winner = publicColor(active === 'w' ? 'b' : 'w');
    this.finishGame(game, resultForWinner(winner), 'TIMEOUT', timestamp, true);
    return true;
  }

  remainingFor(game, color, timestamp) {
    const key = color === 'w' ? 'whiteRemaining' : 'blackRemaining';
    if (!game.clock.enabled || game.clock.activeColor !== color || game.status !== 'PLAYING') return Math.max(0, game.clock[key]);
    return Math.max(0, game.clock[key] - Math.max(0, timestamp - game.clock.lastTurnTimestamp));
  }

  clockSnapshot(game, timestamp) {
    return {
      enabled: game.clock.enabled,
      whiteRemaining: this.remainingFor(game, 'w', timestamp),
      blackRemaining: this.remainingFor(game, 'b', timestamp),
      activeColor: publicColor(game.clock.activeColor),
      increment: game.clock.increment,
      serverTime: timestamp
    };
  }

  gameSnapshot(game, userId) {
    const timestamp = this.now();
    const player = this.playerForGame(game, userId);
    const opponent = player ? this.playerForGame(game, this.opponentId(game, userId)) : null;
    return {
      gameId: game.gameId,
      roomId: game.roomId,
      status: game.status,
      yourColor: player ? player.color : null,
      currentTurn: publicColor(game.engine.turn),
      fen: game.engine.fen(),
      moveHistory: game.moveHistory.map((move) => Object.assign({}, move)),
      moveNumber: game.moveHistory.length + 1,
      revision: game.revision,
      clock: this.clockSnapshot(game, timestamp),
      players: {
        you: player ? { color: player.color, connected: player.connected } : null,
        opponent: opponent ? { color: opponent.color, connected: opponent.connected } : null
      },
      result: game.result,
      resultReason: game.resultReason,
      resultReasonLabel: game.resultReason ? resultReasonLabel(game.resultReason) : null,
      lastMove: game.lastAcceptedMove ? Object.assign({}, game.lastAcceptedMove) : null,
      drawOffer: game.drawOffer ? (game.drawOffer === userId ? 'SENT' : 'RECEIVED') : null,
      rematch: {
        acceptedByYou: game.rematch.has(userId),
        acceptedByOpponent: game.rematch.has(this.opponentId(game, userId))
      },
      createdAt: nowIso(game.createdAt),
      startedAt: nowIso(game.startedAt),
      finishedAt: game.finishedAt ? nowIso(game.finishedAt) : null
    };
  }

  roomSnapshot(room, userId) {
    const player = userId ? this.playerForUser(room, userId) : null;
    const opponent = userId && player ? [room.players.white, room.players.black].find((candidate) => candidate && candidate.userId !== userId) : null;
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      status: room.status,
      expiresAt: room.expiresAt ? nowIso(room.expiresAt) : null,
      createdAt: nowIso(room.createdAt),
      settings: Object.assign({}, room.settings, { timeControlLabel: TIME_CONTROLS[room.settings.timeControl].label }),
      yourColor: player ? player.color : null,
      playerCount: [room.players.white, room.players.black].filter(Boolean).length,
      players: {
        you: player ? { color: player.color, connected: player.connected } : null,
        opponent: opponent ? { color: opponent.color, connected: opponent.connected } : null
      },
      gameId: room.gameId
    };
  }

  persistGame(game) {
    if (!this.store) return;
    this.store.upsert({
      gameId: game.gameId,
      roomId: game.roomId,
      whitePlayerId: game.whitePlayerId,
      blackPlayerId: game.blackPlayerId,
      status: game.status,
      timeControl: game.room.settings.timeControl,
      timeControlLabel: TIME_CONTROLS[game.room.settings.timeControl].label,
      moves: game.moveHistory.map((move) => Object.assign({}, move)),
      result: game.result,
      resultReason: game.resultReason,
      initialFen: ChessEngine.START_FEN,
      finalFen: game.engine.fen(),
      revision: game.revision,
      createdAt: nowIso(game.createdAt),
      startedAt: nowIso(game.startedAt),
      finishedAt: game.finishedAt ? nowIso(game.finishedAt) : null,
      updatedAt: nowIso(this.now())
    });
  }

  historyForUser(userId) {
    if (!this.store) return [];
    return this.store.findForUser(userId).map((record) => this.publicHistoryRecord(record, userId));
  }

  historyRecordForUser(gameId, userId) {
    if (!this.store) return null;
    const record = this.store.findByIdForUser(gameId, userId);
    return record ? this.publicHistoryRecord(record, userId) : null;
  }

  publicHistoryRecord(record, userId) {
    return {
      gameId: record.gameId,
      status: record.status,
      yourColor: record.whitePlayerId === userId ? 'WHITE' : 'BLACK',
      opponentColor: record.whitePlayerId === userId ? 'BLACK' : 'WHITE',
      timeControl: record.timeControl,
      timeControlLabel: record.timeControlLabel,
      moves: Array.isArray(record.moves) ? record.moves : [],
      result: record.result,
      resultReason: record.resultReason,
      resultReasonLabel: record.resultReason ? resultReasonLabel(record.resultReason) : null,
      initialFen: record.initialFen,
      finalFen: record.finalFen,
      revision: record.revision,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt
    };
  }

  tick() {
    const timestamp = this.now();
    for (const room of this.rooms.values()) {
      if (room.status === 'WAITING' && room.expiresAt && timestamp >= room.expiresAt) {
        room.status = 'EXPIRED';
        room.updatedAt = timestamp;
        this.broadcastRoom(room, 'room:expired', { roomCode: room.roomCode });
        this.cleanupRoomMemberships(room);
      }
    }
    for (const game of this.games.values()) {
      if (game.status !== 'PLAYING') continue;
      if (this.clockExpired(game, timestamp)) continue;
      if (game.clock.enabled && timestamp - game.lastClockBroadcastAt >= 1000) {
        game.lastClockBroadcastAt = timestamp;
        this.sendGameStates(game);
      }
    }
    for (const [token, session] of this.sessions.entries()) {
      if (timestamp - session.lastSeenAt > this.sessionTtlMs) this.sessions.delete(token);
    }
  }

  sendGameStates(game) {
    this.sendPlayer(game.room.players.white, 'game:state', { state: this.gameSnapshot(game, game.whitePlayerId) });
    this.sendPlayer(game.room.players.black, 'game:state', { state: this.gameSnapshot(game, game.blackPlayerId) });
  }

  sendPlayer(player, type, payload) {
    if (!player) return;
    for (const socket of player.connections) this.send(socket, type, payload);
  }

  broadcastPresence(game, color, connected, excludedSocket) {
    this.broadcastGame(game, connected ? 'player:reconnected' : 'player:disconnected', (viewerId) => ({
      gameId: game.gameId,
      color,
      connected,
      state: this.gameSnapshot(game, viewerId)
    }), excludedSocket);
  }

  broadcastGame(game, type, payload, excludedSocket) {
    const sockets = new Set();
    [game.room.players.white, game.room.players.black].forEach((player) => {
      if (!player) return;
      player.connections.forEach((socket) => sockets.add(socket));
    });
    sockets.forEach((socket) => {
      if (socket === excludedSocket) return;
      const data = typeof payload === 'function' ? payload(socket._session.userId) : (payload || {});
      this.send(socket, type, data);
    });
  }

  broadcastRoom(room, type, payload) {
    [room.players.white, room.players.black].forEach((player) => {
      if (!player) return;
      player.connections.forEach((socket) => this.send(socket, type, payload));
    });
  }

  cleanupRoomMemberships(room) {
    [room.players.white, room.players.black].forEach((player) => {
      if (!player) return;
      player.connections.forEach((socket) => socket._memberships.delete(room.roomId));
      player.connections.clear();
      player.connected = false;
    });
  }

  send(socket, type, payload, requestId) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const packet = Object.assign({ type }, payload || {});
    if (requestId !== undefined) packet.requestId = requestId;
    try {
      socket.send(JSON.stringify(packet));
    } catch (error) {
      this.metrics.socketFailures += 1;
    }
  }

  sendError(socket, code, message, requestId, details) {
    this.send(socket, 'error', Object.assign({ code, message: message || ERROR_MESSAGES[code] || 'Something went wrong.' }, details || {}), requestId);
  }
}

module.exports = {
  GameService,
  TIME_CONTROLS,
  ERROR_MESSAGES,
  WAITING_ROOM_MS
};
