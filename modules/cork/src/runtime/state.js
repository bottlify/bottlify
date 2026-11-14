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
 * the page table, the function table and the entries. Nothing here changes
 * after the start.
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
    return { memory, ram, layout, sharedLayout, config, imports, features, nowMs, ramOf, codeBase,
        read, readBytes, settings, cacheVersion, clock, formOptions, formHere, leaveOut, found,
        emitLayout, baseGlobals, sharedMemory, codeShared, pages, codePages, table, resumable,
        entries };
}

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
