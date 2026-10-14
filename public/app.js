(() => {
  const $ = (selector) => document.querySelector(selector);
  const socket = io({ transports: ['polling', 'websocket'] });
  const state = { snapshot: null, joined: false, username: '', toastTimer: null, scene: null, activities: [] };
  const red = 0xff5269;
  const blue = 0x59a6ff;
  const green = 0xc4fa58;

  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.toggle('error', isError);
    element.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.remove('show'), 2800);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Erro ${response.status}`);
    return data;
  }

  function formatTime(seconds) {
    const safeSeconds = Math.max(0, Number(seconds) || 0);
    return `${String(Math.floor(safeSeconds / 60)).padStart(2, '0')}:${String(safeSeconds % 60).padStart(2, '0')}`;
  }

  function updateLive(live) {
    const indicator = $('#live-indicator');
    const label = $('#live-label');
    indicator.classList.remove('connected', 'connecting', 'error');
    indicator.classList.add(live.status);
    const status = {
      connected: `LIVE conectado · @${live.username}`,
      connecting: `Conectando · @${live.username}`,
      error: `LIVE com erro · @${live.username}`,
      disconnected: 'LIVE desconectado'
    }[live.status] || 'LIVE desconectado';
    label.textContent = status;
    $('#demo-indicator').classList.toggle('off', !state.snapshot?.demoEnabled);
    $('#demo-indicator').textContent = state.snapshot?.demoEnabled ? 'DEMO' : 'DEMO OFF';
    $('#admin-live-status').textContent = status;
    $('#admin-live-status').classList.toggle('is-connected', live.status === 'connected');
    $('#live-connect').classList.toggle('hidden', live.status === 'connected' || live.status === 'connecting');
    $('#live-disconnect').classList.toggle('hidden', live.status !== 'connected' && live.status !== 'connecting');
    $('#live-error').textContent = live.error || '';
    $('#demo-start').disabled = !state.snapshot?.demoEnabled || live.status === 'connected';
    $('#demo-comment').disabled = !state.snapshot?.demoEnabled || live.status === 'connected';
    $('#demo-event').disabled = !state.snapshot?.demoEnabled || live.status === 'connected';
    $('#demo-toggle').checked = Boolean(state.snapshot?.demoEnabled);
  }

  function renderActivity(items) {
    const feed = $('#activity-feed');
    if (!items?.length) {
      feed.innerHTML = '<div class="empty-state">Aguardando os primeiros movimentos...</div>';
      return;
    }
    feed.replaceChildren();
    for (const item of items.slice(0, 10)) {
      const row = document.createElement('div');
      row.className = 'activity-item';
      row.dataset.kind = item.kind || 'event';
      const dot = document.createElement('span');
      dot.className = 'activity-dot';
      const text = document.createElement('div');
      text.className = 'activity-message';
      text.append(document.createTextNode(item.message || 'Movimento na arena'));
      const time = document.createElement('span');
      time.className = 'activity-time';
      const date = item.time || item.createdAt;
      time.textContent = date ? new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'AGORA';
      text.append(time);
      row.append(dot, text);
      feed.append(row);
    }
  }

  function renderLeaderboard(items) {
    const board = $('#leaderboard');
    if (!items?.length) {
      board.innerHTML = '<div class="empty-state">A pontuação aparecerá aqui.</div>';
      return;
    }
    board.replaceChildren();
    items.slice(0, 5).forEach((player, index) => {
      const row = document.createElement('div');
      row.className = 'leader-row';
      const rank = document.createElement('span');
      rank.className = 'leader-rank';
      rank.textContent = `0${index + 1}`;
      const name = document.createElement('span');
      name.className = 'leader-name';
      name.textContent = player.displayName || player.username;
      const kills = document.createElement('span');
      kills.className = 'leader-kills';
      kills.textContent = `${player.kills || 0} K`;
      const points = document.createElement('span');
      points.className = 'leader-score';
      points.textContent = `${player.points || 0} PTS`;
      row.append(rank, name, kills, points);
      board.append(row);
    });
  }

  function renderSnapshot(snapshot) {
    state.snapshot = snapshot;
    $('#round-number').textContent = `#${String(snapshot.matchNumber || 0).padStart(2, '0')}`;
    $('#timer').textContent = formatTime(snapshot.remainingSeconds);
    $('#timer').parentElement.classList.toggle('urgent', snapshot.remainingSeconds <= 15 && snapshot.phase === 'fighting');
    const phaseLabels = { waiting: 'AGUARDANDO JOGADORES', fighting: 'BATALHA EM ANDAMENTO', finished: 'PARTIDA ENCERRADA' };
    $('#phase-label').textContent = phaseLabels[snapshot.phase] || 'AGUARDANDO';
    $('#arena-subtitle').textContent = snapshot.phase === 'fighting'
      ? 'Comandos recebidos · batalha em andamento'
      : snapshot.phase === 'finished'
        ? 'A rodada terminou · prepare-se para a próxima'
        : 'Aguardando o início da batalha';
    $('#match-status').textContent = phaseLabels[snapshot.phase] || 'Aguardando';
    $('#match-start').disabled = snapshot.phase === 'fighting';
    $('#match-stop').disabled = snapshot.phase !== 'fighting';
    $('#winner-banner').textContent = snapshot.winner ? `✦ ${snapshot.winner} ✦` : '';
    $('#winner-banner').classList.toggle('hidden', snapshot.phase !== 'finished' || !snapshot.winner);
    $('#energy-value').textContent = snapshot.energy || 0;
    $('#energy-fill').style.width = `${Math.min(100, snapshot.energy || 0)}%`;
    $('#likes-count').textContent = Number(snapshot.totalLikes || 0).toLocaleString('pt-BR');
    $('#special-hint').textContent = snapshot.energy >= 100 ? 'Especial liberado — use !especial' : 'Meta: 100% para liberar o especial';
    const players = snapshot.players || [];
    const alive = players.filter((player) => player.alive);
    $('#red-count').textContent = alive.filter((player) => player.team === 'red').length;
    $('#blue-count').textContent = alive.filter((player) => player.team === 'blue').length;
    $('#alive-count').textContent = `${alive.length} combatente${alive.length === 1 ? '' : 's'} na arena`;
    const sideNames = snapshot.settings?.sideNames || { red: 'Lula', blue: 'Bolsonaro' };
    const redName = sideNames.red.toLocaleUpperCase('pt-BR');
    const blueName = sideNames.blue.toLocaleUpperCase('pt-BR');
    $('#side-red-label').textContent = redName;
    $('#side-blue-label').textContent = blueName;
    $('#side-red-count-label').textContent = redName;
    $('#side-blue-count-label').textContent = blueName;
    $('#join-red-name').textContent = `Apoiar ${sideNames.red}`;
    $('#join-blue-name').textContent = `Apoiar ${sideNames.blue}`;
    $('#command-red-attack').textContent = sideNames.red;
    $('#command-blue-attack').textContent = sideNames.blue;
    $('#command-join').textContent = '!entrar NOME';
    $('#command-join-help').textContent = `Apoiar ${sideNames.red} ou ${sideNames.blue}`;
    renderLeaderboard(snapshot.leaderboard);
    renderActivity(snapshot.activity);
    updateLive(snapshot.live || { status: 'disconnected' });
    if (state.scene) state.scene.sync(players, snapshot.phase, snapshot.teamHealth, sideNames);
  }

  class ArenaScene extends Phaser.Scene {
    constructor() {
      super('Arena');
      this.fighters = new Map();
      this.phase = 'waiting';
    }

    preload() {
      this.load.on('loaderror', (file) => {
        console.error(`Falha ao carregar sprite da arena: ${file.key} (${file.src})`);
      });
      this.load.image('arena-background', '/assets/sprites/arena.png');
      this.load.image('fighter-source-red', '/assets/sprites/lula.png');
      this.load.image('fighter-source-blue', '/assets/sprites/bolsonaro.png');
      this.load.once('complete', () => {
        for (const key of ['arena-background', 'fighter-source-red', 'fighter-source-blue']) {
          if (!this.textures.exists(key)) console.error(`Imagem da arena não registrada: ${key}`);
        }
      });
    }

    create() {
      this.paintArena();
      this.createFighterSpriteSheets();
      this.fighterNames = {
        red: document.querySelector('#fighter-name-red'),
        blue: document.querySelector('#fighter-name-blue')
      };
      this.canvasShell = document.querySelector('.canvas-shell');
      this.positionFighterNames = () => {
        const canvasBounds = this.game.canvas.getBoundingClientRect();
        const shellBounds = this.canvasShell.getBoundingClientRect();
        if (!canvasBounds.width || !canvasBounds.height) return;
        const positions = { red: 325, blue: 675 };
        for (const team of ['red', 'blue']) {
          const name = this.fighterNames[team];
          name.style.left = `${canvasBounds.left - shellBounds.left + positions[team] * canvasBounds.width / 1000}px`;
          name.style.top = `${canvasBounds.top - shellBounds.top + 317 * canvasBounds.height / 520}px`;
        }
      };
      this.nameResizeObserver = new ResizeObserver(this.positionFighterNames);
      this.nameResizeObserver.observe(this.canvasShell);
      this.nameResizeObserver.observe(this.game.canvas);
      this.positionFighterNames();
      state.scene = this;
      if (state.snapshot) {
        this.sync(
          state.snapshot.players || [],
          state.snapshot.phase,
          state.snapshot.teamHealth,
          state.snapshot.settings?.sideNames
        );
      }
      this.events.on('shutdown', () => {
        this.nameResizeObserver.disconnect();
        this.fighters.clear();
      });
    }

    createFighterSpriteSheets() {
      const sheets = [
        {
          team: 'red',
          sourceKey: 'fighter-source-red',
          key: 'pixel-fighter-red',
          frameWidth: 160,
          frames: [[11, 70], [92, 163], [186, 263], [286, 405], [419, 537], [560, 641], [650, 763]]
        },
        {
          team: 'blue',
          sourceKey: 'fighter-source-blue',
          key: 'pixel-fighter-blue',
          frameWidth: 160,
          frames: [[12, 68], [94, 162], [187, 268], [282, 398], [420, 534], [560, 640], [649, 758]]
        }
      ];
      for (const sheet of sheets) {
        if (!this.textures.exists(sheet.sourceKey)) {
          throw new Error(`Imagem original ausente para o lutador ${sheet.team}`);
        }
        const source = this.textures.get(sheet.sourceKey).getSourceImage();
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = source.naturalWidth || source.width;
        sourceCanvas.height = source.naturalHeight || source.height;
        const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
        if (!sourceContext) throw new Error(`Não foi possível processar a imagem do lutador ${sheet.team}`);
        sourceContext.drawImage(source, 0, 0);
        this.removeSpriteSheetBackground(sourceContext, sourceCanvas.width, sourceCanvas.height);

        const canvas = document.createElement('canvas');
        canvas.width = sheet.frameWidth * sheet.frames.length;
        canvas.height = sourceCanvas.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error(`Não foi possível montar os quadros do lutador ${sheet.team}`);
        context.imageSmoothingEnabled = false;
        sheet.frames.forEach(([left, right], index) => {
          const width = right - left;
          if (left < 0 || right > sourceCanvas.width || width > sheet.frameWidth) {
            throw new Error(`Recorte inválido no quadro ${index} do lutador ${sheet.team}`);
          }
          const destinationX = index * sheet.frameWidth + Math.floor((sheet.frameWidth - width) / 2);
          context.drawImage(sourceCanvas, left, 0, width, sourceCanvas.height, destinationX, 0, width, sourceCanvas.height);
        });
        const texture = this.textures.addSpriteSheet(sheet.key, canvas, {
          frameWidth: sheet.frameWidth,
          frameHeight: canvas.height,
          endFrame: sheet.frames.length - 1
        });
        if (!texture) throw new Error(`Não foi possível criar as poses do lutador ${sheet.team}`);
      }
    }

    removeSpriteSheetBackground(context, width, height) {
      const image = context.getImageData(0, 0, width, height);
      const { data } = image;
      const visited = new Uint8Array(width * height);
      const queue = new Int32Array(width * height);
      const base = [data[0], data[1], data[2]];
      let head = 0;
      let tail = 0;

      const addIfBackground = (index) => {
        if (visited[index]) return;
        const pixel = index * 4;
        if (
          Math.abs(data[pixel] - base[0]) > 7 ||
          Math.abs(data[pixel + 1] - base[1]) > 7 ||
          Math.abs(data[pixel + 2] - base[2]) > 7
        ) return;
        visited[index] = 1;
        queue[tail] = index;
        tail += 1;
      };

      for (let x = 0; x < width; x += 1) {
        addIfBackground(x);
        addIfBackground((height - 1) * width + x);
      }
      for (let y = 1; y < height - 1; y += 1) {
        addIfBackground(y * width);
        addIfBackground(y * width + width - 1);
      }

      while (head < tail) {
        const index = queue[head];
        head += 1;
        const x = index % width;
        if (x > 0) addIfBackground(index - 1);
        if (x + 1 < width) addIfBackground(index + 1);
        if (index >= width) addIfBackground(index - width);
        if (index + width < width * height) addIfBackground(index + width);
      }

      for (let index = 0; index < visited.length; index += 1) {
        if (visited[index]) data[index * 4 + 3] = 0;
      }
      context.putImageData(image, 0, 0);
    }

    paintArena() {
      this.children.removeAll();
      this.add.image(500, 260, 'arena-background')
        .setDisplaySize(1000, 520)
        .setDepth(-2);
      this.add.rectangle(500, 260, 1000, 520, 0x070b17, .12)
        .setDepth(-1);

      for (let i = 0; i < 30; i += 1) {
        const x = (i * 173 + 31) % 990 + 5;
        const y = (i * 97 + 13) % 265 + 10;
        const size = i % 6 === 0 ? 3 : 2;
        const pixel = this.add.rectangle(x, y, size, size, 0xd8e2f4, i % 6 === 0 ? .48 : .24);
        this.tweens.add({ targets: pixel, alpha: .08, duration: 900 + (i * 89) % 1200, yoyo: true, repeat: -1, delay: (i * 31) % 1600 });
      }
    }

    createFighterTexture(team, pose = 'idle') {
      const textureKey = `pixel-fighter-${team}-${pose}`;
      if (this.textures.exists(textureKey)) return;
      this.drawCleanFighterTexture(team, pose, textureKey);
    }

    drawCleanFighterTexture(team, pose, textureKey) {
      const palette = team === 'red' ? {
        outline: 0x211d27, hair: 0xaeb2b2, hairLight: 0xe1dfd7, hairShade: 0x777d83,
        skin: 0xe8b18f, skinLight: 0xf8d1ad, skinShade: 0xb96f5f, skinDeep: 0x985750, eye: 0x25212a, eyeWhite: 0xf4dfce,
        beard: 0xd4d3ca, beardLight: 0xf0eee5, beardShade: 0x85898d,
        suit: 0x9c263f, suitLight: 0xe34a5d, suitShade: 0x591a32,
        shirt: 0xe8dfd0, tie: 0x29232b, gold: 0xf0bf58,
        pants: 0x33313d, pantsLight: 0x55505c, shoe: 0x171923
      } : {
        outline: 0x1b1b20, hair: 0x302a28, hairLight: 0x55473b, hairShade: 0x211e20,
        skin: 0xe6ae89, skinLight: 0xf5c9a3, skinShade: 0xb86e5a, skinDeep: 0x95564a, eye: 0x241f20, eyeWhite: 0xf2dcc7,
        beard: 0xd4d3ca, beardLight: 0xf0eee5, beardShade: 0x85898d,
        suit: 0x17375f, suitLight: 0x2e6598, suitShade: 0x102340,
        shirt: 0xe4e2d9, tie: 0x172b42, gold: 0xd7bd71,
        pants: 0x283248, pantsLight: 0x42516a, shoe: 0x171923
      };
      const graphics = this.make.graphics({ x: 0, y: 0, add: false });
      const pixel = (x, y, color) => rect(x, y, 1, 1, color);
      const rect = (x, y, width, height, color) => {
        graphics.fillStyle(palette[color], 1);
        graphics.fillRect(x, y, width, height);
      };
      const rows = (startY, shape, color) => {
        shape.forEach((bounds, index) => {
          if (bounds) rect(bounds[0], startY + index, bounds[1] - bounds[0], 1, color);
        });
      };
      const walking = pose === 'walk1' || pose === 'walk2';
      const step = pose === 'walk1' ? -1 : pose === 'walk2' ? 1 : 0;

      rows(4, [
        [39, 57], [34, 62], [30, 66], [27, 69], [24, 72], [22, 74],
        [20, 76], [19, 77], [18, 78], [18, 78], [18, 78], [18, 78],
        [18, 78], [18, 78], [18, 78], [18, 78], [18, 78], [18, 78],
        [18, 78], [18, 78], [18, 78], [18, 78], [18, 78], [18, 78],
        [19, 77], [19, 77], [20, 76], [22, 74], [25, 71], [29, 67],
        [34, 62], [39, 57]
      ], 'outline');
      rows(7, [
        [39, 57], [35, 61], [31, 65], [28, 68], [25, 71], [23, 73],
        [21, 75], [20, 76], [19, 77], [19, 77], [19, 77], [19, 77],
        [19, 77], [19, 77], [19, 77], [19, 77], [19, 77], [19, 77],
        [19, 77], [19, 77], [19, 77], [19, 77], [19, 77], [20, 76],
        [21, 75], [23, 73], [26, 70], [30, 66], [35, 61], [40, 56]
      ], 'skin');
      rect(22, 10, 21, 4, 'skinLight');
      rect(20, 14, 5, 7, 'skinLight');
      rect(25, 14, 7, 6, 'skinLight');
      rect(66, 14, 5, 7, 'skinShade');
      rect(59, 14, 7, 6, 'skinShade');
      rect(19, 22, 4, 9, 'skinShade');
      rect(73, 22, 4, 9, 'skinShade');
      rect(14, 21, 5, 8, 'skinShade');
      rect(77, 21, 5, 8, 'skinShade');
      rect(12, 22, 6, 6, 'skin');
      rect(78, 22, 6, 6, 'skin');
      rect(24, 15, 19, 2, 'skin');
      rect(53, 15, 19, 2, 'skinShade');

      if (team === 'red') {
        rows(4, [
          [39, 57], [35, 61], [32, 64], [29, 67], [27, 69],
          [25, 71], [24, 72], [24, 72], [26, 70], [29, 67]
        ], 'hair');
        rect(29, 7, 10, 3, 'hairLight');
        rect(55, 7, 11, 3, 'hairLight');
        rect(19, 13, 5, 15, 'hairShade');
        rect(72, 13, 5, 15, 'hairShade');
        rows(37, [
          [27, 69], [23, 73], [20, 76], [18, 78], [18, 78],
          [19, 77], [20, 76], [22, 74], [25, 71], [30, 66],
          [36, 60], [42, 54]
        ], 'beard');
        rect(24, 39, 13, 3, 'beardShade');
        rect(59, 39, 13, 3, 'beardShade');
        rect(29, 43, 13, 3, 'beardLight');
        rect(54, 43, 13, 3, 'beardLight');
        rect(38, 47, 19, 3, 'beardShade');
      } else {
        rows(4, [
          [39, 57], [35, 61], [32, 64], [29, 67], [27, 69],
          [25, 71], [24, 72], [24, 72], [25, 71], [27, 69]
        ], 'hair');
        rect(27, 7, 13, 3, 'hairLight');
        rect(39, 6, 21, 4, 'hairShade');
        rect(59, 8, 11, 3, 'hairLight');
        rect(20, 13, 6, 15, 'hairShade');
        rect(70, 13, 6, 15, 'hairShade');
        rect(22, 34, 52, 5, 'skinShade');
        rect(31, 39, 34, 3, 'skinDeep');
        rect(32, 33, 9, 3, 'skinDeep');
        rect(55, 33, 9, 3, 'skinDeep');
        rect(34, 37, 7, 3, 'skinLight');
        rect(55, 37, 7, 3, 'skinLight');
      }

      rect(28, 18, 14, 3, team === 'red' ? 'hairShade' : 'skinDeep');
      rect(54, 18, 14, 3, team === 'red' ? 'hairShade' : 'skinDeep');
      rect(31, 22, 10, 5, 'outline');
      rect(56, 22, 10, 5, 'outline');
      rect(33, 23, 6, 2, 'eyeWhite');
      rect(58, 23, 6, 2, 'eyeWhite');
      rect(35, 23, 3, 2, 'eye');
      rect(60, 23, 3, 2, 'eye');
      rect(46, 25, 5, 10, 'skinShade');
      rect(47, 25, 3, 8, 'skinLight');
      pixel(44, 35, 'skinDeep');
      pixel(53, 35, 'skinDeep');
      if (team === 'red') {
        rect(29, 34, 14, 3, 'beardShade');
        rect(53, 34, 14, 3, 'beardShade');
        rect(41, 35, 19, 2, 'skin');
        rect(38, 38, 26, 2, 'beardLight');
      } else {
        rect(43, 36, 16, 2, 'outline');
        rect(46, 38, 11, 2, 'skinLight');
      }
      if (pose === 'hit') {
        rect(28, 18, 14, 3, 'skinDeep');
        rect(54, 18, 14, 3, 'skinDeep');
        rect(43, 36, 16, 2, 'outline');
      }

      rect(39, 48, 18, 8, 'outline');
      rect(42, 50, 12, 6, 'skin');
      rect(12, 53, 72, 31, 'outline');
      rect(15, 56, 66, 25, 'suit');
      rect(15, 56, 13, 24, 'suitLight');
      rect(68, 56, 13, 24, 'suitShade');
      rect(28, 52, 40, 8, 'shirt');
      rect(40, 58, 16, 24, 'shirt');
      rect(43, 59, 10, 23, 'tie');
      rect(43, 59, 10, 4, 'gold');
      rect(43, 72, 10, 3, 'gold');
      rect(30, 58, 10, 11, 'suitShade');
      rect(56, 58, 10, 11, 'suitLight');

      const guarding = pose === 'guard';
      const leftArmY = guarding ? 51 : walking && step < 0 ? 59 : 61;
      const rightArmY = guarding ? 48 : walking && step > 0 ? 59 : 61;
      rect(3, leftArmY, 16, 23, 'outline');
      rect(6, leftArmY + 3, 11, 16, 'suit');
      rect(5, leftArmY + 17, 13, 11, 'outline');
      rect(9, leftArmY + 20, 7, 5, 'skinLight');
      if (pose === 'punch') {
        rect(68, 60, 15, 16, 'outline');
        rect(71, 63, 10, 10, 'suitShade');
        rect(81, 57, 14, 15, 'outline');
        rect(84, 60, 9, 9, 'skinLight');
      } else {
        rect(77, rightArmY, 16, 23, 'outline');
        rect(79, rightArmY + 3, 11, 16, 'suitShade');
        rect(78, rightArmY + 17, 13, 11, 'outline');
        rect(81, rightArmY + 20, 7, 5, 'skinLight');
      }

      const leftLegY = walking && step > 0 ? 82 : 84;
      const rightLegY = walking && step < 0 ? 82 : 84;
      rect(24, leftLegY, 20, 17, 'outline');
      rect(51, rightLegY, 20, 17, 'outline');
      rect(28, leftLegY + 3, 12, 12, 'pants');
      rect(55, rightLegY + 3, 12, 12, 'pants');
      rect(18, 99 + (walking && step > 0 ? -2 : 0), 27, 8, 'outline');
      rect(51, 99 + (walking && step < 0 ? -2 : 0), 27, 8, 'outline');
      rect(22, 101 + (walking && step > 0 ? -2 : 0), 20, 4, 'shoe');
      rect(55, 101 + (walking && step < 0 ? -2 : 0), 20, 4, 'shoe');

      graphics.generateTexture(textureKey, 96, 108);
      graphics.destroy();
    }

    sync(players, phase, teamHealth = { red: 100, blue: 100 }, sideNames = { red: 'Lula', blue: 'Bolsonaro' }) {
      this.phase = phase;
      for (const team of ['red', 'blue']) {
        const x = team === 'red' ? 325 : 675;
        const y = 207;
        let fighter = this.fighters.get(team);
        if (!fighter) {
          fighter = this.createFighter({ team, displayName: sideNames[team] }, x, y);
          this.fighters.set(team, fighter);
        }
        const health = teamHealth[team] ?? 100;
        const supporters = players.filter((player) => player.team === team).length;
        fighter.container.setAlpha(health > 0 ? 1 : .28);
        fighter.container.setPosition(x, y);
        fighter.name.textContent = sideNames[team];
        fighter.name.setAttribute('aria-label', sideNames[team]);
        fighter.supporters.setText(`${supporters} APOIADORES`);
        fighter.healthBar.width = Math.max(0, 118 * health / 100);
        fighter.healthBar.fillColor = health < 30 ? 0xff5269 : team === 'red' ? 0xff8290 : 0x76b5ff;
        fighter.healthText.setText(`${Math.round(health)}%`);
        fighter.healthBack.setVisible(true);
      }
      if (phase === 'waiting' && players.length === 0) this.drawWaiting();
      else this.removeWaiting();
    }

    createFighter(player, x, y) {
      const tint = player.team === 'red' ? red : blue;
      const container = this.add.container(x, y);
      const aura = this.add.rectangle(0, -8, 144, 180, tint, .045);
      const frame = this.add.rectangle(0, -8, 190, 196, tint, 0);
      frame.setStrokeStyle(5, tint, .98);
      const floor = this.add.rectangle(0, 76, 86, 8, 0x07090e, .85);
      const floorGlow = this.add.rectangle(0, 72, 58, 3, tint, .85);
      const body = this.add.image(0, 0, `pixel-fighter-${player.team}`)
        .setOrigin(.5, .5)
        .setFrame(1)
        .setPosition(0, 12)
        .setScale(1.45, 1.15)
        .setFlipX(player.team === 'blue');
      const defense = this.add.rectangle(0, -8, 202, 204, 0x8dc2ff, 0);
      defense.setStrokeStyle(3, 0x8dc2ff, .65);
      defense.setVisible(false);
      container.add([aura, frame, floor, floorGlow, body, defense]);
      const supporters = this.add.text(x, y + 126, '', { fontFamily: 'DM Mono, monospace', fontSize: '8px', color: '#a7b1c2', align: 'center', stroke: '#080a10', strokeThickness: 3 }).setOrigin(.5, .5);
      const healthBack = this.add.rectangle(x, y + 145, 124, 8, 0x101522).setOrigin(.5);
      healthBack.setStrokeStyle(2, tint, .45);
      const healthBar = this.add.rectangle(x - 60, y + 145, 118, 4, green).setOrigin(0, .5);
      const healthText = this.add.text(x + 69, y + 145, '', { fontFamily: 'DM Mono, monospace', fontSize: '8px', color: '#d9e1ef' }).setOrigin(0, .5);
      const fighter = {
        team: player.team, container, body, aura, name: this.fighterNames[player.team], supporters, healthBack, healthBar,
        healthText, defense, idleY: y, isActing: false, animationToken: 0,
        idlePose: 'idle', motionTween: null, hitAnimationToken: 0
      };
      const bodyRestY = body.y;
      this.tweens.add({ targets: body, y: bodyRestY - 2, duration: 560, yoyo: true, repeat: -1, ease: 'Stepped', easeParams: [4] });
      fighter.idleAnimation = this.time.addEvent({
        delay: 680,
        loop: true,
        callback: () => {
          if (fighter.isActing) return;
          fighter.idlePose = fighter.idlePose === 'idle' ? 'guard' : 'idle';
          this.setFighterPose(fighter, fighter.idlePose);
        }
      });
      return fighter;
    }

    setFighterPose(fighter, pose) {
      if (!fighter?.body?.active) return;
      const frameByPose = { idle: 1, guard: 1, walk1: 2, walk2: 0, punch: 3, kick: 4, hit: 5, knockout: 6 };
      fighter.body.setFrame(frameByPose[pose] ?? 1);
    }

    drawWaiting() {
      if (this.waitingText?.active) return;
      this.waitingText = this.add.text(500, 125, 'A ARENA ESPERA POR VOCE', {
        fontFamily: 'DM Mono, monospace', fontSize: '12px', color: '#697386', letterSpacing: 3
      }).setOrigin(.5);
      this.tweens.add({ targets: this.waitingText, alpha: .35, duration: 1200, yoyo: true, repeat: -1 });
    }

    removeWaiting() {
      if (this.waitingText?.active) {
        this.waitingText.destroy();
        this.waitingText = null;
      }
    }

    flash(kind) {
      const x = kind === 'elimination' ? 500 : 490 + Math.random() * 20;
      const color = kind === 'special' ? green : kind === 'gift' ? 0xffd980 : 0xff7181;
      const flare = this.add.rectangle(x, 264, 12, 12, color, .9);
      this.tweens.add({ targets: flare, scale: 6, alpha: 0, duration: 550, ease: 'Stepped', easeParams: [5], onComplete: () => flare.destroy() });
    }

    attack(action) {
      const attacker = this.fighters.get(action.attackerTeam);
      const target = this.fighters.get(action.targetTeam);
      if (!attacker || !target) return;
      const originX = action.attackerTeam === 'red' ? 325 : 675;
      const direction = action.attackerTeam === 'red' ? 1 : -1;
      attacker.motionTween?.stop();
      attacker.animationToken += 1;
      const animationToken = attacker.animationToken;
      attacker.isActing = true;
      attacker.container.x = originX;
      this.setFighterPose(attacker, 'walk1');
      const lunge = this.tweens.add({
        targets: attacker.container,
        x: originX + direction * 26,
        duration: 150,
        ease: 'Stepped',
        easeParams: [4],
        onUpdate: (tween) => this.setFighterPose(attacker, tween.progress < .5 ? 'walk1' : 'walk2'),
        onComplete: () => {
          if (animationToken !== attacker.animationToken) return;
          this.setFighterPose(attacker, action.special ? 'kick' : 'punch');
          attacker.motionTween = this.tweens.add({
            targets: attacker.container,
            x: originX,
            duration: 180,
            ease: 'Stepped',
            easeParams: [4],
            onComplete: () => {
              if (animationToken !== attacker.animationToken) return;
              attacker.isActing = false;
              attacker.motionTween = null;
              this.setFighterPose(attacker, attacker.idlePose);
            }
          });
        }
      });
      attacker.motionTween = lunge;
      target.hitAnimationToken += 1;
      const hitToken = target.hitAnimationToken;
      if (!target.isActing) {
        this.setFighterPose(target, 'hit');
        const targetX = action.targetTeam === 'red' ? 325 : 675;
        target.motionTween?.stop();
        target.motionTween = this.tweens.add({
          targets: target.container,
          x: targetX + direction * 10,
          y: target.idleY + 3,
          duration: 75,
          yoyo: true,
          ease: 'Stepped',
          easeParams: [3],
          onComplete: () => {
            if (hitToken !== target.hitAnimationToken) return;
            target.motionTween = null;
            this.setFighterPose(target, target.idlePose);
          }
        });
      }
      this.time.delayedCall(260, () => {
        if (hitToken === target.hitAnimationToken && !target.isActing) {
          this.setFighterPose(target, target.idlePose);
        }
      });
      const projectile = this.add.rectangle(originX + direction * 70, 253, 18, 10, action.special ? green : action.attackerTeam === 'red' ? red : blue, .95);
      this.tweens.add({
        targets: projectile,
        x: action.targetTeam === 'red' ? 325 : 675,
        alpha: .1,
        duration: 320,
        ease: 'Stepped',
        easeParams: [6],
        onComplete: () => {
          projectile.destroy();
          this.flash(action.special ? 'special' : 'attack');
          const damageText = this.add.text(target.container.x, 194, `-${action.damage}!`, {
            fontFamily: 'DM Mono, monospace', fontSize: '19px', color: '#ff8a95', stroke: '#090b10', strokeThickness: 4
          }).setOrigin(.5);
          this.tweens.add({ targets: damageText, y: 154, alpha: 0, duration: 700, ease: 'Stepped', easeParams: [8], onComplete: () => damageText.destroy() });
          const attackerColor = action.special ? green : action.attackerTeam === 'red' ? red : blue;
          attacker.aura.setFillStyle(attackerColor, .3);
          target.aura.setFillStyle(0xff5269, .36);
          this.time.delayedCall(180, () => attacker.aura.setFillStyle(attackerColor, .08));
          this.time.delayedCall(260, () => target.aura.setFillStyle(action.targetTeam === 'red' ? red : blue, .08));
          for (let i = 0; i < 8; i += 1) {
            const spark = this.add.rectangle(
              target.container.x + (i % 4) * 8 - 12,
              target.container.y - 26 - Math.floor(i / 4) * 12,
              5,
              5,
              i % 2 ? 0xffd166 : 0xffffff
            );
            this.tweens.add({ targets: spark, x: spark.x + (i % 2 ? 16 : -16), y: spark.y - 12, alpha: 0, duration: 260, ease: 'Stepped', easeParams: [4], onComplete: () => spark.destroy() });
          }
        }
      });
      const comment = this.add.text(originX, 102, `@${String(action.attacker || 'CHAT').slice(0, 20)}`, {
        fontFamily: 'DM Mono, monospace', fontSize: '9px', color: '#f2f3f6', stroke: '#090b10', strokeThickness: 3
      }).setOrigin(.5);
      this.tweens.add({ targets: comment, y: 82, alpha: 0, duration: 800, ease: 'Stepped', easeParams: [8], onComplete: () => comment.destroy() });
    }
  }

  function bootGame() {
    if (!window.Phaser || !$('#game-canvas')) {
      toast('Não foi possível carregar o motor Phaser. Atualize a página.', true);
      return;
    }
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game-canvas',
      width: 1000,
      height: 520,
      backgroundColor: '#0a0c12',
      transparent: false,
      render: { antialias: false, pixelArt: true, roundPixels: true, powerPreference: 'low-power' },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: [ArenaScene]
    });
  }

  function emitCommand(command) {
    if (!state.joined) return toast('Entre em uma equipe para comandar seu personagem.', true);
    socket.emit('player:command', { command });
  }

  function joinTeam(team) {
    const name = $('#player-name').value.trim();
    if (!name) {
      $('#player-name').focus();
      return toast('Escolha seu nome de jogador primeiro.', true);
    }
    if (state.joined) return toast('Você já está participando desta rodada.');
    socket.emit('player:join', { displayName: name, team });
  }

  async function openAdmin() {
    $('#admin-modal').classList.remove('hidden');
    $('#admin-modal').setAttribute('aria-hidden', 'false');
    const status = await request('/api/admin/status').catch((error) => ({ configured: false, authenticated: false, error }));
    if (status.authenticated) {
      showAdminContent();
      await loadSettings();
    } else {
      $('#login-form').classList.remove('hidden');
      $('#admin-content').classList.add('hidden');
      $('#login-message').textContent = status.configured ? '' : 'O administrador precisa configurar ADMIN_PASSWORD no ambiente do servidor.';
      $('#login-form button').disabled = !status.configured;
      $('#admin-password').focus();
    }
  }

  function showAdminContent() {
    $('#login-form').classList.add('hidden');
    $('#admin-content').classList.remove('hidden');
    if (state.snapshot) updateLive(state.snapshot.live);
  }

  async function loadSettings() {
    const settings = await request('/api/admin/settings');
    $('#setting-duration').value = settings.matchDuration;
    $('#setting-players').value = settings.maxPlayers;
    $('#setting-likes').value = settings.likeGoal;
    $('#setting-side-red').value = settings.sideNames?.red || 'Lula';
    $('#setting-side-blue').value = settings.sideNames?.blue || 'Bolsonaro';
    renderGiftRules(settings.gifts);
  }

  function createGiftField(labelText, control) {
    const label = document.createElement('label');
    label.append(document.createTextNode(labelText), control);
    return label;
  }

  function createGiftRuleRow(name = '', rule = {}) {
    const row = document.createElement('div');
    row.className = 'gift-rule-row';

    const giftName = document.createElement('input');
    giftName.type = 'text';
    giftName.maxLength = 48;
    giftName.placeholder = 'Ex.: Rose';
    giftName.value = name;
    giftName.autocomplete = 'off';
    giftName.required = true;
    giftName.setAttribute('aria-label', 'Nome do presente no TikTok');

    const action = document.createElement('select');
    action.setAttribute('aria-label', 'Efeito do presente');
    for (const [value, label] of [
      ['heal', 'Curar o time'],
      ['energy', 'Carregar energia'],
      ['strike', 'Dano ao rival'],
      ['shield', 'Escudo por 8s']
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      action.append(option);
    }
    action.value = rule.action || 'heal';

    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '1';
    amount.max = '100';
    amount.step = '1';
    amount.value = String(rule.amount ?? 12);
    amount.required = true;
    amount.setAttribute('aria-label', 'Intensidade do efeito');

    const label = document.createElement('input');
    label.type = 'text';
    label.maxLength = 32;
    label.placeholder = 'Ex.: Rosa';
    label.value = rule.label || '';
    label.setAttribute('aria-label', 'Rótulo exibido na arena');

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'gift-rule-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remover regra de presente');
    remove.addEventListener('click', () => {
      row.remove();
      renderGiftRuleEmptyState();
      updateGiftRuleAddButton();
    });

    row.append(
      createGiftField('Nome no TikTok', giftName),
      createGiftField('Efeito', action),
      createGiftField('Intensidade', amount),
      createGiftField('Rótulo', label),
      remove
    );
    return row;
  }

  function renderGiftRuleEmptyState() {
    const container = $('#gift-rules');
    const empty = container.querySelector('.gift-rules-empty');
    if (container.querySelector('.gift-rule-row')) {
      empty?.remove();
    } else if (!empty) {
      const message = document.createElement('p');
      message.className = 'gift-rules-empty';
      message.textContent = 'Nenhuma regra configurada. Adicione um presente para definir um efeito.';
      container.append(message);
    }
  }

  function updateGiftRuleAddButton() {
    const count = $('#gift-rules').querySelectorAll('.gift-rule-row').length;
    $('#gift-rule-add').disabled = count >= 30;
    $('#gift-rule-add').textContent = count >= 30 ? 'Limite de 30 regras' : '+ Adicionar presente';
  }

  function renderGiftRules(gifts = {}) {
    const container = $('#gift-rules');
    container.replaceChildren();
    for (const [name, rule] of Object.entries(gifts)) {
      container.append(createGiftRuleRow(name, rule));
    }
    renderGiftRuleEmptyState();
    updateGiftRuleAddButton();
  }

  function readGiftRules() {
    const gifts = Object.create(null);
    for (const row of $('#gift-rules').querySelectorAll('.gift-rule-row')) {
      const [nameInput, actionInput, amountInput, labelInput] = row.querySelectorAll('input, select');
      const name = nameInput.value.trim().toLowerCase();
      if (!name) throw new Error('Informe o nome de cada presente.');
      if (Object.hasOwn(gifts, name)) throw new Error(`O presente "${name}" está configurado mais de uma vez.`);
      const amount = Number(amountInput.value);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
        throw new Error(`A intensidade de "${name}" deve ser um número entre 1 e 100.`);
      }
      gifts[name] = {
        action: actionInput.value,
        amount,
        label: labelInput.value.trim() || name
      };
    }
    return gifts;
  }

  function setMessage(selector, message, success = false) {
    const element = $(selector);
    element.textContent = message;
    element.classList.toggle('success', success);
  }

  socket.on('connect', () => {
    $('#footer-system b').textContent = 'CONECTADO';
    $('#footer-system i').style.background = '#c4fa58';
  });
  socket.on('disconnect', () => {
    state.joined = false;
    $('#joined-badge').classList.add('hidden');
    $('#footer-system b').textContent = 'RECONEXÃO';
    $('#footer-system i').style.background = '#ff5269';
    toast('Conexão de jogo interrompida. Reconectando...', true);
  });
  socket.on('game:state', renderSnapshot);
  socket.on('player:joined', (data) => {
    state.joined = true;
    state.username = data.username;
    $('#joined-badge').classList.remove('hidden');
    toast('Você entrou na arena! Boa batalha.');
  });
  socket.on('chat:reply', (data) => {
    if (data?.message) toast(data.message);
  });
  socket.on('activity', (item) => {
    if (state.scene && ['elimination', 'attack', 'special', 'gift'].includes(item.kind)) state.scene.flash(item.kind);
  });
  socket.on('fight:action', (action) => {
    if (state.scene) state.scene.attack(action);
  });

  $('#join-red').addEventListener('click', () => joinTeam('red'));
  $('#join-blue').addEventListener('click', () => joinTeam('blue'));
  document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => emitCommand(button.dataset.command)));
  $('#top-command').addEventListener('click', () => {
    if (state.joined) emitCommand('!top');
    else {
      const leaders = state.snapshot?.leaderboard || [];
      toast(leaders.length ? `TOP: ${leaders.slice(0, 3).map((item, index) => `${index + 1}. ${item.displayName} (${item.points} pts)`).join(' · ')}` : 'Ainda não há pontuação na arena.');
    }
  });
  $('#player-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinTeam('red');
  });
  $('#demo-start').addEventListener('click', async () => {
    try {
      await request('/api/demo/start', { method: 'POST', body: {} });
      toast('Partida de demonstração iniciada.');
    } catch (error) { toast(error.message, true); }
  });
  $('#demo-event').addEventListener('click', async () => {
    try {
      await request('/api/demo/event', { method: 'POST', body: {} });
    } catch (error) { toast(error.message, true); }
  });
  $('#demo-comment').addEventListener('click', async () => {
    try {
      const result = await request('/api/demo/comment', { method: 'POST', body: { comment: 'Quero apoiar esse lutador!' } });
      toast(state.snapshot?.phase === 'fighting' ? `${result.displayName} entrou no chat e atacou!` : `${result.displayName} entrou no chat; inicie a luta.`);
    } catch (error) { toast(error.message, true); }
  });

  $('#admin-open').addEventListener('click', () => openAdmin().catch((error) => toast(error.message, true)));
  $('#footer-admin').addEventListener('click', () => openAdmin().catch((error) => toast(error.message, true)));
  $('#admin-close').addEventListener('click', closeAdmin);
  document.querySelector('[data-close-modal]').addEventListener('click', closeAdmin);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAdmin(); });

  function closeAdmin() {
    $('#admin-modal').classList.add('hidden');
    $('#admin-modal').setAttribute('aria-hidden', 'true');
  }

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage('#login-message', '');
    try {
      await request('/api/admin/login', { method: 'POST', body: { password: $('#admin-password').value } });
      $('#admin-password').value = '';
      showAdminContent();
      await loadSettings();
    } catch (error) { setMessage('#login-message', error.message); }
  });

  $('#live-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage('#live-error', 'Conectando…');
    try {
      await request('/api/admin/live/connect', { method: 'POST', body: { username: $('#live-username').value } });
      setMessage('#live-error', 'Conectado. Eventos reais da transmissão estão chegando.', true);
    } catch (error) { setMessage('#live-error', error.message); }
  });
  $('#live-disconnect').addEventListener('click', async () => {
    try {
      await request('/api/admin/live/disconnect', { method: 'POST', body: {} });
      setMessage('#live-error', 'Transmissão desconectada.', true);
    } catch (error) { setMessage('#live-error', error.message); }
  });

  $('#gift-rule-add').addEventListener('click', () => {
    const container = $('#gift-rules');
    if (container.querySelectorAll('.gift-rule-row').length >= 30) return;
    container.querySelector('.gift-rules-empty')?.remove();
    const row = createGiftRuleRow();
    container.append(row);
    updateGiftRuleAddButton();
    row.querySelector('input').focus();
  });

  $('#demo-toggle').addEventListener('change', async (event) => {
    try {
      await request('/api/admin/demo', { method: 'POST', body: { enabled: event.target.checked } });
      toast(event.target.checked ? 'Modo de demonstração habilitado.' : 'Modo de demonstração desabilitado.');
    } catch (error) { toast(error.message, true); }
  });
  $('#match-start').addEventListener('click', async () => {
    try {
      await request('/api/admin/match/start', { method: 'POST', body: {} });
      toast('Partida iniciada.');
    } catch (error) { toast(error.message, true); }
  });
  $('#match-stop').addEventListener('click', async () => {
    try {
      await request('/api/admin/match/stop', { method: 'POST', body: {} });
      toast('Partida encerrada.');
    } catch (error) { toast(error.message, true); }
  });
  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage('#settings-message', '');
    try {
      const gifts = readGiftRules();
      await request('/api/admin/settings', {
        method: 'PUT',
        body: {
          matchDuration: Number($('#setting-duration').value),
          maxPlayers: Number($('#setting-players').value),
          likeGoal: Number($('#setting-likes').value),
          sideNames: { red: $('#setting-side-red').value, blue: $('#setting-side-blue').value },
          gifts
        }
      });
      setMessage('#settings-message', 'Configurações salvas.', true);
      toast('Regras da arena atualizadas.');
    } catch (error) {
      setMessage('#settings-message', error.message);
    }
  });
  $('#admin-logout').addEventListener('click', async () => {
    try {
      await request('/api/admin/logout', { method: 'POST', body: {} });
      closeAdmin();
      toast('Sessão administrativa encerrada.');
    } catch (error) { toast(error.message, true); }
  });

  bootGame();
})();
