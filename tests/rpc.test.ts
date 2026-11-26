import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    callSolanaRpc,
    computeLatencyStats,
    diagnoseEndpoint,
    formatDiagnosticsReport,
    summarizePriorityFees,
} from '../src/rpc.ts';

describe('computeLatencyStats', () => {
    it('handles empty samples cleanly', () => {
        assert.deepEqual(computeLatencyStats([]), {
            count: 0,
            minMs: 0,
            p50Ms: 0,
            p95Ms: 0,
            maxMs: 0,
            jitterMs: 0,
        });
    });

    it('computes min, p50, p95, max, and tail jitter', () => {
        const stats = computeLatencyStats([120, 40, 60, 80, 50, 70, 90, 100, 110, 300]);
        assert.equal(stats.count, 10);
        assert.equal(stats.minMs, 40);
        assert.equal(stats.p50Ms, 80);
        assert.equal(stats.p95Ms, 300);
        assert.equal(stats.maxMs, 300);
        assert.equal(stats.jitterMs, 220);
    });
});

describe('summarizePriorityFees', () => {
    it('filters zero-fee slots and summarizes p50/p75/max', () => {
        const summary = summarizePriorityFees([
            {slot: 1, prioritizationFee: 0},
            {slot: 2, prioritizationFee: 0},
            {slot: 3, prioritizationFee: 5000},
            {slot: 4, prioritizationFee: 12000},
            {slot: 5, prioritizationFee: 25000},
            {slot: 6, prioritizationFee: 40000},
        ]);
        assert.equal(summary.sampleCount, 6);
        assert.equal(summary.nonZeroCount, 4);
        assert.equal(summary.recommendedMicroLamports, 12000);
        assert.equal(summary.p75MicroLamports, 25000);
        assert.equal(summary.maxMicroLamports, 40000);
    });

    it('returns zeros when all priority fee samples are zero', () => {
        const summary = summarizePriorityFees([{slot: 10, prioritizationFee: 0}]);
        assert.equal(summary.nonZeroCount, 0);
        assert.equal(summary.recommendedMicroLamports, 0);
    });
});

describe('callSolanaRpc & diagnoseEndpoint', () => {
    it('raises explicit error on HTTP failure and JSON-RPC error objects', async () => {
        const httpErrFetch = (async () => new Response('Bad Gateway', {status: 502})) as typeof fetch;
        await assert.rejects(
            () => callSolanaRpc('https://rpc.example.invalid', 'getHealth', [], {fetchImpl: httpErrFetch}),
            /HTTP 502 from getHealth/,
        );

        const rpcErrFetch = (async () =>
            new Response(JSON.stringify({jsonrpc: '2.0', id: 1, error: {code: -32005, message: 'Node is behind'}}), {
                status: 200,
            })) as typeof fetch;
        await assert.rejects(
            () => callSolanaRpc('https://rpc.example.invalid', 'getHealth', [], {fetchImpl: rpcErrFetch}),
            /RPC getHealth error \(-32005\): Node is behind/,
        );
    });

    it('runs end-to-end diagnostics against a healthy mocked endpoint', async () => {
        const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as {id: number; method: string};
            const map: Record<string, unknown> = {
                getHealth: 'ok',
                getVersion: {'solana-core': '2.1.14'},
                getSlot: 318000100,
                getRecentPrioritizationFees: [
                    {slot: 318000098, prioritizationFee: 0},
                    {slot: 318000099, prioritizationFee: 10000},
                    {slot: 318000100, prioritizationFee: 20000},
                ],
            };
            return new Response(JSON.stringify({jsonrpc: '2.0', id: body.id, result: map[body.method]}), {
                status: 200,
                headers: {'Content-Type': 'application/json'},
            });
        }) as typeof fetch;

        const report = await diagnoseEndpoint('https://rpc.mock.local', {
            fetchImpl: mockFetch,
            samples: 2,
            referenceSlot: 318000110,
        });
        assert.equal(report.healthy, true);
        assert.equal(report.solanaCoreVersion, '2.1.14');
        assert.equal(report.slot, 318000100);
        assert.equal(report.slotLag, 10);
        assert.equal(report.priorityFees.recommendedMicroLamports, 10000);
        assert.equal(report.warnings.length, 0);

        const rendered = formatDiagnosticsReport(report);
        assert.match(rendered, /Status: HEALTHY \(ok\)/);
        assert.match(rendered, /Core Version: 2\.1\.14/);
    });

    it('emits warning when node lags far behind reference slot or fails health check', async () => {
        const laggingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as {id: number; method: string};
            if (body.method === 'getHealth') {
                return new Response(JSON.stringify({jsonrpc: '2.0', id: body.id, error: {code: -32005, message: 'behind'}}), {
                    status: 200,
                });
            }
            if (body.method === 'getSlot') {
                return new Response(JSON.stringify({jsonrpc: '2.0', id: body.id, result: 100}), {status: 200});
            }
            return new Response(JSON.stringify({jsonrpc: '2.0', id: body.id, result: {}}), {status: 200});
        }) as typeof fetch;

        const report = await diagnoseEndpoint('https://lagging.mock.local', {
            fetchImpl: laggingFetch,
            samples: 1,
            referenceSlot: 250,
        });
        assert.equal(report.healthy, false);
        assert.equal(report.slotLag, 150);
        assert.ok(report.warnings.some((w) => w.includes('Health check failed')));
        assert.ok(report.warnings.some((w) => w.includes('trails reference slot by 150')));

        const rendered = formatDiagnosticsReport(report);
        assert.match(rendered, /Status: DEGRADED/);
        assert.match(rendered, /Warnings:/);
    });
});
