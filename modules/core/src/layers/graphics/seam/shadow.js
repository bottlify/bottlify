/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a device's guest routines read and write without crossing into the
 * host, and the host's side of it.
 *
 * A program of this era sets render states, transforms and textures hundreds
 * of times a frame, draws between them, and locks and unlocks a buffer around
 * every draw; every one was a crossing into the host -- a trap, a dispatch and
 * a return. So the setters and the draws are guest code (`commandCode`) that
 * writes the call into a command ring of the device's, and the host makes the
 * calls, in order, through the device's own methods, on its way into any
 * method of its own. The order is what a block of latest values cannot keep
 * and a draw that waits needs. Space in the ring is taken with `lock
 * cmpxchg`, and a record counts once its length, written last, is there, so
 * two threads may share one device's ring.
 *
 * The getters that run in the guest -- GetRenderState, and Direct3D 9's
 * GetTransform and GetTextureStageState -- answer from the device's block.
 * The command routines of their setters write the value there as they record
 * the call, and the host writes what it changes on its own -- at creation,
 * after a reset, after a state block is applied, after MultiplyTransform --
 * so that the block holds what the device holds.
 *
 * A buffer's storage is guest memory already, so a lock in the guest is an
 * address handed back and a range remembered, and an unlock is the buffer's
 * block appended to a ring in the device's block. The host replays each
 * remembered lock and unlock against the real buffer when it next looks,
 * before it makes the calls the command ring holds, so a draw there meets the
 * bytes the program wrote. A lock the guest holds across a crossing is
 * mirrored as a lock the host holds, so a second lock, through either path,
 * is refused the way the real interface refuses it; and while the ring holds
 * a draw, a lock that may overwrite what the draw reads is the host's, which
 * makes the draw first.
 *
 * A texture's level is one surface however often it is asked for, so its
 * pointer sits in the texture's own block and GetSurfaceLevel in the guest
 * reads it there. What such a call owes is a reference, and a reference
 * cannot be taken without the host -- so the guest counts them and the host
 * charges the count before any reference of that texture is read or given
 * back.
 *
 * Nothing is taken on the guest's word. A record the routines could not have
 * written is refused, a call the device refuses was answered D3D_OK in the
 * guest and is reported as a divergence, and while a state block records --
 * when every call has to reach the host as it is made -- the host raises a
 * flag every routine checks first, and leaves to the trap.
 */

import { D3DERR_INVALIDCALL, D3DFVF_RESERVED0, D3DFMT } from '../d3d8/constants.js';

/** The one depth format with a stencil the devices take a stencil clear on. */
const D3DFMT_D24S8 = D3DFMT.D24S8;
/** D3DUSAGE_RENDERTARGET. */
const D3DUSAGE_RENDERTARGET = 0x1;

/**
 * The block takes pages of its own. The routines that write it are guest
 * code the emulator compiles, and a write into a page that holds compiled
 * code makes the emulator discard everything compiled for that page -- so a
 * block laid right after the routines, out of the same heap, would have every
 * SetRenderState throw the routines away and run them interpreted after.
 */
const PAGE = 4096;
const PAGES = 2;

/** Byte offsets within the block. */
export const SHADOW = {
    /** Bit 0 set by the host: take the slow path. */
    FLAGS: 0,
    /**
     * The command ring (`commandCode`): where it is, how many bytes it
     * holds, and how many of them the guest has written -- zero where the
     * device has none, which sends every command to the host. The host
     * keeps how far it has read; the guest only ever adds to the head.
     */
    COMMANDS: 4,
    COMMAND_BYTES: 8,
    COMMAND_HEAD: 12,
    /**
     * Raised by a draw the ring holds, cleared by the host when it takes the
     * ring: while it is up, a lock in the guest that may overwrite what a
     * draw reads is the host's.
     */
    DRAWS_PENDING: 16,
    /** Buffer locks and unlocks taken in the guest, counted by the routines. */
    LOCK_CALLS: 20,
    UNLOCK_CALLS: 24,
    /** How many buffer blocks the ring holds: raised by an unlock, zeroed by the host. */
    RING_HEAD: 28,
    /** The buffers unlocked since the host last looked, as their block addresses. */
    RING: 32,
    RING_CAPACITY: 64,
    /** 256 dwords, one per D3DRENDERSTATETYPE below 256. */
    RENDER_STATES: 32 + 64 * 4,
    RENDER_STATE_COUNT: 256,
    /**
     * A bit per render state the device answers for, set by the host when it
     * mirrors: the getter answers those from the block and leaves the rest,
     * which the device refuses, to the host.
     */
    RENDER_STATE_VALID: 288 + 256 * 4,
    /** 28 matrices of 16 floats: types 0..23 as they are, then WORLD..WORLD3. */
    TRANSFORMS: 1312 + 256 / 8,
    TRANSFORM_SLOTS: 28,
    /** 8 stages of 32 dwords, one per D3DTEXTURESTAGESTATETYPE below 32. */
    STAGE_STATES: 1344 + 28 * 64,
    STAGE_COUNT: 8,
    STAGE_STATE_STRIDE: 32,
    /** The viewport, as D3DVIEWPORT8 and 9 both lay it out: six dwords. */
    VIEWPORT: 3136 + 8 * 32 * 4,
    /** 16 samplers of 16 dwords, one per D3DSAMPLERSTATETYPE below 16. */
    SAMPLER_STATES: 4160 + 6 * 4,
    SAMPLER_COUNT: 16,
    SAMPLER_STATE_STRIDE: 16,
    /**
     * What a draw needs of the device's state (`DRAW`), kept by the routines
     * that change it and written by the host after each of its own entries.
     */
    DRAWABLE: 5208,
    /** The render target's size, for a viewport that must lie within it. */
    TARGET_WIDTH: 5212,
    TARGET_HEIGHT: 5216,
    /** How many user clip planes the device has. */
    CLIP_PLANES: 5220,
    /**
     * Values the host has seen the device take where whether it takes one
     * is a matter of the value alone (`validated`): a vertex format, a
     * shader's handle. Two tables, one per kind of value; zero is an empty slot.
     */
    VALIDATED: 5224,
    VALIDATED_TABLES: 2,
    VALIDATED_SLOTS: 8,
    /**
     * The buffers the lock routine locked last, as their block addresses,
     * each at its count of locks modulo the capacity (a power of two): what
     * the host has to look at for a lock held across its entry.
     */
    LOCK_RING: 5224 + 2 * 8 * 4,
    LOCK_RING_CAPACITY: 16,
    /**
     * Zero while the device's TestCooperativeLevel answers D3D_OK, written
     * by the host after each of its entries: the guest's answers that, and a
     * lost device is the host's.
     */
    COOPERATIVE: 5288 + 16 * 4,
    /**
     * Set by the host when the device records for one that draws elsewhere,
     * or draws nothing: a copy between two of its render targets is then the
     * GPU's whatever it stretches, and the guest's StretchRect may answer it.
     */
    ELSEWHERE: 5352 + 4,
    /**
     * Vertex formats the device has drawn with and how wide a vertex of
     * each is, eight pairs, written by the host: what a draw by pointer with
     * its format as an argument (Direct3D 7's) copies is its vertices times
     * that width, and a format not here is the host's.
     */
    FVF_STRIDES: 5352 + 8,
    FVF_STRIDE_PAIRS: 8,
    /**
     * The state blocks a device of Direct3D 8 or 7 holds, by token, a bit
     * each below `STATE_BLOCK_TOKENS`, written by the host: what an Apply or a
     * Capture by token in the ring may name. And beside them, the blocks that
     * hold what a draw's checks read (`FLAG_DRAW_STALE`).
     */
    STATE_BLOCKS: 5424,
    STATE_BLOCK_DRAWS: 5424 + 32,
    STATE_BLOCK_TOKENS: 256,
    /**
     * The device's lock, as Direct3D's runtime takes its critical section
     * round every call of a device made multithreaded: a command routine and
     * Lock and Unlock in the guest take it with `xchg` (`HELD_GUEST`) and a
     * routine that finds it taken leaves for the host; the host takes it
     * (`HELD_HOST`) while it reads or writes the words the routines change.
     * With threads on several executors a routine otherwise ran beside the
     * host's reading of its words -- an unlock record or a locked range lost,
     * a flag or a mirror written over -- and two routines beside each other.
     * A routine lets it go before it leaves for the host, and before it
     * writes through a pointer of the program's.
     */
    HELD: 5424 + 64,
    /**
     * Direct3D 8's vertex shader -- a handle or a vertex format -- and pixel
     * shader, as GetVertexShader and GetPixelShader answer them: kept by the
     * setters' command routines and written by the host after each of its
     * entries, which sets `SHADERS_VALID` when the device says what they are.
     */
    SHADERS: 5424 + 68,
    SHADERS_VALID: 5424 + 76,
    SIZE: 5424 + 80,
};

/** Byte offsets within a query's block. */
export const QUERY = {
    /** Bit 0 set by the host: take the slow path. */
    FLAGS: 0,
    /** Its D3DQUERYTYPE. */
    TYPE: 4,
    /**
     * An occlusion query's count as the guest's GetData answers it, written
     * by the host: 0 the host's to ask for, 1 asked for and not back (the
     * guest answers S_FALSE), 2 back, in COUNT.
     */
    STATE: 8,
    COUNT: 12,
    /**
     * How many more polls the guest answers S_FALSE before one goes to the
     * host, which looks for the count as it did before (`POLLS_BETWEEN`).
     */
    BUDGET: 16,
    SIZE: 20,
};
/**
 * The polls of an occlusion count asked for that the guest answers between
 * two the host does: the host's look is what brings a count in where the
 * guest alone spun on S_FALSE -- the Gothic 3 demo stopped there.
 */
export const POLLS_BETWEEN = 128;

/**
 * A function `scripts/guest-code` compiled, as bytes placed at `at`: its
 * `return host()` goes to `trap`, the method's own.
 *
 * @param {{ code: Uint8Array, host?: number }} compiled @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function compiledAt(compiled, at, trap){
    const bytes = compiled.code.slice();
    if (compiled.host !== undefined)
    {
        // An address after `mov eax`, else a displacement from the end of the jump.
        new DataView(bytes.buffer).setUint32(compiled.host, bytes[compiled.host - 1] === 0xb8
            ? trap >>> 0 : (trap - (at + compiled.host + 4)) >>> 0, true);
    }
    return bytes;
}

/** Who holds `SHADOW.HELD`: a routine in the guest, or the host. */
export const HELD_GUEST = 1;
export const HELD_HOST = 2;

/** The bits of `SHADOW.DRAWABLE`. */
export const DRAW = Object.freeze({
    /** Between BeginScene and EndScene. */
    SCENE: 1,
    /** A vertex format or declaration a draw can read. */
    DECLARED: 2,
    /** Stream zero holds a buffer a draw can read from. */
    STREAM: 4,
    /** An index buffer is set. */
    INDEXED: 8,
    /** A depth surface is set. */
    DEPTH: 16,
    /** And it holds a stencil. */
    STENCIL: 32,
});

/** A command's head: the method's slot, and the record's length in bytes, its own included. */
export const COMMAND = { SLOT: 0, BYTES: 4, ARGS: 8 };

/** Byte offsets within a buffer's block, which the device's block points at through a ring. */
export const BUFFER = {
    /** Bit 0 set by the host: take the slow path. */
    FLAGS: 0,
    /** Where the buffer's bytes are, and how many. */
    BASE: 4,
    LENGTH: 8,
    /** Whether a lock is held, through either path. */
    LOCKED: 12,
    /** The range locked since the host last looked, as a union; empty when equal. */
    FROM: 16,
    TO: 20,
    /** The D3DLOCK flags of those locks, or-ed. */
    LOCK_FLAGS: 24,
    /** The device's block, for the counters and the ring. */
    DEVICE: 28,
    /**
     * Set by the host when what was unlocked may be lent to the graphics
     * worker (`remote/lending.js`) and read there later: a lock that may
     * write over it is the host's, which claims the bytes first.
     */
    LENT: 32,
    SIZE: 36,
};

/**
 * Byte offsets within a texture's block, which answers for its levels.
 *
 * A level's surface is one object however often it is asked for, so the
 * pointer a program is handed for it never changes -- and a program of this
 * era asks for one before every copy and every lock, hundreds of times a
 * frame, for a pointer it was already given. The table is filled by the host
 * the first time a level is asked for, because that is when the surface is
 * made and published; after that the answer is in the guest's own memory.
 */
export const TEXTURE = {
    /** Bit 0 set by the host: take the slow path. */
    FLAGS: 0,
    /** How many levels the texture has; a level past them is refused here. */
    LEVEL_COUNT: 4,
    /**
     * Where the texture's count is kept in the guest (`seam/com.js`,
     * `createCountCells`), which the routine takes the reference a level
     * owes in; zero sends every level to the host.
     */
    COUNT: 8,
    /** A pointer per level, zero for one the host has not published yet. */
    LEVELS: 12,
    LEVEL_SLOTS: 16,
    SIZE: 12 + 16 * 4,
};

/**
 * Byte offsets within a surface's block: its description, which nothing
 * changes while the surface lives, so GetDesc is answered from it.
 */
export const SURFACE = {
    /** Bit 0 set by the host: take the slow path. */
    FLAGS: 0,
    /** D3DSURFACE_DESC, as the version lays it out: eight words. */
    DESC: 4,
    DESC_WORDS: 8,
    /**
     * The texture it is a level or face of, as a number of the shadow's own,
     * zero for none: two levels of one texture are one texture to the GPU.
     */
    CONTAINER: 4 + 8 * 4,
    SIZE: 4 + 8 * 4 + 4,
};

/**
 * Byte offsets within a Direct3D 7 vertex buffer's block: a buffer's block
 * (`BUFFER`), which the guest's Lock and Unlock keep once a device's block
 * has taken it (`adoptBuffer`, its DEVICE word), and after it how many
 * vertices the buffer holds -- what a draw from it in the ring is refused for.
 */
export const VERTEX_BUFFER7 = {
    /** Whether a lock is held, through either path. */
    LOCKED: BUFFER.LOCKED,
    /** How many vertices it holds, which a draw's range may not pass. */
    VERTICES: BUFFER.SIZE,
    SIZE: BUFFER.SIZE + 4,
};

export const FLAG_SLOW_PATH = 1;
/**
 * Bit 1, set by a state block's Apply in the ring: what the block mirrors may
 * be what the device held before it, so the getters go to the host, which
 * plays the ring, mirrors what the applied blocks hold and clears the bit.
 * The setters and draws go on through the ring.
 */
export const FLAG_STALE = 2;
/**
 * Bit 2, set beside it by the Apply of a block holding what a draw's checks
 * read (`SHADOW.DRAWABLE`): a vertex format or declaration, a stream, the
 * indices. The draws wait for the host then; after any other block's they
 * go on through the ring, which the effects' blocks of render states,
 * textures, shaders and constants are.
 */
export const FLAG_DRAW_STALE = 4;

/**
 * The command ring's size, and how near its end the host starts it over:
 * more than the longest record a routine writes, so that a routine that
 * found no room is always followed by a start over.
 */
export const COMMAND_RING_BYTES = 64 * 1024;
/**
 * A Direct3D 8 or 9 device's: it holds a frame. A ring that fills sends its
 * next call to the host, a pause of the program that compares again every
 * dynamic buffer the draws read, and a frame of Call of Duty 4's first level
 * writes some 13 000 records.
 */
export const DEVICE_RING_BYTES = 1024 * 1024;

/**
 * How long the host waits for a routine to let the device's lock go before it
 * takes it anyway: a routine holds it for some instructions, and only one
 * whose thread faulted inside it -- through a pointer of the program's --
 * never lets it go.
 */
const HELD_WAIT_MS = 200;
const COMMAND_SLACK = 20 * 1024;

/**
 * Writes an empty command ring into a block: `ring` is pages of its own,
 * zeroed so that a length is only ever a finished record's.
 *
 * @param {number} block @param {number} ring
 * @param {(address: number, bytes: Uint8Array) => void} writeMemory
 * @param {number} [bytes]  its size
 */
export function placeCommandRing(block, ring, writeMemory, bytes = COMMAND_RING_BYTES){
    writeMemory(ring, new Uint8Array(bytes));
    const header = new Uint32Array([ring, bytes]);
    writeMemory(block + SHADOW.COMMANDS, new Uint8Array(header.buffer));
}

/**
 * The host's end of a command ring (`commandCode`): what the guest wrote into
 * it since the host last read it, handed to `take` in order -- every record
 * whose length is there, up to the first one a routine has taken the space
 * for and not yet finished. The head is the guest's; the host starts the ring
 * over -- zeroing what it read, so that a length is only ever a finished
 * record's -- once it has read everything up to a head near the end.
 *
 * @param {Object} deps
 * @param {number} deps.block @param {number} deps.ring
 * @param {(address: number) => number} deps.readWord
 * @param {(address: number, words: number) => Uint32Array} deps.readWords
 * @param {(address: number, bytes: Uint8Array) => void} deps.writeMemory
 * @param {(records: Uint8Array) => number} deps.take  makes the calls, says how many
 * @param {(detail: string) => void} deps.refuse
 * @param {number} [deps.bytes]  the ring's size, `COMMAND_RING_BYTES` unless given
 * @param {(address: number, expected: number, value: number) => number} [deps.compareExchangeU32]
 *     the memory's, indivisible against the guest's threads on other executors
 */
export function createCommandReader(deps){
    const { block, ring, readWord, readWords, writeMemory, take, refuse,
        bytes = COMMAND_RING_BYTES, compareExchangeU32 } = deps;
    let tail = 0;
    let taken = 0;
    const zero = new Uint8Array(4);
    return {
        /**
         * @param {() => void} [before]  run once the ring is found to hold calls,
         *     before they are made
         */
        take(before){
            if (readWord(block + SHADOW.DRAWS_PENDING) !== 0)
            {
                // Lowered before the head is read: a draw written after this
                // raises it again, and one before it is read now.
                writeMemory(block + SHADOW.DRAWS_PENDING, zero);
            }
            const head = readWord(block + SHADOW.COMMAND_HEAD);
            if (head === tail)
            {
                return;
            }
            if (head < tail || head > bytes)
            {
                refuse('the command ring\'s head went back');
                tail = head;
                return;
            }
            const words = readWords(ring + tail, (head - tail) >>> 2);
            let whole = 0;
            while (whole < words.length)
            {
                const length = words[whole + (COMMAND.BYTES >>> 2)] >>> 2;
                if (length === 0)
                {
                    break;
                }
                if (length < (COMMAND.ARGS >>> 2) || whole + length > words.length)
                {
                    refuse('a command record the routines could not have written');
                    whole = words.length;
                    break;
                }
                whole += length;
            }
            if (whole > 0)
            {
                before?.();
                taken += take(new Uint8Array(words.buffer, words.byteOffset, whole * 4));
            }
            tail += whole * 4;
            if (tail === head && head > bytes - COMMAND_SLACK)
            {
                // A routine between reading the head and taking its space finds
                // the head moved and takes it again, from the start. One on
                // another executor may have taken space since the head was read
                // here: the head goes back only from where it was read, as one
                // compare-and-swap, and otherwise the next take starts it over.
                writeMemory(ring, new Uint8Array(head));
                if (compareExchangeU32 === undefined)
                {
                    writeMemory(block + SHADOW.COMMAND_HEAD, zero);
                    tail = 0;
                }
                else if (compareExchangeU32(block + SHADOW.COMMAND_HEAD, head, 0) === head)
                {
                    tail = 0;
                }
            }
        },
        /** How many calls the ring has carried. */
        taken: ()=>taken,
        /**
         * How many finished records wait in the ring for the host's next
         * entry: a program that writes a ring's worth and ends without one
         * leaves them there.
         */
        queued(){
            const head = readWord(block + SHADOW.COMMAND_HEAD);
            if (head <= tail || head > bytes)
            {
                return 0;
            }
            const words = readWords(ring + tail, (head - tail) >>> 2);
            let records = 0;
            for (let at = 0; at < words.length;)
            {
                const length = words[at + (COMMAND.BYTES >>> 2)] >>> 2;
                if (length < (COMMAND.ARGS >>> 2))
                {
                    break;
                }
                records++;
                at += length;
            }
            return records;
        },
    };
}

/** What the host clears a word of the block with; never written to. */
const ZERO_WORD = new Uint8Array(4);

/** D3DUSAGE_DYNAMIC. */
const D3DUSAGE_DYNAMIC = 0x200;

/** A lock for reading has nothing to remember; the host takes it. */
const D3DLOCK_READONLY = 0x10;
/**
 * A lock that promises not to overwrite what a draw already made reads: the
 * one a buffer may take in the guest while the command ring holds a draw --
 * unless it discards as well, which promises nothing of the kind.
 */
const D3DLOCK_NOOVERWRITE = 0x1000;
const D3DLOCK_DISCARD = 0x2000;

/** D3DTS_WORLD is 256 and WORLD1..3 follow it; they take the slots after TEXTURE7. */
const WORLD_TYPE = 256;
const WORLD_SLOT = 24;

/** @param {number} type @returns {number} the slot, or -1 for a type the block does not hold */
export function transformSlot(type){
    if (type >= 0 && type < WORLD_SLOT)
    {
        return type;
    }
    if (type >= WORLD_TYPE && type < WORLD_TYPE + 4)
    {
        return WORLD_SLOT + (type - WORLD_TYPE);
    }
    return -1;
}

/** @param {number} slot */
export function transformType(slot){
    return slot < WORLD_SLOT ? slot : WORLD_TYPE + (slot - WORLD_SLOT);
}

/** @param {number} value @returns {number[]} */
const dword = value=>[
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
];

/**
 * Lays out a routine whose branches name their targets, so that no
 * displacement is counted by hand: a part is bytes, a label, or a branch
 * `{ jcc, to }` that becomes two bytes once every label has a position --
 * or five or six, `jmp`/`jcc rel32`, when it says `near`. A short branch
 * that cannot be reached with a byte is a mistake in the routine and is
 * refused rather than truncated.
 *
 * @param {(number[] | { label: string } | { jcc: number, to: string, near?: boolean })[]} parts
 * @returns {Uint8Array}
 */
function assemble(parts){
    /** @param {{ jcc: number, near?: boolean }} branch */
    const sizeOf = branch=>(!branch.near ? 2 : branch.jcc === 0xeb ? 5 : 6);
    /** @type {Map<string, number>} */
    const labels = new Map();
    let at = 0;
    for (const part of parts)
    {
        if (Array.isArray(part))
        {
            at += part.length;
        }
        else if ('label' in part)
        {
            labels.set(part.label, at);
        }
        else
        {
            at += sizeOf(part);
        }
    }
    /** @type {number[]} */
    const out = [];
    for (const part of parts)
    {
        if (Array.isArray(part))
        {
            out.push(...part);
        }
        else if ('jcc' in part)
        {
            const target = labels.get(part.to);
            if (target === undefined)
            {
                throw new Error(`shadow: no label ${part.to}`);
            }
            if (part.near)
            {
                const rel = target - (out.length + sizeOf(part));
                const opcode = part.jcc === 0xeb ? [0xe9] : [0x0f, part.jcc + 0x10];
                out.push(...opcode, ...dword(rel | 0));
                continue;
            }
            const rel = target - (out.length + 2);
            if (rel < -128 || rel > 127)
            {
                throw new Error(`shadow: branch to ${part.to} does not fit a byte`);
            }
            out.push(part.jcc, rel & 0xff);
        }
    }
    return new Uint8Array(out);
}

/** `jmp rel32` from `from` to `to`. @param {number} from @param {number} to */
const jump = (from, to)=>[0xe9, ...dword((to - (from + 5)) | 0)];

/**
 * What every routine starts with: the object's block into ECX, and the two
 * cases that are the host's whatever the call -- no block, or the host's flag.
 *
 *     mov ecx, [esp+4]            ; this
 *     mov ecx, [ecx+4]            ; the block
 *     test ecx, ecx
 *     jz slow                     ; no block: the host's
 *     test dword [ecx], 1         ; the host wants the slow path?
 *     jnz slow
 *
 * @param {string} [slow]  The label those two cases go to.
 * @returns {(number[] | { jcc: number, to: string })[]}
 */
const prologue = (slow = 'slow', flags = FLAG_SLOW_PATH)=>[
    [0x8b, 0x4c, 0x24, 0x04],                                // mov ecx, [esp+4]
    [0x8b, 0x49, 0x04],                                      // mov ecx, [ecx+4]
    [0x85, 0xc9],                                            // test ecx, ecx
    { jcc: 0x74, to: slow },                                 // jz slow
    [0xf7, 0x01, ...dword(flags)],                           // test dword [ecx], flags
    { jcc: 0x75, to: slow },                                 // jnz slow
];

/**
 * Takes the device's lock (`SHADOW.HELD`) with the device's block in `base`
 * (a ModR/M register number), or leaves for `busy` -- the host -- when it is
 * held: by the host, or a routine on another executor.
 *
 *     mov eax, HELD_GUEST
 *     xchg [base+HELD], eax
 *     test eax, eax
 *     jnz busy
 *
 * @param {number} base @param {string} busy
 * @returns {(number[] | { jcc: number, to: string, near?: boolean })[]}
 */
const takeHeld = (base, busy)=>[
    [0xb8, ...dword(HELD_GUEST)],                            // mov eax, HELD_GUEST
    [0x87, 0x80 | base, ...dword(SHADOW.HELD)],              // xchg [base+HELD], eax
    [0x85, 0xc0],                                            // test eax, eax
    { jcc: 0x75, to: busy, near: true },                     // jnz busy
];

/**
 * Lets the device's lock go, the device's block in `base`.
 *
 *     mov dword [base+HELD], 0
 *
 * @param {number} base
 */
const letHeldGo = base=>[0xc7, 0x80 | base, ...dword(SHADOW.HELD), ...dword(0)];

/** ModR/M register numbers. */
const ECX = 1;
const EDX = 2;
const EBX = 3;

/** A getter's prologue: a block the ring may have made stale is the host's too. */
const getterPrologue = ()=>prologue('slow', FLAG_SLOW_PATH | FLAG_STALE);

/**
 * The prologue of a function rather than a method: the block is the calling
 * thread's, in its TEB where Windows keeps the thread's current OpenGL
 * context (`GlContext`), written by the host when a context is made current.
 *
 *     mov ecx, fs:[TEB_GL_CONTEXT]
 *     test ecx, ecx
 *     jz slow                     ; no context current: the host's
 *     test dword [ecx], 1
 *     jnz slow
 *
 * @param {string} [slow]
 * @returns {(number[] | { jcc: number, to: string })[]}
 */
const threadPrologue = (slow = 'slow')=>[
    [0x64, 0x8b, 0x0d, ...dword(TEB_GL_CONTEXT)],            // mov ecx, fs:[disp]
    [0x85, 0xc9],                                            // test ecx, ecx
    { jcc: 0x74, to: slow },                                 // jz slow
    [0xf7, 0x01, ...dword(FLAG_SLOW_PATH)],                  // test dword [ecx], 1
    { jcc: 0x75, to: slow },                                 // jnz slow
];

/** Where a thread's block is in its TEB: the slot Windows keeps its GL context in. */
export const TEB_GL_CONTEXT = 0xbf0;

/**
 * A routine's bytes: its body, then the jump to the trap its slow label
 * lands on.
 *
 * @param {number} at @param {number} trap
 * @param {(number[] | { label: string } | { jcc: number, to: string, near?: boolean })[]} parts
 */
const routine = (at, trap, parts)=>{
    const body = assemble([...parts, { label: 'slow' }]);
    return new Uint8Array([...body, ...jump(at + body.length, trap)]);
};

/**
 * HRESULT GetRenderState(this, D3DRENDERSTATETYPE state, DWORD *value), as
 * guest code: the block holds what the device holds for every state the
 * device answers for, the guest's own writes included, so the answer is read
 * there. A state the device refuses, a null pointer and the host's flag go
 * to the host.
 *
 *     (prologue)
 *     mov eax, [esp+8]            ; state
 *     cmp eax, 256
 *     jae slow
 *     bt [ecx + RENDER_STATE_VALID], eax
 *     jnc slow                    ; a state the device refuses
 *     mov edx, [esp+12]           ; value
 *     test edx, edx
 *     jz slow
 *     mov eax, [ecx + eax*4 + RENDER_STATES]
 *     mov [edx], eax
 *     xor eax, eax                ; D3D_OK
 *     ret 12
 *   slow:
 *     jmp trap
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function getRenderStateCode(at, trap){
    return routine(at, trap, [
        ...getterPrologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.RENDER_STATE_COUNT)],             // cmp eax, 256
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0x0f, 0xa3, 0x81, ...dword(SHADOW.RENDER_STATE_VALID)], // bt [ecx+disp], eax
        { jcc: 0x73, to: 'slow' },                               // jnc slow
        [0x8b, 0x54, 0x24, 0x0c],                                // mov edx, [esp+12]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x84, 0x81, ...dword(SHADOW.RENDER_STATES)],      // mov eax, [ecx+eax*4+disp]
        [0x89, 0x02],                                            // mov [edx], eax
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 12, 0x00],                                        // ret 12
    ]);
}

/**
 * HRESULT Lock(this, UINT offset, UINT size, BYTE** out, DWORD flags), as
 * guest code for a vertex or index buffer. The address handed back is the
 * buffer's own storage; what is remembered is the range, as a union with
 * what was locked before the host last looked, and the flags.
 *
 * The cases left to the host: the device's lock held (`SHADOW.HELD`), a lock
 * of the buffer already held (the host refuses it), a lock for reading, an
 * empty or out-of-range lock, a null out-pointer -- and, while the device's
 * command ring holds a draw the host has not made, any lock but NOOVERWRITE
 * alone: the bytes that draw reads are the buffer's until then, and the host
 * makes it before it takes the lock. A DISCARD with it promises nothing about
 * those bytes, and the buffer has one storage. So too while what was unlocked
 * may be lent to the graphics worker: the host claims it before the program
 * writes over it. The device's lock is let go before the program's pointer is
 * written, which may fault.
 *
 *     mov edx, [ecx+DEVICE]
 *     (take the device's lock through EDX, or slow)
 *     cmp dword [ecx+LOCKED], 0
 *     jne held
 *     test dword [esp+20], READONLY
 *     jnz held
 *     cmp dword [edx+DRAWS_PENDING], 0
 *     jne guarded
 *     cmp dword [ecx+LENT], 0
 *     je free
 *   guarded:
 *     mov eax, [esp+20]
 *     and eax, NOOVERWRITE | DISCARD
 *     cmp eax, NOOVERWRITE
 *     jne held
 *   free:
 *     mov eax, [esp+8]            ; offset
 *     mov edx, [esp+12]           ; size
 *     test edx, edx
 *     jnz sized
 *     mov edx, [ecx+LENGTH]       ; zero: to the end
 *     sub edx, eax
 *   sized:
 *     test edx, edx
 *     jz held
 *     add edx, eax                ; end
 *     jc held
 *     cmp edx, [ecx+LENGTH]
 *     ja held
 *     cmp dword [esp+16], 0
 *     je held
 *     jmp take
 *   held:                         ; the host's, the device let go first
 *     mov eax, [ecx+DEVICE]
 *     mov dword [eax+HELD], 0
 *     jmp slow
 *   take:
 *     push ebx
 *     mov ebx, [ecx+TO]
 *     cmp ebx, [ecx+FROM]
 *     jne merge                   ; a range is pending: widen it
 *     mov [ecx+FROM], eax
 *     mov [ecx+TO], edx
 *     jmp merged
 *   merge:
 *     cmp eax, [ecx+FROM]
 *     jae keepFrom
 *     mov [ecx+FROM], eax
 *   keepFrom:
 *     cmp edx, ebx
 *     jbe merged
 *     mov [ecx+TO], edx
 *   merged:
 *     mov ebx, [esp+24]           ; flags, one word further for the push
 *     or [ecx+LOCK_FLAGS], ebx
 *     add eax, [ecx+BASE]
 *     mov dword [ecx+LOCKED], 1
 *     mov ebx, [ecx+DEVICE]
 *     mov edx, [ebx+LOCK_CALLS]   ; EAX is the address, for the out pointer
 *     and edx, LOCK_RING_CAPACITY - 1
 *     mov [ebx + edx*4 + LOCK_RING], ecx
 *     inc dword [ebx+LOCK_CALLS]
 *     mov dword [ebx+HELD], 0
 *     mov ebx, [esp+20]           ; out
 *     mov [ebx], eax
 *     pop ebx
 *     xor eax, eax
 *     ret 20
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function lockCode(at, trap){
    return routine(at, trap, [
        ...prologue('early'),
        { jcc: 0xeb, to: 'body' },                               // jmp body
        { label: 'early' },
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        { label: 'body' },
        [0x8b, 0x51, BUFFER.DEVICE],                             // mov edx, [ecx+28]
        ...takeHeld(EDX, 'slow'),
        [0x83, 0x79, BUFFER.LOCKED, 0x00],                       // cmp dword [ecx+12], 0
        { jcc: 0x75, to: 'held' },                               // jne held
        [0xf7, 0x44, 0x24, 0x14, ...dword(D3DLOCK_READONLY)],    // test dword [esp+20], 0x10
        { jcc: 0x75, to: 'held' },                               // jnz held
        [0x83, 0xba, ...dword(SHADOW.DRAWS_PENDING), 0x00],      // cmp dword [edx+disp], 0
        { jcc: 0x75, to: 'guarded' },                            // jne guarded
        [0x83, 0x79, BUFFER.LENT, 0x00],                         // cmp dword [ecx+32], 0
        { jcc: 0x74, to: 'free' },                               // je free
        { label: 'guarded' },
        [0x8b, 0x44, 0x24, 0x14],                                // mov eax, [esp+20]
        [0x25, ...dword(D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD)], // and eax, 0x3000
        [0x3d, ...dword(D3DLOCK_NOOVERWRITE)],                   // cmp eax, 0x1000
        { jcc: 0x75, to: 'held' },                               // jne held
        { label: 'free' },
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x8b, 0x54, 0x24, 0x0c],                                // mov edx, [esp+12]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x75, to: 'sized' },                              // jnz sized
        [0x8b, 0x51, BUFFER.LENGTH],                             // mov edx, [ecx+8]
        [0x29, 0xc2],                                            // sub edx, eax
        { label: 'sized' },
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'held' },                               // jz held
        [0x01, 0xc2],                                            // add edx, eax
        { jcc: 0x72, to: 'held' },                               // jc held
        [0x3b, 0x51, BUFFER.LENGTH],                             // cmp edx, [ecx+8]
        { jcc: 0x77, to: 'held' },                               // ja held
        [0x83, 0x7c, 0x24, 0x10, 0x00],                          // cmp dword [esp+16], 0
        { jcc: 0x74, to: 'held' },                               // je held
        { jcc: 0xeb, to: 'take' },                               // jmp take
        { label: 'held' },
        [0x8b, 0x41, BUFFER.DEVICE],                             // mov eax, [ecx+28]
        letHeldGo(0),                                            // mov dword [eax+HELD], 0
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        { label: 'take' },
        [0x53],                                                  // push ebx
        [0x8b, 0x59, BUFFER.TO],                                 // mov ebx, [ecx+20]
        [0x3b, 0x59, BUFFER.FROM],                               // cmp ebx, [ecx+16]
        { jcc: 0x75, to: 'merge' },                              // jne merge
        [0x89, 0x41, BUFFER.FROM],                               // mov [ecx+16], eax
        [0x89, 0x51, BUFFER.TO],                                 // mov [ecx+20], edx
        { jcc: 0xeb, to: 'merged' },                             // jmp merged
        { label: 'merge' },
        [0x3b, 0x41, BUFFER.FROM],                               // cmp eax, [ecx+16]
        { jcc: 0x73, to: 'keepFrom' },                           // jae keepFrom
        [0x89, 0x41, BUFFER.FROM],                               // mov [ecx+16], eax
        { label: 'keepFrom' },
        [0x39, 0xda],                                            // cmp edx, ebx
        { jcc: 0x76, to: 'merged' },                             // jbe merged
        [0x89, 0x51, BUFFER.TO],                                 // mov [ecx+20], edx
        { label: 'merged' },
        [0x8b, 0x5c, 0x24, 0x18],                                // mov ebx, [esp+24]
        [0x09, 0x59, BUFFER.LOCK_FLAGS],                         // or [ecx+24], ebx
        [0x03, 0x41, BUFFER.BASE],                               // add eax, [ecx+4]
        [0xc7, 0x41, BUFFER.LOCKED, ...dword(1)],                // mov dword [ecx+12], 1
        [0x8b, 0x59, BUFFER.DEVICE],                             // mov ebx, [ecx+28]
        [0x8b, 0x93, ...dword(SHADOW.LOCK_CALLS)],               // mov edx, [ebx+disp]
        [0x83, 0xe2, SHADOW.LOCK_RING_CAPACITY - 1],             // and edx, 15
        [0x89, 0x8c, 0x93, ...dword(SHADOW.LOCK_RING)],          // mov [ebx+edx*4+disp], ecx
        [0xff, 0x83, ...dword(SHADOW.LOCK_CALLS)],               // inc dword [ebx+disp]
        letHeldGo(EBX),                                          // mov dword [ebx+HELD], 0
        [0x8b, 0x5c, 0x24, 0x14],                                // mov ebx, [esp+20]
        [0x89, 0x03],                                            // mov [ebx], eax
        [0x5b],                                                  // pop ebx
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x14, 0x00],                                      // ret 20
    ]);
}

/**
 * HRESULT Lock(this, DWORD flags, void **out, DWORD *size), as guest code for
 * a Direct3D 7 vertex buffer: `lockCode`'s, of the whole buffer, as this
 * version locks one -- its storage handed back and its length written where
 * `size` points, if it points anywhere. A buffer no device's block has taken
 * yet (DEVICE zero) is the host's, and so is every case `lockCode` leaves it.
 * The DDLOCK flags it is given mean what D3DLOCK's do: READONLY,
 * NOOVERWRITE and DISCARDCONTENTS are the same bits.
 *
 *     mov edx, [ecx+DEVICE]
 *     test edx, edx
 *     jz slow
 *     (take the device's lock through EDX, or slow)
 *     cmp dword [ecx+LOCKED], 0
 *     jne held
 *     test dword [esp+8], READONLY
 *     jnz held
 *     cmp dword [edx+DRAWS_PENDING], 0
 *     jne guarded
 *     cmp dword [ecx+LENT], 0
 *     je free
 *   guarded:
 *     mov eax, [esp+8]
 *     and eax, NOOVERWRITE | DISCARD
 *     cmp eax, NOOVERWRITE
 *     jne held
 *   free:
 *     cmp dword [esp+12], 0
 *     jne take
 *   held:
 *     mov eax, [ecx+DEVICE]
 *     mov dword [eax+HELD], 0
 *     jmp slow
 *   take:
 *     push ebx
 *     mov dword [ecx+FROM], 0     ; the whole buffer, which no pending range passes
 *     mov eax, [ecx+LENGTH]
 *     mov [ecx+TO], eax
 *     mov ebx, [esp+12]           ; flags, one word further for the push
 *     or [ecx+LOCK_FLAGS], ebx
 *     mov dword [ecx+LOCKED], 1
 *     mov ebx, [ecx+DEVICE]
 *     mov edx, [ebx+LOCK_CALLS]
 *     and edx, LOCK_RING_CAPACITY - 1
 *     mov [ebx + edx*4 + LOCK_RING], ecx
 *     inc dword [ebx+LOCK_CALLS]
 *     mov dword [ebx+HELD], 0
 *     mov ebx, [esp+20]           ; size
 *     test ebx, ebx
 *     jz unsized
 *     mov [ebx], eax
 *   unsized:
 *     mov eax, [ecx+BASE]
 *     mov ebx, [esp+16]           ; out
 *     mov [ebx], eax
 *     pop ebx
 *     xor eax, eax
 *     ret 16                      ; the object and its three arguments
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function lock7Code(at, trap){
    return routine(at, trap, [
        ...prologue('early'),
        { jcc: 0xeb, to: 'body' },                               // jmp body
        { label: 'early' },
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        { label: 'body' },
        [0x8b, 0x51, BUFFER.DEVICE],                             // mov edx, [ecx+28]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow', near: true },                   // jz slow
        ...takeHeld(EDX, 'slow'),
        [0x83, 0x79, BUFFER.LOCKED, 0x00],                       // cmp dword [ecx+12], 0
        { jcc: 0x75, to: 'held' },                               // jne held
        [0xf7, 0x44, 0x24, 0x08, ...dword(D3DLOCK_READONLY)],    // test dword [esp+8], 0x10
        { jcc: 0x75, to: 'held' },                               // jnz held
        [0x83, 0xba, ...dword(SHADOW.DRAWS_PENDING), 0x00],      // cmp dword [edx+disp], 0
        { jcc: 0x75, to: 'guarded' },                            // jne guarded
        [0x83, 0x79, BUFFER.LENT, 0x00],                         // cmp dword [ecx+32], 0
        { jcc: 0x74, to: 'free' },                               // je free
        { label: 'guarded' },
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x25, ...dword(D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD)], // and eax, 0x3000
        [0x3d, ...dword(D3DLOCK_NOOVERWRITE)],                   // cmp eax, 0x1000
        { jcc: 0x75, to: 'held' },                               // jne held
        { label: 'free' },
        [0x83, 0x7c, 0x24, 0x0c, 0x00],                          // cmp dword [esp+12], 0
        { jcc: 0x75, to: 'take' },                               // jne take
        { label: 'held' },
        [0x8b, 0x41, BUFFER.DEVICE],                             // mov eax, [ecx+28]
        letHeldGo(0),                                            // mov dword [eax+HELD], 0
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        { label: 'take' },
        [0x53],                                                  // push ebx
        [0xc7, 0x41, BUFFER.FROM, ...dword(0)],                  // mov dword [ecx+16], 0
        [0x8b, 0x41, BUFFER.LENGTH],                             // mov eax, [ecx+8]
        [0x89, 0x41, BUFFER.TO],                                 // mov [ecx+20], eax
        [0x8b, 0x5c, 0x24, 0x0c],                                // mov ebx, [esp+12]
        [0x09, 0x59, BUFFER.LOCK_FLAGS],                         // or [ecx+24], ebx
        [0xc7, 0x41, BUFFER.LOCKED, ...dword(1)],                // mov dword [ecx+12], 1
        [0x8b, 0x59, BUFFER.DEVICE],                             // mov ebx, [ecx+28]
        [0x8b, 0x93, ...dword(SHADOW.LOCK_CALLS)],               // mov edx, [ebx+disp]
        [0x83, 0xe2, SHADOW.LOCK_RING_CAPACITY - 1],             // and edx, 15
        [0x89, 0x8c, 0x93, ...dword(SHADOW.LOCK_RING)],          // mov [ebx+edx*4+disp], ecx
        [0xff, 0x83, ...dword(SHADOW.LOCK_CALLS)],               // inc dword [ebx+disp]
        letHeldGo(EBX),                                          // mov dword [ebx+HELD], 0
        [0x8b, 0x5c, 0x24, 0x14],                                // mov ebx, [esp+20]
        [0x85, 0xdb],                                            // test ebx, ebx
        { jcc: 0x74, to: 'unsized' },                            // jz unsized
        [0x89, 0x03],                                            // mov [ebx], eax
        { label: 'unsized' },
        [0x8b, 0x41, BUFFER.BASE],                               // mov eax, [ecx+4]
        [0x8b, 0x5c, 0x24, 0x10],                                // mov ebx, [esp+16]
        [0x89, 0x03],                                            // mov [ebx], eax
        [0x5b],                                                  // pop ebx
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x10, 0x00],                                      // ret 16
    ]);
}

/**
 * HRESULT Unlock(this), as guest code. The buffer's block goes on the
 * device's ring for the host to find; the device's lock held, a full ring,
 * or no lock to release, is the host's.
 *
 *     mov edx, [ecx+DEVICE]
 *     (take the device's lock through EDX, or slow)
 *     cmp dword [ecx+LOCKED], 0
 *     je held
 *     mov eax, [edx+RING_HEAD]
 *     cmp eax, RING_CAPACITY
 *     jae held
 *     mov [edx + eax*4 + RING], ecx
 *     inc dword [edx+RING_HEAD]
 *     mov dword [ecx+LOCKED], 0
 *     inc dword [edx+UNLOCK_CALLS]
 *     mov dword [edx+HELD], 0
 *     xor eax, eax
 *     ret 4
 *   held:
 *     mov dword [edx+HELD], 0     ; and on to the host
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function unlockCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x51, BUFFER.DEVICE],                             // mov edx, [ecx+28]
        // A Direct3D 7 buffer no device's block has taken yet: the host's.
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        ...takeHeld(EDX, 'slow'),
        [0x83, 0x79, BUFFER.LOCKED, 0x00],                       // cmp dword [ecx+12], 0
        { jcc: 0x74, to: 'held' },                               // je held
        [0x8b, 0x82, ...dword(SHADOW.RING_HEAD)],                // mov eax, [edx+disp]
        [0x3d, ...dword(SHADOW.RING_CAPACITY)],                  // cmp eax, 64
        { jcc: 0x73, to: 'held' },                               // jae held
        [0x89, 0x8c, 0x82, ...dword(SHADOW.RING)],               // mov [edx+eax*4+disp], ecx
        [0xff, 0x82, ...dword(SHADOW.RING_HEAD)],                // inc dword [edx+disp]
        [0xc7, 0x41, BUFFER.LOCKED, ...dword(0)],                // mov dword [ecx+12], 0
        [0xff, 0x82, ...dword(SHADOW.UNLOCK_CALLS)],             // inc dword [edx+disp]
        letHeldGo(EDX),                                          // mov dword [edx+HELD], 0
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x04, 0x00],                                      // ret 4
        { label: 'held' },
        letHeldGo(EDX),                                          // mov dword [edx+HELD], 0
    ]);
}

/**
 * The tail a routine answers an argument out of range with: the refusal the
 * interface documents, without a crossing to fetch it.
 *
 *   invalid:
 *     mov eax, D3DERR_INVALIDCALL
 *     ret n
 *
 * @param {number} popped
 * @returns {(number[] | { label: string })[]}
 */
const invalidTail = popped=>[
    { label: 'invalid' },
    [0xb8, ...dword(D3DERR_INVALIDCALL)],                        // mov eax, D3DERR_INVALIDCALL
    [0xc2, popped, 0x00],                                        // ret n
];

/** The transform types below WORLD a device answers for: VIEW, PROJECTION, TEXTURE0..7. */
const ANSWERED_TRANSFORMS = (1 << 2 | 1 << 3 | 0xff << 16) >>> 0;
/** Direct3D 7's: WORLD, VIEW, PROJECTION, WORLD1..3 and TEXTURE0..7. */
const TRANSFORMS_7 = (0x7e | 0xff << 16) >>> 0;

/**
 * HRESULT GetTransform(this, D3DTRANSFORMSTATETYPE type, D3DMATRIX *), as
 * guest code: the matrix of every type the device answers for is in the
 * block, the guest's own writes included and the host's own changes mirrored
 * there, so it is copied out of the type's slot. A type the device refuses, a
 * null pointer and the host's flag go to the host.
 *
 *     (prologue)
 *     mov eax, [esp+8]            ; type
 *     cmp eax, 24
 *     jb low
 *     sub eax, 232                ; WORLD..WORLD3 -> 24..27
 *     cmp eax, 24
 *     jb slow
 *     cmp eax, 28
 *     jae slow
 *     jmp slot
 *   low:
 *     mov edx, ANSWERED_TRANSFORMS
 *     bt edx, eax
 *     jnc slow
 *   slot:
 *     mov edx, [esp+12]           ; the matrix
 *     test edx, edx
 *     jz slow
 *     push esi
 *     push edi
 *     mov edi, edx
 *     mov esi, eax
 *     shl esi, 6
 *     lea esi, [ecx + esi + TRANSFORMS]
 *     mov ecx, 16
 *     rep movsd
 *     pop edi
 *     pop esi
 *     xor eax, eax
 *     ret 12
 *   slow:
 *     jmp trap
 *
 * Direct3D 7's numbers are their own slots, all below 24 (`TRANSFORM_MIRROR_7`):
 * a type from 24 is the host's, and the types answered are that version's.
 *
 * @param {number} at @param {number} trap @param {boolean} [version7]
 * @returns {Uint8Array}
 */
export function getTransformCode(at, trap, version7 = false){
    return routine(at, trap, [
        ...getterPrologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(WORLD_SLOT)],                            // cmp eax, 24
        { jcc: 0x72, to: 'low' },                                // jb low
        ...(version7 ? [] : [
            [0x2d, ...dword(WORLD_TYPE - WORLD_SLOT)],           // sub eax, 232
            [0x3d, ...dword(WORLD_SLOT)],                        // cmp eax, 24
            { jcc: 0x72, to: 'slow' },                           // jb slow
            [0x3d, ...dword(SHADOW.TRANSFORM_SLOTS)],            // cmp eax, 28
            { jcc: 0x73, to: 'slow' },                           // jae slow
            { jcc: 0xeb, to: 'slot' },                           // jmp slot
        ]),
        ...(version7 ? [{ jcc: 0xeb, to: 'slow' }] : []),        // jmp slow
        { label: 'low' },
        [0xba, ...dword(version7 ? TRANSFORMS_7 : ANSWERED_TRANSFORMS)], // mov edx, imm32
        [0x0f, 0xa3, 0xc2],                                      // bt edx, eax
        { jcc: 0x73, to: 'slow' },                               // jnc slow
        { label: 'slot' },
        [0x8b, 0x54, 0x24, 0x0c],                                // mov edx, [esp+12]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x56],                                                  // push esi
        [0x57],                                                  // push edi
        [0x89, 0xd7],                                            // mov edi, edx
        [0x89, 0xc6],                                            // mov esi, eax
        [0xc1, 0xe6, 0x06],                                      // shl esi, 6
        [0x8d, 0xb4, 0x31, ...dword(SHADOW.TRANSFORMS)],         // lea esi, [ecx+esi+disp]
        [0xb9, ...dword(16)],                                    // mov ecx, 16
        [0xf3, 0xa5],                                            // rep movsd
        [0x5f],                                                  // pop edi
        [0x5e],                                                  // pop esi
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x0c, 0x00],                                      // ret 12
    ]);
}

/**
 * HRESULT GetTextureStageState(this, DWORD stage, D3DTEXTURESTAGESTATETYPE
 * type, DWORD *value), as guest code: a type the version has is kept in the
 * block, where the setter's command routine writes it (`stageStateMirror`)
 * and the host mirrors every change it makes itself, so the answer is read
 * there. A stage past the block, a type the version has not got, a null
 * pointer and the host's flag go to the host.
 *
 *     (prologue)
 *     mov eax, [esp+12]           ; type
 *     cmp eax, 32
 *     jae slow
 *     mov edx, types
 *     bt edx, eax
 *     jnc slow
 *     mov eax, [esp+8]            ; stage
 *     cmp eax, 8
 *     jae slow
 *     shl eax, 5
 *     add eax, [esp+12]
 *     mov edx, [esp+16]           ; value
 *     test edx, edx
 *     jz slow
 *     mov eax, [ecx + eax*4 + STAGE_STATES]
 *     mov [edx], eax
 *     xor eax, eax
 *     ret 16
 *   slow:
 *     jmp trap
 *
 * @param {number} at @param {number} trap
 * @param {number} types  The version's stage state types below 32, a bit each.
 * @returns {Uint8Array}
 */
export function getTextureStageStateCode(at, trap, types){
    return routine(at, trap, [
        ...getterPrologue(),
        [0x8b, 0x44, 0x24, 0x0c],                                // mov eax, [esp+12]
        [0x3d, ...dword(SHADOW.STAGE_STATE_STRIDE)],             // cmp eax, 32
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0xba, ...dword(types)],                                 // mov edx, imm32
        [0x0f, 0xa3, 0xc2],                                      // bt edx, eax
        { jcc: 0x73, to: 'slow' },                               // jnc slow
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.STAGE_COUNT)],                    // cmp eax, 8
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0xc1, 0xe0, 0x05],                                      // shl eax, 5
        [0x03, 0x44, 0x24, 0x0c],                                // add eax, [esp+12]
        [0x8b, 0x54, 0x24, 0x10],                                // mov edx, [esp+16]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x84, 0x81, ...dword(SHADOW.STAGE_STATES)],       // mov eax, [ecx+eax*4+disp]
        [0x89, 0x02],                                            // mov [edx], eax
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x10, 0x00],                                      // ret 16
    ]);
}

/**
 * HRESULT GetViewport(this, D3DVIEWPORT *out), as guest code: the block
 * holds the device's viewport, which SetViewport's routine keeps and the
 * host mirrors whenever it changes it itself (a render target, a reset, a
 * state block). A null pointer and the host's flag go to the host.
 *
 *     (prologue)
 *     mov edx, [esp+8]            ; out
 *     test edx, edx
 *     jz slow
 *     push esi
 *     push edi
 *     lea esi, [ecx + VIEWPORT]
 *     mov edi, edx
 *     mov ecx, 6
 *     rep movsd
 *     pop edi
 *     pop esi
 *     xor eax, eax                ; D3D_OK
 *     ret 8
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function getViewportCode(at, trap){
    return routine(at, trap, [
        ...getterPrologue(),
        [0x8b, 0x54, 0x24, 0x08],                                // mov edx, [esp+8]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x56, 0x57],                                            // push esi; push edi
        [0x8d, 0xb1, ...dword(SHADOW.VIEWPORT)],                 // lea esi, [ecx+disp]
        [0x89, 0xd7],                                            // mov edi, edx
        [0xb9, ...dword(6)],                                     // mov ecx, 6
        [0xf3, 0xa5],                                            // rep movsd
        [0x5f, 0x5e],                                            // pop edi; pop esi
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x08, 0x00],                                      // ret 8
    ]);
}

/**
 * Direct3D 8's SetVertexShader or SetPixelShader as its command routine keeps
 * it: the argument, as the getter answers it (`SHADOW.SHADERS`).
 *
 *     mov eax, [esp+8]
 *     mov [ecx + SHADERS + 4*which], eax
 *
 * @param {0 | 1} which  vertex, pixel
 */
export const shaderMirror = which=>Object.freeze([
    [0x8b, 0x44, 0x24, 0x08],                                    // mov eax, [esp+8]
    [0x89, 0x81, ...dword(SHADOW.SHADERS + 4 * which)],          // mov [ecx+disp], eax
]);

/**
 * HRESULT GetVertexShader(this, DWORD *handle) or GetPixelShader of Direct3D
 * 8, as guest code: the shader out of the device's block, once the host has
 * written it there. A null pointer goes to the host, which refuses it.
 *
 *     (prologue)
 *     cmp dword [ecx + SHADERS_VALID], 0
 *     je slow
 *     mov edx, [esp+8]            ; handle
 *     test edx, edx
 *     jz slow
 *     mov eax, [ecx + SHADERS + 4*which]
 *     mov [edx], eax
 *     xor eax, eax                ; D3D_OK
 *     ret 8
 *
 * @param {number} at @param {number} trap @param {0 | 1} which  vertex, pixel
 * @returns {Uint8Array}
 */
export function getShaderCode(at, trap, which){
    return routine(at, trap, [
        ...getterPrologue(),
        [0x83, 0xb9, ...dword(SHADOW.SHADERS_VALID), 0x00],      // cmp dword [ecx+disp], 0
        { jcc: 0x74, to: 'slow' },                               // je slow
        [0x8b, 0x54, 0x24, 0x08],                                // mov edx, [esp+8]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x81, ...dword(SHADOW.SHADERS + 4 * which)],      // mov eax, [ecx+disp]
        [0x89, 0x02],                                            // mov [edx], eax
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x08, 0x00],                                      // ret 8
    ]);
}

/**
 * HRESULT GetDesc(this, D3DSURFACE_DESC *out), as guest code for a surface:
 * the description out of the surface's block. A null pointer is the host's.
 *
 *     (prologue)
 *     mov edx, [esp+8]            ; out
 *     test edx, edx
 *     jz slow
 *     push esi
 *     push edi
 *     lea esi, [ecx + DESC]
 *     mov edi, edx
 *     mov ecx, 8
 *     rep movsd
 *     pop edi
 *     pop esi
 *     xor eax, eax                ; D3D_OK
 *     ret 8
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function getSurfaceDescCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x54, 0x24, 0x08],                                // mov edx, [esp+8]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x56, 0x57],                                            // push esi; push edi
        [0x8d, 0x71, SURFACE.DESC],                              // lea esi, [ecx+4]
        [0x89, 0xd7],                                            // mov edi, edx
        [0xb9, ...dword(SURFACE.DESC_WORDS)],                    // mov ecx, 8
        [0xf3, 0xa5],                                            // rep movsd
        [0x5f, 0x5e],                                            // pop edi; pop esi
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x08, 0x00],                                      // ret 8
    ]);
}

/** The sampler state types a device answers for: D3DSAMP_ADDRESSU (1) to DMAPOFFSET (13). */
const SAMPLER_STATE_TYPES = 0x3ffe;

/**
 * HRESULT GetSamplerState(this, DWORD sampler, D3DSAMPLERSTATETYPE type,
 * DWORD *value), as guest code: the value, for one of the sixteen pixel
 * samplers and a type the device answers for. A displacement or vertex
 * sampler, a type it refuses and a null pointer go to the host.
 *
 *     (prologue)
 *     mov eax, [esp+12]           ; type
 *     cmp eax, 16
 *     jae slow
 *     mov edx, SAMPLER_STATE_TYPES
 *     bt edx, eax
 *     jnc slow
 *     mov eax, [esp+8]            ; sampler
 *     cmp eax, 16
 *     jae slow
 *     shl eax, 4
 *     add eax, [esp+12]
 *     mov edx, [esp+16]           ; value
 *     test edx, edx
 *     jz slow
 *     mov eax, [ecx + eax*4 + SAMPLER_STATES]
 *     mov [edx], eax
 *     xor eax, eax
 *     ret 16
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function getSamplerStateCode(at, trap){
    return routine(at, trap, [
        ...getterPrologue(),
        [0x8b, 0x44, 0x24, 0x0c],                                // mov eax, [esp+12]
        [0x3d, ...dword(SHADOW.SAMPLER_STATE_STRIDE)],           // cmp eax, 16
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0xba, ...dword(SAMPLER_STATE_TYPES)],                   // mov edx, imm32
        [0x0f, 0xa3, 0xc2],                                      // bt edx, eax
        { jcc: 0x73, to: 'slow' },                               // jnc slow
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.SAMPLER_COUNT)],                  // cmp eax, 16
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0xc1, 0xe0, 0x04],                                      // shl eax, 4
        [0x03, 0x44, 0x24, 0x0c],                                // add eax, [esp+12]
        [0x8b, 0x54, 0x24, 0x10],                                // mov edx, [esp+16]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x84, 0x81, ...dword(SHADOW.SAMPLER_STATES)],     // mov eax, [ecx+eax*4+disp]
        [0x89, 0x02],                                            // mov [edx], eax
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x10, 0x00],                                      // ret 16
    ]);
}

/**
 * HRESULT GetSurfaceLevel(this, UINT level, IDirect3DSurface8** out), as
 * guest code for a texture. The pointer is the one the host published for
 * that level, out of the texture's own block; a level the texture has not
 * got is refused here, as the interface refuses it.
 *
 * The reference the call owes is taken in the word the texture's count is
 * kept in, which its levels share: the program holds the texture, so the
 * count is not at zero and taking one is no crossing of it. A level the host
 * has not published yet reads zero and goes to the host, which makes the
 * surface and fills the slot in.
 *
 *     mov ecx, [esp+4]            ; this
 *     mov ecx, [ecx+4]            ; the block
 *     test ecx, ecx
 *     jz slow
 *     test dword [ecx], 1
 *     jnz slow
 *     mov eax, [esp+8]            ; level
 *     cmp eax, [ecx+LEVEL_COUNT]
 *     jae invalid                 ; no such level
 *     cmp eax, LEVEL_SLOTS
 *     jae slow                    ; a level the table does not hold
 *     mov edx, [ecx + eax*4 + LEVELS]
 *     test edx, edx
 *     jz slow                     ; not published yet
 *     mov ecx, [ecx + COUNT]
 *     test ecx, ecx
 *     jz slow                     ; a count the host keeps
 *     mov eax, [esp+12]           ; out
 *     test eax, eax
 *     jz slow                     ; a null out-pointer is the host's to refuse
 *     mov [eax], edx
 *     lock inc dword [ecx]
 *     xor eax, eax                ; D3D_OK
 *     ret 12
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function getSurfaceLevelCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3b, 0x41, TEXTURE.LEVEL_COUNT],                       // cmp eax, [ecx+4]
        { jcc: 0x73, to: 'invalid' },                            // jae invalid
        [0x3d, ...dword(TEXTURE.LEVEL_SLOTS)],                   // cmp eax, 16
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0x8b, 0x94, 0x81, ...dword(TEXTURE.LEVELS)],            // mov edx, [ecx+eax*4+disp]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x49, TEXTURE.COUNT],                             // mov ecx, [ecx+8]
        [0x85, 0xc9],                                            // test ecx, ecx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x44, 0x24, 0x0c],                                // mov eax, [esp+12]
        [0x85, 0xc0],                                            // test eax, eax
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x89, 0x10],                                            // mov [eax], edx
        [0xf0, 0xff, 0x01],                                      // lock inc dword [ecx]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x0c, 0x00],                                      // ret 12
        ...invalidTail(12),
    ]);
}

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
            // test dword [eax + DESC + Usage], mask
            [0xf7, 0x80, ...dword(SURFACE.DESC + 8), ...dword(mask)],
            { jcc: 0x74, to: 'out', near: true },                // jz out
            { label: `usable${index}` });
    });
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
        nullable = false, fresh = false } = shape;
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
    if (self && (thread || pointer >= 0 || count || choose || vertices || shape.fvfVertices))
    {
        throw new Error('shadow: a record of the object itself copies nothing');
    }
    // What the routine pops: the record's arguments, the object's own pointer
    // among them when it is the first.
    const popped = self ? args - 1 : args;
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
            [0x8b, 0x44, 0x24, entry + 4 * pointer],             // mov eax, [esp+entry+4p]
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
        parts.push([0xba, ...dword(pointer >= 0 ? bytes : 0)]);  // mov edx, bytes
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
        ...(thread ? [] : [letHeldGo(ECX)]),                     // mov dword [ecx+HELD], 0
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
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
        if (arg === pointer && nullable)
        {
            parts.push(
                [0x8b, 0x44, 0x24, pushed + 4 * arg],            // mov eax, [esp+pushed+4p]
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
            [0x8b, 0x74, 0x24, pushed + 4 * pointer],            // mov esi, [esp+pushed+4p]
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
    parts.push([0x89, 0x77, COMMAND.BYTES]);                     // mov [edi+4], esi
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
        ...(thread ? [] : [letHeldGo(EBX)]),                     // mov dword [ebx+HELD], 0
        [0x5f, 0x5e, 0x5b],                                      // pop edi; pop esi; pop ebx
        { jcc: 0xeb, to: 'slow', near: true });                  // jmp slow
    return routine(at, trap, parts);
}

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
    [0x89, 0x94, 0x81, ...dword(SHADOW.RENDER_STATES)],          // mov [ecx+eax*4+disp], edx
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
 *
 * @param {number} at
 */
export const renderTargetMirror = at=>Object.freeze([
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
 * What Direct3D 9's StretchRect has to be for the guest to take it: no
 * rectangles, so each is its surface whole; two surfaces with blocks, not the
 * same one and not levels of one texture, both render targets in the default
 * pool; and a device that records for one drawing elsewhere (`ELSEWHERE`),
 * which copies or stretches between two such surfaces on the GPU, whatever
 * their sizes and formats. The filter is the routine's `within`.
 */
export const STRETCH_GUARD = Object.freeze([
    [0x83, 0x7c, 0x24, 0x0c, 0x00],                              // cmp dword [esp+12], 0
    { jcc: 0x75, to: 'out', near: true },                        // jne out: a source rectangle
    [0x83, 0x7c, 0x24, 0x14, 0x00],                              // cmp dword [esp+20], 0
    { jcc: 0x75, to: 'out', near: true },                        // jne out: a target rectangle
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

/** Where `STRETCH_GUARD` loads the target, and where it reads the source's texture. */
const STRETCH_TARGET = STRETCH_GUARD.findIndex(part=>Array.isArray(part) && part[0] === 0x8b
    && part[1] === 0x54);
const STRETCH_CONTAINER = STRETCH_GUARD.findIndex(part=>Array.isArray(part) && part[0] === 0x8b
    && part[1] === 0x40 && part[2] === SURFACE.CONTAINER);

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
    ...STRETCH_GUARD.slice(4, STRETCH_TARGET),                    // ELSEWHERE, the source
    [0x8b, 0x54, 0x24, 0x14],                                    // mov edx, [esp+20]: the target
    ...STRETCH_GUARD.slice(STRETCH_TARGET + 1, STRETCH_CONTAINER), // its block, pools, usages
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
 * it holds a stencil, which Clear's checks read. The surface is the argument
 * at `[esp+at]`.
 *
 * @param {number} at
 */
export const depthStencilMirror = at=>Object.freeze([
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
    [0x89, 0x94, 0x81, ...dword(SHADOW.SAMPLER_STATES)],         // mov [ecx+eax*4+disp], edx
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
    /** A draw from the program's memory leaves stream zero and the indices unset. */
    DrawPrimitiveUP: Object.freeze([unmarkDrawable(DRAW.STREAM | DRAW.INDEXED)]),
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
    [0x89, 0x94, 0x81, ...dword(SHADOW.STAGE_STATES)],           // mov [ecx+eax*4+disp], edx
];

/**
 * @typedef {Object} ShadowBuffer
 * @property {number} base        Where its bytes are in guest memory.
 * @property {number} length
 * @property {number} type        D3DRTYPE, which says which interface it is published as.
 * @property {number} refCount
 * @property {number} [usage]     D3DUSAGE, of which DYNAMIC says it may be held locked while drawn.
 * @property {() => number} release
 * @property {(offset: number, size: number, out: { pBits?: number }, flags?: number) => number
 *     } Lock
 * @property {() => number} Unlock
 */

/**
 * A call of the device's the host makes: what the guest did first, then the
 * call, then what the guest's routines check theirs against brought to the
 * device -- once the answer is there, for a call that answers late.
 *
 * @template T
 * @param {{ sync: () => void, settled: () => void } | null | undefined} shadow
 * @param {() => T} call
 * @returns {T}
 */
export function settledAfter(shadow, call){
    if (!shadow)
    {
        return call();
    }
    shadow.sync();
    const result = call();
    if (result instanceof Promise)
    {
        return /** @type {T} */ (/** @type {unknown} */ (result.then(value=>{
            shadow.settled();
            return value;
        })));
    }
    shadow.settled();
    return result;
}

/**
 * @typedef {Object} ShadowTexture
 * @property {number} levels
 *
 * @typedef {Object} ShadowDevice
 * @property {boolean} [lendsMemory]  a recording for the graphics worker that lends what is
 *     unlocked rather than copying it (`remote/replay.js`)
 * @property {(state: number, out: { value?: number }) => number} GetRenderState
 * @property {(type: number, out: { matrix?: ArrayLike<number> }) => number} GetTransform
 * @property {(stage: number, type: number, out: { value?: number }) => number
 *     } GetTextureStageState
 * @property {(out: { viewport?: any }) => number} [GetViewport]
 * @property {(sampler: number, type: number, out: { value?: number }) => number
 *     } [GetSamplerState]
 * @property {() => ShadowRingState} [ringState]
 *
 * @typedef {Object} ShadowRingState  What the command routines check a call against.
 * @property {number} drawable  the `DRAW` bits the device has
 * @property {number} targetWidth @property {number} targetHeight
 * @property {number} clipPlanes
 * @property {readonly number[]} taken  per table of `SHADOW.VALIDATED`, a value the
 *     device holds that it takes for its value alone, zero for none
 * @property {readonly ((value: number) => boolean)[]} [takes]  per table, whether it
 *     still takes one
 * @property {number} [cooperative]  zero while TestCooperativeLevel answers D3D_OK
 * @property {number} [elsewhere]  one when the device records for one drawing elsewhere,
 *     or draws nothing (`SHADOW.ELSEWHERE`)
 * @property {readonly [number, number][]} [strides]  vertex formats drawn with and their
 *     widths, the latest first (`SHADOW.FVF_STRIDES`)
 * @property {readonly [number, boolean][]} [stateBlocks]  the state blocks held by
 *     token, each with whether it holds what a draw's checks read
 *     (`SHADOW.STATE_BLOCKS`)
 * @property {readonly [number, number]} [shaders]  the vertex and pixel shader as
 *     Direct3D 8's getters answer them (`SHADOW.SHADERS`)
 */

/**
 * @typedef {Object} ShadowCommands
 * @property {(records: Uint8Array) => number} take  makes the calls a run of
 *     whole records holds, in order, and says how many it made
 */

/**
 * @typedef {Object} ShadowDeps
 * @property {(bytes: number) => number} allocate     Guest memory.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 *     May answer with the guest's own bytes rather than a copy; nothing here
 *     keeps what it returns past the call that read it.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => number} [readU32]
 *     A dword read in place, for the words looked at on every call: a view
 *     per call was a measured share of a frame.
 * @property {(address: number, expected: number, value: number) => number} [compareExchangeU32]
 *     A dword swapped only if it holds `expected`, indivisible against the
 *     guest's threads on the process's other executors; answers what it held.
 * @property {ShadowDevice} device
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {string} [name]  The device interface a refusal names.
 * @property {ShadowCommands} [commands]  The methods the device's command
 *     ring carries (`commandCode`), and how the host makes one: a device
 *     without them gets no ring.
 * @property {ShadowPhases} [phases]  Where `sync`'s time is accounted.
 * @property {number} [ringBytes]  The command ring's size, `DEVICE_RING_BYTES` unless
 *     given: a gate that fills it many times over gives a smaller one.
 * @property {(work: () => void) => void} [still]  Runs `work` as one pause of the
 *     program's, which does not run until it is done: what the device compares of
 *     guest memory in it is compared once, however many of its calls read it.
 */

/**
 * The phases `sync` opens, inside the host call it runs at the start of
 * (`bridge`'s `innerPhase`): `begin` answers 0 when the call is not one being
 * timed, and `end` takes what `begin` answered.
 *
 * @typedef {Object} ShadowPhases
 * @property {(name: string) => number} begin
 * @property {(name: string, weight: number) => void} end
 */

/**
 * The host's side of one device's block.
 *
 * @param {ShadowDeps} deps
 */
export function createShadow(deps){
    const ringBytes = deps.ringBytes ?? DEVICE_RING_BYTES;
    const { device } = deps;
    // Nothing timed in a production bundle, and no phase looked for.
    const phases = import.meta.BOTTLIFY_DIAGNOSTICS !== false ? deps.phases ?? null : null;
    const name = deps.name ?? 'IDirect3DDevice8';
    let address = 0;
    let refused = 0;
    let slow = false;
    /** The guest's lock and unlock counts, as the last entry that settled a buffer read them. */
    let lockCalls = 0;
    let unlockCalls = 0;
    /**
     * The buffers with a block, by block address, with whether the host
     * holds a lock on the buffer to mirror one the guest holds.
     *
     * @type {Map<number, { buffer: ShadowBuffer, hostLocked: boolean }>}
     */
    const blocks = new Map();
    /** @type {WeakMap<object, number>} */
    const blockOf = new WeakMap();
    /**
     * The blocks of buffers the guest has locked and unlocked itself: the ones
     * that can be held locked in the guest across a host entry.
     *
     * @type {Set<number>}
     */
    const lockedInGuest = new Set();
    /** Locks the host took and let go of in a block (`noteLocked`), beside the routines' counts. */
    let hostTaken = 0;
    let hostReleased = 0;
    /** The textures with a block. @type {WeakMap<object, { block: number }>} */
    const textureBlocks = new WeakMap();
    /** The surfaces with a block. @type {WeakMap<object, number>} */
    const surfaceBlocks = new WeakMap();
    /** @type {WeakMap<object, number>} */
    const queryBlocks = new WeakMap();
    /** The textures surfaces are levels of, numbered (`SURFACE.CONTAINER`). @type {WeakMap<object, number>} */
    const containerNumbers = new WeakMap();
    let containersNumbered = 0;
    /** Resource blocks are carved from pages of their own, for the same reason as the device's. */
    const pool = { at: 0, left: 0 };
    /** The command ring's bytes in guest memory, 0 for none, and how far the host has read it. */
    let commands = 0;
    /**
     * How deep the host is in holding the device's lock (`SHADOW.HELD`): it
     * is one thread, and its operations call one another.
     */
    let holds = 0;
    /** Whether the ring is being taken: a mirror written from inside does not take it again. */
    let taking = false;

    /**
     * A dword's bytes, in one array reused by every write: whoever is handed
     * it copies it at once, and an array made per state written was most of
     * what bringing the block back after a state block allocated.
     */
    const dwordScratch = new Uint8Array(4);
    const dwordScratchWords = new Uint32Array(dwordScratch.buffer);
    /** @param {number} value */
    const dwordBytes = value=>{
        dwordScratchWords[0] = value;
        return dwordScratch;
    };
    /** @param {number[]} values */
    const dwordsBytes = values=>new Uint8Array(values.flatMap(dword));
    /**
     * Guest bytes as words, in place when they are aligned for it and copied
     * when they are not.
     *
     * @param {Uint8Array} bytes
     */
    const wordsOf = bytes=>((bytes.byteOffset & 3) === 0
        ? new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2)
        : new Uint32Array(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    /** @param {number} at @param {number} words */
    const readWords = (at, words)=>wordsOf(deps.readMemory(at, words * 4));
    /** @param {number} at */
    const readWord = deps.readU32 ?? (at=>readWords(at, 1)[0]);
    /** @param {number} bytes @returns {number} a page-aligned span, or 0 */
    const allocatePage = bytes=>{
        // Two pages, so that a whole page is ours whichever boundary the
        // allocation straddles.
        const span = deps.allocate(bytes + PAGE);
        return span === 0 ? 0 : (span + PAGE - 1) & ~(PAGE - 1);
    };
    /** @param {number} bytes @returns {number} a span out of the resource pages, or 0 */
    const carve = bytes=>{
        if (pool.left < bytes)
        {
            pool.at = allocatePage(PAGE);
            pool.left = pool.at === 0 ? 0 : PAGE;
            if (pool.at === 0)
            {
                return 0;
            }
        }
        const block = pool.at;
        pool.at += bytes;
        pool.left -= bytes;
        return block;
    };
    /** @param {string} api @param {string} detail */
    const refuse = (api, detail)=>{
        refused++;
        deps.divergence?.(api, detail);
    };

    /**
     * The device's lock taken for the host, once, however deep its calls go:
     * with threads on other executors a routine of theirs may hold it, for
     * some instructions.
     */
    const hold = ()=>{
        if (holds++ !== 0 || address === 0 || deps.compareExchangeU32 === undefined)
        {
            return;
        }
        const at = address + SHADOW.HELD;
        const from = performance.now();
        while (deps.compareExchangeU32(at, 0, HELD_HOST) !== 0)
        {
            if (performance.now() - from > HELD_WAIT_MS)
            {
                deps.writeMemory(at, dwordBytes(HELD_HOST));
                refuse(`${name}::lock`, `a routine held the device past ${HELD_WAIT_MS} ms`
                    + ' -- a thread that faulted inside one: taken from it');
                break;
            }
        }
    };
    const letGo = ()=>{
        if (--holds !== 0 || address === 0 || deps.compareExchangeU32 === undefined)
        {
            return;
        }
        deps.writeMemory(address + SHADOW.HELD, dwordBytes(0));
    };
    /**
     * `work` with the device's lock held.
     *
     * @template T @param {() => T} work @returns {T}
     */
    const holding = work=>{
        hold();
        try
        {
            return work();
        }
        finally
        {
            letGo();
        }
    };

    // The host writes what the getters in the guest read: what the device
    // holds, so that the block agrees with the device before the guest reads
    // it, and again whenever the host changed state on its own.

    /** @param {number} state @returns {number | null} what the device holds, if it answers */
    const renderStateOf = state=>{
        /** @type {{ value?: number }} */
        const out = {};
        return device.GetRenderState(state, out) === 0 ? (out.value ?? 0) >>> 0 : null;
    };

    const mirrorRenderStates = ()=>{
        const states = new Uint8Array(SHADOW.RENDER_STATE_COUNT * 4);
        const view = new DataView(states.buffer);
        const valid = new Uint8Array(SHADOW.RENDER_STATE_COUNT / 8);
        for (let state = 0; state < SHADOW.RENDER_STATE_COUNT; state++)
        {
            const answered = renderStateOf(state);
            view.setUint32(state * 4, answered ?? 0, true);
            if (answered !== null)
            {
                valid[state >>> 3] |= 1 << (state & 7);
            }
        }
        deps.writeMemory(address + SHADOW.RENDER_STATES, states);
        deps.writeMemory(address + SHADOW.RENDER_STATE_VALID, valid);
    };

    const mirrorTransforms = ()=>{
        const matrices = new Uint8Array(SHADOW.TRANSFORM_SLOTS * 64);
        const floats = new Float32Array(matrices.buffer);
        for (let slot = 0; slot < SHADOW.TRANSFORM_SLOTS; slot++)
        {
            /** @type {{ matrix?: ArrayLike<number> }} */
            const out = {};
            if (device.GetTransform(transformType(slot), out) === 0 && out.matrix)
            {
                floats.set(out.matrix, slot * 16);
            }
        }
        deps.writeMemory(address + SHADOW.TRANSFORMS, matrices);
    };

    /** @param {number} stage @param {number} type */
    const stageStateOf = (stage, type)=>{
        /** @type {{ value?: number }} */
        const out = {};
        return device.GetTextureStageState(stage, type, out) === 0 ? (out.value ?? 0) >>> 0 : 0;
    };

    const mirrorStageStates = ()=>{
        const values = new Uint32Array(SHADOW.STAGE_COUNT * SHADOW.STAGE_STATE_STRIDE);
        for (let stage = 0; stage < SHADOW.STAGE_COUNT; stage++)
        {
            for (let type = 0; type < SHADOW.STAGE_STATE_STRIDE; type++)
            {
                values[stage * SHADOW.STAGE_STATE_STRIDE + type] = stageStateOf(stage, type);
            }
        }
        deps.writeMemory(address + SHADOW.STAGE_STATES, new Uint8Array(values.buffer));
    };

    /** @param {number} type */
    const refreshTransform = type=>{
        const slot = transformSlot(type);
        if (address === 0 || slot < 0)
        {
            return;
        }
        /** @type {{ matrix?: ArrayLike<number> }} */
        const out = {};
        if (device.GetTransform(type, out) !== 0 || !out.matrix)
        {
            return;
        }
        deps.writeMemory(address + SHADOW.TRANSFORMS + slot * 64,
            new Uint8Array(new Float32Array(out.matrix).buffer));
    };

    const mirrorViewport = ()=>{
        /** @type {{ viewport?: { X: number, Y: number, Width: number, Height: number,
         *     MinZ: number, MaxZ: number }, depthWords?: [number, number] }} */
        const out = {};
        if (typeof device.GetViewport !== 'function' || device.GetViewport(out) !== 0
            || !out.viewport)
        {
            return;
        }
        const { X, Y, Width, Height, MinZ, MaxZ } = out.viewport;
        const words = new Uint32Array([X, Y, Width, Height, 0, 0]);
        new Float32Array(words.buffer, 16, 2).set([MinZ, MaxZ]);
        // The words the program set, where the device kept them: a
        // signalling NaN through a number would come out quiet.
        if (out.depthWords)
        {
            words[4] = out.depthWords[0];
            words[5] = out.depthWords[1];
        }
        deps.writeMemory(address + SHADOW.VIEWPORT, new Uint8Array(words.buffer));
    };

    /** @param {number} sampler @param {number} type */
    const samplerStateOf = (sampler, type)=>{
        /** @type {{ value?: number }} */
        const out = {};
        return device.GetSamplerState?.(sampler, type, out) === 0 ? (out.value ?? 0) >>> 0 : 0;
    };

    const mirrorSamplerStates = ()=>{
        if (typeof device.GetSamplerState !== 'function')
        {
            return;
        }
        const values = new Uint32Array(SHADOW.SAMPLER_COUNT * SHADOW.SAMPLER_STATE_STRIDE);
        for (let sampler = 0; sampler < SHADOW.SAMPLER_COUNT; sampler++)
        {
            for (let type = 0; type < SHADOW.SAMPLER_STATE_STRIDE; type++)
            {
                values[sampler * SHADOW.SAMPLER_STATE_STRIDE + type] =
                    samplerStateOf(sampler, type);
            }
        }
        deps.writeMemory(address + SHADOW.SAMPLER_STATES, new Uint8Array(values.buffer));
    };

    /**
     * The values the host has seen the device take that the guest may take
     * on its own (`SHADOW.VALIDATED`), a list per table, newest last; the
     * oldest goes when there is no room.
     *
     * @type {number[][]}
     */
    const validated = Array.from({ length: SHADOW.VALIDATED_TABLES }, ()=>[]);

    /**
     * What the command routines check a call against (`commandChecks`):
     * whether a draw would be taken, the target's size, the clip planes,
     * and the values the device has taken that are taken for their value.
     */
    const mirrorCommandState = ()=>{
        const state = device.ringState?.();
        if (!state)
        {
            return;
        }
        const words = new Uint32Array((SHADOW.LOCK_RING - SHADOW.DRAWABLE) / 4);
        words[0] = state.drawable;
        words[1] = state.targetWidth;
        words[2] = state.targetHeight;
        words[3] = state.clipPlanes;
        validated.forEach((list, table)=>{
            const taken = state.taken[table] ?? 0;
            if (taken !== 0 && !list.includes(taken))
            {
                list.push(taken);
                if (list.length > SHADOW.VALIDATED_SLOTS)
                {
                    list.shift();
                }
            }
            // A value the device no longer takes -- a shader since deleted --
            // is not one to take again.
            const takes = state.takes?.[table];
            for (let index = list.length - 1; index >= 0; index--)
            {
                if (takes && !takes(list[index]))
                {
                    list.splice(index, 1);
                }
            }
            words.set(list, (SHADOW.VALIDATED - SHADOW.DRAWABLE) / 4
                + table * SHADOW.VALIDATED_SLOTS);
        });
        deps.writeMemory(address + SHADOW.DRAWABLE, new Uint8Array(words.buffer));
        deps.writeMemory(address + SHADOW.COOPERATIVE,
            dwordsBytes([state.cooperative ?? 1, state.elsewhere ?? 0]));
        if (state.strides)
        {
            const pairs = new Uint32Array(SHADOW.FVF_STRIDE_PAIRS * 2);
            state.strides.slice(0, SHADOW.FVF_STRIDE_PAIRS).forEach(([fvf, stride], index)=>{
                pairs[index * 2] = fvf;
                pairs[index * 2 + 1] = stride;
            });
            deps.writeMemory(address + SHADOW.FVF_STRIDES, new Uint8Array(pairs.buffer));
        }
        if (state.stateBlocks)
        {
            const bits = new Uint8Array(SHADOW.STATE_BLOCK_TOKENS / 4);
            for (const [token, draws] of state.stateBlocks)
            {
                if (token < SHADOW.STATE_BLOCK_TOKENS)
                {
                    bits[token >>> 3] |= 1 << (token & 7);
                    bits[SHADOW.STATE_BLOCK_TOKENS / 8 + (token >>> 3)] |= draws ? 1 << (token & 7)
                        : 0;
                }
            }
            deps.writeMemory(address + SHADOW.STATE_BLOCKS, bits);
        }
        if (state.shaders)
        {
            deps.writeMemory(address + SHADOW.SHADERS,
                dwordsBytes([state.shaders[0] >>> 0, state.shaders[1] >>> 0, 1]));
        }
    };

    const mirror = ()=>{
        mirrorRenderStates();
        mirrorTransforms();
        mirrorStageStates();
        mirrorViewport();
        mirrorSamplerStates();
        mirrorCommandState();
    };

    /**
     * What was just unlocked on the host may be lent to the graphics worker:
     * the guest's next lock that may write over it comes to the host.
     *
     * @param {number} block
     */
    const markLent = block=>{
        if (device.lendsMemory === true)
        {
            deps.writeMemory(block + BUFFER.LENT, dwordBytes(1));
        }
    };

    /**
     * Replays what the guest did to one buffer against the real one. The
     * block says whether a lock is held and what range was locked since the
     * host last looked; the host's own lock mirrors the guest's, so that the
     * real buffer refuses a second lock the way the guest's block does.
     *
     * @param {number} block
     */
    const settle = block=>{
        const entry = blocks.get(block);
        if (!entry)
        {
            return;
        }
        if (entry.buffer.refCount <= 0)
        {
            // Released by the program with an unlock still on the ring.
            blocks.delete(block);
            return;
        }
        const words = readWords(block, BUFFER.SIZE / 4);
        const locked = words[BUFFER.LOCKED / 4] !== 0;
        const from = words[BUFFER.FROM / 4];
        const to = words[BUFFER.TO / 4];
        if (to > from)
        {
            if (entry.hostLocked)
            {
                entry.buffer.Unlock();
                entry.hostLocked = false;
            }
            if (entry.buffer.Lock(from, to - from, {}, words[BUFFER.LOCK_FLAGS / 4]) === 0)
            {
                entry.hostLocked = true;
                if (locked)
                {
                    // Still being written in the guest -- another thread came
                    // in, or the program's own call between its lock and its
                    // unlock. What it unlocked before reaches the device now,
                    // for the draws in the ring that read it; what it is
                    // writing comes at its unlock, under a lock taken again
                    // that keeps what the buffer holds.
                    entry.buffer.Unlock();
                    entry.hostLocked = entry.buffer.Lock(from, to - from, {},
                        D3DLOCK_NOOVERWRITE) === 0;
                }
            }
            else
            {
                refuse('IDirect3DVertexBuffer8::Lock',
                    `a lock of ${from}..${to} taken in the guest was accepted;`
                    + ' the buffer refuses it');
            }
            deps.writeMemory(block + BUFFER.FROM, new Uint8Array(12));
            markLent(block);
        }
        if (entry.hostLocked && !locked)
        {
            entry.buffer.Unlock();
            entry.hostLocked = false;
        }
    };


    /**
     * What the guest has written into buffers it still holds locked reaches
     * the device before the ring's calls are made: a draw in the ring may
     * read it. A buffer is settled at its unlock, and a host entry while it
     * was still locked -- another call between two quads of one lock -- made
     * the ring's draws of it before what they read was there.
     * ponytail: dynamic buffers and those the guest has unlocked once are
     * looked at; any other held across an entry on its first lock is settled
     * at its unlock.
     */
    const settleHeld = ()=>{
        // Every lock taken and every one let go of is counted -- by the
        // routines that made it, or by `noteLocked` for the host's -- so the
        // difference is what is held. None, and the usual entry costs two
        // words instead of a look at every buffer the guest ever let go of.
        const locks = readWord(address + SHADOW.LOCK_CALLS);
        if (locks + hostTaken === readWord(address + SHADOW.UNLOCK_CALLS) + hostReleased)
        {
            heldLocks.clear();
            heldSince = locks;
            return;
        }
        // What may be held: what was at the last look, and what the routine
        // has locked since, which its ring names -- unless it has gone round.
        const taken = (locks - heldSince) >>> 0;
        if (taken > SHADOW.LOCK_RING_CAPACITY)
        {
            heldLocks.clear();
            for (const block of lockedInGuest)
            {
                heldLocks.add(block);
            }
        }
        else if (taken > 0)
        {
            const ring = readWords(address + SHADOW.LOCK_RING, SHADOW.LOCK_RING_CAPACITY);
            for (let n = heldSince; n !== locks; n = (n + 1) >>> 0)
            {
                heldLocks.add(ring[n & (SHADOW.LOCK_RING_CAPACITY - 1)]);
            }
        }
        heldSince = locks;
        for (const block of heldLocks)
        {
            if (!live(block) || !lockedInGuest.has(block))
            {
                lockedInGuest.delete(block);
                heldLocks.delete(block);
                continue;
            }
            if (!flushHeld(block))
            {
                heldLocks.delete(block);
            }
        }
    };
    /**
     * A block's entry while its buffer is the program's; one released --
     * which a dynamic buffer may be while it still counts as held -- is
     * forgotten here, so the host never locks it again: the played device has
     * let it go.
     *
     * @param {number} block
     */
    const live = block=>{
        const entry = blocks.get(block);
        if (entry && entry.buffer.refCount <= 0)
        {
            blocks.delete(block);
            lockedInGuest.delete(block);
            heldLocks.delete(block);
            return undefined;
        }
        return entry;
    };
    /** The blocks that may be held locked in the guest, as `settleHeld` last found them. */
    const heldLocks = new Set();
    /** The lock routine's count at that look. */
    let heldSince = 0;

    /**
     * What the guest has written so far into a buffer it holds locked, sent
     * through a lock and unlock on the host; the range stays in the block for
     * the unlock to send again with what is written after, less its DISCARD,
     * which this has done. The host keeps no lock of its own: a draw it made
     * of a locked buffer reads the locked range as guest memory holds it at
     * the draw, and a draw from the ring is made after the program wrote on.
     *
     * @param {number} block
     * @returns {boolean}  whether the guest holds it locked
     */
    const flushHeld = block=>{
        const entry = live(block);
        if (!entry || readWord(block + BUFFER.LOCKED) === 0)
        {
            return false;
        }
        if (entry.hostLocked)
        {
            return true;
        }
        const words = readWords(block, BUFFER.SIZE / 4);
        const from = words[BUFFER.FROM / 4];
        const to = words[BUFFER.TO / 4];
        const flags = words[BUFFER.LOCK_FLAGS / 4];
        if (words[BUFFER.LOCKED / 4] === 0 || to <= from)
        {
            return true;
        }
        if (entry.buffer.Lock(from, to - from, {}, flags) === 0)
        {
            entry.buffer.Unlock();
            markLent(block);
        }
        if ((flags & D3DLOCK_DISCARD) !== 0)
        {
            flagWord[0] = flags & ~D3DLOCK_DISCARD;
            deps.writeMemory(block + BUFFER.LOCK_FLAGS, flagBytes);
        }
        return true;
    };
    /** The flags word written back, without a buffer made for each. */
    const flagWord = new Uint32Array(1);
    const flagBytes = new Uint8Array(flagWord.buffer);

    /** The command ring's reader, once the block has one. @type {ReturnType<typeof createCommandReader> | null} */
    let commandReader = null;

    /**
     * Replays the locks and unlocks of buffers the guest let go of since the
     * host last looked, and empties the ring of them. The routines' two
     * counts lie just before the ring, so one read takes them with it.
     *
     * @param {number} heads  how many the ring holds
     */
    const settleUnlocked = heads=>{
        const count = Math.min(heads, SHADOW.RING_CAPACITY);
        const words = readWords(address + SHADOW.LOCK_CALLS, 3 + count).slice();
        if (words.length < 3 + count)
        {
            // No memory to read -- a machine that has stopped.
            return;
        }
        lockCalls = words[0];
        unlockCalls = words[1];
        for (const buffer of words.subarray(3))
        {
            lockedInGuest.add(buffer);
            settle(buffer);
        }
        deps.writeMemory(address + SHADOW.RING_HEAD, ZERO_WORD);
    };

    /**
     * `sync` with its parts as phases of their own, in a host call being
     * timed: the buffers let go of, and the ring's calls with the held
     * buffers settled before them.
     */
    const timedSync = ()=>{
        const held = /** @type {ShadowPhases} */ (phases);
        const unlocked = readWord(address + SHADOW.RING_HEAD);
        if (unlocked !== 0)
        {
            const weight = held.begin('ring-unlocked');
            try
            {
                settleUnlocked(unlocked);
            }
            finally
            {
                held.end('ring-unlocked', weight);
            }
        }
        if (commands !== 0 && commandReader !== null)
        {
            const weight = held.begin('ring-take');
            try
            {
                taking = true;
                commandReader.take(()=>{
                    const inner = held.begin('ring-held');
                    try
                    {
                        settleHeld();
                    }
                    finally
                    {
                        held.end('ring-held', inner);
                    }
                });
            }
            finally
            {
                taking = false;
                held.end('ring-take', weight);
            }
        }
    };

    /** `sync`'s work: the buffers the guest let go of, then the ring. */
    const syncNow = ()=>{
        // The work every host call starts with, outside the method it was
        // asked for: unaccounted, it was read as the call's own time, and
        // a share of the thread that a profile found only here.
        const weight = phases === null ? 0 : phases.begin('ring-sync');
        if (weight !== 0)
        {
            try
            {
                timedSync();
            }
            finally
            {
                /** @type {ShadowPhases} */ (phases).end('ring-sync', weight);
            }
            return;
        }
        const unlocked = readWord(address + SHADOW.RING_HEAD);
        if (unlocked !== 0)
        {
            settleUnlocked(unlocked);
        }
        if (commands !== 0)
        {
            // Held buffers only when the ring has calls that may read
            // them: settling at every entry read every held range again
            // at each of thousands of host calls a frame.
            taking = true;
            try
            {
                commandReader?.take(settleHeld);
            }
            finally
            {
                taking = false;
            }
        }
    };

    /**
     * `sync`'s work in one pause of the program's: a dynamic buffer compared
     * at its unlock is not compared again by the ring's draws from it.
     */
    const syncAll = ()=>{
        if (address === 0)
        {
            return;
        }
        if (deps.still)
        {
            deps.still(syncNow);
            return;
        }
        syncNow();
    };
    /**
     * Before the host writes a mirror from what the device holds: the calls
     * other threads' routines recorded meanwhile made first, so the mirror is
     * not put back behind them -- unless this is the ring being made.
     */
    const caughtUp = ()=>{
        if (!taking)
        {
            syncAll();
        }
    };

    /** The block, made and mirrored on first use. */
    const place = ()=>{
        if (address === 0)
        {
            address = allocatePage(PAGES * PAGE);
            if (address !== 0)
            {
                deps.writeMemory(address, new Uint8Array(SHADOW.SIZE));
                mirror();
                // Pages of its own, as the block's are: the routines write it
                // on every command.
                commands = deps.commands ? allocatePage(ringBytes) : 0;
                if (commands !== 0)
                {
                    placeCommandRing(address, commands, deps.writeMemory, ringBytes);
                    commandReader = createCommandReader({ block: address, ring: commands,
                        readWord, readWords, writeMemory: deps.writeMemory,
                        compareExchangeU32: deps.compareExchangeU32,
                        take: /** @type {ShadowCommands} */ (deps.commands).take,
                        refuse: detail=>refuse(`${name}::commands`, detail),
                        bytes: ringBytes });
                }
            }
        }
        return address;
    };


    /**
     * `noteLocked`'s work, the device's lock held.
     *
     * @param {number} block @param {{ hostLocked: boolean }} entry @param {boolean} locked
     */
    const noteLockedNow = (block, entry, locked)=>{
        entry.hostLocked = locked;
        // The routines count only the locks and unlocks they make; one
        // the host makes is counted here, so that what is held can be
        // told from the four numbers (`settleHeld`).
        const was = readWord(block + BUFFER.LOCKED) !== 0;
        if (was !== locked)
        {
            if (locked)
            {
                hostTaken++;
            }
            else
            {
                hostReleased++;
            }
        }
        deps.writeMemory(block + BUFFER.LOCKED, dwordBytes(locked ? 1 : 0));
        // Never cleared: a lock claims only its own range, and what was
        // lent elsewhere in the buffer may still be unread.
        // ponytail: a lending device's DISCARD and plain locks all come to the host; clear
        // it after a lock of the whole buffer if those traps show up in a profile.
        if (!locked)
        {
            markLent(block);
        }
    };

    /**
     * The block brought to what the device holds: the states named, or all
     * of it (`remirror`).
     *
     * @param {{ renderStates?: Iterable<number>, transforms?: Iterable<number>,
     *     stageStates?: true | Iterable<number>, viewport?: boolean,
     *     samplerStates?: Iterable<number> }} [touched]
     */
    const remirrorNow = touched=>{
        if (!touched)
        {
            mirror();
            return;
        }
        for (const state of touched.renderStates ?? [])
        {
            if (state >= 0 && state < SHADOW.RENDER_STATE_COUNT)
            {
                deps.writeMemory(address + SHADOW.RENDER_STATES + state * 4,
                    dwordBytes(renderStateOf(state) ?? 0));
            }
        }
        for (const type of touched.transforms ?? [])
        {
            refreshTransform(type);
        }
        if (touched.viewport)
        {
            mirrorViewport();
        }
        for (const key of touched.samplerStates ?? [])
        {
            const sampler = key >>> 8;
            const type = key & 0xff;
            if (sampler < SHADOW.SAMPLER_COUNT && type < SHADOW.SAMPLER_STATE_STRIDE)
            {
                deps.writeMemory(address + SHADOW.SAMPLER_STATES
                    + (sampler * SHADOW.SAMPLER_STATE_STRIDE + type) * 4,
                dwordBytes(samplerStateOf(sampler, type)));
            }
        }
        if (touched.stageStates === true)
        {
            mirrorStageStates();
            return;
        }
        for (const key of touched.stageStates ?? [])
        {
            const stage = key >>> 8;
            const type = key & 0xff;
            if (stage < SHADOW.STAGE_COUNT && type < SHADOW.STAGE_STATE_STRIDE)
            {
                const slot = stage * SHADOW.STAGE_STATE_STRIDE + type;
                deps.writeMemory(address + SHADOW.STAGE_STATES + slot * 4,
                    dwordBytes(stageStateOf(stage, type)));
            }
        }
    };

    return {
        address: place,

        /**
         * Whether the fast path is to stand aside. Raised while a state block
         * records, so every call reaches the host as it is made.
         *
         * @param {boolean} on
         */
        slowPath(on){
            slow = on;
            if (address !== 0)
            {
                holding(()=>{
                    const flags = readWord(address + SHADOW.FLAGS) & ~FLAG_SLOW_PATH;
                    deps.writeMemory(address + SHADOW.FLAGS,
                        dwordBytes(flags | (on ? FLAG_SLOW_PATH : 0)));
                });
            }
        },

        /**
         * Whether a state block applied in the ring may have left what the
         * block mirrors behind the device (`FLAG_STALE`).
         */
        stale: ()=>address !== 0 && (readWord(address + SHADOW.FLAGS) & FLAG_STALE) !== 0,

        /** What the block mirrors is the device's again. */
        fresh(){
            if (address !== 0)
            {
                holding(()=>deps.writeMemory(address + SHADOW.FLAGS,
                    dwordBytes(readWord(address + SHADOW.FLAGS) & ~(FLAG_STALE
                        | FLAG_DRAW_STALE))));
            }
        },

        /**
         * After the host changed state on its own -- a state block applied, a
         * reset -- the block is brought to what the device now holds: the
         * states named, or all of it. A small state block applied between
         * draws is common, and reading back every state the block holds cost
         * each Apply hundreds of calls into the device.
         *
         * @param {{ renderStates?: Iterable<number>, transforms?: Iterable<number>,
         *     stageStates?: true | Iterable<number>, viewport?: boolean,
         *     samplerStates?: Iterable<number> }} [touched]  stage states by
         *     (stage << 8) | type, or every one of them (true); sampler states
         *     by (sampler << 8) | type
         */
        remirror(touched){
            if (address !== 0)
            {
                holding(()=>{
                    caughtUp();
                    remirrorNow(touched);
                });
            }
        },

        /**
         * The same for a transform the host changed itself -- one multiplied
         * by MultiplyTransform, which works on what the device holds.
         *
         * @param {number} type
         */
        refreshTransform: type=>holding(()=>{
            caughtUp();
            refreshTransform(type);
        }),

        /**
         * After the host made a call of the device's itself: what the command
         * routines check a call against is the device's again.
         */
        settled(){
            if (address !== 0)
            {
                holding(()=>{
                    caughtUp();
                    mirrorCommandState();
                });
            }
        },

        /**
         * Makes what the guest did since the last entry reach the device: the
         * buffers it let go of first, then the calls in the command ring that
         * may read them.
         */
        sync(){
            if (address !== 0)
            {
                holding(syncAll);
            }
        },

        /**
         * A buffer's block, made on first use: where its bytes are, and the
         * device's block for the counters and the ring.
         *
         * @param {ShadowBuffer} buffer
         * @returns {number} the block, or 0 when there is no memory for one
         */
        attachBuffer(buffer){
            const existing = blockOf.get(buffer);
            if (existing !== undefined)
            {
                return existing;
            }
            const owner = place();
            if (owner === 0)
            {
                return 0;
            }
            const block = carve(BUFFER.SIZE);
            if (block === 0)
            {
                return 0;
            }
            deps.writeMemory(block,
                dwordsBytes([0, buffer.base, buffer.length, 0, 0, 0, 0, owner, 0]));
            blocks.set(block, { buffer, hostLocked: false });
            // A dynamic buffer is the kind a program holds locked while it
            // draws from it, from its very first lock.
            if (((buffer.usage ?? 0) & D3DUSAGE_DYNAMIC) !== 0)
            {
                lockedInGuest.add(block);
            }
            blockOf.set(buffer, block);
            return block;
        },

        /**
         * A Direct3D 7 vertex buffer's block, made beside its interface when
         * the buffer was (`VERTEX_BUFFER7`), taken by this device's block:
         * its storage and this block written into it, so the guest's Lock and
         * Unlock keep it from here on and the host replays what they did, as
         * `attachBuffer`'s. A buffer another device's block took stays that
         * one's.
         *
         * @param {ShadowBuffer} buffer @param {number} block
         * @returns {boolean} whether this device's block holds it
         */
        adoptBuffer(buffer, block){
            const existing = blockOf.get(buffer);
            if (existing !== undefined)
            {
                return existing === block;
            }
            const owner = place();
            if (owner === 0 || block === 0 || readWord(block + BUFFER.DEVICE) !== 0)
            {
                return false;
            }
            holding(()=>{
                deps.writeMemory(block + BUFFER.BASE, dwordsBytes([buffer.base, buffer.length]));
                deps.writeMemory(block + BUFFER.DEVICE, dwordBytes(owner));
            });
            blocks.set(block, { buffer, hostLocked: readWord(block + BUFFER.LOCKED) !== 0 });
            blockOf.set(buffer, block);
            return true;
        },

        /**
         * A texture's block, made on first use: how many levels it has, where
         * its count is kept, and a table of their pointers the host fills in
         * as it publishes them.
         *
         * @param {ShadowTexture} texture
         * @param {number} [count]  the word its count is kept in, 0 for none
         * @returns {number} the block, or 0 when there is no memory for one
         */
        attachTexture(texture, count = 0){
            const existing = textureBlocks.get(texture);
            if (existing)
            {
                return existing.block;
            }
            const block = carve(TEXTURE.SIZE);
            if (block === 0)
            {
                return 0;
            }
            const zeroed = new Uint8Array(TEXTURE.SIZE);
            zeroed.set(dwordBytes(texture.levels ?? 1), TEXTURE.LEVEL_COUNT);
            zeroed.set(dwordBytes(count), TEXTURE.COUNT);
            deps.writeMemory(block, zeroed);
            textureBlocks.set(texture, { block });
            return block;
        },

        /**
         * A surface's block, made on first use, with its description, which
         * `describe` writes at the address it is given.
         *
         * @param {object} surface @param {(at: number) => void} describe
         * @returns {number} the block, or 0 when there is no memory for one
         */
        attachSurface(surface, describe){
            const existing = surfaceBlocks.get(surface);
            if (existing !== undefined)
            {
                return existing;
            }
            const block = carve(SURFACE.SIZE);
            if (block === 0)
            {
                return 0;
            }
            deps.writeMemory(block, new Uint8Array(SURFACE.SIZE));
            describe(block + SURFACE.DESC);
            const container = /** @type {{ container?: object }} */ (surface).container;
            if (container)
            {
                let number = containerNumbers.get(container);
                if (number === undefined)
                {
                    number = ++containersNumbered;
                    containerNumbers.set(container, number);
                }
                deps.writeMemory(block + SURFACE.CONTAINER, dwordBytes(number));
            }
            surfaceBlocks.set(surface, block);
            return block;
        },

        /**
         * A query's block, made on first use: its type, for the guest's
         * methods of an event query.
         *
         * @param {{ type: number }} query
         * @returns {number} the block, or 0 when there is no memory for one
         */
        attachQuery(query){
            const existing = queryBlocks.get(query);
            if (existing !== undefined)
            {
                return existing;
            }
            const block = carve(QUERY.SIZE);
            if (block === 0)
            {
                return 0;
            }
            deps.writeMemory(block, dwordsBytes([0, query.type, 0, 0, 0]));
            queryBlocks.set(query, block);
            return block;
        },

        /**
         * The host published a level's surface: the guest may hand that
         * pointer out itself from now on.
         *
         * @param {ShadowTexture} texture @param {number} level @param {number} pointer
         */
        noteLevel(texture, level, pointer){
            const entry = textureBlocks.get(texture);
            if (!entry || level >= TEXTURE.LEVEL_SLOTS || pointer === 0)
            {
                return;
            }
            deps.writeMemory(entry.block + TEXTURE.LEVELS + level * 4, dwordBytes(pointer));
        },

        /**
         * Before the host locks or unlocks a buffer itself: what the guest
         * did to it is replayed first, so the host's call meets the state the
         * program left.
         *
         * @param {ShadowBuffer} buffer
         */
        settleBuffer(buffer){
            const block = blockOf.get(buffer);
            if (block !== undefined)
            {
                holding(()=>settle(block));
            }
        },

        /**
         * After the host locked or unlocked a buffer itself: the block says
         * so, and the guest routine refuses a second lock or a stray unlock
         * the way the host would.
         *
         * @param {ShadowBuffer} buffer @param {boolean} locked
         */
        noteLocked(buffer, locked){
            const block = blockOf.get(buffer);
            const entry = block === undefined ? undefined : blocks.get(block);
            if (block === undefined || !entry)
            {
                return;
            }
            holding(()=>noteLockedNow(block, entry, locked));
        },

        diagnostics: ()=>({
            // Numbers rather than booleans: a report keeps a flat structure of
            // numbers and drops anything else.
            placed: address !== 0 ? 1 : 0,
            slowPath: slow ? 1 : 0,
            // Buffer locks and unlocks that never crossed into the host, as of
            // the last entry that settled a buffer the guest let go of.
            lockCalls,
            unlockCalls,
            buffers: blocks.size,
            refused,
            // Calls the command ring carried past the bridge, and those it holds yet.
            commandCalls: commandReader?.taken() ?? 0,
            commandsQueued: commandReader?.queued() ?? 0,
        }),
    };
}

/**
 * Guest memory as `appendCommand` reads and writes it, over a reader and a
 * writer of bytes.
 *
 * @param {{ readMemory: (at: number, length: number) => Uint8Array,
 *     writeMemory: (at: number, bytes: Uint8Array) => void,
 *     readU32?: (at: number) => number, writeU32?: (at: number, value: number) => void,
 *     compareExchangeU32?: (at: number, expected: number, value: number) => number }} memory
 *     a word read and written in place where the memory layer offers it: a
 *     command's every word through a four-byte copy was most of its cost; the
 *     device's lock taken atomically where it offers that
 * @returns {GuestWords}
 */
export function guestWords(memory){
    const word = new Uint8Array(4);
    const view = new DataView(word.buffer);
    const { readU32, writeU32, compareExchangeU32: exchange } = memory;
    return {
        u32: readU32 ? at=>readU32(at >>> 0) >>> 0 : at=>{
            const bytes = memory.readMemory(at >>> 0, 4);
            return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
        },
        setU32: writeU32 ? (at, value)=>writeU32(at >>> 0, value >>> 0) : (at, value)=>{
            view.setUint32(0, value >>> 0, true);
            memory.writeMemory(at >>> 0, word);
        },
        read: (at, length)=>memory.readMemory(at >>> 0, length),
        write: (at, bytes)=>memory.writeMemory(at >>> 0, bytes),
        ...(exchange ? { compareExchangeU32: (at, expected, value)=>
            exchange(at >>> 0, expected >>> 0, value >>> 0) >>> 0 } : {}),
    };
}

/**
 * Guest memory as `appendCommand` reads and writes it.
 *
 * @typedef {Object} GuestWords
 * @property {(at: number) => number} u32
 * @property {(at: number, value: number) => void} setU32
 * @property {(at: number, length: number) => Uint8Array} read
 * @property {(at: number, bytes: Uint8Array) => void} write
 * @property {(at: number, expected: number, value: number) => number} [compareExchangeU32]
 *     the word's value before, swapped for `value` where it was `expected`: atomic, where
 *     other executors share the memory
 */

/**
 * A mirror as the host keeps it (`HOST_MIRRORS`): the x86 one's work on the
 * block, from the call's arguments (`this` not among them); false where the
 * x86 one goes to the host.
 *
 * @typedef {(memory: GuestWords, block: number, args: number[]) => boolean} HostMirror
 */

/**
 * Whether bit `index` of the bit string at `at` is set, as `bt` reads one.
 *
 * @param {GuestWords} m @param {number} at @param {number} index
 */
const bitAt = (m, at, index)=>((m.u32(at + 4 * (index >>> 5)) >>> (index & 31)) & 1) === 1;

/**
 * The DRAWABLE word changed: `clear` bits off, then `set` on.
 *
 * @param {GuestWords} m @param {number} block @param {number} clear @param {number} set
 */
const drawable = (m, block, clear, set)=>m.setU32(block + SHADOW.DRAWABLE,
    ((m.u32(block + SHADOW.DRAWABLE) & ~clear) | set) >>> 0);

/**
 * The mirrors of `RENDER_STATE_MIRROR` and its kin, in JavaScript: what the
 * host does in place of a command routine (`appendCommand`) keeps the block
 * as the routine would, which the gate holds them to, input by input.
 */
export const HOST_MIRRORS = Object.freeze({
    /** @type {HostMirror} */
    renderState: (m, block, [state, value])=>{
        if (state >= SHADOW.RENDER_STATE_COUNT
            || !bitAt(m, block + SHADOW.RENDER_STATE_VALID, state))
        {
            return false;
        }
        m.setU32(block + SHADOW.RENDER_STATES + 4 * state, value);
        return true;
    },
    /** @type {HostMirror} */
    transform: (m, block, [type, matrix])=>{
        let slot = type;
        if (type < WORLD_SLOT)
        {
            if (((ANSWERED_TRANSFORMS >>> type) & 1) === 0)
            {
                return false;
            }
        }
        else
        {
            slot = (type - (WORLD_TYPE - WORLD_SLOT)) >>> 0;
            if (slot < WORLD_SLOT || slot >= SHADOW.TRANSFORM_SLOTS)
            {
                return false;
            }
        }
        if (matrix === 0)
        {
            return false;
        }
        m.write(block + SHADOW.TRANSFORMS + slot * 64, m.read(matrix, 64).slice());
        return true;
    },
    /** @type {HostMirror} */
    viewport9: (m, block, [viewport])=>{
        if (viewport === 0 || (m.u32(viewport) | 0) < 0 || (m.u32(viewport + 4) | 0) < 0
            || m.u32(viewport + 8) === 0 || m.u32(viewport + 12) === 0)
        {
            return false;
        }
        m.write(block + SHADOW.VIEWPORT, m.read(viewport, 24).slice());
        return true;
    },
    /** @type {HostMirror} */
    renderTarget: (m, block, [, surface])=>{
        const desc = m.u32(surface + 4) + SURFACE.DESC;
        const width = m.u32(desc + 24);
        const height = m.u32(desc + 28);
        m.setU32(block + SHADOW.VIEWPORT + 8, width);
        m.setU32(block + SHADOW.TARGET_WIDTH, width);
        m.setU32(block + SHADOW.VIEWPORT + 12, height);
        m.setU32(block + SHADOW.TARGET_HEIGHT, height);
        m.setU32(block + SHADOW.VIEWPORT, 0);
        m.setU32(block + SHADOW.VIEWPORT + 4, 0);
        m.setU32(block + SHADOW.VIEWPORT + 16, 0);
        m.setU32(block + SHADOW.VIEWPORT + 20, 0x3f800000);
        return true;
    },
    /** @type {HostMirror} */
    stretch: (m, block, [source, sourceRect, target, targetRect])=>{
        if (sourceRect !== 0 || targetRect !== 0 || m.u32(block + SHADOW.ELSEWHERE) === 0
            || source === 0 || target === 0)
        {
            return false;
        }
        const from = m.u32(source + 4);
        const to = m.u32(target + 4);
        if (from === 0 || to === 0 || from === to
            || m.u32(from + SURFACE.DESC + 12) !== 0 || m.u32(to + SURFACE.DESC + 12) !== 0
            || (m.u32(from + SURFACE.DESC + 8) & D3DUSAGE_RENDERTARGET) === 0
            || (m.u32(to + SURFACE.DESC + 8) & D3DUSAGE_RENDERTARGET) === 0)
        {
            return false;
        }
        const container = m.u32(from + SURFACE.CONTAINER);
        return container === 0 || container !== m.u32(to + SURFACE.CONTAINER);
    },
    /** @type {HostMirror} */
    depthStencil: (m, block, [surface])=>{
        const depth = surface === 0 ? 0
            : DRAW.DEPTH | (m.u32(m.u32(surface + 4) + SURFACE.DESC) === D3DFMT_D24S8
                ? DRAW.STENCIL : 0);
        drawable(m, block, DRAW.DEPTH | DRAW.STENCIL, depth);
        return true;
    },
    /** Direct3D 8's CopyRects, as `COPY_GUARD_8` takes it. @type {HostMirror} */
    copy8: (m, block, [source, rects, , target])=>{
        if (rects !== 0 || !HOST_MIRRORS.stretch(m, block, [source, 0, target, 0]))
        {
            return false;
        }
        const from = m.u32(source + 4) + SURFACE.DESC;
        const to = m.u32(target + 4) + SURFACE.DESC;
        return [0, 24, 28].every(offset=>m.u32(from + offset) === m.u32(to + offset));
    },
    /** Direct3D 8's SetRenderTarget: the target, then its depth surface or none. @type {HostMirror} */
    renderTarget8: (m, block, [target, depth])=>HOST_MIRRORS.renderTarget(m, block, [0, target])
        && HOST_MIRRORS.depthStencil(m, block, [depth]),
    /** @type {HostMirror} */
    samplerState: (m, block, [sampler, type, value])=>{
        if (sampler >= SHADOW.SAMPLER_COUNT || type >= SHADOW.SAMPLER_STATE_STRIDE)
        {
            return false;
        }
        m.setU32(block + SHADOW.SAMPLER_STATES + 4 * ((sampler << 4) + type), value);
        return true;
    },
    /** @param {number} types @returns {HostMirror} */
    stageState: types=>(m, block, [stage, type, value])=>{
        if (type >= SHADOW.STAGE_STATE_STRIDE || ((types >>> type) & 1) === 0
            || stage >= SHADOW.STAGE_COUNT)
        {
            return false;
        }
        m.setU32(block + SHADOW.STAGE_STATES + 4 * ((stage << 5) + type), value);
        return true;
    },
    /** @type {HostMirror} */
    beginScene: (m, block)=>{
        drawable(m, block, 0, DRAW.SCENE);
        return true;
    },
    /** @type {HostMirror} */
    endScene: (m, block)=>{
        drawable(m, block, DRAW.SCENE, 0);
        return true;
    },
    /** @type {HostMirror} */
    fvf: (m, block, [fvf])=>{
        if (fvf !== 0)
        {
            drawable(m, block, DRAW.DECLARED, (fvf & 0x0e) !== 0 ? DRAW.DECLARED : 0);
        }
        return true;
    },
    /** @type {HostMirror} */
    declaration: (m, block, [declaration])=>{
        drawable(m, block, DRAW.DECLARED, declaration !== 0 ? DRAW.DECLARED : 0);
        return true;
    },
    /** @type {HostMirror} */
    streamSource9: (m, block, [stream, buffer, offset, stride])=>{
        if (stream === 0)
        {
            drawable(m, block, DRAW.STREAM, buffer !== 0 && stride !== 0
                && ((offset % stride) & 3) === 0 ? DRAW.STREAM : 0);
        }
        return true;
    },
    /** @type {HostMirror} */
    streamSource8: (m, block, [stream, buffer])=>{
        if (stream === 0)
        {
            drawable(m, block, DRAW.STREAM, buffer !== 0 ? DRAW.STREAM : 0);
        }
        return true;
    },
    /** @type {HostMirror} */
    indices: (m, block, [indices])=>{
        drawable(m, block, DRAW.INDEXED, indices !== 0 ? DRAW.INDEXED : 0);
        return true;
    },
});

/**
 * A command routine's work done by the host (`commandCode`): for a call the
 * host makes to a device's method from driven steps, the record the routine
 * would write is written into the ring, the block's mirrors kept as the
 * routine keeps them, and the call answered D3D_OK -- with no entry into the
 * guest, and nothing made before the ring is played, as the routine's call
 * is made. Undefined where the routine would go to the host: the slow path,
 * a check that fails, a full ring; the call then goes into the guest as it
 * came. A function or a state block's method (`thread`, `self`) is not one
 * this takes.
 *
 * @param {GuestWords} m @param {CommandShape} shape
 * @param {HostMirror | undefined} mirror  the routine's mirror, as the host keeps it
 * @param {number[]} call  the interface pointer, then the arguments
 * @returns {number | undefined}
 */
export function appendCommand(m, shape, mirror, call){
    const { fresh = false } = shape;
    if (shape.thread || shape.self)
    {
        return undefined;
    }
    // The arguments as unsigned words, `this` before them: read in place, not copied.
    /** @type {number[]} */
    const a = ARGUMENTS;
    for (let i = 1; i < call.length; i++)
    {
        a[i - 1] = call[i] >>> 0;
    }
    const block = m.u32(call[0] + 4);
    if (block === 0 || (m.u32(block) & (fresh ? FLAG_SLOW_PATH | FLAG_DRAW_STALE
        : FLAG_SLOW_PATH)) !== 0 || m.u32(block + SHADOW.COMMANDS) === 0)
    {
        return undefined;
    }
    // The device's lock, where the routine takes it (`takeHeld`): held -- by a
    // routine on another executor, or the host's own reading of the block --
    // the call goes into the guest as it came, and the routine goes to the host.
    const held = block + SHADOW.HELD;
    if ((m.compareExchangeU32 ? m.compareExchangeU32(held, 0, HELD_HOST) : m.u32(held)) !== 0)
    {
        return undefined;
    }
    m.setU32(held, HELD_HOST);
    try
    {
        return recordCommand(m, shape, mirror, block, a);
    }
    finally
    {
        m.setU32(held, 0);
    }
}

/**
 * `appendCommand`'s work past the device's lock: the routine's checks, its
 * mirror and its record.
 *
 * @param {GuestWords} m @param {CommandShape} shape
 * @param {HostMirror | undefined} mirror @param {number} block @param {number[]} a
 * @returns {number | undefined}
 */
function recordCommand(m, shape, mirror, block, a){
    const { slot, args, pointer = -1, bytes = 0, count, draws = false, stale = false,
        staleDraws = false } = shape;
    const able = m.u32(block + SHADOW.DRAWABLE);
    if ((shape.needs && (able & shape.needs) !== shape.needs)
        || (shape.refuses && (able & shape.refuses) !== 0))
    {
        return undefined;
    }
    for (const { arg, ranges } of shape.within ?? [])
    {
        if (!ranges.some(([low, high])=>((a[arg] - low) >>> 0) <= ((high - low) >>> 0)))
        {
            return undefined;
        }
    }
    const paired = shape.refusedWhen;
    if (paired && a[paired.arg] === paired.equals >>> 0 && (a[paired.flagsOf] & paired.mask) !== 0)
    {
        return undefined;
    }
    if (shape.span !== undefined && count)
    {
        const end = a[shape.span] + a[count.arg];
        if (end > 0xffffffff || end > count.most)
        {
            return undefined;
        }
    }
    if (shape.below && a[shape.below.arg] >= m.u32(block + shape.below.word))
    {
        return undefined;
    }
    const validated = shape.validated;
    if (validated && (a[validated.arg] & validated.when) !== 0)
    {
        const table = block + SHADOW.VALIDATED
            + (validated.table ?? 0) * SHADOW.VALIDATED_SLOTS * 4;
        let seen = false;
        for (let index = 0; index < SHADOW.VALIDATED_SLOTS && !seen; index++)
        {
            seen = m.u32(table + 4 * index) === a[validated.arg];
        }
        if (!seen)
        {
            return undefined;
        }
    }
    for (const [flag, bits] of shape.flagNeeds?.pairs ?? [])
    {
        if ((a[shape.flagNeeds?.arg ?? 0] & flag) !== 0 && (able & bits) !== bits)
        {
            return undefined;
        }
    }
    for (const usage of usagesOf(shape))
    {
        const surface = a[usage.arg];
        const owner = surface === 0 ? 0 : m.u32(surface + 4);
        if (surface === 0 ? !usage.nullable
            : owner === 0 || (m.u32(owner + SURFACE.DESC + 8) & usage.mask) === 0)
        {
            return undefined;
        }
    }
    const range = shape.vertexRange;
    if (shape.token !== undefined
        && !(a[shape.token] < SHADOW.STATE_BLOCK_TOKENS && tokenBit(m, block, a[shape.token])))
    {
        return undefined;
    }
    if (range)
    {
        const owner = a[range.buffer] === 0 ? 0 : m.u32(a[range.buffer] + 4);
        const end = a[range.start] + a[range.count];
        if (owner === 0 || m.u32(owner + VERTEX_BUFFER7.LOCKED) !== 0 || end > 0xffffffff
            || end > m.u32(owner + VERTEX_BUFFER7.VERTICES))
        {
            return undefined;
        }
    }
    const size = copiedBytes(shape, a, pointer, bytes);
    if (size === null || (mirror && !mirror(m, block, a)))
    {
        return undefined;
    }
    const header = COMMAND.ARGS + 4 * args;
    const length = count !== undefined && count.shift < 2 ? (size + header + 3) & ~3
        : size + header;
    const head = m.u32(block + SHADOW.COMMAND_HEAD);
    if (head + length > m.u32(block + SHADOW.COMMAND_BYTES))
    {
        return undefined;
    }
    m.setU32(block + SHADOW.COMMAND_HEAD, head + length);
    const record = (m.u32(block + SHADOW.COMMANDS) + head) >>> 0;
    m.setU32(record + COMMAND.SLOT, slot);
    for (let arg = 0; arg < args; arg++)
    {
        m.setU32(record + COMMAND.ARGS + 4 * arg, arg === pointer
            ? (a[arg] === 0 ? 0 : record + header) : a[arg]);
    }
    if (pointer >= 0 && size > 0)
    {
        m.write(record + header, m.read(a[pointer], size).slice());
    }
    m.setU32(record + COMMAND.BYTES, length);
    if (draws)
    {
        m.setU32(block + SHADOW.DRAWS_PENDING, 1);
    }
    if (stale)
    {
        const drawsToo = staleDraws || (shape.token !== undefined
            && tokenBit(m, block + SHADOW.STATE_BLOCK_DRAWS - SHADOW.STATE_BLOCKS, a[shape.token]));
        m.setU32(block, m.u32(block) | (drawsToo ? FLAG_STALE | FLAG_DRAW_STALE : FLAG_STALE));
    }
    return 0;
}

/**
 * A token's bit in the block's map of state blocks (`SHADOW.STATE_BLOCKS`).
 *
 * @param {GuestWords} m @param {number} block @param {number} token  below the tokens kept
 */
const tokenBit = (m, block, token)=>
    ((m.u32(block + SHADOW.STATE_BLOCKS + 4 * (token >>> 5)) >>> (token & 31)) & 1) === 1;

/** The arguments of the call `appendCommand` is writing, one array for every call. */
const ARGUMENTS = /** @type {number[]} */ (new Array(16).fill(0));

/**
 * How many bytes a command routine copies of what the call points at, as it
 * works it out; null where it goes to the host.
 *
 * @param {CommandShape} shape @param {number[]} a @param {number} pointer @param {number} bytes
 * @returns {number | null}
 */
function copiedBytes(shape, a, pointer, bytes){
    const { count, choose, vertices, nullable = false } = shape;
    if (pointer >= 0 && a[pointer] === 0)
    {
        if (!nullable)
        {
            return null;
        }
        return nullable === 'empty' && count && a[count.arg] !== 0 ? null : 0;
    }
    if (choose)
    {
        return choose.cases.find(([value])=>value === a[choose.arg])?.[1] ?? choose.otherwise;
    }
    if (vertices)
    {
        const n = a[vertices.count];
        if (n === 0 || n > vertices.most)
        {
            return null;
        }
        /** @type {Record<number, number>} */
        const spans = { 1: n, 2: n + n, 3: n + 1, 4: 3 * n, 5: n + 2, 6: n + 2 };
        const spanned = spans[a[vertices.type]];
        const stride = a[vertices.stride];
        if (spanned === undefined || (stride & 3) !== 0 || stride > vertices.most)
        {
            return null;
        }
        const total = Math.imul(spanned, stride) >>> 0;
        return total === 0 || total > vertices.most ? null : total;
    }
    if (count)
    {
        const n = a[count.arg];
        return n === 0 || n > count.most ? null : (n << count.shift) >>> 0;
    }
    return pointer >= 0 ? bytes : 0;
}
