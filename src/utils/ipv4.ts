/** Small IPv4 helpers shared by the Omada access control and the vendor-neutral net_* tools. */

/** "192.0.2.10" -> 3221225994. Throws on anything that is not a dotted IPv4 address. */
export function ipToNumber(ip: string): number {
    const parts = ip.trim().split('.');
    if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
        throw new Error(`'${ip}' is not an IPv4 address`);
    }
    return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

/** "192.0.2.1/24" -> { ip, prefix, network, broadcast } (numbers). Throws on bad input. */
export function parseCidr(value: string): { ip: string; prefix: number; network: number; broadcast: number } {
    const [ip, bits] = value.trim().split('/');
    const address = ipToNumber(ip);
    const prefix = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`'${value}': the prefix must be 0 to 32`);
    const size = 2 ** (32 - prefix);
    const network = Math.floor(address / size) * size;
    return { ip, prefix, network, broadcast: network + size - 1 };
}

/** Whether an address lies inside a CIDR ("192.0.2.0/24" or a gateway form "192.0.2.1/24"). */
export function inSubnet(address: number, cidr: string): boolean {
    try {
        const { network, broadcast } = parseCidr(cidr);
        return address >= network && address <= broadcast;
    } catch {
        return false;
    }
}

/** Whether two CIDRs share any address. */
export function subnetsOverlap(a: string, b: string): boolean {
    const x = parseCidr(a);
    const y = parseCidr(b);
    return x.network <= y.broadcast && y.network <= x.broadcast;
}
