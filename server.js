require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'data', 'arena-live.sqlite'));
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CHAT_LENGTH = 180;
let demoChatSequence = 0;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS leaderboard (
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    kills INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

const defaultSettings = {
  matchDuration: 180,
  maxPlayers: 500,
  likeGoal: 100,
  sideNames: { red: 'Lula', blue: 'Bolsonaro' },
  gifts: {
    rose: { action: 'heal', amount: 12, label: 'Rosa' },
    'gg': { action: 'energy', amount: 20, label: 'GG' },
    'finger heart': { action: 'strike', amount: 18, label: 'Coração' }
  }
};

const savedSettings = db.prepare('SELECT value FROM settings WHERE key = ?').get('game');
let settings = savedSettings ? { ...defaultSettings, ...JSON.parse(savedSettings.value) } : defaultSettings;
if (!savedSettings) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('game', JSON.stringify(settings));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { serveClient: true, maxHttpBufferSize: 16_384 });
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '24kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use('/vendor/phaser', express.static(path.join(__dirname, 'node_modules', 'phaser', 'dist')));
app.use('/socket.io', express.static(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')));

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api', apiLimiter);

const prepared = {
  addActivity: db.prepare('INSERT INTO activity (kind, message) VALUES (?, ?)'),
  getActivity: db.prepare('SELECT id, kind, message, created_at AS createdAt FROM activity ORDER BY id DESC LIMIT 12'),
  upsertPlayer: db.prepare(`
    INSERT INTO leaderboard (username, display_name) VALUES (?, ?)
    ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP
  `),
  addKill: db.prepare('UPDATE leaderboard SET kills = kills + 1, points = points + 50, updated_at = CURRENT_TIMESTAMP WHERE username = ?'),
  addPoints: db.prepare('UPDATE leaderboard SET points = points + ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?'),
  addWin: db.prepare('UPDATE leaderboard SET wins = wins + 1, points = points + 100, updated_at = CURRENT_TIMESTAMP WHERE username = ?'),
  topPlayers: db.prepare('SELECT username, display_name AS displayName, kills, wins, points FROM leaderboard ORDER BY points DESC, wins DESC, kills DESC LIMIT 8'),
  getSession: db.prepare('SELECT expires_at AS expiresAt FROM admin_sessions WHERE token_hash = ?'),
  addSession: db.prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)'),
  deleteSession: db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?'),
  cleanSessions: db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?')
};

const state = {
  phase: 'waiting',
  matchNumber: 0,
  remainingSeconds: settings.matchDuration,
  players: new Map(),
  teamHealth: { red: 100, blue: 100 },
  teamDefendingUntil: { red: 0, blue: 0 },
  energy: 0,
  totalLikes: 0,
  live: { status: 'disconnected', username: '', error: '' },
  demoEnabled: true,
  winner: '',
  roundEvents: []
};
let liveConnection = null;
let liveAttempt = 0;
const commandTimes = new Map();

function safeText(value, max = 32) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function record(kind, message) {
  const cleanMessage = safeText(message, 110);
  prepared.addActivity.run(kind, cleanMessage);
  state.roundEvents.unshift({ kind, message: cleanMessage, time: new Date().toISOString() });
  state.roundEvents = state.roundEvents.slice(0, 8);
  io.emit('activity', state.roundEvents[0]);
}

function getSnapshot() {
  const players = [...state.players.values()].map((player) => ({ ...player }));
  return {
    phase: state.phase,
    matchNumber: state.matchNumber,
    remainingSeconds: state.remainingSeconds,
    players,
    energy: Math.round(state.energy),
    totalLikes: state.totalLikes,
    live: { ...state.live },
    demoEnabled: state.demoEnabled,
    winner: state.winner,
    teamHealth: { ...state.teamHealth },
    settings: { matchDuration: settings.matchDuration, maxPlayers: settings.maxPlayers, likeGoal: settings.likeGoal, sideNames: { ...settings.sideNames } },
    leaderboard: prepared.topPlayers.all(),
    activity: state.roundEvents.length ? state.roundEvents : prepared.getActivity.all().reverse()
  };
}

function publish() {
  io.emit('game:state', getSnapshot());
}

function teamName(team) {
  return settings.sideNames[team] || (team === 'red' ? 'Lula' : 'Bolsonaro');
}

function normalizeSideName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveTeam(value) {
  const side = normalizeSideName(value);
  if (['red', 'vermelho', 'vermelha', 'rubro', 'rubra'].includes(side) || side === normalizeSideName(teamName('red'))) return 'red';
  if (['blue', 'azul'].includes(side) || side === normalizeSideName(teamName('blue'))) return 'blue';
  return undefined;
}

function makePlayer(username, displayName, requestedTeam) {
  const current = state.players.get(username);
  if (current) {
    current.displayName = displayName || current.displayName;
    if (requestedTeam && current.team !== requestedTeam) {
      current.team = requestedTeam;
      current.alive = state.teamHealth[requestedTeam] > 0;
      record('join', `${current.displayName} escolheu apoiar ${teamName(requestedTeam)}`);
    }
    return current;
  }
  if (state.players.size >= settings.maxPlayers) return null;
  const counts = { red: 0, blue: 0 };
  for (const player of state.players.values()) counts[player.team] += 1;
  let team = requestedTeam;
  if (!['red', 'blue'].includes(team)) team = counts.red <= counts.blue ? 'red' : 'blue';
  const player = { username, displayName: displayName || username, team, health: 100, alive: state.teamHealth[team] > 0, kills: 0, points: 0, defendingUntil: 0 };
  state.players.set(username, player);
  prepared.upsertPlayer.run(username, player.displayName);
  record('join', `${player.displayName} entrou no lado ${teamName(team)}`);
  return player;
}

function changeTeamHealth(team, amount) {
  state.teamHealth[team] = Math.max(0, Math.min(100, state.teamHealth[team] + amount));
  if (state.teamHealth[team] === 0) {
    for (const player of state.players.values()) {
      if (player.team === team) player.alive = false;
    }
  } else if (state.teamHealth[team] > 0) {
    for (const player of state.players.values()) {
      if (player.team === team) player.alive = true;
    }
  }
}

function applyTeamAttack(player, special = false, source = 'chat') {
  const targetTeam = player.team === 'red' ? 'blue' : 'red';
  const defended = state.teamDefendingUntil[targetTeam] > Date.now();
  const damage = defended ? (special ? 14 : 5) : special ? 28 : 12 + Math.floor(Math.random() * 9);
  changeTeamHealth(targetTeam, -damage);
  player.points += special ? 20 : 10;
  prepared.addPoints.run(special ? 20 : 10, player.username);
  io.emit('fight:action', {
    attacker: player.displayName,
    attackerTeam: player.team,
    targetTeam,
    damage,
    targetHealth: state.teamHealth[targetTeam],
    special,
    source
  });
  record(state.teamHealth[targetTeam] === 0 ? 'elimination' : special ? 'special' : 'attack',
    `${player.displayName} atingiu ${teamName(targetTeam)} · ${damage} dano${defended ? ' bloqueado' : ''}`);
  if (state.teamHealth[targetTeam] === 0) {
    player.kills += 1;
    prepared.addKill.run(player.username);
    finishMatch(player.team);
  }
  return damage;
}

function runCommand(username, displayName, rawCommand, source = 'chat') {
  const command = safeText(rawCommand, MAX_CHAT_LENGTH).toLowerCase().trim();
  const [action, teamArg] = command.split(/\s+/);
  const namedAttackTeam = ['red', 'blue'].find((team) => normalizeSideName(command) === normalizeSideName(teamName(team)));
  if (!namedAttackTeam && !['!entrar', '!atacar', '!defender', '!especial', '!top'].includes(action)) return;
  const now = Date.now();
  if (now - (commandTimes.get(username) || 0) < 900) return;
  commandTimes.set(username, now);

  if (action === '!top') {
    const leaders = prepared.topPlayers.all().slice(0, 3);
    io.emit('chat:reply', { username, message: leaders.length ? `🏆 Líderes: ${leaders.map((item, index) => `${index + 1}. ${item.displayName} (${item.points} pts)`).join(' · ')}` : 'Ainda não há pontuação. Entre para jogar!' });
    return;
  }
  if (action === '!entrar') {
    const team = resolveTeam(command.slice(action.length).trim());
    if (!makePlayer(username, displayName, team)) {
      io.emit('chat:reply', { username, message: 'A arena está cheia. Tente na próxima partida.' });
    } else {
      io.emit('chat:reply', { username, message: `Você está na arena! Lado ${teamName(team || state.players.get(username).team)}.` });
    }
    publish();
    return;
  }

  let player = state.players.get(username);
  if (!player && (namedAttackTeam || action === '!atacar' || action === '!defender' || action === '!especial')) {
    player = makePlayer(username, displayName, namedAttackTeam);
  } else if (player && namedAttackTeam && player.team !== namedAttackTeam) {
    player = makePlayer(username, displayName, namedAttackTeam);
  }
  if (!player || !player.alive) {
    io.emit('chat:reply', { username, message: `Use !entrar ${teamName('red')} ou !entrar ${teamName('blue')} para entrar na arena.` });
    return;
  }
  if (state.phase !== 'fighting') {
    io.emit('chat:reply', { username, message: 'A partida ainda não está em andamento.' });
    return;
  }
  if (action === '!defender') {
    state.teamDefendingUntil[player.team] = now + 5000;
    player.points += 2;
    prepared.addPoints.run(2, player.username);
    record('defend', `${player.displayName} protegeu o lado ${teamName(player.team)}`);
  } else if (action === '!atacar' || namedAttackTeam) {
    applyTeamAttack(player, false, source);
  } else if (action === '!especial') {
    if (state.energy < 100) {
      io.emit('chat:reply', { username, message: `Energia em ${Math.round(state.energy)}%. As curtidas carregam o especial!` });
      return;
    }
    state.energy = 0;
    changeTeamHealth(player.team, 18);
    applyTeamAttack(player, true, source);
    record('special', `${player.displayName} ativou o especial de ${teamName(player.team)}!`);
  }
  if (source === 'demo') record('demo', `Ação de demonstração: ${action} por ${displayName}`);
  publish();
}

function startMatch() {
  if (state.phase === 'fighting') return { error: 'A partida já está em andamento.' };
  state.matchNumber += 1;
  state.phase = 'fighting';
  state.remainingSeconds = settings.matchDuration;
  state.energy = 0;
  state.totalLikes = 0;
  state.winner = '';
  for (const player of state.players.values()) {
    player.health = 100;
    player.alive = true;
    player.kills = 0;
    player.points = 0;
    player.defendingUntil = 0;
  }
  state.teamHealth = { red: 100, blue: 100 };
  state.teamDefendingUntil = { red: 0, blue: 0 };
  record('start', `Partida #${state.matchNumber} iniciada!`);
  publish();
  return { ok: true };
}

function finishMatch(winnerTeam = '') {
  if (state.phase !== 'fighting') return;
  const living = [...state.players.values()].filter((player) => player.alive);
  if (!winnerTeam && state.teamHealth.red !== state.teamHealth.blue) {
    winnerTeam = state.teamHealth.red > state.teamHealth.blue ? 'red' : 'blue';
  }
  const winners = living.filter((player) => player.team === winnerTeam);
  state.phase = 'finished';
  state.winner = winnerTeam ? teamName(winnerTeam) : 'SEM VENCEDORES';
  const addWins = db.transaction((players) => players.forEach((player) => prepared.addWin.run(player.username)));
  addWins(winners);
  record('winner', `Vitória: ${state.winner}`);
  publish();
}

function applyLike(count, displayName = 'A comunidade') {
  const likes = Math.min(250, Math.max(1, Number(count) || 1));
  state.totalLikes += likes;
  state.energy = Math.min(100, state.energy + (likes / settings.likeGoal) * 100);
  if (Math.floor(state.totalLikes / settings.likeGoal) !== Math.floor((state.totalLikes - likes) / settings.likeGoal)) {
    record('likes', `${safeText(displayName)} e a comunidade carregaram o especial!`);
  }
  publish();
}

function handleViewerComment(username, displayName, text, source = 'tiktok') {
  const message = safeText(text, MAX_CHAT_LENGTH);
  const namedAttackTeam = ['red', 'blue'].find((team) => normalizeSideName(message) === normalizeSideName(teamName(team)));
  if (namedAttackTeam) {
    runCommand(username, displayName, message, source);
    return true;
  }
  if (message.startsWith('!')) {
    const command = message.toLowerCase().split(/\s+/, 1)[0];
    if (['!entrar', '!atacar', '!defender', '!especial', '!top'].includes(command)) {
      runCommand(username, displayName, message, source);
      return true;
    }
    return false;
  }
  const now = Date.now();
  if (now - (commandTimes.get(username) || 0) < 900) return;
  commandTimes.set(username, now);
  const player = makePlayer(username, displayName);
  if (!player) return false;
  if (state.phase === 'fighting' && player.alive) {
    applyTeamAttack(player, false, source);
  }
  if (source === 'demo') record('demo', `Comentário demo de ${displayName}`);
  publish();
  return true;
}

function applyGift(username, displayName, giftName, count = 1) {
  const player = makePlayer(username, displayName);
  if (!player) return;
  const normalizedName = safeText(giftName, 48).toLowerCase();
  const rule = settings.gifts?.[normalizedName];
  if (!rule) {
    record('gift', `${displayName} enviou ${safeText(giftName, 36)} · sem poder configurado`);
    publish();
    return;
  }
  const amount = Math.min(100, Math.max(1, Number(rule.amount) || 1)) * Math.min(10, Math.max(1, Number(count) || 1));
  if (rule.action === 'heal') changeTeamHealth(player.team, amount);
  else if (rule.action === 'energy') state.energy = Math.min(100, state.energy + amount);
  else if (rule.action === 'strike') {
    const targetTeam = player.team === 'red' ? 'blue' : 'red';
    changeTeamHealth(targetTeam, -amount);
    io.emit('fight:action', { attacker: player.displayName, attackerTeam: player.team, targetTeam, damage: amount, targetHealth: state.teamHealth[targetTeam], special: false, source: 'gift' });
    if (state.teamHealth[targetTeam] === 0) {
      player.kills += 1;
      player.points += 50;
      prepared.addKill.run(player.username);
      finishMatch(player.team);
    }
  } else if (rule.action === 'shield') state.teamDefendingUntil[player.team] = Date.now() + 8000;
  else {
    record('gift', `Poder "${safeText(rule.action, 20)}" não reconhecido para ${safeText(giftName, 36)}`);
    return;
  }
  player.points += 5;
  prepared.addPoints.run(5, player.username);
  record('gift', `${displayName} ativou ${safeText(rule.label || giftName, 32)}!`);
  publish();
}

function demoEvent() {
  if (!state.demoEnabled) return { error: 'O modo de demonstração está desativado.' };
  const demoUsers = [
    ['luna_arcana', 'Luna Arcana', 'red'],
    ['capitao_pixel', 'Capitão Pixel', 'blue'],
    ['ninja_neon', 'Ninja Neon', 'red'],
    ['cometa_azul', 'Cometa Azul', 'blue']
  ];
  for (const [username, display, team] of demoUsers) makePlayer(username, display, team);
  const sample = demoUsers[Math.floor(Math.random() * demoUsers.length)];
  const eventType = Math.random();
  if (eventType < 0.45) applyLike(12 + Math.floor(Math.random() * 28), sample[1]);
  else if (eventType < 0.73) applyGift(sample[0], sample[1], 'rose');
  else if (state.phase === 'fighting') handleViewerComment(sample[0], sample[1], 'Bom combate!', 'demo');
  else record('demo', `Comentário demo de ${sample[1]} · inicie a partida para lutar`);
  return { ok: true };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function adminAuth(req, res, next) {
  const token = req.cookies?.arena_session || parseCookies(req.headers.cookie).arena_session;
  if (!token) return res.status(401).json({ error: 'Autenticação necessária.' });
  const session = prepared.getSession.get(hashToken(token));
  if (!session || session.expiresAt <= Date.now()) {
    if (session) prepared.deleteSession.run(hashToken(token));
    return res.status(401).json({ error: 'Sessão expirada.' });
  }
  next();
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(cookieHeader.split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function describeTikTokConnectError(error, username) {
  const cause = error?.exception || error;
  if (cause?.name === 'UserOfflineError' || /requested user isn't online/i.test(cause?.message || '')) {
    return `O TikTok informa que @${username} não está AO VIVO. Inicie uma transmissão pública nessa conta e tente conectar novamente.`;
  }
  if (cause?.name === 'InvalidUniqueIdError') {
    return `O usuário @${username} não foi reconhecido pelo TikTok. Confira o @ e tente novamente.`;
  }
  return 'Conexão falhou. Confirme o @usuário e que a transmissão está pública e ativa; consulte os logs se o erro continuar.';
}

app.get('/api/state', (_req, res) => res.json(getSnapshot()));
app.get('/api/admin/status', (req, res) => {
  const token = parseCookies(req.headers.cookie).arena_session;
  const session = token && prepared.getSession.get(hashToken(token));
  res.json({ configured: Boolean(ADMIN_PASSWORD), authenticated: Boolean(session && session.expiresAt > Date.now()) });
});
app.post('/api/admin/login', authLimiter, (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Configure ADMIN_PASSWORD no ambiente do servidor.' });
  const password = String(req.body?.password || '');
  const expected = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  const actual = crypto.createHash('sha256').update(password).digest();
  if (!crypto.timingSafeEqual(expected, actual)) return res.status(401).json({ error: 'Senha incorreta.' });
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  prepared.addSession.run(hashToken(token), expiresAt);
  res.setHeader('Set-Cookie', `arena_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${COOKIE_SECURE ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', adminAuth, (req, res) => {
  prepared.deleteSession.run(hashToken(parseCookies(req.headers.cookie).arena_session));
  res.setHeader('Set-Cookie', 'arena_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/settings', adminAuth, (_req, res) => res.json(settings));
app.put('/api/admin/settings', adminAuth, (req, res) => {
  const input = req.body || {};
  const duration = Number(input.matchDuration);
  const maxPlayers = Number(input.maxPlayers);
  const likeGoal = Number(input.likeGoal);
  const sideNames = {
    red: safeText(input.sideNames?.red, 24),
    blue: safeText(input.sideNames?.blue, 24)
  };
  if (!Number.isInteger(duration) || duration < 30 || duration > 900 ||
      !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 500 ||
      !Number.isInteger(likeGoal) || likeGoal < 10 || likeGoal > 100_000 ||
      sideNames.red.length < 2 || sideNames.blue.length < 2 ||
      normalizeSideName(sideNames.red) === normalizeSideName(sideNames.blue)) {
    return res.status(400).json({ error: 'Configuração inválida: informe dois nomes diferentes (2–24 caracteres), duração 30–900 s, jogadores 2–500 e meta 10–100.000 curtidas.' });
  }
  if (!input.gifts || typeof input.gifts !== 'object' || Array.isArray(input.gifts) || Object.keys(input.gifts).length > 30) {
    return res.status(400).json({ error: 'Configure até 30 regras de presentes.' });
  }
  const gifts = Object.create(null);
  for (const [name, rule] of Object.entries(input.gifts)) {
    const giftName = safeText(name, 48).toLowerCase();
    if (!giftName || Object.hasOwn(gifts, giftName) || !rule || !['heal', 'energy', 'strike', 'shield'].includes(rule.action) ||
        !Number.isInteger(Number(rule.amount)) || Number(rule.amount) < 1 || Number(rule.amount) > 100) {
      return res.status(400).json({ error: 'Cada presente precisa ter um nome único, uma ação válida e intensidade entre 1 e 100.' });
    }
    gifts[giftName] = { action: rule.action, amount: Number(rule.amount), label: safeText(rule.label || giftName, 32) };
  }
  settings = { matchDuration: duration, maxPlayers, likeGoal, sideNames, gifts };
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('game', JSON.stringify(settings));
  publish();
  res.json({ ok: true, settings });
});
app.post('/api/admin/live/connect', adminAuth, async (req, res) => {
  const username = safeText(req.body?.username, 30).replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  if (username.length < 2) return res.status(400).json({ error: 'Informe o @usuário público de um criador que esteja AO VIVO.' });
  try {
    const result = await connectTikTok(username);
    if (result.error) return res.status(502).json({ error: result.error });
    res.json({ ok: true, live: state.live });
  } catch (error) {
    console.error('[TikTok LIVE] Falha ao conectar:', error);
    res.status(502).json({ error: 'Não foi possível conectar ao LIVE. Confirme o usuário, a transmissão ativa e a disponibilidade do conector.' });
  }
});
app.post('/api/admin/live/disconnect', adminAuth, async (_req, res) => {
  await disconnectTikTok();
  res.json({ ok: true, live: state.live });
});
app.post('/api/admin/demo', adminAuth, (req, res) => {
  state.demoEnabled = Boolean(req.body?.enabled);
  publish();
  res.json({ ok: true, demoEnabled: state.demoEnabled });
});
app.post('/api/admin/match/start', adminAuth, (req, res) => {
  const result = startMatch();
  res.status(result.error ? 409 : 200).json(result);
});
app.post('/api/admin/match/stop', adminAuth, (_req, res) => {
  if (state.phase === 'fighting') finishMatch();
  res.json({ ok: true });
});
app.post('/api/demo/start', (req, res) => {
  if (!state.demoEnabled || state.live.status === 'connected') return res.status(409).json({ error: 'A demonstração está indisponível durante uma conexão LIVE.' });
  const result = startMatch();
  res.status(result.error ? 409 : 200).json(result);
});
app.post('/api/demo/event', (req, res) => {
  if (!state.demoEnabled || state.live.status === 'connected') return res.status(409).json({ error: 'Eventos de demonstração estão desativados.' });
  res.status(200).json(demoEvent());
});
app.post('/api/demo/comment', (req, res) => {
  if (!state.demoEnabled || state.live.status === 'connected') return res.status(409).json({ error: 'Comentários de demonstração estão desativados.' });
  const viewers = [
    ['demo_chat_luna', 'Luna do chat'],
    ['demo_chat_pixel', 'Pixel do chat'],
    ['demo_chat_neon', 'Neon do chat'],
    ['demo_chat_cometa', 'Cometa do chat']
  ];
  const [username, displayName] = viewers[demoChatSequence++ % viewers.length];
  const comment = safeText(req.body?.comment || 'Quero apoiar esse lutador!', MAX_CHAT_LENGTH);
  const joined = handleViewerComment(username, displayName, comment, 'demo');
  if (!joined) return res.status(429).json({ error: 'Tente novamente em um segundo ou libere uma vaga na arena.' });
  res.json({ ok: true, displayName, comment });
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((error, _req, res, _next) => {
  console.error('[HTTP] Erro inesperado:', error);
  res.status(500).json({ error: 'Erro interno. Consulte os logs do servidor.' });
});

async function disconnectTikTok() {
  liveAttempt += 1;
  const connection = liveConnection;
  liveConnection = null;
  if (connection) {
    try {
      await connection.disconnect();
    } catch (error) {
      console.warn('[TikTok LIVE] Erro ao encerrar conexão:', error.message);
    }
  }
  state.live = { status: 'disconnected', username: '', error: '' };
  publish();
}

async function connectTikTok(username) {
  await disconnectTikTok();
  const attempt = liveAttempt;
  state.live = { status: 'connecting', username, error: '' };
  publish();
  let connector;
  try {
    connector = await import('tiktok-live-connector');
  } catch (error) {
    console.error('[TikTok LIVE] Falha ao carregar o conector:', error);
    state.live = { status: 'error', username, error: 'O conector tiktok-live-connector não está disponível. Verifique a instalação do servidor.' };
    publish();
    return { error: state.live.error };
  }
  if (attempt !== liveAttempt) return { error: 'A solicitação de conexão foi substituída.' };
  const TikTokLiveConnection = connector.TikTokLiveConnection || connector.default?.TikTokLiveConnection;
  if (!TikTokLiveConnection) {
    state.live = { status: 'error', username, error: 'Versão incompatível do conector TikTok LIVE.' };
    publish();
    return { error: state.live.error };
  }
  let connection;
  try {
    connection = new TikTokLiveConnection(`@${username}`, {});
  } catch (error) {
    console.error(`[TikTok LIVE] Usuário inválido @${username}:`, error);
    state.live = { status: 'error', username, error: describeTikTokConnectError(error, username) };
    publish();
    return { error: state.live.error };
  }
  liveConnection = connection;
  const on = (eventKey, fallback, callback) => connection.on(connector.WebcastEvent?.[eventKey] || fallback, callback);
  on('CHAT', 'chat', (data) => {
    const text = safeText(data.content || data.comment, MAX_CHAT_LENGTH);
    const uniqueId = data.user?.displayId || data.user?.uniqueId || data.uniqueId;
    const id = safeText(uniqueId || data.user?.id || data.userId || `viewer_${crypto.createHash('sha1').update(text).digest('hex').slice(0, 8)}`, 48).toLowerCase();
    handleViewerComment(id, safeText(data.user?.nickname || data.nickname || uniqueId || 'Espectador', 32), text, 'tiktok');
  });
  on('LIKE', 'like', (data) => applyLike(
    data.likeCount ?? data.count ?? 1,
    data.user?.nickname || data.nickname || data.user?.displayId || data.uniqueId || 'A comunidade'
  ));
  on('GIFT', 'gift', (data) => {
    const giftType = Number(data.gift?.type ?? data.giftDetails?.giftType);
    const streakEnded = data.repeatEnd === true || Number(data.repeatEnd) === 1;
    if (giftType === 1 && !streakEnded) return;
    const user = data.user?.displayId || data.user?.uniqueId || data.uniqueId || data.user?.id || data.userId || `presente_${Date.now()}`;
    const giftName = data.gift?.name || data.giftDetails?.giftName || data.extendedGiftInfo?.name || data.giftName;
    applyGift(
      safeText(user, 48).toLowerCase(),
      safeText(data.user?.nickname || data.nickname || user, 32),
      giftName || `presente-${data.giftId || data.gift?.id || 'desconhecido'}`,
      data.repeatCount ?? data.comboCount ?? 1
    );
  });
  on('DISCONNECTED', 'disconnected', () => {
    if (liveConnection !== connection) return;
    liveConnection = null;
    state.live = { status: 'disconnected', username, error: 'A transmissão encerrou ou perdeu a conexão.' };
    publish();
  });
  on('ERROR', 'error', (error) => {
    console.error('[TikTok LIVE] Erro do conector:', error?.message || error);
    if (liveConnection === connection) {
      state.live = { status: 'error', username, error: 'O conector reportou um erro; confira os logs do servidor.' };
      publish();
    }
  });
  try {
    await connection.connect();
    if (attempt !== liveAttempt) {
      await connection.disconnect();
      return { error: 'A solicitação de conexão foi cancelada.' };
    }
    state.live = { status: 'connected', username, error: '' };
    state.demoEnabled = false;
    record('live', `Conectado ao TikTok LIVE de @${username}`);
    if (state.phase !== 'fighting') startMatch();
    publish();
    return { ok: true };
  } catch (error) {
    console.error(`[TikTok LIVE] Não foi possível conectar a @${username}:`, error);
    if (liveConnection === connection) liveConnection = null;
    state.live = { status: 'error', username, error: describeTikTokConnectError(error, username) };
    publish();
    return { error: state.live.error };
  }
}

io.on('connection', (socket) => {
  socket.emit('game:state', getSnapshot());
  socket.on('player:join', (data) => {
    const username = `web_${socket.id}`;
    const displayName = safeText(data?.displayName || 'Jogador', 24) || 'Jogador';
    const team = data?.team === 'red' || data?.team === 'blue' ? data.team : undefined;
    if (!makePlayer(username, displayName, team)) socket.emit('chat:reply', { username, message: 'A arena está cheia.' });
    else {
      socket.data.playerId = username;
      socket.emit('player:joined', { username });
      publish();
    }
  });
  socket.on('player:command', (data) => {
    if (!socket.data.playerId) return;
    const player = state.players.get(socket.data.playerId);
    if (!player) return;
    runCommand(player.username, player.displayName, data?.command, 'web');
  });
  socket.on('disconnect', () => {
    if (!socket.data.playerId) return;
    state.players.delete(socket.data.playerId);
    publish();
  });
});

setInterval(() => {
  if (state.phase !== 'fighting') {
    if (state.phase === 'finished' && state.live.status === 'connected') startMatch();
    return;
  }
  state.remainingSeconds = Math.max(0, state.remainingSeconds - 1);
  if (state.remainingSeconds === 0) finishMatch();
  else {
    if (state.teamHealth.red === 0 || state.teamHealth.blue === 0) finishMatch();
    else publish();
  }
}, 1000);
setInterval(() => prepared.cleanSessions.run(Date.now()), 60 * 60_000).unref();
setInterval(() => {
  const expiry = Date.now() - 120_000;
  for (const [username, lastAction] of commandTimes) {
    if (lastAction < expiry) commandTimes.delete(username);
  }
}, 60_000).unref();

server.listen(PORT, () => {
  console.log(`ARENA LIVE disponível em http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD não definida: configure .env para habilitar o painel administrativo.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await disconnectTikTok();
    db.close();
    server.close(() => process.exit(0));
  });
}
