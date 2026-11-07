import { WORLD_D, WORLD_H, WORLD_W } from '../shared/constants.ts';
import { generateWorld, type TemplateId } from '../shared/templates.ts';
import type { Store } from './store.ts';
import { packWorld, renderThumbnail } from './worlddata.ts';

interface StarterWorld {
  id: string;
  name: string;
  description: string;
  template: TemplateId;
  seed: number;
  buildMode: 'owner' | 'everyone';
}

const STARTERS: StarterWorld[] = [
  {
    id: 'skyline-sprint',
    name: 'Skyline Sprint',
    description: 'The classic run: hop, dodge lava and race the clock to the golden pad.',
    template: 'obby',
    seed: 11,
    buildMode: 'owner',
  },
  {
    id: 'open-plots',
    name: 'Open Plots',
    description: 'A big shared field. Everyone can build here, so go make something together.',
    template: 'plot',
    seed: 4,
    buildMode: 'everyone',
  },
  {
    id: 'sunny-isle',
    name: 'Sunny Isle',
    description: 'A floating island to explore. Coins are hidden around the hills and ruins.',
    template: 'island',
    seed: 7,
    buildMode: 'owner',
  },
  {
    id: 'cinder-spiral',
    name: 'Cinder Spiral',
    description: 'Wind your way inward above a sea of lava. Don’t look down.',
    template: 'tower',
    seed: 23,
    buildMode: 'owner',
  },
  {
    id: 'bounce-basin',
    name: 'Bounce Basin',
    description: 'A second long course with a different layout. Can you beat your friends’ times?',
    template: 'obby',
    seed: 42,
    buildMode: 'owner',
  },
];

/** Creates the starter worlds on first run. Existing worlds are never touched. */
export function seedStarterWorlds(store: Store, now: number): number {
  let created = 0;
  for (const s of STARTERS) {
    if (store.getWorld(s.id)) continue;
    const { world } = generateWorld(s.template, s.seed);
    store.createWorld({
      id: s.id,
      ownerId: null,
      name: s.name,
      description: s.description,
      template: s.template,
      seed: s.seed,
      isPublic: true,
      buildMode: s.buildMode,
      width: WORLD_W,
      height: WORLD_H,
      depth: WORLD_D,
      blocks: packWorld(world),
      thumb: renderThumbnail(world),
      featured: true,
      now,
    });
    created++;
  }
  return created;
}
