'use strict';
// Server-side Ludo rules. Same board as the app (lib/game/ludo_engine.dart),
// but the dice are always fair: every face has the same chance. The only
// limit is the usual one: after two sixes in a row the third roll is 1-5.

const COLORS = ['red', 'green', 'yellow', 'blue'];
const START = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const IN_BASE = -1, LAST_TRACK = 50, FINISHED = 56, TRACK = 52;

function makePlayer(color, seat) {
  return { color, seat, tokens: [IN_BASE, IN_BASE, IN_BASE, IN_BASE], team: seat.team ?? null };
}

class Ludo {
  // seats: [{ id, team? }] in turn order; colors are given out by seat count.
  constructor(seats, { needed = 1, rng = Math.random } = {}) {
    const colors = seats.length === 2 ? ['red', 'yellow'] : COLORS.slice(0, seats.length);
    this.players = seats.map((s, i) => ({ id: s.id, color: colors[i], team: s.team ?? null, tokens: [-1, -1, -1, -1] }));
    this.current = 0;
    this.dice = null;
    this.sixesInRow = 0;
    this.finishOrder = [];
    this.needed = needed; // how many finishers end the game (4-player: 2)
    this.over = false;
    this.rng = rng;
  }

  get turn() { return this.players[this.current]; }
  finished(p) { return p.tokens.every(t => t === FINISHED); }
  global(p, t) { return t >= 0 && t <= LAST_TRACK ? (START[p.color] + t) % TRACK : null; }
  sameSide(a, b) { return a === b || (a.team !== null && a.team === b.team); }
  canMove(t, d) { if (t === FINISHED) return false; if (t === IN_BASE) return d === 6; return t + d <= FINISHED; }
  movable() { const d = this.dice; if (d == null) return []; return this.turn.tokens.map((t, i) => this.canMove(t, d) ? i : -1).filter(i => i >= 0); }

  roll() {
    if (this.over || this.dice != null) throw new Error('cannot roll');
    const v = this.sixesInRow >= 2 ? 1 + Math.floor(this.rng() * 5) : 1 + Math.floor(this.rng() * 6);
    if (v === 6) this.sixesInRow++;
    this.dice = v;
    const moves = this.movable();
    const by = this.turn.id;
    if (moves.length === 0) this.advance();
    return { value: v, by, moves };
  }

  move(i) {
    const d = this.dice, p = this.turn;
    if (d == null || this.over) throw new Error('roll first');
    if (!this.canMove(p.tokens[i], d)) throw new Error('bad token');
    const from = p.tokens[i];
    p.tokens[i] = from === IN_BASE ? 0 : from + d;
    const captured = [];
    const g = this.global(p, p.tokens[i]);
    if (g !== null && !SAFE.has(g)) {
      for (const o of this.players) {
        if (this.sameSide(o, p)) continue;
        o.tokens.forEach((t, j) => { if (this.global(o, t) === g) { o.tokens[j] = IN_BASE; captured.push({ id: o.id, token: j }); } });
      }
    }
    this.dice = null;
    if (this.finished(p) && !this.finishOrder.includes(p.id)) { this.finishOrder.push(p.id); this.checkOver(); }
    const extra = !this.over && !this.finished(p) && (d === 6 || captured.length > 0 || p.tokens[i] === FINISHED);
    if (!extra) this.advance(); else if (d !== 6) this.sixesInRow = 0;
    return { by: p.id, token: i, from, to: p.tokens[i], captured, extra };
  }

  checkOver() {
    const teams = this.players.some(p => p.team !== null);
    if (teams) {
      for (const team of [0, 1]) {
        const m = this.players.filter(p => p.team === team);
        if (m.length && m.every(p => this.finished(p))) { this.over = true; this.winningTeam = team; return; }
      }
      return;
    }
    const left = this.players.filter(p => !this.finished(p)).length;
    if (this.finishOrder.length >= this.needed || left <= 1) this.over = true;
  }

  advance() {
    this.sixesInRow = 0; this.dice = null;
    if (this.over) return;
    for (let k = 1; k <= this.players.length; k++) {
      const n = (this.current + k) % this.players.length;
      if (!this.finished(this.players[n])) { this.current = n; return; }
    }
  }

  // Order of places at the end: finishers first, then by progress.
  ranking() {
    const score = p => p.tokens.reduce((s, t) => s + (t === IN_BASE ? 0 : t + 1), 0);
    const rest = this.players.filter(p => !this.finishOrder.includes(p.id)).sort((a, b) => score(b) - score(a)).map(p => p.id);
    return [...this.finishOrder, ...rest];
  }

  // Computer choice. level: easy = any legal move, normal = good move most of
  // the time, hard = best move by the same scoring the offline bot uses.
  botMove(level) {
    const opts = this.movable();
    if (opts.length === 0) return null;
    const r = this.rng();
    if (level === 'easy' || (level === 'normal' && r < 0.3)) return opts[Math.floor(this.rng() * opts.length)];
    let best = opts[0], bestScore = -Infinity;
    for (const i of opts) { const s = this.scoreMove(i, this.dice); if (s > bestScore) { bestScore = s; best = i; } }
    return best;
  }

  scoreMove(i, d) {
    const p = this.turn, t = p.tokens[i];
    if (t === IN_BASE) return 60;
    const target = t + d;
    if (target === FINISHED) return 90;
    let s = target / 10;
    if (target > LAST_TRACK) return s + 40;
    const g = (START[p.color] + target) % TRACK;
    if (!SAFE.has(g)) {
      for (const o of this.players) { if (this.sameSide(o, p)) continue; if (o.tokens.some(x => this.global(o, x) === g)) s += 100; }
      if (this.threatened(g, p)) s -= 30;
    } else s += 25;
    const cur = this.global(p, t);
    if (cur !== null && !SAFE.has(cur) && this.threatened(cur, p)) s += 20;
    return s;
  }

  threatened(sq, p) {
    for (const o of this.players) {
      if (this.sameSide(o, p)) continue;
      for (const x of o.tokens) { const og = this.global(o, x); if (og === null) continue; const dist = (sq - og + TRACK) % TRACK; if (dist >= 1 && dist <= 6) return true; }
    }
    return false;
  }

  state() {
    return {
      players: this.players.map(p => ({ id: p.id, color: p.color, team: p.team, tokens: p.tokens })),
      turn: this.turn.id, dice: this.dice, finishOrder: this.finishOrder, over: this.over,
    };
  }
}

module.exports = { Ludo, FINISHED, IN_BASE };
