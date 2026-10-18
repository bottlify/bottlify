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
    PROCESS_HEAP: 0x18,
    NUMBER_OF_PROCESSORS: 0x64,
    OS_MAJOR_VERSION: 0xa4,
    OS_MINOR_VERSION: 0xa8,
    OS_BUILD_NUMBER: 0xac,
    OS_CSD_VERSION: 0xae,
    OS_PLATFORM_ID: 0xb0,
    CSD_VERSION: 0x1f0,
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
 * @typedef {Object} ThreadLocal
 * An image's thread-local block, as each thread gets a copy of it.
 * @property {number} slot          The slot the loader gave the image.
 * @property {Uint8Array} template  What every copy starts as.
 * @property {number} size          The template and the zeroes after it.
 */

/**
 * @param {Object} options
 * @param {(bytes: number) => number} options.allocate
 *        Guest memory, zeroed, for what lives as long as the process.
 * @param {{ allocate: (bytes: number) => number, free: (address: number) => void }}
 *     [options.threadMemory]
 *        Guest memory a thread's blocks are taken from and given back to,
 *        `allocate` answering zero when it has no room. Without it they come
 *        from `options.allocate` and are never given back.
 * @param {(address: number, bytes: Uint8Array) => void} options.writeMemory
 * @param {number} options.processId
 * @param {{ major: number, minor: number, build: number, servicePackMajor?: number,
 *     servicePackMinor?: number, csdVersion?: string }} options.version
 *        The Windows the machine is: the numbers, and the service pack as a
 *        pair and as text, which is how the block keeps it.
 * @param {number} options.imageBase
 * @param {number} [options.processHeap]  The handle GetProcessHeap answers.
 * @param {string} [options.imagePath]
 * @param {string} [options.commandLine]
 * @param {string} [options.currentDirectory]
 * @param {{ input: number, output: number, error: number }} [options.standardHandles]
 * @param {number} [options.processors]  How many processors the machine has --
 *        the process's executors, which the kernel knows once the processor
 *        layer is made; absent, one.
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
    // Read without a call wherever GetProcessHeap is compiled inline, as
    // NtCurrentTeb()->Peb->ProcessHeap: a null here is a heap nothing can
    // allocate from, and a program that tests the pointer it gets back takes
    // every allocation as out of memory.
    write(peb + PEB.PROCESS_HEAP, options.processHeap ?? 0);
    write(peb + PEB.OS_MAJOR_VERSION, version.major);
    write(peb + PEB.OS_MINOR_VERSION, version.minor);
    // Two WORDs, written as the DWORD they make up: the build, then the
    // service pack with its major number in the high byte.
    write(peb + PEB.OS_BUILD_NUMBER, (version.build & 0xffff
        | ((version.servicePackMajor ?? 0) & 0xff) << 24
        | ((version.servicePackMinor ?? 0) & 0xff) << 16) >>> 0);
    write(peb + PEB.OS_PLATFORM_ID, 2); // VER_PLATFORM_WIN32_NT
    // Read directly by a runtime sizing its thread pool, without a call.
    write(peb + PEB.NUMBER_OF_PROCESSORS, options.processors ?? 1);

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

    // The service pack's name, in the room between the block and its
    // parameters rather than in the arena the parameters' strings share.
    // Empty when there is none: a reader copies it without looking first.
    const csdVersion = version.csdVersion ?? '';
    const csdText = new Uint8Array(csdVersion.length * 2 + 2);
    for (let index = 0; index < csdVersion.length; index++)
    {
        csdText[index * 2] = csdVersion.charCodeAt(index) & 0xff;
        csdText[index * 2 + 1] = csdVersion.charCodeAt(index) >>> 8;
    }
    writeMemory(peb + PEB.SIZE, csdText);
    write(peb + PEB.CSD_VERSION, (csdVersion.length * 2 | csdText.length << 16) >>> 0);
    write(peb + PEB.CSD_VERSION + 4, peb + PEB.SIZE);

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

    // A thread's blocks go when it does: a program that makes a thread per
    // task and lets each one end has only ever had a few alive, however many
    // it has made.
    const threadMemory = options.threadMemory ?? { allocate, free: ()=>{} };
    /**
     * Every block a thread was given, by its environment block: the block and
     * its thread-local array, and its copy of each image's thread-local block
     * by the slot it is in.
     *
     * @type {Map<number, { tls: number, blocks: number[], locals: Map<number, number> }>}
     */
    const threadHeld = new Map();
    /**
     * A thread's copy of an image's block, written in full at `at` -- the
     * memory may be what an ended thread left -- and named in its array.
     *
     * @param {number} tls @param {ThreadLocal} local @param {number} at
     */
    const copyLocal = (tls, { slot, template, size }, at)=>{
        writeMemory(at, new Uint8Array(size));
        writeMemory(at, template);
        write(tls + (slot >>> 0) * 4, at);
    };

    return {
        peb,
        params,
        ldr,
        addModule,
        removeModule,

        /**
         * A block for one thread, with its own thread-local array and its own
         * copy of each image's thread-local block.
         *
         * The array is separate from the block because a program indexes it by
         * a slot number the loader chose, and the block has no room reserved
         * for one -- on Windows it is allocated apart and pointed at, and a
         * program that reads the pointer and indexes it must find the same
         * values TlsGetValue reports.
         *
         * Each is written in full, because the memory may be what an ended
         * thread was given: its block naming that thread, its locals as that
         * thread left them.
         *
         * @param {Object} thread
         * @param {number} thread.id
         * @param {number} thread.stackBase   The highest address of its stack.
         * @param {number} thread.stackLimit  The lowest.
         * @param {ThreadLocal[]} [thread.locals]
         *        Copied into the array at their slots; a slot past it has
         *        nowhere to go and is left out.
         * @returns {{ teb: number, tls: number } | null} null, and nothing
         *     taken, when the thread memory has no room for all of them
         */
        createThreadBlock({ id, stackBase, stackLimit, locals = [] }){
            /** @type {number[]} */
            const taken = [];
            /** @param {number} bytes */
            const take = bytes=>{
                const at = threadMemory.allocate(bytes);
                if (at !== 0)
                {
                    taken.push(at);
                }
                return at;
            };
            const refused = ()=>{
                for (const at of taken)
                {
                    threadMemory.free(at);
                }
                return null;
            };
            const teb = take(TEB.SIZE);
            const tls = teb === 0 ? 0 : take(TLS_SLOTS * 4);
            if (tls === 0)
            {
                return refused();
            }
            writeMemory(teb, new Uint8Array(TEB.SIZE));
            writeMemory(tls, new Uint8Array(TLS_SLOTS * 4));
            /** @type {Map<number, number>} */
            const copies = new Map();
            for (const local of locals)
            {
                if (local.slot >>> 0 >= TLS_SLOTS)
                {
                    continue;
                }
                const at = take(local.size);
                if (at === 0)
                {
                    return refused();
                }
                copyLocal(tls, local, at);
                copies.set(local.slot >>> 0, at);
            }

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

            threadHeld.set(teb, { tls, blocks: [teb, tls], locals: copies });
            return { teb, tls };
        },

        /**
         * Gives back everything `createThreadBlock` and `addThreadLocal` gave
         * a thread: for once the thread has ended and runs nowhere, since
         * until then it still reads and writes them.
         *
         * @param {number} teb
         * @returns {boolean} false for a block this did not make, or gave back already
         */
        releaseThreadBlock(teb){
            const held = threadHeld.get(teb);
            if (held === undefined)
            {
                return false;
            }
            threadHeld.delete(teb);
            for (const at of [...held.blocks, ...held.locals.values()])
            {
                threadMemory.free(at);
            }
            return true;
        },

        /**
         * A copy of an image loaded after the threads were made in each of
         * their arrays, at the image's slot: every thread holding a block has
         * one from now on, as the loader gives each existing thread one when a
         * library with thread-local storage is loaded at run time. A thread
         * made later is given its copy by `createThreadBlock`.
         *
         * @param {ThreadLocal} local
         * @returns {boolean} false, and nothing taken or written, when the
         *     slot is past the array or the thread memory has no room for
         *     every thread's copy
         */
        addThreadLocal(local){
            const slot = local.slot >>> 0;
            if (slot >= TLS_SLOTS)
            {
                return false;
            }
            /** @type {[{ tls: number, locals: Map<number, number> }, number][]} */
            const given = [];
            for (const held of threadHeld.values())
            {
                const at = threadMemory.allocate(local.size);
                if (at === 0)
                {
                    for (const [each, copy] of given)
                    {
                        threadMemory.free(copy);
                        each.locals.delete(slot);
                        write(each.tls + slot * 4, 0);
                    }
                    return false;
                }
                copyLocal(held.tls, local, at);
                held.locals.set(slot, at);
                given.push([held, at]);
            }
            return true;
        },

        /**
         * Takes every thread's copy at a slot back out of its array, as the
         * loader does when the library that slot was given to is unloaded:
         * the copy is given back and the slot reads zero.
         *
         * @param {number} slot
         */
        removeThreadLocal(slot){
            for (const held of threadHeld.values())
            {
                const at = held.locals.get(slot >>> 0);
                if (at !== undefined)
                {
                    held.locals.delete(slot >>> 0);
                    threadMemory.free(at);
                    write(held.tls + (slot >>> 0) * 4, 0);
                }
            }
        },
    };
}
