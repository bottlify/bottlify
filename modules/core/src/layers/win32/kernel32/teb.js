/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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

import { PROCESSOR } from './processor.js';

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
    NUMBER_OF_PROCESSORS: 0x64,
    OS_MAJOR_VERSION: 0xa4,
    OS_MINOR_VERSION: 0xa8,
    OS_BUILD_NUMBER: 0xac,
    OS_PLATFORM_ID: 0xb0,
    SIZE: 0x230,
});

/**
 * Field offsets in `PEB_LDR_DATA`, the block `PEB.LDR` points at.
 *
 * Three circular `LIST_ENTRY` lists over the same set of modules, ordered
 * differently: a program that walks one of them -- anti-tamper code, a plugin
 * loader enumerating what is already loaded -- reads a real list, never a
 * null it dereferences on the first `Flink`.
 */
export const LDR_DATA = Object.freeze({
    LENGTH: 0x00,
    INITIALIZED: 0x04,
    SS_HANDLE: 0x08,
    IN_LOAD_ORDER_MODULE_LIST: 0x0c,
    IN_MEMORY_ORDER_MODULE_LIST: 0x14,
    IN_INITIALIZATION_ORDER_MODULE_LIST: 0x1c,
    SIZE: 0x24,
});

/**
 * Field offsets in `LDR_DATA_TABLE_ENTRY`, one per loaded module.
 *
 * The three `LIST_ENTRY` pairs are the same module's links in each of the
 * three orderings above; `FullDllName` and `BaseDllName` are `UNICODE_STRING`
 * descriptors -- a 16-bit length, a 16-bit room and a 32-bit pointer to
 * characters that live just past the entry, the same shape the process
 * parameter block's strings already use.
 */
export const LDR_ENTRY = Object.freeze({
    IN_LOAD_ORDER_LINKS: 0x00,
    IN_MEMORY_ORDER_LINKS: 0x08,
    IN_INITIALIZATION_ORDER_LINKS: 0x10,
    DLL_BASE: 0x18,
    ENTRY_POINT: 0x1c,
    SIZE_OF_IMAGE: 0x20,
    FULL_DLL_NAME: 0x24,
    BASE_DLL_NAME: 0x2c,
    FLAGS: 0x34,
    SIZE: 0x38,
});

/**
 * Field offsets in the parameter block the process block points at.
 *
 * A program reads this far more often than it reads the process block itself:
 * its standard handles are here, its command line is here, and a C runtime's
 * startup checks the normalised flag before it trusts any of it. Leaving the
 * pointer to this block null is not a missing feature -- it is a null that a
 * program dereferences on its first frame, having every right to.
 */
export const PARAMS = Object.freeze({
    MAXIMUM_LENGTH: 0x00,
    LENGTH: 0x04,
    FLAGS: 0x08,
    DEBUG_FLAGS: 0x0c,
    CONSOLE_HANDLE: 0x10,
    CONSOLE_FLAGS: 0x14,
    STANDARD_INPUT: 0x18,
    STANDARD_OUTPUT: 0x1c,
    STANDARD_ERROR: 0x20,
    CURRENT_DIRECTORY: 0x24,
    DLL_PATH: 0x30,
    IMAGE_PATH_NAME: 0x38,
    COMMAND_LINE: 0x40,
    ENVIRONMENT: 0x48,
    SIZE: 0x290,
});

/**
 * The parameter block holds pointers into itself rather than elsewhere, and
 * says so with this flag. A runtime that finds it clear treats every pointer in
 * the block as an offset instead, and reads from near address zero.
 */
const PARAMS_NORMALIZED = 0x80000000;

/** Where the parameter block sits inside the process block's own allocation. */
const PARAMS_OFFSET = 0x300;

/** Room after the parameter block for the strings it points at. */
const STRING_ARENA = 0x400;

/** No handler is registered yet, and this is how a thread says so. */
export const END_OF_EXCEPTION_LIST = 0xffffffff;

/** How many thread-local slots the array behind FS:[0x2c] holds. */
export const TLS_SLOTS = 64;

/**
 * @typedef {Object} LoadedModule
 * @property {string} name       The module's own name, `BaseDllName`.
 * @property {number} base       `DllBase`.
 * @property {number} [size]     `SizeOfImage`; absent reads as zero.
 * @property {number} [entryPoint]
 * @property {string} [path]     The full path, `FullDllName`; absent falls back to `name`.
 */

/**
 * @param {Object} options
 * @param {(bytes: number) => number} options.allocate  Guest memory, zeroed.
 * @param {(address: number, bytes: Uint8Array) => void} options.writeMemory
 * @param {number} options.processId
 * @param {{ major: number, minor: number, build: number }} options.version
 * @param {number} options.imageBase
 * @param {string} [options.imagePath]
 * @param {string} [options.commandLine]
 * @param {string} [options.currentDirectory]
 * @param {{ input: number, output: number, error: number }} [options.standardHandles]
 * @param {LoadedModule[]} [options.modules]
 *        Every module mapped before the process's first instruction runs --
 *        the loader's own module table, snapshotted here once. `addModule`
 *        on the returned object is how one loaded later, by `LoadLibrary`,
 *        joins the same three lists.
 * @returns {any}
 */
export function createProcessBlocks(options){
    const { allocate, writeMemory, processId, version, imageBase } = options;
    const imagePath = options.imagePath ?? '';
    const commandLine = options.commandLine ?? '';
    const currentDirectory = options.currentDirectory ?? '';
    const standardHandles = options.standardHandles ?? { input: 0, output: 0, error: 0 };
    // One allocation for the process block, its parameter block and the strings
    // those point at. They are one object as far as a program is concerned, and
    // separate allocations would let one move without the other.
    const peb = allocate(PARAMS_OFFSET + PARAMS.SIZE + STRING_ARENA);
    const params = peb + PARAMS_OFFSET;
    const write = (/** @type {number} */ at, /** @type {number} */ value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        writeMemory(at, bytes);
    };

    writeMemory(peb, new Uint8Array(PARAMS_OFFSET + PARAMS.SIZE + STRING_ARENA));
    write(peb + PEB.IMAGE_BASE_ADDRESS, imageBase);
    write(peb + PEB.PROCESS_PARAMETERS, params);
    write(peb + PEB.OS_MAJOR_VERSION, version.major);
    write(peb + PEB.OS_MINOR_VERSION, version.minor);
    write(peb + PEB.OS_BUILD_NUMBER, version.build);
    write(peb + PEB.OS_PLATFORM_ID, 2); // VER_PLATFORM_WIN32_NT
    // Read directly by a runtime sizing its thread pool, without a call.
    write(peb + PEB.NUMBER_OF_PROCESSORS, PROCESSOR.count);

    // Strings are laid out after the parameter block, in the same allocation.
    let strings = params + PARAMS.SIZE;

    /**
     * A UNICODE_STRING written in place: its length in bytes, the room it has,
     * and a pointer to characters that live just past the block.
     *
     * @param {number} at    Where the descriptor goes.
     * @param {string} text
     */
    const writeUnicodeString = (at, text)=>{
        const bytes = new Uint8Array(text.length * 2 + 2);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < text.length; index++)
        {
            view.setUint16(index * 2, text.charCodeAt(index), true);
        }
        writeMemory(strings, bytes);

        const descriptor = new Uint8Array(8);
        const fields = new DataView(descriptor.buffer);
        // The length excludes the terminator and the maximum includes it, which
        // is how a caller tells a full buffer from one with room left.
        fields.setUint16(0, text.length * 2, true);
        fields.setUint16(2, bytes.length, true);
        fields.setUint32(4, strings, true);
        writeMemory(at, descriptor);
        strings += bytes.length + 2 & ~1;
    };

    write(params + PARAMS.MAXIMUM_LENGTH, PARAMS.SIZE + STRING_ARENA);
    write(params + PARAMS.LENGTH, PARAMS.SIZE);
    write(params + PARAMS.FLAGS, PARAMS_NORMALIZED);
    write(params + PARAMS.STANDARD_INPUT, standardHandles.input);
    write(params + PARAMS.STANDARD_OUTPUT, standardHandles.output);
    write(params + PARAMS.STANDARD_ERROR, standardHandles.error);
    writeUnicodeString(params + PARAMS.IMAGE_PATH_NAME, imagePath);
    writeUnicodeString(params + PARAMS.COMMAND_LINE, commandLine);
    writeUnicodeString(params + PARAMS.CURRENT_DIRECTORY, currentDirectory);

    // PEB_LDR_DATA and its three lists of loaded modules. Never left null: a
    // program that walks one starting from PEB->Ldr -- anti-tamper code, a
    // plugin loader enumerating what is already there -- has every right to a
    // real circular list, the way any other process's loader leaves it.
    const ldr = allocate(LDR_DATA.SIZE);
    writeMemory(ldr, new Uint8Array(LDR_DATA.SIZE));
    write(peb + PEB.LDR, ldr);
    write(ldr + LDR_DATA.LENGTH, LDR_DATA.SIZE);
    write(ldr + LDR_DATA.INITIALIZED, 1);

    const loadHead = ldr + LDR_DATA.IN_LOAD_ORDER_MODULE_LIST;
    const memoryHead = ldr + LDR_DATA.IN_MEMORY_ORDER_MODULE_LIST;
    const initHead = ldr + LDR_DATA.IN_INITIALIZATION_ORDER_MODULE_LIST;
    // Empty is circular too: a list of nothing still answers Flink === Blink
    // === its own address, or a walk that checks "have I got back to the
    // head" never does.
    for (const head of [loadHead, memoryHead, initHead])
    {
        write(head, head);
        write(head + 4, head);
    }
    /**
     * Each list's nodes after its head, in order: what linking and unlinking
     * are done from, since nothing here reads guest memory back.
     *
     * @type {Map<number, number[]>}
     */
    const lists = new Map([[loadHead, []], [memoryHead, []], [initHead, []]]);
    /** Each module's entry, by its base. @type {Map<number, number>} */
    const entries = new Map();

    /**
     * `InsertTailList`, done by hand: nothing here keeps a live pointer into
     * guest memory to call the real one on, only the address it would be at.
     *
     * @param {number} head @param {number} node
     */
    const insertTail = (head, node)=>{
        const nodes = /** @type {number[]} */ (lists.get(head));
        const tail = nodes.at(-1) ?? head;
        write(node, head);
        write(node + 4, tail);
        write(tail, node);
        write(head + 4, node);
        nodes.push(node);
    };

    /**
     * `RemoveEntryList`: the neighbours are joined around the node.
     *
     * @param {number} head @param {number} node
     */
    const remove = (head, node)=>{
        const nodes = /** @type {number[]} */ (lists.get(head));
        const at = nodes.indexOf(node);
        if (at < 0)
        {
            return;
        }
        const before = at > 0 ? nodes[at - 1] : head;
        const after = at + 1 < nodes.length ? nodes[at + 1] : head;
        write(before, after);
        write(after + 4, before);
        nodes.splice(at, 1);
    };

    /**
     * A `UNICODE_STRING` describing a wide buffer this call places itself,
     * rather than one carved out of a shared arena -- each module entry owns
     * exactly as much string room as its two names need and no more.
     *
     * @param {number} descriptorAt @param {number} bufferAt @param {string} text
     */
    const writeEntryString = (descriptorAt, bufferAt, text)=>{
        const bytes = new Uint8Array(text.length * 2 + 2);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < text.length; index++)
        {
            view.setUint16(index * 2, text.charCodeAt(index), true);
        }
        writeMemory(bufferAt, bytes);
        const descriptor = new Uint8Array(8);
        const fields = new DataView(descriptor.buffer);
        fields.setUint16(0, text.length * 2, true);
        fields.setUint16(2, bytes.length, true);
        fields.setUint32(4, bufferAt, true);
        writeMemory(descriptorAt, descriptor);
    };

    /**
     * Joins one more module to all three lists -- the loader's own table at
     * process start, or a library `LoadLibrary` mapped afterwards. What a
     * name lacks in one order it never lacks in another: this is the one
     * place a module enters the process's module list at all.
     *
     * @param {LoadedModule} module
     * @returns {number} the entry's own address
     */
    const addModule = module=>{
        const fullName = module.path ?? module.name;
        const baseName = module.name;
        const entry = allocate(
            LDR_ENTRY.SIZE + fullName.length * 2 + 2 + baseName.length * 2 + 2);
        writeMemory(entry, new Uint8Array(LDR_ENTRY.SIZE));
        write(entry + LDR_ENTRY.DLL_BASE, module.base);
        write(entry + LDR_ENTRY.ENTRY_POINT, module.entryPoint ?? 0);
        write(entry + LDR_ENTRY.SIZE_OF_IMAGE, module.size ?? 0);

        const fullNameBuffer = entry + LDR_ENTRY.SIZE;
        const baseNameBuffer = fullNameBuffer + fullName.length * 2 + 2;
        writeEntryString(entry + LDR_ENTRY.FULL_DLL_NAME, fullNameBuffer, fullName);
        writeEntryString(entry + LDR_ENTRY.BASE_DLL_NAME, baseNameBuffer, baseName);

        insertTail(loadHead, entry + LDR_ENTRY.IN_LOAD_ORDER_LINKS);
        insertTail(memoryHead, entry + LDR_ENTRY.IN_MEMORY_ORDER_LINKS);
        insertTail(initHead, entry + LDR_ENTRY.IN_INITIALIZATION_ORDER_LINKS);
        entries.set(module.base >>> 0, entry);
        return entry;
    };

    /**
     * Takes a module FreeLibrary unloaded out of all three lists. Its entry
     * stays where it was, unlinked, as the loader leaves it.
     *
     * @param {number} base
     */
    const removeModule = base=>{
        const entry = entries.get(base >>> 0);
        if (entry === undefined)
        {
            return;
        }
        remove(loadHead, entry + LDR_ENTRY.IN_LOAD_ORDER_LINKS);
        remove(memoryHead, entry + LDR_ENTRY.IN_MEMORY_ORDER_LINKS);
        remove(initHead, entry + LDR_ENTRY.IN_INITIALIZATION_ORDER_LINKS);
        entries.delete(base >>> 0);
    };

    for (const module of options.modules ?? [])
    {
        addModule(module);
    }

    return {
        peb,
        params,
        ldr,
        addModule,
        removeModule,

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
