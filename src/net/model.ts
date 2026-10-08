/**
 * Vendor-neutral network model ("least common multiple" of Omada, UniFi and MikroTik).
 *
 * DESIGN ONLY: nothing imports this yet. It describes what the net_* tools speak and
 * what every vendor adapter (src/net/adapters/<vendor>) must implement.
 *
 * Rules of the model:
 * - It holds every concept any of the three vendors has, so none loses a feature.
 *   An adapter either maps a concept to a native object, builds it from several
 *   objects ("emulated"), or refuses with NetError UNSUPPORTED. It never silently
 *   drops part of a request.
 * - Objects are referred to by Ref (id or name). Ids are opaque, adapter-owned strings.
 * - Every write is a Change that is planned first (dry run), then applied.
 */

// ---- references and small value types --------------------------------------------

/** An object by id, or by its unique name (case-insensitive). */
export type Ref = { id: string } | { name: string };

/** "AA-BB-CC-DD-EE-FF" (any separator accepted on input). */
export type Mac = string;
/** IPv4 address "192.0.2.10" or CIDR "192.0.2.0/24". */
export type Ipv4 = string;
/** "HH:MM" in quarter hours; "24:00" = end of day. Adapters may refuse finer steps. */
export type Clock = string;

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];

export type Vendor = 'omada' | 'unifi' | 'mikrotik';

// ---- schedules --------------------------------------------------------------------

export interface TimeWindow {
    days: Day[];
    from: Clock;
    to: Clock;
}

/**
 * When something applies, in the controller's local time zone.
 * - always: no schedule.
 * - during: the windows are the active times (e.g. "block 22:00-24:00").
 * - outside: the windows are the FREE times; the thing applies at every other time
 *   (e.g. a curfew given as the allowed play hours).
 * Adapters turn this into their own objects: Omada time-range profiles (at most 7
 * windows each, split as needed), UniFi schedules inside the policy, MikroTik one rule
 * per window (no ranges across midnight).
 */
export type Schedule = { kind: 'always' } | { kind: 'during'; windows: TimeWindow[] } | { kind: 'outside'; windows: TimeWindow[] };

// ---- networks and devices -----------------------------------------------------------

export interface Network {
    id: string;
    name: string;
    /** normal = routed LAN; guest = vendor guest semantics; vlanOnly = no gateway interface. */
    purpose: 'normal' | 'guest' | 'vlanOnly';
    /** 1-4094; 1 = the untagged default network. */
    vlan: number;
    /** Gateway address with prefix, e.g. "192.0.2.1/24". Absent for vlanOnly. */
    gateway?: Ipv4;
    dhcp?: { enabled: boolean; range?: { from: Ipv4; to: Ipv4 }; leaseMinutes?: number; dns?: Ipv4[] };
    ipv6: boolean;
    /** Devices on this network can't start connections to other networks. */
    isolated: boolean;
    /** The controller, this server or another management device lives here (see ProtectedResources). */
    protected: boolean;
}

export interface Reservation {
    mac: Mac;
    ip: Ipv4;
    network: Ref;
    description?: string;
}

/** A device as seen right now; used for lock-out checks and "who is on this port/Wi-Fi". */
export interface Client {
    mac: Mac;
    name?: string;
    ip?: Ipv4;
    network?: Ref;
    wifi?: Ref;
    port?: PortRef;
    online: boolean;
}

// ---- Wi-Fi --------------------------------------------------------------------------

export type Band = '2.4' | '5' | '6';
export type WifiSecurity = 'open' | 'wpa2' | 'wpa3' | 'wpa2wpa3';

/**
 * Wi-Fi passwords are never a tool argument and never returned (owner's decision,
 * 2026-10-08: the real password is set in the controller's web UI):
 * - temporary: the adapter sets a random throwaway password that nobody knows, and the
 *   plan's effects tell the owner to set the real one in the web UI;
 * - unchanged: keep the current one (updates only).
 */
export type PassphraseSource = { kind: 'temporary' } | { kind: 'unchanged' };

export interface Wifi {
    id: string;
    name: string;
    network: Ref;
    bands: Band[];
    security: WifiSecurity;
    /** Protected management frames. */
    pmf: 'off' | 'optional' | 'required';
    clientIsolation: boolean;
    hidden: boolean;
    /** 802.11r. */
    fastRoaming: boolean;
    macFilter?: { policy: 'allow' | 'deny'; group: Ref } | null;
    enabled: boolean;
}

// ---- switch ports -------------------------------------------------------------------

export interface PortRef {
    /** Switch by id, name or MAC. */
    device: Ref | { mac: Mac };
    port: number;
}

export interface PortProfile {
    id: string;
    name: string;
    /** Untagged network (the port's PVID). */
    native: Ref;
    tagged: Ref[] | 'all' | 'none';
    isolation: boolean;
}

export interface Port extends PortRef {
    profile?: Ref;
    /** What the port carries right now (clients, an access point, the gateway uplink...). */
    seen: Client[];
    uplink: boolean;
}

// ---- groups and rules -----------------------------------------------------------------

export interface Group {
    id: string;
    name: string;
    kind: 'address' | 'mac';
    entries: Array<{ value: Ipv4 | Mac; name?: string }>;
}

/**
 * Who or what a rule matches. Adapters build what their vendor lacks: e.g. Omada has
 * no per-device match, so { device } becomes a reservation + a one-address group.
 */
export type Selector =
    | { network: Ref }
    | { device: Mac }
    | { group: Ref }
    | { addresses: Ipv4[] }
    | { wifi: Ref }
    | { internet: true }
    | { gateway: true };

export interface Rule {
    id: string;
    name: string;
    action: 'allow' | 'block';
    from: Selector[];
    to: Selector[];
    /** Vendors number protocols differently, so the model names them. */
    protocol: 'any' | 'tcp' | 'udp' | 'icmp' | { tcpUdpPorts: string };
    /** allow = replies to connections started on the other side still pass (stateful). */
    replies: 'allow' | 'match';
    schedule: Schedule;
    enabled: boolean;
    /** 1 = evaluated first. */
    position: number;
    /** Rules found on the controller that this model can't express faithfully (shown read-only). */
    foreign?: { reason: string };
}

// ---- capabilities ---------------------------------------------------------------------

/** native = one vendor object; emulated = the adapter builds and owns several; unsupported = refused. */
export type Support = 'native' | 'emulated' | 'unsupported';

export interface Capabilities {
    vendor: Vendor;
    networks: { create: Support; isolation: Support; ipv6: Support; guestPurpose: Support };
    wifi: { create: Support; bands: Band[]; security: WifiSecurity[]; pmf: Support; fastRoaming: Support; bandSteering: 'perWifi' | 'site' | 'unsupported' };
    ports: { profiles: Support; assign: Support };
    rules: {
        between: Support; // network to network
        toInternet: Support;
        deviceMatch: Support; // { device: Mac }
        wifiMatch: Support;
        stateful: Support;
        schedule: Support;
        /** Most windows one vendor schedule object holds (Omada 7); the adapter splits above it. */
        windowsPerObject?: number;
    };
    groups: { address: Support; mac: Support };
    reservations: Support;
    mdnsRepeater: Support;
}

/** Things no change may cut off: where the controller, this server and their uplinks live. */
export interface ProtectedResources {
    networks: Ref[];
    ports: PortRef[];
    devices: Mac[];
}

// ---- changes, plans, results ------------------------------------------------------------

type CreateOf<T> = Omit<T, 'id' | 'protected' | 'foreign' | 'position'> & { position?: number };
type UpdateOf<T> = { ref: Ref; set: Partial<CreateOf<T>> };

export type Change =
    | { op: 'create'; kind: 'network'; value: CreateOf<Network> }
    | { op: 'update'; kind: 'network'; value: UpdateOf<Network> }
    | { op: 'delete'; kind: 'network'; ref: Ref }
    | { op: 'create'; kind: 'wifi'; value: CreateOf<Wifi>; passphrase: PassphraseSource }
    | { op: 'update'; kind: 'wifi'; value: UpdateOf<Wifi>; passphrase?: PassphraseSource }
    | { op: 'delete'; kind: 'wifi'; ref: Ref }
    | { op: 'create'; kind: 'portProfile'; value: CreateOf<PortProfile> }
    | { op: 'delete'; kind: 'portProfile'; ref: Ref }
    | { op: 'assign'; kind: 'port'; port: PortRef; profile: Ref }
    | { op: 'create'; kind: 'rule'; value: CreateOf<Rule> }
    | { op: 'update'; kind: 'rule'; value: UpdateOf<Rule> }
    | { op: 'delete'; kind: 'rule'; ref: Ref }
    | { op: 'move'; kind: 'rule'; ref: Ref; position: number }
    | { op: 'create'; kind: 'group'; value: CreateOf<Group> }
    | { op: 'delete'; kind: 'group'; ref: Ref }
    | { op: 'set'; kind: 'reservation'; value: Reservation }
    | { op: 'delete'; kind: 'reservation'; mac: Mac }
    | { op: 'set'; kind: 'mdnsRepeater'; enabled: boolean; networks: Ref[] };

/** One vendor-level step of a plan, in the order it will run. Never contains secrets. */
export interface Step {
    action: 'create' | 'update' | 'delete';
    /** Vendor object type, e.g. "omada.timeRange", "unifi.firewallPolicy", "mikrotik.ip/firewall/filter". */
    object: string;
    name: string;
    detail?: string;
}

export interface Plan {
    change: Change;
    vendor: Vendor;
    steps: Step[];
    /** Plain-language effects ("node-s55: devices not on KnownWiFi can no longer join"). */
    effects: string[];
    /** Online devices this change would disconnect or block. apply() refuses unless allowLockout. */
    wouldLockOut: Client[];
    /** Opaque fingerprint of everything the plan read; apply() refuses if it changed meanwhile. */
    basis: string;
}

export interface ApplyResult {
    applied: true;
    /** The neutral object after the change (redacted), when there is one. */
    object?: Network | Wifi | PortProfile | Rule | Group | Reservation;
    /** Vendor objects created for this change; tagged so delete() removes them all again. */
    owned: Array<{ object: string; id: string }>;
}

export type NetErrorCode =
    | 'NOT_FOUND'
    | 'AMBIGUOUS' // a name matches several objects
    | 'EXISTS'
    | 'IN_USE' // delete refused: `users` lists what references it
    | 'PROTECTED' // would touch a ProtectedResources entry
    | 'LOCKOUT' // would cut off online devices, allowLockout not set
    | 'UNSUPPORTED' // `capability` names what the vendor lacks
    | 'LIMIT' // a vendor limit that can't be split around
    | 'CONFLICT' // the controller changed after the plan; nothing was written
    | 'INVALID';

export class NetError extends Error {
    constructor(
        readonly code: NetErrorCode,
        message: string,
        readonly details: { users?: string[]; clients?: Client[]; capability?: string } = {}
    ) {
        super(message);
        this.name = 'NetError';
    }
}

// ---- the adapter contract -----------------------------------------------------------------

/**
 * What every vendor adapter implements. The net_* tools are thin: each builds a Change,
 * calls plan(), returns the plan for a dry run, otherwise apply(). Validation that is
 * the same for every vendor (clock format, overlapping windows, VLAN range) lives in
 * the shared model, not in adapters.
 *
 * Ownership: objects an adapter builds for one neutral object (Omada's reservation +
 * IP group + time ranges + split rules for a device curfew) carry a tag in a free-text
 * field (name, description or comment: "[net:<id>]"), so they are found, listed as one
 * thing and removed together without a database.
 */
export interface NetworkController {
    readonly vendor: Vendor;
    /** Which controller/site this adapter speaks to (several may be configured). */
    readonly id: string;

    capabilities(): Promise<Capabilities>;
    protectedResources(): Promise<ProtectedResources>;

    listNetworks(): Promise<Network[]>;
    listWifi(): Promise<Wifi[]>;
    listPortProfiles(): Promise<PortProfile[]>;
    listPorts(device?: PortRef['device']): Promise<Port[]>;
    listRules(): Promise<Rule[]>;
    listGroups(kind?: Group['kind']): Promise<Group[]>;
    listReservations(): Promise<Reservation[]>;
    listClients(): Promise<Client[]>;
    getMdnsRepeater(): Promise<{ enabled: boolean; networks: Ref[] }>;

    /** Read-only: validates, resolves refs, checks protection, in-use and lock-out. Throws NetError. */
    plan(change: Change): Promise<Plan>;
    /** Runs a plan; re-checks `basis` first (CONFLICT) and lock-out (LOCKOUT unless allowLockout). */
    apply(plan: Plan, options?: { allowLockout?: boolean }): Promise<ApplyResult>;
}
