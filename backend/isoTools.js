'use strict';
const { run, which } = require('./exec');

/** Build isoPath from every file/dir directly inside srcDir, volume label `label`. */
async function buildIso(srcDir, isoPath, label = 'SEED') {
  const genisoimage = (await which('genisoimage')) || (await which('mkisofs'));
  if (genisoimage) {
    await run(genisoimage, ['-o', isoPath, '-V', label, '-J', '-r', srcDir]);
    return;
  }
  const xorriso = await which('xorriso');
  if (xorriso) {
    await run(xorriso, ['-as', 'genisoimage', '-o', isoPath, '-V', label, '-J', '-r', srcDir]);
    return;
  }
  throw new Error('No ISO authoring tool found (install genisoimage, cdrtools, or xorriso).');
}

/**
 * Copies srcIso to destIso with one extra file added at its root, preserving
 * the original's boot images (both legacy BIOS El Torito and UEFI El
 * Torito/ESP) exactly as-is via xorriso's "-boot_image any replay" mode -
 * the standard, well-documented trick for adding a file to an existing
 * bootable Windows ISO without breaking its bootability.
 *
 * Used to put autounattend.xml directly at the root of the Windows install
 * media itself (rather than only on a separate seed CD): that's the very
 * first place Windows Setup checks ("root directory of the installation
 * source"), so it sidesteps entirely any question of whether a *second*
 * attached CD-ROM gets scanned. Throws if xorriso isn't installed - callers
 * should treat that as "skip this, the separate seed CD is still there as
 * the fallback" rather than a hard failure.
 */
async function injectFileIntoIso(srcIso, destIso, rootFileName, rootFileContents) {
  const xorriso = await which('xorriso');
  if (!xorriso) {
    throw new Error('xorriso not found - install it for the most reliable unattended-install detection (falls back to a separate seed CD otherwise).');
  }
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpFile = path.join(os.tmpdir(), `winapps-manager-${Date.now()}-${rootFileName}`);
  fs.writeFileSync(tmpFile, rootFileContents);
  try {
    await run(xorriso, [
      '-indev', srcIso,
      '-outdev', destIso,
      '-map', tmpFile, `/${rootFileName}`,
      '-boot_image', 'any', 'replay'
    ]);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

module.exports = { buildIso, injectFileIntoIso };
