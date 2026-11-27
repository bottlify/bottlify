/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionClient } from './remote.js';

test('calls a custom action server\'s threads make at once each get their own answer', async()=>{
    // The channel carries no call's name back: two threads of the .NET Framework
    // 4.8's custom action asking at once crossed the answers, and MsiDatabaseOpenView
    // was handed another call's 0 for its [code, view].
    /** @type {{ call: string, args: any[] }[]} */
    const asked = [];
    /** @type {((reply: any) => void)[]} */
    const waiting = [];
    const answer = ()=>{
        const one = asked.shift();
        waiting.shift()?.({ result: one?.call === 'openView' ? [0, 7] : 0 });
    };
    const channel = {
        /** @param {any} message */
        send: async message=>{
            // In the pipe at once; the first writer told so only after the second
            // has written and begun to read - its thread waited its turn.
            asked.push(message);
            await new Promise(resolve=>setTimeout(resolve, message.call === 'openView' ? 5 : 0));
            return true;
        },
        receive: ()=>new Promise(resolve=>{
            waiting.push(resolve);
            setTimeout(answer, 10);
        }),
    };
    const client = sessionClient(/** @type {any} */ (channel));
    const [view, executed] = await Promise.all([client.ask('openView', 'SELECT * FROM `File`'),
        client.ask('execute', 1, null)]);
    assert.deepEqual(view, [0, 7]);
    assert.equal(executed, 0);
});
