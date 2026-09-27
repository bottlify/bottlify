/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Interlocked singly linked lists: a LIFO of entries the program owns, each
 * an SLIST_ENTRY whose first word is the next one's address, under an
 * SLIST_HEADER of three fields on a 32-bit system -- the first entry, the
 * depth as a WORD and a WORD sequence that moves with every change.
 *
 * On Windows each operation is one `lock cmpxchg8b` on the header. Here each
 * is one host call, which no other guest thread can interleave with, since
 * the scheduler preempts only between instructions; the header is kept as
 * Windows keeps it, so a program that reads it -- or pushes with its own
 * compare-exchange -- finds the same words.
 */

/** SLIST_HEADER on a 32-bit system. */
const HEADER = Object.freeze({
    NEXT: 0,
    DEPTH: 4,
    SEQUENCE: 6,
    SIZE: 8,
});

/**
 * @typedef {Object} SListHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {(bytes: number) => number} [allocateCode]
 *           Guest memory the processor executes, for the fastcall push.
 */

/**
 * What the export binding hands a guest-code entry: the means to register the
 * trap it jumps to, answering the trap's address.
 *
 * @typedef {{ register: (name: string,
 *     fn: { argBytes: number, handler: Function }) => number }} TrapBuilder
 */

/** The fastcall push's code: four one-byte instructions and a `jmp rel32`. */
const FAST_PUSH_LENGTH = 9;

/**
 * @param {SListHost} host
 */
export function createSListFunctions(host){
    /** @param {number} address */
    const read32 = address=>new DataView(host.readMemory(address, 4).slice().buffer)
        .getUint32(0, true);

    /** @param {number} header */
    const readHeader = header=>{
        const view = new DataView(host.readMemory(header, HEADER.SIZE).slice().buffer);
        return {
            next: view.getUint32(HEADER.NEXT, true),
            depth: view.getUint16(HEADER.DEPTH, true),
            sequence: view.getUint16(HEADER.SEQUENCE, true),
        };
    };

    /**
     * @param {number} header @param {number} next @param {number} depth
     * @param {number} sequence
     */
    const writeHeader = (header, next, depth, sequence)=>{
        const bytes = new Uint8Array(HEADER.SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(HEADER.NEXT, next >>> 0, true);
        view.setUint16(HEADER.DEPTH, depth & 0xffff, true);
        view.setUint16(HEADER.SEQUENCE, sequence & 0xffff, true);
        host.writeMemory(header, bytes);
    };

    /** @param {number} address @param {number} value */
    const write32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    /**
     * Puts the chain `first`..`last` of `count` entries on the front of the
     * list, answering the entry that was first before.
     *
     * @param {number} header @param {number} first @param {number} last @param {number} count
     */
    const pushList = (header, first, last, count)=>{
        const { next, depth, sequence } = readHeader(header);
        write32(last, next);
        writeHeader(header, first, depth + count, sequence + 1);
        return next;
    };

    /** Where the fastcall push's code was placed, once. */
    let fastPush = 0;

    /**
     * PSLIST_ENTRY RtlInterlockedPushListSList(PSLIST_HEADER, PSLIST_ENTRY List,
     *                                          PSLIST_ENTRY ListEnd, ULONG Count)
     *
     * __fastcall, the header in ECX and the list in EDX: kernel32's sync tests
     * call it through a thunk that loads them so. The count is added to the
     * depth as given, whatever the chain holds. A trap cannot be bound
     * fastcall, so the export is four instructions that put the two
     * registers on the stack under the return address and go on to a stdcall
     * trap of all four arguments, which pops the two the caller pushed with
     * them:
     *
     *     pop eax; push edx; push ecx; push eax; jmp <slist-push-list>
     */
    const pushListFast = {
        argBytes: 16,
        /** @param {TrapBuilder} builder */
        guest: builder=>{
            if (fastPush === 0)
            {
                const trap = builder.register('<slist-push-list>', {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: ([header, first, last, count])=>
                        pushList(header >>> 0, first >>> 0, last >>> 0, count >>> 0),
                });
                fastPush = (host.allocateCode ?? host.allocate)(FAST_PUSH_LENGTH);
                const relative = (trap - (fastPush + FAST_PUSH_LENGTH)) | 0;
                host.writeMemory(fastPush, new Uint8Array([
                    0x58, 0x52, 0x51, 0x50, 0xe9,
                    relative & 0xff, relative >>> 8 & 0xff,
                    relative >>> 16 & 0xff, relative >>> 24 & 0xff,
                ]));
            }
            return fastPush;
        },
    };

    return {
        /** VOID InitializeSListHead(PSLIST_HEADER ListHead) */
        InitializeSListHead: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([header])=>{
                host.writeMemory(header >>> 0, new Uint8Array(HEADER.SIZE));
                return 0;
            },
        },

        /** USHORT QueryDepthSList(PSLIST_HEADER ListHead) */
        QueryDepthSList: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([header])=>readHeader(header >>> 0).depth,
        },

        /** PSLIST_ENTRY InterlockedPushEntrySList(PSLIST_HEADER, PSLIST_ENTRY) */
        InterlockedPushEntrySList: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([header, entry])=>pushList(header >>> 0, entry >>> 0, entry >>> 0, 1),
            natives: {
                RtlInterlockedPushListSList: pushListFast,
                /**
                 * PSLIST_ENTRY RtlInterlockedPushListSListEx(PSLIST_HEADER,
                 *     PSLIST_ENTRY List, PSLIST_ENTRY ListEnd, ULONG Count)
                 *
                 * The same push, as an ordinary stdcall.
                 */
                RtlInterlockedPushListSListEx: {
                    argBytes: 16,
                    /** @param {number[]} args */
                    handler: ([header, first, last, count])=>
                        pushList(header >>> 0, first >>> 0, last >>> 0, count >>> 0),
                },
            },
        },

        /** PSLIST_ENTRY InterlockedPopEntrySList(PSLIST_HEADER) */
        InterlockedPopEntrySList: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([header])=>{
                const { next, depth, sequence } = readHeader(header >>> 0);
                if (next === 0)
                {
                    return 0;
                }
                writeHeader(header >>> 0, read32(next), depth - 1, sequence + 1);
                return next;
            },
        },

        /**
         * PSLIST_ENTRY InterlockedFlushSList(PSLIST_HEADER)
         *
         * The whole chain, taken off at once and handed back still linked. A
         * list already empty is left as it is, its depth with it -- the
         * answer kernel32's sync tests accept from Windows before 8.
         */
        InterlockedFlushSList: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([header])=>{
                const { next, sequence } = readHeader(header >>> 0);
                if (next === 0)
                {
                    return 0;
                }
                writeHeader(header >>> 0, 0, 0, sequence + 1);
                return next;
            },
        },
    };
}
