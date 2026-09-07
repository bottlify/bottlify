/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The blocks a Win32 thread and process are described by, in guest memory.
 *
 * A program does not ask for these. It reaches them through FS, which points at
 * the running thread's block, and it does so in code the compiler emitted
 * rather than code anybody wrote: a `__declspec(thread)` variable is
 * `mov eax, fs:[0x2c]` followed by an index into the array that lands at, and
 * the prologue of any function with an exception handler pushes `fs:[0]` and
 * writes its own record there. Neither is a call this engine can intercept.
 *
 * So with no block at all -- FS based at zero -- both read linear address 0x2c
 * and 0x00, get whatever is there, and carry on. The thread-local read
 * dereferences a null array and the exception record is chained onto nothing.
 * Nothing reports it, because from the processor's point of view a program is
 * allowed to read those addresses.
 *
 * The layout below is the one every such instruction was compiled against, so
 * the offsets are not ours to choose. Only the first few fields matter to a
 * program that is not the operating system, and those are the ones filled in;
 * the rest are present and zero because their positions are what put the filled
 * ones where they belong.
 */

/** Field offsets in the thread block, and the size a whole one occupies. */
export const TEB = Object.freeze({
    EXCEPTION_LIST: 0x00,
    STACK_BASE: 0x04,
    STACK_LIMIT: 0x08,
    SUB_SYSTEM_TIB: 0x0c,
    FIBER_DATA: 0x10,
    ARBITRARY_USER_POINTER: 0x14,
    SELF: 0x18,
    ENVIRONMENT_POINTER: 0x1c,
    PROCESS_ID: 0x20,
    THREAD_ID: 0x24,
    ACTIVE_RPC_HANDLE: 0x28,
    TLS_POINTER: 0x2c,
    PEB: 0x30,
    LAST_ERROR: 0x34,
    SIZE: 0x1000,
});

/** Field offsets in the process block. */
export const PEB = Object.freeze({
    INHERITED_ADDRESS_SPACE: 0x00,
    READ_IMAGE_FILE_EXEC_OPTIONS: 0x01,
    BEING_DEBUGGED: 0x02,
    IMAGE_BASE_ADDRESS: 0x08,
    LDR: 0x0c,
    PROCESS_PARAMETERS: 0x10,
    OS_MAJOR_VERSION: 0xa4,
    OS_MINOR_VERSION: 0xa8,
    OS_BUILD_NUMBER: 0xac,
    OS_PLATFORM_ID: 0xb0,
    SIZE: 0x230,
});

/** No handler is registered yet, and this is how a thread says so. */
export const END_OF_EXCEPTION_LIST = 0xffffffff;

/** How many thread-local slots the array behind FS:[0x2c] holds. */
export const TLS_SLOTS = 64;

/**
 * @param {Object} options
 * @param {(bytes: number) => number} options.allocate  Guest memory, zeroed.
 * @param {(address: number, bytes: Uint8Array) => void} options.writeMemory
 * @param {number} options.processId
 * @param {{ major: number, minor: number, build: number }} options.version
 * @param {number} options.imageBase
 */
export function createProcessBlocks(options){
    const { allocate, writeMemory, processId, version, imageBase } = options;
    const peb = allocate(PEB.SIZE);
    const write = (/** @type {number} */ at, /** @type {number} */ value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        writeMemory(at, bytes);
    };

    writeMemory(peb, new Uint8Array(PEB.SIZE));
    write(peb + PEB.IMAGE_BASE_ADDRESS, imageBase);
    write(peb + PEB.OS_MAJOR_VERSION, version.major);
    write(peb + PEB.OS_MINOR_VERSION, version.minor);
    write(peb + PEB.OS_BUILD_NUMBER, version.build);
    write(peb + PEB.OS_PLATFORM_ID, 2); // VER_PLATFORM_WIN32_NT

    return {
        peb,

        /**
         * A block for one thread, with its own thread-local array.
         *
         * The array is separate from the block because a program indexes it by
         * a slot number the loader chose, and the block has no room reserved
         * for one -- on Windows it is allocated apart and pointed at, and a
         * program that reads the pointer and indexes it must find the same
         * values TlsGetValue reports.
         *
         * @param {Object} thread
         * @param {number} thread.id
         * @param {number} thread.stackBase   The highest address of its stack.
         * @param {number} thread.stackLimit  The lowest.
         * @returns {{ teb: number, tls: number }}
         */
        createThreadBlock({ id, stackBase, stackLimit }){
            const teb = allocate(TEB.SIZE);
            const tls = allocate(TLS_SLOTS * 4);
            writeMemory(teb, new Uint8Array(TEB.SIZE));
            writeMemory(tls, new Uint8Array(TLS_SLOTS * 4));

            // No handler registered yet. Zero would be an address, and a
            // dispatcher walking the chain would follow it.
            write(teb + TEB.EXCEPTION_LIST, END_OF_EXCEPTION_LIST);
            write(teb + TEB.STACK_BASE, stackBase);
            write(teb + TEB.STACK_LIMIT, stackLimit);
            // Programs read this to get the block's own address, because FS
            // cannot be turned into a pointer any other way.
            write(teb + TEB.SELF, teb);
            write(teb + TEB.PROCESS_ID, processId);
            write(teb + TEB.THREAD_ID, id);
            write(teb + TEB.TLS_POINTER, tls);
            write(teb + TEB.PEB, peb);

            return { teb, tls };
        },
    };
}
