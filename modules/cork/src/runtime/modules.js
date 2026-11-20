/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The modules translated code lives in: instantiating one over the memory,
 * the helpers and the shared function table (`instantiate`); placing it in
 * the table (`placeModule`), a range of its own where modules are placed;
 * the modules some running region's function is in (`heldModules`), let go
 * past `cacheBytes` by when they last ran (`evict`) and charged to the host's
 * bound (`charge`); and the compiled modules kept for the other runtimes
 * sharing the store (`share`, `sharedModule`). A region joins its module when
 * it is published and leaves it when it goes; a module no region holds is
 * the collector's.
 */

import { TIER_SLOT, mathImports } from '../emit/region.js';
import { buildHelpersModule } from '../emit/helpers.js';
import { keyOf } from './entries.js';
import { createWeakInstances } from './weak-instances.js';
import { sharedModulesOf } from './shared-modules.js';

/** @typedef {import('./state.js').RegionRecord} RegionRecord */
/** @typedef {import('./state.js').Placed} Placed */
/** @typedef {import('./state.js').Held} Held */

/**
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createModules(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { baseGlobals, clock, entries, imports, layout, leaveOut, memory, ram, resumable,
        settings, sharedMemory, sharesStore, table
    } = /** @type {import('./state.js').Base} */ (state);
    const { MISSES_CAP, counts, refused } = rt;
    // The five helper functions every region imports, defined once here and
    // instantiated over this memory when the first region is published.
    /** @type {any} */
    let helperInstance = null;
    const helperImports = ()=>{
        if (helperInstance === null)
        {
            const module = new WebAssembly.Module(
                /** @type {Uint8Array<ArrayBuffer>} */ (buildHelpersModule(layout, sharedMemory)));
            helperInstance = new WebAssembly.Instance(module,
                { env: { memory, ...ram === undefined ? {} : { ram } } }).exports;
        }
        return /** @type {any} */ (helperInstance);
    };
    /** @type {number[]} table indices of dropped regions, reused where modules are not
     * placed: a placed module's range is its own until its last region goes (`placeModule`) */
    const freeTable = [];
    /** The ranges of placed modules whose regions have all gone, for others to take.
     * @type {{ base: number, arms: number }[]} */
    const freeRanges = [];
    /** @type {WeakMap<WebAssembly.Instance, Placed>} */
    const placedOf = new WeakMap();
    /** The placed modules with running regions. @type {Set<Placed>} */
    const placedLive = new Set();
    /** The running region at each table index. @type {Map<number, RegionRecord>} */
    const recordAt = new Map();
    /** @type {Map<WebAssembly.Instance, Held>} */
    const heldModules = new Map();
    let heldBytes = 0;
    /** Each instance's wasm bytes, and the store key its batch is kept under.
     * @type {WeakMap<WebAssembly.Instance, number>} */
    const instanceBytes = new WeakMap();
    /** @type {WeakMap<WebAssembly.Instance, string>} */
    const instanceKeys = new WeakMap();
    /** A module compiled off the thread, by its bytes. @type {WeakMap<WebAssembly.Module, number>} */
    const compiledBytes = new WeakMap();
    /** The store a batch's compiled module is kept for, in this thread or another one
     * (`share`): none for a run that keeps no store or no modules. */
    const keepsModulesFor = leaveOut.size > 0 || settings.blockProfile === true
        || !(settings.sharedModuleBytes > 0) ? null : settings.store ?? null;
    /** The compiled modules of every runtime sharing the store, by store key
     * (`shared-modules.js`): none for a run that keeps no store, nor where no
     * other runtime of this thread would take them. */
    const sharedModules = keepsModulesFor === null || sharesStore === null ? null
        : sharedModulesOf(sharesStore, settings.sharedModuleBytes);
    let nextTable = resumable ? TIER_SLOT + 1 : 0;

    /**
     * A placed module (`finishModule`) takes a range of the table, one index
     * per job, job i's function at the range's start plus i: a range a module
     * gave back (`leaveModule`) when one is long enough, else one past the
     * rest. The range is the module's while it has regions, since its transfer
     * function reaches the functions of that range directly, whatever the
     * table holds.
     *
     * @param {WebAssembly.Instance} instance
     */
    const placeModule = instance=>{
        const exported = /** @type {any} */ (instance.exports);
        if (!table || !(exported.arms instanceof WebAssembly.Global))
        {
            return;
        }
        const arms = exported.arms.value;
        const fits = freeRanges.findIndex(range=>range.arms >= arms);
        let base = nextTable;
        if (fits >= 0)
        {
            const range = freeRanges[fits];
            base = range.base;
            range.base += arms;
            range.arms -= arms;
            if (range.arms === 0)
            {
                freeRanges.splice(fits, 1);
            }
        }
        else
        {
            nextTable += arms;
            if (nextTable > table.length)
            {
                table.grow(Math.max(256, nextTable - table.length));
            }
        }
        exported.base.value = base;
        placedOf.set(instance, { base, arms, crossings: exported.crossings,
            crossedTo: exported.crossedTo, seen: 0, records: new Set(), toward: new Map(),
            instance, baseGlobal: exported.base });
    };

    /** A record into its placed module. @param {RegionRecord} record @param {Placed} placed */
    const joinModule = (record, placed)=>{
        record.module = placed;
        placed.records.add(record);
        if (!placedLive.has(placed))
        {
            placed.seen = placed.crossings.value;
            placedLive.add(placed);
        }
    };
    /** A record out of its placed module, dropped or moved. @param {RegionRecord} record */
    const leaveModule = record=>{
        const placed = record.module;
        if (placed === undefined)
        {
            return;
        }
        placed.records.delete(record);
        record.module = undefined;
        if (placed.records.size === 0)
        {
            counts.crossingsGone += placed.crossings.value;
            placedLive.delete(placed);
            for (const other of placedLive)
            {
                other.toward.delete(placed);
            }
            // Its range goes back for another module to take: kept, the table
            // would grow by every batch a run makes, and V8 grows the dispatch
            // table of every instance that imports the table with it, so a run
            // that keeps rewriting its code runs out of memory. The module no
            // longer reaches that range directly (its base is out of every
            // index's reach), and a region of it published again -- a stored one
            // from its instance -- takes an index as an unplaced module's does.
            placed.baseGlobal.value = 0x80000000 | 0;
            placedOf.delete(placed.instance);
            // Emptied too: a function left in a cell holds its whole instance,
            // and a range no module takes again held its module for the run.
            for (let index = placed.base; index < placed.base + placed.arms; index++)
            {
                table?.set(index, null);
            }
            freeRanges.push({ base: placed.base, arms: placed.arms });
        }
    };

    /** Regions let go past `cacheBytes`, by key(entry, top): how many times, so
     * one brought back is kept the longer the more often it went. @type {Map<number, number>} */
    const evictedKeys = new Map();
    /** Translated instructions a module brought back is kept whatever its mark, twice as
     * many each time again. */
    const EVICT_HOLD = 1 << 28;

    /**
     * A record into the module its function is in; a module not held yet is
     * made room for first. Its entries stamp the module from then on.
     *
     * @param {RegionRecord} record @param {WebAssembly.Instance} instance
     */
    const joinHeld = (record, instance)=>{
        let held = heldModules.get(instance);
        if (held === undefined || record.held !== held)
        {
            leaveHeld(record);
            if (held === undefined)
            {
                const bytes = instanceBytes.get(instance) ?? 0;
                makeRoom(bytes);
                const charged = chargeFor(bytes);
                held = { instance, bytes, records: new Set(), ran: rt.corkRetired, keepUntil: 0,
                    charged };
                heldModules.set(instance, held);
                heldBytes += bytes;
            }
            held.records.add(record);
            record.held = held;
        }
        for (const slot of record.slots)
        {
            entries.at(slot).owner = held;
        }
    };
    /** A record out of its module, dropped or moved: the module is let go with its last.
     * @param {RegionRecord} record */
    const leaveHeld = record=>{
        const held = record.held;
        if (held === undefined)
        {
            return;
        }
        record.held = undefined;
        held.records.delete(record);
        if (held.records.size === 0)
        {
            heldModules.delete(held.instance);
            heldBytes -= held.bytes;
            if (held.charged > 0)
            {
                settings.charge?.give(held.charged);
            }
            settings.letGo?.(held.bytes);
        }
    };
    /**
     * A module's bytes taken from the host's bound (`charge`): where it has no
     * room, the modules gone longest without running are let go until it has.
     * Where none is left to let go and still none fits, the module is held
     * uncharged and counted (`unchargedBytes`): one module past the bound, said,
     * rather than code the program needs refused.
     *
     * @param {number} bytes
     * @returns {number} the bytes taken
     */
    const chargeFor = bytes=>{
        const charge = settings.charge;
        if (!charge || bytes <= 0)
        {
            return 0;
        }
        if (charge.take(bytes))
        {
            return bytes;
        }
        counts.chargeRefused++;
        const retired = rt.corkRetired;
        const order = [...heldModules.values()].sort((a, b)=>
            Number(a.keepUntil > retired) - Number(b.keepUntil > retired) || a.ran - b.ran);
        for (const held of order)
        {
            evict(held);
            if (charge.take(bytes))
            {
                return bytes;
            }
        }
        counts.unchargedBytes += bytes;
        return 0;
    };
    /**
     * Lets modules go until `bytes` more fit under `cacheBytes`: those gone
     * longest without running first, one brought back lately only once the
     * rest have gone. A module larger than the ceiling is held alone.
     *
     * @param {number} bytes
     */
    const makeRoom = bytes=>{
        const cap = settings.cacheBytes;
        if (!(cap > 0) || heldBytes + bytes <= cap)
        {
            return;
        }
        const retired = rt.corkRetired;
        const order = [...heldModules.values()].sort((a, b)=>
            Number(a.keepUntil > retired) - Number(b.keepUntil > retired) || a.ran - b.ran);
        for (const held of order)
        {
            if (heldBytes + bytes <= cap)
            {
                break;
            }
            evict(held);
        }
    };
    /**
     * A module let go: its regions leave the entry hash, the table and its
     * range of it, as a write into their code takes them (`unpublish`), and
     * nothing here holds its instance any more. Their records stay in the
     * store, and a miss at one of them brings its module back from there.
     * Only between slices, so no frame of the module is on the stack.
     *
     * @param {Held} held
     */
    const evict = held=>{
        const records = [...held.records];
        for (const record of records)
        {
            const key = keyOf(record.entry, record.entryTop);
            if (evictedKeys.size >= MISSES_CAP && !evictedKeys.has(key))
            {
                evictedKeys.clear();
            }
            evictedKeys.set(key, (evictedKeys.get(key) ?? 0) + 1);
        }
        rt.unpublish(records);
        const key = instanceKeys.get(held.instance);
        if (key !== undefined && batchInstances.get(key) === held.instance)
        {
            batchInstances.delete(key);
        }
        counts.evictions++;
        counts.evictedRegions += records.length;
    };

    /** @param {Uint8Array | WebAssembly.Module} module @returns {number} its wasm bytes */
    const bytesOf = module=>(module instanceof WebAssembly.Module
        ? compiledBytes.get(module) ?? 0 : module?.length ?? 0);

    /**
     * One instance of a module of regions -- a batch's, or a stored region's
     * own -- or null when it is refused (the program then runs on as it did).
     * The worker compiles what it emitted and sends the module along; bytes
     * from the store, or a build made here, are compiled here.
     *
     * @param {Uint8Array | WebAssembly.Module} module
     * @param {number} [bytes]  its wasm bytes, room made for under `cacheBytes` first
     * @param {string} [shareAs]  the store key of a batch's module, under which the
     *     runtimes sharing the store find it compiled (`share`)
     * @returns {WebAssembly.Instance | null}
     */
    const instantiate = (module, bytes = bytesOf(module), shareAs = undefined)=>{
        makeRoom(bytes);
        const instantiateAt = clock();
        try
        {
            const compiled = module instanceof WebAssembly.Module
                ? module
                : new WebAssembly.Module(/** @type {Uint8Array<ArrayBuffer>} */ (module));
            if (shareAs !== undefined)
            {
                share(shareAs, compiled, bytes);
            }
            const instance = new WebAssembly.Instance(compiled, {
                env: {
                    memory, ...ram === undefined ? {} : { ram }, trap: imports.trap,
                    rdtsc: imports.rdtsc ?? (()=>0n),
                    ...mathImports(), ...helperImports(), ...(table ? { table } : {}),
                    ...baseGlobals,
                },
            });
            counts.modules++;
            instanceBytes.set(instance, bytes);
            placeModule(instance);
            return instance;
        }
        catch (e){
            refused.batch = (refused.batch ?? 0) + 1;
            refused[`batch: ${String(e).slice(0, 120)}`] = 1;
            return null;
        }
        finally
        {
            counts.instantiateMs += clock() - instantiateAt;
        }
    };

    /**
     * Instances of the batch modules this run has, by their store key, so a
     * stored region finds its batch's module already instantiated -- held
     * weakly. What keeps a batch's instance is a region of it still in the
     * table; one a relink took every region from is garbage, and with a store
     * this map held every one of them for the run: each relink a module of
     * thousands of regions again, past a gigabyte of modules in a level load.
     * A record found here is pinned to its instance (`settle`) until it is
     * published, since the instance may go between the look and the use.
     */
    /** @type {ReturnType<typeof createWeakInstances<WebAssembly.Instance>>} */
    const batchInstances = createWeakInstances();
    /** A batch's instance under its store key, and the key by the instance, which
     * an eviction forgets. @param {string} key @param {WebAssembly.Instance} instance */
    const keepBatch = (key, instance)=>{
        batchInstances.set(key, instance);
        instanceKeys.set(instance, key);
    };

    /**
     * A compiled batch module for the other runtimes sharing the store, under
     * the key its bytes are kept under.
     *
     * @param {string} key @param {WebAssembly.Module | null} module @param {number} bytes
     */
    const share = (key, module, bytes)=>{
        if (keepsModulesFor !== null && module !== null)
        {
            compiledBytes.set(module, bytes);
            sharedModules?.set(key, module, bytes);
            // Kept alive where the store is kept too, for runtimes in other
            // threads: one compiling the same bytes is handed this code,
            // tiered up as it is, by the wasm engine's own cache.
            keepsModulesFor.hold?.(key, module, bytes);
        }
    };
    /**
     * A batch module another runtime sharing the store compiled, or undefined.
     * @param {string} key
     */
    const sharedModule = key=>{
        const one = sharedModules?.get(key);
        if (one === undefined)
        {
            return undefined;
        }
        counts.sharedModules++;
        compiledBytes.set(one.module, one.bytes);
        return one.module;
    };
    return {
        freeTable,
        placedOf,
        placedLive,
        recordAt,
        heldModules,
        get heldBytes(){ return heldBytes; },
        compiledBytes,
        sharedModules,
        get nextTable(){ return nextTable; },
        set nextTable(value){ nextTable = value; },
        joinModule,
        leaveModule,
        evictedKeys,
        EVICT_HOLD,
        joinHeld,
        leaveHeld,
        instantiate,
        batchInstances,
        keepBatch,
        share,
        sharedModule,
    };
}
