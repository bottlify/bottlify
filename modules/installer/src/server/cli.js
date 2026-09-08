/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs a bottle server from the command line.
 *
 * The token is not an argument. A secret on a command line is in the process
 * list and in a shell history, and this one admits anybody to a place that
 * writes gigabytes to disk.
 *
 *     BOTTLIFY_UPLOAD_TOKEN=... node src/server/cli.js --root bundles --port 8788
 */

import { createBottleServer } from './index.js';

/** @param {string[]} argv */
export function parseArguments(argv){
    /** @type {{ root: string, port: number, host: string }} */
    const parsed = { root: 'bundles', port: 8788, host: '127.0.0.1' };
    for (let at = 0; at < argv.length; at++)
    {
        const value = argv[at + 1];
        switch (argv[at]){
            case '--root': parsed.root = String(value); at++; break;
            case '--port': parsed.port = Number(value); at++; break;
            case '--host': parsed.host = String(value); at++; break;
            default: throw new Error(`unknown argument ${argv[at]}`);
        }
    }
    return parsed;
}

/* c8 ignore start -- the entry point, exercised by running it */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')))
{
    const options = parseArguments(process.argv.slice(2));
    const token = process.env.BOTTLIFY_UPLOAD_TOKEN ?? '';
    if (!token)
    {
        process.stderr.write('BOTTLIFY_UPLOAD_TOKEN is not set; the endpoint is not public\n');
        process.exit(1);
    }
    const server = createBottleServer({ ...options, token });
    const port = await server.listen();
    process.stdout.write(`bottles: http://${options.host}:${port}/ -> ${options.root}\n`);
}
