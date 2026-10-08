/**
 * RequestHandler.fetchPaginated: walks every page; the page size can be lowered
 * for endpoints with a smaller limit.
 */

import { describe, it, expect, vi } from 'vitest';

import { RequestHandler } from '../../src/omadaClient/request.js';

function handlerWithPages(pages: unknown[][], totalRows: number) {
    const handler = Object.create(RequestHandler.prototype) as RequestHandler;
    const get = vi.fn(async (_path: string, params?: Record<string, unknown>) => ({
        errorCode: 0,
        result: { totalRows, data: pages[(params!.page as number) - 1] ?? [] },
    }));
    Object.assign(handler, { get });
    return { handler, get };
}

describe('fetchPaginated', () => {
    it('walks every page with the default page size', async () => {
        const { handler, get } = handlerWithPages([[1, 2], [3]], 3);

        await expect(handler.fetchPaginated('/x', { searchKey: 'a' })).resolves.toEqual([1, 2, 3]);
        expect(get.mock.calls.map((c) => c[1])).toEqual([
            { pageSize: 200, searchKey: 'a', page: 1 },
            { pageSize: 200, searchKey: 'a', page: 2 },
        ]);
    });

    it('takes a smaller page size from the caller, but never the page', async () => {
        const { handler, get } = handlerWithPages([[1]], 1);

        await handler.fetchPaginated('/x', { pageSize: 50, page: 9 });
        expect(get).toHaveBeenCalledWith('/x', { pageSize: 50, page: 1 });
    });
});
