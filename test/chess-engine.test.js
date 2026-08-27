'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ChessEngine = require('../shared/chess-engine');

function play(engine, moves) {
  moves.forEach(([from, to, promotion]) => {
    const result = engine.makeMove({ from, to, promotion });
    assert.equal(result.ok, true, `${from}-${to} should be legal: ${result.message || ''}`);
  });
}

test('starts with the standard position and legal move count', () => {
  const engine = new ChessEngine();
  assert.equal(engine.fen(), ChessEngine.START_FEN);
  assert.equal(engine.getLegalMoves().length, 20);
});

test('supports castling and records SAN notation', () => {
  const engine = new ChessEngine();
  play(engine, [
    ['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'],
    ['f1', 'b5'], ['a7', 'a6'], ['b5', 'a4'], ['g8', 'f6'], ['e1', 'g1']
  ]);
  assert.equal(engine.getPiece('g1'), 'K');
  assert.equal(engine.getPiece('f1'), 'R');
  assert.equal(engine.moveHistory.at(-1).san, 'O-O');
  assert.equal(engine.castling.includes('K'), false);
});

test('supports en passant', () => {
  const engine = new ChessEngine();
  play(engine, [['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']]);
  assert.equal(engine.isLegalMove({ from: 'e5', to: 'd6' }), true);
  const result = engine.makeMove({ from: 'e5', to: 'd6' });
  assert.equal(result.san, 'exd6');
  assert.equal(engine.getPiece('d5'), null);
  assert.equal(engine.getPiece('d6'), 'P');
});

test('requires and applies promotion', () => {
  const engine = new ChessEngine('7k/P7/8/8/8/8/8/6K1 w - - 0 1');
  assert.equal(engine.isLegalMove({ from: 'a7', to: 'a8' }), false);
  assert.equal(engine.validateMove({ from: 'a7', to: 'a8' }).code, 'PROMOTION_REQUIRED');
  assert.equal(engine.makeMove({ from: 'a7', to: 'a8', promotion: 'q' }).ok, true);
  assert.equal(engine.getPiece('a8'), 'Q');
});

test('rejects moves that leave the king in check and detects checkmate', () => {
  const engine = new ChessEngine();
  play(engine, [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]);
  assert.equal(engine.isCheckmate(), true);
  assert.deepEqual(engine.getGameResult(), { finished: true, result: 'BLACK_WINS', reason: 'CHECKMATE' });
});

test('detects stalemate and insufficient material', () => {
  const stalemate = new ChessEngine('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(stalemate.isStalemate(), true);
  assert.equal(stalemate.getGameResult().reason, 'STALEMATE');

  const insufficient = new ChessEngine('7k/8/8/8/8/8/6B1/6K1 w - - 0 1');
  assert.equal(insufficient.getGameResult().reason, 'INSUFFICIENT_MATERIAL');
});
