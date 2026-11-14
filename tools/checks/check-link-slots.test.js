/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSlots } from './check-link-slots.mjs';

test('a slot of the link filled by plain assignment is found unless said to be once per link',
    ()=>{
        const code = [
            'onWake(handler){',
            '    listener = handler;',
            '},',
            'attach(id, endpoint){',
            '    handlers.endpoint = endpoint;',
            '    // Once per link: the dispatcher.',
            '    handlers.parent ??= parent;',
            '    handlers.com = table; // once per link',
            '    if (handlers.kernel === null) {}',
            '}',
        ].join('\n');
        assert.deepEqual(findSlots(code), [2, 5]);
    });
