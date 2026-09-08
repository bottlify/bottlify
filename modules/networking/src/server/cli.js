/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs a relay from the command line.
 *
 * The allowlist is the only interesting argument. Without one the relay is a
 * private LAN and refuses every connection to the outside, which is what makes
 * running this with no configuration a safe thing to do. `--allow` opens named
 * hosts, and `*.` opens a suffix.
 *
 *     node src/server/cli.js --port 8787 --allow logon.example.com --allow '*.example.net'
 */

import { createRelayServer } from './index.js';

/** @param {string[]} argv */
export function parseArguments(argv){
    /** @type {{ port: number, host: string, allow: string[], origins: string[] }} */
    const parsed = { port: 8787, host: '0.0.0.0', allow: [], origins: [] };
    for (let at = 0; at < argv.length; at++)
    {
        const value = argv[at + 1];
        switch (argv[at])
        {
            case '--port': parsed.port = Number(value); at++; break;
            case '--host': parsed.host = String(value); at++; break;
            case '--allow': parsed.allow.push(String(value)); at++; break;
            case '--origin': parsed.origins.push(String(value)); at++; break;
            default: throw new Error(`unknown argument ${argv[at]}`);
        }
    }
    return parsed;
}

/**
 * Whether a host is on the list.
 *
 * Compared whole-label rather than by substring: a suffix rule for
 * `*.example.com` must not admit `example.com.attacker.net`, and a plain
 * `endsWith` admits exactly that.
 *
 * @param {string[]} allow @param {string} host
 */
export function permits(allow, host){
    const wanted = host.toLowerCase();
    return allow.some(rule=>{
        const pattern = rule.toLowerCase();
        return pattern.startsWith('*.')
            ? wanted.endsWith(pattern.slice(1)) && wanted.length > pattern.length - 1
            : wanted === pattern;
    });
}

/* c8 ignore start -- the entry point, exercised by running it */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')))
{
    const options = parseArguments(process.argv.slice(2));
    const server = createRelayServer({
        port: options.port,
        host: options.host,
        origins: options.origins.length > 0 ? options.origins : undefined,
        policy: request=>permits(options.allow, request.host),
    });
    const port = await server.listen();
    process.stdout.write(`relay listening on ${options.host}:${port}\n`);
}
/* c8 ignore stop */
