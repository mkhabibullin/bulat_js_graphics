import * as THREE from 'three';
import { CLOTH_COLORS, FACES, HATS, SKIN_COLORS, type Avatar } from '../shared/avatar.ts';
import { TEMPLATE_INFO, TEMPLATES } from '../shared/templates.ts';
import { api, ApiError, getToken, setToken, type User, type WorldSummary } from './api.ts';
import { clear, formatCount, formatTime, h, toast } from './dom.ts';
import { AvatarMesh } from './game/avatarMesh.ts';
import { Game } from './game/game.ts';

const app = document.getElementById('app')!;
let user: User | null = null;
let cleanup: (() => void) | null = null;
let coinBadge: HTMLElement | null = null;

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

function setUser(next: User | null): void {
  user = next;
  if (coinBadge && next) coinBadge.textContent = String(next.coins);
}

function logo(): HTMLElement {
  return h('a', { class: 'logo', href: '#/', 'aria-label': 'Tinkerlands home' }, h('span', { class: 'logo-cube' }), 'Tinkerlands');
}

// --- Landing ---

function renderLanding(): void {
  clear(app);
  const username = h('input', { name: 'username', autocomplete: 'username', placeholder: 'Username', required: true, 'aria-label': 'Username' });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', placeholder: 'Password', required: true, 'aria-label': 'Password' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  const finish = async (action: () => Promise<{ token: string; user: User }>): Promise<void> => {
    error.textContent = '';
    try {
      const result = await action();
      setToken(result.token);
      setUser(result.user);
      route();
    } catch (err) {
      error.textContent = errorMessage(err);
    }
  };

  const form = h(
    'form',
    {
      class: 'auth-form',
      onsubmit: (e: Event) => {
        e.preventDefault();
        void finish(() => api.login(username.value, password.value));
      },
    },
    username,
    password,
    error,
    h(
      'div',
      { class: 'auth-buttons' },
      h('button', { class: 'btn', type: 'submit' }, 'Sign in'),
      h('button', { class: 'btn', type: 'button', onclick: () => void finish(() => api.register(username.value, password.value)) }, 'Create account'),
    ),
  );

  app.append(
    h(
      'main',
      { class: 'landing' },
      h(
        'section',
        { class: 'landing-copy' },
        logo(),
        h('h1', {}, 'Build a world. Share it. Play it with friends.'),
        h('p', { class: 'lead' }, 'Race obstacle courses, explore islands, or start from an empty plot and make your own game. It runs right in your browser.'),
        h('button', { class: 'btn btn-primary btn-big', onclick: () => void finish(api.guest) }, 'Play now, no sign-up'),
        h('details', { class: 'auth-details' }, h('summary', {}, 'Have an account, or want one?'), form),
        h('p', { class: 'fine' }, 'By playing you agree to the ', h('a', { href: '#/rules' }, 'community rules'), '.'),
      ),
      h(
        'section',
        { class: 'landing-art', 'aria-hidden': 'true' },
        h('img', { src: '/api/worlds/skyline-sprint/thumb.png', alt: '', class: 'art-main' }),
        h('img', { src: '/api/worlds/sunny-isle/thumb.png', alt: '', class: 'art-side' }),
      ),
    ),
  );
}

// --- Shell ---

function shell(active: string, content: HTMLElement): void {
  clear(app);
  coinBadge = h('span', { class: 'coin-badge', title: 'Your coins' }, String(user?.coins ?? 0));
  const link = (href: string, label: string, key: string): HTMLElement =>
    h('a', { href, class: `nav-link${active === key ? ' active' : ''}` }, label);
  app.append(
    h(
      'header',
      { class: 'topbar' },
      logo(),
      h('nav', { class: 'nav' }, link('#/', 'Discover', 'discover'), link('#/mine', 'My worlds', 'mine'), link('#/avatar', 'Avatar', 'avatar')),
      h(
        'div',
        { class: 'topbar-right' },
        coinBadge,
        h('span', { class: 'username' }, user?.username ?? ''),
        user?.guest && h('a', { class: 'btn btn-small', href: '#/account' }, 'Save progress'),
        h('button', { class: 'btn btn-small', onclick: () => void signOut() }, 'Sign out'),
      ),
    ),
    h('main', { class: 'page' }, content),
    h('footer', { class: 'footer' }, h('a', { href: '#/rules' }, 'Community rules')),
  );
}

async function signOut(): Promise<void> {
  if (user?.guest && !confirm('You’re signed in as a guest. If you sign out now you’ll lose your coins and worlds. Sign out anyway?')) return;
  await api.logout().catch(() => {});
  setToken(null);
  setUser(null);
  location.hash = '#/';
  route();
}

function worldCard(world: WorldSummary): HTMLElement {
  return h(
    'a',
    { class: 'card', href: `#/world/${world.id}` },
    h('div', { class: 'card-art' },
      h('img', { src: `/api/worlds/${world.id}/thumb.png?v=${world.updatedAt}`, alt: '', loading: 'lazy' }),
      world.online > 0 && h('span', { class: 'online-pill' }, `${world.online} playing`),
      !world.isPublic && h('span', { class: 'private-pill' }, 'Private'),
    ),
    h('div', { class: 'card-body' },
      h('h3', {}, world.name),
      h('p', { class: 'card-by' }, world.ownerName ? `by ${world.ownerName}` : 'Tinkerlands original'),
      h('p', { class: 'card-stats' }, `${formatCount(world.visits)} visits · ${formatCount(world.likes)} likes`),
    ),
  );
}

// --- Discover ---

function renderDiscover(): void {
  const grid = h('div', { class: 'grid', 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Loading worlds…'));
  let sort = 'popular';
  let query = '';
  let request = 0;

  const load = async (): Promise<void> => {
    const mine = ++request;
    try {
      const { worlds } = await api.worlds(sort, query);
      if (mine !== request) return;
      clear(grid);
      if (worlds.length === 0) grid.append(h('p', { class: 'muted' }, 'No worlds match that search.'));
      grid.append(...worlds.map(worldCard));
    } catch (err) {
      if (mine !== request) return;
      clear(grid);
      grid.append(h('p', { class: 'form-error' }, errorMessage(err)));
    }
  };

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const options: [string, string][] = [['popular', 'Popular'], ['new', 'New'], ['liked', 'Most liked']];
  const renderTabs = (): void => {
    clear(tabs);
    for (const [key, label] of options) {
      tabs.append(
        h('button', {
          class: `tab${sort === key ? ' active' : ''}`,
          role: 'tab',
          'aria-selected': String(sort === key),
          onclick: () => {
            sort = key;
            renderTabs();
            void load();
          },
        }, label),
      );
    }
  };
  renderTabs();

  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search worlds or creators', 'aria-label': 'Search' });
  let timer = 0;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      query = search.value.trim();
      void load();
    }, 250);
  });

  shell('discover', h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, 'Pick a world'), h('div', { class: 'page-tools' }, tabs, search)), grid));
  void load();
}

// --- World detail ---

async function renderWorld(id: string): Promise<void> {
  shell('discover', h('p', { class: 'muted' }, 'Loading…'));
  let detail;
  try {
    detail = await api.world(id);
  } catch (err) {
    shell('discover', h('div', { class: 'empty' }, h('h1', {}, 'World not found'), h('p', {}, errorMessage(err)), h('a', { class: 'btn', href: '#/' }, 'Back to Discover')));
    return;
  }
  const { world, leaderboard } = detail;
  let liked = detail.liked;
  const likeButton = h('button', { class: 'btn' }, `${liked ? '♥' : '♡'} ${world.likes}`);
  likeButton.addEventListener('click', () => {
    void api.like(world.id).then(
      (r) => {
        liked = r.liked;
        likeButton.textContent = `${liked ? '♥' : '♡'} ${r.likes}`;
      },
      (err: unknown) => toast(errorMessage(err), 'error'),
    );
  });

  const isOwner = world.ownerId === user?.id;

  const board = leaderboard.length > 0
    ? h('ol', { class: 'board' }, leaderboard.map((row) => h('li', {}, h('span', {}, row.username), h('b', {}, formatTime(row.ms)))))
    : h('p', { class: 'muted' }, world.template === 'obby' || world.template === 'tower' ? 'No finishers yet. Be the first!' : 'This world has no timed run.');

  let ownerPanel: HTMLElement | false = false;
  if (isOwner) {
    const name = h('input', { value: world.name, maxlength: 40, 'aria-label': 'World name' });
    const description = h('textarea', { maxlength: 280, rows: 3, 'aria-label': 'Description' });
    description.value = world.description;
    const isPublic = h('input', { type: 'checkbox' });
    isPublic.checked = world.isPublic;
    const everyone = h('input', { type: 'checkbox' });
    everyone.checked = world.buildMode === 'everyone';
    ownerPanel = h(
      'section',
      { class: 'panel' },
      h('h2', {}, 'World settings'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Description'), description),
      h('label', { class: 'field field-row' }, isPublic, h('span', {}, 'Published (anyone can find and join)')),
      h('label', { class: 'field field-row' }, everyone, h('span', {}, 'Let visitors build')),
      h('div', { class: 'pause-actions' },
        h('button', {
          class: 'btn btn-primary',
          onclick: () => {
            api.updateWorld(world.id, { name: name.value, description: description.value, isPublic: isPublic.checked, buildMode: everyone.checked ? 'everyone' : 'owner' }).then(
              () => toast('Saved.', 'good'),
              (err: unknown) => toast(errorMessage(err), 'error'),
            );
          },
        }, 'Save'),
        h('button', {
          class: 'btn btn-danger',
          onclick: () => {
            if (!confirm(`Delete "${world.name}" for good? This can’t be undone.`)) return;
            api.deleteWorld(world.id).then(
              () => {
                location.hash = '#/mine';
              },
              (err: unknown) => toast(errorMessage(err), 'error'),
            );
          },
        }, 'Delete world'),
      ),
    );
  }

  shell(
    'discover',
    h(
      'div',
      { class: 'world-page' },
      h('div', { class: 'world-hero' }, h('img', { src: `/api/worlds/${world.id}/thumb.png?v=${world.updatedAt}`, alt: `Overview of ${world.name}` })),
      h(
        'div',
        { class: 'world-info' },
        h('h1', {}, world.name),
        h('p', { class: 'card-by' }, world.ownerName ? `by ${world.ownerName}` : 'Tinkerlands original'),
        h('p', {}, world.description),
        h('p', { class: 'card-stats' }, `${world.online} playing now · ${formatCount(world.visits)} visits`),
        h('div', { class: 'world-actions' }, h('a', { class: 'btn btn-primary btn-big', href: `#/play/${world.id}` }, isOwner ? 'Play or edit' : 'Play'), likeButton),
        h('section', {}, h('h2', {}, 'Fastest runs'), board),
      ),
      ownerPanel,
    ),
  );
}

// --- My worlds ---

async function renderMine(): Promise<void> {
  const grid = h('div', { class: 'grid' }, h('p', { class: 'muted' }, 'Loading…'));

  const name = h('input', { required: true, minlength: 3, maxlength: 40, placeholder: 'World name', 'aria-label': 'World name' });
  const everyone = h('input', { type: 'checkbox' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  let template: string = TEMPLATES[0];
  const templateRow = h('div', { class: 'template-row', role: 'radiogroup', 'aria-label': 'Template' });
  const renderTemplates = (): void => {
    clear(templateRow);
    for (const id of TEMPLATES) {
      templateRow.append(
        h('button', {
          type: 'button',
          class: `template${template === id ? ' active' : ''}`,
          role: 'radio',
          'aria-checked': String(template === id),
          onclick: () => {
            template = id;
            renderTemplates();
          },
        }, h('b', {}, TEMPLATE_INFO[id].name), h('span', {}, TEMPLATE_INFO[id].blurb)),
      );
    }
  };
  renderTemplates();

  const form = h(
    'form',
    {
      class: 'panel create-form',
      onsubmit: (e: Event) => {
        e.preventDefault();
        error.textContent = '';
        api.createWorld({ name: name.value, description: '', template, buildMode: everyone.checked ? 'everyone' : 'owner', isPublic: true }).then(
          ({ world }) => {
            location.hash = `#/play/${world.id}`;
          },
          (err: unknown) => {
            error.textContent = errorMessage(err);
          },
        );
      },
    },
    h('h2', {}, 'Create a world'),
    name,
    templateRow,
    h('label', { class: 'field field-row' }, everyone, h('span', {}, 'Let visitors build too')),
    error,
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create and enter'),
  );

  shell('mine', h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, 'My worlds')), form, grid));

  try {
    const { worlds } = await api.myWorlds();
    clear(grid);
    if (worlds.length === 0) grid.append(h('p', { class: 'muted' }, 'You haven’t made anything yet. Your worlds will show up here.'));
    grid.append(...worlds.map(worldCard));
  } catch (err) {
    clear(grid);
    grid.append(h('p', { class: 'form-error' }, errorMessage(err)));
  }
}

// --- Avatar ---

function renderAvatar(): void {
  if (!user) return;
  const avatar: Avatar = { ...user.avatar };

  const stage = h('div', { class: 'avatar-stage' });
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 1.25, 4.6);
  camera.lookAt(0, 0.95, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8f80, 2.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  let model = new AvatarMesh(avatar);
  scene.add(model.root);
  const rebuild = (): void => {
    const rotation = model.root.rotation.y;
    model.dispose();
    model = new AvatarMesh(avatar);
    model.root.rotation.y = rotation;
    scene.add(model.root);
  };

  let saveTimer = 0;
  const changed = (): void => {
    rebuild();
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      api.saveAvatar(avatar).then(
        (r) => setUser(r.user),
        (err: unknown) => toast(errorMessage(err), 'error'),
      );
    }, 300);
  };

  let raf = 0;
  let last = performance.now();
  let time = 0;
  const animate = (now: number): void => {
    raf = requestAnimationFrame(animate);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    time += dt;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (renderer.domElement.width !== Math.floor(width * renderer.getPixelRatio())) {
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    }
    model.root.rotation.y = Math.sin(time * 0.7) * 0.5;
    model.animate(dt, { speed: 0, grounded: true, emote: 0, time });
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(animate);

  cleanup = () => {
    cancelAnimationFrame(raf);
    clearTimeout(saveTimer);
    model.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  };

  const swatches = (label: string, colors: string[], key: 'skin' | 'shirt' | 'pants'): HTMLElement => {
    const row = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': label });
    const render = (): void => {
      clear(row);
      for (const color of colors) {
        const button = h('button', {
          class: `swatch${avatar[key] === color ? ' active' : ''}`,
          role: 'radio',
          'aria-checked': String(avatar[key] === color),
          'aria-label': `${label} ${color}`,
          onclick: () => {
            avatar[key] = color;
            render();
            changed();
          },
        });
        button.style.background = color;
        row.append(button);
      }
    };
    render();
    return h('div', { class: 'option-group' }, h('h3', {}, label), row);
  };

  const faceRow = h('div', { class: 'chips' });
  const renderFaces = (): void => {
    clear(faceRow);
    for (const face of FACES) {
      faceRow.append(h('button', {
        class: `chip${avatar.face === face ? ' active' : ''}`,
        onclick: () => {
          avatar.face = face;
          renderFaces();
          changed();
        },
      }, face[0].toUpperCase() + face.slice(1)));
    }
  };
  renderFaces();

  const hatGrid = h('div', { class: 'hat-grid' });
  const renderHats = (): void => {
    clear(hatGrid);
    for (const hat of HATS) {
      const owned = hat.id === 'none' || user!.ownedHats.includes(hat.id);
      const equipped = avatar.hat === hat.id;
      hatGrid.append(
        h('button', {
          class: `hat-item${equipped ? ' active' : ''}${owned ? '' : ' locked'}`,
          onclick: () => {
            if (owned) {
              avatar.hat = hat.id;
              renderHats();
              changed();
              return;
            }
            api.buy(hat.id).then(
              (r) => {
                setUser(r.user);
                avatar.hat = hat.id;
                renderHats();
                changed();
                toast(`You got the ${hat.name}!`, 'good');
              },
              (err: unknown) => toast(errorMessage(err), 'error'),
            );
          },
        }, h('b', {}, hat.name), h('span', {}, owned ? (equipped ? 'Wearing' : 'Owned') : `${hat.price} coins`)),
      );
    }
  };
  renderHats();

  shell(
    'avatar',
    h(
      'div',
      { class: 'avatar-page' },
      stage,
      h(
        'div',
        { class: 'avatar-options' },
        h('h1', {}, 'Your avatar'),
        swatches('Skin', SKIN_COLORS, 'skin'),
        swatches('Shirt', CLOTH_COLORS, 'shirt'),
        swatches('Trousers', CLOTH_COLORS, 'pants'),
        h('div', { class: 'option-group' }, h('h3', {}, 'Face'), faceRow),
        h('div', { class: 'option-group' }, h('h3', {}, 'Hats'), h('p', { class: 'muted' }, 'Earn coins by collecting them in worlds and finishing courses.'), hatGrid),
      ),
    ),
  );
}

// --- Account upgrade ---

function renderAccount(): void {
  const username = h('input', { autocomplete: 'username', required: true, placeholder: 'Choose a username', 'aria-label': 'Username' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8, placeholder: 'Password (8+ characters)', 'aria-label': 'Password' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  shell(
    'account',
    h(
      'form',
      {
        class: 'panel narrow',
        onsubmit: (e: Event) => {
          e.preventDefault();
          api.register(username.value, password.value).then(
            (r) => {
              setToken(r.token);
              setUser(r.user);
              toast('Your progress is saved to your new account.', 'good');
              location.hash = '#/';
            },
            (err: unknown) => {
              error.textContent = errorMessage(err);
            },
          );
        },
      },
      h('h1', {}, 'Save your progress'),
      h('p', {}, 'Create an account to keep your coins, hats and worlds on any device.'),
      username,
      password,
      error,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create account'),
    ),
  );
}

// --- Rules ---

function renderRules(): void {
  const content = h(
    'article',
    { class: 'panel narrow rules' },
    h('h1', {}, 'Community rules'),
    h('p', {}, 'Tinkerlands is for everyone, so keep it friendly. Breaking these rules can get a world taken down or an account banned.'),
    h('ul', {},
      h('li', {}, 'Be kind. No bullying, harassment, hate or threats.'),
      h('li', {}, 'Keep it clean. No sexual, violent or otherwise inappropriate words or builds.'),
      h('li', {}, 'Stay safe. Never share your address, phone number, school or passwords, and never ask for anyone else’s.'),
      h('li', {}, 'Play fair. No cheating, exploits or wrecking other people’s builds.'),
      h('li', {}, 'See something wrong? Use Report in the in-game menu. Mute hides anyone you’d rather not hear from.'),
    ),
  );
  if (user) shell('rules', content);
  else {
    clear(app);
    app.append(h('main', { class: 'page' }, h('p', {}, h('a', { href: '#/' }, '← Back')), content));
  }
}

// --- Play ---

function renderPlay(worldId: string): void {
  if (!user) return;
  const token = getToken();
  if (!token) return;
  clear(app);
  coinBadge = null;
  const container = h('div', { class: 'game' });
  app.append(container);
  document.body.classList.add('in-game');
  const game = new Game({
    container,
    worldId,
    token,
    username: user.username,
    uid: user.id,
    avatar: user.avatar,
    coins: user.coins,
    onLeave: () => {
      location.hash = `#/world/${worldId}`;
    },
    onCoins: (coins) => {
      if (user) user.coins = coins;
    },
    onAuthExpired: () => {
      setToken(null);
      setUser(null);
      location.hash = '#/';
      route();
    },
  });
  cleanup = () => {
    game.dispose();
    document.body.classList.remove('in-game');
  };
}

// --- Router ---

function route(): void {
  cleanup?.();
  cleanup = null;
  const path = location.hash.replace(/^#/, '') || '/';
  const [, section, id] = path.split('/');

  if (section === 'rules') {
    renderRules();
    return;
  }
  if (!user) {
    renderLanding();
    return;
  }
  switch (section) {
    case 'world':
      void renderWorld(id);
      break;
    case 'play':
      renderPlay(id);
      break;
    case 'mine':
      void renderMine();
      break;
    case 'avatar':
      renderAvatar();
      break;
    case 'account':
      renderAccount();
      break;
    default:
      renderDiscover();
      break;
  }
}

async function boot(): Promise<void> {
  if (getToken()) {
    try {
      setUser((await api.me()).user);
    } catch (err) {
      // Only a rejected session signs the player out; a network blip shouldn't.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setToken(null);
      } else {
        clear(app);
        app.append(h('div', { class: 'empty' }, h('h1', {}, 'Can’t reach Tinkerlands'), h('p', {}, errorMessage(err)), h('button', { class: 'btn', onclick: () => location.reload() }, 'Try again')));
        return;
      }
    }
  }
  window.addEventListener('hashchange', route);
  route();
}

void boot();
