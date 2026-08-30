'use strict';
const fs = require('fs');
const { WINAPPS_CONF_FILE, WINAPPS_CONF_DIR } = require('./paths');

// Verbatim default template (this is the exact file layout WinApps ships /
// the user already has), used only the first time no config file exists yet.
const DEFAULT_TEMPLATE = `##################################
#   WINAPPS CONFIGURATION FILE   #
##################################

# INSTRUCTIONS
# - Leading and trailing whitespace are ignored.
# - Empty lines are ignored.
# - Lines starting with '#' are ignored.
# - All characters following a '#' are ignored.

# [WINDOWS USERNAME]
RDP_USER="MyWindowsUser"

# [WINDOWS PASSWORD]
RDP_PASS="MyWindowsPassword"
RDP_ASKPASS=""

# [WINDOWS DOMAIN]
RDP_DOMAIN=""

# [WINDOWS IPV4 ADDRESS]
RDP_IP=""

# [RDP PORT]
RDP_PORT="3389"

# [VM NAME]
VM_NAME="RDPWindows"

# [WINAPPS BACKEND]
WAFLAVOR="libvirt"

# [DISPLAY SCALING FACTOR]
RDP_SCALE="100"

# [MOUNTING REMOVABLE PATHS FOR FILES]
REMOVABLE_MEDIA="/run/media"

# [ADDITIONAL FREERDP FLAGS & ARGUMENTS]
RDP_FLAGS="/cert:tofu /sound +home-drive"

# [NON FULL WINDOWS RDP FLAGS]
RDP_FLAGS_NON_WINDOWS=""

# [FULL WINDOWS RDP FLAGS]
RDP_FLAGS_WINDOWS=""

# [DEBUG WINAPPS]
DEBUG="true"

# [AUTOMATICALLY PAUSE WINDOWS]
AUTOPAUSE="off"

# [AUTOMATICALLY PAUSE WINDOWS TIMEOUT]
AUTOPAUSE_TIME="300"

# [FREERDP COMMAND]
FREERDP_COMMAND=""

# [TIMEOUTS]
PORT_TIMEOUT="5"
RDP_TIMEOUT="30"
APP_SCAN_TIMEOUT="60"
BOOT_TIMEOUT="120"

# [FREERDP RAIL HIDEF]
HIDEF="on"
`;

const KEY_LINE_RE = /^([A-Z_][A-Z0-9_]*)="([^"]*)"(\s*(#.*)?)$/;

function readRawLines() {
  fs.mkdirSync(WINAPPS_CONF_DIR, { recursive: true });
  if (!fs.existsSync(WINAPPS_CONF_FILE)) {
    fs.writeFileSync(WINAPPS_CONF_FILE, DEFAULT_TEMPLATE);
  }
  return fs.readFileSync(WINAPPS_CONF_FILE, 'utf8').split('\n');
}

/** Returns { values: {KEY: value}, comments: {KEY: 'nearest preceding # block text'} } */
function getConfig() {
  const lines = readRawLines();
  const values = {};
  const commentBlocks = {};
  let pendingComment = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      pendingComment.push(trimmed.replace(/^#\s?/, ''));
      continue;
    }
    if (trimmed === '') {
      pendingComment = [];
      continue;
    }
    const m = trimmed.match(KEY_LINE_RE);
    if (m) {
      values[m[1]] = m[2];
      commentBlocks[m[1]] = pendingComment.join('\n');
      pendingComment = [];
    }
  }
  return { values, comments: commentBlocks };
}

/** patch: { KEY: 'new value' }. Only rewrites matching KEY="..." lines; everything else (comments, ordering, spacing) is untouched. */
function setConfig(patch) {
  const lines = readRawLines();
  const seen = new Set();
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    const m = trimmed.match(KEY_LINE_RE);
    if (m && Object.prototype.hasOwnProperty.call(patch, m[1])) {
      seen.add(m[1]);
      const trailing = m[3] || '';
      return `${m[1]}="${patch[m[1]]}"${trailing}`;
    }
    return line;
  });

  // Any key in the patch that wasn't already present in the file gets appended.
  for (const [key, val] of Object.entries(patch)) {
    if (!seen.has(key)) {
      newLines.push(`${key}="${val}"`);
    }
  }

  fs.writeFileSync(WINAPPS_CONF_FILE, newLines.join('\n'));
  return getConfig();
}

module.exports = { getConfig, setConfig, DEFAULT_TEMPLATE, WINAPPS_CONF_FILE };
