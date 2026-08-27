'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const WebSocket = require('ws');
const { GameService } = require('../server/game-service');

class Store {
  constructor() { this.records = []; }
  upsert(record) { this.records.push(record); }
}
class Socket extends EventEmitter {
  constructor() { super(); this.readyState = WebSocket.OPEN; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
  latest(type) { return [...this.sent].reverse().find((item) => item.type === type); }
}
function connect(service, session) {
  const socket = new Socket();
  service.attachSocket(socket, { socket: { remoteAddress: 'clock-test' } });
  service.authenticateSocket(socket, { token: session.token });
  socket.sent = [];
  return socket;
}

test('deducts server time, applies increment, and ends on timeout', () => {
  let time = 0;
  const service = new GameService({ store: new Store(), now: () => time });
  const whiteSession = service.createSession();
  const blackSession = service.createSession();
  const white = connect(service, whiteSession);
  const black = connect(service, blackSession);
  service.handlePacket(white, { type: 'room:create', settings: { timeControl: '1+0', color: 'white' } });
  const code = white.latest('room:created').room.roomCode;
  service.handlePacket(black, { type: 'room:join', roomCode: code });
  const initial = white.latest('game:state').state;
  time = 2500;
  service.handlePacket(white, { type: 'game:move', gameId: initial.gameId, moveId: 'clock-move', from: 'e2', to: 'e4', clientRevision: 0 });
  const afterMove = black.latest('game:state').state;
  assert.equal(afterMove.clock.activeColor, 'BLACK');
  assert.equal(afterMove.clock.whiteRemaining, 57500);
  assert.equal(afterMove.clock.blackRemaining, 60000);

  time = 62501;
  service.tick();
  const end = black.latest('game:end').state;
  assert.equal(end.result, 'WHITE_WINS');
  assert.equal(end.resultReason, 'TIMEOUT');
  assert.equal(end.clock.blackRemaining, 0);
});
