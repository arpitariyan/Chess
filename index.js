'use strict';

/*
 * The board renderer is shared by local and online play. Local moves are
 * applied directly to a ChessEngine; online moves are only sent to the server
 * and are rendered after the authoritative state comes back over WebSocket.
 */
(function () {
  const PIECES = {
    K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
    k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟'
  };
  const PIECE_NAMES = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn', k: 'King' };
  const FILES = 'abcdefgh';

  const $ = (id) => document.getElementById(id);
  const screens = ['home-screen', 'online-lobby-screen', 'waiting-screen', 'game-screen', 'history-screen'];
  const ui = {
    mode: 'home',
    localEngine: null,
    selectedSquare: null,
    selectedMoves: [],
    pendingPromotion: null,
    clockTimer: null,
    toastTimer: null,
    history: [],
    replay: null,
    online: {
      token: null,
      socket: null,
      userId: null,
      requestNumber: 0,
      sessionPromise: null,
      connection: 'idle',
      reconnectTimer: null,
      reconnectDelay: 1000,
      shouldReconnect: true,
      room: null,
      game: null,
      engine: null,
      pendingMoveId: null,
      resultGameId: null
    }
  };

  function safeSessionGet(key) {
    try { return window.sessionStorage.getItem(key); } catch (error) { return null; }
  }

  function safeSessionSet(key, value) {
    try { window.sessionStorage.setItem(key, value); } catch (error) { /* Private browsing can disable storage. */ }
  }

  function clearSession() {
    ui.online.token = null;
    try { window.sessionStorage.removeItem('chess-online-session'); } catch (error) { /* Private browsing can disable storage. */ }
  }

  function randomId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return `${prefix}_${window.crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function showScreen(screenId) {
    screens.forEach((id) => {
      const screen = $(id);
      const visible = id === screenId;
      screen.hidden = !visible;
      screen.classList.toggle('active', visible);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showToast(message, isError) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.toggle('error', Boolean(isError));
    toast.classList.add('visible');
    window.clearTimeout(ui.toastTimer);
    ui.toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3800);
  }

  function setConnection(state, label) {
    ui.online.connection = state;
    const pill = $('connection-pill');
    const text = $('connection-pill-label');
    pill.dataset.state = state;
    text.textContent = label || ({
      idle: 'Local play',
      connecting: 'Connecting',
      connected: 'Connected',
      reconnecting: 'Reconnecting',
      error: 'Connection issue'
    }[state] || state);
  }

  function miniBoard() {
    const board = $('mini-board');
    const engine = new ChessEngine();
    board.innerHTML = '';
    for (let rank = 7; rank >= 0; rank -= 1) {
      for (let file = 0; file < 8; file += 1) {
        const square = document.createElement('div');
        const piece = engine.getPiece(FILES[file] + (rank + 1));
        square.className = `mini-square ${((file + rank) % 2 === 0) ? 'light' : 'dark'}`;
        if (piece) {
          square.textContent = PIECES[piece];
          square.classList.add(piece === piece.toUpperCase() ? 'white-piece' : 'black-piece');
        }
        board.appendChild(square);
      }
    }
  }

  function squareOrder(orientation) {
    const squares = [];
    const ranks = orientation === 'black' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
    const files = orientation === 'black' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
    ranks.forEach((rank) => files.forEach((file) => squares.push(FILES[file] + (rank + 1))));
    return squares;
  }

  function buildLabels(orientation) {
    const rankLabels = $('rank-labels');
    const fileLabels = $('file-labels');
    rankLabels.innerHTML = '';
    fileLabels.innerHTML = '';
    const ranks = orientation === 'black' ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
    const files = orientation === 'black' ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'] : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    ranks.forEach((rank) => { const label = document.createElement('span'); label.textContent = rank; rankLabels.appendChild(label); });
    files.forEach((file) => { const label = document.createElement('span'); label.textContent = file; fileLabels.appendChild(label); });
  }

  function engineKingIsInCheck(engine, piece) {
    if (!piece) return false;
    const color = piece === piece.toUpperCase() ? 'w' : 'b';
    return piece.toLowerCase() === 'k' && engine.isCheck(color);
  }

  function renderBoard(engine, options) {
    if (!engine) return;
    const config = options || {};
    const orientation = config.orientation || 'white';
    const board = $('board');
    board.dataset.orientation = orientation;
    board.innerHTML = '';
    buildLabels(orientation);
    const selected = config.selectedSquare;
    const legalMoves = config.legalMoves || [];
    const lastMove = config.lastMove || engine.lastMove;
    const legalTargets = new Map();
    legalMoves.forEach((move) => legalTargets.set(move.to, move));

    squareOrder(orientation).forEach((square) => {
      const file = FILES.indexOf(square[0]);
      const rank = Number(square[1]) - 1;
      const piece = engine.getPiece(square);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `gamecell ${((file + rank) % 2 === 0) ? 'light' : 'dark'}`;
      cell.dataset.square = square;
      cell.id = `cell-${square}`;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `${square}${piece ? `, ${PIECE_NAMES[piece.toLowerCase()] || 'king'} ` + (piece === piece.toUpperCase() ? 'white' : 'black') : ', empty'}`);
      if (piece) {
        cell.textContent = PIECES[piece] || '';
        cell.classList.add(piece === piece.toUpperCase() ? 'white-piece' : 'black-piece');
      }
      if (square === selected) cell.classList.add('selected');
      if (legalTargets.has(square)) {
        cell.classList.add('legal');
        const target = engine.getPiece(square);
        const movingPiece = selected ? engine.getPiece(selected) : null;
        if (target && movingPiece && target.toUpperCase() !== movingPiece.toUpperCase()) cell.classList.add('capture');
      }
      if (lastMove && (square === lastMove.from || square === lastMove.to)) cell.classList.add('last-move');
      if (engineKingIsInCheck(engine, piece)) cell.classList.add('check');
      cell.addEventListener('click', () => handleSquareClick(square));
      board.appendChild(cell);
    });
  }

  function resetSelection() {
    ui.selectedSquare = null;
    ui.selectedMoves = [];
  }

  function choosePiece(square, engine, color) {
    const piece = engine.getPiece(square);
    if (!piece) return false;
    const pieceColor = piece === piece.toUpperCase() ? 'w' : 'b';
    if (pieceColor !== color) return false;
    ui.selectedSquare = square;
    ui.selectedMoves = engine.getLegalMoves().filter((move) => move.from === square);
    return true;
  }

  function openPromotion(color, candidates, onChoice) {
    ui.pendingPromotion = onChoice;
    const options = $('promotion-options');
    options.innerHTML = '';
    const unique = [];
    candidates.forEach((move) => { if (!unique.includes(move.promotion)) unique.push(move.promotion); });
    unique.forEach((promotion) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'promotion-choice';
      const letter = color === 'w' ? promotion.toUpperCase() : promotion.toLowerCase();
      button.textContent = PIECES[letter];
      button.setAttribute('aria-label', PIECE_NAMES[promotion]);
      button.addEventListener('click', () => {
        const callback = ui.pendingPromotion;
        closePromotion();
        if (callback) callback(promotion);
      });
      options.appendChild(button);
    });
    $('promotion-modal').hidden = false;
    const first = options.querySelector('button');
    if (first) first.focus();
  }

  function closePromotion() {
    $('promotion-modal').hidden = true;
    ui.pendingPromotion = null;
  }

  function handleSquareClick(square) {
    if (ui.mode === 'local') return handleLocalSquare(square);
    if (ui.mode === 'online') return handleOnlineSquare(square);
    // Replay is deliberately read-only.
  }

  function handleLocalSquare(square) {
    const engine = ui.localEngine;
    if (!engine) return;
    const piece = engine.getPiece(square);
    const turnPiece = piece && (piece === piece.toUpperCase() ? 'w' : 'b');
    if (!ui.selectedSquare) {
      if (choosePiece(square, engine, engine.turn)) renderLocalGame();
      return;
    }
    if (piece && turnPiece === engine.turn) {
      choosePiece(square, engine, engine.turn);
      renderLocalGame();
      return;
    }
    const candidates = ui.selectedMoves.filter((move) => move.to === square);
    if (!candidates.length) {
      resetSelection();
      renderLocalGame();
      return;
    }
    const commit = (promotion) => {
      const from = ui.selectedSquare;
      resetSelection();
      const result = engine.makeMove({ from, to: square, promotion: promotion || null });
      if (!result.ok) {
        showToast(result.message || 'That move is not legal.', true);
        renderLocalGame();
        return;
      }
      renderLocalGame();
      if (result.result && result.result.finished) showResult(result.result, 'local');
    };
    if (candidates.some((move) => move.promotion)) {
      const color = engine.turn;
      openPromotion(color, candidates, commit);
    } else {
      commit(null);
    }
  }

  function startLocalGame() {
    closeResult();
    closePromotion();
    ui.mode = 'local';
    ui.localEngine = new ChessEngine();
    ui.replay = null;
    ui.online.game = null;
    resetSelection();
    setConnection('idle', 'Local play');
    showScreen('game-screen');
    renderLocalGame();
  }

  function renderLocalGame() {
    const engine = ui.localEngine;
    if (!engine) return;
    $('game-mode-label').textContent = 'LOCAL GAME';
    $('game-title').textContent = 'The board is yours.';
    $('game-room-label').textContent = 'Pass and play';
    $('opponent-name').textContent = 'Black';
    $('you-name').textContent = 'White';
    $('opponent-avatar').textContent = '♟';
    $('you-avatar').textContent = '♙';
    $('opponent-connection-label').textContent = 'Local game';
    $('opponent-connection-card').dataset.connected = 'false';
    $('opponent-connection-card').querySelector('.status-dot').style.background = '#a3a9ae';
    $('opponent-clock').textContent = '—';
    $('you-clock').textContent = '—';
    $('online-controls').hidden = true;
    $('local-controls').hidden = false;
    $('replay-controls').hidden = true;
    $('server-note').hidden = true;
    $('leave-game-button').textContent = 'Exit game';
    updateTurnCard(engine.turn === 'w' ? 'WHITE' : 'BLACK', false, false);
    renderMoveList(engine.moveHistory, engine.moveHistory.length - 1);
    renderBoard(engine, { orientation: 'white', selectedSquare: ui.selectedSquare, legalMoves: ui.selectedMoves, lastMove: engine.lastMove });
    stopClockTimer();
  }

  function renderReplay() {
    if (!ui.replay) return;
    const replay = ui.replay;
    $('game-mode-label').textContent = 'GAME REPLAY';
    $('game-title').textContent = 'Review the game.';
    $('game-room-label').textContent = replay.record.timeControlLabel || 'Stored game';
    $('opponent-name').textContent = replay.record.yourColor === 'WHITE' ? 'Black' : 'White';
    $('you-name').textContent = replay.record.yourColor === 'WHITE' ? 'White' : 'Black';
    $('opponent-avatar').textContent = replay.record.yourColor === 'WHITE' ? '♟' : '♙';
    $('you-avatar').textContent = replay.record.yourColor === 'WHITE' ? '♙' : '♟';
    $('opponent-connection-label').textContent = 'Stored game';
    $('opponent-connection-card').dataset.connected = 'false';
    $('opponent-connection-card').querySelector('.status-dot').style.background = '#a3a9ae';
    $('opponent-clock').textContent = '—';
    $('you-clock').textContent = '—';
    $('online-controls').hidden = true;
    $('local-controls').hidden = true;
    $('replay-controls').hidden = false;
    $('server-note').hidden = true;
    $('leave-game-button').textContent = 'Exit replay';
    updateTurnCard(replay.index === 0 ? 'WHITE' : (replay.engine.turn === 'w' ? 'WHITE' : 'BLACK'), false, false, replay.index === replay.record.moves.length ? 'Game complete' : 'Replay position');
    renderMoveList(replay.record.moves, replay.index - 1);
    renderBoard(replay.engine, { orientation: replay.record.yourColor === 'BLACK' ? 'black' : 'white', lastMove: replay.engine.lastMove });
    stopClockTimer();
  }

  function updateTurnCard(turn, online, finished, customText) {
    const card = $('turn-card');
    card.classList.toggle('finished', finished);
    $('turn-label').textContent = customText || (finished ? 'Game complete' : `It's ${turn === 'WHITE' ? 'White' : 'Black'}'s turn`);
  }

  function renderMoveList(history, latestIndex) {
    const list = $('move-list');
    const moves = Array.isArray(history) ? history : [];
    $('move-count').textContent = String(moves.length);
    if (!moves.length) {
      list.innerHTML = '<div class="empty-moves">Your opening move is waiting.</div>';
      return;
    }
    const rows = [];
    for (let i = 0; i < moves.length; i += 2) {
      const first = moves[i];
      const second = moves[i + 1];
      const number = first.number || Math.floor(i / 2) + 1;
      rows.push(`<div class="move-row"><span class="move-number">${number}.</span><span class="${i === latestIndex ? 'latest' : ''}">${escapeHtml(first.san || '')}</span><span class="${i + 1 === latestIndex ? 'latest' : ''}">${second ? escapeHtml(second.san || '') : ''}</span></div>`);
    }
    list.innerHTML = rows.join('');
    list.scrollTop = list.scrollHeight;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function stopClockTimer() {
    if (ui.clockTimer) window.clearInterval(ui.clockTimer);
    ui.clockTimer = null;
  }

  function startClockTimer() {
    stopClockTimer();
    ui.clockTimer = window.setInterval(() => {
      if (ui.mode === 'online' && ui.online.game) renderClocks(ui.online.game);
    }, 100);
  }

  function clockText(milliseconds, enabled) {
    if (!enabled || milliseconds == null) return '∞';
    const ms = Math.max(0, milliseconds);
    if (ms < 10000) return `0:${(ms / 1000).toFixed(1).padStart(4, '0')}`;
    const totalSeconds = Math.floor(ms / 1000);
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
  }

  function currentClock(state, color) {
    if (!state || !state.clock || !state.clock.enabled) return null;
    const key = color === 'WHITE' ? 'whiteRemaining' : 'blackRemaining';
    let remaining = Number(state.clock[key]) || 0;
    if (state.status === 'PLAYING' && state.clock.activeColor === color) {
      remaining -= Math.max(0, Date.now() - Number(state.clock.serverTime || Date.now()));
    }
    return Math.max(0, remaining);
  }

  function renderClocks(state) {
    if (!state || !state.clock) return;
    const opponentColor = state.yourColor === 'WHITE' ? 'BLACK' : 'WHITE';
    const opponentClock = $('opponent-clock');
    const youClock = $('you-clock');
    const opponentRemaining = currentClock(state, opponentColor);
    const youRemaining = currentClock(state, state.yourColor);
    opponentClock.textContent = clockText(opponentRemaining, state.clock.enabled);
    youClock.textContent = clockText(youRemaining, state.clock.enabled);
    opponentClock.classList.toggle('active', state.status === 'PLAYING' && state.clock.activeColor === opponentColor);
    youClock.classList.toggle('active', state.status === 'PLAYING' && state.clock.activeColor === state.yourColor);
    opponentClock.classList.toggle('low-time', opponentRemaining != null && opponentRemaining < 10000);
    youClock.classList.toggle('low-time', youRemaining != null && youRemaining < 10000);
  }

  function renderOnlineGame() {
    const state = ui.online.game;
    if (!state || !ui.online.engine) return;
    $('game-mode-label').textContent = 'ONLINE CHESS';
    $('game-title').textContent = state.status === 'FINISHED' ? 'A game well played.' : 'Your move matters.';
    $('game-room-label').textContent = `Room ${ui.online.room ? ui.online.room.roomCode : 'private'}`;
    const opponentColor = state.yourColor === 'WHITE' ? 'BLACK' : 'WHITE';
    $('opponent-name').textContent = opponentColor === 'WHITE' ? 'White' : 'Black';
    $('you-name').textContent = state.yourColor === 'WHITE' ? 'White' : 'Black';
    $('opponent-avatar').textContent = opponentColor === 'WHITE' ? '♙' : '♟';
    $('you-avatar').textContent = state.yourColor === 'WHITE' ? '♙' : '♟';
    const opponentConnected = Boolean(state.players && state.players.opponent && state.players.opponent.connected);
    $('opponent-connection-card').dataset.connected = String(opponentConnected);
    $('opponent-connection-card').querySelector('.status-dot').style.background = opponentConnected ? '' : '#a3a9ae';
    $('opponent-connection-label').textContent = opponentConnected ? 'Opponent connected' : 'Opponent disconnected';
    $('online-controls').hidden = state.status !== 'PLAYING';
    $('local-controls').hidden = true;
    $('replay-controls').hidden = true;
    $('server-note').hidden = false;
    $('leave-game-button').textContent = 'Exit game';
    const ownTurn = state.currentTurn === state.yourColor;
    updateTurnCard(state.currentTurn, true, state.status === 'FINISHED', state.status === 'FINISHED' ? (state.resultReasonLabel || 'Game complete') : (ownTurn ? 'Your turn' : "Opponent's turn"));
    const drawButton = $('draw-button');
    const declineButton = $('decline-draw-button');
    drawButton.disabled = state.drawOffer === 'SENT';
    drawButton.textContent = state.drawOffer === 'RECEIVED' ? 'Accept draw' : state.drawOffer === 'SENT' ? 'Draw offered' : 'Offer draw';
    declineButton.hidden = state.drawOffer !== 'RECEIVED';
    renderClocks(state);
    renderMoveList(state.moveHistory, state.moveHistory.length - 1);
    renderBoard(ui.online.engine, {
      orientation: state.yourColor === 'BLACK' ? 'black' : 'white',
      selectedSquare: ui.selectedSquare,
      legalMoves: ui.selectedMoves,
      lastMove: state.lastMove
    });
    if (state.status === 'PLAYING') startClockTimer();
    else stopClockTimer();
  }

  function handleOnlineSquare(square) {
    const state = ui.online.game;
    const engine = ui.online.engine;
    if (!state || !engine || state.status !== 'PLAYING') return;
    if (ui.online.connection !== 'connected') {
      showToast('Connect to the game before making a move.', true);
      return;
    }
    if (state.currentTurn !== state.yourColor) {
      showToast("It is your opponent's turn.", true);
      return;
    }
    const piece = engine.getPiece(square);
    const pieceColor = piece ? (piece === piece.toUpperCase() ? 'WHITE' : 'BLACK') : null;
    if (!ui.selectedSquare) {
      if (pieceColor === state.yourColor) {
        choosePiece(square, engine, state.yourColor === 'WHITE' ? 'w' : 'b');
        renderOnlineGame();
      }
      return;
    }
    if (pieceColor === state.yourColor) {
      choosePiece(square, engine, state.yourColor === 'WHITE' ? 'w' : 'b');
      renderOnlineGame();
      return;
    }
    const candidates = ui.selectedMoves.filter((move) => move.to === square);
    if (!candidates.length) {
      resetSelection();
      renderOnlineGame();
      return;
    }
    const from = ui.selectedSquare;
    const submit = (promotion) => {
      resetSelection();
      const moveId = randomId('move');
      ui.online.pendingMoveId = moveId;
      sendRealtime('game:move', {
        gameId: state.gameId,
        moveId,
        from,
        to: square,
        promotion: promotion || null,
        clientRevision: state.revision
      });
      renderOnlineGame();
    };
    if (candidates.some((move) => move.promotion)) openPromotion(state.yourColor === 'WHITE' ? 'w' : 'b', candidates, submit);
    else submit(null);
  }

  async function ensureSession() {
    if (ui.online.token) return ui.online.token;
    if (ui.online.sessionPromise) return ui.online.sessionPromise;
    ui.online.sessionPromise = (async () => {
      const saved = safeSessionGet('chess-online-session');
      if (saved) {
        ui.online.token = saved;
        return saved;
      }
      const response = await fetch('/api/session', { method: 'POST', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Unable to create an online session.');
      const data = await response.json();
      if (!data.token) throw new Error('Online session response was invalid.');
      ui.online.token = data.token;
      ui.online.userId = data.userId || null;
      safeSessionSet('chess-online-session', data.token);
      return data.token;
    })();
    try {
      return await ui.online.sessionPromise;
    } finally {
      ui.online.sessionPromise = null;
    }
  }

  async function waitForRealtime() {
    await connectRealtime();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (ui.online.socket && ui.online.socket.readyState === WebSocket.OPEN && ui.online.connection === 'connected') return true;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    throw new Error('The realtime connection is taking too long. Please try again.');
  }

  function socketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  async function connectRealtime() {
    ui.online.shouldReconnect = true;
    if (ui.online.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ui.online.socket.readyState)) return;
    setConnection('connecting', 'Connecting');
    try {
      const token = await ensureSession();
      const socket = new WebSocket(socketUrl());
      ui.online.socket = socket;
      socket.addEventListener('open', () => {
        ui.online.reconnectDelay = 1000;
        sendRealtime('auth', { token });
      });
      socket.addEventListener('message', (event) => {
        try { handleRealtimePacket(JSON.parse(event.data)); } catch (error) { showToast('A realtime update could not be read.', true); }
      });
      socket.addEventListener('close', () => {
        if (ui.online.socket !== socket) return;
        ui.online.socket = null;
        if (ui.online.shouldReconnect) {
          setConnection('reconnecting', 'Reconnecting');
          scheduleReconnect();
        } else {
          setConnection('idle', 'Local play');
        }
      });
      socket.addEventListener('error', () => {
        setConnection('error', 'Connection issue');
      });
    } catch (error) {
      setConnection('error', 'Connection issue');
      showToast(error.message || 'Unable to connect to online play.', true);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (!ui.online.shouldReconnect || ui.online.reconnectTimer) return;
    ui.online.reconnectTimer = window.setTimeout(() => {
      ui.online.reconnectTimer = null;
      connectRealtime();
      ui.online.reconnectDelay = Math.min(8000, ui.online.reconnectDelay * 1.7);
    }, ui.online.reconnectDelay);
  }

  function sendRealtime(type, payload, requestId) {
    const socket = ui.online.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (type !== 'auth') showToast('The realtime connection is not ready yet.', true);
      return false;
    }
    const packet = Object.assign({ type, requestId: requestId || `request_${++ui.online.requestNumber}` }, payload || {});
    socket.send(JSON.stringify(packet));
    return true;
  }

  function handleRealtimePacket(packet) {
    if (!packet || typeof packet.type !== 'string') return;
    switch (packet.type) {
      case 'session:authenticated':
        ui.online.userId = packet.userId || ui.online.userId;
        setConnection('connected', 'Connected');
        break;
      case 'room:created':
      case 'room:joined':
        ui.online.room = packet.room;
        renderWaitingRoom();
        showScreen('waiting-screen');
        break;
      case 'room:state':
        ui.online.room = packet.room;
        if (packet.room && packet.room.status === 'WAITING') {
          renderWaitingRoom();
          if (ui.mode !== 'game') showScreen('waiting-screen');
        }
        break;
      case 'room:ready':
        if (packet.room) ui.online.room = packet.room;
        showToast('Opponent found. Starting game…');
        break;
      case 'room:cancelled':
        ui.online.room = null;
        showToast('The room was cancelled.');
        showScreen('online-lobby-screen');
        break;
      case 'room:expired':
        ui.online.room = null;
        showToast('This waiting room expired. Create a new one.', true);
        showScreen('online-lobby-screen');
        break;
      case 'game:start':
        // The complete game:state event follows game:start. Waiting for it
        // prevents a client from ever inventing an initial board.
        break;
      case 'game:state':
      case 'game:sync':
        applyOnlineState(packet.state);
        break;
      case 'game:move:accepted':
        ui.online.pendingMoveId = null;
        applyOnlineState(packet.state);
        break;
      case 'game:end':
        applyOnlineState(packet.state);
        if (packet.state) showResult(packet.state, 'online');
        break;
      case 'game:draw:offered':
        applyOnlineState(packet.state);
        if (packet.from === 'OPPONENT') showToast('Your opponent offered a draw.');
        break;
      case 'game:draw:declined':
        applyOnlineState(packet.state);
        showToast('Draw offer declined.');
        break;
      case 'game:rematch:pending':
        applyOnlineState(packet.state);
        if (packet.acceptedByOpponent) showToast('Your opponent accepted the rematch.');
        updateResultForRematch(packet.acceptedByYou);
        break;
      case 'game:rematch:declined':
        applyOnlineState(packet.state);
        closeResult();
        showToast('Rematch declined.');
        break;
      case 'game:rematch:started':
        closeResult();
        showToast('Rematch accepted. Colors have been swapped.');
        break;
      case 'player:disconnected':
        applyOnlineState(packet.state);
        if (packet.color) showToast('Your opponent disconnected. Their game is waiting for them.');
        break;
      case 'player:reconnected':
        applyOnlineState(packet.state);
        if (packet.color && packet.color !== (ui.online.game && ui.online.game.yourColor)) showToast('Your opponent reconnected.');
        break;
      case 'error':
        if (packet.state) applyOnlineState(packet.state);
        ui.online.pendingMoveId = null;
        if (packet.code === 'UNAUTHORIZED' && ui.online.socket) {
          clearSession();
          try { ui.online.socket.close(4001, 'session expired'); } catch (error) { /* Socket may already be closed. */ }
        }
        showToast(packet.message || 'Online action failed.', true);
        break;
      default:
        break;
    }
  }

  function applyOnlineState(state) {
    if (!state || !state.gameId) return;
    if (ui.online.game && ui.online.game.gameId === state.gameId && Number(state.revision) < Number(ui.online.game.revision)) return;
    ui.mode = 'online';
    ui.online.game = state;
    ui.online.engine = new ChessEngine(state.fen);
    ui.online.room = ui.online.room || { roomCode: '' };
    resetSelection();
    if (state.status === 'PLAYING' || state.status === 'FINISHED') {
      showScreen('game-screen');
      renderOnlineGame();
      if (state.status === 'FINISHED') showResult(state, 'online');
    }
  }

  function renderWaitingRoom() {
    const room = ui.online.room;
    if (!room) return;
    $('room-code-display').textContent = room.roomCode;
    const settings = room.settings || {};
    const color = room.yourColor ? `${room.yourColor[0]}${room.yourColor.slice(1).toLowerCase()}` : 'Assigned color';
    $('room-settings-label').textContent = `${settings.timeControlLabel || settings.timeControl || '10 + 5'} · ${color}`;
    const waiting = room.status === 'WAITING';
    $('waiting-status-label').textContent = waiting ? 'Waiting for opponent' : 'Opponent found';
    $('cancel-room-button').disabled = !waiting;
  }

  function inviteLink() {
    const code = ui.online.room && ui.online.room.roomCode;
    return code ? `${window.location.origin}${window.location.pathname}?room=${code}` : '';
  }

  async function copyText(value, successMessage) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast(successMessage);
    } catch (error) {
      const helper = document.createElement('textarea');
      helper.value = value;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
      showToast(successMessage);
    }
  }

  function openOnlineLobby() {
    closeResult();
    ui.mode = 'online-lobby';
    showScreen('online-lobby-screen');
    connectRealtime();
    const queryCode = new URLSearchParams(window.location.search).get('room');
    if (queryCode && /^\d{6}$/.test(queryCode)) $('room-code-input').value = queryCode;
  }

  async function createRoom() {
    const settings = {
      timeControl: $('time-control').value,
      color: $('color-choice').value
    };
    try {
      await waitForRealtime();
      sendRealtime('room:create', { settings });
    } catch (error) {
      showToast(error.message || 'Unable to connect to online play.', true);
    }
  }

  async function joinRoom() {
    const code = $('room-code-input').value.replace(/\D/g, '');
    $('room-code-input').value = code;
    if (!/^\d{6}$/.test(code)) {
      showToast('Enter all six digits of the room code.', true);
      $('room-code-input').focus();
      return;
    }
    try {
      await waitForRealtime();
      sendRealtime('room:join', { roomCode: code });
    } catch (error) {
      showToast(error.message || 'Unable to connect to online play.', true);
    }
  }

  function cancelRoom() {
    if (!ui.online.room) return;
    if (window.confirm('Cancel this waiting room?')) sendRealtime('room:cancel', { roomId: ui.online.room.roomId });
  }

  function resign() {
    if (!ui.online.game || !window.confirm('Resign this game?')) return;
    sendRealtime('game:resign', { gameId: ui.online.game.gameId });
  }

  function drawAction() {
    const state = ui.online.game;
    if (!state) return;
    if (state.drawOffer === 'RECEIVED') sendRealtime('game:draw:respond', { gameId: state.gameId, accept: true });
    else if (state.drawOffer !== 'SENT') sendRealtime('game:draw:offer', { gameId: state.gameId });
  }

  function declineDraw() {
    if (ui.online.game) sendRealtime('game:draw:respond', { gameId: ui.online.game.gameId, accept: false });
  }

  function showResult(result, source) {
    if (!result) return;
    const state = source === 'online' ? result : null;
    const finished = state || result;
    const resultValue = finished.result;
    const ownColor = state && state.yourColor;
    const won = ownColor && ((resultValue === 'WHITE_WINS' && ownColor === 'WHITE') || (resultValue === 'BLACK_WINS' && ownColor === 'BLACK'));
    $('result-symbol').textContent = resultValue === 'DRAW' ? '＝' : won ? '✦' : '＋';
    $('result-title').textContent = resultValue === 'DRAW' ? 'Draw.' : won ? 'You win.' : source === 'local' ? 'Black wins.' : 'Game over.';
    $('result-subtitle').textContent = state ? (state.resultReasonLabel || 'The game has ended.') : (result.reason ? result.reason.replaceAll('_', ' ').toLowerCase() : 'The game has ended.');
    $('rematch-button').textContent = source === 'online' ? 'Request rematch →' : 'Play again →';
    $('rematch-button').disabled = false;
    $('result-modal').dataset.source = source;
    $('result-modal').hidden = false;
    ui.online.resultGameId = state ? state.gameId : null;
  }

  function updateResultForRematch(acceptedByYou) {
    if ($('result-modal').hidden) return;
    $('rematch-button').textContent = acceptedByYou ? 'Waiting for opponent…' : 'Request rematch →';
    $('rematch-button').disabled = acceptedByYou;
  }

  function closeResult() {
    $('result-modal').hidden = true;
    $('result-modal').removeAttribute('data-source');
  }

  function resultRematch() {
    const source = $('result-modal').dataset.source;
    if (source === 'local') {
      startLocalGame();
      return;
    }
    if (source === 'online' && ui.online.game) {
      sendRealtime('game:rematch', { gameId: ui.online.game.gameId, action: 'accept' });
      updateResultForRematch(true);
    }
  }

  function openHistory() {
    ui.mode = 'history';
    showScreen('history-screen');
    $('history-list').innerHTML = '<div class="loading-state">Loading your games…</div>';
    loadHistory();
  }

  async function loadHistory() {
    try {
      const token = await ensureSession();
      const response = await fetch('/api/history', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (!response.ok) throw new Error('History is unavailable right now.');
      const data = await response.json();
      ui.history = data.games || [];
      renderHistory();
    } catch (error) {
      $('history-list').innerHTML = '<div class="empty-history">No games could be loaded. Reconnect and try again.</div>';
      showToast(error.message, true);
    }
  }

  function historyResultClass(record) {
    if (record.result === 'DRAW') return 'draw';
    const won = (record.result === 'WHITE_WINS' && record.yourColor === 'WHITE') || (record.result === 'BLACK_WINS' && record.yourColor === 'BLACK');
    return won ? 'win' : 'loss';
  }

  function historyResultText(record) {
    if (!record.result) return 'In progress';
    if (record.result === 'DRAW') return 'Draw';
    return historyResultClass(record) === 'win' ? 'Victory' : 'Defeat';
  }

  function renderHistory() {
    const list = $('history-list');
    if (!ui.history.length) {
      list.innerHTML = '<div class="empty-history">Your completed games will appear here.</div>';
      return;
    }
    list.innerHTML = ui.history.map((record) => {
      const date = record.finishedAt ? new Date(record.finishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Live game';
      return `<article class="history-item"><div><h3>${escapeHtml(record.timeControlLabel || 'Casual game')} · ${escapeHtml(date)}</h3><p>${record.moves.length} moves · ${escapeHtml(record.resultReasonLabel || 'Not finished')}</p></div><span class="history-result ${historyResultClass(record)}">${historyResultText(record)}</span><button class="history-replay" type="button" data-replay-id="${escapeHtml(record.gameId)}">Replay</button></article>`;
    }).join('');
    list.querySelectorAll('[data-replay-id]').forEach((button) => button.addEventListener('click', () => startReplay(button.dataset.replayId)));
  }

  function startReplay(gameId) {
    const record = ui.history.find((item) => item.gameId === gameId);
    if (!record) return;
    const engine = new ChessEngine(record.initialFen || ChessEngine.START_FEN);
    ui.replay = { record, index: 0, engine };
    ui.mode = 'replay';
    closeResult();
    showScreen('game-screen');
    renderReplay();
  }

  function replayTo(index) {
    if (!ui.replay) return;
    const record = ui.replay.record;
    const target = Math.max(0, Math.min(index, record.moves.length));
    const engine = new ChessEngine(record.initialFen || ChessEngine.START_FEN);
    for (let i = 0; i < target; i += 1) {
      const move = record.moves[i];
      engine.makeMove({ from: move.from, to: move.to, promotion: move.promotion || null });
    }
    ui.replay.index = target;
    ui.replay.engine = engine;
    renderReplay();
  }

  function leaveCurrentView() {
    if (ui.mode === 'replay') {
      ui.replay = null;
      openHistory();
      return;
    }
    if (ui.mode === 'local') {
      stopClockTimer();
      ui.mode = 'home';
      showScreen('home-screen');
      return;
    }
    // Keep the socket and server game alive. This is intentional: a short
    // navigation or page visibility change must not destroy an active game.
    ui.mode = 'home';
    showScreen('home-screen');
  }

  function goHome() {
    closePromotion();
    closeResult();
    if (ui.mode === 'local' || ui.mode === 'replay') stopClockTimer();
    ui.mode = 'home';
    setConnection(ui.online.socket ? ui.online.connection : 'idle', ui.online.socket ? undefined : 'Local play');
    showScreen('home-screen');
  }

  function bindEvents() {
    $('home-button').addEventListener('click', goHome);
    $('home-online-button').addEventListener('click', openOnlineLobby);
    $('home-local-button').addEventListener('click', startLocalGame);
    $('history-button').addEventListener('click', openHistory);
    document.querySelectorAll('[data-back-home]').forEach((button) => button.addEventListener('click', goHome));
    $('create-room-button').addEventListener('click', createRoom);
    $('join-room-button').addEventListener('click', joinRoom);
    $('room-code-input').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
    $('room-code-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') joinRoom(); });
    $('cancel-room-button').addEventListener('click', cancelRoom);
    $('copy-code-button').addEventListener('click', () => copyText(ui.online.room && ui.online.room.roomCode, 'Room code copied.'));
    $('copy-link-button').addEventListener('click', () => copyText(inviteLink(), 'Invite link copied.'));
    $('leave-game-button').addEventListener('click', leaveCurrentView);
    $('new-local-game-button').addEventListener('click', startLocalGame);
    $('draw-button').addEventListener('click', drawAction);
    $('decline-draw-button').addEventListener('click', declineDraw);
    $('resign-button').addEventListener('click', resign);
    $('rematch-button').addEventListener('click', resultRematch);
    $('result-exit-button').addEventListener('click', goHome);
    $('replay-first-button').addEventListener('click', () => replayTo(0));
    $('replay-prev-button').addEventListener('click', () => replayTo((ui.replay ? ui.replay.index : 0) - 1));
    $('replay-next-button').addEventListener('click', () => replayTo((ui.replay ? ui.replay.index : 0) + 1));
    $('replay-last-button').addEventListener('click', () => replayTo(ui.replay ? ui.replay.record.moves.length : 0));
  }

  function boot() {
    miniBoard();
    bindEvents();
    // A shared invite link opens the online lobby with the code prefilled, but
    // does not create a realtime session until the user chooses to join.
    const queryCode = new URLSearchParams(window.location.search).get('room');
    if (queryCode && /^\d{6}$/.test(queryCode)) openOnlineLobby();
  }

  document.addEventListener('DOMContentLoaded', boot);
}());
