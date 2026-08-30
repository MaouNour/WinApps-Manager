'use strict';
const { run } = require('./exec');

// Track previous CPU-time samples per VM so we can compute a % from the
// two cumulative-nanoseconds readings virsh gives us (virsh has no direct
// "cpu percent" output, so this is the standard delta-over-wallclock calc).
const prevCpuSamples = new Map();

async function getVmStats(name) {
  const [state, memstat, vcpuInfo, ifaceStat, blockInfo] = await Promise.all([
    run('virsh', ['domstate', name], { allowFail: true }),
    run('virsh', ['dommemstat', name], { allowFail: true }),
    run('virsh', ['cpu-stats', name, '--total'], { allowFail: true }),
    getFirstInterfaceStats(name),
    getFirstBlockStats(name)
  ]);

  const stats = {
    name,
    state: state.stdout.trim(),
    memory: parseMemStat(memstat.stdout),
    cpuPercent: computeCpuPercent(name, vcpuInfo.stdout),
    network: ifaceStat,
    disk: blockInfo
  };
  return stats;
}

function parseMemStat(out) {
  const lines = out.split('\n');
  const m = {};
  for (const l of lines) {
    const [k, v] = l.trim().split(/\s+/);
    if (k && v) m[k] = Number(v); // KiB
  }
  return {
    actualKiB: m.actual || 0,
    availableKiB: m.available || 0,
    unusedKiB: m.unused || 0,
    usedKiB: m.available ? m.available - (m.unused || 0) : 0,
    rssKiB: m.rss || 0
  };
}

function computeCpuPercent(name, out) {
  const m = out.match(/cpu_time\s+([\d.]+)\s+seconds/);
  if (!m) return null;
  const cpuTimeSeconds = parseFloat(m[1]);
  const now = Date.now();
  const prev = prevCpuSamples.get(name);
  prevCpuSamples.set(name, { cpuTimeSeconds, now });
  if (!prev) return null;
  const deltaCpu = cpuTimeSeconds - prev.cpuTimeSeconds;
  const deltaWall = (now - prev.now) / 1000;
  if (deltaWall <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((deltaCpu / deltaWall) * 100)));
}

async function getFirstInterfaceStats(name) {
  try {
    const { stdout: xml } = await run('virsh', ['domiflist', name], { allowFail: true });
    const line = xml.split('\n').find((l) => /vnet|tap/.test(l));
    if (!line) return null;
    const iface = line.trim().split(/\s+/)[0];
    const { stdout } = await run('virsh', ['domifstat', name, iface], { allowFail: true });
    const rx = /rx_bytes\s+(\d+)/.exec(stdout);
    const tx = /tx_bytes\s+(\d+)/.exec(stdout);
    return { iface, rxBytes: rx ? Number(rx[1]) : 0, txBytes: tx ? Number(tx[1]) : 0 };
  } catch (_) {
    return null;
  }
}

async function getFirstBlockStats(name) {
  try {
    const { stdout: xml } = await run('virsh', ['domblklist', name], { allowFail: true, timeoutMs: 5000 });
    const line = xml.split('\n').find((l) => /vda/.test(l));
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const target = parts[0];
    const sourcePath = parts[1];
    // domblkinfo goes through libvirtd (which runs as root and already has
    // the disk open), so it works even when the image file itself isn't
    // readable by the user's own account - unlike shelling out to
    // `qemu-img info` directly on the path, which silently failed for
    // exactly that reason and is why Disk always showed 0.0/0.0 GB.
    const { stdout: info } = await run('virsh', ['domblkinfo', name, target], { allowFail: true, timeoutMs: 5000 });
    const capacity = Number((info.match(/^Capacity:\s*(\d+)/m) || [])[1] || 0);
    const allocation = Number((info.match(/^Allocation:\s*(\d+)/m) || [])[1] || 0);
    return { target, path: sourcePath, virtualSizeBytes: capacity, actualSizeBytes: allocation };
  } catch (_) {
    return null;
  }
}

module.exports = { getVmStats };
