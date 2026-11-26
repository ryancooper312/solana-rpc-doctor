#!/usr/bin/env node

import {diagnoseEndpoint, formatDiagnosticsReport} from '../src/rpc.ts';

function parseArgs(argv) {
    const opts = {
        url: 'https://api.mainnet-beta.solana.com',
        samples: 3,
        timeoutMs: 5000,
        json: false,
        help: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            opts.help = true;
        } else if (arg === '--json') {
            opts.json = true;
        } else if (arg === '--url' && argv[i + 1]) {
            opts.url = argv[++i];
        } else if (arg === '--samples' && argv[i + 1]) {
            opts.samples = Number(argv[++i]) || 3;
        } else if (arg === '--timeout' && argv[i + 1]) {
            opts.timeoutMs = Number(argv[++i]) || 5000;
        }
    }

    return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
    console.log('Usage: solana-rpc-doctor [--url <rpc-url>] [--samples <n>] [--timeout <ms>] [--json]');
    process.exit(0);
}

const report = await diagnoseEndpoint(opts.url, {
    samples: opts.samples,
    timeoutMs: opts.timeoutMs,
});

if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log(formatDiagnosticsReport(report));
}

process.exit(report.healthy ? 0 : 1);
