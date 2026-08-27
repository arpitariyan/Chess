'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const WebSocket = require('ws');
const { GameService } = require('../server/game-service');

class MemoryStore {
  constructor() { this.records = []; }
  upsert(record) {
    const index = this.records.findIndex((item) => item.gameId === record.gameId);
    if (index === -1) this.records.push(record);
    else this.records[index] = record;
  }
  findForUser(userId) { return this.records.filter((record) => record.whitePlayerId === userId || record.blackPlayerId === userId); }
  findByIdForUser(gameId, userId) {
    return this.records.find((record) => record.gameId === gameId && (record.whitePlayerId === userId || record.blackPlayerId === userId)) || null;
  }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sent = [];
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  latest(type) {
    return [...this.sent].reverse().find((packet) => packet.type === type);
  }
  clear() { this.sent.length = 0; }
}

function connect(service, session, clearAfterAuth = true) {
  const socket = new FakeSocket();
  service.attachSocket(socket, { socket: { remoteAddress: 'test-client' } });
  service.authenticateSocket(socket, { token: session.token });
  if (clearAfterAuth) socket.clear();
  return socket;
}

function packet(service, socket, type, payload) {
  service.handlePacket(socket, Object.assign({ type }, payload || {}));
  return socket.latest(type);
}

test('creates a private room, starts a game, and synchronizes authoritative moves', () => {
  const store = new MemoryStore();
  const service = new GameService({ store, waitingRoomMs: 1000 });
  let clock = 1_000_000;
  service.now = () => clock;
  const sessionA = service.createSession();
  const sessionB = service.createSession();
  const a = connect(service, sessionA);
  const b = connect(service, sessionB);

  service.handlePacket(a, { type: 'room:create', requestId: 'create', settings: { timeControl: 'none', color: 'white' } });
  const created = a.latest('room:created');
  assert.match(created.room.roomCode, /^\d{6}$/);
  assert.equal(created.room.yourColor, 'WHITE');
  assert.equal(created.room.status, 'WAITING');

  service.handlePacket(b, { type: 'room:join', requestId: 'join', roomCode: created.room.roomCode });
  const stateA = a.latest('game:state').state;
  const stateB = b.latest('game:state').state;
  assert.equal(stateA.gameId, stateB.gameId);
  assert.equal(stateA.yourColor, 'WHITE');
  assert.equal(stateB.yourColor, 'BLACK');
  assert.equal(stateA.players.you.connected, true);
  assert.equal(stateA.players.opponent.connected, true);
  assert.equal(stateA.revision, 0);

  service.handlePacket(a, {
    type: 'game:move', gameId: stateA.gameId, moveId: 'move-one', from: 'e2', to: 'e4', clientRevision: 0
  });
  assert.equal(a.latest('game:move:accepted').move.san, 'e4');
  assert.equal(b.latest('game:state').state.revision, 1);
  assert.equal(b.latest('game:state').state.currentTurn, 'BLACK');

  // A retry with the same move id is replayed, never applied a second time.
  service.handlePacket(a, {
    type: 'game:move', gameId: stateA.gameId, moveId: 'move-one', from: 'e2', to: 'e4', clientRevision: 0
  });
  assert.equal(a.latest('game:move:accepted').replayed, true);
  assert.equal(b.latest('game:state').state.moveHistory.length, 1);

  // A black move with a stale revision is rejected and includes a full sync.
  service.handlePacket(b, {
    type: 'game:move', gameId: stateA.gameId, moveId: 'stale', from: 'e7', to: 'e5', clientRevision: 0
  });
  assert.equal(b.latest('error').code, 'STATE_OUT_OF_SYNC');
  assert.equal(b.latest('error').state.revision, 1);

  service.handlePacket(b, {
    type: 'game:move', gameId: stateA.gameId, moveId: 'move-two', from: 'e7', to: 'e5', clientRevision: 1
  });
  assert.equal(a.latest('game:state').state.moveHistory.length, 2);
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].moves.length, 2);
});

test('authorizes actions and restores state when a player reconnects', () => {
  const service = new GameService({ store: new MemoryStore(), waitingRoomMs: 1000 });
  const sessionA = service.createSession();
  const sessionB = service.createSession();
  const intruderSession = service.createSession();
  const a = connect(service, sessionA);
  const b = connect(service, sessionB);
  const intruder = connect(service, intruderSession);

  service.handlePacket(a, { type: 'room:create', settings: { timeControl: 'none' } });
  const code = a.latest('room:created').room.roomCode;
  service.handlePacket(b, { type: 'room:join', roomCode: code });
  const gameId = a.latest('game:state').state.gameId;

  service.handlePacket(intruder, { type: 'game:sync', gameId });
  assert.equal(intruder.latest('error').code, 'FORBIDDEN');
  service.handlePacket(intruder, { type: 'game:move', gameId, moveId: 'fake', from: 'e2', to: 'e4', clientRevision: 0 });
  assert.equal(intruder.latest('error').code, 'FORBIDDEN');

  service.detachSocket(a);
  assert.equal(b.latest('player:disconnected').connected, false);
  const reconnected = connect(service, sessionA, false);
  assert.equal(reconnected.latest('game:sync').state.gameId, gameId);
  assert.equal(reconnected.latest('game:sync').state.revision, 0);
  assert.equal(b.latest('player:reconnected').connected, true);
});

test('expires waiting rooms and supports resignation, draw, and rematch', () => {
  const store = new MemoryStore();
  let clock = 1000;
  const service = new GameService({ store, waitingRoomMs: 50, now: () => clock });
  const waitingSession = service.createSession();
  const waitingSocket = connect(service, waitingSession);
  service.handlePacket(waitingSocket, { type: 'room:create', settings: { timeControl: 'none' } });
  const room = waitingSocket.latest('room:created').room;
  clock += 51;
  service.tick();
  assert.equal(waitingSocket.latest('room:expired').roomCode, room.roomCode);
  assert.equal(service.roomsByCode.get(room.roomCode).status, 'EXPIRED');

  const aSession = service.createSession();
  const bSession = service.createSession();
  const a = connect(service, aSession);
  const b = connect(service, bSession);
  service.handlePacket(a, { type: 'room:create', settings: { timeControl: 'none', color: 'white' } });
  const code = a.latest('room:created').room.roomCode;
  service.handlePacket(b, { type: 'room:join', roomCode: code });
  const gameId = a.latest('game:state').state.gameId;

  service.handlePacket(a, { type: 'game:draw:offer', gameId });
  assert.equal(b.latest('game:draw:offered').from, 'OPPONENT');
  service.handlePacket(b, { type: 'game:draw:respond', gameId, accept: false });
  assert.equal(a.latest('game:draw:declined').type, 'game:draw:declined');

  service.handlePacket(a, { type: 'game:resign', gameId });
  assert.equal(a.latest('game:end').state.result, 'BLACK_WINS');
  assert.equal(store.records.find((record) => record.gameId === gameId).resultReason, 'RESIGNATION');

  service.handlePacket(a, { type: 'game:rematch', gameId, action: 'accept' });
  service.handlePacket(b, { type: 'game:rematch', gameId, action: 'accept' });
  const nextStateA = a.latest('game:state').state;
  const nextStateB = b.latest('game:state').state;
  assert.notEqual(nextStateA.gameId, gameId);
  assert.equal(nextStateA.yourColor, 'BLACK');
  assert.equal(nextStateB.yourColor, 'WHITE');
  assert.equal(nextStateA.revision, 0);
});
