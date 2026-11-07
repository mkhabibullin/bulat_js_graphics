import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, hashToken, newId, safeEqual, verifyPassword } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';
import { sanitizeText, TextFilter } from '../server/moderation.ts';
import { KeyedRateLimiter, TokenBucket } from '../server/ratelimit.ts';
import { Store } from '../server/store.ts';
import { packWorld, renderThumbnail, unpackWorld } from '../server/worlddata.ts';
import { DEFAULT_AVATAR } from '../shared/avatar.ts';
import { DAILY_COIN_CAP, STARTING_COINS } from '../shared/constants.ts';
import { generateWorld } from '../shared/templates.ts';

describe('passwords', () => {
  it('verifies the right password only', async () => {
    const hash = await hashPassword('correct horse');
    assert.ok(hash.startsWith('scrypt$'));
    assert.ok(await verifyPassword('correct horse', hash));
    assert.ok(!(await verifyPassword('wrong horse', hash)));
    assert.ok(!(await verifyPassword('x', 'garbage')));
  });

  it('salts each hash', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'));
  });

  it('never stores tokens in the clear', () => {
    assert.notEqual(hashToken('abc'), 'abc');
    assert.equal(hashToken('abc'), hashToken('abc'));
    assert.ok(safeEqual('a', 'a'));
    assert.ok(!safeEqual('a', 'b'));
    assert.match(newId(), /^[a-z2-9]{12}$/);
  });
});

describe('text filter', () => {
  const filter = new TextFilter(['blorp']);

  it('masks blocked words, including disguised ones', () => {
    assert.equal(filter.clean('oh shit'), 'oh ****');
    assert.equal(filter.clean('sh1t'), '****');
    assert.equal(filter.clean('F.U.C.K you'), '*.*.*.* you');
    assert.equal(filter.clean('f u c k'), '* * * *');
    assert.equal(filter.clean('BLORP!'), '*****!');
    assert.equal(filter.clean('kys!'), '***!');
    assert.ok(filter.clean('motherfucker').includes('****'));
  });

  it('leaves innocent text alone', () => {
    for (const text of ['this hit was great', 'class assessment', 'grapes and sexton', 'the bit chair', 'spicy food', 'scunthorpe is fine', 'hello there!', 'Привет, мир', '你好']) {
      assert.equal(filter.clean(text), text);
    }
  });

  it('removes control and direction-override characters', () => {
    assert.equal(sanitizeText('  a‮b\u0000c\n d  '), 'a b c d');
  });
});

describe('rate limits', () => {
  it('token bucket refills over time', () => {
    const bucket = new TokenBucket(10, 2, 0);
    assert.ok(bucket.take(0));
    assert.ok(bucket.take(0));
    assert.ok(!bucket.take(0));
    assert.ok(bucket.take(150));
  });

  it('keyed limiter isolates keys and forgets idle ones', () => {
    const limiter = new KeyedRateLimiter(2, 60_000);
    const t = Date.now();
    assert.ok(limiter.allow('a', t));
    assert.ok(limiter.allow('a', t));
    assert.ok(!limiter.allow('a', t));
    assert.ok(limiter.allow('b', t));
    limiter.allow('c', t + 3_600_000);
    assert.equal(limiter.size, 1);
  });
});

describe('config', () => {
  it('rejects unsafe or malformed values at startup', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
    assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
    assert.throws(() => loadConfig({ ADMIN_TOKEN: 'short' }), /ADMIN_TOKEN/);
    assert.throws(() => loadConfig({ LOG_LEVEL: 'loud' }), /LOG_LEVEL/);
    assert.equal(loadConfig({}).port, 8080);
    assert.equal(loadConfig({ NODE_ENV: 'production' }).host, '0.0.0.0');
    assert.equal(loadConfig({}).host, '127.0.0.1');
  });
});

describe('store', () => {
  const makeUser = (store: Store, name = 'alice') => store.createUser(name, false, 'x', { ...DEFAULT_AVATAR }, Date.now());

  it('enforces case-insensitive unique usernames', () => {
    const store = new Store(':memory:');
    makeUser(store, 'Alice');
    assert.throws(() => makeUser(store, 'alice'), /taken/);
    store.close();
  });

  it('caps coin earnings per day and resets the next day', () => {
    const store = new Store(':memory:');
    const user = makeUser(store);
    const day1 = Date.UTC(2026, 0, 1, 12);
    const first = store.awardCoins(user.id, DAILY_COIN_CAP - 10, day1);
    assert.equal(first.granted, DAILY_COIN_CAP - 10);
    assert.equal(store.awardCoins(user.id, 50, day1).granted, 10);
    assert.equal(store.awardCoins(user.id, 50, day1).granted, 0);
    assert.equal(store.getUser(user.id)!.coins, STARTING_COINS + DAILY_COIN_CAP);
    assert.equal(store.awardCoins(user.id, 50, day1 + 86_400_000).granted, 50);
    store.close();
  });

  it('never lets a purchase overdraw or double-buy', () => {
    const store = new Store(':memory:');
    const user = makeUser(store);
    assert.deepEqual(store.buyHat(user.id, 'crown'), { ok: false, code: 'not_enough_coins' });
    assert.deepEqual(store.buyHat(user.id, 'nonsense'), { ok: false, code: 'unknown_item' });
    assert.deepEqual(store.buyHat(user.id, 'none'), { ok: false, code: 'unknown_item' });
    const ok = store.buyHat(user.id, 'cap');
    assert.ok(ok.ok);
    assert.deepEqual(store.buyHat(user.id, 'cap'), { ok: false, code: 'already_owned' });
    assert.equal(store.getUser(user.id)!.coins, STARTING_COINS - 25);
    store.close();
  });

  it('keeps the best time and rewards only once a day', () => {
    const store = new Store(':memory:');
    const user = makeUser(store);
    const { world } = generateWorld('plot', 1);
    const id = store.createWorld({
      ownerId: null, name: 'w', description: '', template: 'plot', seed: 1, isPublic: true, buildMode: 'owner',
      width: world.w, height: world.h, depth: world.d, blocks: packWorld(world), thumb: new Uint8Array(), now: 1,
    });
    const day = Date.UTC(2026, 0, 1);
    assert.deepEqual(store.recordCompletion(id, user.id, 5000, day), { best: 5000, isBest: true, reward: true });
    assert.deepEqual(store.recordCompletion(id, user.id, 6000, day), { best: 5000, isBest: false, reward: false });
    assert.deepEqual(store.recordCompletion(id, user.id, 4000, day), { best: 4000, isBest: true, reward: false });
    assert.equal(store.recordCompletion(id, user.id, 7000, day + 86_400_000).reward, true);
    assert.equal(store.leaderboard(id, 10)[0].best_ms, 4000);
    store.close();
  });

  it('search treats wildcards literally and resists SQL injection', () => {
    const store = new Store(':memory:');
    const { world } = generateWorld('plot', 1);
    const packed = packWorld(world);
    for (const name of ['100% fun', 'Plain']) {
      store.createWorld({
        ownerId: null, name, description: '', template: 'plot', seed: 1, isPublic: true, buildMode: 'owner',
        width: world.w, height: world.h, depth: world.d, blocks: packed, thumb: new Uint8Array(), now: 1,
      });
    }
    assert.equal(store.listPublicWorlds('new', '%', 10, 0).length, 1);
    assert.equal(store.listPublicWorlds('new', "'; DROP TABLE worlds; --", 10, 0).length, 0);
    assert.equal(store.countWorlds(), 2);
    store.close();
  });

  it('cleans up expired sessions and abandoned guests, but keeps creators', () => {
    const store = new Store(':memory:');
    const now = Date.now();
    const old = now - 90 * 86_400_000;
    const abandoned = store.createUser('Guest_a', true, null, { ...DEFAULT_AVATAR }, old);
    const creator = store.createUser('Guest_b', true, null, { ...DEFAULT_AVATAR }, old);
    const { world } = generateWorld('plot', 1);
    store.createWorld({
      ownerId: creator.id, name: 'w', description: '', template: 'plot', seed: 1, isPublic: true, buildMode: 'owner',
      width: world.w, height: world.h, depth: world.d, blocks: packWorld(world), thumb: new Uint8Array(), now,
    });
    store.createSession('expired', creator.id, now - 1);
    const result = store.cleanup(now, 30 * 86_400_000);
    assert.equal(result.sessions, 1);
    assert.equal(result.guests, 1);
    assert.equal(store.getUser(abandoned.id), undefined);
    assert.ok(store.getUser(creator.id));
    store.close();
  });
});

describe('world storage', () => {
  it('packs and restores every template', () => {
    for (const template of ['plot', 'island', 'obby', 'tower'] as const) {
      const { world } = generateWorld(template, 5);
      const packed = packWorld(world);
      assert.ok(packed.length < 120_000, `${template} packed to ${packed.length}`);
      assert.deepEqual(unpackWorld(packed, world.w, world.h, world.d).data, world.data);
    }
  });

  it('refuses corrupt saves', () => {
    assert.throws(() => unpackWorld(new Uint8Array([1, 2, 3]), 8, 8, 8));
  });

  it('renders a valid PNG thumbnail', () => {
    const { world } = generateWorld('island', 5);
    const png = renderThumbnail(world);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(png.length > 1000 && png.length < 300_000, `size ${png.length}`);
  });
});
