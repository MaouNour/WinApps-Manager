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
  // Belt-and-suspenders: Set-MpPreference for the live session, plus the
  // equivalent Group Policy registry keys so the settings stick across
  // Defender's periodic policy re-apply, plus stopping/disabling the
  // services outright. NOTE (surfaced in the UI too): if Tamper Protection
  // is ON, Microsoft deliberately blocks all of this from succeeding - it
  // has to be switched off by hand first in Windows Security ->
  // Virus & threat protection settings, there is no scriptable bypass.
  return `$ErrorActionPreference = 'SilentlyContinue'
Set-MpPreference -DisableRealtimeMonitoring $true
Set-MpPreference -DisableBehaviorMonitoring $true
Set-MpPreference -DisableIOAVProtection $true
Set-MpPreference -DisableScriptScanning $true
Set-MpPreference -DisableArchiveScanning $true
Set-MpPreference -DisableIntrusionPreventionSystem $true
Set-MpPreference -DisableRemovableDriveScanning $true
Set-MpPreference -MAPSReporting 0
Set-MpPreference -SubmitSamplesConsent 2
$ap = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows Defender'
New-Item -Path $ap -Force | Out-Null
Set-ItemProperty -Path $ap -Name DisableAntiSpyware -Value 1 -Type DWord
$rt = "$ap\\Real-Time Protection"
New-Item -Path $rt -Force | Out-Null
Set-ItemProperty -Path $rt -Name DisableRealtimeMonitoring -Value 1 -Type DWord
Set-ItemProperty -Path $rt -Name DisableBehaviorMonitoring -Value 1 -Type DWord
Set-ItemProperty -Path $rt -Name DisableOnAccessProtection -Value 1 -Type DWord
Set-ItemProperty -Path $rt -Name DisableScanOnRealtimeEnable -Value 1 -Type DWord
sc.exe config WinDefend start=disabled 2>$null
sc.exe stop WinDefend 2>$null
sc.exe config WdNisSvc start=disabled 2>$null
sc.exe stop WdNisSvc 2>$null
sc.exe config Sense start=disabled 2>$null
$tamper = (Get-MpComputerStatus).IsTamperProtected
if ($tamper) { Write-Output "defender-disabled-partial-tamper-protection-on" } else { Write-Output "defender-disabled" }`;
}

function psEnableDefender() {
  return `$ErrorActionPreference = 'SilentlyContinue'
Set-MpPreference -DisableRealtimeMonitoring $false
Set-MpPreference -DisableBehaviorMonitoring $false
Set-MpPreference -DisableIOAVProtection $false
Set-MpPreference -DisableScriptScanning $false
Set-MpPreference -DisableArchiveScanning $false
Set-MpPreference -DisableIntrusionPreventionSystem $false
Set-MpPreference -DisableRemovableDriveScanning $false
Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows Defender' -Recurse -Force
sc.exe config WinDefend start=auto 2>$null
sc.exe start WinDefend 2>$null
sc.exe config WdNisSvc start=demand 2>$null
sc.exe config Sense start=demand 2>$null
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

// "Optimize performance" - separate from bloat trimming so it's toggleable
// on its own: best-performance visual effects, no hibernation file, high
// performance power plan, Storage Sense off, background apps off.
function psDisablePerformanceMode() {
  return `$ErrorActionPreference = 'SilentlyContinue'
# Visual effects: "Adjust for best performance"
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects' -Name VisualFXSetting -Value 2 -Type DWord
$dwm = 'HKCU:\\Software\\Microsoft\\Windows\\DWM'
Set-ItemProperty -Path $dwm -Name EnableAeroPeek -Value 0 -Type DWord
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name DragFullWindows -Value 0
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name MinAnimate -Value 0
# No hibernation file (irrelevant for a VM, frees disk, one less background task)
powercfg /hibernate off
powercfg /setactive SCHEME_MIN 2>$null
# Storage Sense off (no need to auto-clean a VM disk)
New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy' -Name '01' -Value 0 -Type DWord
# Background apps off
New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications' -Name GlobalUserDisabled -Value 1 -Type DWord
Write-Output "performance-disabled"`;
}

function psEnablePerformanceMode() {
  return `$ErrorActionPreference = 'SilentlyContinue'
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects' -Name VisualFXSetting -Value 0 -Type DWord
powercfg /hibernate on
powercfg /setactive SCHEME_BALANCED 2>$null
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy' -Name '01' -Value 1 -Type DWord
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications' -Name GlobalUserDisabled -Value 0 -Type DWord
Write-Output "performance-enabled"`;
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
  return `$ErrorActionPreference = 'SilentlyContinue'
$defender = (Get-MpPreference).DisableRealtimeMonitoring
$tamper = (Get-MpComputerStatus).IsTamperProtected
$wu = (Get-Service wuauserv).StartType
$fw = (Get-NetFirewallProfile | Select-Object -First 1).Enabled
$diagTrack = (Get-Service DiagTrack).StartType
$fx = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects' -Name VisualFXSetting).VisualFXSetting
[PSCustomObject]@{
  defenderDisabled = [bool]$defender
  defenderTamperProtected = [bool]$tamper
  updatesDisabled = ($wu -eq 'Disabled')
  firewallDisabled = (-not [bool]$fw)
  bloatDisabled = ($diagTrack -eq 'Disabled')
  performanceDisabled = ($fx -eq 2)
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
    bloat: enabled ? psEnableBloat() : psDisableBloat(),
    performance: enabled ? psEnablePerformanceMode() : psDisablePerformanceMode()
  };
  if (!map[feature]) throw new Error(`Unknown feature '${feature}'`);
  const out = await runPowerShell(vmName, map[feature], 30000);
  return out.trim();
}

// "Recommended for WinApps" one-click preset: Defender + Updates + bloat +
// performance mode all disabled in one go (Firewall deliberately left
// alone - keeping it on is the sane default even for a RemoteApp VM).
const RECOMMENDED_FEATURES = ['defender', 'updates', 'bloat', 'performance'];

async function applyRecommended(vmName) {
  const results = {};
  for (const feature of RECOMMENDED_FEATURES) {
    results[feature] = await applyToggle(vmName, feature, false);
  }
  return results;
}

module.exports = {
  psDisableDefender, psEnableDefender,
  psDisableUpdates, psEnableUpdates,
  psDisableFirewall, psEnableFirewall,
  psDisableBloat, psEnableBloat,
  psDisablePerformanceMode, psEnablePerformanceMode,
  getGuestControlStatus, applyToggle, applyRecommended,
  RECOMMENDED_FEATURES,
  BLOAT_SERVICES, BLOAT_TASKS, BLOAT_APPX
};
