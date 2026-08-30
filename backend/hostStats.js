'use strict';
const fs = require('fs');
const { run } = require('./exec');

// /proc/stat gives cumulative jiffies since boot, so CPU% needs a delta
// between two samples - same technique vmStats.js uses for the guest.
let prevCpuSample = null;
let gpuKind = undefined; // undefined = not probed yet, null = none found

function readProcStatTotals() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0]; // "cpu  user nice system idle iowait irq softirq steal"
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function getHostCpuPercent() {
  const sample = readProcStatTotals();
  if (!prevCpuSample) {
    prevCpuSample = sample;
    return null;
  }
  const deltaTotal = sample.total - prevCpuSample.total;
  const deltaIdle = sample.idle - prevCpuSample.idle;
  prevCpuSample = sample;
  if (deltaTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - deltaIdle / deltaTotal) * 100)));
}

function getHostMemory() {
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  const kv = {};
  text.split('\n').forEach((l) => {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]] = Number(m[2]); // KiB
  });
  const totalKiB = kv.MemTotal || 0;
  const availableKiB = kv.MemAvailable != null ? kv.MemAvailable : kv.MemFree || 0;
  const usedKiB = Math.max(0, totalKiB - availableKiB);
  return {
    totalMiB: Math.round(totalKiB / 1024),
    usedMiB: Math.round(usedKiB / 1024),
    percent: totalKiB ? Math.round((usedKiB / totalKiB) * 100) : null
  };
}

/** Tries nvidia-smi first, then a generic DRM busy-percent sysfs file (works for AMD/Intel on recent kernels). */
async function getHostGpu() {
  if (gpuKind === undefined) gpuKind = await detectGpuKind();
  if (gpuKind === 'nvidia') {
    try {
      const { stdout } = await run('nvidia-smi', [
        '--query-gpu=utilization.gpu,memory.used,memory.total',
        '--format=csv,noheader,nounits'
      ], { allowFail: true });
      const [util, used, total] = stdout.trim().split(',').map((s) => Number(s.trim()));
      if (Number.isFinite(util)) return { percent: util, usedMiB: used || null, totalMiB: total || null, source: 'nvidia-smi' };
    } catch (_) { /* fall through */ }
    return null;
  }
  if (gpuKind && gpuKind.startsWith('sysfs:')) {
    try {
      const p = gpuKind.slice('sysfs:'.length);
      const percent = Number(fs.readFileSync(p, 'utf8').trim());
      if (Number.isFinite(percent)) return { percent, usedMiB: null, totalMiB: null, source: 'sysfs' };
    } catch (_) { /* fall through */ }
    return null;
  }
  return null;
}

async function detectGpuKind() {
  try {
    const r = await run('nvidia-smi', ['-L'], { allowFail: true });
    if (r.code === 0 && r.stdout.trim()) return 'nvidia';
  } catch (_) { /* nvidia-smi not present */ }
  for (let i = 0; i < 4; i++) {
    const p = `/sys/class/drm/card${i}/device/gpu_busy_percent`;
    if (fs.existsSync(p)) return `sysfs:${p}`;
  }
  return null;
}

async function getHostStats() {
  const [gpu] = await Promise.all([getHostGpu()]);
  return {
    cpuPercent: getHostCpuPercent(),
    memory: getHostMemory(),
    gpu
  };
}

module.exports = { getHostStats };
