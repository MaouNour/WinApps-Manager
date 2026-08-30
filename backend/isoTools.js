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

module.exports = { buildIso };
