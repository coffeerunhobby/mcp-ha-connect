### 2.5.1
- **New: firmware in the `net_` tools.** `net_listFirmware` (QUERY) lists what each network device runs and, when the vendor offers one, the newer version with its release notes and size, and whether the tools can install it. `net_upgradeFirmware` (**ADMIN**) installs that version; registered in eager and graph mode, `net_capabilities` reports `firmware`.
  - **Ruijie / Reyee:** the router's own Online Upgrade (`/api/system` `getVersion`, then `upgradeConfirm` with the download address the router was offered and `isPersist` so it keeps its settings), mapped from the router's page and read live on a RG-EG105G-V3 offered ReyeeOS 2.430 (2026-10-24). Only an offer other than the running version counts, and only from Ruijie's own download servers (`*.ruijienetworks.com`); the address is never an argument, so nothing else can be handed to the router. The dry run shows the current and new version, the size, the release notes and every device on the router's LAN as cut off while it restarts. Applying **always** needs `allowLockout` and the dry run's `basis`, also when no device is seen online (the router itself goes away); the basis is a fingerprint of the router (controller and MAC; a router that doesn't report its MAC is refused), the versions, the download address and checksum, and those devices, so anything changed since, another router behind the same address included, is a CONFLICT with nothing sent. An unanswered upgrade is never reported as done: when the request certainly didn't reach the router (connection refused, no route, TLS rejected, or a refused session whose new login failed) it is a plain failure; otherwise (no answer, or an answer that broke off or was cut short) the outcome is unknown (it may be restarting into the upgrade) and the error says to check `net_listFirmware` in a few minutes before trying again.
  - **Omada:** firmware is listed per device (model and running version; whether a newer one exists needs the controller's own check first). Upgrades are refused (UNSUPPORTED) until the Open API's online upgrade is live-tested; use the controller web UI.
- README: the firmware tools (83 tools in total).
- +19 tests (the offer from a recording of the real router, the trusted download hosts, the listed firmware, the planned upgrade, its lockout (also with nobody online, through the tool), basis, router identity and conflicts, unanswered upgrades, the refusals; `/api/system` calls, a failed upgrade, and requests that certainly weren't sent, answers that break off; the Omada firmware list and refusal; ADMIN for the upgrade; mutation-checked).

### 2.5.0
- **New: Ruijie / Reyee routers in the `net_` tools (read-only).** A second adapter next to Omada, for Ruijie's local eWeb API (the JSON API the router's own web page uses), mapped on a RG-EG105G-V3 with ReyeeOS 2.324. `net_listNetworks`, `net_listClients`, `net_listPorts`, `net_listRules` and `net_capabilities` work on it, and DHCP reservations are read for the model. Every change is refused (UNSUPPORTED) in this version: reservations and rules come next, then networks, each live-tested before release.
  - **What maps how:** LAN networks (`network` lan entries: address, mask, VLAN, DHCP; the default LAN carries Ruijie's internal VLAN 233, untagged), clients (the devices the router sees on its LAN right now, from its ARP table, named by their address lease; a lease alone is no online device, and the router's WAN-side neighbours are left out), reservations, ports (the WAN port is the protected uplink; the router doesn't say which device is on which port) and access-control rules in list order. Rules the model can't say faithfully (a source "anywhere", source ports, IPv6, user groups, schedules, a rule matching only some connection states, an address range, addresses or a device match limited to an interface they don't imply, ports for TCP or UDP only, TCP and UDP without ports) are shown as `foreign` with the reason: a rule is never listed as matching more, or something else, than it does. No Wi-Fi on this model, no port profiles or mDNS repeater; Ruijie's user groups come later.
  - **The client:** logs in like the router's page (username always `admin`, the password GibberishAES-encrypted with the page's key), keeps the session id and cookie, sends the page's checksum headers, and logs in again once when the router answers that the session expired (`code 2`). **A refused login is never retried** (wrong passwords lock the router's login): the client switches itself off with the reason, its tools refuse, and the start-up check stops; only an unreachable router is tried again. The session id is never logged or put in an error, and the router's own error text never reaches an error message either (only its numeric code): it could carry a URL, the session id or a password. HTTPS with a TLS setting for this client only (`RUIJIE_STRICT_SSL=false` for a self-signed certificate); plain `http://` works but logs a warning, because the page's password encryption uses a key shipped in the page itself.
  - **New settings:** `RUIJIE_PLUGIN_ENABLED`, `RUIJIE_BASE_URL`, `RUIJIE_PASSWORD`, `RUIJIE_STRICT_SSL`, `RUIJIE_TIMEOUT`.
- **New: a `controller` argument on every `net_` tool** when several controllers are configured (`omada` or `ruijie`; the schema takes only the configured ones). Without it Omada answers when configured, else the only one. Each call keeps its own choice, also in parallel; a value without a controller behind it is refused, never answered by another.
- **Fix — `net_createWifi` put new Wi-Fi networks on a gateway without a radio.** It copied the device selection (`deviceType`) from the site's first Wi-Fi network; with that one on access points and gateway (3) and an ER605 (no radio), the new network could not even be saved in the controller web UI ("The current Gateway does not support 2.4 GHz"; live, 2026-10-21). Now a new Wi-Fi network goes on the access points when the site has any, and on the gateway only when it reports a radio (`wirelessRouter`); with neither it is refused. A change of either between the dry run and the apply is a CONFLICT.
- **Security — dependencies bumped:** `undici` 6.29.0 → 6.29.1 (GHSA-4qv8-2p9j-2685 unbounded memory in the EventSource parser, GHSA-xjj6-f33q-929c unhandled error on excessive content-encodings) and `zod` 4.6.5 → 4.6.7 (GHSA-mrhx-c7xc-m3w5 memory exhaustion validating oversized constrained collections), all high and published while 2.5.0 was in CI; the release's audit gate caught them.
- Session ids in URLs (`auth=`, `sid=`) are now masked by the log redaction too.
- Test fix: the expired-token test made a token that expired exactly at the auth middleware's 60 s clock skew, so it passed whenever the check ran at a whole second (a 1-in-1000 flake); it now expires 120 s ago.
- README and `.env.example`: the Ruijie router and the `controller` argument.
- +49 tests (the GibberishAES format against an OpenSSL vector, the page key and checksum headers; the client's login, session, renewal on expiry, the never-retried refused login and the lock, parallel logins, unreachable and timed-out routers, nested answers, unknown modules and failed writes; the adapter on sanitized recordings of the real router and every foreign rule shape; the controller argument, its routing in parallel and its refusal; the Ruijie start-up check; the settings; the Wi-Fi device selection; mutation-checked).

### 2.4.8
- **New: which network each device is on, switch ports, and the mDNS repeater (`net_`).** Six tools: `net_listClients`, `net_listPortProfiles`, `net_listPorts`, `net_assignPort`, `net_getMdnsRepeater`, `net_setMdnsRepeater`. Reads need QUERY, changes CONFIGURE; every change has a `dryRun` and is re-checked against the controller before it is written (CONFLICT if what it depends on changed meanwhile). Registered in eager and graph mode. `net_capabilities` now reports port assignment and the mDNS repeater as native.
  - **Clients and their network.** Omada reports wireless clients with VLAN 0 and no network name, so "what is on VLAN 2?" could only be guessed from addresses. `net_listClients` lists the online devices with the network and VLAN each is on: wired ones by their VLAN, wireless ones by their address, and a wireless device without an address yet by the network its Wi-Fi puts it on (when that is one network). It also shows the Wi-Fi network or the switch port, and can list one network only. `omada_listClients` points to it.
  - **Ports.** `net_listPorts` shows the networks each switch port carries (untagged and tagged), its profile, the online devices on it, whether it is an uplink, and why it is protected; `net_listPortProfiles` shows the profiles, with their networks when a profile sets them. `net_assignPort` sets the networks a port carries: its untagged network and optionally tagged ones (`all`, `none` or a list), keeping its name, profile and other settings; then reads back what it carries and reports anything else (CONFLICT).
  - **Why a port's own networks and not its profile:** on controller 6.3 (live, 2026-10-20) port profiles can leave the VLANs out (`vlanConfigEnable` off: all five on the test site), the controller refuses to put a port on such a profile ("The profile with vlan configuration disabled cannot be bound to ports"), and refuses to put a port back on its profile's networks once it has its own. So a port gets its own networks (`PATCH .../switches/{mac}/ports/{port}` with `profileVlanOverrideEnable`), and what it carries is read from each network's list of ports (`GET .../networks/{id}/vlan/{vlan}/ports`), whatever set it. If those lists contradict each other (a switch listed twice, two native networks, a network both tagged and untagged), what the port carries counts as unknown and every device on it as cut off.
  - **Protected ports, refused (PROTECTED) whatever `allowLockout` says:** uplinks, from the controller's site topology: the switch's own link upwards and the port of every adopted device below it (switches, access points, a hardware controller). If the topology can't be read, is incomplete or contradicts itself (a device the controller manages missing from it, a device listed twice, a device other than the gateway not linked upwards exactly once or with no path up to the gateway, a link to or from a device it doesn't describe, a device below reporting two different ports, a port the switch doesn't have), or can't tell a switch's uplink, no port of that switch is changed. Also refused: the ports the controller and this server are on (by address), and link aggregation ports. **New setting `MCP_SERVER_ADDRESSES`:** the LAN address(es) of the machine this server runs on (for Docker: the host's). Every `net_` change protects it like the controller: its switch port, its network (VLAN and gateway never change, never deleted; a server address that can't be resolved protects every routed network, as for the controller) and its internet access (a rule that could cut it off is refused). While it is unset, or the controller's or this server's address can't be resolved, or is inside the site's networks but not seen on a switch port (Wi-Fi or straight on the gateway don't tell which port it hangs off), ports with devices on them are left alone; empty ports can still be assigned. A port with its own settings for everything (profile override) is refused too (UNSUPPORTED); change it in the web UI.
  - **Devices cut off.** A device on the port keeps working only if its network reaches it the same way (as the native network, as a further untagged one, or tagged) before and after; otherwise, or when its network is unknown, it is listed and the change needs `allowLockout`.
  - **mDNS repeater.** The model's repeater is the controller's one gateway mDNS rule repeating between the same networks both ways. `net_setMdnsRepeater` switches it on or off or changes its networks (at least two existing, routed ones, also when the rule's own networks are kept), keeping the rule's name and the services it repeats, then reads it back (the same rule, name, services, status and networks). There must already be a rule (create it once in the web UI with the services to repeat); access point rules, several rules or a one-way rule are shown as `foreign` and left to the web UI.
  - **Network delete** is now also refused while a switch port or LAG carries the network untagged (its devices would be left without a network), naming the switch and ports, or while a switch's port lists for the network can't be read.
  - **Not here:** creating or deleting port profiles (the controller web UI; refused with that pointer), further untagged networks besides the native one.
  - Paths and bodies are from TP-Link's Open API reference, checked on the live controller (6.3.0.45, 2026-10-20). **Live-tested:** the mDNS write (Engineering out of the repeater and back: stored as sent, rule identical afterwards) and the port write (a TV's port to IoT only and back: carried exactly that at once, then the original networks again). `net_assignPort` end to end on that port: the dry run named the TV as cut off, applying without `allowLockout` was refused, with it the port carried IoT only (read back and listed), and back to Default + all tagged it carried exactly what it did before. The port write needs the port's name (-39855 without it).
- **Fix — `allowLockout` could cut off more devices than the dry run showed.** A dry run and the apply are separate calls, and the apply planned afresh: a device that joined in between (a Wi-Fi network being deleted, a network being changed, a port being reassigned) was cut off too, without being in the preview that was agreed to. Now a dry run returns its `basis`, a fingerprint of the change and of what it read, including the devices it cuts off (no secrets in it). Every `net_` change accepts it back and is refused (CONFLICT, nothing written) if it is another change (another port, other networks: a basis vouches only for the change its dry run was for), or the controller or those devices changed since. **`allowLockout` now requires the basis**, so devices are only cut off when they are the ones the dry run showed. Inside the adapter the same check covers the moment between planning and writing.
- **Security — MCP SDK bumped** (`@modelcontextprotocol/server` 2.2.0 → 2.3.1, `@modelcontextprotocol/node` 2.1.0 → 2.1.1, dev `@modelcontextprotocol/client` 2.3.1) for three high advisories published 2026-10-21 (GHSA-jm63-cq47-j5jp shared transport/server instances, GHSA-46jr-4wx8-v453 memory exhaustion during request validation, GHSA-rvq5-wwqv-78pq SDK bearer auth). This server already creates a fresh server and transport per request and does its own JWT auth (not the SDK's), so the request-validation one is the one that applied; the release's audit gate caught it.
- `omada_createGatewayAcl`'s refusal of LAN destinations now points to `net_createRule` (instead of "comes in 2.4.7").
- README: the port, client and mDNS tools are listed (81 tools in total).
- +74 tests (a dry run's basis checked on apply, bound to its change and required with allowLockout; this server's network protected in network and rule changes (also when its address can't be resolved); a plan whose devices to cut off changed is refused; MCP_SERVER_ADDRESSES from the environment to the adapter; the client network for wired and wireless clients; port profiles, what a port carries from the networks' port lists (and when that can't be told), uplinks from the topology, protection, who a port change cuts off, the port write body, conflicts, read-back; network delete refused while a port carries it untagged; the mDNS rule mapping, refusals, conflicts and read-back; the raw switch, port, profile, network-ports, topology and mDNS endpoints through the real request handler; the tools' input mapping and permissions; mutation-checked).

### 2.4.7
- **New: `net_` rules — allow or block traffic between your networks, to addresses on given ports, or to the internet.** Six tools: `net_listRules`, `net_createRule`, `net_updateRule`, `net_deleteRule`, `net_moveRule`, `net_listGroups`. Reads need QUERY, changes CONFIGURE; every change has a `dryRun` and is re-checked against the controller before it is written (CONFLICT if the rules changed meanwhile). Registered in eager and graph mode.
  - **On Omada they are gateway ACLs** (the gateway routes between the VLANs): LAN→LAN between networks or towards addresses on your networks, LAN→WAN towards the internet. `net_capabilities` now reports rules between networks, to the internet and stateful as native.
  - **Stateful.** A block rule stops new connections; replies to connections started from the other side still pass, so "block IoT → Home" leaves Home able to reach IoT. On the ER605 this is Omada's default ("Auto" states): TP-Link's one-way VLAN guide for this router does exactly that. Rules that would also match replies are refused, since Omada's manual connection states are unverified.
  - **Tags.** Every rule made through `net_` ends its description with a unique tag `[net:<key>]` (visible in the controller web UI, hidden in `net_` names), so it is found again and undone by it, never mistaken for a rule made elsewhere at the same moment. Names can't contain `[net:`.
  - **Addresses and ports.** Addresses given in a rule (e.g. "IoT may reach 192.168.0.19 on 1883, 8123") become an IP group, or IP-port group, that the rule owns. Its name is the rule's tag plus `from`/`to` and a 64-bit random part checked to be unused before the group is created (only groups named exactly so count as owned, and `omada_createGroup` now refuses names starting with `[net:`); shown in the rule as plain addresses, replaced when the addresses or ports change, and removed with the rule. If the controller refuses the rule, the group just made is removed again. Single ports only; ranges are refused. A group a rule owns is never used by another rule (naming it in a rule is refused); if a rule made elsewhere still points at it, it stays until that last user is gone.
  - **A change that fails part-way is undone.** A rule that has to move is created switched off, moved, then switched on, so it never acts from the wrong place; a rule that is changed and moved in one update is written switched off, moved, then switched on. If any step fails, the new rule and the groups made for it are removed; a failed update or move puts the rule back exactly as it was, order included (also when the controller did the reorder but its answer got lost); when both content and order have to go back, the rule is switched off first, so neither version acts from the wrong place. A change whose final read-back fails is reported as applied, with a warning; so is a delete whose answer was lost once the rule is seen gone (and a delete that can't be confirmed says so). A create or group whose answer got lost is looked up by its unique description or name and removed. When that can't be confirmed, nothing a live rule might use is deleted, and the error says what to check.
  - **Order.** Rules are checked in order and the first match decides. A new rule goes last unless a position is given; `net_moveRule` reorders, and moving also works for rules the model can't otherwise express.
  - **The controller stays online.** Every change is checked against the whole rule list it produces, and the list it passes through when it is staged. The check looks at the rules that may apply to the controller's (and this server's) own internet traffic, in the order the gateway checks them: enabled, towards the internet, with a source that may hold the controller (also when that can't be read, or the controller's address can't be resolved), whatever destination, protocol or schedule they name. Among those, a change may only add allows and remove blocks; a new or changed block, a removed or changed allow (e.g. an exception for its DNS servers in front of a block of them), or a different order among them is refused (PROTECTED), with the reason. Rules after a complete exception for the controller (everything, all protocols, no schedule, its address surely included) never apply and don't count, so the whole Home network may be blocked below such an exception, and one other device on that network (a curfew) may always be blocked. The check is waived only when the controller is certainly cut off already (a complete block of it, with no exception in front).
  - **Cleanup heals itself.** After every successful rule change, groups a rule owned that no gateway, switch or access point ACL uses any more are removed. If that fails, the change still succeeds with a warning, and the next rule change finishes the cleanup.
  - **Rules made elsewhere** (web UI, `omada_` tools) are listed. Those the model can't express faithfully are marked `foreign` with the reason, and are never changed or deleted through `net_`: inbound WAN/VPN rules, rules with a schedule, manual connection states, a source with ports, a destination port group made elsewhere, other endpoint types, a destination group whose addresses don't match the rule's direction (editing would recompute it), or a LAN network as the destination of a LAN to internet rule.
  - **Refused, with the reason:** the gateway itself as a destination (gateway ACLs filter traffic passing through it; the API has no option for its own addresses), one device by MAC (give its address), a Wi-Fi network as the source (`omada_createGatewayAcl` does it for internet rules), schedules (the `omada_` time-range tools), mixing kinds of source or destination in one rule, a network on both sides, a switch-only network, addresses that mix your networks and the internet, ports towards the internet (only verified between networks), and anything that would cut the controller off the internet (below).
  - **Verified on the live controller** (6.3.0.45, ER605 v2), with the owner's approval and nothing left behind: before writing the code, a switched-off LAN→LAN rule between two networks, an IP-port group (`portType` is required) and a switched-off rule towards it were created, read back and deleted. After it, the release's own code ran end to end: `net_` created the switched-off rule "IoT may reach 192.168.0.19 on 1883, 8123" (stored as LAN→LAN, `protocols [6,17]`, IP-port group, Auto states), read it back as the same rule, and deleted it together with its group.
- `net_createNetwork`/`net_updateNetwork` refuse `isolated` with a pointer to block rules (instead of "comes in 2.4.7").
- README: the rule tools are listed (75 tools in total).
- +105 tests (the Omada adapter against the stateful fake controller: request bodies, owned groups and their tags, rollback when the controller refuses or an answer is lost (create, group, move, update, a reorder that happened but reported an error), the controller staying online in every state, staged updates, groups still used by switch ACLs, cleanup warnings, every refusal leaving the controller untouched, rules made elsewhere and foreign ones, switching on a rule kept as is, ports changed or dropped, renames keeping the tag, moves, conflicts; the raw gateway ACL and group endpoints through the real request handler (method, encoded path, body, errors); the tools' input mapping, permissions and strict selectors; mutation-checked).

### 2.4.6
- **Fix — the server crash-looped when Home Assistant was unreachable at startup.** It checked HA once at boot and exited if HA didn't answer; during the NAS network outage of 2026-10-17/18 the container restarted 100 times and served nothing, Omada included. Now an upstream that doesn't answer at startup (Home Assistant, the Omada controller or the AI provider) no longer stops the server: its client is kept, its tools stay registered and fail cleanly until it answers, `/health` keeps answering, and a background probe retries with a growing pause (5 s doubling to 60 s), logging `Connected to …` once it does. Before, an unreachable Omada controller or AI provider at boot also left their tools off until the next restart. Startup logic moved to `src/upstreams.ts`.
  - `OMADA_SITE_ID` is still checked against the controller's sites. Invalid at startup: the Omada plugin is off, as before. If the controller was unreachable at startup, the check runs once it answers; an invalid site found then switches the Omada client off (`OmadaClient.disable()`), so every Omada call refuses with a pointer to the log, which lists the valid sites.
  - Still refused at startup, as before: a missing `HA_URL`/`HA_TOKEN` or Omada setting.
- **Fix — `omada_createGatewayAcl` accepted rules that could never match.** It makes LAN to internet rules only, but accepted a LAN network as the destination (e.g. source IoT, destination Default). Such a rule looks like an inter-VLAN block and blocks nothing: traffic between the site's own networks never meets a LAN to internet rule. It now refuses a LAN network as the destination, and an IP group with an entry inside a LAN subnet, saying why and where rules between networks are made (the controller web UI today; the `net_` rule tools in 2.4.7). A group that reaches beyond the LANs (e.g. 10.0.0.0/8) is still accepted. `omada_updateGatewayAcl` applies the same check to every LAN to internet rule an update leaves switched on, also when the update only switches it on or changes its policy, so a never-matching rule made earlier can't be presented as protection; switching such a rule off, or deleting it, still works. A LAN to LAN rule made in the web UI can still be pointed at a network.
- Planned releases renumbered (the owner chose these two fixes first): `net_` rules come in 2.4.7, switch ports and the mDNS repeater in 2.4.8; the "not yet" messages and the README say so.
- +16 tests (startup with each upstream down, the backoff schedule with the production pauses on a simulated clock, the late site check, `disable()`; the gateway ACL destination checks on create and update, including switching on an old never-matching rule; mutation-checked).

### 2.4.5
- **Security — Wi-Fi passwords reached the server log at debug level.** The Omada HTTP layer logs request and response bodies with `LOG_LEVEL=debug`, and its scrubber knew only auth-like names, so an SSID detail (`omada_read /wifi/ssids`, and now every `net_` Wi-Fi read and update) logged the Wi-Fi password, and RADIUS/VPN keys likewise. Long secrets it did recognize were logged with their first and last four characters. It now uses the same secret-name list as the tool responses and masks secrets completely. Normal operation (info level) was not affected.
- **New: vendor-neutral `net_` tools, first part: networks and Wi-Fi.** They speak one shared model (`src/net/model.ts`) with an adapter per controller vendor, so the same calls will work for UniFi and MikroTik later; today the Omada adapter is the only one. Nine tools: `net_capabilities`, `net_listNetworks`, `net_createNetwork`, `net_updateNetwork`, `net_deleteNetwork`, `net_listWifi`, `net_createWifi`, `net_updateWifi`, `net_deleteWifi`. Reads need QUERY, changes CONFIGURE; registered in eager and graph mode.
  - **Plan, then apply.** `dryRun` returns the vendor steps, their effects in plain words and the online devices a change would cut off, without writing. Applying re-reads the controller and refuses (CONFLICT) if anything it depends on changed since the plan, and refuses (LOCKOUT) to cut devices off without `allowLockout`. Writes share the per-site lock of the Omada access control tools.
  - **Capabilities.** Each adapter states per feature whether it is native, built from several objects, or unsupported, and refuses unsupported requests with the reason instead of dropping them. On Omada that is: network isolation (comes as rules in 2.4.6), a "guest" network type (Omada does guest per Wi-Fi network), switching IPv6 on, WPA2/WPA3 mixed mode, and switching a Wi-Fi network on or off (`omada_setSsidEnabled` does that).
  - **Networks.** Create a routed VLAN (gateway, DHCP range, IPv6 off) or a switch-only one (which takes no gateway or DHCP, on create or update); refuses a VLAN, name or overlapping subnet in use, a gateway on the network or broadcast address, a DHCP range outside the subnet or over the gateway. Switching IPv6 off on a network devices are on needs `allowLockout` (they lose their IPv6 addresses). The primary network and the one the controller is on are protected (a controller host name is resolved; if it can not be, every routed network is treated as protected): their VLAN and gateway never change and they can't be deleted. A DHCP change names only what changes (DNS servers given replace the old ones; an empty list means automatic; every address pool stays unless a range is given, and each is checked against a new gateway): the range, lease, DNS and anything the model does not describe (custom options, next server) stay as they are. A new gateway is refused when the kept DHCP range does not fit it; the router address DHCP hands out follows the gateway, and a custom one outside the new subnet is refused. Delete is refused while a Wi-Fi network (any network it maps to), port profile, DHCP reservation or gateway/switch/access point rule (every page of each list) uses the network, and lists those users.
  - **Wi-Fi.** Create an SSID that puts its devices on a network (tagged into its VLAN; never a switch-only one, on create or update), with bands, WPA2 or WPA3, PMF, client isolation, hidden, 802.11r and a MAC allow/deny list. An open network with a MAC filter is created locked and opened only once its filter is in place, so it is never open without it; likewise an update that leaves a Wi-Fi network open (opening it, or moving it while open) installs its new filter first. Moving a Wi-Fi network mapped to several networks onto one of them narrows the mapping. A plan that uses a MAC group is refused at apply time if that group was renamed or replaced meanwhile. Every security mode a controller can report is named (legacy WPA and WPA/WPA2, Enterprise, PPSK as well as open, WPA2, WPA3), so a request for WPA2 really changes a legacy WPA/WPA2 network; Enterprise and PPSK networks are left to the web UI unless their security is replaced; replacing it with WPA2/WPA3 sets a temporary password (an old shared key is never revived). **Passwords are never taken or shown:** a new Wi-Fi network (or one reset with `newTemporaryPassword`) gets a random temporary password nobody knows, and the owner sets the real one in the controller's web UI. Updates resend the existing password internally; it never appears in a plan, step, error, fingerprint or log. Changes that disconnect devices (name, bands, network, security, PMF, password, a MAC filter leaving devices out) or cut them off from the other networks (switching on client isolation, Omada guest mode) need `allowLockout`; a Wi-Fi network switched off with `omada_setSsidEnabled` (its 24/7 radio-off schedule) is listed as off; the only Wi-Fi network can't be deleted.
- Shared IPv4 helpers (`src/utils/ipv4.ts`) replace the copies in the access control code; the Omada client exposes `resolveSiteId` and `controllerHost`.
- README: the `net_` tools are listed (69 tools in total).
- +73 tests (devices without an IPv4 address yet; the debug log never carrying a secret, even partly; the Omada adapter against a stateful fake controller: request bodies, every refusal leaving the controller untouched, protection, in-use, lock-out, conflicts, the password never leaking; the tools' permissions, dry run and input mapping; mutation-checked).

### 2.4.4
- **Security — the SIM PIN of a USB LTE modem was returned in plain text** by `omada_read /network/internet` (`usbLteSettings[].pin`), together with the ISP PPPoE login name and the LTE APN user name (passwords were already redacted). Every tool response now also redacts SIM PIN/PUK fields (`pin`, `simPin`, `pinCode`, `puk`, `puk2`...) and, inside dial-up and VPN sections (PPPoE, L2TP, PPTP, LTE/APN, VPN), account user names, also when a VPN read returns a bare list of accounts (`omada_read` passes the resource path as context). Ordinary names elsewhere (Home Assistant users, devices, profile names) stay readable, and so do fields like `pinEnable`, `ping` or `mapping`.
- Checked live: every readable `omada_read` node (51, parameterized ones included) was read and scanned for credential-like fields that came back unredacted; these three were the only ones.
- +4 tests (the internet settings shape, a VPN section, an unwrapped VPN list through `omada_read`, names left alone; mutation-checked).

### 2.4.3
- **Fix — `omada_createTimeRange` / `omada_updateTimeRange` sent schedules the controller cannot hold.** An Omada time range holds at most 7 windows (seen on the OC200: 7 accepted, also two on one day; 8 refused with "The number of time range per entry has reached the limit"). An inverted curfew needs two windows on most days, so it always failed with that message. The tools now refuse such a schedule before calling the controller and say how to split it: one time range for the mornings, one for the evenings, each with its own rule (how the live curfew was built). The tool descriptions say so up front.
- README: the limit is noted.
- +4 tests (the limit at 7/8, the refusal without a controller call, the morning profile via `invertWindows`; mutation-checked).

### 2.4.2
- **Fix — `omada_deleteTimeRange` still failed with "Invalid request parameters"; so did `omada_setSsidMacFilter` and deleting a MAC group.** The real cause: Omada lists every SSID a second time under a pseudo WLAN group `gateway`, which has no SSID detail. Every check that reads SSID details (time range used by a Wi-Fi schedule, MAC group used by an SSID filter, the SSID filter itself) now reads each SSID once, in its real WLAN group. `omada_setSsidEnabled` skips the pseudo group too. **Correction:** 2.4.1 blamed the switch ACL page size; that was a misread log line. Its smaller page size is harmless and stays. Nothing was ever deleted by the failed calls: the checks run before any write.
- +1 test, and the fake controller in the access control tests now lists the pseudo group first, like a worst case of the real one (mutation-checked).

### 2.4.1
- **Fix — `omada_deleteTimeRange` failed with "Invalid request parameters".** Its check for switch ACL rules using the profile read the switch ACL list with 200 rules per page, which the controller rejects; it now asks for 50 (the paginated reader accepts a smaller page size for such endpoints). Nothing was deleted by the failed calls: the check runs before the delete. Found in the live test of 2.4.0, which otherwise confirmed the access control tools against the controller (a time range with two windows on one day, a scheduled gateway deny rule stored with its `timeRangeId`, disabling, refusals for objects in use, deletes).
- +3 tests (the page size override and the switch ACL read; mutation-checked).

### 2.4.0
- **New: controller-side access control**, so a schedule such as a curfew is enforced by the Omada controller itself instead of a daily block/unblock loop (which can leave an orphaned block). All writes need **CONFIGURE**, are typed, accept names or ids, and say what they changed. Changes made through this server, MAC group edits included, are applied one at a time per site (Omada replaces whole objects, and rules, schedules, groups and SSID filters reference each other), and a gateway ACL update re-reads the rule just before writing: if it changed meanwhile (e.g. in the web UI), nothing is written.
  - **Time ranges:** `omada_createTimeRange`, `omada_updateTimeRange`, `omada_deleteTimeRange`. Windows are written as `{days: ["mon", ...], start: "14:30", end: "19:00"}` in quarter hours; `invertWindows` takes the allowed hours and covers everything else. Delete is refused while a gateway or switch ACL rule or an SSID Wi-Fi schedule uses the profile; the profile `omada_setSsidEnabled` relies on is never touched, and no other profile may take its name.
  - **Groups:** `omada_createGroup` (IP group: `a.b.c.d` = /32 or `a.b.c.d/n`; MAC group) and `omada_deleteGroup` (refused for built-in groups, `IPGroup_Any`, and groups a gateway ACL or an SSID MAC filter uses).
  - **DHCP reservations:** `omada_setDhcpReservation` (creates or changes; the LAN network is the one whose subnet holds the address; refuses an address reserved for another device) and `omada_removeDhcpReservation`.
  - **Gateway ACL:** `omada_createGatewayAcl`, `omada_updateGatewayAcl` (incl. enable/disable and dropping the schedule), `omada_deleteGatewayAcl`, `omada_moveGatewayAcl`. LAN to internet rules with an IP group, LAN network or SSID as source, the built-in `IPGroup_Any` as default destination, optionally only during a time range. The EAP (access point) ACL is not offered: it has no schedule and cannot match MAC groups.
  - **SSID MAC filter:** `omada_setSsidMacFilter` turns an SSID's allow or deny list (a MAC group) on or off. It lists the connected clients the change would disconnect and refuses then unless `allowLockout`; `dryRun` only reports. The check and the switch run under the same lock as MAC group edits, so an entry removed at the same moment cannot slip past it. An allow list also stops devices that join with a random MAC address.
  - **Reads:** `omada_listAccessControl` (eager mode) shows time ranges as readable windows, IP groups, and gateway ACL rules with names instead of ids. Graph mode gets `omada_read /profiles/ip-groups`.
- README: the access control tools are listed (49).
- +57 tests (schedule parsing and inversion incl. the full curfew week, every write against a stateful fake controller, refusals that leave the controller untouched, concurrent and conflicting ACL updates, a rule created while its time range is deleted, rules with endpoint types these tools do not edit, lockout detection, permissions; mutation-checked).

### 2.3.1
- **Privacy — the npm package ships only `dist/` and `.env.example`** (plus README, LICENSE, package.json). Earlier versions also published the sources, tests, CI files and Docker files (743 files, now 481).
- **Privacy — no real network details in the code.** The maintainer's LAN addresses, a device's MAC address and hostname, and an SSID name that had been used as examples in tests, code comments, a tool description, an error message, the README and `.env.example` are replaced with placeholders (`10.0.0.x`, `02-1A-2B-3C-4D-5E`, `laptop-1`, `home-wifi`). No functional change.

### 2.3.0
- **New: `omada_diagnoseClient`** (QUERY, read-only) explains in one call why a device cannot get onto the network: active and known client with block state, MAC group membership, each SSID's MAC filter (allow or deny list and the group it uses), the site MAC filter, IP-MAC binding and DHCP reservation, ending in a verdict ("not on the allow list 'X' of SSID Y", "blocked: use omada_unblockClient", ...). For ADMIN callers it also searches the audit log and detects an **orphaned block**: a client Omada no longer lists, with failed block/unblock/delete lines for its MAC (a block left in the site's per-device config that no API exposes; the verdict gives the backup/restore fix). Sources that cannot be read are listed under `unavailable` (the source and Omada's errorCode only; the error text, which can carry internal addresses, stays in the server log) and the diagnosis carries on.
- **New: MAC group entries** (Settings > Profiles > Groups > MAC Group, usable as an SSID allow or deny list). `omada_listMacGroups` (QUERY; graph mode: `omada_read /profiles/mac-groups`) lists the groups with their entries and which SSIDs use them and how. `omada_setMacGroupEntry` adds a MAC or renames its entry and `omada_removeMacGroupEntry` removes it (both **CONFIGURE**); each answer says what the change means for every SSID filtering by that group. Omada replaces a group's whole list on update, so changes made through this server are applied one at a time per group (two concurrent calls cannot overwrite each other), and the group is re-read just before the write: if anything in it, or its name, changed meanwhile (e.g. in the web UI), nothing is written. Known limit, accepted: Omada has no conditional update, so a web-UI edit to the same group landing in the instant between that last read and the write is overwritten. Built-in groups are refused; a group is chosen by groupId or a unique name.
- README: the four new Omada tools are listed (36).
- +35 tests (group add / rename / remove, the guarded write and concurrent changes, diagnosis verdicts incl. the orphan and the ADMIN-only audit, sanitized source errors, tool permissions and SSID effects; mutation-checked).
- **CI publishes the Docker image.** A new `publish-image` job runs on `v*` tags after the test matrix and the boot test: it builds the image, boot-tests **that exact image**, scans it with Trivy (pinned 0.75.0) **before** pushing — fixable HIGH/CRITICAL findings fail the release — then pushes `:X.Y.Z` to GHCR and moves `:latest` only for the newest final release (pre-release tags such as `-rc.1` and re-runs of older releases never move it; image publishes run one at a time). It authenticates with the run's own `GITHUB_TOKEN`, so releasing no longer needs a personal access token or the maintainer's machine. The decisions live in `scripts/ci/publish-image.ts` (+10 tests); the boot test moved to `scripts/ci/smoke.sh`, shared by both jobs.
- CI: an unused loop variable in the boot test (actionlint/shellcheck warning) fixed.
- `AGENTS.md` and `.codex/` are no longer tracked: they are local agent files (both are now in `.gitignore`).

### 2.2.1
- **Security — secrets are redacted from every tool response.** Omada read tools returned the household Wi-Fi password in plain text (`pskSetting.securityKey` in the SSID detail, via `omada_getSsidDetail` and `omada_read /wifi/ssids`), and other paths could do the same for RADIUS / CoA / SNMP secrets, PPSK and VPN keys, portal passwords and tokens. Every tool response now passes through one redaction step (in `toToolResult`, so MCP and the REST bridge alike): non-empty text values under secret-looking names become `"<redacted>"` (empty values stay empty; flags and numbers with similar names such as `hidePwd` or `encryptionPsk` are untouched), and `token=` / `access_token=` values inside URLs (Home Assistant camera images) are masked. Internal read-modify-write paths are unaffected; redaction happens only at the response.
- **Fix — `omada_unblockClient` on clients the controller no longer treats as current.** Omada's unblock endpoint fails with "This client does not exist" once a blocked (and therefore offline) client drops out of the controller's current set. The tool now checks the known-clients list: if the client is there and no longer blocked (e.g. unblocked in the web UI), it reports success; otherwise it returns a clear error saying what to do. A client the controller has no record of is never reported as unblocked, because its access points may still refuse it (an orphaned block). This works whether the controller reports the error with HTTP 200 or an HTTP error status (controller errors now carry their `errorCode`).
- **New: `omada_listBlockedClients`** (QUERY) lists blocked clients from the known-clients list, offline ones included, so automations can check block state. Graph mode gets `omada_read /clients/known` instead: one page of known clients with their `block` field (the controller cannot filter by block state, so a single-page "blocked" view would miss entries).
- **New: `omada_deleteClient`** (**CONFIGURE**) deletes the controller's record of a client (name, history, block state), to clear a block the unblock endpoint can no longer reach.
- `omada_blockClient`'s description now warns that a long block can become impossible to undo through the API and recommends a controller-side time-range rule for schedules such as a curfew.
- README: the two new Omada tools are listed (32).
- +30 tests (redaction across SSID, RADIUS, PPSK, VPN, SNMP, portal, webhook and camera shapes, and through `omada_read`; the unblock fallback including the orphaned-record case and a record without block state; the blocked list; deleteClient and its permission; mutation-checked).

### 2.2.0
- **New: owner questions — approve or deny from the phone.** `askOwner` sends a sticky, persistent notification with 1-3 buttons (default Approve / Deny) and returns a `requestId` at once; `getOwnerAnswer` waits up to 50 s per call and returns `answered` (button index and label, `answeredAt`, the HA user who tapped), `pending`, `timeout`, `cancelled` or `unknown`; `cancelOwnerQuestion` withdraws a question and marks the notification "Cancelled". Two calls rather than one long one because Cloudflare cuts requests at ~100 s. Questions stay open up to 7 days (default 10 min); the phone removes the notification at expiry by itself.
  - **No database, restart-proof:** the requestId carries the question, buttons, target, expiry and asking client, signed with a key derived from `MCP_AUTH_SECRET`; each button's action id is signed separately and cannot be derived from the requestId. After a restart the server still recognises open questions and the taps on them. Only a tap during the restart itself is lost (the question then expires as NO).
  - **Security:** a tap counts only with origin REMOTE and a user (the mobile app webhook), so an automation firing a fake `mobile_app_notification_action` cannot approve anything; tampered ids, extended expiries and swapped button indexes are rejected; only the asking token `sub` can read or cancel; at most 3 open questions and 30 per hour per client; first tap wins; late taps are ignored. Needs `NOTIFY`.
  - **Plain text only:** question at most 256 characters (line breaks allowed), title 60, button labels 20. Text is NFC-normalized (Romanian diacritics are fine), then emoji, control and invisible characters (zero-width joiners, bidi overrides), variation selectors and stacked combining marks are refused with the offending character named — never silently stripped or cut.
  - **`MCP_OWNER_QUESTIONS_HA_USERS`**: comma-separated HA user ids allowed to answer (the `answeredBy` of an answer); unset = any HA user, with a startup warning.
  - Known limit, accepted: cancellations and answers are kept in memory only. After a restart, someone with a Home Assistant login could re-send an old button id through HA's API and answer a question that had been cancelled or denied (the phone no longer shows its buttons; that access already controls the house).
  - Needs HTTP mode, an **admin** Home Assistant token (button taps are not on HA's non-admin event allowlist) and `MCP_AUTH_SECRET`. If Home Assistant refuses the tap subscription at startup, the three tools are not offered (logged); if it refuses later, `askOwner` returns an error saying so instead of sending questions nobody can answer. New `MCP_OWNER_QUESTIONS_ENABLED` (default `true`).
- **Fix — `getAutomationTrace` always answered "Not Found".** Home Assistant has no REST trace endpoint; traces exist only over the WebSocket (`trace/list`, admin-only) and are keyed by the automation's `id` attribute, not its entity id. The tool now uses a one-off WebSocket command, returns the newest runs first (new `limit`, default 5, max 20) with trigger, state and errors, and explains when an automation defined in YAML without an `id` has no traces.
- **Fix — Home Assistant events stopped after an HA restart.** The WebSocket client reconnected but never re-sent its subscriptions (HA forgets them with the connection), so `/subscribe_events` went silent after every HA restart. Subscriptions are now restored on reconnect; the client keeps retrying with the delay capped at 60 s instead of giving up after 10 attempts; commands are matched to their results by id (they were matched in arrival order); connecting has a deadline and fails at once if HA closes before authenticating; and a subscription made while Home Assistant is unreachable (also at server startup) is queued and sent once HA is back, instead of failing (an SSE client stays connected and receives events when HA returns; previously owner questions and SSE stayed unavailable until a server restart). Unsubscribing works while HA is offline (the subscription is forgotten for good, never restored on reconnect), and a subscription cancelled before HA confirmed it is cancelled on HA's side too. A subscription HA refuses (e.g. a non-admin token) is reported and dropped; one whose confirmation is lost is cancelled and retried (no duplicate subscriptions on HA); and an event HA sends right after confirming a subscription is no longer dropped. Errors from these WebSocket commands reach callers and logs as HA's error code only (e.g. `Home Assistant rejected 'trace/list' (unauthorized)`), never HA's free text or the internal address; the detail stays in the server log. The WebSocket connections now follow `HA_STRICT_SSL` like the REST client.
- **Fix — duplicate events.** With two subscriptions to the same event type, each received every event twice (HA sends one copy per subscription). Each copy now goes only to its own subscription.
- **Logging — tool arguments are logged at debug level only.** The info-level `Tool invoked` line now carries just the tool and session; the arguments (message and question text, entity names, MAC addresses) appear only with `LOG_LEVEL=debug`.
- README: `MCP_SSE_EVENTS_ENABLED` defaults to `true` (the README said `false`).
- +88 tests (owner question service and tools incl. a real MCP round trip and concurrent rate limits, plain-text validation, WebSocket client against a fake HA server incl. reconnects, deadlines and the TLS policy, trace lookup; the security checks are mutation-tested).

### 2.1.1
- **Fix — `omada_setSiteNtpServers` was rejected by the controller on sites with daylight saving off.** Omada returns the DST start/end as empty objects when DST is off, but rejects them on write ("Daylight saving parameter [month] should not be null"). The site update now sends DST start/end only when complete; with DST on and an incomplete start/end it refuses to write. The rejected 2.1.0 call changed nothing (the controller validates before saving).
- +2 tests (the live DST-off shape; DST on with an incomplete start/end).

### 2.1.0
- **New: site NTP tools for Omada.** `omada_getSiteNtpStatus` (QUERY; also `omada_read /network/ntp` in graph mode) reads the NTP configuration and status. `omada_setSiteNtpServers` (**CONFIGURE**, not CONTROL: it changes site-wide configuration) replaces the site NTP server list (hostnames or IPv4, at most 5) and can turn NTP on or off. Omada has no NTP-only write: NTP lives in the site settings, so the tool reads the site, changes only the NTP fields and writes the whole site back (`PUT /sites/{siteId}`), translating the read and write shapes (servers are strings on read, `{ address }` objects on write; read-only DST fields are dropped). It refuses to write if the site lacks a required field, validates every address before contacting the controller, supports `dryRun` to preview the exact request, and reports the before/after lists as the controller holds them. The controller has no conditional update, so writes are serialized per site and the site is re-read just before the PUT: if a non-NTP setting changed in between, nothing is written and the call fails with a conflict. Not exposed on the Open WebUI REST bridge.
- README: the Omada tool list was stale (said 24, missed the block/unblock, PoE and SSID action tools); it now lists all 30.
- +42 tests (address validation, the update body, dry run, read-modify-write, conflict refusal, per-site serialization, controller rejection, the `/network/ntp` graph read, and RBAC: a CONTROL token cannot change NTP; mutation-checked).

### 2.0.0
- **Major version for the two major dependency upgrades below (MCP SDK v2, zod 4).** No configuration changes are needed and MCP clients are unaffected: same tools, same protocol versions, same auth.
- **MCP SDK v2 (split packages).** `@modelcontextprotocol/sdk` 1.x → `@modelcontextprotocol/server` 2.2 + `@modelcontextprotocol/node` 2.1. The production dependency tree shrinks from **95 packages to 8**: Express, body-parser, qs, cors, cross-spawn (Socket "shell access"), ajv (Socket "uses eval"), eventsource and the long tail of unmaintained Express helpers are gone. `npm audit` (incl. dev) reports 0. Client compatibility is unchanged: v2 still negotiates `2025-11-25` and older protocol versions (verified with `mcp-remote`, the Claude Desktop client, plus raw `2025-06-18` initialize). Applied with the official codemod, then by hand: tool `inputSchema`s pass schema objects (raw shapes are deprecated), and the REST bridge's synthetic request context moved to the v2 shape (`http.authInfo`) — without that, Open WebUI's tool calls would have been denied.
- **zod 3 → 4** (SDK v2 requires zod ≥ 4.2). `zodToOpenApiSchema` was ported to zod 4 internals (the generated OpenAPI spec is byte-identical). The JSON Schemas in `tools/list` change only cosmetically (key order, explicit safe-integer `maximum`, no top-level `additionalProperties: false`), except `createAutomation` now correctly advertises `trigger` and `action` as required.
- **Performance — schema conversion is memoized.** SDK v2 converts every tool schema to JSON Schema inside `registerTool`; with the stateless per-request server that made a full request ~60% slower (2.2 → 3.6 ms). `memoizeJsonSchema` caches each schema's conversion for the process (deep-cloned results, validation untouched, `tools/list` byte-identical), bringing a full request to **1.9 ms — faster than on v1**.
- **New: `npm run bench`** — vitest benchmarks of the per-request hot paths (server build, full `createServer`+`tools/list` round trip, JWT verify, argument validation), used to catch and fix the regression above.
- +6 tests (memoization, mutation-checked); test mocks moved to the v2 context shape.

### 1.7.6
- **`omada_read` is hidden from callers who can read no Omada resource.** It has no single static permission (it checks per resource path), so 1.7.5 still listed it to every caller, including unmapped tokens that could read nothing. A new per-tool visibility rule lists it only when the caller holds the permission of at least one readable node (e.g. a `QUERY` or an `ADMIN`-only mask); a `NONE`/`NOTIFY`-only caller no longer sees it. Per-path checks are unchanged.
- **CI: `actions/checkout` and `actions/setup-node` v4 → v7** (Node 24 runtime; v4 targeted the deprecated Node 20 action runtime). No workflow changes were needed: the breaking changes in v5–v7 concern automatic caching (not triggered — no `packageManager` field) and credential persistence (CI never pushes with git).
- `AGENTS.md`: the GHCR push token is fetched from the maintainer's password manager at push time — never stored as an environment variable.
- +4 tests (`omada_read` visibility for NONE / QUERY / ADMIN-only / NOTIFY-only masks).

### 1.7.5
- **Security — `tools/list` is filtered by the caller's permissions.** A token is only offered the tools it may call (e.g. a `readonly` token no longer sees `restartHomeAssistant`, `deleteAutomation`, `invokeAction` or the Omada write tools). Previously every valid token was shown all tools; calls were already denied, but LLM clients planned around tools they could not use and the admin surface was disclosed. Each tool's static permission is recorded by `wrapToolHandler`; `createServer({ callerPermissions })` disables the rest, so the SDK omits them from the list and rejects calls to them. Per-call RBAC is unchanged; stdio (local trust) is unfiltered; `omada_read`/`omada_browse` stay listed (they gate per resource path).
- **Fix — control tools no longer report success for a non-existent entity.** Home Assistant silently ignores service calls to unknown `entity_id`s, so `entityAction`, `controlLight`, `controlClimate`, `controlFan`, `controlCover`, `controlMediaPlayer`, `activateScene` and `runScript` returned `success: true` for typos. They now check existence first and return `isError` "Entity not found" ("No action was performed") without calling the service.
- **Warning — permissive `defaultRole`.** With bearer auth, the server logs a startup warning when `MCP_PERMISSIONS_CONFIG` `defaultRole` grants anything, since it applies to every valid token with an unmapped `sub`. README now recommends `defaultRole: NONE` plus one `users` entry per client (and fixes the `ADMIN` role row, which wrongly said "all except AI").
- **Fix — `generate:jwt` prints the token once.** stdout carries only the bare token; details go to stderr, so `TOKEN=$(npm run -s generate:jwt -- ...)` captures exactly one token.
- Added `.codex/review-rules.md` (the repo's hard rules for pre-release code review).
- +26 tests: permission-filtered `tools/list` over an MCP client and over the real HTTP path (bearer auth → stream transport, incl. interleaved callers), the entity guard for all eight tools, `defaultRoleWarning` and its wiring in the auth middleware, and the `generate:jwt` stdout contract (subprocess).

### 1.7.4
- **Security — cleared every advisory in the dependency tree** (`npm audit` and `npm audit --omit=dev` both report 0). Runtime range declarations are unchanged; all fixes are in-range lockfile bumps:
  - Production: `undici` 6.28.0→6.29.0 (WebSocket DoS ×2, retry-interceptor response splitting), `fast-uri` 3.1.6→3.1.8 (authority injection / host confusion; via ajv), `hono` 4.13.3→4.13.11, `ip-address` 10.5.0→10.7.2, `qs` 6.15.3→6.16.0 (all three transitive under the SDK's express stack).
  - Dev-only: `vitest` + `@vitest/coverage-v8` 4.1.10→4.1.11 (devDependency floor raised to `^4.1.11`), `brace-expansion`, `js-yaml`, `nanoid`, `postcss`; `esbuild` pinned back to 0.27.2 (the advisory covers 0.27.3–0.28.0).
  - None of the production advisories were reachable here — the vulnerable surfaces (undici's WebSocket/retry interceptor, hono/express/qs request parsing, ip-address) are never imported by this server — but they failed the `npm audit` CI gate.
- **Image rebuilt on the current base**: Node 24.19.0→24.21.0 (bundled OpenSSL 3.5.7→3.5.8, bundled undici 7.29.0→7.29.1), Alpine 3.24.1→3.24.2, `curl` 8.21.0→8.22.0, `libssl3`/`libcrypto3` 3.5.8. No source changes.

### 1.7.3
- **Fix — stateless `GET /mcp` now returns `405 Method Not Allowed` instead of hanging forever.** In stateless mode every request gets a fresh transport, so the SDK's standalone SSE GET opened a stream that never emitted a byte and never ended. That eternal zero-byte response pinned the Cloudflare→origin keep-alive socket, and HTTP/1.1 serial semantics stalled every request queued behind it — mcp-remote's own `WWW-Authenticate` probe GET poisoned the socket its `initialize` POST was then queued on, surfacing as intermittent "Request timed out" (and occasional CF 502) for Claude Desktop / Cowork sessions. Also fixes the resource leak (each hung GET pinned a socket + a full McpServer instance). Stateful mode is unchanged. +4 regression tests (`isStatelessMcpGet`).
- Removed `src/wrapper.ts` — a dead legacy HTTP wrapper (unauthenticated, spawn-per-request) that nothing referenced but still compiled into the shipped image. Verified unused: n8n calls the native `/mcp` endpoint; the live server already 404'd the wrapper's `POST /` route.
- `openapi.json`: dropped the stale `POST /` "raw JSON-RPC passthrough" advertisement (the endpoint 404s; n8n uses `/mcp`).
- Removed the unused `customRequestSchema` export (never registered as a tool).
- `parsePermissionsConfig` now logs a warning when `MCP_PERMISSIONS_CONFIG` is invalid JSON instead of silently resolving every caller to NONE (still fail-closed).
- Track `AGENTS.md` (agent instructions for the repo), updated to the current release process (CI OIDC npm publish, WSL Docker build) and current facts (REST bridge is RBAC-gated).

### 1.7.2
- Fix: a malformed JSON request body now returns `400 Bad Request` (was `500`) — `parseBody` tags the parse failure and the handler returns the parse detail; oversize bodies still `413`, genuine faults still `500`.
- Security: cleared every high/moderate advisory in the production tree via already-in-range bumps (no `overrides`, no hard-dep downgrades, `package.json` unchanged; `npm audit --omit=dev` now 0): `ip-address` 10.2.0→10.5.0 (SSRF), `fast-uri` 3.1.3→3.1.6, `@hono/node-server` 1.19.14→1.19.17 (serve-static path traversal), `hono` 4.12.29→4.13.3 (middleware DoS), `undici` 6.27.0→6.28.0.
- Remaining `npm audit` findings are dev-only tooling (esbuild/vitest/tsx) that never ships.

### 1.7.1
- Per-action cooldown on `invokeAction`: a minimum interval between firings (default 60s, 0 disables) so an injected model can't loop a *legitimate* remote-hands action into a deploy storm / endpoint DoS. Check-and-claim runs before the fetch; a failed call still consumes the slot.
- Fix: undici pairing — dispatcher requests now use undici's own `fetch`. An npm-undici-6 `Agent` passed to Node's built-in fetch broke on Node 26 ("invalid onError method" → "fetch failed"); the real root cause of the v1.5.5 crash-loop.
- README npm badge → shields.io (badge.fury.io served a stale cached version).

### 1.7.0
- Unified chat-face registry: one source generates the OpenAPI spec and the `MCP_CHAT_TOOLS` slice; Omada tools made chat-eligible.
- Fix two stale OC200-v6 integration tests (totalTraffic rename, required threat-list params).

### 1.6.0
- Remote-hands actions: `invokeAction` fires pre-registered REST actions (`MCP_REST_ACTIONS`) — deploy triggers / webhooks, each individually gated (name-only lookup, no arbitrary URLs).
- package.json: add repository / homepage / bugs metadata.

### 1.5.6
- Runtime base → `node:24-alpine` LTS (node:26 broke the old-kernel NAS's first fetch); npm stripped from the runtime image.
- CI: boot-test the built image (mock HA + `/health`) so a release is never the image's first run; auto-create the GitHub Release on `v*` tags; tokenless npm publish via OIDC trusted publishing; also test on Node 26 (the image runtime).

### 1.5.5
- CVE patch: refresh dependencies, `node:26` base (node:25 EOL), `apk upgrade`, drop unused `--experimental-quic`.
- Fix: regenerate the lockfile on Linux — a Windows-generated lock omitted `@emnapi/*` optional deps, failing `npm ci` in the Docker/CI build.

### 1.5.4
- Actionable error hints so agents self-correct: `getState` / `entityAction` / `hass://entities/{id}` return a `hint` toward `searchEntities` on a missing/malformed `entity_id`; Omada `resolveSiteId` with no site hints to `omada_browse /`; corrected stale Omada SSID getter refs to graph paths (`omada_read /wifi/groups`, `/wifi/ssids`). Additive — error text only, no API/behavior change.

### 1.5.3
- Fix: add `x-session-id` to `Access-Control-Allow-Headers` so Open WebUI's OpenAPI tool calls pass CORS preflight (the browser was blocking every call on the unlisted header → "NetworkError"). Final piece with v1.5.1 (https scheme) + v1.5.2 (CORS on 401/429) to make `/api/*` calls complete.

### 1.5.2
- Fix: apply REST-bridge CORS (`/openapi.json`, `/api/*`, SSE path) **before** auth / rate-limit, so a `401` / `429` still carries `Access-Control-Allow-Origin`. A browser discards a header-less cross-origin response and reports "NetworkError", hiding the real `401` — making an auth misconfig look like a tunnel failure. Path test extracted to `isRestApiCorsPath()`; 200s unchanged.

### 1.5.1
- Fix: `/openapi.json` honors `X-Forwarded-Proto` so `servers[0].url` advertises `https` behind the TLS-terminating Cloudflare tunnel (was hardcoded `http://`, blocked as mixed content on an https page → "NetworkError"). New `resolveForwardedProto()` validates against an allowlist (spoof-safe; first hop of a comma chain). No change for plain-HTTP.

### 1.5.0
- Feature — Omada resource graph Tier 4 reads (still just `omada_browse` + `omada_read`, zero tool-schema cost), grounded in the reference API client, over the existing `OmadaClient.readResource()`:
  - VPN (`/vpn`): `/site-to-site` (list or single via `id`), `/client-to-site/servers`, `/client-to-site/clients`, `/wireguard`, paginated `/ipsec-stats`.
  - Profiles (`/profiles`): `/ppsk` (**requires** `params.type` 0/1) and `/time-range`.
  - Schedules (`/schedules`): `/poe`, `/port`, `/upgrade`.
  - Backup (`/backup`): `/files`, `/result`.
  - Audit (`/audit`) — **ADMIN-gated**: `/site` and `/global`, paginated with optional epoch-ms `startTime`/`endTime` + `searchKey` (new `auditFilters` helper).
  - First ADMIN subtree beyond `/security`, further exercising per-path RBAC.

### 1.4.0
- Feature — Omada resource graph widened from ~33 to **54 readable nodes** at the same two-tool surface (`omada_browse` + `omada_read`), zero tool-schema cost; every node grounded in the controller OpenAPI spec + reference client, over `OmadaClient.readResource()`:
  - Typed-read parity: `/devices/search`, `/network/load-balance` — every typed getter now has a graph node.
  - Tier 2 (insight): `/devices/cable-test` (requires `switchMac`), `/network/port-forwarding/rules`, `/network/dhcp-leases`, dashboard `/client-distribution`, `/traffic-distribution`, `/traffic-activities`.
  - Tier 3 (home subset, skipping enterprise gear): `/devices/poe`, `/lldp`, `/network/dhcp-reservations`, `/static-routes`, `/ip-mac-binding`, `/attack-defense`, `/acls/{gateway,switch,eap}`, `/url-filters/{gateway,eap}`, `/mac-filters/{allow,deny}`, `/wifi/band-steering` — all read-only, QUERY-gated.
  - Paginated nodes forward one `page`/`pageSize` (no page-walking).

### 1.3.4
- Feature — Omada resource-graph tool registration (`MCP_TOOL_REGISTRATION_MODE=graph`): registers `omada_browse` (permission-filtered tree of resource **types**) + `omada_read` (per-path-RBAC fetch, single-page pagination) + the 5 typed write/action tools, replacing ~21 read getters; `eager` (default) unchanged. One `OmadaClient.readResource()` primitive backs the newly-exposed endpoints. `graph` is now a complete superset of `eager` reads, incl. the ADMIN-gated IDS/IPS log at `/security/threats` (required epoch `startTime`/`endTime`) — first node above QUERY. New `namespace.ts`/`graph.ts`, `getCallerPermissions()` extracted; +47 tests.
- Fix — `OMADA_SITE_ID` validated against the live controller at startup: an id not present on the controller (drift after migration, like `OMADA_OMADAC_ID`) now disables the Omada plugin with an error naming the bad value + valid sites, instead of silently scoping reads to a dead site (later "user does not have permissions to access this site"). HA/AI keep working; valid default still auto-resolves. New `checkConfiguredSite()` + 4 tests.
- Fix — graph reads that require query params now send them: `/events` + `/events/alerts` send `filters.timeStart`/`timeEnd` (epoch ms, default last 7d, `params.module`/`resolved` optional); `/dashboard/cpu` + `/memory` send `start`/`end` (epoch s, default last 24h); `/wifi/rogue`, `/wifi/wids` (Pro-only), `/devices/pending` marked paginated. Surfaces the controller's `errorCode`/`msg` in thrown HTTP errors (was a bare `400`). Window helpers `resolveLogWindowMs`/`resolveUsageWindowSec`; +10 tests.

### 1.3.1
- Patch — RBAC role-name case-insensitivity (follow-up to v1.3.0 fail-closed change): `getUserPermissions` resolves per-user `role` and `defaultRole` case-insensitively, so lowercase `"operator"`/`"admin"` in `MCP_PERMISSIONS_CONFIG` map correctly instead of collapsing to an empty mask; unknown roles still fail closed to `NONE`. Tests under `tests/permissions/`.

### 1.3.0
- **Security hardening release** — OWASP-aligned audit (API Top 10 2023 + Top 10 2021), every fix with regression tests under `tests/security/`; external behavior unchanged for correct configs. Suite → 908 tests; `npm audit --omit=dev` clean.
  - Access control: REST `/api/*` gated by the same RBAC bits as their MCP twins (`403` on insufficient perms); SSE `/subscribe_events` requires `QUERY`, dead `?token=` removed, SSE CORS constrained to the allowlist.
  - Authentication: opt-in `MCP_AUTH_REQUIRE_EXP` (reject no-`exp` tokens, default off + startup warning); optional `MCP_AUTH_ISSUER`/`AUDIENCE` + `nbf`/clock-skew; signing secret must be ≥32 chars for `bearer` (fail-fast).
  - Injection/SSRF: every interpolated HA path segment `encodeURIComponent`-encoded and schema-validated.
  - Crypto/transport: removed process-global `NODE_TLS_REJECT_UNAUTHORIZED=0` (per-client `undici` dispatcher only when `strictSsl=false`); SSE IDs via `randomUUID()`.
  - Configuration: `MCP_AUTH_METHOD=none` throws on non-loopback bind; opt-in DNS-rebinding Host validation via `MCP_HTTP_ALLOWED_HOSTS` (unset = off); removed `ALLOWED_ORIGINS=*` from compose; container runs non-root (`USER node`); static security headers on every response.
  - Resource limits: rate-limit keying trusts forwarding headers only from `MCP_RATE_LIMIT_TRUSTED_PROXIES` peers (else socket addr); 1 MB body cap (`413` + socket destroy); slow-loris headers/request/keep-alive timeouts.
  - Logging: client-facing `500`/SSE errors generic (detail server-side only); `/health` returns only `{"status":"healthy"}`.
  - Design: tool authz fails **closed** (missing mask denies, was `0xFF`); stdio opts into local full-trust explicitly.
  - Dependencies: bumped `@modelcontextprotocol/sdk`→`^1.29.0`, `ws`→`^8.21.0` (cleared 8 prod advisories, 5 high); CI gate asserts zero high/critical.

### 1.2.0
- **Omada Client Block/Unblock**: Block or unblock a network client by MAC address
  - New tool `omada_blockClient`: denies a client all network access until unblocked
  - New tool `omada_unblockClient`: restores a previously blocked client's access
  - Backed by the Omada Open API `POST .../clients/{mac}/block` and `/unblock` endpoints
  - Both require the `CONTROL` permission and return a `{ mac, siteId, blocked }` status object
  - Total Omada tools: 23 → 25
- All tests passing

### 1.1.0
- **Performance: Paginated Entity Queries**: Reduced response sizes by ~98% for entity queries
  - New `LightweightEntity` type returns only essential fields (entity_id, state, friendly_name, unit_of_measurement, last_changed)
  - Default response size reduced from ~800KB-1MB to ~15KB for typical queries
  - Pagination with configurable page size (1-200, default 50)
  - Tools updated: `getStates`, `getAllSensors`, `searchEntities`, `getEntitiesByDomain`, `listEntities`
  - New parameters: `page`, `pageSize`, `includeAttributes` (set `includeAttributes=true` for full entity data)
  - Backward compatible: tools work without parameters using sensible defaults
- **MCP Server Instructions**: Added server instructions for improved LLM tool selection
  - Instructions are sent during MCP initialization to guide LLMs on optimal tool usage
  - Dynamically generated based on enabled plugins (HA, Omada, AI)
  - Covers entity queries, device control, automation workflows, Omada operations, and cross-plugin integration
  - Follows MCP best practices for concise, actionable guidance
- **Fix: Graceful Omada startup degradation**: Server no longer crashes when Omada credentials are invalid or controller is unreachable
  - Omada plugin disables itself with a warning instead of taking down the whole server
  - Home Assistant and AI plugins continue working normally
- **Fix: Omada auth error clarity**: Error code `-44106` now explicitly hints to check `OMADA_OMADAC_ID` in addition to client credentials, since Omada returns the same code for both invalid credentials and an incorrect controller ID (e.g. after a controller version upgrade)
- All 829 tests passing

### 1.0.0
- **TP-Link Omada Network Integration**: Full support for Omada SDN controller
  - 24 new tools for network management (total tools: 60)
  - Site management: `omada_listSites`
  - Device management: `omada_listDevices`, `omada_getDevice`, `omada_searchDevices`, `omada_getSwitchStackDetail`, `omada_listDevicesStats`
  - Client management: `omada_listClients`, `omada_getClient`, `omada_listMostActiveClients`, `omada_listClientsActivity`, `omada_listClientsPastConnections`
  - Rate limiting: `omada_getRateLimitProfiles`, `omada_setClientRateLimit`, `omada_setClientRateLimitProfile`, `omada_disableClientRateLimit`
  - Security: `omada_getThreatList`
  - Network config: `omada_getInternetInfo`, `omada_getPortForwardingStatus`, `omada_getLanNetworkList`, `omada_getLanProfileList`, `omada_getWlanGroupList`, `omada_getSsidList`, `omada_getSsidDetail`, `omada_getFirewallSetting`
  - OAuth2 authentication with automatic token refresh
  - New environment variables: `OMADA_PLUGIN_ENABLED`, `OMADA_BASE_URL`, `OMADA_CLIENT_ID`, `OMADA_CLIENT_SECRET`, `OMADA_OMADAC_ID`, `OMADA_SITE_ID`, `OMADA_STRICT_SSL`, `OMADA_TIMEOUT`
- **JWT Authentication**: Replaced static bearer tokens with JWT-based authentication
  - `MCP_AUTH_SECRET`: JWT signing secret (min 32 chars, HS256 algorithm)
  - Token validation with expiration support (`exp` claim)
  - User identification via `sub` claim for permission lookup
- **Permission System**: Role-based access control with binary masks
  - Permission binary masks: ADMIN (1), CONFIGURE (2), CONTROL (4), QUERY (8), NOTIFY (16), AI (32) (sorted by criticality)
  - Role presets: NONE, READONLY, OPERATOR, CONTRIBUTOR, ADMIN, SUPERUSER
  - User-to-role mapping with id/sub based authentication
  - `MCP_PERMISSIONS_CONFIG` environment variable for configuration
  - Case-insensitive role lookup in configuration
- **MCP SDK AuthInfo Integration**: Proper integration with MCP SDK authentication
  - Permissions passed via `authInfo.extra.permissions` to tool handlers
  - Tools enforce permission requirements (e.g., READONLY users denied CONTROL tools)
- **Plugin Architecture**: Modular plugin system for extensibility
  - Home Assistant plugin (`HA_PLUGIN_ENABLED`)
  - Local AI plugin (`AI_PLUGIN_ENABLED`)
  - Omada network plugin (`OMADA_PLUGIN_ENABLED`)
- **Environment Variable Cleanup**: Standardized naming conventions
  - Renamed `LOCALAI_PLUGIN_ENABLED` to `AI_PLUGIN_ENABLED`
  - Deprecated `MCP_SERVER_MODE`, `MCP_SERVER_PORT`, `MCP_SERVER_HOST`
- **Minimal Logger**: Replaced pino with lightweight built-in logger
  - Supports plain, JSON, and GCP-JSON log formats
  - Zero external logging dependencies
- All 688 unit tests + 44 integration tests passing

### 0.9.0
- **Streamable HTTP Only**: Removed deprecated SSE transport, keeping only Streamable HTTP
  - Real-time HA event subscriptions still available at `/subscribe_events`
- Preparing for future QUIC transport (Node.js 25+ experimental support)
- All 648 tests passing

### 0.8.0
- **Bearer Token Authentication**: Secure HTTP endpoints with bearer tokens
  - `MCP_AUTH_METHOD`: Set to `bearer` to enable authentication
  - `MCP_AUTH_TOKEN`: Comma-separated tokens for multiple clients
  - `WWW-Authenticate` header on 401 responses
  - Health check and OpenAPI endpoints skip authentication
- **Server-Timing Header**: Response timing on all HTTP responses
  - `Server-Timing: total;dur=X` header (integer milliseconds)
  - Visible in browser DevTools Network tab
- **Modular Auth Middleware**: Clean separation in `src/server/auth.ts`
- All 648 tests passing

### 0.7.0
- **Calendar Tools**: Access Home Assistant calendar entities
  - `listCalendars`: Get all calendar entities
  - `getCalendarEvents`: Get events from one or all calendars with date filtering
- **Person Tracking Tool**: Track household members
  - `listPersons`: List all person entities with location state (home/away)
  - Optimized description for small LLM tool selection
  - Returns onsite/away counts and linked device trackers
- Total tools increased from 34 to 37

### 0.6.0
- **Mobile App Notifications**: Full support for Home Assistant mobile app notifications
  - `sendNotification`: Enhanced with action buttons, priority, images, videos
  - `listNotificationTargets`: Discover available mobile app notification targets
  - Android-specific options: priority, channel, LED color, vibration patterns
  - iOS-specific options: interruption level, badge count, critical alerts
  - Sticky and persistent notification support
- **Fixed Automation API**: `createAutomation` now works correctly
  - Uses correct endpoint: `POST /config/automation/config/{id}`
  - Auto-generates timestamp-based IDs (like HA UI)
  - Auto-reloads automations after creation
  - Added optional `id` field to AutomationConfig type
- **Refactored Tools Architecture**: Split monolithic registry into individual tool files
  - Each tool now in its own file under `src/tools/`
  - Improved maintainability and code organization
  - Shared schemas and utilities in `src/tools/common.ts`
- Switched to NodeNext module resolution for TypeScript
- All 310 tests passing

### 0.5.0
- **Real-time SSE Event Subscription**: Subscribe to Home Assistant events via Server-Sent Events
  - Filter by domain, entity_id, or event types
  - Automatic WebSocket connection to Home Assistant
  - Keep-alive support for persistent connections
- **Enhanced Automation Management**: Full automation lifecycle support
  - `triggerAutomation`: Manually trigger automations with variables
  - `enableAutomation`/`disableAutomation`/`toggleAutomation`: Control automation state
  - `createAutomation`: Create new automations via API
  - `deleteAutomation`: Remove automations
  - `reloadAutomations`: Reload from configuration
  - `getAutomationTrace`: View execution history
- **Advanced Device Control Tools**:
  - `controlLight`: Brightness, color, color temperature, transitions
  - `controlClimate`: Temperature, HVAC mode, fan mode, presets
  - `controlMediaPlayer`: Playback, volume, mute controls
  - `controlCover`: Position and tilt control
  - `controlFan`: Speed, oscillation, direction
  - `activateScene`: Scene activation
  - `runScript`: Script execution with variables
  - `sendNotification`: Send notifications through Home Assistant
- **Rate Limiting**: Built-in token bucket rate limiter
  - Configurable window and request limits
  - Per-IP tracking with automatic cleanup
  - Skip paths for health checks
- **New Configuration Options**:
  - `MCP_SSE_EVENTS_ENABLED`: Enable/disable SSE
  - `MCP_SSE_EVENTS_PATH`: Customize SSE endpoint
  - `MCP_RATE_LIMIT_ENABLED`: Enable/disable rate limiting
  - `MCP_RATE_LIMIT_WINDOW_MS`: Rate limit window
  - `MCP_RATE_LIMIT_MAX_REQUESTS`: Max requests per window
- Total tools increased from 16 to 33

### 0.4.0
- **Extensible AI Provider System**: Refactored AI client to support multiple providers
  - New `src/localAI/` folder with provider-based architecture
  - Supports Ollama (native API) and OpenAI-compatible APIs (LocalAI, LM Studio, vLLM)
  - New environment variables: `AI_PROVIDER`, `AI_URL`, `AI_MODEL`, `AI_TIMEOUT`, `AI_API_KEY`
- Refactored `haClient.ts` into modular folder structure (`src/haClient/`)
- Split monolithic client into dedicated operation classes:
  - `request.ts` - HTTP request handler
  - `states.ts` - State operations (getStates, getState, getAllSensors)
  - `services.ts` - Service operations (callService, restartServer)
  - `entities.ts` - Entity operations (getEntitiesByDomain, searchEntities, listEntities, getDomainSummary)
  - `automations.ts` - Automation operations (getAutomations)
  - `history.ts` - History operations (getHistory, getSystemLog)
  - `updates.ts` - Update operations (getAvailableUpdates)
  - `config.ts` - Config operations (getVersion, getConfig, checkApi)
  - `index.ts` - Main HaClient class composing all operations
- Improved code organization following modular architecture pattern
- No changes to public API or tools - fully backward compatible
- All 325 tests pass

### 0.3.0
- Added 8 new tools: `getVersion`, `entityAction`, `listEntities`, `getDomainSummary`, `listAutomations`, `restartHomeAssistant`, `getSystemLog`, `checkUpdates`
- Added MCP Resources support with 5 URI-based endpoints (`hass://entities`, etc.)
- Added `entityAction` tool for simplified turn_on/turn_off/toggle operations
- Added `listEntities` tool with domain, state, search, and limit filtering
- Added `getDomainSummary` tool for domain statistics
- Added `listAutomations` tool for automation management
- Added `restartHomeAssistant` tool for server control
- Added `getSystemLog` tool for viewing logbook entries (events, state changes)
- Added `checkUpdates` tool to check for available updates (Core, Supervisor, OS, add-ons)
- Total tools increased from 8 to 16
- Enhanced type definitions for Automation, DomainSummary, HaVersion, LogbookEntry, UpdateInfo

### 0.2.0
- Added AI-powered sensor analysis with Ollama
- Added `getAllSensors` tool
- Added `analyzeSensors` tool
- Added `getHistory` tool
- Added phi4:14b as recommended model (9.5/10, 6.65s avg)
- Added qwen3:14b support (10/10 accuracy, 12.5s avg)
- Added comprehensive security documentation
- Added UFW firewall configuration guide
- Added n8n workflow examples and import instructions
- Updated to Node.js 20+ (v20.19.6) and npm 10.8+
- Updated installation instructions with verified versions
- Added Docker CLI workflow import method
- Enhanced troubleshooting with network/firewall diagnostics

### 0.1.0
- Basic Home Assistant integration
- 5 core tools (getStates, getState, callService, getEntitiesByDomain, searchEntities)
- Multiple transport modes (stdio, SSE, HTTP streaming)
- Full TypeScript support