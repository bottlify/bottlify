/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `--network ws://host:port/` for the tools that run a program in Node: the
 * relay (`modules/networking`, `node src/server/cli.js`) the run's Winsock
 * reaches the world through, joined in room `harness` as game.mjs joins it.
 * Without the flag a run has the loopback adapter alone, as an app given no
 * network has.
 *
 * `--roots FILE` is a PEM bundle (a Linux machine's
 * /etc/ssl/certs/ca-certificates.crt) whose certificates the machine trusts
 * beside Windows' own defaults: its ROOT store, which a program that does its
 * own TLS has crypt32 judge a server's chain against.
 */

import { readFileSync } from 'node:fs';
import { connectRelay } from '../modules/networking/src/client/index.js';
import { defaultTrustedRoots } from '../modules/core/src/layers/win32/wintrust/roots.js';

/**
 * The transport for `createApp({ win32: { network } })`, or null without
 * `--network`. A relay that does not answer is an error here rather than a
 * machine without a network: a run asked to go online that silently did not
 * would be read as the program's own failure.
 *
 * @param {string[]} argv
 * @returns {Promise<any>}
 */
export async function relayFromArgv(argv){
    const at = argv.indexOf('--network');
    if (at < 0)
    {
        return null;
    }
    const url = argv[at + 1];
    if (!url || !/^wss?:\/\//.test(url))
    {
        throw new Error(`--network wants ws://host:port/ or wss://, not ${url}`);
    }
    return connectRelay({ url, room: 'harness' });
}

/**
 * The roots for `createApp({ win32: { trustedRoots } })`, or null without
 * `--roots`: the bundle's certificates after the default ones.
 *
 * @param {string[]} argv
 * @returns {Uint8Array[] | null}
 */
export function rootsFromArgv(argv){
    const at = argv.indexOf('--roots');
    if (at < 0)
    {
        return null;
    }
    const text = readFileSync(argv[at + 1], 'latin1');
    const found = [...text.matchAll(
        /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)]
        .map(match=>new Uint8Array(Buffer.from(match[1].replace(/\s+/g, ''), 'base64')));
    if (found.length === 0)
    {
        throw new Error(`--roots: no certificate in ${argv[at + 1]}`);
    }
    return [...defaultTrustedRoots(), ...found];
}
