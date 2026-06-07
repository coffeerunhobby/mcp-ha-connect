/**
 * Result of a client block/unblock operation.
 */
export interface ClientBlockStatus {
    /** MAC address of the client that was blocked or unblocked. */
    mac: string;
    /** Site the operation was applied to. */
    siteId: string;
    /** True if the client is now blocked, false if it was unblocked. */
    blocked: boolean;
}
