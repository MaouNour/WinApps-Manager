'use strict';
const { run } = require('./exec');

/** Reads the <ip address=".." netmask=".."/> of a libvirt network and returns CIDR, e.g. 192.168.122.0/24. */
async function getNetworkCidr(networkName = 'default') {
  const { stdout } = await run('virsh', ['net-dumpxml', networkName]);
  const m = stdout.match(/<ip address='([^']+)'\s+netmask='([^']+)'/) ||
    stdout.match(/<ip address="([^"]+)"\s+netmask="([^"]+)"/);
  if (!m) throw new Error(`Could not determine subnet for libvirt network '${networkName}'.`);
  const [, addr, mask] = m;
  const cidr = netmaskToCidr(mask);
  const network = addr.split('.').map(Number);
  network[3] = 0; // assume the doc's typical /24; good enough for the default NAT network
  return `${network.join('.')}/${cidr}`;
}

function netmaskToCidr(mask) {
  return mask
    .split('.')
    .map(Number)
    .reduce((acc, octet) => acc + octet.toString(2).split('1').length - 1, 0);
}

// Equivalent to:
//   alias stop-win-network="sudo iptables -A FORWARD -s <subnet> -d 0.0.0.0/0 -j DROP"
async function disconnectNetwork(networkName = 'default') {
  const subnet = await getNetworkCidr(networkName);
  await run('iptables', ['-A', 'FORWARD', '-s', subnet, '-d', '0.0.0.0/0', '-j', 'DROP'], { sudo: true });
  return { subnet };
}

// Equivalent to:
//   alias connect-win-network="sudo iptables -D FORWARD -s <subnet> -d 0.0.0.0/0 -j DROP"
async function reconnectNetwork(networkName = 'default') {
  const subnet = await getNetworkCidr(networkName);
  await run('iptables', ['-D', 'FORWARD', '-s', subnet, '-d', '0.0.0.0/0', '-j', 'DROP'], { sudo: true, allowFail: true });
  return { subnet };
}

/** True if the DROP rule for this network's subnet currently exists. */
async function isNetworkDisconnected(networkName = 'default') {
  const subnet = await getNetworkCidr(networkName);
  const { stdout } = await run('iptables', ['-S', 'FORWARD'], { allowFail: true });
  return stdout.includes(`-s ${subnet} -d 0.0.0.0/0 -j DROP`);
}

module.exports = { getNetworkCidr, disconnectNetwork, reconnectNetwork, isNetworkDisconnected };
