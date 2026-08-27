(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChessEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FILES = 'abcdefgh';
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const PROMOTIONS = ['q', 'r', 'b', 'n'];
  const KNIGHT_STEPS = [
    [1, 2], [2, 1], [2, -1], [1, -2],
    [-1, -2], [-2, -1], [-2, 1], [-1, 2]
  ];
  const KING_STEPS = [
    [1, 1], [1, 0], [1, -1], [0, -1],
    [-1, -1], [-1, 0], [-1, 1], [0, 1]
  ];
  const DIAGONALS = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  const ORTHOGONALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const PIECE_LETTERS = { p: '', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };

  function inBounds(file, rank) {
    return file >= 0 && file < 8 && rank >= 0 && rank < 8;
  }

  function squareToIndex(square) {
    if (typeof square !== 'string' || !/^[a-h][1-8]$/.test(square)) return -1;
    return (Number(square[1]) - 1) * 8 + FILES.indexOf(square[0]);
  }

  function indexToSquare(index) {
    if (!Number.isInteger(index) || index < 0 || index > 63) return null;
    return FILES[index % 8] + String(Math.floor(index / 8) + 1);
  }

  function colorOf(piece) {
    if (!piece) return null;
    return piece === piece.toUpperCase() ? 'w' : 'b';
  }

  function typeOf(piece) {
    return piece ? piece.toLowerCase() : null;
  }

  function opposite(color) {
    return color === 'w' ? 'b' : 'w';
  }

  function copyMove(move) {
    return {
      from: move.from,
      to: move.to,
      promotion: move.promotion || null,
      flags: Object.assign({}, move.flags || {}),
      captured: move.captured || null
    };
  }

  class ChessEngine {
    constructor(fen) {
      this.moveHistory = [];
      this.lastMove = null;
      this.loadFEN(fen || START_FEN);
    }

    reset() {
      this.moveHistory = [];
      this.lastMove = null;
      this.loadFEN(START_FEN);
      return this;
    }

    loadFEN(fen) {
      if (typeof fen !== 'string') throw new Error('FEN must be a string');
      const fields = fen.trim().split(/\s+/);
      if (fields.length < 4) throw new Error('Invalid FEN');

      const placement = fields[0].split('/');
      if (placement.length !== 8) throw new Error('Invalid FEN piece placement');

      this.board = Array(64).fill(null);
      placement.forEach((row, fenRank) => {
        let file = 0;
        for (const symbol of row) {
          if (/^[1-8]$/.test(symbol)) {
            file += Number(symbol);
          } else if (/^[prnbqkPRNBQK]$/.test(symbol)) {
            if (file > 7) throw new Error('Invalid FEN row');
            const rank = 7 - fenRank;
            this.board[rank * 8 + file] = symbol;
            file += 1;
          } else {
            throw new Error('Invalid FEN piece');
          }
        }
        if (file !== 8) throw new Error('Invalid FEN row width');
      });

      this.turn = fields[1] === 'b' ? 'b' : 'w';
      this.castling = fields[2] === '-' ? '' : fields[2].replace(/[^KQkq]/g, '');
      this.enPassant = fields[3] === '-' ? -1 : squareToIndex(fields[3]);
      if (fields[3] !== '-' && this.enPassant < 0) throw new Error('Invalid FEN en passant square');
      this.halfmove = Number.isInteger(Number(fields[4])) ? Number(fields[4]) : 0;
      this.fullmove = Number.isInteger(Number(fields[5])) ? Number(fields[5]) : 1;
      if (this.halfmove < 0 || this.fullmove < 1) throw new Error('Invalid FEN counters');

      this.positionCounts = new Map();
      this.positionCounts.set(this.positionKey(), 1);
      this.moveHistory = [];
      this.lastMove = null;
      return this;
    }

    clone() {
      const copy = Object.create(ChessEngine.prototype);
      copy.board = this.board.slice();
      copy.turn = this.turn;
      copy.castling = this.castling;
      copy.enPassant = this.enPassant;
      copy.halfmove = this.halfmove;
      copy.fullmove = this.fullmove;
      copy.positionCounts = new Map(this.positionCounts);
      copy.moveHistory = this.moveHistory.map((item) => Object.assign({}, item));
      copy.lastMove = this.lastMove ? copyMove(this.lastMove) : null;
      return copy;
    }

    fen() {
      const rows = [];
      for (let rank = 7; rank >= 0; rank -= 1) {
        let row = '';
        let empty = 0;
        for (let file = 0; file < 8; file += 1) {
          const piece = this.board[rank * 8 + file];
          if (piece) {
            if (empty) row += String(empty);
            empty = 0;
            row += piece;
          } else {
            empty += 1;
          }
        }
        if (empty) row += String(empty);
        rows.push(row);
      }
      return [
        rows.join('/'),
        this.turn,
        this.castling || '-',
        this.enPassant >= 0 ? indexToSquare(this.enPassant) : '-',
        this.halfmove,
        this.fullmove
      ].join(' ');
    }

    getPosition() {
      return {
        fen: this.fen(),
        board: this.board.slice(),
        currentTurn: this.turn,
        castling: this.castling || '-',
        enPassant: this.enPassant >= 0 ? indexToSquare(this.enPassant) : null,
        halfmove: this.halfmove,
        fullmove: this.fullmove
      };
    }

    getPiece(square) {
      const index = squareToIndex(square);
      return index >= 0 ? this.board[index] : null;
    }

    positionKey() {
      const placement = this.fen().split(' ').slice(0, 4);
      return placement.join(' ');
    }

    kingIndex(color) {
      const king = color === 'w' ? 'K' : 'k';
      return this.board.indexOf(king);
    }

    isSquareAttacked(targetIndex, byColor) {
      if (targetIndex < 0 || targetIndex > 63) return false;
      const targetFile = targetIndex % 8;
      const targetRank = Math.floor(targetIndex / 8);

      // Pawns attack towards the opponent's side. Look backwards from target.
      const pawn = byColor === 'w' ? 'P' : 'p';
      const pawnRank = targetRank + (byColor === 'w' ? -1 : 1);
      if (pawnRank >= 0 && pawnRank < 8) {
        for (const file of [targetFile - 1, targetFile + 1]) {
          if (inBounds(file, pawnRank) && this.board[pawnRank * 8 + file] === pawn) return true;
        }
      }

      const knight = byColor === 'w' ? 'N' : 'n';
      for (const [df, dr] of KNIGHT_STEPS) {
        const file = targetFile + df;
        const rank = targetRank + dr;
        if (inBounds(file, rank) && this.board[rank * 8 + file] === knight) return true;
      }

      const king = byColor === 'w' ? 'K' : 'k';
      for (const [df, dr] of KING_STEPS) {
        const file = targetFile + df;
        const rank = targetRank + dr;
        if (inBounds(file, rank) && this.board[rank * 8 + file] === king) return true;
      }

      const bishop = byColor === 'w' ? 'B' : 'b';
      const rook = byColor === 'w' ? 'R' : 'r';
      const queen = byColor === 'w' ? 'Q' : 'q';
      for (const [df, dr] of DIAGONALS) {
        let file = targetFile + df;
        let rank = targetRank + dr;
        while (inBounds(file, rank)) {
          const piece = this.board[rank * 8 + file];
          if (piece) {
            if (piece === bishop || piece === queen) return true;
            break;
          }
          file += df;
          rank += dr;
        }
      }
      for (const [df, dr] of ORTHOGONALS) {
        let file = targetFile + df;
        let rank = targetRank + dr;
        while (inBounds(file, rank)) {
          const piece = this.board[rank * 8 + file];
          if (piece) {
            if (piece === rook || piece === queen) return true;
            break;
          }
          file += df;
          rank += dr;
        }
      }
      return false;
    }

    isCheck(color) {
      const king = this.kingIndex(color || this.turn);
      return king < 0 || this.isSquareAttacked(king, opposite(color || this.turn));
    }

    isInCheck(color) {
      return this.isCheck(color);
    }

    generatePseudoMoves(color) {
      const side = color || this.turn;
      const moves = [];
      for (let from = 0; from < 64; from += 1) {
        const piece = this.board[from];
        if (!piece || colorOf(piece) !== side) continue;
        const type = typeOf(piece);
        const file = from % 8;
        const rank = Math.floor(from / 8);

        const addMove = (to, extra) => {
          if (to < 0 || to > 63) return;
          const target = this.board[to];
          if (target && colorOf(target) === side) return;
          if (target && typeOf(target) === 'k') return; // Kings cannot be captured.
          moves.push(Object.assign({
            from: indexToSquare(from),
            to: indexToSquare(to),
            promotion: null,
            flags: {},
            captured: target || null
          }, extra || {}));
        };

        if (type === 'p') {
          const direction = side === 'w' ? 1 : -1;
          const startRank = side === 'w' ? 1 : 6;
          const promotionRank = side === 'w' ? 7 : 0;
          const oneRank = rank + direction;
          if (inBounds(file, oneRank)) {
            const one = oneRank * 8 + file;
            if (!this.board[one]) {
              if (oneRank === promotionRank) {
                PROMOTIONS.forEach((promotion) => addMove(one, { promotion, flags: { promotion: true } }));
              } else {
                addMove(one);
              }
              const twoRank = rank + direction * 2;
              const two = twoRank * 8 + file;
              if (rank === startRank && inBounds(file, twoRank) && !this.board[two]) {
                addMove(two, { flags: { pawnDouble: true } });
              }
            }
          }
          for (const captureFile of [file - 1, file + 1]) {
            const captureRank = rank + direction;
            if (!inBounds(captureFile, captureRank)) continue;
            const to = captureRank * 8 + captureFile;
            const target = this.board[to];
            if (target && colorOf(target) !== side && typeOf(target) !== 'k') {
              if (captureRank === promotionRank) {
                PROMOTIONS.forEach((promotion) => addMove(to, { promotion, flags: { capture: true, promotion: true } }));
              } else {
                addMove(to, { flags: { capture: true } });
              }
            } else if (to === this.enPassant) {
              const capturedIndex = to - direction * 8;
              const captured = this.board[capturedIndex];
              if (captured === (side === 'w' ? 'p' : 'P')) {
                addMove(to, { flags: { capture: true, enPassant: true }, captured });
              }
            }
          }
        } else if (type === 'n') {
          KNIGHT_STEPS.forEach(([df, dr]) => {
            const targetFile = file + df;
            const targetRank = rank + dr;
            if (inBounds(targetFile, targetRank)) addMove(targetRank * 8 + targetFile);
          });
        } else if (type === 'b' || type === 'r' || type === 'q') {
          const directions = type === 'b' ? DIAGONALS : type === 'r' ? ORTHOGONALS : DIAGONALS.concat(ORTHOGONALS);
          directions.forEach(([df, dr]) => {
            let targetFile = file + df;
            let targetRank = rank + dr;
            while (inBounds(targetFile, targetRank)) {
              const to = targetRank * 8 + targetFile;
              const target = this.board[to];
              if (!target) {
                addMove(to);
              } else {
                if (colorOf(target) !== side && typeOf(target) !== 'k') addMove(to, { flags: { capture: true } });
                break;
              }
              targetFile += df;
              targetRank += dr;
            }
          });
        } else if (type === 'k') {
          KING_STEPS.forEach(([df, dr]) => {
            const targetFile = file + df;
            const targetRank = rank + dr;
            if (inBounds(targetFile, targetRank)) addMove(targetRank * 8 + targetFile);
          });

          // Castling is generated only when the king is not in check and the
          // traversed squares are safe. The rights and rook are both checked.
          const homeRank = side === 'w' ? 0 : 7;
          const kingHome = homeRank * 8 + 4;
          if (from === kingHome && !this.isSquareAttacked(from, opposite(side))) {
            const kingSideRight = side === 'w' ? 'K' : 'k';
            const queenSideRight = side === 'w' ? 'Q' : 'q';
            const rook = side === 'w' ? 'R' : 'r';
            if (this.castling.includes(kingSideRight) && this.board[homeRank * 8 + 7] === rook &&
                !this.board[homeRank * 8 + 5] && !this.board[homeRank * 8 + 6] &&
                !this.isSquareAttacked(homeRank * 8 + 5, opposite(side)) &&
                !this.isSquareAttacked(homeRank * 8 + 6, opposite(side))) {
              addMove(homeRank * 8 + 6, { flags: { castle: 'king' } });
            }
            if (this.castling.includes(queenSideRight) && this.board[homeRank * 8] === rook &&
                !this.board[homeRank * 8 + 1] && !this.board[homeRank * 8 + 2] && !this.board[homeRank * 8 + 3] &&
                !this.isSquareAttacked(homeRank * 8 + 3, opposite(side)) &&
                !this.isSquareAttacked(homeRank * 8 + 2, opposite(side))) {
              addMove(homeRank * 8 + 2, { flags: { castle: 'queen' } });
            }
          }
        }
      }
      return moves;
    }

    legalMoves() {
      const side = this.turn;
      return this.generatePseudoMoves(side).filter((move) => {
        const next = this.clone();
        next.applyMove(move, false);
        return !next.isCheck(side);
      });
    }

    getLegalMoves() {
      return this.legalMoves().map(copyMove);
    }

    validateMove(input) {
      if (!input || typeof input !== 'object') return { ok: false, code: 'INVALID_MOVE', message: 'Move payload is invalid.' };
      const from = typeof input.from === 'string' ? input.from.toLowerCase() : '';
      const to = typeof input.to === 'string' ? input.to.toLowerCase() : '';
      const promotion = input.promotion == null || input.promotion === '' ? null : String(input.promotion).toLowerCase();
      if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) {
        return { ok: false, code: 'INVALID_MOVE', message: 'Choose a valid board square.' };
      }
      if (promotion !== null && !PROMOTIONS.includes(promotion)) {
        return { ok: false, code: 'INVALID_PROMOTION', message: 'That promotion piece is not available.' };
      }
      const candidates = this.legalMoves().filter((move) => move.from === from && move.to === to);
      if (!candidates.length) return { ok: false, code: 'INVALID_MOVE', message: 'That move is not legal.' };
      const isPromotion = candidates.some((move) => move.promotion);
      if (isPromotion && !promotion) {
        return { ok: false, code: 'PROMOTION_REQUIRED', message: 'Choose a piece for promotion.', promotionRequired: true };
      }
      const match = candidates.find((move) => (move.promotion || null) === promotion);
      if (!match) return { ok: false, code: 'INVALID_PROMOTION', message: 'Choose a valid promotion piece.' };
      return { ok: true, move: copyMove(match) };
    }

    isLegalMove(input) {
      return this.validateMove(input).ok;
    }

    sanForMove(move) {
      const fromIndex = squareToIndex(move.from);
      const toIndex = squareToIndex(move.to);
      const piece = this.board[fromIndex];
      const type = typeOf(piece);
      if (!piece || fromIndex < 0 || toIndex < 0) return '';
      if (move.flags && move.flags.castle === 'king') return this.sanWithSuffix('O-O', move);
      if (move.flags && move.flags.castle === 'queen') return this.sanWithSuffix('O-O-O', move);

      const capture = Boolean(move.flags && (move.flags.capture || move.flags.enPassant)) || Boolean(this.board[toIndex]);
      let san = PIECE_LETTERS[type];
      if (type === 'p' && capture) san += move.from[0];

      if (type !== 'p') {
        const peers = this.legalMoves().filter((candidate) => candidate.from !== move.from && candidate.to === move.to &&
          typeOf(this.board[squareToIndex(candidate.from)]) === type);
        if (peers.length) {
          const sameFile = peers.some((candidate) => candidate.from[0] === move.from[0]);
          const sameRank = peers.some((candidate) => candidate.from[1] === move.from[1]);
          if (!sameFile) san += move.from[0];
          else if (!sameRank) san += move.from[1];
          else san += move.from;
        }
      }
      if (capture) san += 'x';
      san += move.to;
      if (move.promotion) san += '=' + move.promotion.toUpperCase();
      return this.sanWithSuffix(san, move);
    }

    sanWithSuffix(san, move) {
      const next = this.clone();
      next.applyMove(move, false);
      if (next.isCheck(next.turn)) {
        san += next.legalMoves().length ? '+' : '#';
      }
      return san;
    }

    applyMove(move, record) {
      const from = squareToIndex(move.from);
      const to = squareToIndex(move.to);
      const piece = this.board[from];
      if (!piece || from < 0 || to < 0) return this;
      const side = colorOf(piece);
      const type = typeOf(piece);
      const target = this.board[to];
      const flags = move.flags || {};
      const isCapture = Boolean(target) || Boolean(flags.enPassant) || Boolean(flags.capture);

      this.board[from] = null;
      if (flags.enPassant) {
        const capturedIndex = to - (side === 'w' ? 8 : -8);
        this.board[capturedIndex] = null;
      }

      let movedPiece = piece;
      if (move.promotion) movedPiece = side === 'w' ? move.promotion.toUpperCase() : move.promotion.toLowerCase();
      this.board[to] = movedPiece;

      if (flags.castle === 'king') {
        const rank = side === 'w' ? 0 : 7;
        const rookFrom = rank * 8 + 7;
        const rookTo = rank * 8 + 5;
        this.board[rookTo] = this.board[rookFrom];
        this.board[rookFrom] = null;
      } else if (flags.castle === 'queen') {
        const rank = side === 'w' ? 0 : 7;
        const rookFrom = rank * 8;
        const rookTo = rank * 8 + 3;
        this.board[rookTo] = this.board[rookFrom];
        this.board[rookFrom] = null;
      }

      if (type === 'k') {
        this.removeCastling(side === 'w' ? 'K' : 'k');
        this.removeCastling(side === 'w' ? 'Q' : 'q');
      }
      if (type === 'r') this.removeRookRight(from);
      if (target && typeOf(target) === 'r') this.removeRookRight(to);
      if (flags.enPassant) this.enPassant = -1;
      else this.enPassant = flags.pawnDouble ? from + (side === 'w' ? 8 : -8) : -1;

      this.halfmove = type === 'p' || isCapture ? 0 : this.halfmove + 1;
      if (side === 'b') this.fullmove += 1;
      this.turn = opposite(side);

      const publicMove = copyMove(move);
      publicMove.captured = flags.enPassant ? (side === 'w' ? 'p' : 'P') : target || null;
      this.lastMove = publicMove;
      if (record !== false) {
        this.positionCounts.set(this.positionKey(), (this.positionCounts.get(this.positionKey()) || 0) + 1);
      }
      return this;
    }

    removeCastling(right) {
      this.castling = this.castling.replace(right, '');
    }

    removeRookRight(index) {
      if (index === squareToIndex('a1')) this.removeCastling('Q');
      else if (index === squareToIndex('h1')) this.removeCastling('K');
      else if (index === squareToIndex('a8')) this.removeCastling('q');
      else if (index === squareToIndex('h8')) this.removeCastling('k');
    }

    makeMove(input) {
      const validation = this.validateMove(input);
      if (!validation.ok) return validation;
      const move = validation.move;
      const san = this.sanForMove(move);
      this.applyMove(move, true);
      const historyItem = {
        number: Math.ceil((this.moveHistory.length + 1) / 2),
        color: this.turn === 'b' ? 'w' : 'b',
        from: move.from,
        to: move.to,
        promotion: move.promotion || null,
        san,
        fen: this.fen()
      };
      this.moveHistory.push(historyItem);
      return {
        ok: true,
        move: copyMove(move),
        san,
        fen: this.fen(),
        result: this.getGameResult()
      };
    }

    isCheckmate() {
      return this.isCheck(this.turn) && this.legalMoves().length === 0;
    }

    isStalemate() {
      return !this.isCheck(this.turn) && this.legalMoves().length === 0;
    }

    hasInsufficientMaterial() {
      const pieces = this.board.filter(Boolean).map((piece, index) => ({ piece, index })).filter(({ piece }) => typeOf(piece) !== 'k');
      if (!pieces.length) return true;
      if (pieces.some(({ piece }) => ['p', 'r', 'q'].includes(typeOf(piece)))) return false;
      if (pieces.length === 1 && ['b', 'n'].includes(typeOf(pieces[0].piece))) return true;
      if (pieces.every(({ piece }) => typeOf(piece) === 'b')) {
        const colors = new Set(pieces.map(({ index }) => (Math.floor(index / 8) + (index % 8)) % 2));
        return colors.size === 1;
      }
      return false;
    }

    isDraw() {
      return Boolean(this.getGameResult() && this.getGameResult().result === 'DRAW');
    }

    getGameResult() {
      const legal = this.legalMoves();
      if (!legal.length) {
        if (this.isCheck(this.turn)) {
          return {
            finished: true,
            result: this.turn === 'w' ? 'BLACK_WINS' : 'WHITE_WINS',
            reason: 'CHECKMATE'
          };
        }
        return { finished: true, result: 'DRAW', reason: 'STALEMATE' };
      }
      if (this.halfmove >= 100) return { finished: true, result: 'DRAW', reason: 'FIFTY_MOVE_RULE' };
      if ((this.positionCounts.get(this.positionKey()) || 0) >= 3) {
        return { finished: true, result: 'DRAW', reason: 'THREEFOLD_REPETITION' };
      }
      if (this.hasInsufficientMaterial()) return { finished: true, result: 'DRAW', reason: 'INSUFFICIENT_MATERIAL' };
      return { finished: false, result: null, reason: null };
    }
  }

  ChessEngine.START_FEN = START_FEN;
  ChessEngine.squareToIndex = squareToIndex;
  ChessEngine.indexToSquare = indexToSquare;
  ChessEngine.opposite = opposite;
  return ChessEngine;
}));
