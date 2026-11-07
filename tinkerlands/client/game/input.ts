import { settings } from '../settings.ts';

export interface InputCallbacks {
  onJumpKey?: () => void;
  onKey: (code: string, event: KeyboardEvent) => void;
  /** The main button went down. It counts as held until onPrimaryEnd. */
  onPrimary: () => void;
  onPrimaryEnd: () => void;
  onSecondary: () => void;
  onWheel: (delta: number) => void;
  onLockLost: () => void;
}

/** Keyboard, mouse (pointer lock) and touch input, reduced to a move vector and look angles. */
export class InputController {
  yaw = 0;
  pitch = -0.25;
  jumpHeld = false;
  readonly touch: boolean;
  private readonly keys = new Set<string>();
  private readonly canvas: HTMLElement;
  private readonly cb: InputCallbacks;
  private readonly controller = new AbortController();
  private enabled = true;
  private ignoreLockLoss = false;
  private stickX = 0;
  private stickY = 0;
  private stickPointer: number | null = null;
  private lookPointer: number | null = null;
  private lastLookX = 0;
  private lastLookY = 0;
  private dragging = false;

  constructor(canvas: HTMLElement, cb: InputCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    this.touch = window.matchMedia('(pointer: coarse)').matches;
    const opts = { signal: this.controller.signal };

    window.addEventListener('keydown', (e) => this.onKeyDown(e), opts);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code), opts);
    window.addEventListener('blur', () => {
      this.clearKeys();
      // The mouse-up can happen in another window, where we'd never see it.
      this.cb.onPrimaryEnd();
    }, opts);
    document.addEventListener('mousemove', (e) => this.onMouseMove(e), opts);
    document.addEventListener('pointerlockchange', () => this.onLockChange(), opts);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cb.onWheel(Math.sign(e.deltaY));
    }, { signal: this.controller.signal, passive: false });
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e), opts);
    window.addEventListener('mouseup', (e) => {
      this.dragging = false;
      if (e.button === 0) this.cb.onPrimaryEnd();
    }, opts);

    if (this.touch) {
      canvas.addEventListener('pointerdown', (e) => this.onLookStart(e), opts);
      window.addEventListener('pointermove', (e) => this.onLookMove(e), opts);
      window.addEventListener('pointerup', (e) => this.onLookEnd(e), opts);
      window.addEventListener('pointercancel', (e) => this.onLookEnd(e), opts);
    }
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clearKeys();
  }

  private clearKeys(): void {
    this.keys.clear();
    this.jumpHeld = false;
  }

  requestLock(): void {
    if (this.touch || this.locked) return;
    try {
      const result = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      // Browsers refuse a re-lock right after Esc; the click-to-resume overlay covers it.
      result?.catch?.(() => {});
    } catch {
      // Pointer lock unsupported: dragging with the mouse still works.
    }
  }

  /** Releases the mouse on purpose (chat, palette) without opening the pause menu. */
  releaseLock(): void {
    if (!this.locked) return;
    this.ignoreLockLoss = true;
    document.exitPointerLock();
  }

  private onLockChange(): void {
    if (this.locked) return;
    if (this.ignoreLockLoss) {
      this.ignoreLockLoss = false;
      return;
    }
    this.clearKeys();
    this.cb.onLockLost();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'Tab' || e.code === 'ArrowUp' || e.code === 'ArrowDown') e.preventDefault();
    this.cb.onKey(e.code, e);
    if (this.enabled) this.keys.add(e.code);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.locked && !this.dragging) return;
    this.look(e.movementX, e.movementY);
  }

  private look(dx: number, dy: number): void {
    const scale = 0.0024 * settings.sensitivity;
    this.yaw -= dx * scale;
    this.pitch -= dy * scale * (settings.invertY ? -1 : 1);
    this.pitch = Math.max(-1.45, Math.min(1.35, this.pitch));
  }

  private onMouseDown(e: MouseEvent): void {
    if (this.touch) return;
    if (!this.locked) {
      this.requestLock();
      // Without pointer lock (it can be refused), holding a button drags the view.
      this.dragging = true;
      return;
    }
    if (e.button === 0) this.cb.onPrimary();
    else if (e.button === 2) this.cb.onSecondary();
  }

  // --- Touch look: drag anywhere on the canvas that isn't a control. ---

  private onLookStart(e: PointerEvent): void {
    if (this.lookPointer !== null) return;
    this.lookPointer = e.pointerId;
    this.lastLookX = e.clientX;
    this.lastLookY = e.clientY;
  }

  private onLookMove(e: PointerEvent): void {
    if (e.pointerId !== this.lookPointer) return;
    this.look((e.clientX - this.lastLookX) * 1.6, (e.clientY - this.lastLookY) * 1.6);
    this.lastLookX = e.clientX;
    this.lastLookY = e.clientY;
  }

  private onLookEnd(e: PointerEvent): void {
    if (e.pointerId === this.lookPointer) this.lookPointer = null;
  }

  /** Connects the on-screen joystick element. */
  bindJoystick(base: HTMLElement, knob: HTMLElement): void {
    const radius = 46;
    const opts = { signal: this.controller.signal };
    const update = (e: PointerEvent): void => {
      const rect = base.getBoundingClientRect();
      let dx = e.clientX - (rect.left + rect.width / 2);
      let dy = e.clientY - (rect.top + rect.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > radius) {
        dx = (dx / len) * radius;
        dy = (dy / len) * radius;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.stickX = dx / radius;
      this.stickY = dy / radius;
    };
    base.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.stickPointer = e.pointerId;
      base.setPointerCapture(e.pointerId);
      update(e);
    }, opts);
    base.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickPointer) update(e);
    }, opts);
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      this.stickX = 0;
      this.stickY = 0;
      knob.style.transform = '';
    };
    base.addEventListener('pointerup', release, opts);
    base.addEventListener('pointercancel', release, opts);
  }

  setTouchJump(held: boolean): void {
    this.jumpHeld = held;
  }

  /** Current movement intent, with each axis from -1 to 1. */
  sample(): { fwd: number; strafe: number; jump: boolean } {
    if (!this.enabled) return { fwd: 0, strafe: 0, jump: false };
    const k = this.keys;
    let fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    if (this.stickPointer !== null) {
      fwd = -this.stickY;
      strafe = this.stickX;
    }
    return { fwd, strafe, jump: k.has('Space') || this.jumpHeld };
  }

  dispose(): void {
    this.controller.abort();
    if (this.locked) {
      this.ignoreLockLoss = true;
      document.exitPointerLock();
    }
  }
}
