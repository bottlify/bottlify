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
 *
 * Behind a proxy, `--address-header` names the header carrying the client's
 * address (Cloudflare's `cf-connecting-ip`), which the per-address limit then
 * counts by; `--resume-seconds` is how long a peer whose link dropped is kept
 * for its client to come back to.
 */

import { createRelayServer } from './index.js';
import { parseIp } from '../protocol.js';

/** @param {string[]} argv */
export function parseArguments(argv){
    /** @type {{ port: number, host: string, allow: string[], origins: string[],
     *     addressHeader: string, resumeSeconds: number }} */
    const parsed = { port: 8787, host: '0.0.0.0', allow: [], origins: [],
        addressHeader: '', resumeSeconds: 10 };
    for (let at = 0; at < argv.length; at++)
    {
        const value = argv[at + 1];
        switch (argv[at])
        {
            case '--port': parsed.port = Number(value); at++; break;
            case '--host': parsed.host = String(value); at++; break;
            case '--allow': parsed.allow.push(String(value)); at++; break;
            case '--origin': parsed.origins.push(String(value)); at++; break;
            case '--address-header':
                parsed.addressHeader = String(value).toLowerCase();
                at++;
                break;
            case '--resume-seconds':
                parsed.resumeSeconds = Number(value);
                if (!(parsed.resumeSeconds >= 0))
                {
                    throw new Error(`--resume-seconds wants a number, not ${value}`);
                }
                at++;
                break;
            default: throw new Error(`unknown argument ${argv[at]}`);
        }
    }
    return parsed;
}

const DOTTED = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const RANGE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;

/**
 * Whether a host is on the list.
 *
 * Compared whole-label rather than by substring: a suffix rule for
 * `*.example.com` must not admit `example.com.attacker.net`, and a plain
 * `endsWith` admits exactly that. A rule of `*` alone admits every host, for a
 * relay run on one's own machine that is meant to be an open one. A range,
 * `a.b.c.d/n`, admits the addresses in it: a server that hands out addresses
 * rather than names (a game's list of its worlds) is reached by them.
 *
 * @param {string[]} allow @param {string} host
 */
export function permits(allow, host){
    const wanted = host.toLowerCase();
    const address = DOTTED.test(wanted) ? parseIp(wanted) : null;
    return allow.some(rule=>{
        const pattern = rule.toLowerCase();
        if (pattern === '*')
        {
            return true;
        }
        const range = RANGE.exec(pattern);
        if (range)
        {
            const bits = Number(range[2]);
            return address !== null && bits <= 32
                && (bits === 0 || ((address ^ parseIp(range[1])) >>> (32 - bits)) === 0);
        }
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
        resumeWindowMs: options.resumeSeconds * 1000,
        ...(options.addressHeader ? {
            addressOf: (/** @type {import('node:http').IncomingMessage} */ request)=>
                String(request.headers[options.addressHeader]
                    ?? request.socket.remoteAddress ?? ''),
        } : {}),
    });
    const port = await server.listen();
    process.stdout.write(`relay listening on ${options.host}:${port}\n`);
}
/* c8 ignore stop */
