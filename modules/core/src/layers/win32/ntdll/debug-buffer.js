/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * The process debug buffer: RtlCreateQueryDebugBuffer, RtlQueryProcessDebugInformation
 * and RtlDestroyQueryDebugBuffer, what a crash reporter or a tool listing
 * modules and heaps asks of ntdll.
 *
 * The buffer is a RTL_DEBUG_INFORMATION (DEBUG_BUFFER) in the process heap;
 * a query fills the parts its flags ask for, each a block of its own the
 * buffer points at: the modules as RTL_PROCESS_MODULES, read from the
 * loader's list in the process block, and the heaps as RTL_PROCESS_HEAPS.
 * The 32-bit layouts only: a 64-bit process is refused, and says so.
 */

const STATUS_SUCCESS = 0;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_INVALID_CID = 0xc000000b;
const STATUS_NO_MEMORY = 0xc0000017;
const STATUS_NOT_IMPLEMENTED = 0xc0000002;

/** RTL_DEBUG_INFORMATION's fields, 32-bit. */
const DEBUG_BUFFER = Object.freeze({
    INFO_CLASS_MASK: 0x20,
    SIZE_OF_INFO: 0x24,
    ALLOCATED_SIZE: 0x28,
    MODULE_INFORMATION: 0x30,
    BACK_TRACE_INFORMATION: 0x34,
    HEAP_INFORMATION: 0x38,
    LOCK_INFORMATION: 0x3c,
    SIZE: 0x60,
});

/** What RtlQueryProcessDebugInformation is asked for. */
export const PDI = Object.freeze({
    MODULES: 0x01,
    BACKTRACE: 0x02,
    HEAPS: 0x04,
    HEAP_TAGS: 0x08,
    HEAP_BLOCKS: 0x10,
    LOCKS: 0x20,
});

/** RTL_PROCESS_MODULE_INFORMATION, 32-bit, after RTL_PROCESS_MODULES' count. */
const MODULE = Object.freeze({
    MAPPED_BASE: 0x04,
    IMAGE_BASE: 0x08,
    IMAGE_SIZE: 0x0c,
    LOAD_ORDER_INDEX: 0x14,
    INIT_ORDER_INDEX: 0x16,
    LOAD_COUNT: 0x18,
    OFFSET_TO_FILE_NAME: 0x1a,
    FULL_PATH_NAME: 0x1c,
    PATH_ROOM: 256,
    SIZE: 0x11c,
});

/** RTL_HEAP_INFORMATION, 32-bit, after RTL_PROCESS_HEAPS' count. */
const HEAP = Object.freeze({ BASE_ADDRESS: 0x00, SIZE: 0x40 });

/**
 * One loaded module as RTL_PROCESS_MODULE_INFORMATION has it.
 *
 * @typedef {{ base: number, size: number, path: string }} DebugModule
 */

/**
 * @typedef {Object} DebugBufferHost
 * @property {import('../common/guest.js').Guest} guest
 * @property {(bytes: number) => number} allocate  Zeroed bytes of the process heap.
 * @property {(address: number) => boolean} free
 * @property {number} processId  This process's id.
 * @property {(id: number) => boolean} [otherProcess]  Whether an id names another
 *     process of the run, whose information is not read from here.
 * @property {() => DebugModule[]} modules  The loader's list, in load order.
 * @property {() => number[]} heaps  The process's heaps, its own first.
 * @property {number} [pointerSize]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {DebugBufferHost} host
 */
export function createDebugBufferFunctions(host){
    const { guest } = host;
    /**
     * The blocks each live buffer's last query allocated, to give back.
     *
     * @type {Map<number, number[]>}
     */
    const blocks = new Map();
    const release = (/** @type {number} */ buffer)=>{
        for (const block of blocks.get(buffer) ?? [])
        {
            host.free(block);
        }
        blocks.set(buffer, []);
    };

    /** @param {DebugModule[]} modules */
    const moduleBlock = modules=>{
        const data = new Uint8Array(4 + modules.length * MODULE.SIZE);
        const view = new DataView(data.buffer);
        view.setUint32(0, modules.length, true);
        modules.forEach(({ base, size, path }, index)=>{
            const at = 4 + index * MODULE.SIZE;
            view.setUint32(at + MODULE.MAPPED_BASE, base, true);
            view.setUint32(at + MODULE.IMAGE_BASE, base, true);
            view.setUint32(at + MODULE.IMAGE_SIZE, size, true);
            view.setUint16(at + MODULE.LOAD_ORDER_INDEX, index, true);
            view.setUint16(at + MODULE.INIT_ORDER_INDEX, index, true);
            view.setUint16(at + MODULE.LOAD_COUNT, 1, true);
            const text = [...path].slice(0, MODULE.PATH_ROOM - 1)
                .map(character=>(character.charCodeAt(0) < 0x100 ? character.charCodeAt(0) : 0x3f));
            data.set(text, at + MODULE.FULL_PATH_NAME);
            view.setUint16(at + MODULE.OFFSET_TO_FILE_NAME,
                Math.min(path.lastIndexOf('\\') + 1, text.length), true);
        });
        return data;
    };

    /** @param {number[]} heaps */
    const heapBlock = heaps=>{
        const data = new Uint8Array(4 + heaps.length * HEAP.SIZE);
        const view = new DataView(data.buffer);
        view.setUint32(0, heaps.length, true);
        heaps.forEach((heap, index)=>view.setUint32(4 + index * HEAP.SIZE + HEAP.BASE_ADDRESS,
            heap, true));
        return data;
    };

    return {
        /** PRTL_DEBUG_INFORMATION RtlCreateQueryDebugBuffer(ULONG Size, BOOLEAN EventPair) */
        RtlCreateQueryDebugBuffer: {
            returns: 'pointer',
            argBytes: 8,
            handler: ()=>{
                const buffer = host.allocate(DEBUG_BUFFER.SIZE);
                if (buffer === 0)
                {
                    return 0;
                }
                guest.fill(buffer, 0, DEBUG_BUFFER.SIZE);
                guest.set32(buffer + DEBUG_BUFFER.ALLOCATED_SIZE, DEBUG_BUFFER.SIZE);
                blocks.set(buffer, []);
                return buffer;
            },
        },

        /** NTSTATUS RtlDestroyQueryDebugBuffer(PRTL_DEBUG_INFORMATION Buffer) */
        RtlDestroyQueryDebugBuffer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                const at = wholeAddress(buffer);
                if (!blocks.has(at))
                {
                    return STATUS_INVALID_PARAMETER;
                }
                release(at);
                blocks.delete(at);
                host.free(at);
                return STATUS_SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlQueryProcessDebugInformation(ULONG UniqueProcessId,
         *     ULONG Flags, PRTL_DEBUG_INFORMATION Buffer)
         *
         * An id that names no process is STATUS_INVALID_CID (a thread's id
         * included). The modules and the heaps are listed; a heap's figures,
         * its blocks, its tags, back traces and locks are not kept, and are
         * said not to be.
         */
        RtlQueryProcessDebugInformation: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([id, flags, buffer])=>{
                const at = wholeAddress(buffer);
                if (!blocks.has(at))
                {
                    return STATUS_INVALID_PARAMETER;
                }
                if ((id >>> 0) !== host.processId)
                {
                    if (!host.otherProcess?.(id >>> 0))
                    {
                        return STATUS_INVALID_CID;
                    }
                    host.divergence?.('RtlQueryProcessDebugInformation',
                        'another process\'s debug information is not read; refused');
                    return STATUS_NOT_IMPLEMENTED;
                }
                if (host.pointerSize === 8)
                {
                    host.divergence?.('RtlQueryProcessDebugInformation',
                        'the 64-bit layout is not written; refused');
                    return STATUS_NOT_IMPLEMENTED;
                }
                release(at);
                const asked = flags >>> 0;
                let size = 0;
                /** @param {Uint8Array} data @param {number} field */
                const place = (data, field)=>{
                    const block = host.allocate(data.length);
                    if (block === 0)
                    {
                        return false;
                    }
                    guest.setBytes(block, data);
                    /** @type {number[]} */ (blocks.get(at)).push(block);
                    guest.set32(at + field, block);
                    size += data.length;
                    return true;
                };
                if ((asked & PDI.MODULES) !== 0
                    && !place(moduleBlock(host.modules()), DEBUG_BUFFER.MODULE_INFORMATION))
                {
                    return STATUS_NO_MEMORY;
                }
                if ((asked & (PDI.HEAPS | PDI.HEAP_BLOCKS | PDI.HEAP_TAGS)) !== 0
                    && !place(heapBlock(host.heaps()), DEBUG_BUFFER.HEAP_INFORMATION))
                {
                    return STATUS_NO_MEMORY;
                }
                const unkept = asked & (PDI.HEAP_BLOCKS | PDI.HEAP_TAGS | PDI.BACKTRACE
                    | PDI.LOCKS | PDI.HEAPS);
                if (unkept !== 0)
                {
                    host.divergence?.('RtlQueryProcessDebugInformation',
                        'heap figures, blocks and tags, back traces and locks are not kept; '
                        + 'the heaps are listed with none');
                }
                guest.set32(at + DEBUG_BUFFER.INFO_CLASS_MASK, asked);
                guest.set32(at + DEBUG_BUFFER.SIZE_OF_INFO, size);
                return STATUS_SUCCESS;
            },
        },
    };
}
