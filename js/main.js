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
let difficulty = 'easy';  // 'easy' (heuristic) | 'hard' (MCTS)
let aiToken = 0;          // bumped each new game to cancel an in-flight MCTS search

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
// Uses integer point ids + typed-array visited buffers (no string keys) because
// this is the hottest function in the MCTS rollouts.
function groupAt(r, c, color, b) {
  const seen = new Uint8Array(SIZE * SIZE);
  const libSeen = new Uint8Array(SIZE * SIZE);
  const start = r * SIZE + c;
  const stack = [start];
  seen[start] = 1;
  const stones = [];
  let liberties = 0;
  while (stack.length) {
    const id = stack.pop();
    const cr = (id / SIZE) | 0;
    const cc = id % SIZE;
    stones.push([cr, cc]);
    for (let d = 0; d < 4; d++) {
      const nr = cr + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const nc = cc + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
      const nid = nr * SIZE + nc;
      const v = b[nr][nc];
      if (v === null) {
        if (!libSeen[nid]) { libSeen[nid] = 1; liberties++; }
      } else if (v === color && !seen[nid]) {
        seen[nid] = 1;
        stack.push(nid);
      }
    }
  }
  return { stones, liberties };
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
  const capturedStones = [];
  for (const [nr, nc] of neighbors(r, c)) {
    if (nb[nr][nc] === foe) {
      const group = groupAt(nr, nc, foe, nb);
      if (group.liberties === 0) {
        for (const [gr, gc] of group.stones) {
          nb[gr][gc] = null;
          capturedStones.push([gr, gc]);
        }
        captured += group.stones.length;
      }
    }
  }

  // Suicide: a stone whose own group has no liberties after captures is illegal.
  // (If we captured anything, a liberty was freed, so zero here means self-capture.)
  if (groupAt(r, c, color, nb).liberties === 0) return null;
  return { board: nb, captured, capturedStones };
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
  aiToken += 1;   // cancel any MCTS search still running from a previous game
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

// Is it currently the computer's turn to move?
function aiToMove() {
  return mode === 'computer' && !gameOver && !scoring && turn === aiColor;
}

// If it's the computer's turn, let it move shortly (so the UI repaints first).
function scheduleAi() {
  if (!aiToMove()) return;
  if (difficulty === 'hard') setTimeout(aiMoveHard, 60);
  else setTimeout(aiMoveEasy, 350);
}

// Commit the computer's chosen move (or pass) and hand the turn back.
function applyAiMove(move) {
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

function aiMoveEasy() {
  if (!aiToMove()) return;
  applyAiMove(chooseAiMove());
}

function aiMoveHard() {
  if (!aiToMove()) return;
  const token = aiToken;
  mctsSearch(move => {
    if (token === aiToken && aiToMove()) applyAiMove(move);
  });
}

// --- computer opponent (Monte Carlo Tree Search) --------------------------

const MCTS_TIME_MS = 1500;   // thinking budget per move
const UCT_C = 1.414;         // exploration constant

// Area score of a fully-played-out board (no dead-stone concept in rollouts).
function scoreBoard(b) {
  let black = 0;
  let white = 0;
  const visited = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] === 'black') black++;
      else if (b[r][c] === 'white') white++;
      else if (!visited[r][c]) {
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
              if (!visited[nr][nc]) { visited[nr][nc] = true; stack.push([nr, nc]); }
            } else {
              borders.add(v);
            }
          }
        }
        if (borders.size === 1) {
          if ([...borders][0] === 'black') black += region.length;
          else white += region.length;
        }
      }
    }
  }
  return { black, white };
}

// An empty-point list with O(1) add/remove, indexed by point id = r*SIZE + c.
// This lets a rollout mutate one board in place instead of cloning every move.
function eAdd(id, empties, pos) {
  if (pos[id] >= 0) return;
  pos[id] = empties.length;
  empties.push(id);
}
function eRemove(id, empties, pos) {
  const i = pos[id];
  if (i < 0) return;
  const lastId = empties[empties.length - 1];
  empties[i] = lastId;
  pos[lastId] = i;
  empties.pop();
  pos[id] = -1;
}

// Place `color` at (r,c) on board `b` IN PLACE, removing captured groups and
// keeping the empties list current. Returns the capture count, or -1 (and
// reverts) if the move is suicide. No whole-board cloning — this is the hot path.
function playoutPlace(b, color, r, c, empties, pos) {
  b[r][c] = color;
  const foe = opponent(color);
  let captured = 0;
  for (const [nr, nc] of neighbors(r, c)) {
    if (b[nr][nc] === foe) {
      const g = groupAt(nr, nc, foe, b);
      if (g.liberties === 0) {
        for (const [gr, gc] of g.stones) {
          b[gr][gc] = null;
          eAdd(gr * SIZE + gc, empties, pos);
          captured++;
        }
      }
    }
  }
  if (captured === 0 && groupAt(r, c, color, b).liberties === 0) {
    b[r][c] = null;   // suicide — revert (no captures happened to undo)
    return -1;
  }
  eRemove(r * SIZE + c, empties, pos);
  return captured;
}

// If the group at (r,c) has exactly one liberty, return it [lr,lc]; else null.
function singleLiberty(b, r, c, color) {
  const seen = new Uint8Array(SIZE * SIZE);
  const start = r * SIZE + c;
  seen[start] = 1;
  const stack = [start];
  let libId = -1;
  while (stack.length) {
    const id = stack.pop();
    const cr = (id / SIZE) | 0;
    const cc = id % SIZE;
    for (let d = 0; d < 4; d++) {
      const nr = cr + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const nc = cc + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
      const v = b[nr][nc];
      if (v === null) {
        const lid = nr * SIZE + nc;
        if (libId === -1) libId = lid;
        else if (libId !== lid) return null;   // more than one liberty
      } else if (v === color && !seen[nr * SIZE + nc]) {
        seen[nr * SIZE + nc] = 1;
        stack.push(nr * SIZE + nc);
      }
    }
  }
  return libId === -1 ? null : [(libId / SIZE) | 0, libId % SIZE];
}

// "Heavy" playout move: respond to ataris created by the opponent's last move —
// capture an enemy group in atari, or save one of our own. Returns [r,c] or null.
function heavyMove(b, color, lastR, lastC) {
  if (lastR < 0) return null;
  const foe = opponent(color);
  let captures = null;
  let saves = null;
  const around = [[lastR, lastC], [lastR - 1, lastC], [lastR + 1, lastC], [lastR, lastC - 1], [lastR, lastC + 1]];
  for (const [r, c] of around) {
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
    const v = b[r][c];
    if (v === foe) {
      const lib = singleLiberty(b, r, c, foe);
      if (lib) (captures || (captures = [])).push(lib);
    } else if (v === color) {
      const lib = singleLiberty(b, r, c, color);
      if (lib) (saves || (saves = [])).push(lib);
    }
  }
  const pool = captures || saves;   // capturing is preferred over saving
  return pool ? pool[(Math.random() * pool.length) | 0] : null;
}

// Play a (tactically-biased) random game to the end and return the area-scoring
// winner. Fast in-place rollout: one board copy, then mutate.
function rollout(startBoard, startColor) {
  const b = startBoard.map(row => row.slice());
  let color = startColor;
  let passes = 0;
  let lastR = -1;
  let lastC = -1;
  const empties = [];
  const pos = new Array(SIZE * SIZE).fill(-1);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] === null) { pos[r * SIZE + c] = empties.length; empties.push(r * SIZE + c); }
    }
  }
  const maxMoves = SIZE * SIZE * 2;

  for (let m = 0; m < maxMoves && passes < 2; m++) {
    let placed = false;

    // 1. Tactical response most of the time.
    if (Math.random() < 0.9) {
      const hm = heavyMove(b, color, lastR, lastC);
      if (hm && playoutPlace(b, color, hm[0], hm[1], empties, pos) >= 0) {
        lastR = hm[0]; lastC = hm[1]; placed = true;
      }
    }
    // 2. A few random (non-eye) tries.
    for (let t = 0; !placed && t < 8 && empties.length; t++) {
      const id = empties[(Math.random() * empties.length) | 0];
      const r = (id / SIZE) | 0;
      const c = id % SIZE;
      if (isEye(b, color, r, c)) continue;
      if (playoutPlace(b, color, r, c, empties, pos) >= 0) { lastR = r; lastC = c; placed = true; }
    }
    // 3. Exhaustive scan so we don't pass while a legal move remains.
    for (let i = 0; !placed && i < empties.length; i++) {
      const id = empties[i];
      const r = (id / SIZE) | 0;
      const c = id % SIZE;
      if (isEye(b, color, r, c)) continue;
      if (playoutPlace(b, color, r, c, empties, pos) >= 0) { lastR = r; lastC = c; placed = true; }
    }

    if (!placed) { passes++; lastR = -1; lastC = -1; }
    else passes = 0;
    color = opponent(color);
  }

  const s = scoreBoard(b);
  return s.black > s.white + KOMI ? 'black' : 'white';
}

function makeNode(b, toMove, passes, move, parent) {
  return {
    board: b, toMove, passes, move, parent,
    children: [], untried: null, visits: 0, wins: 0,
    terminal: passes >= 2,
  };
}

// Legal moves at a node: every non-eye, non-suicide point, plus 'pass'.
function nodeMoves(node) {
  if (node.untried !== null) return node.untried;
  if (node.terminal) { node.untried = []; return node.untried; }
  const moves = [];
  const { board: b, toMove } = node;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] !== null) continue;
      if (isEye(b, toMove, r, c)) continue;
      if (resolveMove(b, toMove, r, c)) moves.push([r, c]);
    }
  }
  moves.push('pass');
  node.untried = moves;
  return moves;
}

function selectChild(node) {
  const logParent = Math.log(node.visits);
  let best = null;
  let bestVal = -Infinity;
  for (const child of node.children) {
    const val = child.wins / child.visits + UCT_C * Math.sqrt(logParent / child.visits);
    if (val > bestVal) { bestVal = val; best = child; }
  }
  return best;
}

function expandChild(node, move) {
  let childBoard;
  let childPasses;
  if (move === 'pass') {
    childBoard = node.board;
    childPasses = node.passes + 1;
  } else {
    childBoard = resolveMove(node.board, node.toMove, move[0], move[1]).board;
    childPasses = 0;
  }
  const child = makeNode(childBoard, opponent(node.toMove), childPasses, move, node);
  node.children.push(child);
  return child;
}

function mctsIteration(root) {
  let node = root;

  // Selection: descend through fully-expanded, non-terminal nodes.
  while (!node.terminal && nodeMoves(node).length === 0 && node.children.length > 0) {
    node = selectChild(node);
  }

  // Expansion: try one new move from this node.
  if (!node.terminal) {
    const untried = nodeMoves(node);
    if (untried.length > 0) {
      const i = (Math.random() * untried.length) | 0;
      const move = untried.splice(i, 1)[0];
      node = expandChild(node, move);
    }
  }

  // Simulation + backpropagation.
  const winner = rollout(node.board, node.toMove);
  for (let n = node; n; n = n.parent) {
    n.visits++;
    if (winner === opponent(n.toMove)) n.wins++;   // credit the side that moved into n
  }
}

// Restrict the root to the heuristic's best candidates (plus pass), so the
// search refines among sensible moves instead of spreading thin over ~170 —
// this is what makes a 1.5s budget enough to value captures and defense.
const ROOT_CANDIDATES = 18;
const TACTICAL_WEIGHT = 0.3;   // how strongly the heuristic biases the final pick
function prunedRootMoves(node) {
  const b = node.board;
  const color = node.toMove;
  const scored = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (b[r][c] !== null || isEye(b, color, r, c)) continue;
      const res = resolveMove(b, color, r, c);
      if (res) scored.push({ move: [r, c], score: evaluateMove(res, color, r, c) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, ROOT_CANDIDATES);
  // Remember each candidate's heuristic score (min–max normalized across the
  // candidates) so the final pick can favor clear tactics — captures AND
  // atari-defense — that MCTS alone is indifferent to, regardless of scale.
  const hi = top.length ? top[0].score : 0;
  const lo = top.length ? top[top.length - 1].score : 0;
  const span = hi - lo;
  node.priors = { pass: 0 };
  for (const { move, score } of top) {
    node.priors[move.join(',')] = span > 0 ? (score - lo) / span : 0;
  }
  return [...top.map(s => s.move), 'pass'];
}

// Run MCTS on a time budget (sliced so the UI stays responsive), then call
// done(bestMove) where bestMove is [r,c] or null (= pass).
function mctsSearch(done) {
  const root = makeNode(board, turn, passes, null, null);
  root.untried = prunedRootMoves(root);   // search only sensible root moves
  const token = aiToken;
  const deadline = Date.now() + MCTS_TIME_MS;

  (function slice() {
    if (token !== aiToken) return;   // a new game cancelled this search
    const sliceEnd = Date.now() + 25;
    while (Date.now() < sliceEnd) {
      for (let i = 0; i < 30; i++) mctsIteration(root);
    }
    if (Date.now() < deadline) {
      setTimeout(slice, 0);
    } else {
      done(bestRootMove(root));
    }
  })();
}

// Pick the move with the best blend of MCTS win-rate and heuristic value, so
// clear tactics are taken unless another move is decisively more winning.
function bestRootMove(root) {
  const priors = root.priors || {};
  let best = null;
  let bestValue = -Infinity;
  for (const child of root.children) {
    if (child.visits === 0) continue;
    const winRate = child.wins / child.visits;
    const key = child.move === 'pass' ? 'pass' : child.move.join(',');
    const prior = priors[key] || 0;   // already normalized to [0,1]
    const value = winRate + TACTICAL_WEIGHT * prior;
    if (value > bestValue) { bestValue = value; best = child; }
  }
  if (!best || best.move === 'pass') return null;
  return best.move;
}

// --- board construction ---------------------------------------------------

const CELL_MAX = 44;                   // largest spacing between intersections (desktop)
const SVGNS = 'http://www.w3.org/2000/svg';
// Star points (hoshi) for a 13x13 board: the four 4-4 points plus tengen (center).
const STARS = [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]];

let CELL;     // pixels between adjacent intersections (sized to fit the viewport)
let MARGIN;   // tan border between the outer line and the frame
let SPAN;     // distance across all lines
let SURFACE;  // full board surface size
let STONE;    // stone diameter
let pointEls = [];                     // pointEls[r][c] -> the intersection's DOM node

// The intersection coordinate (in pixels) for row r / column c.
const coord = k => MARGIN + k * CELL;

// Size the board to the available space so it fits phones and desktops alike.
function computeDimensions() {
  const usableW = Math.min(window.innerWidth, 640) - 32 - 24;  // page padding + wood frame
  const usableH = window.innerHeight - 240;                    // leave room for the controls
  const target = Math.max(200, Math.min(usableW, usableH, 592));
  CELL = Math.max(15, Math.min(CELL_MAX, Math.floor(target / 13.4)));
  MARGIN = Math.round(CELL * 0.7);
  STONE = Math.round(CELL * 0.92);
  SPAN = (SIZE - 1) * CELL;
  SURFACE = SPAN + MARGIN * 2;
}

function buildBoard() {
  computeDimensions();
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
    dot.setAttribute('r', Math.max(2, CELL * 0.08));
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

  // Opponent / color / level selection — applying it starts a fresh game.
  $('input[name=mode], input[name=pcolor], input[name=level]').on('change', () => {
    mode = $('input[name=mode]:checked').val();
    humanColor = $('input[name=pcolor]:checked').val();
    aiColor = opponent(humanColor);
    difficulty = $('input[name=level]:checked').val();
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

  // Re-fit the board when the viewport changes (rotation, resize) without
  // disturbing the game — the board model is preserved, only the DOM is redrawn.
  let resizeTimer;
  $(window).on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const before = CELL;
      computeDimensions();
      if (CELL !== before) {
        buildBoard();
        if (scoring) renderScoring(); else render();
        updateStatus();
      }
    }, 150);
  });

  newGame();
});

// Register the service worker so the app is installable and works offline.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
