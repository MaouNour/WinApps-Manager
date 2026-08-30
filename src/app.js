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
    h('div', { class: 'sub' }, 'WinApps ships its own app-detection wizard (winapps-setup), which already scans the registry, matches community-tested apps with proper icons/MIME types, and lets you check/uncheck what gets a launcher. This screen launches that wizard directly - no network needed once WinApps is installed.')
  ]);

  const installedCard = h('div', { class: 'card' }, [h('h2', {}, 'WinApps installation')]);
  const installed = await window.api.winapps.isInstalled();
  installedCard.appendChild(h('div', { class: 'row' }, [
    h('span', { class: 'badge ' + (installed ? 'ok' : 'warn') }, installed ? 'WinApps CLI found' : 'WinApps not installed yet'),
    installed
      ? h('button', { class: 'btn', onclick: () => window.api.winapps.check().then(() => toast('Ran winapps check - see terminal/log for output.')) }, 'Run connectivity check')
      : h('button', { class: 'btn primary', onclick: () => window.api.winapps.launchInstaller().catch((e) => toast(e.message, true)) }, 'Install WinApps now')
  ]));
  page.appendChild(installedCard);

  const refreshCard = h('div', { class: 'card' }, [
    h('h2', {}, 'Manage which apps get a launcher'),
    h('div', { class: 'sub' }, 'Opens the official checkbox picker in a terminal window. Run it again any time after installing a new Windows app.'),
    h('button', {
      class: 'btn primary',
      onclick: () => window.api.winapps.launchAppRefresh().then(() => toast('Opened the WinApps app picker.')).catch((e) => toast(e.message, true))
    }, 'Refresh app list')
  ]);
  page.appendChild(refreshCard);

  const previewCard = h('div', { class: 'card' }, [
    h('h2', {}, 'Installed programs (read-only preview)'),
    h('div', { class: 'sub' }, 'Queries the registry inside the VM over the QEMU Guest Agent, purely so you can see what\'s installed before opening the picker above. VM name below defaults to VM_NAME from winapps.conf.')
  ]);
  const vmNameInput = h('input', { type: 'text', value: 'RDPWindows', style: 'max-width:220px;display:inline-block;margin-right:8px' });
  const results = h('div', { class: 'check-list', style: 'margin-top:12px' });
  previewCard.appendChild(h('div', { class: 'row' }, [
    vmNameInput,
    h('button', { class: 'btn', onclick: async () => {
      results.innerHTML = 'Scanning...';
      try {
        const apps = await window.api.apps.scan(vmNameInput.value.trim());
        results.innerHTML = '';
        if (!apps.length) results.appendChild(h('div', { class: 'sub' }, 'No programs found (or VM not running / guest agent not ready).'));
        apps.forEach((a) => {
          results.appendChild(h('div', { class: 'check-item' }, [
            h('div', {}, [h('div', { class: 'label' }, a.name), h('div', { class: 'detail' }, a.version || '')])
          ]));
        });
      } catch (e) {
        results.innerHTML = '';
        results.appendChild(h('div', { class: 'sub' }, 'Scan failed: ' + e.message));
      }
    }}, 'Scan')
  ]));
  previewCard.appendChild(results);
  page.appendChild(previewCard);

  content.appendChild(page);
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
