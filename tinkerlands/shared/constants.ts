// Values both the client's prediction and the server's simulation depend on.
// Changing any of them requires bumping PROTOCOL_VERSION.

export const PROTOCOL_VERSION = 3;

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
/** Snapshots go out every N simulation ticks (15 Hz). */
export const SNAPSHOT_INTERVAL_TICKS = 2;

export const WORLD_W = 96;
export const WORLD_H = 48;
export const WORLD_D = 96;
export const CHUNK_SIZE = 16;

export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.7;
export const PLAYER_EYE = 1.45;

export const WALK_SPEED = 7;
export const JUMP_VELOCITY = 9.5;
export const GRAVITY = 26;
export const TERMINAL_VELOCITY = 40;
export const BOUNCE_VELOCITY = 17;
export const GROUND_ACCEL = 70;
export const ICE_ACCEL = 7;
export const AIR_ACCEL = 24;
export const COYOTE_TICKS = 3;
/** Falling below this height counts as a death. */
export const KILL_Y = -12;

/** Maximum distance from the player's eye to an edited block. */
export const BUILD_REACH = 12;

export const TNT_FUSE_TICKS = TICK_RATE * 3;
/** Fuse range, in ticks, for TNT set off by another explosion. */
export const TNT_CHAIN_FUSE_MIN_TICKS = 5;
export const TNT_CHAIN_FUSE_MAX_TICKS = 15;
export const TNT_RADIUS = 4;
/** Players this close to a blast are sent back to their checkpoint. */
export const TNT_KILL_RADIUS = 2.5;
/** Players this close to a blast get thrown. */
export const TNT_PUSH_RADIUS = 7;
export const TNT_PUSH_SPEED = 18;

export const MAX_PLAYERS_PER_ROOM = 30;
export const MAX_CHAT_LENGTH = 200;

export const DAILY_COIN_CAP = 300;
export const COIN_VALUE = 1;
export const FINISH_REWARD = 50;
export const STARTING_COINS = 50;

/** WebSocket close codes after which the client should not auto-reconnect. */
export const CLOSE = {
  KICKED: 4001,
  SUPERSEDED: 4002,
  BANNED: 4003,
  NOT_FOUND: 4004,
  FULL: 4005,
  PROTOCOL: 4006,
  AUTH: 4007,
  ABUSE: 4008,
  CLOSED: 4009,
} as const;
