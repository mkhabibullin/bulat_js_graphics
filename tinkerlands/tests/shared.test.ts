import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { B } from '../shared/blocks.ts';
import { validateAvatar, DEFAULT_AVATAR, randomAvatar } from '../shared/avatar.ts';
import { JUMP_VELOCITY, GRAVITY, DT, TICK_RATE, WALK_SPEED } from '../shared/constants.ts';
import { createPlayerState, findContacts, stepPlayer, type MoveInput, type PlayerState } from '../shared/physics.ts';
import { parseClientMessage } from '../shared/protocol.ts';
import { generateWorld, TEMPLATES, type Waypoint } from '../shared/templates.ts';
import { decodeRLE, encodeRLE, VoxelWorld } from '../shared/world.ts';

function flatWorld(): VoxelWorld {
  const world = new VoxelWorld(32, 32, 32);
  world.fill(0, 0, 0, 31, 4, 31, B.STONE);
  return world;
}

const idle: MoveInput = { fwd: 0, strafe: 0, yaw: 0, jump: false };

function settle(s: PlayerState, world: VoxelWorld): void {
  for (let i = 0; i < 60; i++) stepPlayer(s, idle, world);
}

describe('world encoding', () => {
  it('round-trips random and uniform data', () => {
    const data = new Uint8Array(70_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 977 < 900 ? 3 : (i * 31) % 28;
    assert.deepEqual(decodeRLE(encodeRLE(data), data.length), data);
    const uniform = new Uint8Array(442_368);
    assert.deepEqual(decodeRLE(encodeRLE(uniform), uniform.length), uniform);
    assert.ok(encodeRLE(uniform).length < 10);
  });

  it('rejects malformed data instead of returning a partial world', () => {
    const good = encodeRLE(new Uint8Array(100));
    assert.throws(() => decodeRLE(good, 50), /overflow/);
    assert.throws(() => decodeRLE(good, 200), /short/);
    assert.throws(() => decodeRLE(new Uint8Array([0x80]), 10), /truncated/);
    assert.throws(() => decodeRLE(new Uint8Array([5]), 5), /truncated/);
    assert.throws(() => decodeRLE(new Uint8Array([0, 1]), 5), /overflow/);
    assert.throws(() => decodeRLE(new Uint8Array(12).fill(0xff), 5), /invalid|truncated/);
  });
});

describe('physics', () => {
  it('lands on the ground and stays there', () => {
    const world = flatWorld();
    const s = createPlayerState(16, 12, 16);
    settle(s, world);
    assert.ok(s.grounded);
    assert.ok(Math.abs(s.y - 5) < 0.01, `y=${s.y}`);
  });

  it('jumps to the expected height and clears a one-block step', () => {
    const world = flatWorld();
    const s = createPlayerState(16, 5.01, 16);
    settle(s, world);
    const start = s.y;
    let peak = start;
    stepPlayer(s, { ...idle, jump: true }, world);
    for (let i = 0; i < TICK_RATE; i++) {
      stepPlayer(s, idle, world);
      peak = Math.max(peak, s.y);
    }
    const expected = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
    assert.ok(Math.abs(peak - start - expected) < 0.3, `height ${peak - start}, expected ${expected}`);
    assert.ok(peak - start > 1.1);
  });

  it('walks at the configured speed, also diagonally', () => {
    const world = flatWorld();
    const s = createPlayerState(5, 5.01, 16);
    settle(s, world);
    for (let i = 0; i < 15; i++) stepPlayer(s, { fwd: 1, strafe: 1, yaw: 0, jump: false }, world);
    const speed = Math.hypot(s.vx, s.vz);
    assert.ok(Math.abs(speed - WALK_SPEED) < 0.01, `speed ${speed}`);
  });

  it('is stopped by walls', () => {
    const world = flatWorld();
    world.fill(20, 5, 0, 20, 8, 31, B.BRICK);
    const s = createPlayerState(15, 5.01, 16);
    settle(s, world);
    const right: MoveInput = { fwd: 0, strafe: 1, yaw: 0, jump: false };
    for (let i = 0; i < 60; i++) stepPlayer(s, right, world);
    assert.ok(s.x <= 20 - 0.3 + 1e-3 && s.x > 19, `x=${s.x}`);
  });

  it('does not tunnel through a thin floor at terminal velocity', () => {
    const world = new VoxelWorld(16, 200, 16);
    world.fill(0, 2, 0, 15, 2, 15, B.STONE);
    const s = createPlayerState(8, 190, 8);
    for (let i = 0; i < 300; i++) stepPlayer(s, idle, world);
    assert.ok(s.grounded);
    assert.ok(Math.abs(s.y - 3) < 0.01, `y=${s.y}`);
  });

  it('cannot leave the world sideways', () => {
    const world = flatWorld();
    const s = createPlayerState(1, 5.01, 16);
    const left: MoveInput = { fwd: 0, strafe: -1, yaw: 0, jump: false };
    for (let i = 0; i < 100; i++) stepPlayer(s, left, world);
    assert.ok(s.x >= 0.3 - 1e-6);
  });

  it('lifts a player out when a block appears on top of them', () => {
    const world = flatWorld();
    const s = createPlayerState(16, 5.01, 16);
    settle(s, world);
    world.fill(16, 5, 16, 16, 6, 16, B.BRICK);
    stepPlayer(s, idle, world);
    assert.ok(s.y >= 7, `y=${s.y}`);
  });

  it('launches off bounce pads and slides on ice', () => {
    const world = flatWorld();
    world.fill(10, 4, 10, 12, 4, 12, B.BOUNCE);
    const bouncer = createPlayerState(11.5, 8, 11.5);
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      stepPlayer(bouncer, idle, world);
      if (i > 20) peak = Math.max(peak, bouncer.y);
    }
    assert.ok(peak > 9, `peak ${peak}`);

    const iceWorld = flatWorld();
    iceWorld.fill(0, 4, 0, 31, 4, 31, B.ICE);
    const skater = createPlayerState(5, 5.01, 16);
    settle(skater, iceWorld);
    for (let i = 0; i < 40; i++) stepPlayer(skater, { fwd: 0, strafe: 1, yaw: 0, jump: false }, iceWorld);
    const before = skater.x;
    stepPlayer(skater, idle, iceWorld);
    assert.ok(skater.x - before > 0.1, 'should keep sliding when input stops');
  });

  it('reports hazards, coins, checkpoints and goals', () => {
    const world = flatWorld();
    world.set(16, 4, 16, B.LAVA);
    world.set(20, 4, 20, B.CHECKPOINT);
    world.set(24, 4, 24, B.GOAL);
    world.set(8, 5, 8, B.COIN);

    const onLava = createPlayerState(16.5, 5.01, 16.5);
    settle(onLava, world);
    assert.ok(findContacts(onLava, world).hazard);

    const onCheck = createPlayerState(20.5, 5.01, 20.5);
    settle(onCheck, world);
    assert.deepEqual(findContacts(onCheck, world).checkpoint, { x: 20, y: 4, z: 20 });

    const onGoal = createPlayerState(24.5, 5.01, 24.5);
    settle(onGoal, world);
    assert.ok(findContacts(onGoal, world).goal);

    const onCoin = createPlayerState(8.5, 5.01, 8.5);
    settle(onCoin, world);
    assert.deepEqual(findContacts(onCoin, world).coins, [{ x: 8, y: 5, z: 8 }]);

    const clear = createPlayerState(2.5, 5.01, 2.5);
    settle(clear, world);
    const none = findContacts(clear, world);
    assert.ok(!none.hazard && !none.goal && !none.checkpoint && none.coins.length === 0);
  });

  it('is deterministic for the same inputs', () => {
    const world = flatWorld();
    world.fill(10, 5, 10, 14, 5, 14, B.BRICK);
    const run = (): PlayerState => {
      const s = createPlayerState(3, 8, 3);
      for (let i = 0; i < 400; i++) {
        stepPlayer(s, { fwd: Math.sin(i / 9), strafe: Math.cos(i / 13), yaw: i * 0.01, jump: i % 37 === 0 }, world);
      }
      return s;
    };
    assert.deepEqual(run(), run());
  });
});

describe('client message validation', () => {
  it('accepts valid messages', () => {
    assert.ok(parseClientMessage('{"t":"i","s":1,"f":1,"r":-0.5,"y":3.2,"j":1}'));
    assert.ok(parseClientMessage('{"t":"b","x":1,"y":2,"z":3,"k":4}'));
    assert.ok(parseClientMessage('{"t":"m","x":1,"y":2,"z":3}'));
    assert.ok(parseClientMessage('{"t":"mx"}'));
    assert.ok(parseClientMessage('{"t":"l","x":1,"y":2,"z":3}'));
    assert.ok(parseClientMessage('{"t":"c","m":"hi"}'));
    assert.ok(parseClientMessage('{"t":"join","token":"abc","worldId":"skyline-sprint","v":1}'));
  });

  it('rejects anything malformed', () => {
    const bad = [
      'not json', '[]', 'null', '5', '{}', '{"t":"nope"}',
      '{"t":"i","s":-1,"f":0,"r":0,"y":0,"j":0}',
      '{"t":"i","s":1.5,"f":0,"r":0,"y":0,"j":0}',
      '{"t":"i","s":1,"f":2,"r":0,"y":0,"j":0}',
      '{"t":"i","s":1,"f":0,"r":-9,"y":0,"j":0}',
      '{"t":"i","s":1,"f":0,"r":0,"y":1e308,"j":0}',
      '{"t":"i","s":1,"f":"1","r":0,"y":0,"j":0}',
      '{"t":"i","s":1,"f":0,"r":0,"y":0,"j":2}',
      '{"t":"b","x":-1,"y":0,"z":0,"k":1}',
      '{"t":"b","x":0,"y":999,"z":0,"k":1}',
      '{"t":"b","x":0,"y":0,"z":0,"k":250}',
      '{"t":"b","x":0.5,"y":0,"z":0,"k":1}',
      '{"t":"l","x":-1,"y":0,"z":0}',
      '{"t":"l","x":0,"y":0}',
      '{"t":"m","x":-1,"y":0,"z":0}',
      '{"t":"m","x":0,"y":999,"z":0}',
      '{"t":"m","x":0.5,"y":0,"z":0}',
      '{"t":"c","m":""}',
      `{"t":"c","m":"${'x'.repeat(201)}"}`,
      '{"t":"c","m":5}',
      '{"t":"join","token":"a","worldId":"../etc","v":1}',
      `{"t":"join","token":"${'a'.repeat(200)}","worldId":"x","v":1}`,
      '{"t":"e","e":99}',
      '{"t":"kick","id":"a"}',
    ];
    for (const raw of bad) assert.equal(parseClientMessage(raw), null, raw);
  });

  it('ignores prototype pollution attempts', () => {
    const msg = parseClientMessage('{"t":"c","m":"hi","__proto__":{"polluted":true}}');
    assert.deepEqual(msg, { t: 'c', m: 'hi' });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe('avatars', () => {
  it('accepts valid looks and owned hats only', () => {
    assert.ok(validateAvatar(DEFAULT_AVATAR, []));
    assert.equal(validateAvatar({ ...DEFAULT_AVATAR, hat: 'crown' }, []), null);
    assert.ok(validateAvatar({ ...DEFAULT_AVATAR, hat: 'crown' }, ['crown']));
    assert.equal(validateAvatar({ ...DEFAULT_AVATAR, skin: 'red; background:url(x)' }, []), null);
    assert.equal(validateAvatar({ ...DEFAULT_AVATAR, face: 'nope' }, []), null);
    assert.equal(validateAvatar(null, []), null);
    assert.ok(validateAvatar(randomAvatar(), []));
  });
});

/** Steers along a course's route under the real physics, jumping where marked. */
function autopilot(world: VoxelWorld, route: Waypoint[], maxTicks: number): { finished: boolean; ticks: number; stuckAt: number; died: boolean } {
  const start = route[0];
  const s = createPlayerState(start.x, start.y + 0.01, start.z);
  let index = 1;
  let deaths = 0;
  let ticks = 0;
  let leapedFor = 0;
  for (; ticks < maxTicks && index < route.length; ticks++) {
    const target = route[index];
    const dx = target.x - s.x;
    const dz = target.z - s.z;
    const dist = Math.hypot(dx, dz);
    // A leap is done on landing anywhere near its target, like a person would.
    const atHeight = s.grounded && Math.abs(s.y - target.y) < 0.2;
    const passed = target.pass === true && dist < 0.8 && Math.abs(s.y - target.y) < 2;
    if ((atHeight && dist < (target.leap ? 2.6 : 0.45)) || passed) {
      index++;
      continue;
    }
    // Move straight at the target: forward at yaw pointing to it.
    const yaw = Math.atan2(-dx, -dz);
    const climb = target.y > s.y + 0.5 && !route[index - 1].pass;
    const leap = target.leap === true && leapedFor !== index;
    const jump = s.grounded && (leap || climb);
    if (jump) leapedFor = index;
    stepPlayer(s, { fwd: dist > 0.05 ? 1 : 0, strafe: 0, yaw, jump }, world);
    const contacts = findContacts(s, world);
    if (contacts.hazard || s.y < 0) {
      deaths++;
      break;
    }
  }
  return { finished: index >= route.length, ticks, stuckAt: index, died: deaths > 0 };
}

describe('world templates', () => {
  for (const template of TEMPLATES) {
    it(`${template}: has a safe spawn and stays in bounds`, () => {
      for (const seed of [1, 2, 3, 11, 23, 42, 99]) {
        const { world } = generateWorld(template, seed);
        let spawns = 0;
        for (let i = 0; i < world.data.length; i++) {
          if (world.data[i] === B.SPAWN) {
            spawns++;
            const y = Math.floor(i / (world.w * world.d));
            const rest = i - y * world.w * world.d;
            const z = Math.floor(rest / world.w);
            const x = rest - z * world.w;
            assert.ok(!world.isSolid(x, y + 1, z), `spawn blocked at ${x},${y},${z}, seed ${seed}`);
            assert.ok(!world.isSolid(x, y + 2, z), `spawn blocked at ${x},${y},${z}, seed ${seed}`);
          }
        }
        assert.ok(spawns > 0, `no spawn, seed ${seed}`);
      }
    });

    it(`${template}: is deterministic per seed`, () => {
      assert.deepEqual(generateWorld(template, 77).world.data, generateWorld(template, 77).world.data);
    });
  }

  for (const template of ['obby', 'tower'] as const) {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 11, 23, 42, 99, 1234, 98765]) {
      it(`${template} seed ${seed}: can be completed under real physics`, () => {
        const { world, route } = generateWorld(template, seed);
        assert.ok(route.length > 30, `route too short: ${route.length}`);
        let goals = 0;
        for (const b of world.data) if (b === B.GOAL) goals++;
        assert.ok(goals > 0, 'no goal');
        const last = route[route.length - 1];
        assert.equal(world.get(Math.floor(last.x), Math.floor(last.y) - 1, Math.floor(last.z)), B.GOAL);
        const result = autopilot(world, route, 20_000);
        assert.ok(result.finished, `stopped at waypoint ${result.stuckAt}/${route.length} (${JSON.stringify(route[result.stuckAt])}), died=${result.died}`);
      });
    }
  }

  for (const seed of [1, 2, 3, 7, 11, 23, 42, 99, 1234, 98765]) {
    it(`island seed ${seed}: all land and coins can be reached on foot`, () => {
      const { world } = generateWorld('island', seed);
      const { w, h, d } = world;
      const key = (x: number, y: number, z: number): number => world.index(x, y, z);
      const canStand = (x: number, y: number, z: number): boolean =>
        y >= 1 && y + 1 < h && world.isSolid(x, y - 1, z) && !world.isSolid(x, y, z) && !world.isSolid(x, y + 1, z);

      // Walk outward from the spawn: step up one block at most, drop any distance.
      const start: [number, number, number][] = [];
      for (let i = 0; i < world.data.length; i++) {
        if (world.data[i] === B.SPAWN) {
          const y = Math.floor(i / (w * d));
          const rest = i - y * w * d;
          const z = Math.floor(rest / w);
          start.push([rest - z * w, y + 1, z]);
        }
      }
      const seen = new Set<number>(start.map(([x, y, z]) => key(x, y, z)));
      const queue = [...start];
      while (queue.length > 0) {
        const [x, y, z] = queue.pop()!;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= d) continue;
          for (let ny = y + 1; ny >= Math.max(1, y - 30); ny--) {
            // Stepping up needs headroom above the player's current spot.
            if (ny > y && world.isSolid(x, y + 2, z)) continue;
            if (!canStand(nx, ny, nz)) continue;
            const k = key(nx, ny, nz);
            if (!seen.has(k)) {
              seen.add(k);
              queue.push([nx, ny, nz]);
            }
            break;
          }
        }
      }

      let coins = 0;
      let reachable = 0;
      for (let i = 0; i < world.data.length; i++) {
        if (world.data[i] !== B.COIN) continue;
        coins++;
        const y = Math.floor(i / (w * d));
        const rest = i - y * w * d;
        const z = Math.floor(rest / w);
        const x = rest - z * w;
        // A standing player overlaps the two cells above their feet, and can
        // jump to one more, so a coin up to three above a reachable spot counts.
        let ok = false;
        for (let up = 0; up <= 3 && !ok; up++) ok = seen.has(key(x, y - up, z));
        if (ok) reachable++;
      }
      assert.ok(coins > 15, `only ${coins} coins`);
      assert.ok(reachable === coins, `only ${reachable}/${coins} coins are reachable`);

      // Almost all of the open ground is walkable.
      let land = 0;
      let walked = 0;
      for (let z = 0; z < d; z++) {
        for (let x = 0; x < w; x++) {
          const top = world.topSolid(x, z);
          if (top < 0 || world.get(x, top, z) === B.LEAVES || world.get(x, top, z) === B.LOG) continue;
          land++;
          if (seen.has(key(x, top + 1, z))) walked++;
        }
      }
      assert.ok(walked / land > 0.95, `only ${walked}/${land} of the land is walkable`);
    });
  }

  it('courses take a meaningful time to run', () => {
    const { world, route } = generateWorld('obby', 11);
    const result = autopilot(world, route, 20_000);
    const seconds = result.ticks * DT;
    assert.ok(seconds > 30, `only ${seconds}s`);
  });
});
