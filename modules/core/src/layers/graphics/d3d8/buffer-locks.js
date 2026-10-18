/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { D3DLOCK } from './constants.js';

/**
 * A Direct3D 8 or 9 vertex or index buffer's locks, which nest: the runtime
 * counts them, and a buffer is free again once every lock has its unlock. A
 * program that fills a dynamic index buffer a piece at a time may lock the
 * next piece before it unlocks the last, and a refusal there was an
 * assertion box a frame.
 *
 * The renderer holds one lock of a buffer at a time, so a nested lock that
 * reaches outside what is held lets it go and takes the union again under
 * NOOVERWRITE: what the first lock wrote is kept, and the last unlock sends
 * all of it.
 *
 * @param {Object} options
 * @param {number} options.length  The buffer's size in bytes.
 * @param {(offset: number, length: number, flags: number) => void} options.lock
 * @param {() => void} options.unlock
 */
export function createBufferLocks({ length, lock, unlock }){
    let count = 0;
    let from = 0;
    let to = 0;
    return {
        /** How many locks are held. */
        get count(){
            return count;
        },

        /**
         * A lock of `size` bytes from `offset`, zero meaning to the end.
         *
         * @param {number} offset @param {number} size @param {number} flags D3DLOCK
         * @returns {number | null} the length locked, or null for a range the
         *     buffer does not have
         */
        take(offset, size, flags){
            const locked = size === 0 ? length - offset : size;
            if (offset < 0 || !(locked > 0) || offset + locked > length)
            {
                return null;
            }
            if (count === 0)
            {
                from = offset;
                to = offset + locked;
                lock(offset, locked, flags);
            }
            else if (offset < from || offset + locked > to)
            {
                from = Math.min(from, offset);
                to = Math.max(to, offset + locked);
                unlock();
                lock(from, to - from, D3DLOCK.NOOVERWRITE);
            }
            count++;
            return locked;
        },

        /** @returns {boolean} false when nothing was locked */
        release(){
            if (count === 0)
            {
                return false;
            }
            count--;
            if (count === 0)
            {
                unlock();
            }
            return true;
        },
    };
}
