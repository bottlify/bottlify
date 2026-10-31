/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from './protobuf.js';
import { appOwnershipTicket } from './session.js';

/** CMsgClientGetAppOwnershipTicketResponse, as Steam answers. */
const Response = { eresult: [1, 'uint32'], app_id: [2, 'uint32'], ticket: [3, 'bytes'] };

/**
 * A connection that answers EMsg 857 for the apps in `owned` and refuses the
 * rest with AccessDenied, as Steam does.
 *
 * @param {Record<number, Uint8Array>} owned
 */
const connection = owned=>/** @type {any} */ ({
    /** @param {number} emsg @param {any} _schema @param {{ app_id: number }} body */
    request: async(emsg, _schema, body)=>{
        assert.equal(emsg, 857);
        const ticket = owned[body.app_id];
        return { body: encode(/** @type {any} */ (Response), ticket
            ? { eresult: 1, app_id: body.app_id, ticket }
            : { eresult: 15, app_id: body.app_id }) };
    },
});

test('an owned app\'s ownership ticket is Steam\'s, and an app not owned has none', async()=>{
    const ticket = Uint8Array.of(1, 2, 3, 4);
    const steam = connection({ 361420: ticket });
    assert.deepEqual(await appOwnershipTicket(steam, 361420), ticket);
    assert.equal(await appOwnershipTicket(steam, 480), null);
});
