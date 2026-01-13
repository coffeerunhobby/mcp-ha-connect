/**
 * Autonomic Priority System
 * Uses powers of 2 for bitwise operations - can combine with OR, check with AND
 *
 * Based on MOQT priority model adapted for home automation tiers:
 * - REFLEX (Tier 0): Immediate autonomous response, no AI delay
 * - SUPERVISED (Tier 1): Quick decision with timeout + default action
 * - INFORMATIONAL (Tier 2): Passive awareness, respects quiet hours
 * - LOG: Debug/metrics, lowest priority
 */

/**
 * Priority levels as powers of 2 for bitwise operations
 */
export enum Priority {
  /** Tier 0: Immediate reflex - smoke, gas, intrusion. No confirmation needed. */
  REFLEX = 1,

  /** Tier 1: Supervised action - requires approval within timeout window */
  SUPERVISED = 32,

  /** Tier 2: Informational alert - passive, respects quiet hours */
  INFORMATIONAL = 64,

  /** Logging/metrics - lowest priority */
  LOG = 128,
}

/**
 * Priority masks for filtering
 */
export const PriorityMask = {
  /** All critical priorities (REFLEX only) */
  CRITICAL: Priority.REFLEX,

  /** Action priorities (REFLEX + SUPERVISED) */
  ACTIONABLE: Priority.REFLEX | Priority.SUPERVISED,

  /** User-facing priorities (everything except LOG) */
  USER_FACING: Priority.REFLEX | Priority.SUPERVISED | Priority.INFORMATIONAL,

  /** All priorities */
  ALL: Priority.REFLEX | Priority.SUPERVISED | Priority.INFORMATIONAL | Priority.LOG,
} as const;

/**
 * Check if a priority matches a mask
 */
export function matchesPriority(priority: Priority, mask: number): boolean {
  return (priority & mask) !== 0;
}

/**
 * Get human-readable priority name
 */
export function getPriorityName(priority: Priority): string {
  switch (priority) {
    case Priority.REFLEX:
      return 'reflex';
    case Priority.SUPERVISED:
      return 'supervised';
    case Priority.INFORMATIONAL:
      return 'informational';
    case Priority.LOG:
      return 'log';
    default:
      return 'unknown';
  }
}

/**
 * Get tier number from priority
 */
export function getPriorityTier(priority: Priority): 0 | 1 | 2 | 3 {
  switch (priority) {
    case Priority.REFLEX:
      return 0;
    case Priority.SUPERVISED:
      return 1;
    case Priority.INFORMATIONAL:
      return 2;
    case Priority.LOG:
      return 3;
    default:
      return 3;
  }
}

/**
 * Check if priority should bypass quiet hours
 */
export function bypassesQuietHours(priority: Priority): boolean {
  // Only REFLEX bypasses quiet hours
  return priority === Priority.REFLEX;
}

/**
 * Check if priority requires immediate action (no AI delay)
 */
export function requiresImmediateAction(priority: Priority): boolean {
  return priority === Priority.REFLEX;
}

/**
 * Check if priority requires user approval
 */
export function requiresApproval(priority: Priority): boolean {
  return priority === Priority.SUPERVISED;
}
