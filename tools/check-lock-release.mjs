/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a guest routine the engine writes itself stores to a word it
 * takes with a locked instruction (`xchg` with memory, a `lock` prefix) with a
 * plain one: a lock let go, a count given back, as a `mov`.
 *
 * On several executors the locked instructions are wasm atomics and a plain
 * store is the host's plain store, which a host that reorders stores (arm64)
 * may show another executor before the stores made ahead of it: the thread
 * that takes the lock next finds it free and reads what the last holder wrote
 * under it as it was before. The device's lock let go with a `mov` drew models
 * of Call of Duty 4 from the frame before; the heap's handed two threads one
 * cell.
 *
 * A store is taken to reach the same word as a locked access when its operand
 * has the same base, index and displacement, or the same displacement far
 * into a block (a block's field reached through another register).
 *
 *     node tools/check-lock-release.mjs
 */

import { decode } from '../modules/cork/src/decode/decoder.js';
import {
    commandCode, getRenderStateCode, getSamplerStateCode, getShaderCode, getSurfaceDescCode,
    getSurfaceLevelCode, getTargetCode, getTextureStageStateCode, getTransformCode,
    getViewportCode, lock7Code, lockCode, lockLevelCode, moveCopyCode, unlockCode,
    unlockLevelCode,
} from '../modules/core/src/layers/graphics/seam/shadow.js';
import { COMMANDS as D3D9_COMMANDS, commandSlot as d3d9Slot }
    from '../modules/core/src/layers/graphics/d3d9/commands.js';
import { D3D8_COMMANDS } from '../modules/core/src/layers/graphics/d3d8/commands.js';
import { D3D7_COMMANDS } from '../modules/core/src/layers/graphics/d3d7/commands.js';
import { GL_COMMANDS } from '../modules/core/src/layers/graphics/opengl/commands.js';
import {
    callocCode, freeCode, globalAllocCode, globalFreeCode, heapAllocCode, heapFreeCode,
    heapReAllocCode, heapSizeCode, mallocCode, msizeCode, reallocCode,
} from '../modules/core/src/layers/win32/kernel32/guest-heap.js';
import { enterCode, leaveCode, tryEnterCode } from '../modules/core/src/layers/win32/kernel32/critical.js';
import { eventStateCode, releaseMutexCode, waitOneCode }
    from '../modules/core/src/layers/win32/kernel32/wait-one.js';
import {
    COMPARE_EXCHANGE_CODE, DECREMENT_CODE, EXCHANGE_ADD_CODE, EXCHANGE_CODE, INCREMENT_CODE,
} from '../modules/core/src/layers/win32/kernel32/interlocked.js';
import { queryPerformanceCounterCode, sleepCode }
    from '../modules/core/src/layers/win32/kernel32/process.js';
import { executeOnceCode, sleepCsCode, sleepSrwCode }
    from '../modules/core/src/layers/win32/kernel32/slimsync.js';

const AT = 0x20000;
const TRAP = 0x105000;
/** A heap's routines' placement: where the directory and the class map lie. */
const PLACED = { dirBase: 0x400000, dirSpan: 0x1000000, directory: 0x30000, classMap: 0x31000 };

/**
 * The instructions of `code`, each with its memory operand, if any.
 *
 * @param {Uint8Array} code
 * @returns {{ op: string, locked: boolean, writes: boolean, mem: any }[]}
 */
function instructionsOf(code){
    /** The operations that only read their memory operand. */
    const reads = new Set(['cmp', 'test', 'bt', 'push', 'lea', 'jmp', 'call']);
    const found = [];
    for (let at = 0; at < code.length;)
    {
        const decoded = /** @type {any} */ (decode(address=>code[address - AT] ?? 0, AT + at));
        if ('reason' in decoded)
        {
            // Data after a routine's last jump (a table, padding): the rest is not code.
            break;
        }
        const operands = decoded.operands ?? [];
        const mem = operands.find((/** @type {any} */ operand)=>operand?.kind === 'mem');
        const locked = mem !== undefined
            && (decoded.op === 'xchg' || decoded.prefixes?.lock === true);
        const writes = mem !== undefined && !reads.has(decoded.op)
            && (decoded.op === 'xchg' || operands[0] === mem || decoded.op.startsWith('cmpxchg'));
        found.push({ op: decoded.op, locked, writes, mem });
        at += decoded.length;
    }
    return found;
}

/** Displacements this far into a block name its field whatever register holds the block. */
const FAR = 0x100;

/** @param {any} a @param {any} b */
const sameWord = (a, b)=>(a.base ?? -1) === (b.base ?? -1) && (a.index ?? -1) === (b.index ?? -1)
    && (a.disp ?? 0) === (b.disp ?? 0)
    || ((a.disp ?? 0) >= FAR && (a.disp ?? 0) === (b.disp ?? 0) && (a.index ?? -1) < 0
        && (b.index ?? -1) < 0);

/** @type {[string, Uint8Array][]} */
const routines = [
    ['Lock', lockCode(AT, TRAP)],
    ['Lock with moves', lockCode(AT, TRAP, 0x7f, AT + 0x1000)],
    ['the copy of a move', moveCopyCode()],
    ['Lock (Direct3D 7)', lock7Code(AT, TRAP)],
    ['Unlock', unlockCode(AT, TRAP)],
    ['texture LockRect', lockLevelCode(AT, TRAP, { find: 'texture' })],
    ['texture LockBox', lockLevelCode(AT, TRAP, { find: 'texture', box: true })],
    ['surface LockRect', lockLevelCode(AT, TRAP, { find: 'surface' })],
    ['texture UnlockRect', unlockLevelCode(AT, TRAP, { find: 'texture' })],
    ['surface UnlockRect', unlockLevelCode(AT, TRAP, { find: 'surface' })],
    ['GetRenderTarget', getTargetCode(AT, TRAP, { depth: false, indexed: true })],
    ['GetDepthStencilSurface', getTargetCode(AT, TRAP, { depth: true, indexed: false })],
    ['GetRenderState', getRenderStateCode(AT, TRAP)],
    ['GetTransform', getTransformCode(AT, TRAP)],
    ['GetTextureStageState', getTextureStageStateCode(AT, TRAP, 0xffffffff)],
    ['GetViewport', getViewportCode(AT, TRAP)],
    ['GetVertexShader', getShaderCode(AT, TRAP, 0)],
    ['GetPixelShader', getShaderCode(AT, TRAP, 1)],
    ['GetSurfaceDesc', getSurfaceDescCode(AT, TRAP)],
    ['GetSamplerState', getSamplerStateCode(AT, TRAP)],
    ['GetSurfaceLevel', getSurfaceLevelCode(AT, TRAP)],
    ['HeapAlloc', heapAllocCode(PLACED, AT, TRAP)],
    ['malloc', mallocCode(PLACED, AT, TRAP, 0x500000)],
    ['calloc', callocCode(PLACED, AT, TRAP, 0x500000)],
    ['HeapFree', heapFreeCode(PLACED, AT, TRAP)],
    ['free', freeCode(PLACED, AT, TRAP)],
    ['HeapSize', heapSizeCode(PLACED, AT, TRAP)],
    ['_msize', msizeCode(PLACED, AT, TRAP)],
    ['HeapReAlloc', heapReAllocCode(PLACED, AT, TRAP)],
    ['realloc', reallocCode(PLACED, AT, TRAP)],
    ['GlobalAlloc', globalAllocCode(AT, TRAP, 0x500000, 0x21000)],
    ['GlobalFree', globalFreeCode(AT, TRAP, 0x500000, 0x22000)],
    ['EnterCriticalSection', enterCode(AT, TRAP, 0x40000)],
    ['LeaveCriticalSection', leaveCode(AT, TRAP, 0x40000)],
    ['TryEnterCriticalSection', tryEnterCode(0x40000)],
    ['WaitForSingleObject', waitOneCode(AT, TRAP, 0x50000, 1, 2)],
    ['ReleaseMutex', releaseMutexCode(AT, TRAP, 0x50000, 2)],
    ['SetEvent', eventStateCode(AT, TRAP, 0x50000, 2)],
    ['InterlockedCompareExchange', COMPARE_EXCHANGE_CODE],
    ['InterlockedDecrement', DECREMENT_CODE],
    ['InterlockedExchangeAdd', EXCHANGE_ADD_CODE],
    ['InterlockedExchange', EXCHANGE_CODE],
    ['InterlockedIncrement', INCREMENT_CODE],
    ['QueryPerformanceCounter', queryPerformanceCounterCode(AT, TRAP, 0x60000)],
    ['Sleep', sleepCode(AT, TRAP, 0x61000)],
    ['SleepConditionVariableSRW', sleepSrwCode(AT, { sleep: TRAP, timedOut: TRAP + 8,
        shared: TRAP + 16, exclusive: TRAP + 24 })],
    ['SleepConditionVariableCS', sleepCsCode(AT, { sleep: TRAP, timedOut: TRAP + 8,
        enter: TRAP + 16 })],
    ['InitOnceExecuteOnce', executeOnceCode(AT, { begin: TRAP, end: TRAP + 8 })],
];
/**
 * @param {string} family @param {Record<string, any>} table
 * @param {(name: string) => number} slotOf @param {Record<string, any>} [more]
 */
const commands = (family, table, slotOf, more = {})=>{
    for (const [name, shape] of Object.entries(table))
    {
        routines.push([`${family} ${name}`,
            commandCode(AT, TRAP, { ...shape, slot: slotOf(name), ...more })]);
    }
};
commands('Direct3D 9', D3D9_COMMANDS, d3d9Slot);
commands('Direct3D 8', D3D8_COMMANDS.COMMANDS, D3D8_COMMANDS.commandSlot);
commands('Direct3D 7', D3D7_COMMANDS.COMMANDS, D3D7_COMMANDS.commandSlot);
commands('OpenGL', GL_COMMANDS.COMMANDS, GL_COMMANDS.commandSlot, { thread: true });

/** @type {string[]} */
const problems = [];
let locking = 0;
for (const [name, code] of routines)
{
    const instructions = instructionsOf(code);
    const taken = instructions.filter(one=>one.locked).map(one=>one.mem);
    locking += taken.length > 0 ? 1 : 0;
    for (const one of instructions)
    {
        if (one.writes && !one.locked && taken.some(word=>sameWord(word, one.mem)))
        {
            problems.push(`${name}: a plain ${one.op} to a word it takes with a locked`
                + ` instruction (base ${one.mem.base}, displacement ${one.mem.disp ?? 0})`);
        }
    }
}
// The rule says nothing if the routines stop holding locked instructions.
if (locking < 150)
{
    problems.push(`only ${locking} of ${routines.length} routines take a word with a locked`
        + ' instruction: the routines were not read');
}
if (problems.length > 0)
{
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log(`lock release: ${routines.length} routines, ${locking} with locked words,`
    + ' none let go plainly');
