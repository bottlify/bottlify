/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The setters and draws a device records in its command ring in the guest
 * (`commandCode`): what a call is checked against before the routine answers
 * for it, the record it writes, and what it mirrors into the device's block
 * for the getters.
 */

import { D3DFVF_RESERVED0 } from '../../d3d8/constants.js';
import {
    EBX, ECX, countLeft, dirtyPrologue, dword, letHeldGo, prologue, routine, takeHeld,
    threadPrologue,
} from './assemble.js';
import {
    COMMAND, D3DFMT_D24S8, D3DUSAGE_RENDERTARGET, DRAW, FLAG_DRAW_STALE, FLAG_SLOW_PATH, FLAG_STALE,
    SHADOW, SURFACE, VERTEX_BUFFER7, WORLD_SLOT, WORLD_TYPE,
} from '../block.js';
import { ANSWERED_TRANSFORMS, TRANSFORMS_7 } from './getters.js';

/**
 * A shape's surface arguments and the usage each must have (`surfaceUsage`).
 *
 * @param {CommandShape} shape
 * @returns {readonly { arg: number, mask: number, nullable?: boolean }[]}
 */
export const usagesOf = shape=>{
    const usage = shape.surfaceUsage;
    return usage === undefined ? [] : 'arg' in usage ? [usage] : usage;
};

/**
 * What a command routine checks before it takes a call, so that a call it
 * answers D3D_OK for is one the device takes: the arguments the device
 * refuses by their value, and the state it refuses a call in that the block
 * keeps. Whatever fails leaves for the host through `out`; nothing is
 * written before.
 *
 * @param {CommandShape} shape
 * @param {(argument: number) => number} at  where an argument is on entry
 * @returns {(number[] | { label: string } | { jcc: number, to: string, near?: boolean })[]}
 */
function commandChecks(shape, at){
    /** @type {(number[] | { label: string } | { jcc: number, to: string, near?: boolean })[]} */
    const parts = [];
    if (shape.needs)
    {
        parts.push(
            [0x8b, 0x81, ...dword(SHADOW.DRAWABLE)],             // mov eax, [ecx+DRAWABLE]
            [0x25, ...dword(shape.needs)],                       // and eax, needs
            [0x3d, ...dword(shape.needs)],                       // cmp eax, needs
            { jcc: 0x75, to: 'out', near: true });               // jne out
    }
    if (shape.refuses)
    {
        parts.push(
            [0xf7, 0x81, ...dword(SHADOW.DRAWABLE), ...dword(shape.refuses)], // test [..], m
            { jcc: 0x75, to: 'out', near: true });               // jnz out
    }
    (shape.within ?? []).forEach(({ arg, ranges }, index)=>{
        parts.push([0x8b, 0x44, 0x24, at(arg)]);                 // mov eax, [esp+arg]
        for (const [low, high] of ranges)
        {
            parts.push(
                [0x89, 0xc2],                                    // mov edx, eax
                [0x81, 0xea, ...dword(low)],                     // sub edx, low
                [0x81, 0xfa, ...dword((high - low) >>> 0)],      // cmp edx, high-low
                { jcc: 0x76, to: `within${index}` });            // jbe within
        }
        parts.push(
            { jcc: 0xeb, to: 'out', near: true },                // jmp out
            { label: `within${index}` });
    });
    if (shape.refusedWhen)
    {
        const { arg, equals, flagsOf, mask } = shape.refusedWhen;
        parts.push(
            [0x81, 0x7c, 0x24, at(arg), ...dword(equals)],       // cmp dword [esp+arg], equals
            { jcc: 0x75, to: 'paired' },                         // jne paired
            [0xf7, 0x44, 0x24, at(flagsOf), ...dword(mask)],     // test dword [esp+flags], mask
            { jcc: 0x75, to: 'out', near: true },                // jnz out
            { label: 'paired' });
    }
    if (shape.span !== undefined && shape.count)
    {
        parts.push(
            [0x8b, 0x44, 0x24, at(shape.span)],                  // mov eax, [esp+start]
            [0x03, 0x44, 0x24, at(shape.count.arg)],             // add eax, [esp+count]
            { jcc: 0x72, to: 'out', near: true },                // jc out
            [0x3d, ...dword(shape.count.most)],                  // cmp eax, most
            { jcc: 0x77, to: 'out', near: true });               // ja out
    }
    if (shape.below)
    {
        parts.push(
            [0x8b, 0x44, 0x24, at(shape.below.arg)],             // mov eax, [esp+arg]
            [0x3b, 0x81, ...dword(shape.below.word)],            // cmp eax, [ecx+word]
            { jcc: 0x73, to: 'out', near: true });               // jae out
    }
    usagesOf(shape).forEach(({ arg, mask, nullable = false }, index)=>{
        parts.push(
            [0x8b, 0x44, 0x24, at(arg)],                         // mov eax, [esp+arg]
            [0x85, 0xc0],                                        // test eax, eax
            { jcc: 0x74, to: nullable ? `usable${index}` : 'out', near: true }, // jz usable / out
            [0x8b, 0x40, 0x04],                                  // mov eax, [eax+4]: its block
            [0x85, 0xc0],                                        // test eax, eax
            { jcc: 0x74, to: 'out', near: true },                // jz out
            [0x3b, 0x48, SURFACE.OWNER],                         // cmp ecx, [eax+OWNER]
            { jcc: 0x75, to: 'out', near: true },                // jne out: another device's
            // test dword [eax + DESC + Usage], mask
            [0xf7, 0x80, ...dword(SURFACE.DESC + 8), ...dword(mask)],
            { jcc: 0x74, to: 'out', near: true },                // jz out
            { label: `usable${index}` });
    });
    if (shape.depthCovers)
    {
        // Past the usage checks: both have a block, the depth surface when
        // there is one.
        const { target, depth } = shape.depthCovers;
        for (const side of [SURFACE.DESC + 24, SURFACE.DESC + 28])
        {
            parts.push(
                [0x8b, 0x44, 0x24, at(depth)],                   // mov eax, [esp+depth]
                [0x85, 0xc0],                                    // test eax, eax
                { jcc: 0x74, to: 'covered', near: true },        // jz covered: none
                [0x8b, 0x40, 0x04],                              // mov eax, [eax+4]: its block
                [0x8b, 0x54, 0x24, at(target)],                  // mov edx, [esp+target]
                [0x8b, 0x52, 0x04],                              // mov edx, [edx+4]: its block
                [0x8b, 0x52, side],                              // mov edx, [edx+side]
                [0x39, 0x50, side],                              // cmp [eax+side], edx
                { jcc: 0x72, to: 'out', near: true });           // jb out: smaller
        }
        parts.push({ label: 'covered' });
    }
    if (shape.token !== undefined)
    {
        parts.push(
            [0x8b, 0x44, 0x24, at(shape.token)],                 // mov eax, [esp+token]
            [0x3d, ...dword(SHADOW.STATE_BLOCK_TOKENS)],         // cmp eax, 256
            { jcc: 0x73, to: 'out', near: true },                // jae out
            [0x0f, 0xa3, 0x81, ...dword(SHADOW.STATE_BLOCKS)],   // bt [ecx+STATE_BLOCKS], eax
            { jcc: 0x73, to: 'out', near: true });               // jnc out: none held
    }
    if (shape.vertexRange)
    {
        const { buffer, start, count } = shape.vertexRange;
        parts.push(
            [0x8b, 0x44, 0x24, at(buffer)],                      // mov eax, [esp+buffer]
            [0x85, 0xc0],                                        // test eax, eax
            { jcc: 0x74, to: 'out', near: true },                // jz out
            [0x8b, 0x40, 0x04],                                  // mov eax, [eax+4]: its block
            [0x85, 0xc0],                                        // test eax, eax
            { jcc: 0x74, to: 'out', near: true },                // jz out
            [0x83, 0x78, VERTEX_BUFFER7.LOCKED, 0x00],           // cmp dword [eax+LOCKED], 0
            { jcc: 0x75, to: 'out', near: true },                // jne out
            [0x8b, 0x54, 0x24, at(start)],                       // mov edx, [esp+start]
            [0x03, 0x54, 0x24, at(count)],                       // add edx, [esp+count]
            { jcc: 0x72, to: 'out', near: true },                // jc out
            [0x3b, 0x50, VERTEX_BUFFER7.VERTICES],               // cmp edx, [eax+VERTICES]
            { jcc: 0x77, to: 'out', near: true });               // ja out
    }
    if (shape.flagNeeds)
    {
        const { arg, pairs } = shape.flagNeeds;
        parts.push([0x8b, 0x44, 0x24, at(arg)]);                 // mov eax, [esp+arg]
        pairs.forEach(([flag, bits], index)=>{
            parts.push(
                [0xa9, ...dword(flag)],                          // test eax, flag
                { jcc: 0x74, to: `unflagged${index}`, near: true }, // jz unflagged
                [0x8b, 0x91, ...dword(SHADOW.DRAWABLE)],         // mov edx, [ecx+DRAWABLE]
                [0x81, 0xe2, ...dword(bits)],                    // and edx, bits
                [0x81, 0xfa, ...dword(bits)],                    // cmp edx, bits
                { jcc: 0x75, to: 'out', near: true },            // jne out
                { label: `unflagged${index}` });
        });
    }
    if (shape.validated)
    {
        parts.push(
            [0x8b, 0x44, 0x24, at(shape.validated.arg)],         // mov eax, [esp+arg]
            [0xa9, ...dword(shape.validated.when)],              // test eax, when
            { jcc: 0x74, to: 'validated', near: true });         // jz validated
        const table = SHADOW.VALIDATED
            + (shape.validated.table ?? 0) * SHADOW.VALIDATED_SLOTS * 4;
        for (let index = 0; index < SHADOW.VALIDATED_SLOTS; index++)
        {
            parts.push(
                [0x3b, 0x81, ...dword(table + 4 * index)],       // cmp eax, [ecx+slot]
                { jcc: 0x74, to: 'validated', near: true });     // je validated
        }
        parts.push(
            { jcc: 0xeb, to: 'out', near: true },                // jmp out
            { label: 'validated' });
    }
    return parts;
}

/** A RECT's bytes, as a record copies one (`rects`). */
export const RECT_BYTES = 16;

/**
 * A method a command routine takes: what the record holds, how much of what
 * the method reads through a pointer is copied with it, and what else the
 * routine does in the guest.
 *
 * @typedef {Object} CommandShape
 * @property {number} slot  the method's slot, which names it to the host
 * @property {number} args  its arguments, `this` not counted
 * @property {number} [pointer]  the argument pointing at what the method reads
 * @property {number} [bytes]  how many bytes that is, or else
 * @property {{ arg: number, shift: number, most: number }} [count]  the argument
 *     counting its elements, `1 << shift` bytes each, at most `most` of them
 * @property {{ type: number, fvf: number, count: number, most: number }} [fvfVertices]
 *     or the vertices a draw by pointer names -- `count` of them, a whole
 *     number of primitives of `type` -- each as wide as `fvf` is in
 *     `SHADOW.FVF_STRIDES`: at most `most` bytes
 * @property {{ type: number, count: number, stride: number, most: number }} [vertices]
 *     or the vertices a draw's primitives span, of the type and count those
 *     arguments give, `stride` bytes each: at most `most` bytes
 * @property {boolean} [self]  the record's first argument is the object's own
 *     pointer -- a method of an object of the device's that is not the device
 * @property {boolean} [stale]  the call may change what the block mirrors
 *     (`FLAG_STALE`)
 * @property {boolean} [staleDraws]  and what a draw's checks read too
 *     (`FLAG_DRAW_STALE`)
 * @property {'empty' | 'any'} [nullable]  the pointer may be null, and is
 *     then recorded as null with nothing copied: with a count of zero alone
 *     ('empty'), or whatever the count ('any')
 * @property {(number[] | { label: string } | { jcc: number, to: string, near?: boolean })[]
 *     } [mirror]  guest code run first, with the block in ECX, that keeps what
 *     a getter in the guest reads current; it may leave for the host through
 *     `out`, and leaves ECX and the stack as it found them
 * @property {{ arg: number, cases: readonly [number, number][], otherwise: number }} [choose]
 *     or else the bytes chosen by an argument's value: its case's, or `otherwise`
 * @property {{ arg: number, ranges: readonly [number, number][] }[]} [within]  arguments
 *     the device takes only within ranges, inclusive and unsigned; any other is the host's
 * @property {{ arg: number, equals: number, flagsOf: number, mask: number }} [refusedWhen]
 *     a pair the device refuses: an argument of one value while another has a bit of
 *     `mask` -- the host's
 * @property {number} [span]  the argument that starts what `count` counts: the
 *     two together may not reach past `count.most`
 * @property {{ arg: number, word: number }} [below]  an argument the device takes
 *     only below a word of the block the host keeps
 * @property {{ arg: number, when: number, table?: number }} [validated]  an argument
 *     the device takes or not by its value alone: one with a bit of `when` is
 *     taken here only if the host has seen the device take it, in that table
 *     of `SHADOW.VALIDATED`
 * @property {{ arg: number, mask: number, nullable?: boolean }
 *     | readonly { arg: number, mask: number, nullable?: boolean }[]} [surfaceUsage]  an
 *     argument the device takes only as a surface whose usage has a bit of `mask`, read
 *     from the surface's block (`SURFACE`, the word after its interface): a surface
 *     with no block is the host's, and so is a null one unless `nullable`; or several
 * @property {{ target: number, depth: number }} [depthCovers]  a depth surface
 *     argument, when there is one, the device takes only as large as the target
 *     argument in both sides, read from their blocks (`SURFACE`)
 * @property {number} [token]  an argument the device takes only as the token of a
 *     state block it holds (`SHADOW.STATE_BLOCKS`): with `stale`, the block's
 *     apply is one a draw waits for the host after when the block holds what
 *     its checks read (`SHADOW.STATE_BLOCK_DRAWS`)
 * @property {{ buffer: number, start: number, count: number }} [vertexRange]  a Direct3D 7
 *     vertex buffer argument and the range of its vertices a draw reads: taken only for a
 *     buffer with a block (`VERTEX_BUFFER7`), not locked, holding the range whole
 * @property {{ arg: number, pairs: readonly [number, number][] }} [flagNeeds]  flags of
 *     an argument the device takes only with `DRAW` bits: for each pair, an argument
 *     with a bit of the first needs every bit of the second
 * @property {number} [needs]  the `DRAW` bits the device must have for the call
 * @property {number} [refuses]  and those it must not
 * @property {boolean} [fresh]  the call reads what a state block applied in the
 *     ring may have changed (`FLAG_DRAW_STALE`), and waits for the host when it may have
 * @property {boolean} [draws]  a draw: a lock in the guest that may overwrite
 *     what it reads waits for the host to make it
 * @property {boolean} [thread]  a function rather than a method: no `this`, and
 *     the block is the calling thread's (`threadPrologue`)
 * @property {'rect' | 'box'} [dirty]  a texture's AddDirtyRect or AddDirtyBox, its
 *     object's block a texture's (`dirtyPrologue`)
 * @property {readonly number[]} [rects]  arguments each pointing at a RECT or null: each
 *     copied after the arguments in order, sixteen bytes a place whether or not it is
 *     null, and the argument made to point at its copy - a null one stays null. Not
 *     with `pointer`; what a rectangle must be is the mirror's to check
 */

/**
 * A call as guest code that writes it into the device's command ring for the
 * host to make at its next entry -- the arguments, and a copy of what a
 * pointer argument points at, with the pointer made to point at the copy.
 * The program is told D3D_OK; what the host would refuse it refuses then,
 * and reports. A null pointer, a count past `most`, a full ring, a device
 * without one and whatever `mirror` declines are the host's now.
 *
 * Space is taken with `lock cmpxchg` on the head, so two threads never take
 * the same bytes, and a record counts once its length -- written last -- is
 * there: a host entry between any two instructions of a routine reads the
 * records before it and stops at one not yet whole. A device's routine runs
 * under the device's lock (`SHADOW.HELD`), its checks and mirrors with it,
 * and leaves for the host when it finds the lock held; a function's runs on
 * the calling thread's own context and takes none.
 *
 *     (prologue; no ring: early)  (the device's lock, or early)
 *     ...  bits  ...  mirror  ...  pointer and count checks (out: the lock let go)
 *     push ebx; push esi; push edi
 *     mov ebx, ecx                ; the block
 *     lea esi, [edx + ARGS + 4*args]   ; the record's length; EDX the copy's
 *   reserve:
 *     mov eax, [ebx+COMMAND_HEAD]
 *     lea edi, [eax+esi]
 *     cmp edi, [ebx+COMMAND_BYTES]
 *     ja full
 *     lock cmpxchg [ebx+COMMAND_HEAD], edi
 *     jne reserve
 *     add eax, [ebx+COMMANDS]     ; the record
 *     mov edi, eax
 *     mov dword [edi], slot
 *     (each argument into [edi+ARGS+4*i]; the pointer as the copy's address)
 *     [mov esi, source; lea edi, [edi+ARGS+4*args]; mov ecx, edx; shr ecx, 2;
 *      rep movsd; mov edi, eax; lea esi, [edx + ARGS + 4*args]]
 *     [each rectangle not null: its four words into its place]
 *     mov [edi+BYTES], esi        ; whole
 *     [mov dword [ebx+DRAWS_PENDING], 1]
 *     mov dword [ebx+HELD], 0
 *     pop edi; pop esi; pop ebx
 *     xor eax, eax
 *     ret 4+4*args
 *   full:
 *     mov dword [ebx+HELD], 0
 *     pop edi; pop esi; pop ebx
 *     jmp slow
 *
 * @param {number} at @param {number} trap @param {CommandShape} shape
 * @returns {Uint8Array}
 */
export function commandCode(at, trap, shape){
    const { slot, args, pointer = -1, bytes = 0, count, choose, vertices, mirror = [],
        draws = false, thread = false, self = false, stale = false, staleDraws = false,
        nullable = false, fresh = false, rects = [] } = shape;
    if (rects.length > 0 && (pointer >= 0 || self || thread))
    {
        throw new Error('shadow: a record copies rectangles or what one pointer points at');
    }
    if (nullable && !count)
    {
        throw new Error('shadow: a pointer that may be null is counted by an argument');
    }
    const header = COMMAND.ARGS + 4 * args;
    // A copy counted in bytes need not be whole dwords: the record is rounded
    // up and the tail copied a byte at a time, never read past.
    const ragged = count !== undefined && count.shift < 2;
    /** ESI = the record's length, the copy's bytes in EDX: whole dwords, or rounded up. */
    const recordLength = ragged
        ? [[0x8d, 0xb2, ...dword(header + 3)], [0x83, 0xe6, 0xfc]] // lea esi, [edx+h+3]; and -4
        : [[0x8d, 0xb2, ...dword(header)]];                    // lea esi, [edx+header]
    if (self && (thread || count || choose || vertices || shape.fvfVertices))
    {
        throw new Error('shadow: a record of the object itself copies no more than a structure');
    }
    if (shape.dirty && !self)
    {
        throw new Error('shadow: a dirty region is a call of the texture itself');
    }
    // What the routine pops: the record's arguments, the object's own pointer
    // among them when it is the first.
    const popped = self ? args - 1 : args;
    // An argument's place on the stack, past the object's own when the record names it first.
    const shift = self ? 1 : 0;
    if (pointer >= 0 && !count && !choose && !vertices && !shape.fvfVertices
        && (bytes <= 0 || (bytes & 3) !== 0))
    {
        throw new Error(`shadow: a command copies whole dwords, not ${bytes} bytes`);
    }
    // Where argument i is on entry, and once three registers are pushed:
    // past `this` for a method, at once for a function.
    const entry = thread ? 4 : 8;
    const pushed = entry + 12;
    /** @type {(number[] | { label: string } | { jcc: number, to: string, near?: boolean })[]} */
    const parts = [
        ...(thread ? threadPrologue('early')
            : shape.dirty ? dirtyPrologue(shape.dirty, 'early')
                : prologue('early', fresh ? FLAG_SLOW_PATH | FLAG_DRAW_STALE : FLAG_SLOW_PATH)),
        [0x83, 0xb9, ...dword(SHADOW.COMMANDS), 0x00],           // cmp dword [ecx+disp], 0
        { jcc: 0x74, to: 'early' },                              // je early
        { jcc: 0xeb, to: 'body' },                               // jmp body
        { label: 'early' },
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        { label: 'body' },
        // A device's; a thread's own context (OpenGL) is no other thread's.
        ...(thread ? [] : takeHeld(ECX, 'early')),
        ...commandChecks(shape, argument=>entry + 4 * (argument - (self ? 1 : 0))),
        ...mirror,
    ];
    if (pointer >= 0)
    {
        parts.push(
            [0x8b, 0x44, 0x24, entry + 4 * (pointer - shift)],   // mov eax, [esp+entry+4p]
            [0x85, 0xc0],                                        // test eax, eax
            { jcc: 0x74, to: nullable ? 'none' : 'out', near: true }); // jz out
    }
    if (choose)
    {
        parts.push(
            [0x8b, 0x44, 0x24, entry + 4 * choose.arg],          // mov eax, [esp+entry+4c]
            [0xba, ...dword(choose.otherwise)]);                 // mov edx, otherwise
        choose.cases.forEach(([value, size], index)=>parts.push(
            [0x3d, ...dword(value)],                             // cmp eax, value
            { jcc: 0x75, to: `case${index}` },                   // jne next
            [0xba, ...dword(size)],                              // mov edx, size
            { label: `case${index}` }));
    }
    else if (shape.fvfVertices)
    {
        // So many vertices as whole primitives of the type -- a point or
        // more, an even number of two or more, two or more, a multiple of
        // three, three or more -- each as wide as the format's entry in the
        // block says; a format with none, or a copy past `most`, is the host's.
        const { type, fvf, count: vertexCount, most } = shape.fvfVertices;
        parts.push(
            [0x8b, 0x44, 0x24, entry + 4 * type],                // mov eax, [esp+entry+4t]
            [0x8b, 0x54, 0x24, entry + 4 * vertexCount],         // mov edx, [esp+entry+4c]
            [0x85, 0xd2],                                        // test edx, edx
            { jcc: 0x74, to: 'out', near: true },                // jz out
            [0x81, 0xfa, ...dword(most)],                        // cmp edx, most
            { jcc: 0x77, to: 'out', near: true },                // ja out
            [0x83, 0xf8, 0x01],                                  // cmp eax, 1
            { jcc: 0x74, to: 'counted', near: true },            // je counted: points
            [0x83, 0xf8, 0x02],                                  // cmp eax, 2
            { jcc: 0x75, to: 'notLines' },                       // jne notLines
            [0xf6, 0xc2, 0x01],                                  // test dl, 1
            { jcc: 0x75, to: 'out', near: true },                // jnz out: odd
            { label: 'notLines' },
            [0x83, 0xf8, 0x03],                                  // cmp eax, 3
            { jcc: 0x77, to: 'notStrip' },                       // ja notStrip
            [0x83, 0xfa, 0x02],                                  // cmp edx, 2
            { jcc: 0x72, to: 'out', near: true },                // jb out
            { jcc: 0xeb, to: 'counted', near: true },            // jmp counted
            { label: 'notStrip' },
            [0x83, 0xf8, 0x06],                                  // cmp eax, 6
            { jcc: 0x77, to: 'out', near: true },                // ja out: no such type
            [0x83, 0xfa, 0x03],                                  // cmp edx, 3
            { jcc: 0x72, to: 'out', near: true },                // jb out
            [0x83, 0xf8, 0x04],                                  // cmp eax, 4
            { jcc: 0x75, to: 'counted', near: true },            // jne counted
            // A multiple of three: n times the inverse of three modulo 2^32 is
            // at most a third of the range exactly when it is.
            [0x69, 0xc2, ...dword(0xaaaaaaab)],                  // imul eax, edx, 0xaaaaaaab
            [0x3d, ...dword(0x55555555)],                        // cmp eax, 0x55555555
            { jcc: 0x77, to: 'out', near: true },                // ja out
            { label: 'counted' },
            [0x8b, 0x44, 0x24, entry + 4 * fvf]);                // mov eax, [esp+entry+4f]
        for (let index = 0; index < SHADOW.FVF_STRIDE_PAIRS; index++)
        {
            parts.push(
                [0x3b, 0x81, ...dword(SHADOW.FVF_STRIDES + 8 * index)], // cmp eax, [ecx+fvf i]
                { jcc: 0x75, to: `stride${index}` },             // jne next
                [0x8b, 0x81, ...dword(SHADOW.FVF_STRIDES + 8 * index + 4)], // mov eax, [ecx+width]
                { jcc: 0xeb, to: 'strided', near: true },        // jmp strided
                { label: `stride${index}` });
        }
        parts.push(
            { jcc: 0xeb, to: 'out', near: true },                // jmp out: a format not drawn yet
            { label: 'strided' },
            [0x85, 0xc0],                                        // test eax, eax
            { jcc: 0x74, to: 'out', near: true },                // jz out
            [0xa8, 0x03],                                        // test al, 3
            { jcc: 0x75, to: 'out', near: true },                // jnz out
            [0x3d, ...dword(most)],                              // cmp eax, most
            { jcc: 0x77, to: 'out', near: true },                // ja out
            [0x0f, 0xaf, 0xd0],                                  // imul edx, eax
            [0x81, 0xfa, ...dword(most)],                        // cmp edx, most
            { jcc: 0x77, to: 'out', near: true });               // ja out
    }
    else if (vertices)
    {
        // How many vertices the primitives span, by type (`vertexCountOf`),
        // times the stride: an unknown type, no primitives, a stride that is
        // not whole dwords or a copy past `most` bytes is the host's.
        /** @type {[number, number[][]][]} */
        const steps = [
            [1, []],                                             // POINTLIST: n
            [2, [[0x01, 0xd2]]],                                 // LINELIST: add edx, edx
            [3, [[0x42]]],                                       // LINESTRIP: inc edx
            [4, [[0x8d, 0x14, 0x52]]],                           // TRIANGLELIST: lea edx, [edx*3]
            [5, [[0x83, 0xc2, 0x02]]],                           // TRIANGLESTRIP: add edx, 2
            [6, [[0x83, 0xc2, 0x02]]],                           // TRIANGLEFAN: add edx, 2
        ];
        parts.push(
            [0x8b, 0x44, 0x24, entry + 4 * vertices.type],       // mov eax, [esp+entry+4t]
            [0x8b, 0x54, 0x24, entry + 4 * vertices.count],      // mov edx, [esp+entry+4c]
            [0x85, 0xd2],                                        // test edx, edx
            { jcc: 0x74, to: 'out', near: true },                // jz out
            [0x81, 0xfa, ...dword(vertices.most)],               // cmp edx, most
            { jcc: 0x77, to: 'out', near: true },                // ja out
            ...steps.flatMap(([type], index)=>[
                [0x83, 0xf8, type],                              // cmp eax, type
                { jcc: 0x74, to: `type${index}` }]),             // je typeN
            { jcc: 0xeb, to: 'out', near: true },                // jmp out
            ...steps.flatMap(([, step], index)=>[
                { label: `type${index}` },
                ...step,
                { jcc: 0xeb, to: 'stride', near: true }]),       // jmp stride
            { label: 'stride' },
            [0x8b, 0x44, 0x24, entry + 4 * vertices.stride],     // mov eax, [esp+entry+4s]
            [0xa8, 0x03],                                        // test al, 3
            { jcc: 0x75, to: 'out', near: true },                // jnz out
            [0x3d, ...dword(vertices.most)],                     // cmp eax, most
            { jcc: 0x77, to: 'out', near: true },                // ja out
            [0x0f, 0xaf, 0xd0],                                  // imul edx, eax
            [0x85, 0xd2],                                        // test edx, edx
            { jcc: 0x74, to: 'out', near: true },                // jz out
            [0x81, 0xfa, ...dword(vertices.most)],               // cmp edx, most
            { jcc: 0x77, to: 'out', near: true });               // ja out
    }
    else if (count)
    {
        parts.push(
            [0x8b, 0x54, 0x24, entry + 4 * count.arg],           // mov edx, [esp+entry+4c]
            [0x85, 0xd2],                                        // test edx, edx
            { jcc: 0x74, to: 'out' },                            // jz out
            [0x81, 0xfa, ...dword(count.most)],                  // cmp edx, most
            { jcc: 0x77, to: 'out' },                            // ja out
            [0xc1, 0xe2, count.shift]);                          // shl edx, shift
    }
    else
    {
        parts.push([0xba, ...dword(pointer >= 0 ? bytes          // mov edx, bytes
            : RECT_BYTES * rects.length)]);
    }
    if (nullable === 'empty' && count)
    {
        // No pointer is no elements: a count with it is the host's to refuse.
        parts.push(
            { jcc: 0xeb, to: 'take' },                           // jmp take
            { label: 'none' },
            [0x8b, 0x54, 0x24, entry + 4 * count.arg],           // mov edx, [esp+entry+4c]
            [0x85, 0xd2],                                        // test edx, edx
            { jcc: 0x75, to: 'out' });                           // jnz out
    }
    else if (nullable)
    {
        // No pointer copies nothing, whatever the count says.
        parts.push(
            { jcc: 0xeb, to: 'take' },                           // jmp take
            { label: 'none' },
            [0x31, 0xd2]);                                       // xor edx, edx
    }
    parts.push(
        { jcc: 0xeb, to: 'take' },                               // jmp take
        { label: 'out' },
        ...(thread ? [] : [letHeldGo(ECX),                       // mov dword [ecx+HELD], 0
            countLeft(ECX, SHADOW.LEFT_CHECKS)]),                // lock inc dword [ecx+LEFT_CHECKS]
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        // A mirror that found the call changes nothing (`storeState`): no record.
        ...(mirror.some(part=>'to' in part && part.to === 'same') ? [
            { label: 'same' },
            letHeldGo(ECX),                                      // lock and dword [ecx+HELD], 0
            [0x31, 0xc0],                                        // xor eax, eax
            [0xc2, entry - 4 + 4 * popped, 0x00],                // ret 4*args (+4 for this)
        ] : []),
        { label: 'take' },
        [0x53, 0x56, 0x57],                                      // push ebx; push esi; push edi
        [0x89, 0xcb],                                            // mov ebx, ecx
        ...recordLength,
        { label: 'reserve' },
        [0x8b, 0x83, ...dword(SHADOW.COMMAND_HEAD)],             // mov eax, [ebx+disp]
        [0x8d, 0x3c, 0x30],                                      // lea edi, [eax+esi]
        [0x3b, 0xbb, ...dword(SHADOW.COMMAND_BYTES)],            // cmp edi, [ebx+disp]
        { jcc: 0x77, to: 'full', near: true },                   // ja full
        [0xf0, 0x0f, 0xb1, 0xbb, ...dword(SHADOW.COMMAND_HEAD)], // lock cmpxchg [ebx+disp], edi
        { jcc: 0x75, to: 'reserve' },                            // jne reserve
        [0x03, 0x83, ...dword(SHADOW.COMMANDS)],                 // add eax, [ebx+disp]
        [0x89, 0xc7],                                            // mov edi, eax
        [0xc7, 0x07, ...dword(slot)]);                           // mov dword [edi], slot
    for (let arg = 0; arg < args; arg++)
    {
        const rect = rects.indexOf(arg);
        if (rect >= 0)
        {
            // Its copy's address, or none for none.
            parts.push(
                [0x8b, 0x44, 0x24, pushed + 4 * arg],            // mov eax, [esp+pushed+4r]
                [0x85, 0xc0],                                    // test eax, eax
                { jcc: 0x74, to: `noRect${rect}` },              // jz noRect: it stays 0
                [0x8d, 0x87, ...dword(header + RECT_BYTES * rect)], // lea eax, [edi+copy]
                { label: `noRect${rect}` });
        }
        else if (arg === pointer && nullable)
        {
            parts.push(
                [0x8b, 0x44, 0x24, pushed + 4 * (arg - shift)],  // mov eax, [esp+pushed+4p]
                [0x85, 0xc0],                                    // test eax, eax
                { jcc: 0x74, to: 'null' },                       // jz null: it stays 0
                [0x8d, 0x87, ...dword(header)],                  // lea eax, [edi+header]
                { label: 'null' });
        }
        else
        {
            parts.push(arg === pointer
                ? [0x8d, 0x87, ...dword(header)]                 // lea eax, [edi+header]
                : [0x8b, 0x44, 0x24, pushed + 4 * (arg - (self ? 1 : 0))]); // mov eax, [esp+..]
        }
        parts.push([0x89, 0x47, COMMAND.ARGS + 4 * arg]);        // mov [edi+8+4i], eax
    }
    if (pointer >= 0)
    {
        parts.push(
            [0x89, 0xf8],                                        // mov eax, edi
            [0x8b, 0x74, 0x24, pushed + 4 * (pointer - shift)],  // mov esi, [esp+pushed+4p]
            [0x8d, 0xbf, ...dword(header)],                      // lea edi, [edi+header]
            [0x89, 0xd1],                                        // mov ecx, edx
            [0xc1, 0xe9, 0x02],                                  // shr ecx, 2
            [0xf3, 0xa5],                                        // rep movsd
            ...(ragged ? [
                [0x89, 0xd1],                                    // mov ecx, edx
                [0x83, 0xe1, 0x03],                              // and ecx, 3
                [0xf3, 0xa4],                                    // rep movsb
            ] : []),
            [0x89, 0xc7],                                        // mov edi, eax
            ...recordLength);
    }
    rects.forEach((arg, rect)=>{
        parts.push(
            [0x8b, 0x44, 0x24, pushed + 4 * arg],                // mov eax, [esp+pushed+4r]
            [0x85, 0xc0],                                        // test eax, eax
            { jcc: 0x74, to: `copied${rect}` },                  // jz copied
            ...[0, 4, 8, 12].flatMap(offset=>[
                [0x8b, 0x50, offset],                            // mov edx, [eax+o]
                [0x89, 0x57, header + RECT_BYTES * rect + offset], // mov [edi+copy+o], edx
            ]),
            { label: `copied${rect}` });
    });
    // The length last, with `xchg`: an atomic store on several executors, so a
    // host that reads it with an atomic load finds the record's words, and the
    // bytes the program wrote before the call, there with it.
    parts.push([0x87, 0x77, COMMAND.BYTES]);                     // xchg [edi+4], esi
    if (draws)
    {
        parts.push([0xc7, 0x83, ...dword(SHADOW.DRAWS_PENDING), ...dword(1)]); // mov [ebx+disp], 1
    }
    if (stale && shape.token !== undefined)
    {
        // As the token's block says: what the draws' checks read too, or not.
        parts.push(
            [0x8b, 0x44, 0x24, pushed + 4 * shape.token],        // mov eax, [esp+token]
            [0x0f, 0xa3, 0x83, ...dword(SHADOW.STATE_BLOCK_DRAWS)], // bt [ebx+disp], eax
            [0x19, 0xc0],                                        // sbb eax, eax
            [0x83, 0xe0, FLAG_DRAW_STALE],                       // and eax, 4
            [0x83, 0xc8, FLAG_STALE],                            // or eax, 2
            [0xf0, 0x09, 0x03]);                                 // lock or [ebx], eax
    }
    else if (stale)
    {
        parts.push([0xf0, 0x83, 0x0b,                            // lock or dword [ebx], 2|4
            staleDraws ? FLAG_STALE | FLAG_DRAW_STALE : FLAG_STALE]);
    }
    parts.push(
        ...(thread ? [] : [letHeldGo(EBX)]),                     // mov dword [ebx+HELD], 0
        [0x5f, 0x5e, 0x5b],                                      // pop edi; pop esi; pop ebx
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, entry - 4 + 4 * popped, 0x00],                    // ret 4*args (+4 for this)
        { label: 'full' },
        ...(thread ? [] : [letHeldGo(EBX),                       // mov dword [ebx+HELD], 0
            countLeft(EBX, SHADOW.LEFT_FULL)]),                  // lock inc dword [ebx+LEFT_FULL]
        [0x5f, 0x5e, 0x5b],                                      // pop edi; pop esi; pop ebx
        { jcc: 0xeb, to: 'slow', near: true });                  // jmp slow
    return routine(at, trap, parts);
}

/**
 * A state's value, EDX, into its slot at `[ecx+eax*4+disp]` -- or, when the
 * slot holds it already and no state block applied in the ring may have left
 * the slot behind the device (`FLAG_STALE`), no record at all (`same`): the
 * call changes nothing, as a device that is not pure drops it. An Unreal
 * Engine 3 title set the same sampler and render states again before every
 * draw, three records in four, each one the host played.
 *
 *     test dword [ecx], FLAG_STALE
 *     jnz changed
 *     cmp [ecx+eax*4+disp], edx
 *     je same
 *   changed:
 *     mov [ecx+eax*4+disp], edx
 *
 * @param {number} disp
 */
const storeState = disp=>[
    [0xf7, 0x01, ...dword(FLAG_STALE)],                          // test dword [ecx], 2
    { jcc: 0x75, to: 'changed' },                                // jnz changed
    [0x39, 0x94, 0x81, ...dword(disp)],                          // cmp [ecx+eax*4+disp], edx
    { jcc: 0x74, to: 'same', near: true },                       // je same
    { label: 'changed' },
    [0x89, 0x94, 0x81, ...dword(disp)],                          // mov [ecx+eax*4+disp], edx
];

/**
 * What a command routine for SetRenderState keeps in the block for
 * GetRenderState in the guest: the value, for a state the block holds; any
 * other state is the host's.
 */
export const RENDER_STATE_MIRROR = Object.freeze([
    [0x8b, 0x44, 0x24, 0x08],                                    // mov eax, [esp+8]
    [0x3d, ...dword(SHADOW.RENDER_STATE_COUNT)],                 // cmp eax, 256
    { jcc: 0x73, to: 'out', near: true },                        // jae out
    [0x0f, 0xa3, 0x81, ...dword(SHADOW.RENDER_STATE_VALID)],     // bt [ecx+disp], eax
    { jcc: 0x73, to: 'out', near: true },                        // jnc out: one the device refuses
    [0x8b, 0x54, 0x24, 0x0c],                                    // mov edx, [esp+12]
    ...storeState(SHADOW.RENDER_STATES),
]);

/** The same for SetTransform: the matrix into its type's slot. */
export const TRANSFORM_MIRROR = Object.freeze([
    [0x8b, 0x44, 0x24, 0x08],                                    // mov eax, [esp+8]
    [0x3d, ...dword(WORLD_SLOT)],                                // cmp eax, 24
    { jcc: 0x72, to: 'low' },                                    // jb low
    [0x2d, ...dword(WORLD_TYPE - WORLD_SLOT)],                   // sub eax, 232
    [0x3d, ...dword(WORLD_SLOT)],                                // cmp eax, 24
    { jcc: 0x72, to: 'out', near: true },                        // jb out
    [0x3d, ...dword(SHADOW.TRANSFORM_SLOTS)],                    // cmp eax, 28
    { jcc: 0x73, to: 'out', near: true },                        // jae out
    { jcc: 0xeb, to: 'slot' },                                   // jmp slot
    { label: 'low' },
    // A type below WORLD that Direct3D 8 refuses is the host's to refuse.
    [0xba, ...dword(ANSWERED_TRANSFORMS)],                       // mov edx, imm32
    [0x0f, 0xa3, 0xc2],                                          // bt edx, eax
    { jcc: 0x73, to: 'out', near: true },                        // jnc out
    { label: 'slot' },
    [0x8b, 0x54, 0x24, 0x0c],                                    // mov edx, [esp+12]
    [0x85, 0xd2],                                                // test edx, edx
    { jcc: 0x74, to: 'out', near: true },                        // jz out
    [0x56, 0x57],                                                // push esi; push edi
    [0x89, 0xd6],                                                // mov esi, edx
    [0x89, 0xc7],                                                // mov edi, eax
    [0xc1, 0xe7, 0x06],                                          // shl edi, 6
    [0x8d, 0xbc, 0x39, ...dword(SHADOW.TRANSFORMS)],             // lea edi, [ecx+edi+disp]
    [0x89, 0xca],                                                // mov edx, ecx
    [0xb9, ...dword(16)],                                        // mov ecx, 16
    [0xf3, 0xa5],                                                // rep movsd
    [0x89, 0xd1],                                                // mov ecx, edx
    [0x5f, 0x5e],                                                // pop edi; pop esi
]);

/**
 * The same for Direct3D 7's SetTransform: its types are its own -- WORLD 1,
 * WORLD1..3 4..6, VIEW 2, PROJECTION 3, TEXTURE0..7 16..23 -- and each goes
 * into the slot of its number, as the shadow reads them back
 * (`transformType`); any other type is the host's to refuse.
 */
export const TRANSFORM_MIRROR_7 = Object.freeze([
    [0x8b, 0x44, 0x24, 0x08],                                    // mov eax, [esp+8]
    [0x3d, ...dword(WORLD_SLOT)],                                // cmp eax, 24
    { jcc: 0x73, to: 'out', near: true },                        // jae out
    [0xba, ...dword(TRANSFORMS_7)],                              // mov edx, imm32
    [0x0f, 0xa3, 0xc2],                                          // bt edx, eax
    { jcc: 0x73, to: 'out', near: true },                        // jnc out
    ...TRANSFORM_MIRROR.slice(TRANSFORM_MIRROR.findIndex(part=>'label' in part
        && part.label === 'slot') + 1),
]);

/** The same for SetViewport: the six dwords into the block. */
export const VIEWPORT_MIRROR = Object.freeze([
    [0x8b, 0x54, 0x24, 0x08],                                    // mov edx, [esp+8]
    [0x85, 0xd2],                                                // test edx, edx
    { jcc: 0x74, to: 'out', near: true },                        // jz out
    [0x56, 0x57],                                                // push esi; push edi
    [0x89, 0xd6],                                                // mov esi, edx
    [0x8d, 0xb9, ...dword(SHADOW.VIEWPORT)],                     // lea edi, [ecx+disp]
    [0x89, 0xca],                                                // mov edx, ecx
    [0xb9, ...dword(6)],                                         // mov ecx, 6
    [0xf3, 0xa5],                                                // rep movsd
    [0x89, 0xd1],                                                // mov ecx, edx
    [0x5f, 0x5e],                                                // pop edi; pop esi
]);

/**
 * The same for a SetRenderTarget, after its checks have found the surface a
 * target with a block: the viewport a new target brings -- all of it, depths
 * 0 and 1 -- and the target's size, from the surface's description. The
 * surface is the argument at `[esp+at]`: Direct3D 9's second, 8's first.
 * The pair GetRenderTarget answers with is the surface and the word it
 * counts in, the third of its interface's (`bridge/internal/vtable.js`): a
 * program saves and restores its target around every pass, and a pair left
 * for the host to say again sent each of those reads to the host, which
 * played the whole ring first. A surface counting nowhere leaves the pair to
 * the host.
 *
 * @param {number} at
 */
export const renderTargetMirror = at=>Object.freeze([
    [0x83, 0xa1, ...dword(SHADOW.TARGETS_VALID), 0xfe],          // and dword [ecx+disp], ~1
    [0x8b, 0x44, 0x24, at],                                      // mov eax, [esp+at]: the surface
    [0x8b, 0x40, 0x08],                                          // mov eax, [eax+8]: its count
    [0x85, 0xc0],                                                // test eax, eax
    { jcc: 0x74, to: 'targetHeld' },                             // jz targetHeld
    [0x89, 0x81, ...dword(SHADOW.TARGETS + 4)],                  // mov [ecx+pair+4], eax
    [0x8b, 0x44, 0x24, at],                                      // mov eax, [esp+at]
    [0x89, 0x81, ...dword(SHADOW.TARGETS)],                      // mov [ecx+pair], eax
    [0x83, 0x89, ...dword(SHADOW.TARGETS_VALID), 0x01],          // or dword [ecx+disp], 1
    { label: 'targetHeld' },
    [0x8b, 0x44, 0x24, at],                                      // mov eax, [esp+at]: the surface
    [0x8b, 0x40, 0x04],                                          // mov eax, [eax+4]: its block
    [0x8b, 0x90, ...dword(SURFACE.DESC + 24)],                   // mov edx, [eax+Width]
    [0x89, 0x91, ...dword(SHADOW.VIEWPORT + 8)],                 // mov [ecx+viewport W], edx
    [0x89, 0x91, ...dword(SHADOW.TARGET_WIDTH)],                 // mov [ecx+target W], edx
    [0x8b, 0x90, ...dword(SURFACE.DESC + 28)],                   // mov edx, [eax+Height]
    [0x89, 0x91, ...dword(SHADOW.VIEWPORT + 12)],                // mov [ecx+viewport H], edx
    [0x89, 0x91, ...dword(SHADOW.TARGET_HEIGHT)],                // mov [ecx+target H], edx
    [0xc7, 0x81, ...dword(SHADOW.VIEWPORT), ...dword(0)],        // X 0
    [0xc7, 0x81, ...dword(SHADOW.VIEWPORT + 4), ...dword(0)],    // Y 0
    [0xc7, 0x81, ...dword(SHADOW.VIEWPORT + 16), ...dword(0)],   // MinZ 0
    [0xc7, 0x81, ...dword(SHADOW.VIEWPORT + 20), ...dword(0x3f800000)], // MaxZ 1
]);
export const RENDER_TARGET_MIRROR = renderTargetMirror(0x0c);

/** `or dword [ecx+DRAWABLE], bits`. @param {number} bits */
const markDrawable = bits=>[0x83, 0x89, ...dword(SHADOW.DRAWABLE), bits];
/** `and dword [ecx+DRAWABLE], ~bits`. @param {number} bits */
const unmarkDrawable = bits=>[0x83, 0xa1, ...dword(SHADOW.DRAWABLE), ~bits & 0xff];

/**
 * What Direct3D 9's StretchRect has to be for the guest to take it: two
 * surfaces with blocks, not the same one and not levels of one texture, both
 * render targets in the default pool; each rectangle none - its surface
 * whole - or within its surface and not empty (`rectWithin`); and a device
 * that records for one drawing elsewhere (`ELSEWHERE`), which copies or
 * stretches between two such surfaces on the GPU, whatever their sizes and
 * formats. The filter is the routine's `within`; the rectangles travel in the
 * record (`rects`).
 */
const STRETCH_SURFACES = Object.freeze([
    [0x83, 0xb9, ...dword(SHADOW.ELSEWHERE), 0x00],              // cmp dword [ecx+disp], 0
    { jcc: 0x74, to: 'out', near: true },                        // je out
    [0x8b, 0x44, 0x24, 0x08],                                    // mov eax, [esp+8]: the source
    [0x85, 0xc0],                                                // test eax, eax
    { jcc: 0x74, to: 'out', near: true },                        // jz out
    [0x8b, 0x40, 0x04],                                          // mov eax, [eax+4]: its block
    [0x85, 0xc0],                                                // test eax, eax
    { jcc: 0x74, to: 'out', near: true },                        // jz out
    [0x8b, 0x54, 0x24, 0x10],                                    // mov edx, [esp+16]: the target
    [0x85, 0xd2],                                                // test edx, edx
    { jcc: 0x74, to: 'out', near: true },                        // jz out
    [0x8b, 0x52, 0x04],                                          // mov edx, [edx+4]: its block
    [0x85, 0xd2],                                                // test edx, edx
    { jcc: 0x74, to: 'out', near: true },                        // jz out
    [0x39, 0xd0],                                                // cmp eax, edx
    { jcc: 0x74, to: 'out', near: true },                        // je out: the same surface
    [0x83, 0x78, SURFACE.DESC + 12, 0x00],                       // cmp dword [eax+Pool], 0
    { jcc: 0x75, to: 'out', near: true },                        // jne out
    [0x83, 0x7a, SURFACE.DESC + 12, 0x00],                       // cmp dword [edx+Pool], 0
    { jcc: 0x75, to: 'out', near: true },                        // jne out
    [0xf7, 0x40, SURFACE.DESC + 8, ...dword(D3DUSAGE_RENDERTARGET)], // test [eax+Usage], RT
    { jcc: 0x74, to: 'out', near: true },                        // jz out
    [0xf7, 0x42, SURFACE.DESC + 8, ...dword(D3DUSAGE_RENDERTARGET)], // test [edx+Usage], RT
    { jcc: 0x74, to: 'out', near: true },                        // jz out
    [0x8b, 0x40, SURFACE.CONTAINER],                             // mov eax, [eax+CONTAINER]
    [0x85, 0xc0],                                                // test eax, eax
    { jcc: 0x74, to: 'stretchApart' },                           // jz apart
    [0x3b, 0x42, SURFACE.CONTAINER],                             // cmp eax, [edx+CONTAINER]
    { jcc: 0x74, to: 'out', near: true },                        // je out: one texture
    { label: 'stretchApart' },
]);

/**
 * A rectangle argument at `[esp+rect]` checked against the surface at
 * `[esp+surface]`, as the device checks one: none is the whole surface; one
 * is taken only within it and not empty: left below right, right not past
 * the width, top below bottom, bottom not past the height, compared unsigned
 * as the host reads the words, so a negative edge is past every surface.
 *
 *     mov edx, [esp+rect]
 *     test edx, edx
 *     jz whole
 *     mov eax, [edx+8]            ; right
 *     cmp [edx], eax              ; left
 *     jae out
 *     mov eax, [edx+12]           ; bottom
 *     cmp [edx+4], eax            ; top
 *     jae out
 *     mov eax, [esp+surface]
 *     mov eax, [eax+4]            ; its block
 *     mov eax, [eax+Width]
 *     cmp [edx+8], eax
 *     ja out
 *     mov eax, [esp+surface]
 *     mov eax, [eax+4]
 *     mov eax, [eax+Height]
 *     cmp [edx+12], eax
 *     ja out
 *   whole:
 *
 * @param {number} rect @param {number} surface  stack offsets on entry
 * @param {string} whole  the label it ends at
 */
const rectWithin = (rect, surface, whole)=>[
    [0x8b, 0x54, 0x24, rect],                                    // mov edx, [esp+rect]
    [0x85, 0xd2],                                                // test edx, edx
    { jcc: 0x74, to: whole, near: true },                        // jz whole
    [0x8b, 0x42, 0x08],                                          // mov eax, [edx+8]
    [0x39, 0x02],                                                // cmp [edx], eax
    { jcc: 0x73, to: 'out', near: true },                        // jae out
    [0x8b, 0x42, 0x0c],                                          // mov eax, [edx+12]
    [0x39, 0x42, 0x04],                                          // cmp [edx+4], eax
    { jcc: 0x73, to: 'out', near: true },                        // jae out
    ...[[0x08, 24], [0x0c, 28]].flatMap(([edge, size])=>[
        [0x8b, 0x44, 0x24, surface],                             // mov eax, [esp+surface]
        [0x8b, 0x40, 0x04],                                      // mov eax, [eax+4]: its block
        [0x8b, 0x40, SURFACE.DESC + size],                       // mov eax, [eax+Width/Height]
        [0x39, 0x42, edge],                                      // cmp [edx+right/bottom], eax
        { jcc: 0x77, to: 'out', near: true },                    // ja out
    ]),
    { label: whole },
];

export const STRETCH_GUARD = Object.freeze([
    ...STRETCH_SURFACES,
    ...rectWithin(0x0c, 0x08, 'sourceWhole'),
    ...rectWithin(0x14, 0x10, 'targetWhole'),
]);

/** Where `STRETCH_SURFACES` loads the target, and where it reads the source's texture. */
const STRETCH_TARGET = STRETCH_SURFACES.findIndex(part=>Array.isArray(part) && part[0] === 0x8b
    && part[1] === 0x54);
const STRETCH_CONTAINER = STRETCH_SURFACES.findIndex(part=>Array.isArray(part)
    && part[0] === 0x8b && part[1] === 0x40 && part[2] === SURFACE.CONTAINER);

/**
 * What Direct3D 8's CopyRects has to be for the guest to take it, as Direct3D
 * 9's StretchRect (`STRETCH_GUARD`): no rectangles, so the source travels
 * whole; two render targets in the default pool with blocks, not the same one
 * and not levels of one texture, of one format and one size -- a copy cannot
 * stretch -- and a device that records for one drawing elsewhere, which
 * copies between them on the GPU.
 */
export const COPY_GUARD_8 = Object.freeze([
    [0x83, 0x7c, 0x24, 0x0c, 0x00],                              // cmp dword [esp+12], 0
    { jcc: 0x75, to: 'out', near: true },                        // jne out: rectangles
    ...STRETCH_SURFACES.slice(0, STRETCH_TARGET),                 // ELSEWHERE, the source
    [0x8b, 0x54, 0x24, 0x14],                                    // mov edx, [esp+20]: the target
    ...STRETCH_SURFACES.slice(STRETCH_TARGET + 1, STRETCH_CONTAINER), // its block, pools, usages
    // One format and one size, a word at a time: the source's block again in EAX.
    ...[0, 24, 28].flatMap(offset=>[
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x8b, 0x40, 0x04],                                      // mov eax, [eax+4]
        [0x8b, 0x40, SURFACE.DESC + offset],                     // mov eax, [eax+DESC+o]
        [0x3b, 0x42, SURFACE.DESC + offset],                     // cmp eax, [edx+DESC+o]
        { jcc: 0x75, to: 'out', near: true },                    // jne out
    ]),
    [0x8b, 0x44, 0x24, 0x08],                                    // mov eax, [esp+8]
    [0x8b, 0x40, 0x04],                                          // mov eax, [eax+4]
    [0x8b, 0x40, SURFACE.CONTAINER],                             // mov eax, [eax+CONTAINER]
    [0x85, 0xc0],                                                // test eax, eax
    { jcc: 0x74, to: 'copyApart' },                              // jz apart
    [0x3b, 0x42, SURFACE.CONTAINER],                             // cmp eax, [edx+CONTAINER]
    { jcc: 0x74, to: 'out', near: true },                        // je out: one texture
    { label: 'copyApart' },
]);

/**
 * The same for a depth surface set -- Direct3D 9's SetDepthStencilSurface,
 * 8's SetRenderTarget -- after its checks have found the surface a depth
 * surface with a block, or none: whether a depth surface is set and whether
 * it holds a stencil, which Clear's checks read; and the pair
 * GetDepthStencilSurface answers with, as `renderTargetMirror` writes the
 * target's: the surface and its count's word, or zeros for none. The surface
 * is the argument at `[esp+at]`.
 *
 * @param {number} at
 */
export const depthStencilMirror = at=>Object.freeze([
    [0x83, 0xa1, ...dword(SHADOW.TARGETS_VALID), 0xfd],          // and dword [ecx+disp], ~2
    [0x8b, 0x44, 0x24, at],                                      // mov eax, [esp+at]: the surface
    [0x85, 0xc0],                                                // test eax, eax
    { jcc: 0x74, to: 'depthPair' },                              // jz depthPair: none, zeros
    [0x8b, 0x40, 0x08],                                          // mov eax, [eax+8]: its count
    [0x85, 0xc0],                                                // test eax, eax
    { jcc: 0x74, to: 'depthHeld' },                              // jz depthHeld
    { label: 'depthPair' },
    [0x89, 0x81, ...dword(SHADOW.TARGETS + 12)],                 // mov [ecx+pair+4], eax
    [0x8b, 0x44, 0x24, at],                                      // mov eax, [esp+at]
    [0x89, 0x81, ...dword(SHADOW.TARGETS + 8)],                  // mov [ecx+pair], eax
    [0x83, 0x89, ...dword(SHADOW.TARGETS_VALID), 0x02],          // or dword [ecx+disp], 2
    { label: 'depthHeld' },
    unmarkDrawable(DRAW.DEPTH | DRAW.STENCIL),
    [0x8b, 0x44, 0x24, at],                                      // mov eax, [esp+at]: the surface
    [0x85, 0xc0],                                                // test eax, eax
    { jcc: 0x74, to: 'depth' },                                  // jz depth
    markDrawable(DRAW.DEPTH),
    [0x8b, 0x40, 0x04],                                          // mov eax, [eax+4]: its block
    [0x81, 0xb8, ...dword(SURFACE.DESC), ...dword(D3DFMT_D24S8)], // cmp [eax+Format], D24S8
    { jcc: 0x75, to: 'depth' },                                  // jne depth
    markDrawable(DRAW.STENCIL),
    { label: 'depth' },
]);
export const DEPTH_STENCIL_MIRROR = depthStencilMirror(0x08);

/**
 * The same for SetSamplerState: the value into its sampler's slot. A sampler
 * or a type past the block is the host's.
 */
export const SAMPLER_STATE_MIRROR = Object.freeze([
    [0x8b, 0x44, 0x24, 0x08],                                    // mov eax, [esp+8]
    [0x3d, ...dword(SHADOW.SAMPLER_COUNT)],                      // cmp eax, 16
    { jcc: 0x73, to: 'out', near: true },                        // jae out
    [0x8b, 0x54, 0x24, 0x0c],                                    // mov edx, [esp+12]
    [0x81, 0xfa, ...dword(SHADOW.SAMPLER_STATE_STRIDE)],         // cmp edx, 16
    { jcc: 0x73, to: 'out', near: true },                        // jae out
    [0xc1, 0xe0, 0x04],                                          // shl eax, 4
    [0x01, 0xd0],                                                // add eax, edx
    [0x8b, 0x54, 0x24, 0x10],                                    // mov edx, [esp+16]
    ...storeState(SHADOW.SAMPLER_STATES),
]);

/**
 * What a viewport must be for Direct3D 9 to take it: a width and a height, and
 * a corner that is not negative. It may reach past the target.
 */
export const VIEWPORT_GUARD_9 = Object.freeze([
    [0x8b, 0x54, 0x24, 0x08],                                    // mov edx, [esp+8]
    [0x85, 0xd2],                                                // test edx, edx
    { jcc: 0x74, to: 'out', near: true },                        // jz out
    [0x83, 0x3a, 0x00],                                          // cmp dword [edx], 0
    { jcc: 0x7c, to: 'out', near: true },                        // jl out
    [0x83, 0x7a, 0x04, 0x00],                                    // cmp dword [edx+4], 0
    { jcc: 0x7c, to: 'out', near: true },                        // jl out
    [0x83, 0x7a, 0x08, 0x00],                                    // cmp dword [edx+8], 0
    { jcc: 0x74, to: 'out', near: true },                        // je out
    [0x83, 0x7a, 0x0c, 0x00],                                    // cmp dword [edx+12], 0
    { jcc: 0x74, to: 'out', near: true },                        // je out
]);

/** And for Direct3D 8, which takes only a viewport within the render target. */
export const VIEWPORT_GUARD_8 = Object.freeze([
    ...VIEWPORT_GUARD_9,
    [0x8b, 0x42, 0x08],                                          // mov eax, [edx+8]
    [0x03, 0x02],                                                // add eax, [edx]
    { jcc: 0x72, to: 'out', near: true },                        // jc out
    [0x3b, 0x81, ...dword(SHADOW.TARGET_WIDTH)],                 // cmp eax, [ecx+disp]
    { jcc: 0x77, to: 'out', near: true },                        // ja out
    [0x8b, 0x42, 0x0c],                                          // mov eax, [edx+12]
    [0x03, 0x42, 0x04],                                          // add eax, [edx+4]
    { jcc: 0x72, to: 'out', near: true },                        // jc out
    [0x3b, 0x81, ...dword(SHADOW.TARGET_HEIGHT)],                // cmp eax, [ecx+disp]
    { jcc: 0x77, to: 'out', near: true },                        // ja out
]);

/**
 * What the routines that change the state a draw needs keep in the block for
 * the draws' routines (`SHADOW.DRAWABLE`): the same answer the device would
 * give, from the arguments the call carries. The host writes what the device
 * holds after each of its own entries, so a call it made is accounted for too.
 */
export const DRAWABLE_MIRRORS = Object.freeze({
    /** BeginScene: in a scene. */
    BeginScene: Object.freeze([markDrawable(DRAW.SCENE)]),
    /** EndScene: out of it. */
    EndScene: Object.freeze([unmarkDrawable(DRAW.SCENE)]),
    /**
     * Direct3D 9's SetFVF: no format changes nothing; any other is a format a
     * draw reads if it has a position.
     */
    SetFVF: Object.freeze([
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x85, 0xc0],                                            // test eax, eax
        { jcc: 0x74, to: 'drawn' },                              // jz drawn
        unmarkDrawable(DRAW.DECLARED),
        [0xa8, 0x0e],                                            // test al, XYZ|XYZRHW|...
        { jcc: 0x74, to: 'drawn' },                              // jz drawn
        markDrawable(DRAW.DECLARED),
        { label: 'drawn' },
    ]),
    /** SetVertexDeclaration: a declaration is one a draw reads, none is none. */
    SetVertexDeclaration: Object.freeze([
        unmarkDrawable(DRAW.DECLARED),
        [0x83, 0x7c, 0x24, 0x08, 0x00],                          // cmp dword [esp+8], 0
        { jcc: 0x74, to: 'drawn' },                              // je drawn
        markDrawable(DRAW.DECLARED),
        { label: 'drawn' },
    ]),
    /**
     * Direct3D 8's SetVertexShader: a shader's handle, or a format with a
     * position, is something a draw reads.
     */
    SetVertexShader8: Object.freeze([
        unmarkDrawable(DRAW.DECLARED),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0xa9, ...dword(D3DFVF_RESERVED0)],                      // test eax, RESERVED0
        { jcc: 0x75, to: 'declared' },                           // jnz declared
        [0xa8, 0x0e],                                            // test al, 0x0e
        { jcc: 0x74, to: 'drawn' },                              // jz drawn
        { label: 'declared' },
        markDrawable(DRAW.DECLARED),
        { label: 'drawn' },
    ]),
    /**
     * Direct3D 9's SetStreamSource: stream zero is drawn from when it has a
     * buffer, a stride and an offset whose remainder past whole strides is a
     * whole number of four bytes, where WebGPU can bind a vertex buffer.
     */
    SetStreamSource9: Object.freeze([
        [0x83, 0x7c, 0x24, 0x08, 0x00],                          // cmp dword [esp+8], 0
        { jcc: 0x75, to: 'drawn' },                              // jne drawn
        unmarkDrawable(DRAW.STREAM),
        [0x83, 0x7c, 0x24, 0x0c, 0x00],                          // cmp dword [esp+12], 0
        { jcc: 0x74, to: 'drawn' },                              // je drawn
        [0x83, 0x7c, 0x24, 0x14, 0x00],                          // cmp dword [esp+20], 0
        { jcc: 0x74, to: 'drawn' },                              // je drawn
        [0x8b, 0x44, 0x24, 0x10],                                // mov eax, [esp+16]
        [0x31, 0xd2],                                            // xor edx, edx
        [0xf7, 0x74, 0x24, 0x14],                                // div dword [esp+20]
        [0xf6, 0xc2, 0x03],                                      // test dl, 3
        { jcc: 0x75, to: 'drawn' },                              // jnz drawn
        markDrawable(DRAW.STREAM),
        { label: 'drawn' },
    ]),
    /** Direct3D 8's: stream zero is drawn from when it has a buffer. */
    SetStreamSource8: Object.freeze([
        [0x83, 0x7c, 0x24, 0x08, 0x00],                          // cmp dword [esp+8], 0
        { jcc: 0x75, to: 'drawn' },                              // jne drawn
        unmarkDrawable(DRAW.STREAM),
        [0x83, 0x7c, 0x24, 0x0c, 0x00],                          // cmp dword [esp+12], 0
        { jcc: 0x74, to: 'drawn' },                              // je drawn
        markDrawable(DRAW.STREAM),
        { label: 'drawn' },
    ]),
    /** SetIndices: an index buffer, or none. */
    SetIndices: Object.freeze([
        unmarkDrawable(DRAW.INDEXED),
        [0x83, 0x7c, 0x24, 0x08, 0x00],                          // cmp dword [esp+8], 0
        { jcc: 0x74, to: 'drawn' },                              // je drawn
        markDrawable(DRAW.INDEXED),
        { label: 'drawn' },
    ]),
    /** A draw from the program's memory leaves stream zero unset; the indices stay. */
    DrawPrimitiveUP: Object.freeze([unmarkDrawable(DRAW.STREAM)]),
});

/**
 * The same for SetTextureStageState, given the types the version has: the
 * value into its stage's slot. A stage past the block, or a type it does not
 * hold, is the host's.
 *
 * @param {number} types
 */
export const stageStateMirror = types=>[
    [0x8b, 0x44, 0x24, 0x0c],                                    // mov eax, [esp+12]
    [0x3d, ...dword(SHADOW.STAGE_STATE_STRIDE)],                 // cmp eax, 32
    { jcc: 0x73, to: 'out', near: true },                        // jae out
    [0xba, ...dword(types)],                                     // mov edx, imm32
    [0x0f, 0xa3, 0xc2],                                          // bt edx, eax
    { jcc: 0x73, to: 'out', near: true },                        // jnc out
    [0x8b, 0x44, 0x24, 0x08],                                    // mov eax, [esp+8]
    [0x3d, ...dword(SHADOW.STAGE_COUNT)],                        // cmp eax, 8
    { jcc: 0x73, to: 'out', near: true },                        // jae out
    [0xc1, 0xe0, 0x05],                                          // shl eax, 5
    [0x03, 0x44, 0x24, 0x0c],                                    // add eax, [esp+12]
    [0x8b, 0x54, 0x24, 0x10],                                    // mov edx, [esp+16]
    ...storeState(SHADOW.STAGE_STATES),
];

