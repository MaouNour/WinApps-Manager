'use strict';
const fs = require('fs');
const path = require('path');
const { which } = require('./exec');
const { DESKTOP_ENTRIES_DIR, WINAPPS_BIN_DIR } = require('./paths');

/**
 * Resolves the real `winapps` CLI binary, exactly as WinApps' own installer
 * would reference it in a generated wrapper script's `${BIN_PATH}/winapps`.
 * Falls back to the standard user-mode install location if not on PATH yet
 * (e.g. WinApps installed but shell hasn't picked up ~/.local/bin).
 */
async function resolveWinappsBin() {
  const onPath = await which('winapps');
  if (onPath) return onPath;
  const userLocal = path.join(WINAPPS_BIN_DIR, 'winapps');
  if (fs.existsSync(userLocal)) return userLocal;
  return path.join(WINAPPS_BIN_DIR, 'winapps'); // best-effort default even if not installed yet
}

function desktopFilePath(slug) {
  return path.join(DESKTOP_ENTRIES_DIR, `${slug}.desktop`);
}
function wrapperScriptPath(slug) {
  return path.join(WINAPPS_BIN_DIR, slug);
}

/** True if this app currently has a launcher (icon+checkbox reflects this). */
function isAppEnabled(slug) {
  return fs.existsSync(desktopFilePath(slug));
}

/** Returns the set of catalog slugs that currently have a launcher enabled. */
function listEnabledSlugs(catalog) {
  const enabled = new Set();
  for (const app of catalog) {
    if (isAppEnabled(app.slug)) enabled.add(app.slug);
  }
  return enabled;
}

function desktopEntryContents({ slug, fullName, categories, mimeTypes, iconPath, binPath }) {
  const lines = [
    '[Desktop Entry]',
    `Name=${fullName}`,
    `Exec=${binPath} ${slug} %F`,
    'Terminal=false',
    'Type=Application',
    iconPath ? `Icon=${iconPath}` : null,
    `StartupWMClass=${fullName}`,
    `Comment=${fullName}`,
    categories ? `Categories=${categories};` : null,
    mimeTypes ? `MimeType=${mimeTypes}` : null
  ].filter(Boolean);
  return lines.join('\n') + '\n';
}

/**
 * Enables one app: writes `~/.local/share/applications/<slug>.desktop` and
 * an executable `~/.local/bin/<slug>` wrapper that calls `winapps <slug>`.
 * This is exactly what WinApps' own installer (waConfigureApp) does when
 * you tick a box in its terminal wizard - we just do it directly, from a
 * checkbox in the UI, no terminal and no network involved.
 */
async function enableApp(app) {
  const binPath = await resolveWinappsBin();
  fs.mkdirSync(DESKTOP_ENTRIES_DIR, { recursive: true });
  fs.mkdirSync(WINAPPS_BIN_DIR, { recursive: true });

  fs.writeFileSync(desktopFilePath(app.slug), desktopEntryContents({ ...app, binPath }));

  const wrapper = `#!/usr/bin/env bash\n${binPath} ${app.slug} "$@"\n`;
  const wp = wrapperScriptPath(app.slug);
  fs.writeFileSync(wp, wrapper);
  fs.chmodSync(wp, 0o755);

  return { slug: app.slug, enabled: true };
}

/** Disables one app: removes its .desktop entry and wrapper script. */
function disableApp(slug) {
  const df = desktopFilePath(slug);
  const wp = wrapperScriptPath(slug);
  if (fs.existsSync(df)) fs.rmSync(df);
  if (fs.existsSync(wp)) fs.rmSync(wp);
  return { slug, enabled: false };
}

async function setAppEnabled(app, enabled) {
  return enabled ? enableApp(app) : disableApp(app.slug);
}

/**
 * Cross-references the (offline, guest-agent-scanned) list of programs
 * actually installed in Windows against the app catalog, so the picker can
 * show a "detected in Windows" badge - purely informational, doesn't
 * restrict which boxes can be checked (matches winboat's approach of
 * always letting you pick, since detection is best-effort name matching).
 *
 * Two bugs fixed here (this used to always report 0 matches for a lot of
 * real installs):
 *  - Only `app.name` (WinApps' short "GNOME shortcut name", e.g. "Access")
 *    was checked. `app.fullName` (e.g. "Microsoft Access") is often the one
 *    that actually resembles the registry DisplayName - now both are tried.
 *  - A catalog/installed entry with a very short or empty normalized name
 *    (e.g. a stray registry entry with no real DisplayName) made
 *    `needle.includes(hay)` trivially true for every other app, since an
 *    empty/1-2 char string is a substring of almost anything. Both sides
 *    now require at least 3 normalized characters before they're eligible
 *    to match at all.
 */
function detectCatalogMatches(catalog, installedPrograms) {
  const normalizedInstalled = installedPrograms
    .map((p) => normalize(p.name))
    .filter((hay) => hay.length >= 3);
  const matched = new Set();
  for (const app of catalog) {
    const needles = [normalize(app.name), normalize(app.fullName)].filter((n) => n.length >= 3);
    if (!needles.length) continue;
    const isMatch = normalizedInstalled.some((hay) => needles.some((needle) => hay.includes(needle) || needle.includes(hay)));
    if (isMatch) matched.add(app.slug);
  }
  return matched;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

module.exports = { isAppEnabled, listEnabledSlugs, enableApp, disableApp, setAppEnabled, detectCatalogMatches };
