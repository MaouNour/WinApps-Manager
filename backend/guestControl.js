'use strict';
const { runPowerShell } = require('./guestAgent');

// Expanded bloat/perf service + scheduled-task list. Kept as data so the
// same list drives both the first-boot bootstrap script (unattend.js) and
// live toggling against an already-installed VM (below).
//
// Deliberately NOT included here, even though they're "bloat" in spirit:
// anything RDP/network/auth-core (TermService, UmRdpService, SessionEnv,
// RpcSs, RpcEptMapper, DcomLaunch, Dnscache, Dhcp, NlaSvc, EventLog,
// ProfSvc, Schedule) - disabling any of those risks breaking the VM's
// remote access entirely, which is a much worse outcome than a few extra
// MB of idle RAM. Also left alone: AudioSrv/AudioEndpointBuilder (WinApps
// can redirect guest audio - some setups want it), Themes (needed for
// basic UI rendering, disabling it usually makes things look broken, not
// faster), FontCache (a cache - disabling it makes font rendering slower,
// not faster), and SmartCard services (some people RDP in with smart-card
// auth). WSearch's *service* itself is governed by the separate 'search'
// toggle below and is deliberately left out of this list entirely - having
// both 'bloat' and 'search' silently manage the same service (with two
// different verify steps and two different "enabled" start types) is a
// real way to end up with a toggle that looks wrong days after the last
// time you actually touched it.
const BLOAT_SERVICES = [
  'DiagTrack', 'dmwappushservice', 'MapsBroker', 'RetailDemo',
  'SysMain', 'WerSvc', 'PcaSvc', 'WalletService', 'RemoteRegistry',
  'Fax', 'TabletInputService', 'WMPNetworkSvc', 'XblAuthManager',
  'XblGameSave', 'XboxNetApiSvc', 'XboxGipSvc',
  // Extra low-risk, non-core services - same "clearly-consumer-feature,
  // clearly-not-needed-headless" bar as the original list above.
  'PhoneSvc', 'lfsvc', 'MessagingService', 'PimIndexMaintenanceSvc',
  'UnistoreSvc', 'CDPUserSvc', 'DoSvc', 'diagnosticshub.standardcollector.service',
  'wercplsupport', 'CscService', 'TrkWks', 'SSDPSRV', 'upnphost',
  'WbioSrvc', 'shpamsvc', 'SEMgrSvc', 'icssvc'
];

const BLOAT_TASKS = [
  '\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser',
  '\\Microsoft\\Windows\\Application Experience\\ProgramDataUpdater',
  '\\Microsoft\\Windows\\Application Experience\\StartupAppTask',
  '\\Microsoft\\Windows\\Autochk\\Proxy',
  '\\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator',
  '\\Microsoft\\Windows\\Customer Experience Improvement Program\\UsbCeip',
  '\\Microsoft\\Windows\\Feedback\\Siuf\\DmClient',
  '\\Microsoft\\Windows\\Feedback\\Siuf\\DmClientOnScenarioDownload',
  '\\Microsoft\\Windows\\Maps\\MapsUpdateTask',
  '\\Microsoft\\Windows\\Windows Error Reporting\\QueueReporting',
  '\\Microsoft\\Windows\\Maintenance\\WinSAT',
  '\\Microsoft\\Windows\\PI\\Sqm-Tasks',
  '\\Microsoft\\Windows\\NetTrace\\GatherNetworkInfo',
  '\\Microsoft\\Windows\\DiskDiagnostic\\Microsoft-Windows-DiskDiagnosticDataCollector',
  '\\Microsoft\\Windows\\Shell\\FamilySafetyMonitor',
  '\\Microsoft\\Windows\\Shell\\FamilySafetyRefreshTask',
  '\\Microsoft\\Windows\\CloudExperienceHost\\CreateObjectTask',
  '\\Microsoft\\Windows\\Location\\Notifications',
  // Periodic defrag of the guest's *virtual* disk file: on a modern
  // host filesystem/SSD this is pure wasted guest disk I/O for no real
  // benefit, so it's included here even though it's not "bloat" per se.
  '\\Microsoft\\Windows\\Defrag\\ScheduledDefrag'
];

const BLOAT_APPX = [
  'xboxapp', 'bingweather', 'bingnews', 'zunemusic', 'zunevideo', 'solitaire', 'people', 'getstarted',
  // Extra Win10/11 pre-pinned consumer bloat that's pure dead weight on a
  // RemoteApp-only VM - none of these are touched unless the 'bloat'
  // toggle is explicitly turned off by the user (same as the original list).
  'bingfinance', 'bingsports', 'binghealthandfitness', 'bingfoodanddrink', 'bingtravel',
  'todos', 'clipchamp', 'linkedin', 'gethelp', 'officehub', 'skypeapp',
  'mixedreality', 'messaging', '3dviewer', 'print3d', 'windowsmaps',
  'communicationsapps', 'feedbackhub',
  'windowsalarms', 'windowscamera', 'windowssoundrecorder', 'xboxgamingoverlay', 'yourphone'
];

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
# Balanced, not High Performance (SCHEME_MIN): forcing the guest vCPU to
# stay boosted fights the host for the same thermal/power budget on a
# laptop, which tends to make things feel slower overall, not faster,
# once the host is also under load. Balanced still lets it clock up under
# real load without pinning it there constantly.
powercfg /setactive SCHEME_BALANCED 2>$null
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

// Windows Search / indexing - large idle CPU/disk/RAM consumer on a VM that
// has nothing local worth indexing. Also turns off the taskbar search box's
// web-search suggestions (Bing calls on every keystroke).
//
// IMPORTANT (this is what "disabled but still finding things" almost
// always means, not a bug): the taskbar/Start search BOX is a separate
// per-user shell component (SearchHost.exe/SearchApp.exe) that can still
// answer app-launcher queries from its own local app cache with the
// WSearch *indexing service* fully off - that's normal Windows behavior,
// not this service quietly re-enabling itself. What this toggle actually
// controls is the background file-content indexer (SearchIndexer.exe) -
// the thing that eats idle CPU/disk/RAM keeping an index nobody on a
// RemoteApp VM needs.
function psDisableSearch() {
  return `$ErrorActionPreference = 'SilentlyContinue'
sc.exe config WSearch start=disabled
sc.exe stop WSearch
$pol = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search'
New-Item -Path $pol -Force | Out-Null
Set-ItemProperty -Path $pol -Name AllowCortana -Value 0 -Type DWord
Set-ItemProperty -Path $pol -Name ConnectedSearchUseWeb -Value 0 -Type DWord
Set-ItemProperty -Path $pol -Name DisableWebSearch -Value 1 -Type DWord
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search' -Name SearchboxTaskbarMode -Value 0 -Type DWord
# Verify it actually stuck, straight from the registry Start value SCM
# itself consults (0=Boot 1=System 2=Auto 3=Manual 4=Disabled) - sc.exe
# can silently no-op (protected-service ACL, a security product, a GPO
# re-apply racing this script) and a status check that just trusts the
# command instead of re-reading reality is how a toggle ends up reporting
# "disabled" for a service that was never actually touched.
$raw = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\WSearch' -Name Start -ErrorAction SilentlyContinue).Start
if ($raw -eq 4) { Write-Output "search-disabled" } else { Write-Output "search-disable-failed-check-permissions" }`;
}
function psEnableSearch() {
  return `$ErrorActionPreference = 'SilentlyContinue'
sc.exe config WSearch start=delayed-auto
sc.exe start WSearch
Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search' -Recurse -Force
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search' -Name SearchboxTaskbarMode -Value 1 -Type DWord
Write-Output "search-enabled"`;
}

// OneDrive - a full background sync client + tray process nobody asked for
// on a RemoteApp VM unless they specifically use it for file redirection
// (WinApps already does file access via +home-drive, so this is normally
// pure overhead). Stops it and blocks it from relaunching; does NOT
// uninstall it (uninstalling is a bigger, harder-to-reverse step than a
// toggle should silently do).
function psDisableOneDrive() {
  return `$ErrorActionPreference = 'SilentlyContinue'
Stop-Process -Name OneDrive -Force
Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name OneDrive
$pol = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\OneDrive'
New-Item -Path $pol -Force | Out-Null
Set-ItemProperty -Path $pol -Name DisableFileSyncNGSC -Value 1 -Type DWord
Write-Output "onedrive-disabled"`;
}
function psEnableOneDrive() {
  return `$ErrorActionPreference = 'SilentlyContinue'
Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\OneDrive' -Name DisableFileSyncNGSC
$od = "$env:LOCALAPPDATA\\Microsoft\\OneDrive\\OneDrive.exe"
if (Test-Path $od) {
  Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name OneDrive -Value $od
  Start-Process $od
}
Write-Output "onedrive-enabled"`;
}

// Widgets + Copilot - the two Windows 11 taskbar features with their own
// standing background processes/services that a headless per-app VM has no
// use for.
function psDisableWidgetsCopilot() {
  return `$ErrorActionPreference = 'SilentlyContinue'
$exp = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
Set-ItemProperty -Path $exp -Name TaskbarDa -Value 0 -Type DWord
$pol1 = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Dsh'
New-Item -Path $pol1 -Force | Out-Null
Set-ItemProperty -Path $pol1 -Name AllowNewsAndInterests -Value 0 -Type DWord
$pol2 = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsCopilot'
New-Item -Path $pol2 -Force | Out-Null
Set-ItemProperty -Path $pol2 -Name TurnOffWindowsCopilot -Value 1 -Type DWord
Set-ItemProperty -Path $exp -Name ShowCopilotButton -Value 0 -Type DWord
sc.exe config WidgetsService start=disabled 2>$null
sc.exe stop WidgetsService 2>$null
Get-AppxPackage -AllUsers *WebExperience* | Remove-AppxPackage -ErrorAction SilentlyContinue
Write-Output "widgetscopilot-disabled"`;
}
function psEnableWidgetsCopilot() {
  return `$ErrorActionPreference = 'SilentlyContinue'
Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name TaskbarDa -Value 1 -Type DWord
Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Dsh' -Recurse -Force
Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsCopilot' -Recurse -Force
sc.exe config WidgetsService start=demand 2>$null
Write-Output "widgetscopilot-enabled"`;
}

// Shell/Explorer overhead that only matters for interactive desktop use -
// AutoPlay detection, Windows Image Acquisition (scanners/cameras), Quick
// Access recent-file tracking. None of this affects individual apps
// launched via WinApps' RemoteApp (RAIL) mode, which never shows the
// desktop shell in the first place - this is for people who also open a
// full desktop session sometimes and want it as light as possible, or who
// just want the background services gone either way.
function psDisableShellExtras() {
  return `$ErrorActionPreference = 'SilentlyContinue'
sc.exe config ShellHWDetection start=disabled
sc.exe stop ShellHWDetection
sc.exe config stisvc start=disabled
sc.exe stop stisvc
$adv = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
Set-ItemProperty -Path $adv -Name Start_TrackDocs -Value 0 -Type DWord
Set-ItemProperty -Path $adv -Name Start_TrackProgs -Value 0 -Type DWord
Set-ItemProperty -Path $adv -Name ShowTaskViewButton -Value 0 -Type DWord
Write-Output "shellextras-disabled"`;
}
function psEnableShellExtras() {
  return `$ErrorActionPreference = 'SilentlyContinue'
sc.exe config ShellHWDetection start=auto
sc.exe start ShellHWDetection
sc.exe config stisvc start=demand
$adv = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
Set-ItemProperty -Path $adv -Name Start_TrackDocs -Value 1 -Type DWord
Set-ItemProperty -Path $adv -Name Start_TrackProgs -Value 1 -Type DWord
Set-ItemProperty -Path $adv -Name ShowTaskViewButton -Value 1 -Type DWord
Write-Output "shellextras-enabled"`;
}

// Print Spooler - deliberately its own standalone toggle, never bundled
// into either preset below: plenty of people still want redirected
// printing to work, so this only ever changes if picked explicitly.
function psDisablePrintSpooler() {
  return `$ErrorActionPreference = 'SilentlyContinue'
sc.exe config Spooler start=disabled
sc.exe stop Spooler
Write-Output "printspooler-disabled"`;
}
function psEnablePrintSpooler() {
  return `$ErrorActionPreference = 'SilentlyContinue'
sc.exe config Spooler start=auto
sc.exe start Spooler
Write-Output "printspooler-enabled"`;
}

// "Headless mode" - as close as it's safe to get to "pure backend runner,
// no UI at all" without touching the actual shell (explorer.exe) itself.
// Deliberately does NOT try to replace/remove the shell: RemoteApp (RAIL)
// sessions already never show a desktop/taskbar for the launched app by
// design (that's inherent to how RDP RemoteApp works, not something this
// app configures) - the risk of going further and swapping out explorer.exe
// as the Winlogon shell is that it can break the session infrastructure
// RemoteApp itself depends on to spawn app windows in the first place, in
// a way that's hard to diagnose remotely and can lock you out of the VM's
// desktop entirely. So this toggle targets the two concrete things asked
// for that are safe to fully remove - Task Manager and Control Panel/
// Settings access - plus a couple of real background processes that only
// exist to serve interactive desktop use.
//
// Task Manager and Control Panel/Settings are blocked via Image File
// Execution Options (IFEO), not the classic DisableTaskMgr/NoControlPanel
// policies. Those classic policies live under HKCU, and because WinApps
// Manager's guest commands run as NT AUTHORITY\SYSTEM (the qemu-ga service
// account) rather than as the RDP user, a write to `HKCU:\...` here lands
// in SYSTEM's own profile, not the actual logged-in user's - it would look
// like it worked (no error) and silently do nothing for anyone who RDPs
// in, which is exactly the kind of "reports success, isn't actually true"
// bug this VM management page has already needed fixing once (see the
// Windows Search fix above). IFEO is keyed by executable name, not by
// user, so it applies machine-wide regardless of who's logged in.
function psDisableHeadlessShell() {
  return `$ErrorActionPreference = 'SilentlyContinue'
foreach ($exe in @('Taskmgr.exe', 'SystemSettings.exe', 'control.exe')) {
  $ifeo = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\$exe"
  New-Item -Path $ifeo -Force | Out-Null
  Set-ItemProperty -Path $ifeo -Name Debugger -Value 'cmd.exe /c exit' -Type String
}
# Game Bar / Game DVR - background capture hooks with no purpose on a VM
# nobody games on; machine-wide policy, not per-user.
$gdvr = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR'
New-Item -Path $gdvr -Force | Out-Null
Set-ItemProperty -Path $gdvr -Name AllowGameDVR -Value 0 -Type DWord
# Spotlight/lock-screen tips/Start suggestions - periodic background
# network calls fetching content nobody will ever see headlessly.
$cc = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent'
New-Item -Path $cc -Force | Out-Null
Set-ItemProperty -Path $cc -Name DisableWindowsSpotlightFeatures -Value 1 -Type DWord
Set-ItemProperty -Path $cc -Name DisableSoftLanding -Value 1 -Type DWord
Set-ItemProperty -Path $cc -Name DisableThirdPartySuggestions -Value 1 -Type DWord
$raw = Test-Path "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\Taskmgr.exe"
if ($raw) { Write-Output "headlessshell-disabled" } else { Write-Output "headlessshell-disable-failed-check-permissions" }`;
}
function psEnableHeadlessShell() {
  return `$ErrorActionPreference = 'SilentlyContinue'
foreach ($exe in @('Taskmgr.exe', 'SystemSettings.exe', 'control.exe')) {
  Remove-Item -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\$exe" -Recurse -Force
}
Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR' -Name AllowGameDVR
Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent' -Recurse -Force
Write-Output "headlessshell-enabled"`;
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
# Raw registry Start value (0=Boot 1=System 2=Auto 3=Manual 4=Disabled),
# not Get-Service.StartType - this is the exact value SCM itself reads to
# decide whether WSearch is allowed to start, so there's no layer of
# indirection left that could report "disabled" for a service that isn't.
$searchRaw = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\WSearch' -Name Start -ErrorAction SilentlyContinue).Start
$oneDriveRun = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name OneDrive
$widgets = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name TaskbarDa).TaskbarDa
$shellHw = (Get-Service ShellHWDetection).StartType
$spooler = (Get-Service Spooler).StartType
$headlessTM = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\Taskmgr.exe'
[PSCustomObject]@{
  defenderDisabled = [bool]$defender
  defenderTamperProtected = [bool]$tamper
  updatesDisabled = ($wu -eq 'Disabled')
  firewallDisabled = (-not [bool]$fw)
  bloatDisabled = ($diagTrack -eq 'Disabled')
  performanceDisabled = ($fx -eq 2)
  searchDisabled = ($searchRaw -eq 4)
  onedriveDisabled = (-not [bool]$oneDriveRun)
  widgetsCopilotDisabled = ($widgets -eq 0)
  shellExtrasDisabled = ($shellHw -eq 'Disabled')
  printSpoolerDisabled = ($spooler -eq 'Disabled')
  headlessShellDisabled = [bool]$headlessTM
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
    performance: enabled ? psEnablePerformanceMode() : psDisablePerformanceMode(),
    search: enabled ? psEnableSearch() : psDisableSearch(),
    onedrive: enabled ? psEnableOneDrive() : psDisableOneDrive(),
    widgetsCopilot: enabled ? psEnableWidgetsCopilot() : psDisableWidgetsCopilot(),
    shellExtras: enabled ? psEnableShellExtras() : psDisableShellExtras(),
    printSpooler: enabled ? psEnablePrintSpooler() : psDisablePrintSpooler(),
    headlessShell: enabled ? psEnableHeadlessShell() : psDisableHeadlessShell()
  };
  if (!map[feature]) throw new Error(`Unknown feature '${feature}'`);
  const out = await runPowerShell(vmName, map[feature], 30000);
  return out.trim();
}

// "Recommended for WinApps" one-click preset: Defender + Updates + bloat +
// performance mode all disabled in one go (Firewall deliberately left
// alone - keeping it on is the sane default even for a RemoteApp VM).
const RECOMMENDED_FEATURES = ['defender', 'updates', 'bloat', 'performance'];

// "RemoteApp-only ultra-lite" preset: everything in the recommended preset,
// plus every toggle above that only matters for interactive desktop use
// (search indexing, OneDrive sync, Widgets/Copilot, AutoPlay/WIA/shell
// tracking, and headless mode's Task Manager/Settings/Game Bar/Spotlight
// blocks). Deliberately still leaves Firewall AND Print Spooler alone -
// those are functional, not cosmetic, and shouldn't be silently switched
// off by a "make it lighter" button.
const REMOTEAPP_ONLY_FEATURES = [...RECOMMENDED_FEATURES, 'search', 'onedrive', 'widgetsCopilot', 'shellExtras', 'headlessShell'];

async function applyRecommended(vmName) {
  const results = {};
  for (const feature of RECOMMENDED_FEATURES) {
    results[feature] = await applyToggle(vmName, feature, false);
  }
  return results;
}

async function applyRemoteAppOnlyPreset(vmName) {
  const results = {};
  for (const feature of REMOTEAPP_ONLY_FEATURES) {
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
  psDisableSearch, psEnableSearch,
  psDisableOneDrive, psEnableOneDrive,
  psDisableWidgetsCopilot, psEnableWidgetsCopilot,
  psDisableShellExtras, psEnableShellExtras,
  psDisablePrintSpooler, psEnablePrintSpooler,
  psDisableHeadlessShell, psEnableHeadlessShell,
  getGuestControlStatus, applyToggle, applyRecommended, applyRemoteAppOnlyPreset,
  RECOMMENDED_FEATURES, REMOTEAPP_ONLY_FEATURES,
  BLOAT_SERVICES, BLOAT_TASKS, BLOAT_APPX
};
