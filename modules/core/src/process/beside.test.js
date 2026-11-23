/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portableOptions } from './beside.js';

test('a process in a worker of its own starts with the run\'s Steam account, not its network', ()=>{
    // A Steam game run first in a worker of its own (concurrency 2) was told no
    // client was running: the whole of `win32` stayed behind, the account with
    // it, and Steamworks failed to initialise where one process at a time ran.
    const tickets = { 221640: Uint8Array.of(1, 2, 3) };
    const steam = { steamId: '76561197960287930', accountName: 'player', apps: [221640],
        appId: 221640, ownershipTickets: tickets };
    const crossing = /** @type {any} */ (portableOptions(/** @type {any} */ ({
        windows: 'win7',
        win32: { steam, trustedRoots: ['AAAA'], handleWords: false,
            network: { connect: ()=>null, name: 'relay' } },
    })));
    assert.deepEqual(crossing.win32.steam, steam);
    assert.deepEqual(crossing.win32.trustedRoots, ['AAAA']);
    assert.equal(crossing.win32.handleWords, false);
    assert.equal(crossing.win32.network, undefined,
        'the transport is the run\'s, reached across the process\'s link');
    assert.equal(crossing.windows, 'win7');
});
