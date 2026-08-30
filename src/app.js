'use strict';

const content = document.getElementById('content');
const navBtns = [...document.querySelectorAll('.nav-btn')];

const pages = {
  dashboard: renderDashboard,
  wizard: renderWizard,
  config: renderConfig,
  apps: renderApps,
  doctor: renderDoctor
};

navBtns.forEach((btn) => {
  btn.addEventListener('click', () => go(btn.dataset.page));
});

function go(pageId) {
  navBtns.forEach((b) => b.classList.toggle('active', b.dataset.page === pageId));
  content.innerHTML = '';
  pages[pageId]();
}

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return el;
}

/* ---------------------------- DASHBOARD ---------------------------- */

async function renderDashboard() {
  const page = h('div', { class: 'page' }, [
    h('h1', {}, 'Dashboard'),
    h('div', { class: 'sub' }, 'Your WinApps virtual machines and quick actions.'),
    h('div', { id: 'vm-list-card', class: 'card' }, [h('h2', {}, 'Virtual Machines'), h('div', { class: 'sub' }, 'Loading...')])
  ]);
  content.appendChild(page);
  await refreshVmList();
}

async function refreshVmList() {
  const card = document.getElementById('vm-list-card');
  if (!card) return;
  let vms = [];
  try {
    vms = await window.api.vm.list();
  } catch (e) {
    card.innerHTML = '';
    card.appendChild(h('h2', {}, 'Virtual Machines'));
    card.appendChild(h('div', { class: 'sub' }, 'Could not list VMs: ' + e.message));
    return;
  }
  card.innerHTML = '';
  card.appendChild(h('h2', {}, 'Virtual Machines'));
  if (!vms.length) {
    card.appendChild(h('div', { class: 'sub' }, 'No VMs yet. Go to "New VM" to create one.'));
    return;
  }
  const list = h('div', { class: 'vm-list' });
  for (const vm of vms) {
    list.appendChild(await vmRow(vm));
  }
  card.appendChild(list);
}

async function vmRow(vm) {
  const running = vm.state.includes('running');
  const netDisconnected = await window.api.net.status('default').catch(() => false);

  const row = h('div', { class: 'vm-item' });
  row.appendChild(
    h('div', {}, [
      h('div', { class: 'vm-name' }, vm.name),
      h('div', { class: 'vm-state' }, [
        h('span', { class: 'badge ' + (running ? 'ok' : '') }, vm.state),
        ' ',
        h('span', { class: 'badge ' + (netDisconnected ? 'warn' : '') }, netDisconnected ? 'network isolated' : 'network connected')
      ])
    ])
  );

  const actions = h('div', { class: 'vm-actions' });
  const mkBtn = (label, fn, cls = '') =>
    h('button', {
      class: 'btn small ' + cls,
      onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          await fn();
          await refreshVmList();
        } catch (e) {
          toast(e.message, true);
        } finally {
          ev.target.disabled = false;
        }
      }
    }, label);

  // Equivalent to winvm-start / winvm-stop / winvm-kill / winvm-restart, with
  // the VM name substituted per-row automatically.
  actions.appendChild(mkBtn('Start', () => window.api.vm.start(vm.name)));
  actions.appendChild(mkBtn('Shutdown', () => window.api.vm.shutdown(vm.name)));
  actions.appendChild(mkBtn('Kill', () => window.api.vm.kill(vm.name), 'danger'));
  actions.appendChild(mkBtn('Restart', () => window.api.vm.reset(vm.name)));
  actions.appendChild(
    mkBtn(netDisconnected ? 'Reconnect network' : 'Disconnect network', () =>
      netDisconnected ? window.api.net.reconnect('default') : window.api.net.disconnect('default')
    )
  );
  row.appendChild(actions);
  return row;
}

/* ------------------------------ WIZARD ------------------------------ */

function renderWizard() {
  const state = {
    name: 'RDPWindows',
    memoryMiB: 4096,
    currentMemoryMiB: 1024,
    vcpus: 2,
    diskSizeGiB: 64,
    windowsIsoPath: '',
    virtioIsoPath: '',
    osTargetHint: 'win11',
    username: '',
    password: '',
    memballoon: true,
    startOnBoot: true,
    enableDefenderDisable: false,
    enableUpdatesDisable: false,
    enableBloatDisable: false
  };

  const page = h('div', { class: 'page' }, [
    h('h1', {}, 'Create a Windows VM'),
    h('div', { class: 'sub' }, 'Fully automates docs/libvirt.md: disk + domain XML with the Hyper-V enlightenments, clock tuning and guest-agent channel from the docs, an unattended silent Windows install, and the post-install RDP/registry/driver setup - no need to click through Windows setup yourself.'),
    h('div', { class: 'card' }, [
      h('h2', {}, 'VM identity'),
      field('VM name (must match winapps.conf VM_NAME)', textInput(state, 'name')),
      field('Windows edition', selectInput(state, 'osTargetHint', [
        ['win11', 'Windows 11 (Pro/Enterprise)'],
        ['win10', 'Windows 10 (Pro/Enterprise)']
      ]))
    ]),
    h('div', { class: 'card' }, [
      h('h2', {}, 'Install media'),
      isoField('Windows installer ISO', state, 'windowsIsoPath'),
      isoField('VirtIO drivers ISO', state, 'virtioIsoPath'),
      h('div', { class: 'sub' }, 'Pick local files. If you don\'t have them yet, download the Windows ISO from microsoft.com and the VirtIO ISO from the Fedora people mirror, then point here - no in-app downloader is bundled, so nothing here ever needs network access once you have the files.')
    ]),
    h('div', { class: 'card' }, [
      h('h2', {}, 'Resources'),
      h('div', { class: 'grid-2' }, [
        field('Memory (MiB, max)', numberInput(state, 'memoryMiB')),
        field('Memory (MiB, min / balloon floor)', numberInput(state, 'currentMemoryMiB')),
        field('vCPUs', numberInput(state, 'vcpus')),
        field('Disk size (GiB)', numberInput(state, 'diskSizeGiB'))
      ]),
      checkbox('Enable VirtIO memory ballooning (recommended)', state, 'memballoon'),
      checkbox('Start VM automatically on host boot', state, 'startOnBoot')
    ]),
    h('div', { class: 'card' }, [
      h('h2', {}, 'Windows account (becomes RDP_USER / RDP_PASS)'),
      h('div', { class: 'sub' }, 'This must be a full account + password (per the WinApps README, PIN-only accounts do not work over RDP). Saved into winapps.conf automatically once the VM is ready.'),
      h('div', { class: 'grid-2' }, [
        field('Username', textInput(state, 'username')),
        field('Password', passwordInput(state, 'password'))
      ])
    ]),
    h('div', { class: 'card' }, [
      h('h2', {}, 'Optional hardening (applied silently on first boot)'),
      checkbox('Disable Windows Defender', state, 'enableDefenderDisable'),
      checkbox('Disable Windows Update', state, 'enableUpdatesDisable'),
      checkbox('Trim background bloat services/tasks', state, 'enableBloatDisable')
    ]),
    h('div', { class: 'card', id: 'wizard-progress-card' }, [
      h('h2', {}, 'Create'),
      h('div', { class: 'sub' }, 'The VM boots with no window shown - just watch progress here. When it reaches 100%, Windows is installed and ready for winapps installation.'),
      h('div', { id: 'progress-area' }),
      h('button', {
        class: 'btn primary',
        id: 'create-btn',
        onclick: () => startCreate(state)
      }, 'Create VM')
    ])
  ]);
  content.appendChild(page);
}

function field(label, inputEl) {
  return h('div', { class: 'field' }, [h('label', {}, label), inputEl]);
}
function textInput(state, key) {
  const el = h('input', { type: 'text', value: state[key] });
  el.addEventListener('input', () => (state[key] = el.value));
  return el;
}
function passwordInput(state, key) {
  const el = h('input', { type: 'password', value: state[key] });
  el.addEventListener('input', () => (state[key] = el.value));
  return el;
}
function numberInput(state, key) {
  const el = h('input', { type: 'number', value: state[key] });
  el.addEventListener('input', () => (state[key] = Number(el.value)));
  return el;
}
function selectInput(state, key, options) {
  const el = h('select', {});
  options.forEach(([val, label]) => {
    const opt = h('option', { value: val }, label);
    if (val === state[key]) opt.setAttribute('selected', 'selected');
    el.appendChild(opt);
  });
  el.addEventListener('change', () => (state[key] = el.value));
  return el;
}
function checkbox(label, state, key) {
  const id = 'chk-' + key + '-' + Math.random().toString(36).slice(2, 7);
  const input = h('input', { type: 'checkbox', id });
  input.checked = !!state[key];
  input.addEventListener('change', () => (state[key] = input.checked));
  return h('div', { class: 'checkbox-field' }, [input, h('label', { for: id }, label)]);
}
function isoField(label, state, key) {
  const pathText = h('input', { type: 'text', value: state[key], readonly: 'readonly' });
  const browse = h('button', {
    class: 'btn small',
    onclick: async () => {
      const p = await window.api.dialogs.pickIso({ title: label });
      if (p) {
        state[key] = p;
        pathText.value = p;
      }
    }
  }, 'Browse...');
  return h('div', { class: 'field' }, [h('label', {}, label), h('div', { class: 'row' }, [h('div', { style: 'flex:1' }, pathText), browse])]);
}

async function startCreate(state) {
  if (!state.windowsIsoPath || !state.virtioIsoPath) return toast('Pick both ISOs first.', true);
  if (!state.username || !state.password) return toast('Set a Windows username and password.', true);

  const btn = document.getElementById('create-btn');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  const area = document.getElementById('progress-area');
  area.innerHTML = '';
  const bar = h('div', { class: 'progress-wrap' }, [h('div', { class: 'progress-bar', style: 'width:0%' })]);
  const msg = h('div', { class: 'progress-msg' }, 'Starting...');
  area.appendChild(bar);
  area.appendChild(msg);

  const unsubscribe = window.api.vm.onCreateProgress((p) => {
    bar.firstChild.style.width = Math.max(2, p.pct) + '%';
    msg.textContent = `[${p.stage}] ${p.message}`;
  });

  const res = await window.api.vm.create({ ...state });
  unsubscribe();
  btn.disabled = false;
  btn.textContent = 'Create VM';

  if (!res.ok) {
    toast('VM creation failed: ' + res.error, true);
    return;
  }
  toast(`VM "${state.name}" is ready.`);

  // Write RDP_USER/RDP_PASS/VM_NAME/WAFLAVOR straight into winapps.conf.
  await window.api.config.set({
    RDP_USER: state.username,
    RDP_PASS: state.password,
    VM_NAME: state.name,
    WAFLAVOR: 'libvirt'
  });
  go('dashboard');
}

/* ------------------------------ CONFIG ------------------------------ */

async function renderConfig() {
  const { values, comments } = await window.api.config.get();
  const page = h('div', { class: 'page' }, [
    h('h1', {}, 'winapps.conf'),
    h('div', { class: 'sub' }, '~/.config/winapps/winapps.conf - every field below maps 1:1 to a key in that file. Saving only rewrites the values you changed; all comments and layout stay intact.')
  ]);
  const form = h('div', { class: 'card' });
  const fieldsState = { ...values };

  const groups = [
    ['Windows account', ['RDP_USER', 'RDP_PASS', 'RDP_DOMAIN']],
    ['Connection', ['RDP_IP', 'RDP_PORT', 'VM_NAME', 'WAFLAVOR', 'RDP_SCALE']],
    ['FreeRDP flags', ['RDP_FLAGS', 'RDP_FLAGS_NON_WINDOWS', 'RDP_FLAGS_WINDOWS', 'FREERDP_COMMAND', 'HIDEF']],
    ['Files', ['REMOVABLE_MEDIA']],
    ['Behaviour', ['DEBUG', 'AUTOPAUSE', 'AUTOPAUSE_TIME']],
    ['Timeouts', ['PORT_TIMEOUT', 'RDP_TIMEOUT', 'APP_SCAN_TIMEOUT', 'BOOT_TIMEOUT']]
  ];

  for (const [groupLabel, keys] of groups) {
    const box = h('div', { style: 'margin-bottom:18px' });
    box.appendChild(h('h3', {}, groupLabel));
    for (const key of keys) {
      if (!(key in fieldsState)) continue;
      const isSecret = key === 'RDP_PASS';
      const inputEl = h('input', { type: isSecret ? 'password' : 'text', value: fieldsState[key] });
      inputEl.addEventListener('input', () => (fieldsState[key] = inputEl.value));
      const wrap = h('div', { class: 'field' }, [
        h('label', {}, `${key}${comments[key] ? ' — ' + comments[key].split('\n')[0] : ''}`),
        inputEl
      ]);
      box.appendChild(wrap);
    }
    form.appendChild(box);
  }

  form.appendChild(
    h('button', {
      class: 'btn primary',
      onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          await window.api.config.set(fieldsState);
          toast('winapps.conf saved.');
        } catch (e) {
          toast(e.message, true);
        } finally {
          ev.target.disabled = false;
        }
      }
    }, 'Save changes')
  );

  page.appendChild(form);
  content.appendChild(page);
}

/* ------------------------------- APPS ------------------------------- */

async function renderApps() {
  const page = h('div', { class: 'page' }, [
    h('h1', {}, 'Apps'),
    h('div', { class: 'sub' }, 'Tick an app to add its launcher, untick to remove it - applied instantly, no terminal, no network needed once the catalog is cached.')
  ]);
  page.style.maxWidth = '1100px';

  const installedCard = h('div', { class: 'card' }, [h('h2', {}, 'WinApps installation')]);
  const installed = await window.api.winapps.isInstalled();
  installedCard.appendChild(h('div', { class: 'row' }, [
    h('span', { class: 'badge ' + (installed ? 'ok' : 'warn') }, installed ? 'WinApps CLI found' : 'WinApps not installed yet'),
    installed
      ? h('button', { class: 'btn', onclick: () => window.api.winapps.check().then(() => toast('Ran winapps check - see terminal/log for output.')) }, 'Run connectivity check')
      : h('button', { class: 'btn primary', onclick: () => window.api.winapps.launchInstaller().catch((e) => toast(e.message, true)) }, 'Install WinApps now')
  ]));
  page.appendChild(installedCard);

  const pickerCard = h('div', { class: 'card' });
  pickerCard.appendChild(h('h2', {}, 'App picker'));
  const body = h('div', {});
  pickerCard.appendChild(body);
  page.appendChild(pickerCard);
  content.appendChild(page);

  const cached = await window.api.apps.catalogIsCached();
  if (!cached) {
    renderCatalogSyncPrompt(body, false);
    return;
  }
  await renderAppGrid(body);
}

function renderCatalogSyncPrompt(container, isResync) {
  container.innerHTML = '';
  container.appendChild(h('div', { class: 'sub' }, isResync
    ? 'Re-syncing pulls any newly added community apps and refreshes icons from the WinApps repo. One-time network use, then offline again.'
    : 'First time here: this does one one-time download of app names + icons from the WinApps repo (a few hundred KB). After that, the picker works completely offline - checking/unchecking apps never touches the network again.'));
  const progress = h('div', { class: 'sub' }, '');
  const btn = h('button', {
    class: 'btn primary',
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Syncing...';
      const off = window.api.apps.onCatalogSyncProgress((line) => (progress.textContent = line));
      const res = await window.api.apps.catalogSync(isResync);
      off();
      if (!res.ok) {
        toast('Catalog sync failed: ' + res.error, true);
        btn.disabled = false;
        btn.textContent = 'Retry sync';
        return;
      }
      toast(`Cached ${res.apps.length} apps.`);
      await renderAppGrid(container);
    }
  }, isResync ? 'Re-sync catalog' : 'Sync app catalog (one-time)');
  container.appendChild(h('div', { class: 'row', style: 'margin-top:10px' }, [btn]));
  container.appendChild(progress);
}

async function renderAppGrid(container) {
  container.innerHTML = 'Loading catalog...';
  const catalog = await window.api.apps.catalogGet();
  const enabledSlugs = new Set(await window.api.apps.listEnabled(catalog));

  container.innerHTML = '';

  const toolbar = h('div', { class: 'app-toolbar' }, [
    h('input', { class: 'app-search', type: 'text', placeholder: 'Filter apps...' }),
    h('input', { type: 'text', value: 'RDPWindows', style: 'max-width:180px', id: 'apps-vm-name' }),
    h('button', { class: 'btn', id: 'apps-detect-btn' }, 'Detect installed apps'),
    h('button', { class: 'btn', onclick: () => renderCatalogSyncPrompt(container, true) }, 'Re-sync catalog')
  ]);
  container.appendChild(toolbar);

  const detectedNote = h('div', { class: 'sub' }, '');
  container.appendChild(detectedNote);

  const grid = h('div', { class: 'app-grid' });
  container.appendChild(grid);

  let detected = new Set();

  function draw(filterText) {
    grid.innerHTML = '';
    const f = (filterText || '').trim().toLowerCase();
    const visible = catalog.filter((a) => !f || a.fullName.toLowerCase().includes(f));
    for (const app of visible) {
      grid.appendChild(appTile(app, enabledSlugs, detected));
    }
    if (!visible.length) grid.appendChild(h('div', { class: 'sub' }, 'No apps match.'));
  }

  toolbar.querySelector('.app-search').addEventListener('input', (e) => draw(e.target.value));

  toolbar.querySelector('#apps-detect-btn').addEventListener('click', async () => {
    const vmName = toolbar.querySelector('#apps-vm-name').value.trim();
    detectedNote.textContent = 'Scanning installed programs via QEMU Guest Agent...';
    try {
      const installedPrograms = await window.api.apps.scan(vmName);
      const matches = await window.api.apps.detectMatches(catalog, installedPrograms);
      detected = new Set(matches);
      detectedNote.textContent = `Detected ${detected.size} catalog apps installed in "${vmName}" (green dot). Checking a box is still up to you.`;
      draw(toolbar.querySelector('.app-search').value);
    } catch (e) {
      detectedNote.textContent = 'Detection failed: ' + e.message + ' (VM not running / guest agent not ready?)';
    }
  });

  draw('');
}

function appTile(app, enabledSlugs, detected) {
  const enabled = enabledSlugs.has(app.slug);
  const icon = app.iconPath
    ? h('img', { class: 'app-icon', src: 'file://' + app.iconPath, alt: '' })
    : h('div', { class: 'app-icon fallback' }, app.fullName.slice(0, 2).toUpperCase());

  const checkbox = h('input', { type: 'checkbox', class: 'app-check' });
  checkbox.checked = enabled;

  const tile = h('div', { class: 'app-tile' + (enabled ? ' enabled' : '') }, [
    detected.has(app.slug) ? h('div', { class: 'app-detected', title: 'Detected as installed in Windows' }) : null,
    checkbox,
    icon,
    h('div', { class: 'app-name' }, app.fullName)
  ]);

  const toggle = async () => {
    const next = !checkbox.checked;
    checkbox.checked = next;
    tile.classList.toggle('enabled', next);
    checkbox.disabled = true;
    const res = next ? await window.api.apps.enable(app) : await window.api.apps.disable(app.slug);
    checkbox.disabled = false;
    if (!res.ok) {
      checkbox.checked = !next;
      tile.classList.toggle('enabled', !next);
      toast(`Could not ${next ? 'enable' : 'disable'} ${app.fullName}: ${res.error}`, true);
    } else {
      next ? enabledSlugs.add(app.slug) : enabledSlugs.delete(app.slug);
    }
  };

  // Single path for both "click the tile" and "click the checkbox": suppress
  // the checkbox's own native toggle and drive checked/enabled state (plus
  // the enable/disable IPC call) entirely through toggle() above.
  checkbox.addEventListener('click', (e) => e.preventDefault());
  tile.addEventListener('click', toggle);

  return tile;
}

/* ------------------------------ DOCTOR ------------------------------ */

async function renderDoctor() {
  const page = h('div', { class: 'page' }, [
    h('h1', {}, 'Setup Check'),
    h('div', { class: 'sub' }, 'Everything docs/libvirt.md lists as a prerequisite, checked automatically.')
  ]);
  const card = h('div', { class: 'card' }, [h('div', { class: 'sub' }, 'Checking...')]);
  page.appendChild(card);
  content.appendChild(page);

  const { allOk, results } = await window.api.host.check();
  card.innerHTML = '';
  card.appendChild(h('div', { class: 'row', style: 'margin-bottom:12px' }, [
    h('span', { class: 'badge ' + (allOk ? 'ok' : 'bad') }, allOk ? 'All checks passed' : 'Some checks need attention')
  ]));
  const list = h('div', { class: 'check-list' });
  results.forEach((r) => {
    list.appendChild(h('div', { class: 'check-item' }, [
      h('div', {}, [h('div', { class: 'label' }, r.label), h('div', { class: 'detail' }, r.detail || '')]),
      h('span', { class: 'badge ' + (r.ok ? 'ok' : 'bad') }, r.ok ? 'OK' : 'Fix needed')
    ]));
  });
  card.appendChild(list);
}

go('dashboard');
