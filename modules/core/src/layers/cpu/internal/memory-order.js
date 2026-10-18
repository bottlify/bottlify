/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether the host's processor may show one thread's plain stores to another
 * out of their order, or let a thread read ahead of a load it waits on -- an
 * arm64 one does, an x86 one does not. A program written for x86 relies on
 * that order between its threads with plain `mov`s: data, then a flag. On a
 * host that reorders, a process on several executors needs cork's ordered
 * variant to keep it (`ordered` in the engine's settings).
 *
 * Read from the platform where it says: node's `process.arch`, a Chromium
 * page's or worker's `userAgentData` (its user agent string names x64 on every
 * Windows machine, arm64 too). Elsewhere from the user agent string; a Mac's
 * says Intel on Apple silicon as well, so a Mac is taken to reorder, as is
 * anything the string does not name: the ordered variant is correct anywhere,
 * only slower where it was not needed.
 *
 * @returns {Promise<boolean>}
 */
export async function reordersPlainAccesses(){
    const scope = /** @type {any} */ (globalThis);
    const arch = scope.process?.versions?.node !== undefined ? scope.process.arch : undefined;
    if (typeof arch === 'string')
    {
        return arch !== 'x64' && arch !== 'ia32';
    }
    const data = scope.navigator?.userAgentData;
    if (typeof data?.getHighEntropyValues === 'function')
    {
        try
        {
            const { architecture } = await data.getHighEntropyValues(['architecture']);
            if (architecture === 'x86')
            {
                return false;
            }
            if (typeof architecture === 'string' && architecture !== '')
            {
                return true;
            }
        }
        catch {
            // Refused or not there: the user agent string below.
        }
    }
    const agent = String(scope.navigator?.userAgent ?? '');
    if (/Macintosh|Mac OS X/.test(agent))
    {
        return true;
    }
    return !/x86_64|x64|Win64|WOW64|amd64|i[3-6]86/i.test(agent);
}
