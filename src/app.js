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

/* ---------------------- TAB CACHING ----------------------
 * Each page gets its own container that is created and rendered exactly
 * once, then just shown/hidden on nav clicks - so switching tabs is
 * instant instead of re-fetching everything every time. Pages that show
 * live data (Dashboard) keep themselves fresh via a background poller
 * that runs regardless of which tab is visible; the others get a manual
 * "Refresh" affordance instead of re-querying on every visit.
 * ---------------------------------------------------------- */
const pageContainers = {};
const pageReady = {};

navBtns.forEach((btn) => {
  btn.addEventListener('click', () => go(btn.dataset.page));
});

function go(pageId) {
  navBtns.forEach((b) => b.classList.toggle('active', b.dataset.page === pageId));
  Object.entries(pageContainers).forEach(([id, el]) => {
    el.style.display = id === pageId ? '' : 'none';
  });
  if (!pageContainers[pageId]) {
    const el = h('div');
    content.appendChild(el);
    pageContainers[pageId] = el;
  }
  if (!pageReady[pageId]) {
    pageReady[pageId] = true;
    pages[pageId](pageContainers[pageId]);
  } else if (pageId === 'dashboard') {
    // Data may have changed in the background while this tab was hidden -
    // repaint instantly from cache (no network round-trip on the switch itself).
    paintDashboard();
  }
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

function fmtPct(p) {
  return p == null ? '—' : `${p}%`;
}

/* ------------------------- HOST STATS BAR -------------------------
 * Always visible in the sidebar, on every tab, refreshed independently
 * of whatever page is currently open.
 * -------------------------------------------------------------- */
function meterClass(pct) {
  return pct != null && pct >= 85 ? 'meter-fill hot' : 'meter-fill';
}

async function pollHostStats() {
  try {
    const s = await window.api.host.stats();
    const cpuBar = document.getElementById('hs-cpu-bar');
    const cpuVal = document.getElementById('hs-cpu-val');
    if (cpuBar) {
      cpuBar.style.width = (s.cpuPercent ?? 0) + '%';
      cpuBar.className = meterClass(s.cpuPercent);
      cpuVal.textContent = fmtPct(s.cpuPercent);
    }
    const ramBar = document.getElementById('hs-ram-bar');
    const ramVal = document.getElementById('hs-ram-val');
    if (ramBar && s.memory) {
      ramBar.style.width = (s.memory.percent ?? 0) + '%';
      ramBar.className = meterClass(s.memory.percent);
      ramVal.textContent = fmtPct(s.memory.percent);
    }
    const gpuBar = document.getElementById('hs-gpu-bar');
    const gpuVal = document.getElementById('hs-gpu-val');
    if (gpuBar) {
      if (s.gpu) {
        gpuBar.style.width = (s.gpu.percent ?? 0) + '%';
        gpuBar.className = meterClass(s.gpu.percent);
        gpuVal.textContent = fmtPct(s.gpu.percent);
      } else {
        gpuBar.style.width = '0%';
        gpuVal.textContent = 'n/a';
      }
    }
  } catch (_) {
    // Host stats are a nice-to-have - never surface a toast for this.
  }
}
setInterval(pollHostStats, 2000);
pollHostStats();

/* ---------------------------- DASHBOARD ---------------------------- */

// In-memory cache so re-opening a VM's details, or switching back to this
// tab, is instant - populated by the background poller and by the details
// panel's own refresh, never wiped out on tab switches.
const dash = {
  vms: null,
  netStatus: {}, // networkName -> bool (disconnected)
  passwordless: null,
  details: {}, // vmName -> { stats, config, guestStatus, statsAt, guestAt }
  expanded: new Set(),
  statsTimers: {} // vmName -> interval id, while its panel is expanded
};

async function pollDashboard() {
  try {
    const vms = await window.api.vm.list();
    const netDisconnected = await window.api.net.status('default').catch(() => false);
    dash.vms = vms;
    dash.netStatus['default'] = netDisconnected;
  } catch (e) {
    dash.vms = dash.vms || [];
    dash.vmListError = e.message;
  }
  paintDashboard();
}
setInterval(pollDashboard, 4000);

function renderDashboard(root) {
  root.appendChild(
    h('div', { class: 'page' }, [
      h('h1', {}, 'Dashboard'),
      h('div', { class: 'sub' }, 'Your WinApps virtual machines and quick actions. Updates automatically in the background.'),
      h('div', { id: 'vm-list-card', class: 'card' }, [h('h2', {}, 'Virtual Machines'), h('div', { class: 'sub' }, 'Loading...')])
    ])
  );
  pollDashboard();
}

function paintDashboard() {
  const card = document.getElementById('vm-list-card');
  if (!card) return; // dashboard not built yet
  card.innerHTML = '';
  card.appendChild(h('h2', {}, 'Virtual Machines'));

  if (dash.vms == null) {
    card.appendChild(h('div', { class: 'sub' }, 'Loading...'));
    return;
  }
  if (dash.vmListError && !dash.vms.length) {
    card.appendChild(h('div', { class: 'sub' }, 'Could not list VMs: ' + dash.vmListError));
    return;
  }
  if (!dash.vms.length) {
    card.appendChild(h('div', { class: 'sub' }, 'No VMs yet. Go to "New VM" to create one.'));
    return;
  }
  const list = h('div', { class: 'vm-list' });
  for (const vm of dash.vms) list.appendChild(vmRow(vm));
  card.appendChild(list);
}

function vmRow(vm) {
  const running = vm.state.includes('running');
  const netDisconnected = !!dash.netStatus['default'];

  const row = h('div', { class: 'vm-item' });
  row.appendChild(
    h('div', {}, [
      h('div', { class: 'vm-name' }, vm.name),
      h('div', { class: 'vm-state' }, [
        h('span', { class: 'badge ' + (running ? 'ok' : '') }, vm.state),
        ' ',
        h('span', { class: 'badge ' + (netDisconnected ? 'warn' : 'ok') }, netDisconnected ? 'network isolated' : 'network connected')
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
          await pollDashboard();
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
  const isExpanded = dash.expanded.has(vm.name);
  const detailsBtn = h('button', { class: 'btn small' }, isExpanded ? 'Hide details' : 'Details');
  actions.appendChild(detailsBtn);

  const wrap = h('div', {}, [row]);
  const detailsArea = h('div', { style: 'display:' + (isExpanded ? 'block' : 'none') + '; margin-top:8px' });
  wrap.appendChild(detailsArea);

  if (isExpanded) {
    detailsArea.appendChild(renderVmDetails(vm));
    startDetailsAutoRefresh(vm.name);
  }

  detailsBtn.addEventListener('click', async () => {
    const showing = dash.expanded.has(vm.name);
    if (showing) {
      dash.expanded.delete(vm.name);
      stopDetailsAutoRefresh(vm.name);
      detailsArea.style.display = 'none';
      detailsArea.innerHTML = '';
      detailsBtn.textContent = 'Details';
    } else {
      dash.expanded.add(vm.name);
      detailsBtn.textContent = 'Hide details';
      detailsArea.style.display = 'block';
      detailsArea.innerHTML = '';
      detailsArea.appendChild(renderVmDetails(vm));
      startDetailsAutoRefresh(vm.name);
      // Kick a fetch right away even if we already had cached data, so the
      // numbers are fresh the moment you actually look at them.
      await refreshVmDetailsData(vm.name, { full: true });
      rerenderVmDetailsIfOpen(vm);
    }
  });

  row.appendChild(actions);
  return wrap;
}

function startDetailsAutoRefresh(vmName) {
  if (dash.statsTimers[vmName]) return;
  dash.statsTimers[vmName] = setInterval(async () => {
    await refreshVmDetailsData(vmName, { full: false });
    const vm = (dash.vms || []).find((v) => v.name === vmName);
    if (vm) rerenderVmDetailsIfOpen(vm);
  }, 3000);
}

function stopDetailsAutoRefresh(vmName) {
  if (dash.statsTimers[vmName]) {
    clearInterval(dash.statsTimers[vmName]);
    delete dash.statsTimers[vmName];
  }
}

// Re-paints just the expanded details block for one VM in place, without
// touching the rest of the dashboard (avoids losing focus/scroll position).
function rerenderVmDetailsIfOpen(vm) {
  if (!dash.expanded.has(vm.name)) return;
  const rows = [...document.querySelectorAll('.vm-item')];
  const rowEl = rows.find((r) => r.querySelector('.vm-name')?.textContent === vm.name);
  if (!rowEl) return;
  const detailsArea = rowEl.parentElement.querySelector('div[style*="display"]');
  if (!detailsArea) return;
  detailsArea.innerHTML = '';
  detailsArea.appendChild(renderVmDetails(vm));
}

/** Fetches fresh stats/config (always) and, if `full`, also guest status. Fills the cache. */
async function refreshVmDetailsData(vmName, { full }) {
  if (!dash.details[vmName]) dash.details[vmName] = {};
  const entry = dash.details[vmName];
  try {
    const [stats, config] = await Promise.all([
      window.api.vmExtra.stats(vmName),
      window.api.vmExtra.config(vmName)
    ]);
    entry.stats = stats;
    entry.config = config;
    entry.statsAt = Date.now();
  } catch (e) {
    entry.statsError = e.message;
  }
  if (full) {
    try {
      entry.guestStatus = await window.api.guest.status(vmName);
      entry.guestError = null;
    } catch (e) {
      entry.guestError = e.message;
    }
    entry.guestAt = Date.now();
  }
}

/* -------------------------- VM DETAILS PANEL --------------------------
 * Renders synchronously from whatever is already in `dash.details` (which
 * may be nothing the very first time a VM is expanded, in which case it
 * shows a loading placeholder that refreshVmDetailsData() fills in a
 * moment later via rerenderVmDetailsIfOpen()).
 * ---------------------------------------------------------------- */

function renderVmDetails(vm) {
  const panel = h('div', { class: 'card', style: 'background:var(--panel-2)' });
  const entry = dash.details[vm.name] || {};

  // --- Live stats (CPU / RAM / disk / network - always kept fresh while open) ---
  const statsBox = h('div', { style: 'margin-bottom:16px' });
  statsBox.appendChild(h('h3', {}, 'Live stats'));
  if (entry.stats) {
    const stats = entry.stats;
    const memUsedMiB = Math.round((stats.memory.usedKiB || 0) / 1024);
    const memTotalMiB = Math.round((stats.memory.availableKiB || 0) / 1024);
    statsBox.appendChild(h('div', { class: 'row' }, [
      h('span', { class: 'badge' }, `CPU: ${fmtPct(stats.cpuPercent)}`),
      h('span', { class: 'badge' }, `RAM: ${memUsedMiB || '—'} / ${memTotalMiB || '—'} MiB`),
      stats.disk ? h('span', { class: 'badge' }, `Disk: ${(stats.disk.actualSizeBytes / 1e9).toFixed(1)} / ${(stats.disk.virtualSizeBytes / 1e9).toFixed(1)} GB`) : null,
      stats.network ? h('span', { class: 'badge' }, `Net: ↓${(stats.network.rxBytes / 1e6).toFixed(1)}MB ↑${(stats.network.txBytes / 1e6).toFixed(1)}MB`) : null
    ]));
  } else if (entry.statsError) {
    statsBox.appendChild(h('div', { class: 'sub' }, 'Stats unavailable: ' + entry.statsError));
  } else {
    statsBox.appendChild(h('div', { class: 'sub' }, 'Loading...'));
  }
  panel.appendChild(statsBox);

  // --- Resize compute/storage - values read live from libvirt, not just our own saved metadata ---
  const cfg = entry.config;
  const resizeBox = h('div', { style: 'margin-bottom:16px' });
  resizeBox.appendChild(h('h3', {}, 'Resources (edit, VM must be shut off)'));
  if (cfg) {
    resizeBox.appendChild(h('div', { class: 'sub' }, `Currently: ${cfg.vcpus || '—'} vCPUs, ${cfg.memoryMiB || '—'} MiB RAM, ${cfg.diskSizeGiB ?? '—'} GB disk (${cfg.diskAllocatedGiB ?? '—'} GB allocated) - read directly from the running VM's own definition.`));
    const vcpuInput = h('input', { type: 'number', value: cfg.vcpus || 2, style: 'max-width:100px' });
    const memInput = h('input', { type: 'number', value: cfg.memoryMiB || 4096, style: 'max-width:140px' });
    const diskInput = h('input', { type: 'number', value: Math.round(cfg.diskSizeGiB || 64), style: 'max-width:100px' });
    resizeBox.appendChild(h('div', { class: 'row' }, [
      h('div', {}, [h('label', {}, 'vCPUs'), vcpuInput]),
      h('div', {}, [h('label', {}, 'Memory (MiB)'), memInput]),
      h('div', {}, [h('label', {}, 'Disk (GiB, grow only)'), diskInput]),
      h('button', {
        class: 'btn',
        onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            await window.api.vmExtra.resizeCompute(vm.name, { vcpus: Number(vcpuInput.value), memoryMiB: Number(memInput.value) });
            if (cfg.diskPath && Number(diskInput.value) > (cfg.diskSizeGiB || 0)) {
              await window.api.vmExtra.growDisk(vm.name, cfg.diskPath, Number(diskInput.value));
            }
            toast('Resources updated. Start the VM to apply.');
            await refreshVmDetailsData(vm.name, { full: false });
            rerenderVmDetailsIfOpen(vm);
          } catch (e) {
            toast(e.message, true);
          } finally {
            ev.target.disabled = false;
          }
        }
      }, 'Apply')
    ]));
    resizeBox.appendChild(h('div', { class: 'sub' }, 'Growing the disk only extends the virtual file - use Disk Management inside Windows afterwards to extend the NTFS volume onto the new space.'));
  } else {
    resizeBox.appendChild(h('div', { class: 'sub' }, entry.statsError ? 'Could not read live configuration.' : 'Loading...'));
  }
  panel.appendChild(resizeBox);

  // --- Live Defender/Update/Firewall/Performance/bloat toggles ---
  const guestBox = h('div', {});
  guestBox.appendChild(h('h3', {}, 'Windows management'));
  panel.appendChild(guestBox);

  const FEATURES = [
    ['defender', 'Windows Defender (incl. real-time protection)', 'defenderDisabled'],
    ['updates', 'Windows Update', 'updatesDisabled'],
    ['firewall', 'Windows Firewall', 'firewallDisabled'],
    ['performance', 'Optimize for performance (visual effects, power plan, hibernation)', 'performanceDisabled'],
    ['bloat', 'Background bloat services/tasks', 'bloatDisabled']
  ];

  if (entry.guestStatus) {
    const status = entry.guestStatus;
    if (status.defenderTamperProtected) {
      guestBox.appendChild(h('div', { class: 'sub', style: 'color:var(--warn); margin-bottom:8px' },
        'Defender Tamper Protection is ON in this VM - Microsoft blocks scripted changes to Defender while it\u2019s on. Turn it off by hand first: Windows Security \u2192 Virus & threat protection \u2192 Manage settings \u2192 Tamper Protection.'));
    }
    const list = h('div', { class: 'check-list' });
    for (const [feature, label, statusKey] of FEATURES) {
      const disabled = !!status[statusKey];
      const item = h('div', { class: 'check-item' }, [
        h('div', {}, [h('div', { class: 'label' }, label)]),
        h('div', { class: 'row' }, [
          h('span', { class: 'badge ' + (disabled ? 'warn' : 'ok') }, disabled ? 'disabled' : 'enabled'),
          h('button', {
            class: 'btn small',
            onclick: async (ev) => {
              ev.target.disabled = true;
              try {
                await window.api.guest.toggle(vm.name, feature, disabled /* enable if currently disabled */);
                toast(`${label} ${disabled ? 'enabled' : 'disabled'}.`);
                await refreshVmDetailsData(vm.name, { full: true });
                rerenderVmDetailsIfOpen(vm);
              } catch (e) {
                toast(e.message, true);
              } finally {
                ev.target.disabled = false;
              }
            }
          }, disabled ? 'Enable' : 'Disable')
        ])
      ]);
      list.appendChild(item);
    }
    guestBox.appendChild(list);

    guestBox.appendChild(h('button', {
      class: 'btn primary',
      style: 'margin-top:10px',
      onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          await window.api.guest.applyRecommended(vm.name);
          toast('Applied recommended WinApps settings (Defender, Updates, background bloat, performance mode disabled).');
          await refreshVmDetailsData(vm.name, { full: true });
          rerenderVmDetailsIfOpen(vm);
        } catch (e) {
          toast(e.message, true);
        } finally {
          ev.target.disabled = false;
        }
      }
    }, 'Apply recommended WinApps optimizations'));
    guestBox.appendChild(h('div', { class: 'sub' }, 'Firewall is left as-is by the recommended preset; toggle it separately above if you want it off too.'));
  } else if (entry.guestError) {
    guestBox.appendChild(h('div', { class: 'sub' }, 'Could not read guest status (VM must be running with the guest agent up): ' + entry.guestError));
  } else {
    guestBox.appendChild(h('div', { class: 'sub' }, 'Loading...'));
  }

  return panel;
}

/* ------------------------------ WIZARD ------------------------------ */

function renderWizard(root) {
  const state = {
    name: 'RDPWindows',
    memoryMiB: 4096,
    currentMemoryMiB: 1024,
    vcpus: 2,
    diskSizeGiB: 64,
    windowsIsoPath: '',
    virtioIsoPath: '',
    useAutoMedia: true,
    osTargetHint: 'win11',
    username: '',
    password: '',
    memballoon: true,
    startOnBoot: true,
    enableDefenderDisable: false,
    enableUpdatesDisable: false,
    enableFirewallDisable: false,
    enableBloatDisable: false,
    enablePerformanceMode: false
  };

  const page = h('div', { class: 'page' }, [
    h('h1', {}, 'Create a Windows VM'),
    h('div', { class: 'sub' }, 'Fully automates docs/libvirt.md: disk + domain XML with the Hyper-V enlightenments, clock tuning and guest-agent channel from the docs, an unattended silent Windows install, and the post-install RDP/registry/driver setup - no need to click through Windows setup, and by default no need to touch ISOs either.'),
    h('div', { class: 'card' }, [
      h('h2', {}, 'VM identity'),
      field('VM name (must match winapps.conf VM_NAME)', textInput(state, 'name')),
      field('Windows edition', selectInput(state, 'osTargetHint', [
        ['win11', 'Windows 11 (Pro/Enterprise)'],
        ['win10', 'Windows 10 (Pro/Enterprise)']
      ]))
    ]),
    renderMediaCard(state),
    h('div', { class: 'card' }, [
      h('h2', {}, 'Resources'),
      h('div', { class: 'grid-2' }, [
        field('Memory (MiB, max)', numberInput(state, 'memoryMiB')),
        field('Memory (MiB, min / balloon floor)', numberInput(state, 'currentMemoryMiB')),
        field('vCPUs', numberInput(state, 'vcpus')),
        field('Disk size (GiB)', numberInput(state, 'diskSizeGiB'))
      ]),
      checkbox('Enable VirtIO memory ballooning (recommended)', state, 'memballoon'),
      checkbox('Start VM automatically on host boot', state, 'startOnBoot'),
      h('div', { class: 'sub' }, 'All of these (RAM, vCPUs, disk size) stay editable later from the Dashboard once the VM exists - and the Dashboard always reads the real, current values back from libvirt itself.')
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
      h('h2', {}, 'Optional hardening & performance (applied silently on first boot)'),
      checkbox('Disable Windows Defender (incl. real-time protection)', state, 'enableDefenderDisable'),
      checkbox('Disable Windows Update', state, 'enableUpdatesDisable'),
      checkbox('Disable Windows Firewall', state, 'enableFirewallDisable'),
      checkbox('Trim background bloat services/tasks', state, 'enableBloatDisable'),
      checkbox('Optimize for performance (visual effects, power plan, hibernation, background apps)', state, 'enablePerformanceMode'),
      h('div', { class: 'sub' }, 'All five stay toggleable live later too, from the Dashboard - this just sets the starting state. Note: if Defender Tamper Protection ends up on inside Windows, it has to be switched off by hand before Defender can be scripted off.')
    ]),
    h('div', { class: 'card', id: 'wizard-progress-card' }, [
      h('h2', {}, 'Create'),
      h('div', { class: 'sub' }, 'The VM boots with no window shown - just watch progress here. Windows ISO / VirtIO ISO download (if needed), silent install, and first-boot setup all happen automatically; it reaches 100% once Windows is installed and the guest agent responds.'),
      h('div', { id: 'progress-area' }),
      h('button', {
        class: 'btn primary',
        id: 'create-btn',
        onclick: () => startCreate(state)
      }, 'Create VM')
    ])
  ]);
  root.appendChild(page);
}

function renderMediaCard(state) {
  const card = h('div', { class: 'card' }, [
    h('h2', {}, 'Install media'),
    h('div', { class: 'sub' }, "By default nothing to pick: the Windows ISO is fetched straight from Microsoft's own download servers for the edition you chose above, and the VirtIO drivers ISO from the official Fedora mirror - both cached after the first VM, so later VMs don't re-download. Expand Advanced only if you already have specific ISO files you want to use instead.")
  ]);

  const advancedBody = h('div', { style: 'display:none; margin-top:12px' });
  const advBtn = h('button', {
    class: 'btn small',
    onclick: () => {
      const showing = advancedBody.style.display !== 'none';
      advancedBody.style.display = showing ? 'none' : 'block';
      advBtn.textContent = showing ? 'Advanced: use my own ISO files' : 'Hide advanced options';
    }
  }, 'Advanced: use my own ISO files');

  const winIso = isoField('Windows installer ISO (overrides auto-download)', state, 'windowsIsoPath');
  const virtioIso = isoField('VirtIO drivers ISO (overrides auto-download)', state, 'virtioIsoPath');
  advancedBody.appendChild(winIso);
  advancedBody.appendChild(virtioIso);

  card.appendChild(advBtn);
  card.appendChild(advancedBody);
  return card;
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
  if (!state.name) return toast('Set a VM name.', true);
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
  await pollDashboard();
  go('dashboard');
}

/* ------------------------------ CONFIG ------------------------------ */

async function renderConfig(root) {
  const page = h('div', { class: 'page' }, [
    h('h1', {}, 'winapps.conf'),
    h('div', { class: 'sub' }, '~/.config/winapps/winapps.conf - every field below maps 1:1 to a key in that file. Saving only rewrites the values you changed; all comments and layout stay intact.')
  ]);
  const formHolder = h('div');
  page.appendChild(formHolder);
  root.appendChild(page);
  await paintConfigForm(formHolder);
}

async function paintConfigForm(formHolder) {
  formHolder.innerHTML = 'Loading...';
  const { values, comments } = await window.api.config.get();
  formHolder.innerHTML = '';
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

  const btnRow = h('div', { class: 'row' });
  btnRow.appendChild(h('button', {
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
  }, 'Save changes'));
  btnRow.appendChild(h('button', { class: 'btn small', onclick: () => paintConfigForm(formHolder) }, 'Reload from disk'));
  form.appendChild(btnRow);

  formHolder.appendChild(form);
}

/* ------------------------------- APPS ------------------------------- */

async function renderApps(root) {
  const page = h('div', { class: 'page' }, [
    h('h1', {}, 'Apps'),
    h('div', { class: 'sub' }, "A winboat-style icon grid, backed by WinApps' own detection under the hood (installer.sh --user) - registry scan, matching, icons and MIME types are all WinApps' real, tested logic. Nothing here is reinvented; this screen just gives it a proper UI instead of a terminal dialog.")
  ]);

  const installedCard = h('div', { class: 'card' }, [h('h2', {}, 'WinApps installation')]);
  const installed = await window.api.winapps.isInstalled();
  installedCard.appendChild(h('div', { class: 'row' }, [
    h('span', { class: 'badge ' + (installed ? 'ok' : 'warn') }, installed ? 'WinApps CLI found' : 'WinApps not installed yet'),
    installed
      ? h('button', { class: 'btn', onclick: () => window.api.winapps.check().then(() => toast('Ran winapps check - see log for output.')) }, 'Run connectivity check')
      : h('button', { class: 'btn primary', onclick: () => window.api.winapps.launchInstaller().catch((e) => toast(e.message, true)) }, 'Install WinApps now')
  ]));
  page.appendChild(installedCard);

  const detectCard = h('div', { class: 'card' }, [
    h('h2', {}, 'Detect apps'),
    h('div', { class: 'sub' }, 'Runs the real WinApps scan against the VM (a brief hidden RDP session that inventories installed programs) and refreshes the grid below. Safe to re-run any time after installing new Windows software - fully offline.')
  ]);
  const scopeSelect = h('select', { style: 'max-width:220px;display:inline-block;margin-right:8px' }, [
    h('option', { value: 'user' }, 'Current user only'),
    h('option', { value: 'system' }, 'Whole system')
  ]);
  const detectLog = h('div', { class: 'sub', style: 'margin-top:10px; font-family:monospace; max-height:120px; overflow-y:auto' });
  const detectBtn = h('button', {
    class: 'btn primary',
    onclick: async (ev) => {
      ev.target.disabled = true;
      detectLog.textContent = '';
      const unsub = window.api.winappsApps.onDetectionLine((line) => {
        detectLog.textContent += line + '\n';
        detectLog.scrollTop = detectLog.scrollHeight;
      });
      try {
        const res = await window.api.winappsApps.runDetection(scopeSelect.value);
        unsub();
        if (!res.ok) throw new Error(res.error);
        toast('App detection finished.');
        await refreshAppGrid();
      } catch (e) {
        unsub();
        toast(e.message, true);
      } finally {
        ev.target.disabled = false;
      }
    }
  }, 'Detect apps now');
  detectCard.appendChild(h('div', { class: 'row' }, [scopeSelect, detectBtn]));
  detectCard.appendChild(detectLog);
  page.appendChild(detectCard);

  const manualCard = h('div', { class: 'card' }, [
    h('h2', {}, 'Add an app manually'),
    h('div', { class: 'sub' }, "For an app that isn't in WinApps' community-tested list yet. Give the full in-guest path to its .exe (per the WinApps README's \"manual\" mode).")
  ]);
  const manualPathInput = h('input', { type: 'text', placeholder: 'C:\\Program Files\\Some App\\app.exe', style: 'max-width:420px;display:inline-block;margin-right:8px' });
  manualCard.appendChild(h('div', { class: 'row' }, [
    manualPathInput,
    h('button', {
      class: 'btn',
      onclick: async (ev) => {
        if (!manualPathInput.value.trim()) return;
        ev.target.disabled = true;
        try {
          await window.api.winappsApps.addManual(manualPathInput.value.trim());
          toast('App added.');
          manualPathInput.value = '';
          await refreshAppGrid();
        } catch (e) {
          toast(e.message, true);
        } finally {
          ev.target.disabled = false;
        }
      }
    }, 'Add')
  ]));
  page.appendChild(manualCard);

  const gridCard = h('div', { class: 'card' }, [
    h('div', { class: 'row', style: 'justify-content:space-between; margin-bottom:12px' }, [
      h('h2', { style: 'margin:0' }, 'Detected apps'),
      h('button', { class: 'btn small', onclick: () => refreshAppGrid() }, 'Refresh')
    ]),
    h('div', { id: 'app-grid', class: 'app-grid' }, [h('div', { class: 'sub' }, 'Loading...')])
  ]);
  page.appendChild(gridCard);

  const previewCard = h('div', { class: 'card' }, [
    h('h2', {}, 'Raw installed-programs list (read-only)'),
    h('div', { class: 'sub' }, "Queries the uninstall registry over the QEMU Guest Agent directly, in case you want to see everything on the VM regardless of whether WinApps has matched it yet.")
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

  root.appendChild(page);
  await refreshAppGrid();
}

async function refreshAppGrid() {
  const grid = document.getElementById('app-grid');
  if (!grid) return;
  grid.innerHTML = '';
  let apps = [];
  try {
    apps = await window.api.winappsApps.list();
  } catch (e) {
    grid.appendChild(h('div', { class: 'sub' }, 'Could not read app list: ' + e.message));
    return;
  }
  if (!apps.length) {
    grid.appendChild(h('div', { class: 'sub' }, 'No apps detected yet - click "Detect apps now" above.'));
    return;
  }
  for (const app of apps) {
    grid.appendChild(appTile(app));
  }
}

function appTile(app) {
  const iconEl = app.iconDataUri
    ? h('img', { src: app.iconDataUri, class: 'app-icon' })
    : h('div', { class: 'app-icon app-icon-fallback' }, app.name.slice(0, 1).toUpperCase());

  const toggle = h('input', { type: 'checkbox' });
  toggle.checked = !!app.enabled;
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      await window.api.winappsApps.setEnabled(app.id, toggle.checked);
    } catch (e) {
      toast(e.message, true);
      toggle.checked = !toggle.checked;
    } finally {
      toggle.disabled = false;
    }
  });

  return h('div', { class: 'app-tile' }, [
    iconEl,
    h('div', { class: 'app-tile-name' }, app.name),
    h('label', { class: 'app-tile-toggle' }, [toggle, ' shown in launcher'])
  ]);
}

/* ------------------------------ DOCTOR ------------------------------ */

async function renderDoctor(root) {
  const page = h('div', { class: 'page' }, [
    h('h1', {}, 'Setup Check'),
    h('div', { class: 'sub' }, 'Everything docs/libvirt.md lists as a prerequisite, checked automatically.')
  ]);
  const hostCard = h('div', { class: 'card' }, [h('div', { class: 'sub' }, 'Checking...')]);
  page.appendChild(hostCard);

  const netCard = h('div', { class: 'card' }, [
    h('h2', {}, 'Passwordless network toggle'),
    h('div', { class: 'sub' }, 'Isolating/reconnecting a VM\u2019s network (the "Disconnect network" button on the Dashboard) runs iptables, which normally needs sudo every time. Enabling this installs a narrowly-scoped sudoers rule - limited to exactly this app\u2019s bundled script, on this VM\u2019s subnet only - so it works instantly with no password prompt from then on. One graphical authorization now, never again after.'),
    h('div', { id: 'net-passwordless-status', class: 'sub' }, 'Checking...')
  ]);
  page.appendChild(netCard);

  root.appendChild(page);

  paintHostChecks(hostCard);
  paintPasswordlessStatus(netCard);
}

async function paintHostChecks(hostCard) {
  hostCard.innerHTML = '';
  hostCard.appendChild(h('div', { class: 'sub' }, 'Checking...'));
  const { allOk, results } = await window.api.host.check();
  hostCard.innerHTML = '';
  hostCard.appendChild(h('div', { class: 'row', style: 'margin-bottom:12px; justify-content:space-between' }, [
    h('span', { class: 'badge ' + (allOk ? 'ok' : 'bad') }, allOk ? 'All checks passed' : 'Some checks need attention'),
    h('button', { class: 'btn small', onclick: () => paintHostChecks(hostCard) }, 'Re-check')
  ]));
  const list = h('div', { class: 'check-list' });
  results.forEach((r) => {
    list.appendChild(h('div', { class: 'check-item' }, [
      h('div', {}, [h('div', { class: 'label' }, r.label), h('div', { class: 'detail' }, r.detail || '')]),
      h('span', { class: 'badge ' + (r.ok ? 'ok' : 'bad') }, r.ok ? 'OK' : 'Fix needed')
    ]));
  });
  hostCard.appendChild(list);
}

async function paintPasswordlessStatus(netCard) {
  const statusEl = netCard.querySelector('#net-passwordless-status');
  statusEl.textContent = 'Checking...';
  let installed = false;
  try {
    installed = await window.api.net.passwordlessStatus('default');
  } catch (_) { /* treat as not installed */ }
  statusEl.innerHTML = '';
  statusEl.appendChild(h('div', { class: 'row' }, [
    h('span', { class: 'badge ' + (installed ? 'ok' : 'warn') }, installed ? 'Passwordless toggle active' : 'Not set up yet'),
    !installed
      ? h('button', {
          class: 'btn primary small',
          onclick: async (ev) => {
            ev.target.disabled = true;
            try {
              await window.api.net.installPasswordless('default');
              toast('Passwordless network toggle enabled.');
              await paintPasswordlessStatus(netCard);
            } catch (e) {
              toast(e.message, true);
            } finally {
              ev.target.disabled = false;
            }
          }
        }, 'Enable')
      : h('button', { class: 'btn small', onclick: () => paintPasswordlessStatus(netCard) }, 'Re-check')
  ]));
}

go('dashboard');
