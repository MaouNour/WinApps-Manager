'use strict';
const { runPowerShell } = require('./guestAgent');

// Lists installed programs from the standard uninstall registry hives.
// This is informational only (shown as a read-only preview list in the
// Apps screen) - actually adding/removing WinApps shortcuts is delegated
// to WinApps' own `winapps-setup`, which already knows how to detect
// community-tested apps, generate icons and .desktop entries correctly.
const INVENTORY_SCRIPT = `
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
  Select-Object DisplayName, DisplayVersion, InstallLocation |
  ConvertTo-Json -Compress
`;

async function scanInstalledApps(vmName) {
  const raw = await runPowerShell(vmName, INVENTORY_SCRIPT, 30000);
  let parsed;
  try {
    parsed = JSON.parse(raw.trim() || '[]');
  } catch (e) {
    throw new Error(`Could not parse guest inventory output: ${e.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((a) => a && a.DisplayName)
    .map((a) => ({ name: a.DisplayName, version: a.DisplayVersion || '', installLocation: a.InstallLocation || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { scanInstalledApps };
