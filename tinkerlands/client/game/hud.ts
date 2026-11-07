import { BLOCKS } from '../../shared/blocks.ts';
import { MAX_CHAT_LENGTH } from '../../shared/constants.ts';
import type { PlayerInfo } from '../../shared/protocol.ts';
import { api, ApiError } from '../api.ts';
import { clear, formatTime, h, toast } from '../dom.ts';
import { saveSettings, settings } from '../settings.ts';
import type { AtlasInfo } from './atlas.ts';
import { TILE } from './atlas.ts';
import type { InputController } from './input.ts';

/** What the HUD needs from the game. Keeps the dependency one-directional. */
export interface HudHost {
  resume(): void;
  chatClosed(): void;
  sendChat(text: string): void;
  setPauseInput(paused: boolean): void;
  setTouchJump(held: boolean): void;
  leave(): void;
  restartRun(): void;
  toggleBuild(): void;
  togglePalette(): void;
  chooseBlock(block: number): void;
  paletteBlocks(): number[];
  selectSlot(slot: number): void;
  primaryAction(): void;
  primaryEnd(): void;
  secondaryAction(): void;
  emote(index: number): void;
  worldId(): string;
  isWorldOwner(): boolean;
  listPlayers(): PlayerInfo[];
  isMuted(uid: string): boolean;
  toggleMute(uid: string): void;
  kickPlayer(id: number): void;
  retryConnection(): void;
}

const REPORT_REASONS = ['Bullying or harassment', 'Inappropriate language', 'Inappropriate content', 'Cheating or griefing', 'Asking for personal information', 'Something else'];

export class GameHud {
  private readonly host: HudHost;
  private readonly root: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly loadingText: HTMLElement;
  private readonly fatal: HTMLElement;
  private readonly worldName: HTMLElement;
  private readonly coins: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly best: HTMLElement;
  private readonly timerBox: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly coords: HTMLElement;
  private readonly hotbar: HTMLElement;
  private readonly buildButton: HTMLButtonElement;
  private readonly buildHint: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly chatLog: HTMLElement;
  private readonly chatInput: HTMLInputElement;
  private readonly bannerEl: HTMLElement;
  private readonly flashEl: HTMLElement;
  private readonly finish: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly playerList: HTMLElement;
  private readonly palette: HTMLElement;
  private readonly touchControls: HTMLElement;
  private readonly touchBuild: HTMLElement;
  private atlas: AtlasInfo | null = null;
  private bannerTimer = 0;
  private lastTimerText = '';
  private lastBest: number | null | undefined = undefined;
  private isTouch = false;
  private myName = '';
  private helpSeen = false;

  constructor(container: HTMLElement, host: HudHost) {
    this.host = host;
    this.loadingText = h('p', {}, 'Connecting…');
    this.loading = h('div', { class: 'overlay overlay-solid' }, h('div', { class: 'spinner' }), this.loadingText);
    this.fatal = h('div', { class: 'overlay overlay-solid hidden' });

    this.worldName = h('span', { class: 'hud-world' });
    this.coins = h('span', { class: 'hud-coins', title: 'Your coins' }, '0');
    this.stats = h('span', { class: 'hud-stats' });
    this.coords = h('span', { class: 'hud-stats' });
    const menuButton = h('button', { class: 'hud-btn', 'aria-label': 'Open menu', onclick: () => this.openPause() }, '☰');

    this.timer = h('div', { class: 'timer-value' }, '0:00.00');
    this.best = h('div', { class: 'timer-best' });
    this.timerBox = h('div', { class: 'timer hidden' }, this.timer, this.best);

    this.hotbar = h('div', { class: 'hotbar hidden', role: 'toolbar', 'aria-label': 'Blocks' });
    this.buildButton = h('button', { class: 'hud-btn build-toggle hidden', onclick: () => this.host.toggleBuild() }, 'Build (B)');
    this.buildHint = h('div', { class: 'build-hint hidden' }, 'Hold left-click: break · Right-click: place, or light TNT · E: all blocks · 1–9 or wheel: choose');
    this.crosshair = h('div', { class: 'crosshair hidden' });

    this.chatLog = h('div', { class: 'chat-log', role: 'log', 'aria-label': 'Chat' });
    this.chatInput = h('input', {
      class: 'chat-input hidden',
      maxlength: MAX_CHAT_LENGTH,
      placeholder: 'Say something…',
      'aria-label': 'Chat message',
      autocomplete: 'off',
    });
    this.chatInput.addEventListener('keydown', (e) => this.onChatKey(e));
    this.chatInput.addEventListener('blur', () => {
      if (!this.chatInput.classList.contains('hidden')) this.closeChat(false);
    });

    this.bannerEl = h('div', { class: 'banner hidden', 'aria-live': 'polite' });
    this.flashEl = h('div', { class: 'flash' });
    this.finish = h('div', { class: 'finish hidden' });
    this.playerList = h('div', { class: 'player-list' });
    this.pause = this.buildPause();
    this.palette = h('div', { class: 'overlay palette hidden' });
    this.touchBuild = h(
      'div',
      { class: 'touch-build hidden' },
      h(
        'button',
        {
          class: 'touch-btn',
          onpointerdown: () => this.host.primaryAction(),
          onpointerup: () => this.host.primaryEnd(),
          onpointercancel: () => this.host.primaryEnd(),
          onpointerleave: () => this.host.primaryEnd(),
        },
        'Hold: break',
      ),
      h('button', { class: 'touch-btn', onclick: () => this.host.secondaryAction() }, 'Place'),
      h('button', { class: 'touch-btn', onclick: () => this.host.togglePalette() }, 'Blocks'),
    );
    this.touchControls = h('div', { class: 'touch-controls hidden' });

    this.root = h(
      'div',
      { class: 'hud' },
      h('div', { class: 'hud-top' }, h('div', { class: 'hud-left' }, menuButton, this.worldName), this.timerBox, h('div', { class: 'hud-right' }, this.coins, this.buildButton)),
      h('div', { class: 'hud-debug' }, this.stats, this.coords),
      this.crosshair,
      this.bannerEl,
      this.finish,
      h('div', { class: 'chat' }, this.chatLog, this.chatInput),
      this.buildHint,
      this.hotbar,
      this.touchControls,
      this.touchBuild,
      this.flashEl,
      this.palette,
      this.pause,
      this.fatal,
      this.loading,
    );
    container.append(this.root);
  }

  private buildPause(): HTMLElement {
    const slider = (label: string, min: number, max: number, step: number, value: number, onInput: (n: number) => void): HTMLElement => {
      const input = h('input', { type: 'range', min, max, step, value });
      input.addEventListener('input', () => onInput(Number(input.value)));
      return h('label', { class: 'field' }, h('span', {}, label), input);
    };
    const invert = h('input', { type: 'checkbox' });
    invert.checked = settings.invertY;
    invert.addEventListener('change', () => {
      settings.invertY = invert.checked;
      saveSettings();
    });
    const quality = h(
      'select',
      {},
      h('option', { value: 'high' }, 'High (with shadows)'),
      h('option', { value: 'low' }, 'Low (faster)'),
    );
    quality.value = settings.quality;
    quality.addEventListener('change', () => {
      settings.quality = quality.value === 'low' ? 'low' : 'high';
      saveSettings();
      toast('Graphics quality applies the next time you join a world.', 'info');
    });

    const reportSelect = h('select', { 'aria-label': 'Reason' }, REPORT_REASONS.map((r) => h('option', { value: r }, r)));
    const reportButton = h('button', { class: 'btn btn-small', onclick: () => void this.sendReport({ worldId: this.host.worldId() }, reportSelect.value) }, 'Report this world');

    return h(
      'div',
      { class: 'overlay pause hidden', role: 'dialog', 'aria-label': 'Menu' },
      h(
        'div',
        { class: 'panel pause-panel' },
        h('h2', {}, 'Paused'),
        h(
          'div',
          { class: 'pause-actions' },
          h('button', { class: 'btn btn-primary', onclick: () => this.host.resume() }, 'Resume'),
          h('button', { class: 'btn', onclick: () => { this.host.restartRun(); this.host.resume(); } }, 'Restart run (R)'),
          h('button', { class: 'btn', onclick: () => this.host.leave() }, 'Leave world'),
        ),
        h('h3', {}, 'Controls'),
        h(
          'ul',
          { class: 'controls' },
          h('li', {}, h('kbd', {}, 'WASD'), ' move'),
          h('li', {}, h('kbd', {}, 'Space'), ' jump'),
          h('li', {}, h('kbd', {}, 'Mouse'), ' look · ', h('kbd', {}, 'Wheel'), ' zoom'),
          h('li', {}, h('kbd', {}, 'Enter'), ' chat'),
          h('li', {}, h('kbd', {}, 'B'), ' build mode'),
          h('li', {}, h('kbd', {}, 'G'), ' wave · ', h('kbd', {}, 'H'), ' dance · ', h('kbd', {}, 'J'), ' cheer'),
        ),
        h('h3', {}, 'Players'),
        this.playerList,
        h('h3', {}, 'Settings'),
        slider('Mouse sensitivity', 0.2, 3, 0.1, settings.sensitivity, (n) => {
          settings.sensitivity = n;
          saveSettings();
        }),
        slider('Volume', 0, 1, 0.05, settings.volume, (n) => {
          settings.volume = n;
          saveSettings();
        }),
        h('label', { class: 'field field-row' }, invert, h('span', {}, 'Invert vertical look')),
        h('label', { class: 'field' }, h('span', {}, 'Graphics'), quality),
        h('h3', {}, 'Report a problem'),
        h('div', { class: 'report-row' }, reportSelect, reportButton),
      ),
    );
  }

  private async sendReport(target: { worldId?: string; targetUserId?: string }, reason: string): Promise<void> {
    try {
      await api.report({ ...target, worldId: this.host.worldId(), reason });
      toast('Thanks. Your report was sent to the moderators.', 'good');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t send the report.', 'error');
    }
  }

  onWorldReady(name: string, input: InputController, atlas: AtlasInfo): void {
    this.worldName.textContent = name;
    this.atlas = atlas;
    this.isTouch = input.touch;
    if (input.touch) this.bindTouch(input);
    this.hideFinish();
    this.closePause();
    if (!this.helpSeen) {
      this.helpSeen = true;
      this.addChat(null, input.touch ? 'Use the stick to move and drag to look around.' : 'WASD to move, Space to jump. Click to capture the mouse, Esc for the menu.');
    }
    this.renderPalette();
  }

  private bindTouch(input: InputController): void {
    clear(this.touchControls);
    this.touchControls.classList.remove('hidden');
    const knob = h('div', { class: 'stick-knob' });
    const stick = h('div', { class: 'stick', 'aria-label': 'Move' }, knob);
    const jump = h('button', { class: 'touch-jump', 'aria-label': 'Jump' }, 'Jump');
    jump.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.host.setTouchJump(true);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      jump.addEventListener(type, () => this.host.setTouchJump(false));
    }
    const chat = h('button', { class: 'touch-chat', 'aria-label': 'Chat', onclick: () => this.focusChat() }, 'Chat');
    this.touchControls.append(stick, jump, chat);
    input.bindJoystick(stick, knob);
  }

  setLoading(text: string | null): void {
    if (text === null) {
      this.loading.classList.add('hidden');
    } else {
      this.loadingText.textContent = text;
      this.loading.classList.remove('hidden');
      this.fatal.classList.add('hidden');
    }
  }

  showFatal(message: string, canRetry = false, reload = false): void {
    this.loading.classList.add('hidden');
    clear(this.fatal);
    this.fatal.append(
      h('div', { class: 'panel' }, h('p', { class: 'fatal-message' }, message),
        h('div', { class: 'pause-actions' },
          canRetry && h('button', { class: 'btn btn-primary', onclick: () => this.host.retryConnection() }, 'Try again'),
          reload && h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Reload'),
          h('button', { class: 'btn', onclick: () => this.host.leave() }, 'Back to worlds'),
        ),
      ),
    );
    this.fatal.classList.remove('hidden');
    this.host.setPauseInput(true);
  }

  setCoins(coins: number): void {
    this.coins.textContent = String(coins);
  }

  setStats(fps: number, rtt: number): void {
    this.stats.textContent = `${fps} fps · ${rtt} ms`;
  }

  setCompass(text: string): void {
    if (this.coords.textContent !== text) this.coords.textContent = text;
  }

  setTimer(elapsed: number | null, best: number | null): void {
    if (elapsed === null && best === null && this.lastTimerText === '') return;
    const visible = elapsed !== null || best !== null;
    this.timerBox.classList.toggle('hidden', !visible);
    if (elapsed !== null) {
      // The server's time is what counts; this display is for pacing.
      const text = formatTime(elapsed);
      if (text !== this.lastTimerText) {
        this.timer.textContent = text;
        this.lastTimerText = text;
      }
    }
    if (best !== this.lastBest) {
      this.lastBest = best;
      this.best.textContent = best === null ? '' : `Best ${formatTime(best)}`;
    }
  }

  banner(text: string, kind: string): void {
    this.bannerEl.textContent = text;
    this.bannerEl.className = `banner banner-${kind}`;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.bannerEl.classList.add('hidden'), 1800);
  }

  flash(): void {
    this.flashEl.classList.remove('flash-on');
    void this.flashEl.offsetWidth; // Restart the CSS animation.
    this.flashEl.classList.add('flash-on');
  }

  showFinish(ms: number, best: number, isBest: boolean, granted: number): void {
    clear(this.finish);
    this.finish.append(
      h('div', { class: 'finish-title' }, 'Finished!'),
      h('div', { class: 'finish-time' }, formatTime(ms)),
      h('div', { class: 'finish-sub' }, isBest ? 'New personal best!' : `Your best: ${formatTime(best)}`),
      granted > 0 ? h('div', { class: 'finish-coins' }, `+${granted} coins`) : '',
      h('button', { class: 'btn btn-primary', onclick: () => this.host.restartRun() }, 'Run it again (R)'),
    );
    this.finish.classList.remove('hidden');
    this.lastTimerText = 'finished';
    this.timer.textContent = formatTime(ms);
  }

  hideFinish(): void {
    this.finish.classList.add('hidden');
  }

  addChat(name: string | null, text: string): void {
    const line = name === null
      ? h('div', { class: 'chat-line chat-system' }, text)
      : h('div', { class: 'chat-line' }, h('b', {}, `${name}: `), text);
    this.chatLog.append(line);
    while (this.chatLog.childElementCount > 40) this.chatLog.firstElementChild?.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
    // Fades out with CSS; hovering or typing brings the whole log back.
    setTimeout(() => line.classList.add('chat-old'), 12000);
  }

  focusChat(): void {
    this.chatInput.classList.remove('hidden');
    this.root.classList.add('chat-open');
    this.chatInput.focus();
  }

  private closeChat(refocus: boolean): void {
    this.chatInput.value = '';
    this.chatInput.classList.add('hidden');
    this.root.classList.remove('chat-open');
    if (refocus) this.chatInput.blur();
    this.host.chatClosed();
  }

  private onChatKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = this.chatInput.value.trim();
      if (text) this.host.sendChat(text);
      this.closeChat(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.closeChat(true);
    }
  }

  setBuild(canBuild: boolean, active: boolean, hotbar: number[], selected: number, isOwner: boolean): void {
    this.buildButton.classList.toggle('hidden', !canBuild);
    this.buildButton.classList.toggle('active', active);
    this.buildButton.textContent = active ? 'Stop building (B)' : isOwner ? 'Edit world (B)' : 'Build (B)';
    this.buildButton.setAttribute('aria-pressed', String(active));
    this.hotbar.classList.toggle('hidden', !active);
    this.crosshair.classList.toggle('hidden', !active);
    this.buildHint.classList.toggle('hidden', !active || this.isTouch);
    this.touchBuild.classList.toggle('hidden', !active || !this.isTouch);
    if (!active) return;
    clear(this.hotbar);
    hotbar.forEach((block, i) => {
      const slot = h(
        'button',
        {
          class: `slot${i === selected ? ' selected' : ''}`,
          title: BLOCKS[block].name,
          'aria-label': `${BLOCKS[block].name}, slot ${i + 1}`,
          onclick: () => this.host.selectSlot(i),
        },
        this.blockIcon(block),
        h('span', { class: 'slot-key' }, String(i + 1)),
      );
      this.hotbar.append(slot);
    });
  }

  private blockIcon(block: number): HTMLCanvasElement {
    const canvas = h('canvas', { class: 'block-icon', width: TILE, height: TILE });
    const g = canvas.getContext('2d')!;
    const pos = this.atlas?.icon[block];
    if (this.atlas && pos && pos.x >= 0) {
      g.drawImage(this.atlas.canvas, pos.x, pos.y, TILE, TILE, 0, 0, TILE, TILE);
    } else {
      g.fillStyle = '#ffc93c';
      g.strokeStyle = '#b57a00';
      g.lineWidth = 4;
      g.beginPath();
      g.arc(24, 24, 16, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    return canvas;
  }

  private renderPalette(): void {
    clear(this.palette);
    const grid = h('div', { class: 'palette-grid' });
    for (const id of this.host.paletteBlocks()) {
      grid.append(
        h(
          'button',
          { class: 'palette-item', onclick: () => this.host.chooseBlock(id), title: BLOCKS[id].description ?? BLOCKS[id].name },
          this.blockIcon(id),
          h('span', {}, BLOCKS[id].name),
        ),
      );
    }
    this.palette.append(
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Blocks'),
        grid,
        h('div', { class: 'pause-actions' }, h('button', { class: 'btn', onclick: () => this.host.togglePalette() }, 'Close (E)')),
      ),
    );
  }

  isPaletteOpen(): boolean {
    return !this.palette.classList.contains('hidden');
  }

  setPaletteOpen(open: boolean): void {
    if (open) this.renderPalette();
    this.palette.classList.toggle('hidden', !open);
  }

  isPaused(): boolean {
    return !this.pause.classList.contains('hidden');
  }

  openPause(): void {
    if (!this.fatal.classList.contains('hidden')) return;
    this.refreshPlayers(this.myName);
    this.pause.classList.remove('hidden');
    this.host.setPauseInput(true);
  }

  closePause(): void {
    this.pause.classList.add('hidden');
  }

  refreshPlayers(myName: string): void {
    this.myName = myName;
    clear(this.playerList);
    this.playerList.append(h('div', { class: 'player-row' }, h('span', { class: 'player-name' }, `${myName} (you)`)));
    const owner = this.host.isWorldOwner();
    for (const p of this.host.listPlayers()) {
      const reportSelect = h('select', { 'aria-label': `Reason for reporting ${p.name}` }, REPORT_REASONS.map((r) => h('option', { value: r }, r)));
      const muted = this.host.isMuted(p.uid);
      this.playerList.append(
        h(
          'div',
          { class: 'player-row' },
          h('span', { class: 'player-name' }, p.name),
          h('button', { class: 'btn btn-small', onclick: () => this.host.toggleMute(p.uid) }, muted ? 'Unmute' : 'Mute'),
          reportSelect,
          h('button', { class: 'btn btn-small', onclick: () => void this.sendReport({ targetUserId: p.uid }, reportSelect.value) }, 'Report'),
          owner && h('button', { class: 'btn btn-small btn-danger', onclick: () => this.host.kickPlayer(p.id) }, 'Remove'),
        ),
      );
    }
  }

  dispose(): void {
    clearTimeout(this.bannerTimer);
    this.root.remove();
  }
}
