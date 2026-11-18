/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The layout of the blocks a device's guest routines and the host share: the
 * device's (`SHADOW`), a buffer's, a texture's, a surface's, a level's and a
 * query's, word by word, and the flags and constants both sides read them
 * with. The routines are in `routines/`, the host's side in `shadow.js`.
 */

import { D3DFMT } from '../d3d8/constants.js';

/** The one depth format with a stencil the devices take a stencil clear on. */
export const D3DFMT_D24S8 = D3DFMT.D24S8;
/** D3DUSAGE_RENDERTARGET. */
export const D3DUSAGE_RENDERTARGET = 0x1;

/**
 * The block takes pages of its own. The routines that write it are guest
 * code the translator compiles, and a write near translated code drops what
 * the translator made of it -- so a block laid right after the routines, out
 * of the same heap, would have every SetRenderState throw the routines away
 * and run them interpreted after.
 */
export const PAGE = 4096;
export const PAGES = 2;

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
    /**
     * The render target and the depth surface as GetRenderTarget and
     * GetDepthStencilSurface answer them: each a pair of the pointer the
     * program was handed for it and the word its count is kept in. Written by
     * the host after each of its entries; a bit of `TARGETS_VALID` says which
     * pair is the device's -- a target set in the ring clears its own, and a
     * depth pair of zeros with its bit set is no depth surface.
     */
    TARGETS: 5424 + 80,
    TARGETS_VALID: 5424 + 96,
    /**
     * Why routines left for the host, counted by the routines as they leave:
     * the device's lock taken by the host or a routine on another executor;
     * the command ring with no room; a command whose arguments the routine
     * leaves to the host. Each a call that plays the ring on the process's
     * executor, which a counter of host calls cannot tell apart.
     */
    LEFT_HELD: 5424 + 100,
    LEFT_FULL: 5424 + 104,
    LEFT_CHECKS: 5424 + 108,
    /**
     * The bytes the guest's moves of a buffer copied from the storage left
     * into the new one (`moveCopyCode`), as two words, low then high.
     */
    MOVE_COPIED: 5424 + 112,
    SIZE: 5424 + 120,
};

/** Byte offsets within a query's block. */
export const QUERY = {
    /** Bit 0 set by the host: take the slow path. */
    FLAGS: 0,
    /** Its D3DQUERYTYPE. */
    TYPE: 4,
    /**
     * An occlusion query's count as the guest's GetData answers it: in its
     * low three bits (`COUNT_STATE`) 0 the host's to ask for, 1 asked for and
     * not back (the guest answers S_FALSE), 2 back, in COUNT, 3 the played
     * side writes it here and nothing has flushed its draws yet, 4 the same
     * flushed; above them the measurement's number, so a count the played
     * side writes late lands only on the measurement it was made for.
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
/** QUERY.STATE's states, its mask and where the measurement's number starts. */
export const COUNT_STATE = Object.freeze({ HOST: 0, ASKED: 1, BACK: 2, WRITTEN: 3, FLUSHED: 4,
    MASK: 7, SHIFT: 3 });

/**
 * An occlusion count into its query's block, as the side that draws writes it
 * into shared guest memory: the count, then the state from "the played side
 * writes it" (flushed or not) to "back" -- only while the block still waits on
 * the measurement the count was made for, so one that comes late never lands
 * on the next. The state moves by compare-exchange against the engine's
 * thread, which numbers each measurement as it issues it.
 *
 * @param {Int32Array} words  Guest memory.
 * @param {number} block @param {number} measurement @param {number} count
 * @returns {boolean} whether it landed
 */
export function storeCount(words, block, measurement, count){
    const state = (block + QUERY.STATE) >>> 2;
    const stamp = (measurement << COUNT_STATE.SHIFT) | 0;
    const now = Atomics.load(words, state);
    if (now !== (stamp | COUNT_STATE.WRITTEN) && now !== (stamp | COUNT_STATE.FLUSHED))
    {
        return false;
    }
    Atomics.store(words, (block + QUERY.COUNT) >>> 2, count | 0);
    return Atomics.compareExchange(words, state, now, stamp | COUNT_STATE.BACK) === now;
}

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
    /** The D3DLOCK flags of those locks, or-ed, and `LOCK_IN_PLACE`. */
    LOCK_FLAGS: 24,
    /** The device's block, for the counters and the ring. */
    DEVICE: 28,
    /**
     * Set by the host when what was unlocked may be lent to the graphics
     * worker (`remote/lending.js`) and read there later: a lock that may
     * write over it is the host's, which claims the bytes first.
     */
    LENT: 32,
    /**
     * Set by the routine that put the block on the device's ring, cleared by
     * the host that empties it: a buffer already there is not put there
     * again, since the host settles the union of its ranges once whatever
     * number of unlocks named it.
     */
    QUEUED: 36,
    /**
     * A dynamic buffer's other storages (`d3d8/storages.js`), zero for none,
     * and whether the guest may move the buffer onto each: set by the host
     * when it adds one, and again once the device has moved off it and
     * nothing it plays or lent reads it; cleared by the lock routine that
     * moves the buffer onto it for a DISCARD under draws the ring holds
     * (`lockCode`), which leaves the storage it moved off in its place.
     */
    SPARES: 40,
    SPARE_FREE: 48,
    SPARE_COUNT: 2,
    SIZE: 56,
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
    /**
     * The device's block, whose ring the texture's AddDirtyRect and
     * AddDirtyBox write into; zero sends them to the host.
     */
    DEVICE: 12 + 16 * 4,
    /** The top level's extent, which a dirty rectangle or box may not leave. */
    WIDTH: 80,
    HEIGHT: 84,
    DEPTH: 88,
    /** A level's block (`LEVEL`) per level, zero for one the guest does not lock. */
    LOCKS: 92,
    SIZE: 92 + 16 * 4,
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
    /** Its block as a level the guest locks (`LEVEL`), zero for none. */
    LEVEL: 4 + 8 * 4 + 4,
    /**
     * The block of the device that made it: a command routine binds only a
     * surface of its own device (Wine's test_render_target_device_mismatch).
     */
    OWNER: 4 + 8 * 4 + 8,
    SIZE: 4 + 8 * 4 + 12,
};

/**
 * Byte offsets within the block of a level the guest locks: a surface of a
 * texture, a volume of a volume texture, or a surface of its own. Its bytes
 * are guest memory at one address whatever is locked of them, so a lock is
 * an address worked out and a lock remembered, which the host replays on the
 * level at its next entry; the words the buffers' are where a buffer's block
 * has them.
 */
export const LEVEL = {
    /** Bit 0 set by the host: take the slow path. */
    FLAGS: 0,
    BASE: 4,
    /** Whether a lock is held, through either path. */
    LOCKED: BUFFER.LOCKED,
    /** A lock the guest took that the host has not replayed yet: the next is the host's. */
    TAKEN: 16,
    ROW_PITCH: 20,
    /** That lock's D3DLOCK flags. */
    LOCK_FLAGS: BUFFER.LOCK_FLAGS,
    DEVICE: BUFFER.DEVICE,
    SLICE_PITCH: 32,
    /** On the device's ring of blocks to settle (`SHADOW.RING`), until the host empties it. */
    QUEUED: BUFFER.QUEUED,
    WIDTH: 40,
    HEIGHT: 44,
    DEPTH: 48,
    TEXEL_BYTES: 52,
    /**
     * Set when a draw may read the level: a lock in the guest then waits for
     * the draws in the ring, as a buffer's does. One in system memory is
     * never drawn from.
     */
    SAMPLED: 56,
    /** Whether that lock named a box, and the box, as D3DBOX lays it out. */
    BOXED: 60,
    BOX: 64,
    SIZE: 64 + 6 * 4,
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
export const HELD_WAIT_MS = 200;
export const COMMAND_SLACK = 20 * 1024;

/** What the host clears a word of the block with; never written to. */
export const ZERO_WORD = new Uint8Array(4);

/** D3DUSAGE_DYNAMIC. */
export const D3DUSAGE_DYNAMIC = 0x200;

/** A lock for reading has nothing to remember; the host takes it. */
export const D3DLOCK_READONLY = 0x10;
/**
 * A lock that promises not to overwrite what a draw already made reads: the
 * one a buffer may take in the guest while the command ring holds a draw --
 * unless it discards as well, which promises nothing of the kind.
 */
export const D3DLOCK_NOOVERWRITE = 0x1000;
export const D3DLOCK_DISCARD = 0x2000;
/**
 * Or-ed into a buffer block's LOCK_FLAGS by the lock routine for a lock
 * without NOOVERWRITE (`lockCode`), and taken off by the host that
 * replays it: a DISCARD or a lock with neither flag, taken in the guest only
 * while the ring holds no draw, renames what draws read -- those made before
 * it from the old bytes, those after from the new -- so its replay comes
 * before the ring's next run, and the buffer may not move onto another
 * storage until then, which holds the replay back until after the run. Not a
 * D3DLOCK flag; the replay leaves it off.
 */
export const LOCK_IN_PLACE = 0x80000000;

/**
 * The flags the host replays a buffer block's locks with: what the routines
 * or-ed in since it last looked, less `LOCK_IN_PLACE`, and with a DISCARD
 * among them the DISCARD alone. One lock with both DISCARD and NOOVERWRITE
 * is a NOOVERWRITE (Wine's `wined3d_resource_sanitise_map_flags`), which
 * renames nothing; or-ed, the two are a DISCARD taken in place and the
 * NOOVERWRITE locks after it, and the replay has to rename as the DISCARD
 * did, or a ring started over is written into the copy the frames still
 * queued for the GPU draw from. A rename keeps what the copy held, so a
 * program's own lock with both flags loses nothing by it.
 *
 * @param {number} flags  a block's LOCK_FLAGS
 */
export const replayedFlags = flags=>((flags & D3DLOCK_DISCARD) !== 0
    ? flags & ~(LOCK_IN_PLACE | D3DLOCK_NOOVERWRITE) : flags & ~LOCK_IN_PLACE);

/** D3DTS_WORLD is 256 and WORLD1..3 follow it; they take the slots after TEXTURE7. */
export const WORLD_TYPE = 256;
export const WORLD_SLOT = 24;

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

