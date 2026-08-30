'use strict';
const { run } = require('./exec');

// Track previous CPU-time samples per VM so we can compute a % from two
// cumulative-nanoseconds readings (same delta-over-wallclock calc as before).
const prevCpuSamples = new Map();

// `virsh domstats` returns state + cpu + memory + net + block for one call
// (or, with no domain argument, for every domain on the host) in a single
// libvirtd round-trip. That matters here specifically because qemu:///system
// is polkit-gated: every separate `virsh <cmd>` process opens a brand-new
// connection, and every new connection makes polkitd re-run its
// authorization rules. The old version of this file made 7 separate virsh
// calls per VM per poll (domstate, dommemstat, cpu-stats, domiflist,
// domifstat, domblklist, domblkinfo) - each one its own polkit check, on a
// 5s timer, for as long as the app was open. That's what was driving
// polkitd's CPU: not a leak, just a lot of avoidable round-trips. Folding
// them into one domstats call (and, in vmctl.js, one domstats call for every
// VM at once) removes essentially all of that.
const DOMSTATS_FLAGS = ['--state', '--cpu-total', '--balloon', '--interface', '--block'];

/**
 * Splits `virsh domstats` output into one flat Map<string,string> of dotted
 * keys per domain name, e.g. domains.get('MyVM').get('cpu.time').
 */
function parseDomstats(text) {
  const domains = new Map();
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const domainMatch = line.match(/^Domain:\s*'([^']*)'/);
    if (domainMatch) {
      current = new Map();
      domains.set(domainMatch[1], current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    current.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return domains;
}

// Mirrors libvirt's own virshDomainStateToString table (tools/virsh-domain-monitor.c)
// so these strings line up exactly with what `virsh domstate`/`virsh list` print -
// the rest of the app (e.g. vmctl.js's "must be shut off" check) compares against
// those exact strings.
const STATE_NAMES = ['no state', 'running', 'idle', 'paused', 'in shutdown', 'shut off', 'crashed', 'pmsuspended'];

function stateName(fields) {
  const n = Number(fields.get('state.state'));
  return STATE_NAMES[n] || 'unknown';
}

async function domstatsCall(extraArgs = []) {
  const { stdout } = await run('virsh', ['domstats', ...DOMSTATS_FLAGS, ...extraArgs], { allowFail: true, timeoutMs: 10000 });
  return parseDomstats(stdout);
}

/**
 * One virsh call for every domain on the host (running and shut off alike -
 * `domstats` with no domain argument and no --list-* filter covers both).
 * Used by vmctl.listVms() so the dashboard's background poll costs exactly
 * one virsh spawn regardless of how many VMs exist.
 */
async function listVmStates() {
  const domains = await domstatsCall();
  return Array.from(domains.entries()).map(([name, fields]) => ({ name, state: stateName(fields) }));
}

async function getVmStats(name) {
  const domains = await domstatsCall([name]);
  const fields = domains.get(name) || new Map();
  return {
    name,
    state: stateName(fields),
    memory: parseBalloon(fields),
    cpuPercent: computeCpuPercent(name, fields),
    network: parseNetwork(fields),
    disk: parseBlock(fields)
  };
}

function num(fields, key) {
  const v = fields.get(key);
  return v === undefined ? 0 : Number(v);
}

function parseBalloon(fields) {
  const availableKiB = num(fields, 'balloon.available');
  const unusedKiB = num(fields, 'balloon.unused');
  return {
    actualKiB: num(fields, 'balloon.current'),
    availableKiB,
    unusedKiB,
    usedKiB: availableKiB ? availableKiB - unusedKiB : 0,
    rssKiB: num(fields, 'balloon.rss')
  };
}

function computeCpuPercent(name, fields) {
  const raw = fields.get('cpu.time');
  if (raw === undefined) return null;
  const cpuTimeSeconds = Number(raw) / 1e9; // cpu.time is reported in nanoseconds
  const now = Date.now();
  const prev = prevCpuSamples.get(name);
  prevCpuSamples.set(name, { cpuTimeSeconds, now });
  if (!prev) return null;
  const deltaCpu = cpuTimeSeconds - prev.cpuTimeSeconds;
  const deltaWall = (now - prev.now) / 1000;
  if (deltaWall <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((deltaCpu / deltaWall) * 100)));
}

function parseNetwork(fields) {
  if (!fields.has('net.0.name')) return null;
  return {
    iface: fields.get('net.0.name'),
    rxBytes: num(fields, 'net.0.rx.bytes'),
    txBytes: num(fields, 'net.0.tx.bytes')
  };
}

function parseBlock(fields) {
  if (!fields.has('block.0.name')) return null;
  return {
    target: fields.get('block.0.name'),
    path: fields.get('block.0.path') || null,
    virtualSizeBytes: num(fields, 'block.0.capacity'),
    actualSizeBytes: num(fields, 'block.0.allocation')
  };
}

module.exports = { getVmStats, listVmStates };
