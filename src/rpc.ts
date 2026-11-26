export type JsonRpcRequest = {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown[];
};

export type PrioritizationFeeSample = {
    slot: number;
    prioritizationFee: number;
};

export type LatencyStats = {
    count: number;
    minMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    jitterMs: number;
};

export type PriorityFeeSummary = {
    sampleCount: number;
    nonZeroCount: number;
    recommendedMicroLamports: number;
    p75MicroLamports: number;
    maxMicroLamports: number;
};

export type RpcDiagnosticsResult = {
    endpoint: string;
    healthy: boolean;
    healthDetail: string;
    solanaCoreVersion: string | null;
    slot: number | null;
    slotLag: number | null;
    latency: LatencyStats;
    priorityFees: PriorityFeeSummary;
    warnings: string[];
};

export type DiagnoseOptions = {
    fetchImpl?: typeof fetch;
    samples?: number;
    timeoutMs?: number;
    referenceSlot?: number;
};

function round2(val: number): number {
    return Math.round(val * 100) / 100;
}

function percentile(sortedAsc: readonly number[], ratio: number): number {
    if (sortedAsc.length === 0) {
        return 0;
    }
    const index = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(sortedAsc.length * ratio) - 1));
    return sortedAsc[index] ?? 0;
}

/**
 * Compute latency distribution percentiles and p95-p50 tail jitter from millisecond samples.
 */
export function computeLatencyStats(samplesMs: readonly number[]): LatencyStats {
    if (samplesMs.length === 0) {
        return {count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, jitterMs: 0};
    }

    const sorted = [...samplesMs].sort((a, b) => a - b);
    const minMs = round2(sorted[0] ?? 0);
    const maxMs = round2(sorted.at(-1) ?? 0);
    const p50Ms = round2(percentile(sorted, 0.5));
    const p95Ms = round2(percentile(sorted, 0.95));
    const jitterMs = round2(Math.max(0, p95Ms - p50Ms));

    return {
        count: sorted.length,
        minMs,
        p50Ms,
        p95Ms,
        maxMs,
        jitterMs,
    };
}

/**
 * Filter zero-fee slots and compute median (p50) and p75 priority fee estimates in micro-lamports.
 */
export function summarizePriorityFees(fees: readonly PrioritizationFeeSample[]): PriorityFeeSummary {
    const nonZero = fees
        .map((entry) => entry.prioritizationFee)
        .filter((fee) => Number.isFinite(fee) && fee > 0)
        .sort((a, b) => a - b);

    if (nonZero.length === 0) {
        return {
            sampleCount: fees.length,
            nonZeroCount: 0,
            recommendedMicroLamports: 0,
            p75MicroLamports: 0,
            maxMicroLamports: 0,
        };
    }

    return {
        sampleCount: fees.length,
        nonZeroCount: nonZero.length,
        recommendedMicroLamports: Math.round(percentile(nonZero, 0.5)),
        p75MicroLamports: Math.round(percentile(nonZero, 0.75)),
        maxMicroLamports: Math.round(nonZero.at(-1) ?? 0),
    };
}

/**
 * Execute a single Solana JSON-RPC 2.0 call with HTTP status and RPC error envelope validation.
 */
export async function callSolanaRpc<TResult>(
    rpcUrl: string,
    method: string,
    params: unknown[] = [],
    options: {fetchImpl?: typeof fetch; timeoutMs?: number; requestId?: number} = {},
): Promise<{result: TResult; durationMs: number}> {
    const fetchFn = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 5000;
    const payload: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: options.requestId ?? 1,
        method,
        ...(params.length > 0 ? {params} : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = performance.now();

    try {
        const resp = await fetchFn(rpcUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const durationMs = performance.now() - start;

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} from ${method}`);
        }

        const parsed = (await resp.json()) as {result?: TResult; error?: {code?: number; message?: string}};
        if (!parsed || typeof parsed !== 'object') {
            throw new Error(`Malformed JSON-RPC payload from ${method}`);
        }
        if (parsed.error) {
            throw new Error(`RPC ${method} error (${parsed.error.code ?? 'unknown'}): ${parsed.error.message ?? 'unknown error'}`);
        }
        if (!('result' in parsed)) {
            throw new Error(`Missing result field in ${method} response`);
        }

        return {result: parsed.result as TResult, durationMs};
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Run health, version, slot lag, latency sampling, and priority fee diagnostics against a Solana RPC endpoint.
 */
export async function diagnoseEndpoint(
    rpcUrl: string,
    options: DiagnoseOptions = {},
): Promise<RpcDiagnosticsResult> {
    const sampleCount = Math.max(1, options.samples ?? 3);
    const warnings: string[] = [];
    const latencySamples: number[] = [];

    let healthy = false;
    let healthDetail = 'unknown';
    try {
        const healthCall = await callSolanaRpc<string>(rpcUrl, 'getHealth', [], options);
        latencySamples.push(healthCall.durationMs);
        healthy = healthCall.result === 'ok';
        healthDetail = String(healthCall.result);
    } catch (err) {
        healthDetail = err instanceof Error ? err.message : String(err);
        warnings.push(`Health check failed: ${healthDetail}`);
    }

    let solanaCoreVersion: string | null = null;
    try {
        const versionCall = await callSolanaRpc<{'solana-core'?: string}>(rpcUrl, 'getVersion', [], options);
        latencySamples.push(versionCall.durationMs);
        solanaCoreVersion = versionCall.result?.['solana-core'] ?? null;
    } catch (err) {
        warnings.push(`getVersion failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let slot: number | null = null;
    for (let i = 0; i < sampleCount; i++) {
        try {
            const slotCall = await callSolanaRpc<number>(rpcUrl, 'getSlot', [{commitment: 'confirmed'}], {
                ...options,
                requestId: i + 10,
            });
            latencySamples.push(slotCall.durationMs);
            slot = slotCall.result;
        } catch (err) {
            warnings.push(`getSlot sample ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    let slotLag: number | null = null;
    if (slot !== null && options.referenceSlot !== undefined) {
        slotLag = Math.max(0, options.referenceSlot - slot);
        if (slotLag > 50) {
            warnings.push(`Node trails reference slot by ${slotLag} slots`);
        }
    }

    let priorityFees: PriorityFeeSummary = summarizePriorityFees([]);
    try {
        const feeCall = await callSolanaRpc<PrioritizationFeeSample[]>(rpcUrl, 'getRecentPrioritizationFees', [], options);
        latencySamples.push(feeCall.durationMs);
        priorityFees = summarizePriorityFees(Array.isArray(feeCall.result) ? feeCall.result : []);
    } catch (err) {
        warnings.push(`getRecentPrioritizationFees failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
        endpoint: rpcUrl,
        healthy,
        healthDetail,
        solanaCoreVersion,
        slot,
        slotLag,
        latency: computeLatencyStats(latencySamples),
        priorityFees,
        warnings,
    };
}

/**
 * Render a human-readable diagnostics report for terminal usage.
 */
export function formatDiagnosticsReport(report: RpcDiagnosticsResult): string {
    const lines = [
        `Solana RPC Doctor — ${report.endpoint}`,
        `Status: ${report.healthy ? 'HEALTHY' : 'DEGRADED'} (${report.healthDetail})`,
        `Core Version: ${report.solanaCoreVersion ?? 'unknown'}`,
        `Confirmed Slot: ${report.slot ?? 'unavailable'}${report.slotLag !== null ? ` (lag: ${report.slotLag} slots)` : ''}`,
        `Latency (ms): min=${report.latency.minMs} p50=${report.latency.p50Ms} p95=${report.latency.p95Ms} max=${report.latency.maxMs} jitter=${report.latency.jitterMs}`,
        `Priority Fees (microLamports): recommended=${report.priorityFees.recommendedMicroLamports} p75=${report.priorityFees.p75MicroLamports} max=${report.priorityFees.maxMicroLamports} (${report.priorityFees.nonZeroCount}/${report.priorityFees.sampleCount} non-zero)`,
    ];

    if (report.warnings.length > 0) {
        lines.push('Warnings:');
        for (const warning of report.warnings) {
            lines.push(`  - ${warning}`);
        }
    }

    return lines.join('\n');
}

