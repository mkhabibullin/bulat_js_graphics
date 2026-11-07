import * as THREE from 'three';

/** A camera-facing rounded label, used for name tags and chat bubbles. */
export function makeLabel(
  text: string,
  options: { background: string; color: string; fontSize?: number; maxWidth?: number; scale?: number },
): THREE.Sprite {
  const fontSize = options.fontSize ?? 34;
  const maxWidth = options.maxWidth ?? 520;
  const padX = 22;
  const padY = 12;
  const font = `700 ${fontSize}px ui-rounded, "Segoe UI", system-ui, sans-serif`;
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d')!;
  measure.font = font;

  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const attempt = line ? `${line} ${word}` : word;
    if (measure.measureText(attempt).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = attempt;
    }
    if (lines.length === 3) break;
  }
  if (lines.length < 3 && line) lines.push(line);

  const textWidth = Math.min(maxWidth, Math.max(...lines.map((l) => measure.measureText(l).width)));
  const lineHeight = fontSize * 1.22;
  canvas.width = Math.ceil(textWidth + padX * 2);
  canvas.height = Math.ceil(lines.length * lineHeight + padY * 2);

  const g = canvas.getContext('2d')!;
  g.font = font;
  g.fillStyle = options.background;
  g.beginPath();
  g.roundRect(0, 0, canvas.width, canvas.height, 18);
  g.fill();
  g.fillStyle = options.color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((l, i) => g.fillText(l, canvas.width / 2, padY + lineHeight * (i + 0.5), maxWidth));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false });
  const sprite = new THREE.Sprite(material);
  const scale = (options.scale ?? 0.0075);
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  sprite.center.set(0.5, 0);
  return sprite;
}

export function disposeLabel(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
  sprite.removeFromParent();
}
