// Go — game logic
// The board model below is the single source of truth. The visual board (grid
// lines, star points, and clickable intersections) is GENERATED from JS in
// buildBoard(), and every intersection is rendered from this model — which is
// what lets us answer questions like "does this group still have liberties?"

const SIZE = 13;
const KOMI = 7.5;     // points added to White to offset Black's first-move advantage

let board;            // SIZE x SIZE grid of null | 'black' | 'white'
let turn;             // whose move it is
let captures;         // { black, white } = stones each color has captured
let passes;           // consecutive passes (two in a row ends the game)
let gameOver;
let history;          // Set of past board positions, for the ko / repetition rule
let scoring;          // true once the game has ended and we're counting territory
let dead;             // Set of "r,c" stones marked dead during scoring
let mode = 'human';   // 'human' (two players) | 'computer' (vs the AI)
let humanColor = 'black';
let aiColor = 'white';

const opponent = color => (color === 'black' ? 'white' : 'black');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// --- core engine ----------------------------------------------------------

// The (up to four) orthogonally-adjacent points that are still on the board.
function neighbors(r, c) {
  const out = [];
  if (r > 0) out.push([r - 1, c]);
  if (r < SIZE - 1) out.push([r + 1, c]);
  if (c > 0) out.push([r, c - 1]);
  if (c < SIZE - 1) out.push([r, c + 1]);
  return out;
}

// Flood-fill from (r,c) across same-colored, connected stones.
// Returns the whole group and how many liberties (empty adjacent points) it has.
function groupAt(r, c, color, b) {
  const stack = [[r, c]];
  const seen = new Set([`${r},${c}`]);
  const stones = [];
  const liberties = new Set();
  while (stack.length) {
    const [cr, cc] = stack.pop();
    stones.push([cr, cc]);
    for (const [nr, nc] of neighbors(cr, cc)) {
      const v = b[nr][nc];
      const key = `${nr},${nc}`;
      if (v === null) {
        liberties.add(key);
      } else if (v === color && !seen.has(key)) {
        seen.add(key);
        stack.push([nr, nc]);
      }
    }
  }
  return { stones, liberties: liberties.size };
}

// Serialize a board position so we can detect repetition (the ko rule).
function hash(b) {
  return b.map(row => row.map(v => (v ? v[0] : '.')).join('')).join('/');
}

const cloneBoard = b => b.map(row => row.slice());

// Resolve placing `color` at (r,c) on board `b`, applying captures and the
// suicide rule. Returns { board, captured } for the resulting position, or
// null if the point is occupied or the move is suicide. (Ko is checked
// separately by the caller, since it needs the game's position history.)
function resolveMove(b, color, r, c) {
  if (b[r][c] !== null) return null;
  const nb = cloneBoard(b);
  nb[r][c] = color;
  const foe = opponent(color);

  // Remove any adjacent enemy group left with zero liberties.
  let captured = 0;
  for (const [nr, nc] of neighbors(r, c)) {
    if (nb[nr][nc] === foe) {
      const group = groupAt(nr, nc, foe, nb);
      if (group.liberties === 0) {
        for (const [gr, gc] of group.stones) nb[gr][gc] = null;
        captured += group.stones.length;
      }
    }
  }

  // Suicide: a stone whose own group has no liberties after captures is illegal.
  // (If we captured anything, a liberty was freed, so zero here means self-capture.)
  if (groupAt(r, c, color, nb).liberties === 0) return null;
  return { board: nb, captured };
}

// Attempt to place `turn`'s stone at (r,c). Returns { ok, reason, captured }.
// Nothing is committed unless the move is fully legal.
function tryMove(r, c) {
  if (gameOver) return { ok: false, reason: 'The game is over.' };
  if (board[r][c] !== null) return { ok: false, reason: 'There is already a stone there.' };

  const res = resolveMove(board, turn, r, c);
  if (!res) return { ok: false, reason: 'Illegal move: suicide is not allowed.' };
  if (history.has(hash(res.board))) {
    return { ok: false, reason: 'Illegal move: ko — you cannot recreate a previous board position.' };
  }

  // Commit.
  board = res.board;
  captures[turn] += res.captured;
  history.add(hash(res.board));
  passes = 0;
  turn = opponent(turn);
  return { ok: true, captured: res.captured };
}

// --- actions --------------------------------------------------------------

function pass() {
  if (gameOver) return;
  passes += 1;
  if (passes >= 2) {
    gameOver = true;
    scoring = true;
    setMessage('Game over. Click any dead stones to remove them — the score updates live.');
    renderScoring();
    updateStatus();
  } else {
    setMessage(`${cap(turn)} passed.`);
    turn = opponent(turn);
    render();
    updateStatus();
    scheduleAi();
  }
}

function resign() {
  if (gameOver) return;
  gameOver = true;
  setMessage(`${cap(turn)} resigned — ${cap(opponent(turn))} wins!`);
  updateStatus();
}

function newGame() {
  board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  turn = 'black';
  captures = { black: 0, white: 0 };
  passes = 0;
  gameOver = false;
  scoring = false;
  dead = new Set();
  history = new Set([hash(board)]);
  setMessage('');
  setScore('');
  render();
  updateStatus();
  scheduleAi();   // if the computer plays Black, it moves first
}

// --- scoring (area / Chinese rules) ---------------------------------------

// Compute the result given the current board and the stones marked dead.
// Area score = your living stones on the board + empty territory surrounded
// only by your color. White additionally receives komi.
function computeScore() {
  // Effective board: dead stones are treated as removed (captured).
  const b = cloneBoard(board);
  for (const key of dead) {
    const [r, c] = key.split(',').map(Number);
    b[r][c] = null;
  }

  const territory = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  let blackStones = 0;
  let whiteStones = 0;
  let blackTerr = 0;
  let whiteTerr = 0;
  const visited = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] === 'black') blackStones++;
      else if (b[r][c] === 'white') whiteStones++;
      else if (!visited[r][c]) {
        // Flood-fill this empty region and note which colors border it.
        const region = [];
        const borders = new Set();
        const stack = [[r, c]];
        visited[r][c] = true;
        while (stack.length) {
          const [cr, cc] = stack.pop();
          region.push([cr, cc]);
          for (const [nr, nc] of neighbors(cr, cc)) {
            const v = b[nr][nc];
            if (v === null) {
              if (!visited[nr][nc]) {
                visited[nr][nc] = true;
                stack.push([nr, nc]);
              }
            } else {
              borders.add(v);
            }
          }
        }
        // A region touching exactly one color is that color's territory.
        const owner = borders.size === 1 ? [...borders][0] : null;
        if (owner === 'black') blackTerr += region.length;
        else if (owner === 'white') whiteTerr += region.length;
        if (owner) for (const [tr, tc] of region) territory[tr][tc] = owner;
      }
    }
  }

  const blackScore = blackStones + blackTerr;
  const whiteScore = whiteStones + whiteTerr + KOMI;
  return { territory, blackStones, whiteStones, blackTerr, whiteTerr, blackScore, whiteScore };
}

// In scoring mode, clicking a stone toggles its whole group's dead/alive state.
function toggleDead(r, c) {
  if (board[r][c] === null) return;
  const { stones } = groupAt(r, c, board[r][c], board);
  const isDead = dead.has(`${r},${c}`);
  for (const [gr, gc] of stones) {
    if (isDead) dead.delete(`${gr},${gc}`);
    else dead.add(`${gr},${gc}`);
  }
  renderScoring();
  updateStatus();
}

// --- computer opponent (heuristic) ----------------------------------------

// Is (r,c) an eye for `color`? (an empty point the AI should not fill itself).
// Standard heuristic: every orthogonal neighbor is `color`, and enough diagonals
// are too — all of them on an edge/corner, or at least 3 of 4 in open space.
function isEye(b, color, r, c) {
  if (b[r][c] !== null) return false;
  for (const [nr, nc] of neighbors(r, c)) {
    if (b[nr][nc] !== color) return false;
  }
  const diagonals = [[r - 1, c - 1], [r - 1, c + 1], [r + 1, c - 1], [r + 1, c + 1]]
    .filter(([dr, dc]) => dr >= 0 && dr < SIZE && dc >= 0 && dc < SIZE);
  const friendly = diagonals.filter(([dr, dc]) => b[dr][dc] === color).length;
  const offBoard = 4 - diagonals.length;
  return offBoard > 0 ? friendly === diagonals.length : friendly >= 3;
}

// Total number of `color` stones that are in atari (their group has 1 liberty).
function countAtari(b, color) {
  const seen = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  let total = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] === color && !seen[r][c]) {
        const group = groupAt(r, c, color, b);
        for (const [gr, gc] of group.stones) seen[gr][gc] = true;
        if (group.liberties === 1) total += group.stones.length;
      }
    }
  }
  return total;
}

// Score a resolved candidate move for `color`. Higher is better.
function evaluateMove(res, color, r, c) {
  const nb = res.board;
  let s = res.captured * 12;                              // capturing is great

  const ownLiberties = groupAt(r, c, color, nb).liberties;
  if (res.captured === 0 && ownLiberties === 1) s -= 8;  // walking into self-atari

  s -= countAtari(nb, color) * 1.5;                      // keep own groups safe
  s += countAtari(nb, opponent(color)) * 1.0;           // pressure enemy groups

  let contact = 0;                                       // build connected shapes
  for (const [nr, nc] of neighbors(r, c)) if (board[nr][nc] !== null) contact++;
  s += contact * 0.6;

  return s;
}

// Pick the AI's move: the best-scoring legal point, or null to pass.
function chooseAiMove() {
  let best = null;
  let bestScore = -Infinity;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== null) continue;
      if (isEye(board, aiColor, r, c)) continue;         // never fill its own eyes
      const res = resolveMove(board, aiColor, r, c);
      if (!res) continue;                                // occupied or suicide
      if (history.has(hash(res.board))) continue;        // ko
      const score = evaluateMove(res, aiColor, r, c) + Math.random() * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = [r, c];
      }
    }
  }
  if (!best) return null;                                // no legal move -> pass
  if (passes >= 1 && bestScore < 3) return null;         // opponent passed, nothing useful -> agree to end
  if (bestScore < -6) return null;                       // only terrible moves left -> pass
  return best;
}

// If it's the computer's turn, let it move shortly (so the UI repaints first).
function scheduleAi() {
  if (mode === 'computer' && !gameOver && !scoring && turn === aiColor) {
    setTimeout(aiMove, 350);
  }
}

function aiMove() {
  if (mode !== 'computer' || gameOver || scoring || turn !== aiColor) return;
  const move = chooseAiMove();
  if (!move) {
    pass();
    return;
  }
  const res = tryMove(move[0], move[1]);
  if (!res.ok) {            // shouldn't happen — candidates are pre-validated
    pass();
    return;
  }
  setMessage(res.captured ? `Computer captured ${res.captured} stone${res.captured > 1 ? 's' : ''}.` : '');
  render();
  updateStatus();
  scheduleAi();
}

// --- board construction ---------------------------------------------------

const CELL = 44;                       // pixels between adjacent intersections
const MARGIN = 32;                     // tan border between the outer line and the frame
const SPAN = (SIZE - 1) * CELL;        // distance across all lines
const SURFACE = SPAN + MARGIN * 2;     // full board surface size
const STONE = 40;                      // stone diameter
const SVGNS = 'http://www.w3.org/2000/svg';
// Star points (hoshi) for a 13x13 board: the four 4-4 points plus tengen (center).
const STARS = [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]];

let pointEls = [];                     // pointEls[r][c] -> the intersection's DOM node

// The intersection coordinate (in pixels) for row r / column c.
const coord = k => MARGIN + k * CELL;

function buildBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  boardEl.style.width = `${SURFACE}px`;
  boardEl.style.height = `${SURFACE}px`;
  boardEl.style.setProperty('--stone', `${STONE}px`);
  boardEl.style.setProperty('--cell', `${CELL}px`);

  // Grid lines + star points drawn once as a crisp SVG layer.
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'lines');
  svg.setAttribute('viewBox', `0 0 ${SURFACE} ${SURFACE}`);

  let d = '';
  for (let k = 0; k < SIZE; k++) {
    const p = coord(k);
    d += `M${MARGIN} ${p}H${MARGIN + SPAN}`;   // horizontal line
    d += `M${p} ${MARGIN}V${MARGIN + SPAN}`;   // vertical line
  }
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('class', 'gridline');
  path.setAttribute('d', d);
  svg.appendChild(path);

  for (const [i, j] of STARS) {
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('class', 'star');
    dot.setAttribute('cx', coord(j));
    dot.setAttribute('cy', coord(i));
    dot.setAttribute('r', 3.5);
    svg.appendChild(dot);
  }
  boardEl.appendChild(svg);

  // A clickable point sits on every intersection, holding a (hidden) stone.
  pointEls = [];
  for (let i = 0; i < SIZE; i++) {
    pointEls[i] = [];
    for (let j = 0; j < SIZE; j++) {
      const pt = document.createElement('div');
      pt.className = 'point';
      pt.style.left = `${coord(j)}px`;
      pt.style.top = `${coord(i)}px`;
      pt.dataset.r = i;
      pt.dataset.c = j;
      pt.appendChild(document.createElement('span')).className = 'stone';
      boardEl.appendChild(pt);
      pointEls[i][j] = pt;
    }
  }
}

// --- rendering ------------------------------------------------------------

function render() {
  for (let i = 0; i < SIZE; i++) {
    for (let j = 0; j < SIZE; j++) {
      const v = board[i][j];
      pointEls[i][j].className = v ? `point ${v}` : 'point';
    }
  }
}

// Overlay dead-stone marks and territory dots on top of the rendered board,
// and update the live score readout.
function renderScoring() {
  render();
  const score = computeScore();
  for (let i = 0; i < SIZE; i++) {
    for (let j = 0; j < SIZE; j++) {
      const pt = pointEls[i][j];
      if (dead.has(`${i},${j}`)) {
        pt.classList.add('dead');
      } else if (score.territory[i][j] === 'black') {
        pt.classList.add('terr-black');
      } else if (score.territory[i][j] === 'white') {
        pt.classList.add('terr-white');
      }
    }
  }

  const { blackScore, whiteScore } = score;
  const margin = Math.abs(blackScore - whiteScore);
  let result;
  if (blackScore === whiteScore) result = "It's a tie!";
  else result = `${blackScore > whiteScore ? 'Black' : 'White'} leads by ${margin}`;
  setScore(`Black ${blackScore} — White ${whiteScore} (incl. ${KOMI} komi) · ${result}`);
}

function updateStatus() {
  let indicator;
  if (scoring) indicator = 'Scoring';
  else if (gameOver) indicator = 'Game Over';
  else if (mode === 'computer') indicator = turn === humanColor ? `Your move (${cap(humanColor)})` : 'Computer thinking…';
  else indicator = `${cap(turn)} Stone`;
  document.getElementById('indicator').textContent = indicator;
  document.getElementById('black-captures').textContent = `Black captured: ${captures.black}`;
  document.getElementById('white-captures').textContent = `White captured: ${captures.white}`;

  // Let the CSS tint the hover preview in the player-to-move's color.
  const boardEl = document.getElementById('board');
  boardEl.classList.toggle('black-turn', !gameOver && turn === 'black');
  boardEl.classList.toggle('white-turn', !gameOver && turn === 'white');
}

function setMessage(text) {
  document.getElementById('message').textContent = text;
}

function setScore(text) {
  document.getElementById('score').textContent = text;
}

// --- wiring ---------------------------------------------------------------

$(function () {
  buildBoard();

  $('#board').on('click', '.point', function () {
    const r = +this.dataset.r;
    const c = +this.dataset.c;
    if (scoring) {
      toggleDead(r, c);
      return;
    }
    if (mode === 'computer' && turn === aiColor) return;   // not your turn
    const result = tryMove(r, c);
    if (result.ok) {
      setMessage(result.captured ? `${cap(opponent(turn))} captured ${result.captured} stone${result.captured > 1 ? 's' : ''}.` : '');
      render();
      updateStatus();
      scheduleAi();
    } else {
      setMessage(result.reason);
    }
  });

  $('#pass').on('click', () => {
    if (mode === 'computer' && turn === aiColor) return;   // wait for the computer
    pass();
  });
  $('#resign').on('click', () => {
    if (mode === 'computer' && turn === aiColor) return;
    resign();
  });
  $('#newgame').on('click', newGame);

  // Opponent / color selection — applying it starts a fresh game.
  $('input[name=mode], input[name=pcolor]').on('change', () => {
    mode = $('input[name=mode]:checked').val();
    humanColor = $('input[name=pcolor]:checked').val();
    aiColor = opponent(humanColor);
    $('#color-choice').toggleClass('hidden', mode !== 'computer');
    newGame();
  });

  // Rules modal: open on button, close on ✕, on backdrop click, or on Escape.
  const closeRules = () => $('#rules-overlay').addClass('hidden');
  $('#rules').on('click', () => $('#rules-overlay').removeClass('hidden'));
  $('#rules-close').on('click', closeRules);
  $('#rules-overlay').on('click', evt => {
    if (evt.target.id === 'rules-overlay') closeRules();
  });
  $(document).on('keydown', evt => {
    if (evt.key === 'Escape') closeRules();
  });

  newGame();
});
