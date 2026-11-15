/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * quartz.dll's system clock: CLSID_SystemClock, the IReferenceClock a filter
 * graph runs on when no renderer offers a clock of its own, and the one a
 * program asks for to pace its own streaming.
 *
 * Its time is the machine's own millisecond clock, the one timeGetTime reads,
 * in REFERENCE_TIME's hundred-nanosecond units: Windows' system clock is built
 * on the same multimedia timer, and the documentation promises no finer than a
 * millisecond, so a time read here and timeGetTime read just after never run
 * the other way. GetTime answers S_FALSE when the time has not moved since the
 * last read, as the documentation says.
 *
 * An advise is a kernel timer whose due time the scheduler honours as it
 * honours a waitable timer's: AdviseTime signals the caller's event once at
 * base + offset, AdvisePeriodic releases the caller's semaphore once a period
 * from its start. The clock never waits itself; nothing here needs a thread.
 */

import { describe } from './describe.js';
import { IID_IREFERENCE_CLOCK, IREFERENCE_CLOCK_SLOTS } from './interfaces.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;

/** REFERENCE_TIME units in one millisecond. */
const TICKS_PER_MS = 10_000;

/**
 * @typedef {Object} ClockHost
 * @property {() => number} now  The machine's clock, in milliseconds.
 * @property {(due: number, period: number, fired: () => void) => { cancel: () => void }} at
 *           A kernel timer: `fired` at `due` (milliseconds of `now`), then every
 *           `period` after it when the period is not zero.
 * @property {(handle: number) => void} setEvent
 * @property {(handle: number) => void} releaseSemaphore
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @typedef {Object} ClockState
 * @property {number} last  The last time GetTime answered, in milliseconds; -1 before.
 * @property {Map<number, { cancel: () => void }>} advises
 * @property {number} next  The next cookie.
 */

/** @param {number} low @param {number} high a REFERENCE_TIME passed by value */
const referenceTime = (low, high)=>(high | 0) * 0x1_0000_0000 + (low >>> 0);

/** @param {number} value @returns {Uint8Array} a REFERENCE_TIME's eight bytes */
const quad = value=>{
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, BigInt(Math.trunc(value)), true);
    return bytes;
};

/** @param {number} value @returns {Uint8Array} */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/**
 * The system clock's class.
 *
 * @param {ClockHost} host
 * @returns {() => import('../ole32/objects.js').ComClassDefinition}
 */
export function createSystemClock(host){
    /** @type {Record<string, (state: ClockState, args: number[]) => number>} */
    const clock = {
        /** HRESULT GetTime(REFERENCE_TIME *pTime) */
        GetTime: (state, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const now = Math.floor(host.now());
            host.writeMemory(out >>> 0, quad(now * TICKS_PER_MS));
            const moved = now !== state.last;
            state.last = now;
            return moved ? S_OK : S_FALSE;
        },

        /**
         * HRESULT AdviseTime(REFERENCE_TIME baseTime, REFERENCE_TIME streamTime,
         *                    HEVENT hEvent, DWORD_PTR *pdwAdviseCookie)
         */
        AdviseTime: (state, [baseLow, baseHigh, offsetLow, offsetHigh, event, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const due = referenceTime(baseLow, baseHigh) + referenceTime(offsetLow, offsetHigh);
            if (due <= 0)
            {
                return E_INVALIDARG;
            }
            const cookie = state.next++;
            const advise = host.at(due / TICKS_PER_MS, 0, ()=>{
                // A one-shot advise is gone once it has fired: Unadvise of it is S_FALSE.
                state.advises.delete(cookie);
                host.setEvent(event >>> 0);
            });
            state.advises.set(cookie, advise);
            host.writeMemory(out >>> 0, dword(cookie));
            return S_OK;
        },

        /**
         * HRESULT AdvisePeriodic(REFERENCE_TIME startTime, REFERENCE_TIME periodTime,
         *                        HSEMAPHORE hSemaphore, DWORD_PTR *pdwAdviseCookie)
         */
        AdvisePeriodic: (state, [startLow, startHigh, periodLow, periodHigh, semaphore, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const start = referenceTime(startLow, startHigh);
            const period = referenceTime(periodLow, periodHigh);
            if (start < 0 || period <= 0)
            {
                return E_INVALIDARG;
            }
            const cookie = state.next++;
            // A period shorter than the clock's millisecond fires each millisecond.
            const advise = host.at(start / TICKS_PER_MS, Math.max(1, period / TICKS_PER_MS),
                ()=>host.releaseSemaphore(semaphore >>> 0));
            state.advises.set(cookie, advise);
            host.writeMemory(out >>> 0, dword(cookie));
            return S_OK;
        },

        /** HRESULT Unadvise(DWORD_PTR dwAdviseCookie) */
        Unadvise: (state, [cookie])=>{
            const advise = state.advises.get(cookie >>> 0);
            if (!advise)
            {
                return S_FALSE;
            }
            advise.cancel();
            state.advises.delete(cookie >>> 0);
            return S_OK;
        },
    };

    return ()=>{
        /** @type {ClockState} */
        const state = { last: -1, advises: new Map(), next: 1 };
        return {
            state,
            aggregatable: true,
            // An advise still armed when the clock goes is cancelled: nothing
            // signals a program's event for a clock it has let go.
            destroy: ()=>{
                for (const advise of state.advises.values())
                {
                    advise.cancel();
                }
                state.advises.clear();
            },
            interfaces: [describe(IID_IREFERENCE_CLOCK, IREFERENCE_CLOCK_SLOTS, clock)],
        };
    };
}
