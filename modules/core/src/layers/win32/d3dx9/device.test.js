/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceCalls } from './device.js';
import { guestOver } from '../common/guest.fixture.js';

test('a 64-bit object past 4 GiB has its method and a locked rectangle\'s bits read whole',
    async()=>{
    // An image past 4 GiB: its objects, vtables and locked bits have a high dword.
        const base = 2 ** 32 + 0x10000;
        const memory = new Uint8Array(0x100);
        const guest = guestOver(memory, 8, [], 0, base);
        /** @type {number[]} */
        const entries = [];
        const { method, lockedRect } = createDeviceCalls({ guest, callGuest: ({ entry })=>{
            entries.push(entry);
            return Promise.resolve(-1);
        } });
        guest.setPtr(base, base + 0x40);
        guest.setPtr(base + 0x40 + 3 * 8, base + 0x80);
        assert.equal(await method(undefined, base, 3, []), 0xffffffff, 'its HRESULT unsigned');
        assert.deepEqual(entries, [base + 0x80]);
        guest.set32(base + 0x20, 256);
        guest.setPtr(base + 0x28, base + 0x90);
        assert.deepEqual(lockedRect(base + 0x20), { pitch: 256, bits: base + 0x90 });
    });
