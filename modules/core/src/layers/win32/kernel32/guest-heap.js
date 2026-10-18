/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The heap's small blocks, allocated and freed by the guest itself.
 *
 * HeapAlloc and HeapFree -- and malloc and free above them -- are the calls a
 * program makes most while it loads, and each was a crossing into the host
 * for a lookup in the host's own maps. A block of up to a kilobyte is now
 * handed out and taken back by a few dozen instructions in the guest, the
 * way the heap's front end does it on Windows, and only what those do not
 * keep reaches the host: a class with nothing cached, a cache that is full, a
 * heap whose lock another thread holds, a flag they do not take, a pointer
 * they do not recognise.
 *
 * The host's rule that nothing of a heap's bookkeeping sits beside a block
 * still holds. Small blocks live in slabs of one size class each, 16 KiB
 * apart, and what the guest knows of them is out of line: a directory with a
 * word for every 16 KiB of the arena naming the slab's record, and the record
 * with a 16-bit word for each of its cells -- zero for free, and otherwise one
 * more than the bytes asked for, which is how HeapSize answers exactly. A
 * write past the end of a block reaches the next block, as it would on
 * Windows, and never a heap's own state.
 *
 * Each heap's control block (its handle, as on Windows, at a 64 KiB
 * boundary) holds a lock word and, for each class, a stack of free cells --
 * the cache the guest takes from and gives back to, the cell and the address
 * of its word in each entry. The lock is taken with `xchg`, one instruction,
 * and the scheduler switches threads only between instructions, so a thread
 * that finds it taken is one preempted inside a few instructions of its own;
 * it does not wait but hands its call to the host. The host touches a heap's
 * cache only while it holds the same lock, taken with one compare-and-swap:
 * threads on the process's other executors run while it does, and a lock
 * found free and not taken was another thread's the next instant. Where it
 * finds the lock taken it does not wait either, and keeps the free cells it
 * knows of beyond that cache itself: those it takes when a cache runs dry, and
 * those a full cache hands back, from which a slab whose cells are all back
 * goes back to the arena.
 */

import { assembleTo } from './code-arena.js';

/** The largest block the guest's own path hands out. */
export const SMALL_LIMIT = 1024;

/** The cells of each size class, in bytes: at most an eighth of a large one unused. */
export const CELL_SIZES = Object.freeze([
    8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256,
    320, 384, 448, 512, 640, 768, 896, 1024,
]);

/** Each request's class, by its size rounded up to eight bytes and divided by eight. */
const CLASS_OF = Uint8Array.from({ length: SMALL_LIMIT / 8 + 1 },
    (_, eighths)=>CELL_SIZES.findIndex(size=>size >= Math.max(8, eighths * 8)));

/** A slab's size, and what one directory word covers. */
export const SLAB = 16384;
const SLAB_SHIFT = 14;

/**
 * A heap's control block. The lock is 0 while free; each class keeps how
 * many cells its cache holds, its cells' size, and the cache itself -- the
 * cell's address and its word's, eight bytes an entry.
 */
export const CONTROL = Object.freeze({
    LOCK: 0x00,
    MAGIC: 0x04,
    CLASSES: 0x40,
    CLASS_SHIFT: 10,
    COUNT: 0,
    CELL: 4,
    ENTRIES: 8,
    SIZE: 0x40 + CELL_SIZES.length * 0x400,
});

/** The entries a class's cache holds: what fits in its 1 KiB after the two words. */
export const CACHE = 127;

/** How many a dry cache is given, and a full one gives back, at once. */
const REFILL = 64;
const DRAIN = 64;

/** Where a heap's handle is aligned, as HeapCreate's are on Windows. */
const HEAP_ALIGNMENT = 0x10000;

/** Marks a live control block: 'HEAP'. */
export const HEAP_MAGIC = 0x50414548;

/** A slab's record: its heap, its cells, where it is, and a word a cell from `SIZES`. */
export const RECORD = Object.freeze({
    HEAP: 0,
    CELL: 4,
    RECIPROCAL: 8,
    BASE: 12,
    CELLS: 16,
    CLASS: 20,
    SIZES: 32,
});

/** The owner of what this file takes from the arena for itself. */
const OWN = Symbol('guest heap');

/**
 * The guest memory the host side reads and writes.
 *
 * @typedef {Object} HeapMemory
 * @property {(address: number) => number} readU16
 * @property {(address: number) => number} readU32
 * @property {(address: number, value: number) => void} writeU16
 * @property {(address: number, value: number) => void} writeU32
 * @property {(address: number, length: number) => Uint8Array} readBytes
 * @property {(address: number, bytes: Uint8Array) => void} writeBytes
 * @property {(address: number, value: number, length: number) => void} fillBytes
 * @property {(address: number, expected: number, value: number) => number} [compareExchangeU32]
 *     one indivisible step against other threads where the memory is shared
 */

/**
 * @typedef {Object} Slab
 * @property {number} base
 * @property {number} record
 * @property {HeapState} heap
 * @property {number} cls
 * @property {number} cellSize
 * @property {number} cells
 * @property {number} next     Cells from here on were never handed out.
 * @property {number[]} free   Free cells the host holds, by index: in no cache.
 * @property {boolean} partial  Whether its class's `partial` lists it.
 */

/**
 * @typedef {Object} HeapState
 * @property {number} handle
 * @property {{ slabs: Set<Slab>, partial: Slab[] }[]} classes
 */

/**
 * @typedef {Object} BlockInfo
 * @property {number} address
 * @property {number} size
 * @property {number} capacity
 * @property {any} owner
 * @property {boolean} fresh
 */

/**
 * The allocator this sits in front of: the shared one over the arena
 * (`heap.js`'s `createHeapAllocator`).
 *
 * @typedef {Object} Backend
 * @property {(bytes: number, options?: { alignment?: number, owner?: any }) => number} allocate
 * @property {(address: number, bytes: number, options?: { owner?: any }) => boolean} allocateAt
 * @property {(address: number) => boolean} free
 * @property {(address: number) => BlockInfo | null} block
 * @property {(address: number) => BlockInfo | null} blockContaining
 * @property {(address: number) => BlockInfo | null} blockAtOrBefore
 * @property {(address: number) => Generator<BlockInfo>} blocksAbove
 * @property {(address: number, bytes: number) => boolean} resize
 * @property {() => { base: number, size: number }[]} freeSpans
 * @property {(owner: any) => number[]} owned
 * @property {() => number} handedTo  the first arena address never inside a block
 * @property {() => { blocks: number, used: number, free: number, largestFree: number }}
 *     diagnostics
 */

/**
 * @param {{ allocator: Backend, arena: { base: number, size: number },
 *     memory: HeapMemory }} options
 */
export function createGuestHeap({ allocator, arena, memory }){
    /** The directory's first granule starts here, at or below the arena. */
    const dirBase = Math.floor(arena.base / SLAB) * SLAB;
    const dirSpan = arena.base + arena.size - dirBase;
    const granules = Math.ceil(dirSpan / SLAB);

    /** @type {Map<number, HeapState>} */
    const heaps = new Map();
    /** By granule, the slab there. @type {Map<number, Slab>} */
    const slabs = new Map();
    /** Control blocks made before guest memory could be written. @type {number[]} */
    const unwritten = [];
    let directory = 0;
    let classMap = 0;
    let ready = false;
    const counts = { slabs: 0, released: 0, refills: 0, drains: 0, hostAllocations: 0,
        hostFrees: 0 };

    /** @param {number} address @param {number} length */
    const zeroed = (address, length)=>{
        if (!allocator.block(address)?.fresh)
        {
            memory.fillBytes(address, 0, length);
        }
    };

    /** @param {number} hcb */
    const writeControl = hcb=>{
        zeroed(hcb, CONTROL.SIZE);
        memory.writeU32(hcb + CONTROL.MAGIC, HEAP_MAGIC);
        CELL_SIZES.forEach((size, cls)=>{
            memory.writeU32(classArea(hcb, cls) + CONTROL.CELL, size);
        });
    };

    /**
     * What the guest's routines read before their first run: the directory
     * and the class of each size, and the control blocks made so far. Guest
     * memory is written here and not at `createHeap`, which the process heap
     * reaches while the machine is being assembled.
     *
     * @returns {boolean} false when the arena had no room for them
     */
    const ensure = ()=>{
        if (ready)
        {
            return true;
        }
        directory = allocator.allocate(granules * 4, { owner: OWN });
        classMap = directory === 0 ? 0 : allocator.allocate(CLASS_OF.length, { owner: OWN });
        if (classMap === 0)
        {
            if (directory !== 0)
            {
                allocator.free(directory);
            }
            return false;
        }
        zeroed(directory, granules * 4);
        memory.writeBytes(classMap, CLASS_OF);
        for (const hcb of unwritten.splice(0))
        {
            writeControl(hcb);
        }
        ready = true;
        return true;
    };

    /** @param {number} hcb @param {number} cls */
    const classArea = (hcb, cls)=>hcb + CONTROL.CLASSES + (cls << CONTROL.CLASS_SHIFT);

    /** @param {number} address */
    const slabOf = address=>{
        const offset = address - dirBase;
        return offset < 0 || offset >= dirSpan ? undefined : slabs.get(Math.floor(offset / SLAB));
    };

    /**
     * The cell starting at `address`, or null for anything else.
     *
     * @param {number} address
     * @returns {{ slab: Slab, index: number } | null}
     */
    const cellAt = address=>{
        const slab = slabOf(address >>> 0);
        if (slab === undefined)
        {
            return null;
        }
        const offset = (address >>> 0) - slab.base;
        const index = Math.floor(offset / slab.cellSize);
        return index * slab.cellSize === offset && index < slab.cells ? { slab, index } : null;
    };

    /** @param {Slab} slab @param {number} index */
    const slotOf = (slab, index)=>slab.record + RECORD.SIZES + index * 2;

    /** @param {Slab} slab */
    const listPartial = slab=>{
        if (!slab.partial)
        {
            slab.partial = true;
            slab.heap.classes[slab.cls].partial.push(slab);
        }
    };

    /**
     * A new slab for a heap's class, or null when the arena has no room.
     *
     * @param {HeapState} heap @param {number} cls
     * @returns {Slab | null}
     */
    const newSlab = (heap, cls)=>{
        const cellSize = CELL_SIZES[cls];
        const cells = Math.floor(SLAB / cellSize);
        const base = allocator.allocate(SLAB, { alignment: SLAB, owner: OWN });
        if (base === 0)
        {
            return null;
        }
        const record = allocator.allocate(RECORD.SIZES + cells * 2, { owner: OWN });
        if (record === 0)
        {
            allocator.free(base);
            return null;
        }
        zeroed(record, RECORD.SIZES + cells * 2);
        memory.writeU32(record + RECORD.HEAP, heap.handle);
        memory.writeU32(record + RECORD.CELL, cellSize);
        // ceil(2^32 / size): the high word of an offset times it is the offset
        // over the size, exactly for every offset inside a slab.
        memory.writeU32(record + RECORD.RECIPROCAL, Math.ceil(2 ** 32 / cellSize) >>> 0);
        memory.writeU32(record + RECORD.BASE, base);
        memory.writeU32(record + RECORD.CELLS, cells);
        memory.writeU32(record + RECORD.CLASS, cls);
        const granule = (base - dirBase) / SLAB;
        memory.writeU32(directory + granule * 4, record);
        /** @type {Slab} */
        const slab = {
            base, record, heap, cls, cellSize, cells, next: 0, free: [], partial: false,
        };
        slabs.set(granule, slab);
        heap.classes[cls].slabs.add(slab);
        listPartial(slab);
        counts.slabs++;
        return slab;
    };

    /**
     * A slab whose cells are all back with the host goes back to the arena.
     *
     * @param {Slab} slab
     */
    const releaseIfEmpty = slab=>{
        if (slab.free.length !== slab.next)
        {
            return;
        }
        const granule = (slab.base - dirBase) / SLAB;
        memory.writeU32(directory + granule * 4, 0);
        slabs.delete(granule);
        const kind = slab.heap.classes[slab.cls];
        kind.slabs.delete(slab);
        if (slab.partial)
        {
            kind.partial.splice(kind.partial.indexOf(slab), 1);
        }
        allocator.free(slab.record);
        allocator.free(slab.base);
        counts.slabs--;
        counts.released++;
    };

    /**
     * A free cell in no cache, taken from the host's own: its address, or 0.
     *
     * @param {HeapState} heap @param {number} cls
     */
    const takeCell = (heap, cls)=>{
        const { partial } = heap.classes[cls];
        for (;;)
        {
            const slab = partial.length > 0 ? partial[partial.length - 1] : newSlab(heap, cls);
            if (slab === null)
            {
                return 0;
            }
            const index = slab.free.length > 0 ? /** @type {number} */ (slab.free.pop())
                : slab.next < slab.cells ? slab.next++ : -1;
            if (slab.free.length === 0 && slab.next === slab.cells)
            {
                partial.pop();
                slab.partial = false;
            }
            if (index >= 0)
            {
                return slab.base + index * slab.cellSize;
            }
        }
    };

    /**
     * Takes the heap's lock for the host: whether it was free. What the guest's
     * `xchg` leaves there is 1 as well.
     *
     * @param {HeapState} heap
     */
    const lock = heap=>{
        const at = heap.handle + CONTROL.LOCK;
        if (memory.compareExchangeU32)
        {
            return memory.compareExchangeU32(at, 0, 1) === 0;
        }
        if (memory.readU32(at) !== 0)
        {
            return false;
        }
        memory.writeU32(at, 1);
        return true;
    };
    /** @param {HeapState} heap */
    const unlock = heap=>memory.writeU32(heap.handle + CONTROL.LOCK, 0);

    /**
     * The oldest half of a full cache back to the host.
     *
     * @param {HeapState} heap @param {number} cls
     */
    const drain = (heap, cls)=>{
        const area = classArea(heap.handle, cls);
        const count = memory.readU32(area + CONTROL.COUNT);
        const taken = Math.min(DRAIN, count);
        /** @type {Set<Slab>} */
        const touched = new Set();
        for (let i = 0; i < taken; i++)
        {
            const cell = cellAt(memory.readU32(area + CONTROL.ENTRIES + i * 8));
            if (cell !== null)
            {
                cell.slab.free.push(cell.index);
                listPartial(cell.slab);
                touched.add(cell.slab);
            }
        }
        const rest = memory.readBytes(area + CONTROL.ENTRIES + taken * 8, (count - taken) * 8)
            .slice();
        memory.writeBytes(area + CONTROL.ENTRIES, rest);
        memory.writeU32(area + CONTROL.COUNT, count - taken);
        counts.drains++;
        for (const slab of touched)
        {
            releaseIfEmpty(slab);
        }
    };

    /**
     * A dry cache given cells, while its heap's lock is free.
     *
     * @param {HeapState} heap @param {number} cls
     */
    const refill = (heap, cls)=>{
        const area = classArea(heap.handle, cls);
        let count = memory.readU32(area + CONTROL.COUNT);
        while (count < REFILL)
        {
            const address = takeCell(heap, cls);
            if (address === 0)
            {
                break;
            }
            const { slab, index } = /** @type {{ slab: Slab, index: number }} */ (cellAt(address));
            memory.writeU32(area + CONTROL.ENTRIES + count * 8, address);
            memory.writeU32(area + CONTROL.ENTRIES + count * 8 + 4, slotOf(slab, index));
            count++;
        }
        memory.writeU32(area + CONTROL.COUNT, count);
        counts.refills++;
    };

    /**
     * A block for the host's own path: from the cache while the heap's lock
     * is free (filling it first when it is dry), otherwise from the cells the
     * host holds. 0 when the arena has no room.
     *
     * @param {HeapState} heap @param {number} size
     */
    const allocateSmall = (heap, size)=>{
        if (!ensure())
        {
            return 0;
        }
        const cls = CLASS_OF[(size + 7) >>> 3];
        let address = 0;
        if (lock(heap))
        {
            const area = classArea(heap.handle, cls);
            if (memory.readU32(area + CONTROL.COUNT) === 0)
            {
                refill(heap, cls);
            }
            const count = memory.readU32(area + CONTROL.COUNT);
            if (count > 0)
            {
                address = memory.readU32(area + CONTROL.ENTRIES + (count - 1) * 8);
                memory.writeU32(area + CONTROL.COUNT, count - 1);
            }
            unlock(heap);
        }
        if (address === 0)
        {
            address = takeCell(heap, cls);
        }
        if (address === 0)
        {
            return 0;
        }
        const { slab, index } = /** @type {{ slab: Slab, index: number }} */ (cellAt(address));
        memory.writeU16(slotOf(slab, index), size + 1);
        counts.hostAllocations++;
        return address;
    };

    /**
     * A live cell given back by the host's path: into its heap's cache where
     * the lock is free (half the cache handed back first when it is full),
     * otherwise to the host's own.
     *
     * @param {{ slab: Slab, index: number }} cell
     */
    const freeSmall = ({ slab, index })=>{
        const slot = slotOf(slab, index);
        if (memory.readU16(slot) === 0)
        {
            return false;
        }
        memory.writeU16(slot, 0);
        counts.hostFrees++;
        const { heap } = slab;
        if (!lock(heap))
        {
            slab.free.push(index);
            listPartial(slab);
            releaseIfEmpty(slab);
            return true;
        }
        const area = classArea(heap.handle, slab.cls);
        if (memory.readU32(area + CONTROL.COUNT) >= CACHE)
        {
            drain(heap, slab.cls);
        }
        const count = memory.readU32(area + CONTROL.COUNT);
        memory.writeU32(area + CONTROL.ENTRIES + count * 8, slab.base + index * slab.cellSize);
        memory.writeU32(area + CONTROL.ENTRIES + count * 8 + 4, slot);
        memory.writeU32(area + CONTROL.COUNT, count + 1);
        unlock(heap);
        return true;
    };

    /**
     * @param {{ slab: Slab, index: number }} cell
     * @returns {BlockInfo | null}
     */
    const blockOfCell = ({ slab, index })=>{
        const word = memory.readU16(slotOf(slab, index));
        return word === 0 ? null : {
            address: slab.base + index * slab.cellSize,
            size: word - 1,
            capacity: slab.cellSize,
            owner: slab.heap.handle,
            fresh: false,
        };
    };

    return {
        /**
         * A heap: its control block's address, which is its handle. 0 when
         * the arena has no room.
         */
        createHeap(){
            const hcb = allocator.allocate(CONTROL.SIZE,
                { alignment: HEAP_ALIGNMENT, owner: OWN });
            if (hcb === 0)
            {
                return 0;
            }
            heaps.set(hcb, {
                handle: hcb,
                classes: CELL_SIZES.map(()=>({ slabs: new Set(), partial: [] })),
            });
            if (ready)
            {
                writeControl(hcb);
            }
            else
            {
                unwritten.push(hcb);
            }
            return hcb;
        },

        /** Every small block of the heap goes with it, and so does its handle. @param {number} hcb */
        destroyHeap(hcb){
            const heap = heaps.get(hcb);
            if (heap === undefined)
            {
                return false;
            }
            for (const { slabs: owned } of heap.classes)
            {
                for (const slab of owned)
                {
                    slab.free = Array.from({ length: slab.next }, (_, i)=>i);
                    slab.partial = false;
                    releaseIfEmpty(slab);
                }
            }
            if (ready)
            {
                memory.writeU32(hcb + CONTROL.MAGIC, 0);
            }
            else
            {
                unwritten.splice(unwritten.indexOf(hcb), 1);
            }
            heaps.delete(hcb);
            allocator.free(hcb);
            return true;
        },

        /** @param {number} handle */
        isHeap: handle=>heaps.has(handle >>> 0),

        /** Every heap, in the order they were made. */
        list: ()=>[...heaps.keys()],

        /**
         * The allocator every host path goes through: the arena's own, with
         * the small blocks of a heap's owner taken here and every block of
         * either kind found, sized and freed by whichever holds it.
         *
         * @returns {Backend}
         */
        wrap(){
            return {
                allocate(bytes, options = {}){
                    // Not before the routines are placed: until then guest memory
                    // may not be there to write a cell's word into, and nothing in
                    // the guest takes a cell back.
                    const heap = !ready || options.owner === undefined ? undefined
                        : heaps.get(options.owner);
                    if (heap !== undefined && bytes <= SMALL_LIMIT
                        && (options.alignment ?? 8) <= 8)
                    {
                        const address = allocateSmall(heap, bytes);
                        if (address !== 0)
                        {
                            return address;
                        }
                    }
                    return allocator.allocate(bytes, options);
                },
                allocateAt: (address, bytes, options)=>
                    allocator.allocateAt(address, bytes, options),
                free(address){
                    const cell = cellAt(address);
                    return cell === null ? allocator.free(address) : freeSmall(cell);
                },
                block(address){
                    const cell = cellAt(address);
                    return cell === null ? allocator.block(address) : blockOfCell(cell);
                },
                blockContaining: address=>allocator.blockContaining(address),
                blockAtOrBefore: address=>allocator.blockAtOrBefore(address),
                blocksAbove: address=>allocator.blocksAbove(address),
                resize(address, bytes){
                    const cell = cellAt(address);
                    if (cell === null)
                    {
                        return allocator.resize(address, bytes);
                    }
                    if (bytes > cell.slab.cellSize || blockOfCell(cell) === null)
                    {
                        return false;
                    }
                    memory.writeU16(slotOf(cell.slab, cell.index), bytes + 1);
                    return true;
                },
                freeSpans: ()=>allocator.freeSpans(),
                owned(owner){
                    const own = allocator.owned(owner);
                    const heap = heaps.get(owner);
                    if (heap === undefined)
                    {
                        return own;
                    }
                    for (const { slabs: held } of heap.classes)
                    {
                        for (const slab of held)
                        {
                            for (let index = 0; index < slab.next; index++)
                            {
                                if (memory.readU16(slotOf(slab, index)) !== 0)
                                {
                                    own.push(slab.base + index * slab.cellSize);
                                }
                            }
                        }
                    }
                    return own;
                },
                handedTo: ()=>allocator.handedTo(),
                diagnostics: ()=>allocator.diagnostics(),
            };
        },

        /**
         * Where the guest's routines find what they read, the directory and
         * the class map written first; null when the arena had no room.
         *
         * @returns {Placement | null}
         */
        placement(){
            return ensure() ? { dirBase, dirSpan, directory, classMap } : null;
        },

        diagnostics(){
            let cached = 0;
            if (ready)
            {
                for (const hcb of heaps.keys())
                {
                    for (let cls = 0; cls < CELL_SIZES.length; cls++)
                    {
                        cached += memory.readU32(classArea(hcb, cls) + CONTROL.COUNT);
                    }
                }
            }
            return { heaps: heaps.size, cached, ...counts };
        },
    };
}

/**
 * What a routine is compiled against.
 *
 * @typedef {Object} Placement
 * @property {number} dirBase    The address the directory's first word covers.
 * @property {number} dirSpan    The bytes it covers from there.
 * @property {number} directory  The directory: a record's address a granule, or 0.
 * @property {number} classMap   A size's class, at its size in eighths rounded up.
 */

/** @param {number} value @returns {number[]} */
const dword = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const JZ = [0x0f, 0x84];
const JNZ = [0x0f, 0x85];
const JB = [0x0f, 0x82];
const JAE = [0x0f, 0x83];
const JBE = [0x0f, 0x86];
const JA = [0x0f, 0x87];

/** @typedef {import('./code-arena.js').Piece} Piece */

/**
 * EAX a pointer: ECX its slab's record, EDX its cell's index and ESI the
 * pointer, pushed first -- or `bad`, which pops ESI, for anything that is not
 * the start of a cell.
 *
 * @param {Placement} p
 * @returns {Piece[]}
 */
function locate(p){
    return [
        [0x56],                                              // push esi
        [0x89, 0xc6],                                        // mov esi, eax
        [0x8d, 0x88, ...dword(-p.dirBase)],                  // lea ecx, [eax - dirBase]
        [0x81, 0xf9, ...dword(p.dirSpan)],                   // cmp ecx, dirSpan
        { jump: JAE, to: 'bad' },
        [0xc1, 0xe9, SLAB_SHIFT],                            // shr ecx, 14
        [0x8b, 0x0c, 0x8d, ...dword(p.directory)],           // mov ecx, [directory + ecx*4]
        [0x85, 0xc9],                                        // test ecx, ecx
        { jump: JZ, to: 'bad' },
        [0x2b, 0x41, RECORD.BASE],                           // sub eax, [ecx + base]
        [0xf7, 0x61, RECORD.RECIPROCAL],                     // mul dword [ecx + reciprocal]
        [0x3b, 0x51, RECORD.CELLS],                          // cmp edx, [ecx + cells]
        { jump: JAE, to: 'bad' },
        [0x89, 0xd0],                                        // mov eax, edx
        [0x0f, 0xaf, 0x41, RECORD.CELL],                     // imul eax, [ecx + cell]
        [0x03, 0x41, RECORD.BASE],                           // add eax, [ecx + base]
        [0x39, 0xf0],                                        // cmp eax, esi
        { jump: JNZ, to: 'bad' },
    ];
}

/**
 * Allocation, EDX the control block and ECX the size (at most SMALL_LIMIT):
 * a cell off its class's cache under the heap's lock, its word written, and
 * zeroed when `zero` says so; to the trap when the lock is taken or the cache
 * is empty.
 *
 * @param {Placement} p
 * @param {'flag' | 'always' | 'never'} zero  `flag`: when the flags word at
 *     [esp + 8] on entry has HEAP_ZERO_MEMORY
 * @param {number} pop  The bytes `ret` takes off.
 * @returns {Piece[]}
 */
function allocBody(p, zero, pop){
    const ret = pop === 0 ? [0xc3] : [0xc2, pop, 0];
    return [
        [0x56],                                              // push esi
        [0x89, 0xce],                                        // mov esi, ecx
        [0x83, 0xc1, 0x07],                                  // add ecx, 7
        [0xc1, 0xe9, 0x03],                                  // shr ecx, 3
        [0x0f, 0xb6, 0x81, ...dword(p.classMap)],            // movzx eax, byte [classMap + ecx]
        [0xc1, 0xe0, CONTROL.CLASS_SHIFT],                   // shl eax, 10
        [0x8d, 0x44, 0x02, CONTROL.CLASSES],                 // lea eax, [edx + eax + classes]
        [0xb9, ...dword(1)],                                 // mov ecx, 1
        [0x87, 0x0a],                                        // xchg [edx], ecx: the lock
        [0x85, 0xc9],                                        // test ecx, ecx
        { jump: JNZ, to: 'busy' },
        [0x8b, 0x08],                                        // mov ecx, [eax]: the count
        [0x83, 0xe9, 0x01],                                  // sub ecx, 1
        { jump: JB, to: 'empty' },
        [0x89, 0x08],                                        // mov [eax], ecx
        [0x53],                                              // push ebx
        [0x8d, 0x5c, 0xc8, CONTROL.ENTRIES],                 // lea ebx, [eax + ecx*8 + entries]
        [0x8d, 0x4e, 0x01],                                  // lea ecx, [esi + 1]: its word
        [0x8b, 0x03],                                        // mov eax, [ebx]: the cell
        [0x8b, 0x5b, 0x04],                                  // mov ebx, [ebx + 4]: its word's
        [0x66, 0x89, 0x0b],                                  // mov [ebx], cx
        [0x5b],                                              // pop ebx
        [0xc7, 0x02, ...dword(0)],                           // mov dword [edx], 0: unlocked
        ...zero === 'flag' ? [
            [0xf6, 0x44, 0x24, 0x0c, 0x08],                  // test byte [esp + 12], 8
            { jump: JNZ, to: 'zero' },
        ] : zero === 'always' ? [{ jump: [0xe9], to: 'zero' }] : [],
        [0x5e],                                              // pop esi
        ret,
        ...zero === 'never' ? [] : [
            'zero',
            [0x57],                                          // push edi
            [0x89, 0xc7],                                    // mov edi, eax
            [0x89, 0xc2],                                    // mov edx, eax
            [0x8d, 0x4e, 0x03],                              // lea ecx, [esi + 3]
            [0xc1, 0xe9, 0x02],                              // shr ecx, 2
            [0x31, 0xc0],                                    // xor eax, eax
            [0xf3, 0xab],                                    // rep stosd
            [0x89, 0xd0],                                    // mov eax, edx
            [0x5f],                                          // pop edi
            [0x5e],                                          // pop esi
            ret,
        ],
        'empty',
        [0xc7, 0x02, ...dword(0)],                           // mov dword [edx], 0
        'busy',
        [0x5e],                                              // pop esi
    ];
}

/**
 * The flags HeapAlloc's own path takes: HEAP_NO_SERIALIZE (the lock is cheap
 * enough to take anyway), HEAP_GENERATE_EXCEPTIONS (it never fails, the host
 * does) and HEAP_ZERO_MEMORY.
 */
const ALLOC_FLAGS = 0x1 | 0x4 | 0x8;
/** And HeapReAlloc's: those and HEAP_REALLOC_IN_PLACE_ONLY. */
const REALLOC_FLAGS = ALLOC_FLAGS | 0x10;

/**
 * LPVOID HeapAlloc(HANDLE hHeap, DWORD dwFlags, SIZE_T dwBytes), as guest
 * code. The handle is taken when it is inside the arena and its block says it
 * is a heap.
 *
 *     mov edx, [esp+4]            ; the heap
 *     mov ecx, [esp+12]           ; the size
 *     test dword [esp+8], ~flags  ; a flag this path does not take
 *     jnz slow
 *     cmp ecx, 1024
 *     ja slow
 *     lea eax, [edx - arena]      ; a handle whose block lies in the arena
 *     cmp eax, span - control
 *     ja slow
 *     cmp dword [edx+4], 'HEAP'
 *     jne slow
 *     ...                         ; allocBody
 *   slow:
 *     jmp <heap-alloc>
 *
 * @param {Placement} p @param {number} at @param {number} trap
 */
export function heapAllocCode(p, at, trap){
    return assembleTo([
        [0x8b, 0x54, 0x24, 0x04],                            // mov edx, [esp + 4]
        [0x8b, 0x4c, 0x24, 0x0c],                            // mov ecx, [esp + 12]
        [0xf7, 0x44, 0x24, 0x08, ...dword(~ALLOC_FLAGS)],    // test dword [esp + 8], ~flags
        { jump: JNZ, to: 'slow' },
        [0x81, 0xf9, ...dword(SMALL_LIMIT)],                 // cmp ecx, 1024
        { jump: JA, to: 'slow' },
        [0x8d, 0x82, ...dword(-p.dirBase)],                  // lea eax, [edx - dirBase]
        [0x3d, ...dword(p.dirSpan - CONTROL.SIZE)],          // cmp eax, dirSpan - control
        { jump: JA, to: 'slow' },
        [0x81, 0x7a, CONTROL.MAGIC, ...dword(HEAP_MAGIC)],   // cmp dword [edx + 4], 'HEAP'
        { jump: JNZ, to: 'slow' },
        ...allocBody(p, 'flag', 12),
    ], at, trap);
}

/**
 * void *malloc(size_t size) on a heap known when it is placed.
 *
 * @param {Placement} p @param {number} at @param {number} trap @param {number} heap
 */
export function mallocCode(p, at, trap, heap){
    return assembleTo([
        [0x8b, 0x4c, 0x24, 0x04],                            // mov ecx, [esp + 4]
        [0x81, 0xf9, ...dword(SMALL_LIMIT)],                 // cmp ecx, 1024
        { jump: JA, to: 'slow' },
        [0xba, ...dword(heap)],                              // mov edx, heap
        ...allocBody(p, 'never', 0),
    ], at, trap);
}

/**
 * void *calloc(size_t count, size_t size): the product, at most a kilobyte
 * and not past 32 bits, zeroed.
 *
 * @param {Placement} p @param {number} at @param {number} trap @param {number} heap
 */
export function callocCode(p, at, trap, heap){
    return assembleTo([
        [0x8b, 0x44, 0x24, 0x04],                            // mov eax, [esp + 4]
        [0xf7, 0x64, 0x24, 0x08],                            // mul dword [esp + 8]
        { jump: JB, to: 'slow' },                            // jc: past 32 bits
        [0x3d, ...dword(SMALL_LIMIT)],                       // cmp eax, 1024
        { jump: JA, to: 'slow' },
        [0x89, 0xc1],                                        // mov ecx, eax
        [0xba, ...dword(heap)],                              // mov edx, heap
        ...allocBody(p, 'always', 0),
    ], at, trap);
}

/**
 * The cell located (ECX, EDX, ESI pushed) given back under its heap's lock,
 * EBX the heap: its word cleared and it pushed onto its class's cache. A cell
 * already free, a cache already full, and a lock another thread holds are
 * the host's.
 *
 * @param {number} pop  What `ret` takes off.
 * @param {boolean} answer  Whether the caller is told TRUE.
 * @returns {Piece[]}
 */
function freeBody(pop, answer){
    const ret = pop === 0 ? [0xc3] : [0xc2, pop, 0];
    return [
        [0x8d, 0x54, 0x51, RECORD.SIZES],                    // lea edx, [ecx + edx*2 + sizes]
        [0xb8, ...dword(1)],                                 // mov eax, 1
        [0x87, 0x03],                                        // xchg [ebx], eax: the lock
        [0x85, 0xc0],                                        // test eax, eax
        { jump: JNZ, to: 'held' },
        [0x66, 0x83, 0x3a, 0x00],                            // cmp word [edx], 0
        { jump: JZ, to: 'unlock' },
        [0x0f, 0xb6, 0x41, RECORD.CLASS],                    // movzx eax, byte [ecx + class]
        [0xc1, 0xe0, CONTROL.CLASS_SHIFT],                   // shl eax, 10
        [0x8d, 0x44, 0x03, CONTROL.CLASSES],                 // lea eax, [ebx + eax + classes]
        [0x8b, 0x08],                                        // mov ecx, [eax]: the count
        [0x83, 0xf9, CACHE],                                 // cmp ecx, 127
        { jump: JAE, to: 'unlock' },
        [0x66, 0xc7, 0x02, 0x00, 0x00],                      // mov word [edx], 0
        [0x89, 0x74, 0xc8, CONTROL.ENTRIES],                 // mov [eax + ecx*8 + 8], esi
        [0x89, 0x54, 0xc8, CONTROL.ENTRIES + 4],             // mov [eax + ecx*8 + 12], edx
        [0x41],                                              // inc ecx
        [0x89, 0x08],                                        // mov [eax], ecx
        [0xc7, 0x03, ...dword(0)],                           // mov dword [ebx], 0: unlocked
        [0x5b],                                              // pop ebx
        [0x5e],                                              // pop esi
        'done',
        ...answer ? [[0xb8, ...dword(1)]] : [],              // mov eax, 1
        ret,
        'unlock',
        [0xc7, 0x03, ...dword(0)],                           // mov dword [ebx], 0
        'held',
        [0x5b],                                              // pop ebx
        'bad',
        [0x5e],                                              // pop esi
    ];
}

/**
 * BOOL HeapFree(HANDLE hHeap, DWORD dwFlags, LPVOID lpMem), as guest code: a
 * null pointer is TRUE, a cell of this heap is taken back, anything else is
 * the host's.
 *
 * @param {Placement} p @param {number} at @param {number} trap
 */
export function heapFreeCode(p, at, trap){
    return assembleTo([
        [0x8b, 0x44, 0x24, 0x0c],                            // mov eax, [esp + 12]
        [0x85, 0xc0],                                        // test eax, eax
        { jump: JZ, to: 'done' },
        ...locate(p),
        [0x53],                                              // push ebx
        [0x8b, 0x19],                                        // mov ebx, [ecx + heap]
        [0x3b, 0x5c, 0x24, 0x0c],                            // cmp ebx, [esp + 12]: the heap
        { jump: JNZ, to: 'held' },
        ...freeBody(12, true),
    ], at, trap);
}

/**
 * void free(void *block): a cell of any heap, as the host's free takes any
 * block.
 *
 * @param {Placement} p @param {number} at @param {number} trap
 */
export function freeCode(p, at, trap){
    return assembleTo([
        [0x8b, 0x44, 0x24, 0x04],                            // mov eax, [esp + 4]
        [0x85, 0xc0],                                        // test eax, eax
        { jump: JZ, to: 'done' },
        ...locate(p),
        [0x53],                                              // push ebx
        [0x8b, 0x19],                                        // mov ebx, [ecx + heap]
        ...freeBody(0, false),
    ], at, trap);
}

/**
 * The size of the live cell located, in EAX; a free one is the host's.
 *
 * @param {number} pop
 * @returns {Piece[]}
 */
function sizeBody(pop){
    return [
        [0x0f, 0xb7, 0x44, 0x51, RECORD.SIZES],              // movzx eax, word [ecx+edx*2+sizes]
        [0x85, 0xc0],                                        // test eax, eax
        { jump: JZ, to: 'bad' },
        [0x48],                                              // dec eax
        [0x5e],                                              // pop esi
        pop === 0 ? [0xc3] : [0xc2, pop, 0],
        'bad',
        [0x5e],                                              // pop esi
    ];
}

/**
 * SIZE_T HeapSize(HANDLE hHeap, DWORD dwFlags, LPCVOID lpMem), as guest code.
 *
 * @param {Placement} p @param {number} at @param {number} trap
 */
export function heapSizeCode(p, at, trap){
    return assembleTo([
        [0x8b, 0x44, 0x24, 0x0c],                            // mov eax, [esp + 12]
        ...locate(p),
        [0x8b, 0x01],                                        // mov eax, [ecx + heap]
        [0x3b, 0x44, 0x24, 0x08],                            // cmp eax, [esp + 8]: the heap
        { jump: JNZ, to: 'bad' },
        ...sizeBody(12),
    ], at, trap);
}

/**
 * size_t _msize(void *block): a cell of any heap.
 *
 * @param {Placement} p @param {number} at @param {number} trap
 */
export function msizeCode(p, at, trap){
    return assembleTo([
        [0x8b, 0x44, 0x24, 0x04],                            // mov eax, [esp + 4]
        ...locate(p),
        ...sizeBody(0),
    ], at, trap);
}

/**
 * A live cell located, resized in place to the size in EAX (at most its
 * cell): its word rewritten, and with `zeroFlag` the bytes it gains zeroed
 * when the flags word there has HEAP_ZERO_MEMORY. Answers the pointer.
 *
 * @param {number} pop
 * @param {number | null} zeroFlag  The flags word's offset from ESP once EBX
 *     and EDI are pushed too, or null for none.
 * @returns {Piece[]}
 */
function resizeBody(pop, zeroFlag){
    return [
        [0x3b, 0x41, RECORD.CELL],                           // cmp eax, [ecx + cell]
        { jump: JA, to: 'bad' },
        [0x53],                                              // push ebx
        [0x57],                                              // push edi
        [0x8d, 0x5c, 0x51, RECORD.SIZES],                    // lea ebx, [ecx + edx*2 + sizes]
        [0x0f, 0xb7, 0x13],                                  // movzx edx, word [ebx]
        [0x85, 0xd2],                                        // test edx, edx
        { jump: JZ, to: 'free' },
        [0x8d, 0x7a, 0xff],                                  // lea edi, [edx - 1]: the old size
        [0x8d, 0x48, 0x01],                                  // lea ecx, [eax + 1]: the new word
        [0x66, 0x89, 0x0b],                                  // mov [ebx], cx
        ...zeroFlag === null ? [] : [
            [0xf6, 0x44, 0x24, zeroFlag, 0x08],              // test byte [esp + flags], 8
            { jump: JZ, to: 'resized' },
            [0x39, 0xf8],                                    // cmp eax, edi
            { jump: JBE, to: 'resized' },
            [0x89, 0xc1],                                    // mov ecx, eax
            [0x29, 0xf9],                                    // sub ecx, edi: what it gained
            [0x01, 0xf7],                                    // add edi, esi: from the old end
            [0x31, 0xc0],                                    // xor eax, eax
            [0xf3, 0xaa],                                    // rep stosb
        ],
        'resized',
        [0x89, 0xf0],                                        // mov eax, esi
        [0x5f],                                              // pop edi
        [0x5b],                                              // pop ebx
        [0x5e],                                              // pop esi
        pop === 0 ? [0xc3] : [0xc2, pop, 0],
        'free',
        [0x5f],                                              // pop edi
        [0x5b],                                              // pop ebx
        'bad',
        [0x5e],                                              // pop esi
    ];
}

/**
 * LPVOID HeapReAlloc(HANDLE hHeap, DWORD dwFlags, LPVOID lpMem, SIZE_T dwBytes),
 * as guest code: a size that fits the block's cell is answered in place, with
 * or without HEAP_REALLOC_IN_PLACE_ONLY; one that does not moves, which is the
 * host's.
 *
 * @param {Placement} p @param {number} at @param {number} trap
 */
export function heapReAllocCode(p, at, trap){
    return assembleTo([
        [0xf7, 0x44, 0x24, 0x08, ...dword(~REALLOC_FLAGS)],  // test dword [esp + 8], ~flags
        { jump: JNZ, to: 'slow' },
        [0x8b, 0x44, 0x24, 0x0c],                            // mov eax, [esp + 12]
        ...locate(p),
        [0x8b, 0x01],                                        // mov eax, [ecx + heap]
        [0x3b, 0x44, 0x24, 0x08],                            // cmp eax, [esp + 8]: the heap
        { jump: JNZ, to: 'bad' },
        [0x8b, 0x44, 0x24, 0x14],                            // mov eax, [esp + 20]: the size
        ...resizeBody(16, 0x14),
    ], at, trap);
}

/**
 * void *realloc(void *block, size_t size): in place when the size fits the
 * block's cell; a null block, a size of zero and a move are the host's.
 *
 * @param {Placement} p @param {number} at @param {number} trap
 */
export function reallocCode(p, at, trap){
    return assembleTo([
        [0x8b, 0x44, 0x24, 0x04],                            // mov eax, [esp + 4]
        [0x85, 0xc0],                                        // test eax, eax
        { jump: JZ, to: 'slow' },
        [0x83, 0x7c, 0x24, 0x08, 0x00],                      // cmp dword [esp + 8], 0
        { jump: JZ, to: 'slow' },
        ...locate(p),
        [0x8b, 0x44, 0x24, 0x0c],                            // mov eax, [esp + 12]: the size
        ...resizeBody(0, null),
    ], at, trap);
}

/**
 * GlobalAlloc as guest code: the process heap's HeapAlloc, as on Windows NT,
 * with GMEM_ZEROINIT turned into HEAP_ZERO_MEMORY; a request for no bytes,
 * which the host answers with a block of one, is the host's. A main thread
 * that allocates and frees a few thousand times a second, on another
 * executor, waited each time for the process's executor to answer.
 *
 *     mov eax, [esp+8]            ; bytes
 *     test eax, eax
 *     jz slow
 *     mov ecx, [esp+4]
 *     and ecx, GMEM_ZEROINIT
 *     shr ecx, 3                  ; HEAP_ZERO_MEMORY
 *     push eax
 *     push ecx
 *     push heap
 *     call alloc                  ; the guest's HeapAlloc
 *     ret 8
 *   slow:
 *     jmp trap
 *
 * @param {number} at  where the code lands @param {number} trap  the host's GlobalAlloc
 * @param {number} heap  the process heap @param {number} alloc  the guest's HeapAlloc
 * @returns {Uint8Array}
 */
export function globalAllocCode(at, trap, heap, alloc){
    const slow = 33;
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x08,                              // 0: mov eax, [esp+8]
        0x85, 0xc0,                                          // 4: test eax, eax
        0x74, slow - 8,                                      // 6: jz slow
        0x8b, 0x4c, 0x24, 0x04,                              // 8: mov ecx, [esp+4]
        0x83, 0xe1, 0x40,                                    // 12: and ecx, GMEM_ZEROINIT
        0xc1, 0xe9, 0x03,                                    // 15: shr ecx, 3
        0x50,                                                // 18: push eax
        0x51,                                                // 19: push ecx
        0x68, ...dword(heap),                                // 20: push heap
        0xe8, ...dword(alloc - (at + 30)),                   // 25: call alloc
        0xc2, 0x08, 0x00,                                    // 30: ret 8
        0xe9, ...dword(trap - (at + slow + 5)),              // 33: jmp trap
    ]);
}

/**
 * GlobalFree as guest code: the process heap's HeapFree, answered NULL when it
 * took the block back; a block it does not -- another heap's, or not a block --
 * goes to the host's GlobalFree as the call was made, which frees any block
 * and answers a failure with the handle back.
 *
 *     mov eax, [esp+4]
 *     test eax, eax
 *     jz none                     ; NULL: NULL
 *     push eax
 *     push 0
 *     push heap
 *     call free                   ; the guest's HeapFree
 *     test eax, eax
 *     jz slow
 *   none:
 *     xor eax, eax
 *     ret 4
 *   slow:
 *     jmp trap
 *
 * @param {number} at  where the code lands @param {number} trap  the host's GlobalFree
 * @param {number} heap  the process heap @param {number} free  the guest's HeapFree
 * @returns {Uint8Array}
 */
export function globalFreeCode(at, trap, heap, free){
    const none = 25;
    const slow = 30;
    return new Uint8Array([
        0x8b, 0x44, 0x24, 0x04,                              // 0: mov eax, [esp+4]
        0x85, 0xc0,                                          // 4: test eax, eax
        0x74, none - 8,                                      // 6: jz none
        0x50,                                                // 8: push eax
        0x6a, 0x00,                                          // 9: push 0
        0x68, ...dword(heap),                                // 11: push heap
        0xe8, ...dword(free - (at + 21)),                    // 16: call free
        0x85, 0xc0,                                          // 21: test eax, eax
        0x74, slow - 25,                                     // 23: jz slow
        0x31, 0xc0,                                          // 25: xor eax, eax
        0xc2, 0x04, 0x00,                                    // 27: ret 4
        0xe9, ...dword(trap - (at + slow + 5)),              // 30: jmp trap
    ]);
}
