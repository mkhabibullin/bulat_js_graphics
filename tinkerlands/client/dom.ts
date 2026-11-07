type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

/**
 * Small element builder. Text goes through text nodes and attributes through
 * setAttribute, so player-supplied strings can never become markup.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') {
      el.addEventListener(key.replace(/^on/, ''), value);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'value') {
      (el as unknown as HTMLInputElement).value = String(value);
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: (Child | Child[])[]): void {
  for (const child of children) {
    if (Array.isArray(child)) append(el, child);
    else if (child !== null && child !== undefined && child !== false) {
      el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
}

export function clear(el: Element): void {
  el.replaceChildren();
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'error' | 'good' = 'info', ms = 3200): void {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const item = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.append(item);
  setTimeout(() => item.remove(), ms);
}

export function formatTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
