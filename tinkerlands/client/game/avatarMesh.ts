import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Avatar } from '../../shared/avatar.ts';

const LEG_HEIGHT = 0.42;
const BODY_HEIGHT = 0.52;
const HEAD_SIZE = 0.68;

// Geometry is shared across every avatar and lives for the whole session.
const geo = {
  head: new RoundedBoxGeometry(HEAD_SIZE, HEAD_SIZE, HEAD_SIZE, 4, 0.15),
  body: new RoundedBoxGeometry(0.52, BODY_HEIGHT, 0.34, 3, 0.09),
  arm: new RoundedBoxGeometry(0.17, 0.46, 0.18, 3, 0.07),
  leg: new RoundedBoxGeometry(0.2, LEG_HEIGHT, 0.22, 3, 0.07),
  facePlane: new THREE.PlaneGeometry(HEAD_SIZE * 0.86, HEAD_SIZE * 0.86),
};

const faceTextures = new Map<string, THREE.CanvasTexture>();

function faceTexture(face: string): THREE.CanvasTexture {
  const cached = faceTextures.get(face);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  const ink = '#26262c';
  g.fillStyle = ink;
  g.strokeStyle = ink;
  g.lineWidth = 7;
  g.lineCap = 'round';
  const eye = (x: number, y = 54, r = 10): void => {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(x + 3, y - 4, r * 0.32, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = ink;
  };
  const smile = (y = 78, width = 20): void => {
    g.beginPath();
    g.arc(64, y, width, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
  };
  switch (face) {
    case 'grin':
      eye(40);
      eye(88);
      g.beginPath();
      g.arc(64, 74, 22, 0, Math.PI);
      g.closePath();
      g.fill();
      g.fillStyle = '#fff';
      g.fillRect(48, 74, 32, 7);
      break;
    case 'wink':
      eye(40);
      g.beginPath();
      g.moveTo(76, 56);
      g.lineTo(100, 50);
      g.stroke();
      smile();
      break;
    case 'shades':
      g.beginPath();
      g.roundRect(20, 42, 40, 24, 6);
      g.roundRect(68, 42, 40, 24, 6);
      g.fill();
      g.fillRect(56, 48, 16, 6);
      smile(80, 16);
      break;
    case 'robot':
      g.fillStyle = '#29b6f6';
      g.fillRect(26, 44, 28, 20);
      g.fillRect(74, 44, 28, 20);
      g.fillStyle = ink;
      for (let x = 38; x < 92; x += 11) g.fillRect(x, 84, 7, 12);
      g.fillRect(34, 80, 60, 4);
      break;
    case 'cat':
      eye(40, 52, 9);
      eye(88, 52, 9);
      g.beginPath();
      g.moveTo(64, 70);
      g.arc(54, 70, 10, 0, Math.PI);
      g.moveTo(74, 70);
      g.arc(64 + 10, 70, 10, Math.PI, 0, true);
      g.stroke();
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(10, 70);
      g.lineTo(32, 74);
      g.moveTo(118, 70);
      g.lineTo(96, 74);
      g.stroke();
      break;
    default:
      eye(40);
      eye(88);
      smile();
      break;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  faceTextures.set(face, texture);
  return texture;
}

function buildHat(id: string, material: (color: number) => THREE.Material): THREE.Group {
  const hat = new THREE.Group();
  const top = HEAD_SIZE / 2;
  const add = (geometry: THREE.BufferGeometry, color: number, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material(color));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    hat.add(mesh);
    return mesh;
  };
  switch (id) {
    case 'cap':
      add(new RoundedBoxGeometry(0.7, 0.18, 0.7, 2, 0.06), 0xe5484d, 0, top + 0.06, 0);
      add(new THREE.BoxGeometry(0.5, 0.04, 0.3), 0xc9313a, 0, top - 0.01, 0.44);
      break;
    case 'flower': {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        add(new THREE.SphereGeometry(0.08, 10, 8), 0xffffff, 0.18 + Math.cos(a) * 0.12, top + 0.06, 0.1 + Math.sin(a) * 0.12);
      }
      add(new THREE.SphereGeometry(0.075, 10, 8), 0xf8cf3f, 0.18, top + 0.08, 0.1);
      break;
    }
    case 'antenna':
      add(new THREE.CylinderGeometry(0.02, 0.02, 0.36, 8), 0x8d939a, 0, top + 0.18, 0);
      add(new THREE.SphereGeometry(0.08, 12, 10), 0xe5484d, 0, top + 0.38, 0);
      break;
    case 'cone':
      add(new THREE.BoxGeometry(0.6, 0.05, 0.6), 0xf5873b, 0, top + 0.02, 0);
      add(new THREE.ConeGeometry(0.22, 0.55, 16), 0xf5873b, 0, top + 0.3, 0);
      add(new THREE.CylinderGeometry(0.13, 0.17, 0.1, 16), 0xffffff, 0, top + 0.26, 0);
      break;
    case 'tophat':
      add(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 20), 0x2f3238, 0, top + 0.02, 0);
      add(new THREE.CylinderGeometry(0.27, 0.27, 0.42, 20), 0x2f3238, 0, top + 0.24, 0);
      add(new THREE.CylinderGeometry(0.275, 0.275, 0.08, 20), 0xe5484d, 0, top + 0.09, 0);
      break;
    case 'propeller': {
      add(new THREE.SphereGeometry(0.3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0x3f8cf0, 0, top - 0.03, 0);
      add(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 6), 0x8d939a, 0, top + 0.31, 0);
      const blades = add(new THREE.BoxGeometry(0.7, 0.02, 0.1), 0xf8cf3f, 0, top + 0.37, 0);
      blades.name = 'spin';
      break;
    }
    case 'wizard': {
      add(new THREE.CylinderGeometry(0.46, 0.46, 0.04, 20), 0x4a55c7, 0, top + 0.02, 0);
      const cone = add(new THREE.ConeGeometry(0.28, 0.75, 16), 0x4a55c7, 0, top + 0.4, 0);
      cone.rotation.x = -0.12;
      add(new THREE.SphereGeometry(0.05, 8, 6), 0xf8cf3f, 0.06, top + 0.42, 0.25);
      break;
    }
    case 'halo': {
      const ring = add(new THREE.TorusGeometry(0.26, 0.035, 8, 24), 0xffe680, 0, top + 0.22, 0);
      ring.rotation.x = Math.PI / 2;
      break;
    }
    case 'crown': {
      add(new THREE.CylinderGeometry(0.27, 0.27, 0.13, 8), 0xf8cf3f, 0, top + 0.07, 0);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        add(new THREE.ConeGeometry(0.07, 0.16, 4), 0xf8cf3f, Math.cos(a) * 0.23, top + 0.2, Math.sin(a) * 0.23);
      }
      add(new THREE.SphereGeometry(0.045, 8, 6), 0xe5484d, 0, top + 0.08, 0.27);
      break;
    }
    default:
      break;
  }
  return hat;
}

export interface AvatarPose {
  speed: number;
  grounded: boolean;
  emote: number;
  time: number;
  /** Swings the right arm, for mining a block. */
  swing?: boolean;
}

/** A player character: its feet are at the group's origin and it faces +Z. */
export class AvatarMesh {
  readonly root = new THREE.Group();
  private readonly model = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly hatGeometries: THREE.BufferGeometry[] = [];
  private spinner: THREE.Object3D | null = null;
  private walkPhase = 0;

  constructor(avatar: Avatar) {
    const mat = (color: THREE.ColorRepresentation): THREE.MeshLambertMaterial => {
      const m = new THREE.MeshLambertMaterial({ color });
      this.materials.push(m);
      return m;
    };
    const skin = mat(avatar.skin);
    const shirt = mat(avatar.shirt);
    const pants = mat(avatar.pants);

    const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(geometry, material);
      m.castShadow = true;
      return m;
    };

    const hipY = LEG_HEIGHT;
    const shoulderY = hipY + BODY_HEIGHT - 0.06;

    const body = mesh(geo.body, shirt);
    body.position.y = hipY + BODY_HEIGHT / 2;
    this.model.add(body);

    this.head.position.y = hipY + BODY_HEIGHT + HEAD_SIZE / 2 - 0.02;
    this.head.add(mesh(geo.head, skin));
    const faceMaterial = new THREE.MeshBasicMaterial({ map: faceTexture(avatar.face), transparent: true, depthWrite: false });
    this.materials.push(faceMaterial);
    const facePlane = new THREE.Mesh(geo.facePlane, faceMaterial);
    facePlane.position.z = HEAD_SIZE / 2 + 0.002;
    this.head.add(facePlane);

    const hat = buildHat(avatar.hat, (color) => mat(color));
    hat.traverse((o) => {
      if (o instanceof THREE.Mesh) this.hatGeometries.push(o.geometry as THREE.BufferGeometry);
    });
    this.spinner = hat.getObjectByName('spin') ?? null;
    this.head.add(hat);
    this.model.add(this.head);

    const limb = (group: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, length: number): void => {
      group.position.set(x, y, 0);
      const m = mesh(geometry, material);
      m.position.y = -length / 2;
      group.add(m);
      this.model.add(group);
    };
    limb(this.armL, geo.arm, shirt, 0.35, shoulderY, 0.46);
    limb(this.armR, geo.arm, shirt, -0.35, shoulderY, 0.46);
    limb(this.legL, geo.leg, pants, 0.13, hipY, LEG_HEIGHT);
    limb(this.legR, geo.leg, pants, -0.13, hipY, LEG_HEIGHT);

    this.root.add(this.model);
  }

  setVisible(visible: boolean): void {
    this.model.visible = visible;
  }

  animate(dt: number, pose: AvatarPose): void {
    const moving = pose.speed > 0.3;
    this.walkPhase += dt * pose.speed * 2.1;
    if (this.spinner) this.spinner.rotation.y += dt * (moving || !pose.grounded ? 20 : 3);

    let armL = 0;
    let armR = 0;
    let legL = 0;
    let legR = 0;
    let armSpreadL = 0;
    let armSpreadR = 0;
    let bob = 0;
    let lean = 0;
    let turn = 0;

    if (!pose.grounded) {
      armL = -2.6;
      armR = -2.6;
      legL = 0.5;
      legR = -0.4;
    } else if (pose.emote === 1) {
      armR = -2.9 + Math.sin(pose.time * 12) * 0.3;
      armSpreadR = -0.3;
    } else if (pose.emote === 2) {
      turn = pose.time * 5;
      bob = Math.abs(Math.sin(pose.time * 8)) * 0.1;
      armL = -1.6 + Math.sin(pose.time * 8) * 0.8;
      armR = -1.6 - Math.sin(pose.time * 8) * 0.8;
    } else if (pose.emote === 3) {
      bob = Math.abs(Math.sin(pose.time * 9)) * 0.28;
      armL = -2.9;
      armR = -2.9;
      armSpreadL = 0.35;
      armSpreadR = -0.35;
    } else if (moving) {
      const swing = Math.sin(this.walkPhase) * 0.85;
      armL = swing;
      armR = -swing;
      legL = -swing;
      legR = swing;
      bob = Math.abs(Math.cos(this.walkPhase)) * 0.05;
      lean = 0.08;
    } else {
      bob = Math.sin(pose.time * 2) * 0.008;
      armSpreadL = 0.02;
      armSpreadR = -0.02;
    }

    if (pose.swing) armR = -1.9 + Math.sin(pose.time * 20) * 0.7;

    const blend = 1 - Math.exp(-dt * 18);
    this.armL.rotation.x += (armL - this.armL.rotation.x) * blend;
    this.armR.rotation.x += (armR - this.armR.rotation.x) * blend;
    this.armL.rotation.z += (armSpreadL - this.armL.rotation.z) * blend;
    this.armR.rotation.z += (armSpreadR - this.armR.rotation.z) * blend;
    this.legL.rotation.x += (legL - this.legL.rotation.x) * blend;
    this.legR.rotation.x += (legR - this.legR.rotation.x) * blend;
    this.model.position.y += (bob - this.model.position.y) * blend;
    this.model.rotation.x += (lean - this.model.rotation.x) * blend;
    this.model.rotation.y = pose.emote === 2 ? turn : 0;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    for (const g of this.hatGeometries) g.dispose();
    this.root.removeFromParent();
  }
}
