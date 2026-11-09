/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A wide window's memory (`wideLayout`), as `BlockMemory` is 4 GiB's: the RAM
 * in its own `memory64` memory, the page flags and the pages' code granules in
 * the state's, addresses as numbers up to 16 GiB. Plain -- every access tests
 * its pages -- and only what long mode's model asks of a memory: reads and
 * writes of up to four bytes, the faults with the first address not reached,
 * the notes of a store into translated code or a watched page.
 */

import { Fault } from './ir.js';
import { Tables, codeRangesAt, pageFlagsAt } from './runtime/layout.js';
import { PageFlag, markWritten } from './runtime/pages.js';

export class WideMemory {
    /**
     * @param {WebAssembly.Memory} memory  the state's and the tables'
     * @param {WebAssembly.Memory} ram  the guest's RAM, its address 0 the guest's
     * @param {import('../../core/src/layers/cpu/engine.js').StateLayout} layout
     * @param {((address: number, size: number) => void) | null} onCodeWrite
     * @param {{ faultEip: number }} owner
     */
    constructor(memory, ram, layout, onCodeWrite, owner){
        const window = /** @type {number} */ (layout.window);
        this.view = new DataView(memory.buffer);
        this.ramView = new DataView(ram.buffer);
        this.ramBytes = new Uint8Array(ram.buffer);
        this.pageFlags = new Uint8Array(memory.buffer, pageFlagsAt(layout), window / 4096);
        this.codeRanges = codeRangesAt(layout);
        this.onCodeWrite = onCodeWrite;
        this.owner = owner;
        this.zeroReadsBelow = 0;
        /** @type {[number, number][]} */
        this.readThrough = [];
    }

    /** @param {number} address */
    closed(address){
        return (this.pageFlags[Math.floor(address / 4096)] & PageFlag.INACCESSIBLE) !== 0;
    }

    /** @param {number} address @param {number} size */
    inaccessible(address, size){
        return this.closed(address) || (size > 1 && this.closed(address + size - 1));
    }

    /**
     * As `BlockMemory.fault`: #GP carrying the first byte not reached.
     *
     * @param {number} address @param {number} size @param {boolean} write
     */
    fault(address, size, write){
        const first = this.closed(address) ? address
            : Math.floor((address + size - 1) / 4096) * 4096;
        return Object.assign(new Fault(13, this.owner.faultEip), { address: first, write });
    }

    /** @param {number} address @param {number} size */
    read(address, size){
        if (this.inaccessible(address, size))
        {
            if (address + size <= this.zeroReadsBelow)
            {
                return 0;
            }
            throw this.fault(address, size, false);
        }
        return size === 1 ? this.ramBytes[address]
            : size === 2 ? this.ramView.getUint16(address, true)
                : this.ramView.getUint32(address, true);
    }

    /** @param {number} address @param {number} size @param {number} value */
    write(address, size, value){
        if (this.inaccessible(address, size))
        {
            throw this.fault(address, size, true);
        }
        if (size === 1)
        {
            this.ramBytes[address] = value;
        }
        else if (size === 2)
        {
            this.ramView.setUint16(address, value, true);
        }
        else
        {
            this.ramView.setUint32(address, value, true);
        }
        for (const page of new Set([Math.floor(address / 4096),
            Math.floor((address + size - 1) / 4096)]))
        {
            if ((this.pageFlags[page] & PageFlag.WATCH) !== 0)
            {
                markWritten(this.pageFlags, page);
            }
        }
        if (this.onCodeWrite !== null
            && (this.codeHit(address) || (size > 1 && this.codeHit(address + size - 1))))
        {
            this.onCodeWrite(address, size);
        }
    }

    /**
     * As `BlockMemory.codeHit`: the byte's page holds translated code and the
     * byte lies within the page's code granules.
     *
     * @param {number} address
     */
    codeHit(address){
        const page = Math.floor(address / 4096);
        if ((this.pageFlags[page] & PageFlag.HAS_CODE) === 0)
        {
            return false;
        }
        const range = this.codeRanges + page * 2;
        const granule = (address & 0xfff) >>> Tables.CODE_GRANULE_SHIFT;
        return granule >= this.view.getUint8(range) && granule < this.view.getUint8(range + 1);
    }
}
