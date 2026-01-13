/**
 * Priority system tests
 */

import { describe, it, expect } from 'vitest';
import {
  Priority,
  PriorityMask,
  matchesPriority,
  getPriorityName,
  getPriorityTier,
  bypassesQuietHours,
  requiresImmediateAction,
  requiresApproval,
} from '../../src/autonomic/priority.js';

describe('Priority enum', () => {
  it('should use powers of 2 for bitwise operations', () => {
    expect(Priority.REFLEX).toBe(1);        // 2^0
    expect(Priority.SUPERVISED).toBe(32);   // 2^5
    expect(Priority.INFORMATIONAL).toBe(64); // 2^6
    expect(Priority.LOG).toBe(128);         // 2^7
  });

  it('should allow bitwise OR combinations', () => {
    const actionable = Priority.REFLEX | Priority.SUPERVISED;
    expect(actionable).toBe(33); // 1 + 32
  });

  it('should allow bitwise AND checks', () => {
    const mask = Priority.REFLEX | Priority.SUPERVISED;

    expect(Priority.REFLEX & mask).toBe(Priority.REFLEX);
    expect(Priority.SUPERVISED & mask).toBe(Priority.SUPERVISED);
    expect(Priority.INFORMATIONAL & mask).toBe(0);
    expect(Priority.LOG & mask).toBe(0);
  });
});

describe('PriorityMask', () => {
  it('should define CRITICAL as REFLEX only', () => {
    expect(PriorityMask.CRITICAL).toBe(Priority.REFLEX);
  });

  it('should define ACTIONABLE as REFLEX + SUPERVISED', () => {
    expect(PriorityMask.ACTIONABLE).toBe(Priority.REFLEX | Priority.SUPERVISED);
  });

  it('should define USER_FACING as all except LOG', () => {
    expect(PriorityMask.USER_FACING).toBe(
      Priority.REFLEX | Priority.SUPERVISED | Priority.INFORMATIONAL
    );
  });

  it('should define ALL as all priorities', () => {
    expect(PriorityMask.ALL).toBe(
      Priority.REFLEX | Priority.SUPERVISED | Priority.INFORMATIONAL | Priority.LOG
    );
  });
});

describe('matchesPriority', () => {
  it('should return true when priority matches mask', () => {
    expect(matchesPriority(Priority.REFLEX, PriorityMask.ACTIONABLE)).toBe(true);
    expect(matchesPriority(Priority.SUPERVISED, PriorityMask.ACTIONABLE)).toBe(true);
  });

  it('should return false when priority does not match mask', () => {
    expect(matchesPriority(Priority.INFORMATIONAL, PriorityMask.ACTIONABLE)).toBe(false);
    expect(matchesPriority(Priority.LOG, PriorityMask.ACTIONABLE)).toBe(false);
  });

  it('should work with USER_FACING mask', () => {
    expect(matchesPriority(Priority.REFLEX, PriorityMask.USER_FACING)).toBe(true);
    expect(matchesPriority(Priority.SUPERVISED, PriorityMask.USER_FACING)).toBe(true);
    expect(matchesPriority(Priority.INFORMATIONAL, PriorityMask.USER_FACING)).toBe(true);
    expect(matchesPriority(Priority.LOG, PriorityMask.USER_FACING)).toBe(false);
  });
});

describe('getPriorityName', () => {
  it('should return correct names', () => {
    expect(getPriorityName(Priority.REFLEX)).toBe('reflex');
    expect(getPriorityName(Priority.SUPERVISED)).toBe('supervised');
    expect(getPriorityName(Priority.INFORMATIONAL)).toBe('informational');
    expect(getPriorityName(Priority.LOG)).toBe('log');
  });

  it('should return unknown for invalid priority', () => {
    expect(getPriorityName(999 as Priority)).toBe('unknown');
  });
});

describe('getPriorityTier', () => {
  it('should return correct tier numbers', () => {
    expect(getPriorityTier(Priority.REFLEX)).toBe(0);
    expect(getPriorityTier(Priority.SUPERVISED)).toBe(1);
    expect(getPriorityTier(Priority.INFORMATIONAL)).toBe(2);
    expect(getPriorityTier(Priority.LOG)).toBe(3);
  });
});

describe('bypassesQuietHours', () => {
  it('should return true only for REFLEX', () => {
    expect(bypassesQuietHours(Priority.REFLEX)).toBe(true);
    expect(bypassesQuietHours(Priority.SUPERVISED)).toBe(false);
    expect(bypassesQuietHours(Priority.INFORMATIONAL)).toBe(false);
    expect(bypassesQuietHours(Priority.LOG)).toBe(false);
  });
});

describe('requiresImmediateAction', () => {
  it('should return true only for REFLEX', () => {
    expect(requiresImmediateAction(Priority.REFLEX)).toBe(true);
    expect(requiresImmediateAction(Priority.SUPERVISED)).toBe(false);
    expect(requiresImmediateAction(Priority.INFORMATIONAL)).toBe(false);
    expect(requiresImmediateAction(Priority.LOG)).toBe(false);
  });
});

describe('requiresApproval', () => {
  it('should return true only for SUPERVISED', () => {
    expect(requiresApproval(Priority.REFLEX)).toBe(false);
    expect(requiresApproval(Priority.SUPERVISED)).toBe(true);
    expect(requiresApproval(Priority.INFORMATIONAL)).toBe(false);
    expect(requiresApproval(Priority.LOG)).toBe(false);
  });
});

describe('Use cases', () => {
  it('should handle smoke detector (REFLEX)', () => {
    const priority = Priority.REFLEX;

    expect(bypassesQuietHours(priority)).toBe(true);
    expect(requiresImmediateAction(priority)).toBe(true);
    expect(requiresApproval(priority)).toBe(false);
    expect(getPriorityTier(priority)).toBe(0);
  });

  it('should handle water leak detection (SUPERVISED)', () => {
    const priority = Priority.SUPERVISED;

    expect(bypassesQuietHours(priority)).toBe(false);
    expect(requiresImmediateAction(priority)).toBe(false);
    expect(requiresApproval(priority)).toBe(true);
    expect(getPriorityTier(priority)).toBe(1);
  });

  it('should handle HVAC filter reminder (INFORMATIONAL)', () => {
    const priority = Priority.INFORMATIONAL;

    expect(bypassesQuietHours(priority)).toBe(false);
    expect(requiresImmediateAction(priority)).toBe(false);
    expect(requiresApproval(priority)).toBe(false);
    expect(getPriorityTier(priority)).toBe(2);
  });

  it('should filter actionable events', () => {
    const events = [
      { name: 'smoke', priority: Priority.REFLEX },
      { name: 'water_leak', priority: Priority.SUPERVISED },
      { name: 'hvac_filter', priority: Priority.INFORMATIONAL },
      { name: 'debug', priority: Priority.LOG },
    ];

    const actionable = events.filter(e => matchesPriority(e.priority, PriorityMask.ACTIONABLE));

    expect(actionable).toHaveLength(2);
    expect(actionable.map(e => e.name)).toEqual(['smoke', 'water_leak']);
  });
});
