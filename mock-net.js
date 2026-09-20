// mock-net.js
const os = require('node:os');

const MY_IP = '192.168.43.1';

const interfaces = {
  lo: [
    {
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: true,
      cidr: '127.0.0.1/8',
    },
    {
      address: '::1',
      netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      family: 'IPv6',
      mac: '00:00:00:00:00:00',
      internal: true,
      cidr: '::1/128',
      scopeid: 0,
    },
  ],
  wlan0: [
    {
      address: MY_IP,
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: `${MY_IP}/24`,
    },
  ],
};

try {
  os.networkInterfaces = () => interfaces;
} catch {
  Object.defineProperty(os, 'networkInterfaces', {
    value: () => interfaces,
    configurable: true,
    writable: true,
  });
}