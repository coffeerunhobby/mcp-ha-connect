/**
 * Per-key serialization for read-modify-write changes on the controller. Omada
 * replaces whole objects on update, so two changes to the same object made
 * through this server must not interleave.
 */

const locks = new Map<string, Promise<unknown>>();

/** Run `task` after every earlier task with the same key has settled. */
export async function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
        () => undefined,
        () => undefined
    );
    locks.set(key, settled);
    try {
        return await run;
    } finally {
        if (locks.get(key) === settled) locks.delete(key);
    }
}

/**
 * Lock key for every change to a site's access control objects: MAC group entries,
 * groups, time ranges, DHCP reservations, gateway ACL rules and SSID MAC filters.
 * They reference each other, so one lock per site keeps every check-then-write whole.
 */
export function accessControlLockKey(siteId: string): string {
    return `${siteId}/access-control`;
}
