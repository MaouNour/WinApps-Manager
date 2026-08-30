'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { buildIso } = require('./isoTools');
const { DOWNLOADS_DIR, SEED_ISO_DIR } = require('./paths');
const {
  psDisableDefender,
  psDisableUpdates,
  psDisableFirewall,
  psDisableBloat,
  psDisablePerformanceMode
} = require('./guestControl');

const OEM_BASE = 'https://raw.githubusercontent.com/winapps-org/winapps/main/oem/';
// Exactly the four files docs/libvirt.md instructs you to download for a
// libvirt VM (explicitly NOT Container.reg, which is docker/podman-only).
const OEM_FILES = ['RDPApps.reg', 'install.bat', 'TimeSync.ps1', 'NetProfileCleanup.ps1'];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'winapps-manager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/** Downloads the official oem/*.{reg,bat,ps1} files once and caches them locally forever after. */
async function ensureOemFilesCached(onLine) {
  const dir = path.join(DOWNLOADS_DIR, 'oem');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of OEM_FILES) {
    const dest = path.join(dir, f);
    if (fs.existsSync(dest)) continue;
    if (onLine) onLine(`Fetching official ${f} from winapps-org/winapps (one-time, then cached offline)...`);
    const text = await fetchText(OEM_BASE + f);
    fs.writeFileSync(dest, text);
  }
  return dir;
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/**
 * Builds autounattend.xml. This automates exactly what the manual "Install
 * Windows" section of docs/libvirt.md walks through by hand:
 *  - loads the VirtIO storage driver (so the vda disk is visible at all,
 *    since the disk bus is virtio)
 *  - bypasses the "connect to the internet" OOBE requirement (equivalent of
 *    the documented OOBE\BYPASSNRO trick)
 *  - creates the local account matching RDP_USER/RDP_PASS (RDP requires a
 *    full account+password, per the WinApps README)
 *  - on first logon, locates and runs bootstrap.cmd from our OEM seed disc,
 *    which installs VirtIO guest tools + QEMU Guest Agent, imports
 *    RDPApps.reg, runs the official install.bat/TimeSync.ps1/
 *    NetProfileCleanup.ps1, and applies whichever optional tweaks
 *    (Defender/Updates/bloat) the user selected in the wizard.
 */
function buildAutounattendXml({ username, password, computerName = 'RDPWINDOWS', locale = 'en-US', osTargetHint }) {
  const driverPaths = [];
  // We don't know in advance which drive letter WinPE will assign the
  // VirtIO ISO (it depends on attach order), so we list every plausible
  // combination; WindowsPE silently skips paths that don't exist.
  for (const letter of ['D', 'E', 'F', 'G']) {
    for (const sub of ['amd64\\w10', 'amd64\\w11']) {
      driverPaths.push(`      <PathAndCredentials wcm:action="add" wcm:keyValue="${driverPaths.length + 1}">
        <Path>${letter}:\\${sub}</Path>
      </PathAndCredentials>`);
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <SetupUILanguage>
        <UILanguage>${locale}</UILanguage>
      </SetupUILanguage>
      <InputLocale>${locale}</InputLocale>
      <SystemLocale>${locale}</SystemLocale>
      <UILanguage>${locale}</UILanguage>
      <UserLocale>${locale}</UserLocale>
    </component>
    <component name="Microsoft-Windows-PnpCustomizationsWinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <DriverPaths>
${driverPaths.join('\n')}
      </DriverPaths>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <DiskConfiguration>
        <Disk wcm:action="add">
          <CreatePartitions>
            <CreatePartition wcm:action="add">
              <Order>1</Order>
              <Type>Primary</Type>
              <Extend>true</Extend>
            </CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add">
              <Order>1</Order>
              <PartitionID>1</PartitionID>
              <Format>NTFS</Format>
              <Label>Windows</Label>
              <Letter>C</Letter>
            </ModifyPartition>
          </ModifyPartitions>
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
        </Disk>
      </DiskConfiguration>
      <UserData>
        <AcceptEula>true</AcceptEula>
      </UserData>
      <ImageInstall>
        <OSImage>
          <InstallTo>
            <DiskID>0</DiskID>
            <PartitionID>1</PartitionID>
          </InstallTo>
        </OSImage>
      </ImageInstall>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <ComputerName>${xmlEscape(computerName)}</ComputerName>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <NetworkLocation>Home</NetworkLocation>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${xmlEscape(username)}</Name>
            <Group>Administrators</Group>
            <Password>
              <Value>${xmlEscape(password)}</Value>
              <PlainText>true</PlainText>
            </Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <LogonCount>3</LogonCount>
        <Username>${xmlEscape(username)}</Username>
        <Password>
          <Value>${xmlEscape(password)}</Value>
          <PlainText>true</PlainText>
        </Password>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <CommandLine>cmd /c for %d in (D E F G H) do if exist %d:\\bootstrap.cmd call %d:\\bootstrap.cmd</CommandLine>
          <Description>Run WinApps bootstrap from seed media</Description>
          <RequiresUserInput>false</RequiresUserInput>
        </SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}

/** bootstrap.cmd: runs once at first logon, off the seed ISO, entirely offline. */
function buildBootstrapCmd({ enableDefenderDisable, enableUpdatesDisable, enableFirewallDisable, enableBloatDisable, enablePerformanceMode }) {
  const optional = [];
  if (enableDefenderDisable) optional.push('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0disable-defender.ps1"');
  if (enableUpdatesDisable) optional.push('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0disable-updates.ps1"');
  if (enableFirewallDisable) optional.push('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0disable-firewall.ps1"');
  if (enableBloatDisable) optional.push('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0disable-bloat.ps1"');
  if (enablePerformanceMode) optional.push('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0optimize-performance.ps1"');

  return `@echo off
setlocal enabledelayedexpansion
echo [winapps-manager] Running first-boot setup...

:: Locate the VirtIO driver ISO (guest tools installer) among optical drives.
for %%d in (D E F G H) do (
  if exist %%d:\\virtio-win-guest-tools.exe (
    echo [winapps-manager] Installing VirtIO guest tools + QEMU Guest Agent (silent)...
    %%d:\\virtio-win-guest-tools.exe /install /quiet /norestart
  )
)

:: Apply the official WinApps oem tweaks (RDPApps.reg, firewall rule, etc.)
if exist "%~dp0RDPApps.reg" (
  echo [winapps-manager] Importing RDPApps.reg...
  reg import "%~dp0RDPApps.reg"
)
if exist "%~dp0install.bat" (
  echo [winapps-manager] Running official oem\\install.bat...
  call "%~dp0install.bat"
)
if exist "%~dp0TimeSync.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0TimeSync.ps1"
)
if exist "%~dp0NetProfileCleanup.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0NetProfileCleanup.ps1"
)

${optional.join('\n')}

echo [winapps-manager] First-boot setup complete.
`;
}

/**
 * Builds the whole seed ISO (autounattend.xml + oem scripts) for one VM
 * creation run and returns its path.
 */
async function buildSeedIso(vmOpts, onLine) {
  const oemDir = await ensureOemFilesCached(onLine);
  const stage = path.join(SEED_ISO_DIR, `${vmOpts.name}-stage`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  fs.writeFileSync(path.join(stage, 'autounattend.xml'), buildAutounattendXml(vmOpts));
  fs.writeFileSync(path.join(stage, 'bootstrap.cmd'), buildBootstrapCmd(vmOpts));
  fs.writeFileSync(path.join(stage, 'disable-defender.ps1'), psDisableDefender());
  fs.writeFileSync(path.join(stage, 'disable-updates.ps1'), psDisableUpdates());
  fs.writeFileSync(path.join(stage, 'disable-firewall.ps1'), psDisableFirewall());
  fs.writeFileSync(path.join(stage, 'disable-bloat.ps1'), psDisableBloat());
  fs.writeFileSync(path.join(stage, 'optimize-performance.ps1'), psDisablePerformanceMode());
  for (const f of OEM_FILES) {
    fs.copyFileSync(path.join(oemDir, f), path.join(stage, f));
  }

  const isoPath = path.join(SEED_ISO_DIR, `${vmOpts.name}-seed.iso`);
  if (onLine) onLine('Packaging autounattend/oem seed ISO...');
  await buildIso(stage, isoPath, 'SEED');
  return isoPath;
}

module.exports = { buildSeedIso, buildAutounattendXml };
