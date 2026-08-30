'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { APP_CATALOG_DIR, APP_CATALOG_MANIFEST } = require('./paths');

const API_APPS_URL = 'https://api.github.com/repos/winapps-org/winapps/contents/apps';
const RAW_BASE = 'https://raw.githubusercontent.com/winapps-org/winapps/main/';
const ICON_EXTENSIONS = ['svg', 'ico', 'png'];

// The one entry that isn't under apps/ - "Windows (Full RDP Session)" ships
// as install/windows.svg and is always available regardless of what's
// detected inside the guest, per the README's Community Tested Applications
// table.
const WINDOWS_RDP_ENTRY = {
  slug: 'windows',
  name: 'Windows',
  fullName: 'Windows (Full RDP Session)',
  categories: 'System',
  mimeTypes: '',
  iconRawPath: 'install/windows.svg'
};

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'winapps-manager', Accept: 'application/vnd.github+json' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpGetJson(res.headers.location));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'winapps-manager' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpGetBuffer(res.headers.location));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

/** Parses the bash-style `apps/<slug>/info` file (NAME="...", FULL_NAME="...", etc.) without sourcing it. */
function parseInfoFile(text) {
  const out = {};
  const re = /^([A-Z_][A-Z0-9_]*)=["']?([^"'\n]*)["']?\s*$/gm;
  let m;
  while ((m = re.exec(text))) {
    out[m[1]] = m[2];
  }
  return out;
}

function isCatalogCached() {
  return fs.existsSync(APP_CATALOG_MANIFEST);
}

function readManifest() {
  if (!fs.existsSync(APP_CATALOG_MANIFEST)) return null;
  try {
    return JSON.parse(fs.readFileSync(APP_CATALOG_MANIFEST, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Returns the cached catalog (array of {slug,name,fullName,categories,mimeTypes,iconPath}), or null if never synced. Never touches the network. */
function getCatalog() {
  const manifest = readManifest();
  if (!manifest) return null;
  return manifest.apps;
}

/**
 * One-time (or explicit re-run) network sync: lists apps/ in the WinApps
 * repo, downloads each app's info file + icon, caches them locally, and
 * writes a manifest the rest of the app reads offline forever after.
 * Idempotent: apps already cached are skipped unless force=true.
 */
async function syncCatalog(onLine = () => {}, force = false) {
  fs.mkdirSync(APP_CATALOG_DIR, { recursive: true });
  const existing = force ? null : readManifest();
  const cachedSlugs = new Set((existing?.apps || []).map((a) => a.slug));

  onLine('Fetching app list from winapps-org/winapps...');
  const listing = await httpGetJson(API_APPS_URL);
  const dirs = listing.filter((e) => e.type === 'dir');

  const apps = force ? [] : existing?.apps ? [...existing.apps] : [];

  for (const dir of dirs) {
    const slug = dir.name;
    if (slug === 'ms-office-protocol-handler') continue; // internal, not a user-pickable app
    if (cachedSlugs.has(slug)) continue;

    onLine(`Caching ${slug}...`);
    const appDir = path.join(APP_CATALOG_DIR, slug);
    fs.mkdirSync(appDir, { recursive: true });

    let info = {};
    try {
      const infoBuf = await httpGetBuffer(RAW_BASE + `apps/${slug}/info`);
      info = parseInfoFile(infoBuf.toString('utf8'));
      fs.writeFileSync(path.join(appDir, 'info'), infoBuf);
    } catch (e) {
      onLine(`  (no info file for ${slug}, using folder name)`);
    }

    let iconExt = null;
    for (const ext of ICON_EXTENSIONS) {
      try {
        const buf = await httpGetBuffer(RAW_BASE + `apps/${slug}/icon.${ext}`);
        fs.writeFileSync(path.join(appDir, `icon.${ext}`), buf);
        iconExt = ext;
        break;
      } catch (_) {
        /* try next extension */
      }
    }

    apps.push({
      slug,
      name: info.NAME || slug,
      fullName: info.FULL_NAME || info.NAME || slug,
      categories: info.CATEGORIES || '',
      mimeTypes: info.MIME_TYPES || '',
      iconPath: iconExt ? path.join(appDir, `icon.${iconExt}`) : null
    });
  }

  // Always ensure the "Windows (Full RDP Session)" tile is present.
  if (!apps.some((a) => a.slug === 'windows')) {
    const appDir = path.join(APP_CATALOG_DIR, 'windows');
    fs.mkdirSync(appDir, { recursive: true });
    let iconPath = null;
    try {
      const buf = await httpGetBuffer(RAW_BASE + WINDOWS_RDP_ENTRY.iconRawPath);
      iconPath = path.join(appDir, 'icon.svg');
      fs.writeFileSync(iconPath, buf);
    } catch (_) {}
    apps.push({
      slug: WINDOWS_RDP_ENTRY.slug,
      name: WINDOWS_RDP_ENTRY.name,
      fullName: WINDOWS_RDP_ENTRY.fullName,
      categories: WINDOWS_RDP_ENTRY.categories,
      mimeTypes: WINDOWS_RDP_ENTRY.mimeTypes,
      iconPath
    });
  }

  apps.sort((a, b) => a.fullName.localeCompare(b.fullName));
  fs.writeFileSync(APP_CATALOG_MANIFEST, JSON.stringify({ syncedAt: new Date().toISOString(), apps }, null, 2));
  onLine(`Catalog ready: ${apps.length} apps cached offline.`);
  return apps;
}

module.exports = { getCatalog, syncCatalog, isCatalogCached, readManifest };
