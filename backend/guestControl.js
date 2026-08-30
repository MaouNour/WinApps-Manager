'use strict';
const { runPowerShell } = require('./guestAgent');

// Expanded bloat/perf service + scheduled-task list. Kept as data so the
// same list drives both the first-boot bootstrap script (unattend.js) and
// live toggling against an already-installed VM (below).
const BLOAT_SERVICES = [
  'DiagTrack', 'dmwappushservice', 'MapsBroker', 'RetailDemo', 'WSearch',
  'SysMain', 'WerSvc', 'PcaSvc', 'WalletService', 'RemoteRegistry',
  'Fax', 'TabletInputService', 'WMPNetworkSvc', 'XblAuthManager',
  'XblGameSave', 'XboxNetApiSvc', 'XboxGipSvc'
];

const BLOAT_TASKS = [
  '\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser',
  '\\Microsoft\\Windows\\Application Experience\\ProgramDataUpdater',
  '\\Microsoft\\Windows\\Autochk\\Proxy',
  '\\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator',
  '\\Microsoft\\Windows\\Customer Experience Improvement Program\\UsbCeip',
  '\\Microsoft\\Windows\\Feedback\\Siuf\\DmClient',
  '\\Microsoft\\Windows\\Feedback\\Siuf\\DmClientOnScenarioDownload',
  '\\Microsoft\\Windows\\Maps\\MapsUpdateTask',
  '\\Microsoft\\Windows\\Windows Error Reporting\\QueueReporting'
];

const BLOAT_APPX = ['xboxapp', 'bingweather', 'bingnews', 'zunemusic', 'zunevideo', 'solitaire', 'people', 'getstarted'];

function psDisableDefender() {
  return `Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue
Set-MpPreference -DisableBehaviorMonitoring $true -ErrorAction SilentlyContinue
Set-MpPreference -DisableIOAVProtection $true -ErrorAction SilentlyContinue
Set-MpPreference -DisableScriptScanning $true -ErrorAction SilentlyContinue
Set-MpPreference -MAPSReporting 0 -ErrorAction SilentlyContinue
Set-MpPreference -SubmitSamplesConsent 2 -ErrorAction SilentlyContinue
sc.exe config WinDefend start=disabled 2>$null
sc.exe config WdNisSvc start=disabled 2>$null
Write-Output "defender-disabled"`;
}

function psEnableDefender() {
  return `Set-MpPreference -DisableRealtimeMonitoring $false -ErrorAction SilentlyContinue
Set-MpPreference -DisableBehaviorMonitoring $false -ErrorAction SilentlyContinue
Set-MpPreference -DisableIOAVProtection $false -ErrorAction SilentlyContinue
Set-MpPreference -DisableScriptScanning $false -ErrorAction SilentlyContinue
sc.exe config WinDefend start=auto 2>$null
sc.exe start WinDefend 2>$null
sc.exe config WdNisSvc start=demand 2>$null
Write-Output "defender-enabled"`;
}

function psDisableUpdates() {
  return `sc.exe config wuauserv start=disabled
sc.exe stop wuauserv 2>$null
sc.exe config UsoSvc start=disabled
sc.exe stop UsoSvc 2>$null
New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU" -Name NoAutoUpdate -Value 1 -Type DWord
Write-Output "updates-disabled"`;
}

function psEnableUpdates() {
  return `sc.exe config wuauserv start=demand
sc.exe start wuauserv 2>$null
sc.exe config UsoSvc start=demand
Remove-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU" -Name NoAutoUpdate -ErrorAction SilentlyContinue
Write-Output "updates-enabled"`;
}

function psDisableFirewall() {
  return `Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled False
Write-Output "firewall-disabled"`;
}

function psEnableFirewall() {
  return `Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True
Write-Output "firewall-enabled"`;
}

function psDisableBloat() {
  const svc = BLOAT_SERVICES.map((s) => `'${s}'`).join(',');
  const tasks = BLOAT_TASKS.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
  const appx = BLOAT_APPX.map((a) => `'*${a}*'`).join(',');
  return `$services = @(${svc})
foreach ($s in $services) { sc.exe config $s start=disabled 2>$null; sc.exe stop $s 2>$null }
$tasks = @(${tasks})
foreach ($t in $tasks) { schtasks /Change /TN $t /Disable 2>$null }
$appx = @(${appx})
foreach ($pattern in $appx) { Get-AppxPackage -AllUsers $pattern | Remove-AppxPackage -ErrorAction SilentlyContinue }
# Power/perf tweaks for a headless RemoteApp VM
powercfg /change monitor-timeout-ac 0 2>$null
powercfg /change disk-timeout-ac 0 2>$null
powercfg /setactive SCHEME_MIN 2>$null
Write-Output "bloat-disabled"`;
}

function psEnableBloat() {
  const svc = BLOAT_SERVICES.map((s) => `'${s}'`).join(',');
  const tasks = BLOAT_TASKS.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
  return `$services = @(${svc})
foreach ($s in $services) { sc.exe config $s start=demand 2>$null }
$tasks = @(${tasks})
foreach ($t in $tasks) { schtasks /Change /TN $t /Enable 2>$null }
Write-Output "bloat-enabled"`;
}

// Live status probe used by the Dashboard toggle badges.
function psStatus() {
  return `$defender = (Get-MpPreference -ErrorAction SilentlyContinue).DisableRealtimeMonitoring
$wu = (Get-Service wuauserv -ErrorAction SilentlyContinue).StartType
$fw = (Get-NetFirewallProfile -ErrorAction SilentlyContinue | Select-Object -First 1).Enabled
$diagTrack = (Get-Service DiagTrack -ErrorAction SilentlyContinue).StartType
[PSCustomObject]@{
  defenderDisabled = [bool]$defender
  updatesDisabled = ($wu -eq 'Disabled')
  firewallDisabled = (-not [bool]$fw)
  bloatDisabled = ($diagTrack -eq 'Disabled')
} | ConvertTo-Json -Compress`;
}

async function getGuestControlStatus(vmName) {
  const raw = await runPowerShell(vmName, psStatus(), 15000);
  try {
    return JSON.parse(raw.trim());
  } catch (e) {
    throw new Error('Could not read guest status (is the VM running with the guest agent up?): ' + e.message);
  }
}

async function applyToggle(vmName, feature, enabled) {
  const map = {
    defender: enabled ? psEnableDefender() : psDisableDefender(),
    updates: enabled ? psEnableUpdates() : psDisableUpdates(),
    firewall: enabled ? psEnableFirewall() : psDisableFirewall(),
    bloat: enabled ? psEnableBloat() : psDisableBloat()
  };
  if (!map[feature]) throw new Error(`Unknown feature '${feature}'`);
  const out = await runPowerShell(vmName, map[feature], 30000);
  return out.trim();
}

module.exports = {
  psDisableDefender, psEnableDefender,
  psDisableUpdates, psEnableUpdates,
  psDisableFirewall, psEnableFirewall,
  psDisableBloat, psEnableBloat,
  getGuestControlStatus, applyToggle,
  BLOAT_SERVICES, BLOAT_TASKS, BLOAT_APPX
};
