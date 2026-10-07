/**
 * getAutomationTrace goes over the WebSocket (`trace/list`), keyed by the
 * automation's config id — there is no REST trace endpoint in Home Assistant.
 */

import { describe, it, expect, vi } from 'vitest';

import { AutomationOperations } from '../../src/haClient/automations.js';
import type { StateOperations } from '../../src/haClient/states.js';

function setup(state: unknown, traces: unknown = []) {
    const stateOps = { getState: vi.fn().mockResolvedValue(state) } as unknown as StateOperations;
    const wsCommand = vi.fn().mockResolvedValue(traces);
    const request = { get: vi.fn() };
    const ops = new AutomationOperations(stateOps, undefined, request as never, wsCommand as never);
    return { ops, wsCommand, request };
}

const automation = (attributes: Record<string, unknown>) => ({ entity_id: 'automation.relay', state: 'on', attributes });

const run = (id: string, start: string) => ({ run_id: id, timestamp: { start, finish: start }, trigger: 'state of sensor.x' });

describe('AutomationOperations.getAutomationTrace', () => {
    it('lists traces by the automation id attribute, newest first, over the WebSocket only', async () => {
        const { ops, wsCommand, request } = setup(automation({ id: '1700000000000' }), [
            run('a', '2026-10-07T08:00:00Z'),
            run('c', '2026-10-07T10:00:00Z'),
            run('b', '2026-10-07T09:00:00Z'),
        ]);

        const traces = await ops.getAutomationTrace('automation.relay');

        expect(wsCommand).toHaveBeenCalledWith({ type: 'trace/list', domain: 'automation', item_id: '1700000000000' });
        expect(traces.map((t) => t.run_id)).toEqual(['c', 'b', 'a']);
        expect(request.get).not.toHaveBeenCalled();
    });

    it('returns at most `limit` runs (default 5)', async () => {
        const many = Array.from({ length: 8 }, (_, i) => run(String(i), `2026-10-07T0${i}:00:00Z`));
        const { ops } = setup(automation({ id: 7 }), many);

        expect(await ops.getAutomationTrace('automation.relay')).toHaveLength(5);
        expect((await ops.getAutomationTrace('automation.relay', 2)).map((t) => t.run_id)).toEqual(['7', '6']);
    });

    it('explains that a YAML automation without an id has no traces', async () => {
        const { ops, wsCommand } = setup(automation({ friendly_name: 'Relay' }));

        await expect(ops.getAutomationTrace('automation.relay')).rejects.toThrow(/has no 'id'.*no traces/);
        expect(wsCommand).not.toHaveBeenCalled();
    });

    it('reports an unknown automation', async () => {
        const { ops, wsCommand } = setup(null);

        await expect(ops.getAutomationTrace('automation.nope')).rejects.toThrow('Automation automation.nope not found');
        expect(wsCommand).not.toHaveBeenCalled();
    });
});
