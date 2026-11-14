/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The variants a region is formed in, and the switches between them: the x87
 * precision control it is compiled for (`precisionAt`), floats computed in
 * f32 or rounded from doubles, a test of the x87 stack's shape at its entries,
 * reads tested against their pages (`checkReads`) and stores through esp
 * untested (`looseStacks`). Each starts at its fast end; a region that leaves
 * because the guest ran under another variant -- an exit the run loop names
 * (`precisionMissed`, `floatMissed`, `shapeMissed`), a fault on a closed page,
 * code met on a stack -- moves its code, or the whole program, to the variant
 * that holds, and the code formed for the old one goes.
 */

import { keyOf } from './entries.js';
import { SharedSwitch } from './shared-code.js';
import { isX87 } from '../emit/x87.js';

/** @typedef {import('../emit/region.js').X87Precision} X87Precision */
/** @typedef {import('./state.js').RegionRecord} RegionRecord */

/** Whether a region holds x87 code: what makes it a variant of its entry's top.
 * @param {import('../region.js').Region} region */
export const usesX87 = region=>region.blocks.some(block=>block.instructions.some(isX87));

/**
 * @param {object} state  the runtime's state (`state.js`), typed inside: its type is
 *     made of what this returns
 */
export function createVariants(state){
    const rt = /** @type {import('./state.js').State} */ (state);
    const { codeShared, entries, layout, settings, view
    } = /** @type {import('./state.js').Base} */ (state);
    const { counts } = rt;
    /**
     * The precision control each x87 region is compiled for, by its entry
     * (`X87Precision`): the one the machine has when the entry is first formed
     * -- single, as Direct3D leaves it, or a wide one -- then, once a region
     * there left because it ran under the other, that one, and after a second
     * such leave a test at every rounding instruction (`mixed`). A program
     * that runs one part of its code under single and another under double --
     * a renderer and a physics library -- keeps each part compiled for its
     * own, where one switch for the whole program put every x87 region of it
     * under the test once both were seen.
     * @type {Map<number, { precision: X87Precision, misses: number }>}
     */
    const precisionAt = new Map();
    /**
     * The precision control a formed region's x87 is compiled for (`precisionAt`),
     * the machine's for an entry not yet seen; `mixed` without `wideFirst`, and for a
     * region with no x87 in it, which tests nothing.
     *
     * @param {import('../region.js').Region} region
     * @returns {X87Precision}
     */
    const precisionOf = region=>{
        if (settings.wideFirst !== true || !usesX87(region))
        {
            return 'mixed';
        }
        let known = precisionAt.get(region.entry);
        if (known === undefined)
        {
            const single = (view().getUint16(layout.x87Control, true) & 0x300) === 0;
            known = { precision: /** @type {X87Precision} */ (single ? 'narrow' : 'wide'),
                misses: 0 };
            precisionAt.set(region.entry, known);
        }
        return known.precision;
    };
    /** The x87 entries by the precision control they are compiled for. */
    const precisionCounts = ()=>{
        const counted = { wide: 0, narrow: 0, mixed: 0 };
        for (const { precision } of precisionAt.values())
        {
            counted[precision]++;
        }
        return counted;
    };
    /**
     * The entries, by `keyOf`, whose single-precision results kept leaving a float's range
     * (`RANGE`): compiled for single, they round every result from a double.
     * @type {Set<number>}
     */
    const roundedKeys = new Set();
    /**
     * A formed region's precision as a job and a record carry it, and whether its
     * single-precision arithmetic runs on floats (`floatSingles`).
     *
     * @param {import('../region.js').Region} region @param {number} entryTop
     */
    const precisionFlags = (region, entryTop)=>{
        const precision = precisionOf(region);
        return { wide: precision === 'wide', narrow: precision === 'narrow',
            floats: precision === 'narrow' && settings.floatSingles !== false
                && !roundedKeys.has(keyOf(region.entry, entryTop)) };
    };
    /**
     * What a job's emitter is told of its precision: nothing for `mixed`, the
     * emitter's default.
     *
     * @param {{ wide?: boolean, narrow?: boolean, floats?: boolean }} one
     */
    const precisionJob = one=>(one.wide === true ? { precision: /** @type {const} */ ('wide') }
        : one.narrow === true ? { precision: /** @type {const} */ ('narrow'),
            ...(one.floats === true ? { floats: true } : {}) } : {});
    /**
     * Whether regions test the pages they read (`checkReads`): from the
     * start when asked, or from the program's first fault on a page it cannot
     * reach.
     */
    let readsChecked = settings.checkReads === true;
    /** Whether regions are made loose (`looseStacks`): until code is translated on a stack. */
    let loose = settings.looseStacks !== false && settings.precise !== true;
    /** The pages of the threads' stacks the host named (`noteStack`). @type {Set<number>} */
    const stackPages = new Set();
    /**
     * Whether a write to the page marks it (`takeWrites`): not on a thread's
     * stack while stores through esp test no page.
     * @param {number} page
     */
    const watchable = page=>!(loose
        && (stackPages.has(page) || codeShared?.onStack(page) === true));
    /** key(entry, top) of the x87 regions whose shape test kept failing: formed checked. */
    const checkedKeys = new Set();

    /**
     * Whether a region's code reaches memory through esp alone (a push, a call,
     * an operand off esp with no index): the accesses a loose region leaves
     * untested.
     *
     * @param {import('../region.js').Region} region
     */
    const throughStack = region=>region.blocks.some(block=>block.instructions.some(
        ({ op, operands })=>op.startsWith('push') || op === 'call' || op === 'enter'
            || operands.some(operand=>operand.kind === 'mem' && operand.base === 4
                && (operand.index ?? -1) < 0)));

    /**
     * Code is translated on a page of a thread's stack: the regions that store
     * through esp untested go, and every region from now on tests them -- a
     * store through esp could write the code itself.
     */
    const stackCodeSeen = ()=>{
        if (!loose)
        {
            return;
        }
        loose = false;
        counts.stackCode++;
        codeShared?.raise(SharedSwitch.STACKS_TESTED);
        const on = new Set([...rt.regions].filter(record=>record.loose)
            .flatMap(record=>[...record.pages]));
        for (const page of on)
        {
            rt.invalidatePage(page);
        }
    };

    /**
     * The program touched a page it cannot reach, and the tier that tested
     * the access faulted it: reads are tested from now on, and the regions
     * that wrapped theirs into RAM go -- the same instruction would read zeros
     * there where the interpreter faults. A program reaches one only on
     * purpose (a reservation it commits in its own handler), and a run
     * switches at most once.
     */
    const readsFaulted = ()=>{
        if (readsChecked || settings.checkReads === false)
        {
            return;
        }
        readsChecked = true;
        counts.readSwitches++;
        codeShared?.raise(SharedSwitch.READS_CHECKED);
        const on = new Set([...rt.regions].filter(record=>record.wrapped)
            .flatMap(record=>[...record.pages]));
        for (const page of on)
        {
            rt.invalidatePage(page);
        }
    };

    /**
     * A region left before a rounding instruction because the machine has
     * another precision control than it was compiled for (PRECISION): the
     * regions holding that instruction compiled for the other go, and their
     * entries are compiled from now on for the one found -- or, an entry whose
     * regions left this way once already, for a test at every rounding
     * instruction (`precisionAt`). Every other region stays as it is.
     *
     * @param {number} eip  the instruction it left before
     */
    const precisionMissed = eip=>{
        const single = (view().getUint16(layout.x87Control, true) & 0x300) === 0;
        const under = single ? 'narrow' : 'wide';
        const going = [...rt.byPage.get(eip >>> 12) ?? []].filter(record=>
            (single ? record.wide : record.narrow) === true
            && record.spans.some(([from, to])=>eip >= from && eip < to));
        for (const record of going)
        {
            const known = precisionAt.get(record.entry);
            // A region compiled before its entry moved on goes without moving it again.
            if (known !== undefined && known.precision === (record.wide ? 'wide' : 'narrow'))
            {
                known.precision = known.misses === 0 ? under : 'mixed';
                known.misses++;
                counts.precisionSwitches++;
            }
        }
        if (going.length > 0)
        {
            rt.unpublish(going);
        }
    };

    /**
     * A region computing single precision on floats left before an operation whose
     * float result is not the processor's (`RANGE`): the host ran it. One that keeps
     * leaving -- data at a float's edge, a result past it -- goes, its entry
     * translated again rounding every result from a double (`roundedKeys`).
     *
     * @param {number} eip  the operation it left before
     */
    const floatMissed = eip=>{
        counts.floatMisses++;
        const going = [...rt.byPage.get(eip >>> 12) ?? []].filter(record=>record.floats === true
            && record.spans.some(([from, to])=>eip >= from && eip < to)
            && (record.floatMisses = (record.floatMisses ?? 0) + 1) >= settings.checkedAfter);
        for (const record of going)
        {
            roundedKeys.add(keyOf(record.entry, record.entryTop));
            counts.floatsRounded++;
        }
        if (going.length > 0)
        {
            rt.unpublish(going);
        }
    };
    /**
     * An entry found the machine's x87 stack in another shape than its block
     * was compiled for, and the host's interpreter runs the block. A region
     * that keeps finding it -- code that faults on purpose, or a function
     * entered with the stack in more than one shape -- is dropped, to be
     * formed again checked; answers it then.
     *
     * @param {number} eip @param {number} top
     * @returns {RegionRecord | null}
     */
    const shapeMissed = (eip, top)=>{
        counts.shapeMisses++;
        const record = rt.recordOf.get(entries.entryOf(eip, top));
        if (record === undefined || record.checked)
        {
            return null;
        }
        record.shapeMisses = (record.shapeMisses ?? 0) + 1;
        if (record.shapeMisses < settings.checkedAfter)
        {
            return null;
        }
        checkedKeys.add(keyOf(record.entry, record.entryTop));
        counts.shapeChecked++;
        rt.unpublish([record]);
        return record;
    };
    /** Whether a formed x87 region is to be translated checked.
     * @param {import('../region.js').Region} region @param {number} entryTop */
    const checkedAt = (region, entryTop)=>usesX87(region)
        && (!settings.x87Shapes || checkedKeys.has(keyOf(region.entry, entryTop)));
    return {
        precisionAt,
        precisionOf,
        precisionCounts,
        roundedKeys,
        precisionFlags,
        precisionJob,
        get readsChecked(){ return readsChecked; },
        get loose(){ return loose; },
        stackPages,
        watchable,
        throughStack,
        stackCodeSeen,
        readsFaulted,
        precisionMissed,
        floatMissed,
        shapeMissed,
        checkedAt,
    };
}
