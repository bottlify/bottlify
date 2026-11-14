/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's state: one object every part of the runtime is made over
 * (`createCorkRuntime` builds it part by part, each part's factory taking it
 * and adding what it returns), in place of the closure the parts once shared.
 * This file holds its base: what the host hands the runtime and what follows
 * from it alone -- the settings, the features translated code is made for,
 * the page table, the function table, the entries and the views of guest
 * memory. Nothing here changes after the start.
 */

import { TIER_SLOT } from '../emit/region.js';
import { MODE_64 } from '../decode/decoder.js';
import { features as probeFeatures } from '../wasm/features.js';
import { Body, ModuleBuilder, ValType } from '../wasm/encoder.js';
import { SHARED_MAX_PAGES } from '../wasm/shared-import.js';
import { RUNTIME_HELPERS, routineHelper } from '../helpers.js';
import { createEntries } from './entries.js';
import { codeBlockPages, createPageTable } from './pages.js';
import { createSharedCode } from './shared-code.js';
import { Tables, basesOf, tablesSize } from './layout.js';
import { CACHE_VERSION } from './cache.js';
import { runtimeSettings } from './settings.js';

/** @typedef {import('../../../core/src/layers/cpu/engine.js').EngineEnv} EngineEnv */

/** @type {Function | null} */
let noTier = null;
/**
 * What the table's `TIER_SLOT` holds until the host puts the interpreter tier's
 * entry there (`interpretWith`): a function answering 0, which a miss of the
 * hash takes as no tier and leaves as before. One a process.
 */
function noTierEntry(){
    if (noTier === null)
    {
        const m = new ModuleBuilder();
        const type = m.type({ params: [ValType.i32], results: [ValType.i32] });
        m.function(type, [], new Body().i32const(0).toBytes(), { exportAs: 'none' });
        const bytes = /** @type {Uint8Array<ArrayBuffer>} */ (m.toBytes());
        noTier = /** @type {Function} */ (
            new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.none);
    }
    return noTier;
}


/**
 * What the host hands the runtime, and what follows from it alone.
 *
 * @param {EngineEnv & { features?: ReturnType<typeof probeFeatures> }} env
 */
export function baseState({ memory, ram, layout, sharedLayout = undefined, config = {},
    read, readBytes, imports, features, now: nowMs = ()=>performance.now() })
{
    // The memory holding guest RAM: a wide window's own (`ramMemory`), else the one memory.
    if ((layout.ramMemory !== undefined) !== (ram !== undefined))
    {
        throw new Error('cork: a wide window\'s RAM is its own memory, given with it');
    }
    const ramOf = ram ?? memory;
    // A code block's (`codeBase`): the translator's addresses are offsets in it, the host's,
    // its bytes' and the page table's the window's.
    const codeBase = layout.codeBase ?? 0;
    if (codeBase !== 0)
    {
        const byte = read;
        const bytes = readBytes;
        read = byte && (address=>byte(address + codeBase));
        readBytes = bytes && ((start, end)=>bytes(start + codeBase, end + codeBase));
    }
    const settings = runtimeSettings(config);
    // The version translations are kept under: the translator's own, or a higher one
    // the host asks for, which empties every store of a lower version. Never lower
    // than the emitter's -- a record of an older emitter is code that is wrong now.
    const cacheVersion = Math.max(CACHE_VERSION, config.cacheVersion ?? 0);
    /** The host clock for a diagnostic timing, or zero when timings are off. */
    const clock = import.meta.BOTTLIFY_DIAGNOSTICS !== false && settings.timings === true
        ? ()=>performance.now() : ()=>0;
    /** How a region is formed, the same on this thread, in a batch and in a relink. */
    const formOptions = { maxBlocks: settings.maxRegionBlocks, leafCalls: settings.leafCalls,
        leafBytes: settings.leafBytes, formDepth: settings.formDepth,
        coldReach: settings.coldReach,
        // Long mode's code formed as long mode's, the shared emitter's own cuts in it.
        ...layout.bits === 64 ? { mode: MODE_64 } : {},
        // A wide window's import slots are not checked as a call through one runs.
        ...layout.window !== undefined ? { slotHelpers: false } : {},
        // The dictionary's functions formed as what they do (`emit/crt.js`), or
        // none; a list of entries in place of the dictionary is a test's.
        ...settings.helpers === true || settings.helpers === undefined
            ? settings.helpersAlso === undefined ? {}
                : { helpers: [...RUNTIME_HELPERS, ...settings.helpersAlso.map(routineHelper)] }
            : { helpers: settings.helpers } };
    /** The same on this thread, with the host's copy of a span at once where it has one; a
     * worker is sent `formOptions`, which a function cannot cross in. */
    const formHere = readBytes === undefined ? formOptions
        : { ...formOptions, bytesOf: readBytes };
    /** @type {Set<string>} instruction classes left to the other executor */
    const leaveOut = new Set(settings.leaveOut ?? []);
    if (layout.tables + tablesSize(layout) > memory.buffer.byteLength)
    {
        throw new Error(`cork: the memory ends at ${memory.buffer.byteLength}, before the tables`
            + ` at ${layout.tables} + ${tablesSize(layout)}`);
    }
    const probed = features ?? probeFeatures();
    // An arm64 host is known by its default NaN, whatever NaN the emitter makes for it.
    const found = probed.defaultNaNNegative || settings.exactNaN === true ? probed
        : { ...probed, defaultNaNNegative: true, armHost: true };
    // The layout translations are made for: the process's shared one where it
    // has several executors, whose bytes every executor instantiates over its
    // own state block and tables, given as the instance's bases -- so a
    // translation's key and its arena entries are the same on every executor;
    // this executor's own otherwise. Whatever reads or writes the state from
    // here, the helpers included, keeps to the executor's own (`layout`).
    const emitLayout = sharedLayout ?? layout;
    /** The globals an instance of a shared-layout module is given: where this executor's are. */
    const baseGlobals = emitLayout.shared === true ? Object.fromEntries(
        Object.entries(basesOf(layout)).map(([name, at])=>[name,
            new WebAssembly.Global({ value: 'i32', mutable: false }, at)])) : {};
    // A shared memory links only to modules whose import says so, with a
    // maximum: every module emitted here, and the helpers, declare it.
    const sharedMemory = typeof SharedArrayBuffer === 'function'
        && memory.buffer instanceof SharedArrayBuffer
        ? { shared: true, maxPages: SHARED_MAX_PAGES }
        : undefined;
    const codeShared = settings.sharedCode
        ? createSharedCode(memory, settings.sharedCode.at, settings.sharedCode.index) : null;
    const pages = createPageTable(memory, layout, codeShared);
    const codePages = codeBlockPages(pages, codeBase);
    // With tail calls, every region function goes into one table shared by
    // every module, and every entry into the hash translated code probes:
    // a return or an indirect jump into translated code then transfers
    // without leaving wasm. Without them, the slice loop is the only way
    // between regions.
    const table = found.tailCalls
        ? new WebAssembly.Table({ element: 'anyfunc', initial: 256 })
        : null;
    // A miss of the hash may run the interpreter tier in wasm through the
    // table (`interpretWith`); its slot is no region's.
    const resumable = table !== null;
    if (resumable)
    {
        table.set(TIER_SLOT, noTierEntry());
    }
    // Past three quarters of the entry hash's slots live, a block start is kept
    // in the host's map alone (`createEntries`' own share).
    const entries = createEntries(
        table ? { memory, hashBase: layout.tables + Tables.HASH, shift: layout.hashShift ?? 16,
            zeroed: settings.tablesZeroed === true } : {});
    /** @type {DataView | null} */
    let cachedView = null;
    // One view, taken again only when the memory grew (which detaches the
    // buffer it was on): a view per region run was a fifth of a call's cost.
    const view = ()=>{
        // A grown memory detaches the old buffer, whose length then reads 0:
        // asked of the view's own buffer, not of `memory.buffer`, whose getter
        // is a crossing into the engine on every run.
        if (cachedView === null || cachedView.buffer.byteLength === 0)
        {
            cachedView = new DataView(memory.buffer);
        }
        return cachedView;
    };
    /** @type {Uint8Array | null} */
    let cachedBytes = null;
    /**
     * The guest's bytes `[address, end)` where they lie in the memory, or null
     * where a byte is past RAM and only `read` answers it: what compares a
     * store's range with a copy byte by byte, which through `read` was a call
     * a byte -- tens of microseconds for half a page.
     *
     * @param {number} address @param {number} end
     */
    const guestBytes = (address, end)=>{
        if (typeof layout.ramSize !== 'number' || address < 0
            || codeBase + end > layout.ramSize)
        {
            return null;
        }
        // A shared memory that grew keeps its old buffer whole, only shorter
        // than the memory now is: taken again once a range reaches past it.
        if (cachedBytes === null || cachedBytes.buffer.byteLength === 0
            || cachedBytes.length < layout.ramBase + codeBase + end)
        {
            cachedBytes = new Uint8Array(ramOf.buffer);
        }
        return cachedBytes.length < layout.ramBase + codeBase + end ? null
            : cachedBytes.subarray(layout.ramBase + codeBase + address,
                layout.ramBase + codeBase + end);
    };
    const counterWord = ()=>view().getUint32(layout.counter, true);
    /** Whether every block counts its executions (`blockProfile`). */
    const profiling = import.meta.BOTTLIFY_DIAGNOSTICS !== false && settings.blockProfile === true;
    /** Whether translated code counts its transfers through the hash (`countTransfers`). */
    const transfersCounted = import.meta.BOTTLIFY_DIAGNOSTICS !== false
        && settings.countTransfers === true;
    return { memory, ram, layout, sharedLayout, config, imports, features, nowMs, ramOf, codeBase,
        read, readBytes, settings, cacheVersion, clock, formOptions, formHere, leaveOut, found,
        emitLayout, baseGlobals, sharedMemory, codeShared, pages, codePages, table, resumable,
        entries, view, guestBytes, counterWord, profiling, transfersCounted };
}

/**
 * A module placed in the table (`placeModule`): its range's start and
 * length, its counts of what left it through the table, and its running
 * regions.
 *
 * @typedef {{ base: number, arms: number, crossings: WebAssembly.Global,
 *     crossedTo: WebAssembly.Global, seen: number, records: Set<RegionRecord>,
 *     toward: Map<Placed, number>, instance: WebAssembly.Instance,
 *     baseGlobal: WebAssembly.Global }} Placed
 *   seen: `crossings` when last read; toward: crossings into each other module
 */

/**
 * A module some running region's function is in (`cacheBytes`): its wasm
 * bytes, those regions, the translated instructions (`corkRetired`) when
 * one of them last ran -- an entry from the host, a crossing out of the
 * module or into it -- and until when one brought back after an eviction
 * is kept whatever that says; `charged`, its bytes taken from the host's
 * bound (`charge`).
 *
 * @typedef {{ instance: WebAssembly.Instance, bytes: number,
 *     records: Set<RegionRecord>, ran: number, keepUntil: number, charged: number }} Held
 */

/**
 * @typedef {Object} RegionRecord
 * @property {number} entry
 * @property {Set<number>} pages
 * @property {Set<number>} [reads]   every page forming read: what a worker forms it from
 * @property {Set<number>} [formable]   every page forming was told it may form code on
 * @property {number[]} slots   entry indices
 * @property {number} table     the function's index in the table, or -1
 * @property {[number, number][]} spans   the blocks' [start, end)
 * @property {{ start: number, bytes: Uint8Array }[]} [sources]  every byte forming read,
 *     as it read them, kept where a store into code reached one of its pages before: a
 *     later store there drops it only when it changes one of them (`storedInto`)
 * @property {Map<number, [number, number]>} extents  by page, the code granules its
 *     blocks cover there, [from, to)
 * @property {number} entryTop  the x87 top it was formed for
 * @property {string} hash      of its bytes, which a relink forms it from again
 * @property {string} labels    its block starts and labels, which a relinked function
 *     must keep for the entries to stand
 * @property {boolean} [linked]  its function is in a relinked module already
 * @property {boolean} [wide]  an x87 region compiled for the wide precision controls
 * @property {boolean} [narrow]  an x87 region compiled for single precision
 * @property {boolean} [floats]  of those, one computing on floats in f32 (`floatSingles`)
 * @property {boolean} [loose]  compiled with its stores through esp untested (`looseStacks`)
 * @property {boolean} [anyTop]  no x87 in it: kept in the store at any top (`regionKey`)
 * @property {boolean} [byHash]  kept in the store under its bytes' hash too (`storeKey`)
 * @property {boolean} [wrapped]  compiled with its reads wrapped into RAM, untested
 * @property {boolean} [checked]  an x87 region whose entries test nothing of the stack's shape
 * @property {boolean} [copies]  its blocks inside its loops are entered through copies
 *     (`emitRegion`); without, they have no entry (`closed`)
 * @property {number[]} [closed]  the starts of those blocks with no entry
 * @property {number} [blocks]  how many blocks it has: a label from twice as many is a copy's
 * @property {Placed} [module]  the placed module its table index is in (`placeModule`)
 * @property {Held} [held]  the module its function is in (`cacheBytes`)
 * @property {number} [heat]  its entries and the crossings into it, halved at each
 *     reading (`foldHeat`)
 * @property {number} [crossed]  crossings into it read since the last reading
 * @property {boolean} [movedAlone]  a merge took it alone into the module calling it
 * @property {number} [merged]  the merges that built it again (`MERGES_A_REGION`)
 * @property {number} [floatMisses]  its float results that were not the processor's
 * @property {number} [shapeMisses]  its entries' tests that failed
 * @property {[number, number[]][]} [targets]  by indirect call, the callees formed into it
 * @property {Map<number, number[]>} [unformed]  by indirect call, the callees forming it
 *     again did not take in (the region full): not asked of it again
 * @property {Map<number, number>} [reforms]  by indirect call, times it was formed again
 *     for that call: a site's own budget, which its region's other sites do not spend
 */

/**
 * The state the runtime's parts are made over: the base and every part's
 * members. `Late` is what runtime.js itself still lends the parts.
 *
 * @typedef {Record<string, any>} Late
 * @typedef {ReturnType<typeof baseState>
 *     & ReturnType<typeof import('./diagnostics.js').createDiagnostics>
 *     & ReturnType<typeof import('./variants.js').createVariants>
 *     & Late} State
 */

/**
 * Adds a part's members to the state, accessors as accessors: a part's
 * mutable value is read and written through the part that owns it.
 *
 * @template {object} S
 * @template {object} P
 * @param {S} rt @param {P} part
 * @returns {S & P}
 */
export const join = (rt, part)=>/** @type {S & P} */ (
    Object.defineProperties(rt, Object.getOwnPropertyDescriptors(part)));
