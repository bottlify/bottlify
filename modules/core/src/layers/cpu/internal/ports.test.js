/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPorts } from './ports.js';

test('a latched timer count reads back low byte then high, frozen while the clock moves', ()=>{
    let ms = 10;
    const ports = createPorts(()=>ms);
    ports.write(0x43, 1, 0x00);
    ms = 20;
    const low = ports.read(0x40, 1);
    const high = ports.read(0x40, 1);
    const ticks = Math.floor(10 * 1193.182);
    assert.equal(high << 8 | low, 0xffff - (ticks & 0xffff),
        'the count at the latch, not at the read');

    const later = ports.read(0x40, 1) | ports.read(0x40, 1) << 8;
    assert.equal(later, 0xffff - (Math.floor(20 * 1193.182) & 0xffff),
        'the latch is spent: the live count');
});

test('a port nothing answers reads as a floating bus, and the report names it', ()=>{
    const ports = createPorts(()=>0);
    assert.equal(ports.read(0x378, 1), 0xff);
    assert.equal(ports.read(0x378, 4), 0xffffffff);
    ports.write(0x80, 1, 1);
    assert.deepEqual(ports.diagnostics(), ['in 378 x2', 'out 80 x1']);
});
