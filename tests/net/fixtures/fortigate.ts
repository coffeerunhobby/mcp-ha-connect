/**
 * FortiGate 80F answers in the shape of the FortiOS 7.4 REST API (documentation shapes, not a
 * recording: no FortiGate was reachable when these were written). The factory default has the
 * internal ports in the hardware switch "lan" (192.168.1.99/24, DHCP .110-.210); this one adds a
 * VLAN, a DMZ, address objects and policies of each kind. MACs and serials are documentation values.
 */

type Raw = Record<string, unknown>;

export const envelope = (path: string, name: string, results: unknown, extra: Raw = {}): Raw => ({
    http_method: 'GET',
    results,
    vdom: 'root',
    path,
    name,
    status: 'success',
    http_status: 200,
    serial: 'FGT80FTK00000001',
    version: 'v7.4.4',
    build: 2662,
    ...extra,
});

export const systemStatus = { model_name: 'FortiGate', model_number: '80F', model: 'FGT80F', hostname: 'FGT80F-Home', log_disk_status: 'not_available' };

export const interfaces: Raw[] = [
    { name: 'wan1', vdom: 'root', type: 'physical', role: 'wan', mode: 'dhcp', ip: '192.168.0.126 255.255.255.0', allowaccess: 'ping https', status: 'up', alias: '' },
    { name: 'wan2', vdom: 'root', type: 'physical', role: 'wan', mode: 'dhcp', ip: '0.0.0.0 0.0.0.0', allowaccess: 'ping', status: 'up', alias: '' },
    { name: 'dmz', vdom: 'root', type: 'physical', role: 'dmz', mode: 'static', ip: '10.10.10.1 255.255.255.0', allowaccess: 'ping https', status: 'up', alias: '' },
    { name: 'a', vdom: 'root', type: 'physical', role: 'undefined', mode: 'static', ip: '0.0.0.0 0.0.0.0', status: 'up', alias: '' },
    { name: 'b', vdom: 'root', type: 'physical', role: 'undefined', mode: 'static', ip: '0.0.0.0 0.0.0.0', status: 'up', alias: '' },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ name: `internal${n}`, vdom: 'root', type: 'physical', role: 'undefined', mode: 'static', ip: '0.0.0.0 0.0.0.0', status: 'up', alias: '' })),
    { name: 'lan', vdom: 'root', type: 'hard-switch', role: 'lan', mode: 'static', ip: '192.168.1.99 255.255.255.0', allowaccess: 'ping https ssh fabric', status: 'up', alias: 'Home LAN' },
    { name: 'iot', vdom: 'root', type: 'vlan', role: 'lan', mode: 'static', ip: '192.168.20.1 255.255.255.0', interface: 'lan', vlanid: 20, status: 'up', alias: '' },
    { name: 'fortilink', vdom: 'root', type: 'aggregate', role: 'lan', mode: 'static', ip: '10.255.1.1 255.255.255.0', status: 'up', alias: '', member: [] },
    { name: 'ssl.root', vdom: 'root', type: 'tunnel', role: 'undefined', ip: '0.0.0.0 0.0.0.0', status: 'up', alias: '' },
];

export const virtualSwitch: Raw[] = [{ name: 'lan', 'physical-switch': 'sw0', port: [1, 2, 3, 4, 5, 6].map((n) => ({ name: `internal${n}` })) }];

export const liveInterfaces: Record<string, Raw> = {
    wan1: { id: 'wan1', name: 'wan1', mac: '04:d5:90:00:00:01', ip: '192.168.0.126', mask: 24, link: true, speed: 1000, duplex: 1 },
    wan2: { id: 'wan2', name: 'wan2', mac: '04:d5:90:00:00:02', ip: '0.0.0.0', mask: 0, link: false, speed: 0, duplex: -1 },
    internal1: { id: 'internal1', name: 'internal1', mac: '04:d5:90:00:00:03', link: true, speed: 1000, duplex: 1 },
    internal2: { id: 'internal2', name: 'internal2', mac: '04:d5:90:00:00:04', link: false, speed: 0, duplex: -1 },
};

export const dhcpServers: Raw[] = [
    {
        id: 1,
        status: 'enable',
        interface: 'lan',
        'lease-time': 604800,
        'default-gateway': '192.168.1.99',
        netmask: '255.255.255.0',
        'dns-service': 'default',
        'ip-range': [{ id: 1, 'start-ip': '192.168.1.110', 'end-ip': '192.168.1.210' }],
        'reserved-address': [
            { id: 1, type: 'mac', ip: '192.168.1.50', mac: '02:00:00:00:00:50', action: 'assign', description: 'node-c6' },
            { id: 2, type: 'mac', ip: '192.168.1.51', mac: '02:00:00:00:00:51', action: 'block', description: 'blocked laptop' },
        ],
    },
    {
        id: 2,
        status: 'disable',
        interface: 'iot',
        'lease-time': 3600,
        'dns-service': 'specify',
        'dns-server1': '1.1.1.1',
        'dns-server2': '0.0.0.0',
        'ip-range': [{ id: 1, 'start-ip': '192.168.20.10', 'end-ip': '192.168.20.200' }],
        'reserved-address': [],
    },
];

export const dhcpLeases: Raw[] = [
    { ip: '192.168.1.110', reserved: false, mac: '02:00:00:00:00:10', hostname: 'phone', expire_time: 1795000000, status: 'leased', interface: 'lan', type: 'ipv4' },
    { ip: '192.168.1.50', reserved: true, mac: '02:00:00:00:00:50', hostname: 'node-c6', expire_time: 1795000000, status: 'leased', interface: 'lan', type: 'ipv4' },
];

export const arp: Raw[] = [
    { ip: '192.168.1.50', age: 0, mac: '02:00:00:00:00:50', interface: 'lan' },
    { ip: '192.168.0.1', age: 3, mac: '02:00:00:00:00:01', interface: 'wan1' },
    { ip: '192.168.1.1', age: 9, mac: '00:00:00:00:00:00', interface: 'lan' },
];

export const addresses: Raw[] = [
    { name: 'all', type: 'ipmask', subnet: '0.0.0.0 0.0.0.0' },
    { name: 'node-c6', type: 'ipmask', subnet: '192.168.1.50 255.255.255.255' },
    { name: 'printers', type: 'ipmask', subnet: '192.168.1.32 255.255.255.240' },
    { name: 'laptop-mac', type: 'mac', macaddr: [{ macaddr: '02:00:00:00:00:77' }] },
    { name: 'two-macs', type: 'mac', macaddr: [{ macaddr: '02:00:00:00:00:78' }, { macaddr: '02:00:00:00:00:79' }] },
    { name: 'example.com', type: 'fqdn', fqdn: 'example.com' },
    { name: 'guest-range', type: 'iprange', 'start-ip': '192.168.1.200', 'end-ip': '192.168.1.210' },
];

export const addressGroups: Raw[] = [
    { name: 'servers', member: [{ name: 'node-c6' }, { name: 'printers' }, { name: 'example.com' }] },
    { name: 'kids', member: [{ name: 'laptop-mac' }, { name: 'two-macs' }] },
];

const intf = (...n: string[]) => n.map((name) => ({ name }));

export const policies: Raw[] = [
    { policyid: 1, name: 'LAN to internet', status: 'enable', srcintf: intf('lan'), dstintf: intf('wan1'), srcaddr: intf('all'), dstaddr: intf('all'), action: 'accept', service: intf('ALL'), schedule: 'always', nat: 'enable' },
    { policyid: 5, name: 'block IoT to LAN', status: 'enable', srcintf: intf('iot'), dstintf: intf('lan'), srcaddr: intf('all'), dstaddr: intf('all'), action: 'deny', service: intf('ALL'), schedule: 'always' },
    { policyid: 3, name: 'laptop web', status: 'disable', srcintf: intf('lan'), dstintf: intf('wan1'), srcaddr: intf('laptop-mac'), dstaddr: intf('all'), action: 'accept', service: intf('ALL_TCP'), schedule: 'always' },
    { policyid: 4, name: 'servers to printers', status: 'enable', srcintf: intf('lan'), dstintf: intf('lan'), srcaddr: intf('servers'), dstaddr: intf('node-c6', 'printers'), action: 'accept', service: intf('ALL_ICMP'), schedule: 'always' },
    { policyid: 6, name: 'night', status: 'enable', srcintf: intf('lan'), dstintf: intf('wan1'), srcaddr: intf('all'), dstaddr: intf('all'), action: 'deny', service: intf('HTTPS'), schedule: 'school-nights' },
    { policyid: 7, name: '', status: 'enable', srcintf: intf('any'), dstintf: intf('wan1'), srcaddr: intf('example.com'), dstaddr: intf('all'), action: 'accept', service: intf('ALL'), schedule: 'always', 'internet-service': 'enable', 'srcaddr-negate': 'enable', groups: intf('staff') },
];

export const firmware = {
    current: { version: 'v7.4.4', major: 7, minor: 4, patch: 4, build: 2662, 'platform-id': 'FGT80F' },
    available: [
        { id: 'a', version: 'v7.2.10', major: 7, minor: 2, patch: 10, build: 1706, source: 'fortiguard' },
        { id: 'b', version: 'v7.4.9', major: 7, minor: 4, patch: 9, build: 2829, source: 'fortiguard' },
        { id: 'c', version: 'v7.4.10', major: 7, minor: 4, patch: 10, build: 2900, source: 'fortiguard' },
    ],
};
