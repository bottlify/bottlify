/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Device state that a program sets without leaving the guest.
 *
 * A program of this era sets render states, transforms and stream bindings
 * hundreds of times a frame, and locks and unlocks a buffer around every
 * draw; every one was a crossing into the host -- a trap, a dispatch and a
 * return -- to store a dword, sixteen floats or a pointer. So the most
 * frequent setters are guest code that writes into a block of guest memory
 * the device owns, and the host reads the block on its way into any method
 * of its own.
 *
 * A buffer's storage is guest memory already, so a lock in the guest is an
 * address handed back and a range remembered, and an unlock is the buffer's
 * block appended to a ring in the device's block. The host replays each
 * remembered lock and unlock against the real buffer when it next looks, and
 * that is when the bytes reach the renderer -- before any draw, because a
 * draw is a crossing. A lock the guest holds across a crossing is mirrored as
 * a lock the host holds, so a second lock, through either path, is refused
 * the way the real interface refuses it.
 *
 * The block is one-way and untrusted. The guest writes it, and nothing the
 * host derives from state -- a pipeline, a shader, a binding -- is keyed on
 * the block directly. On every entry into the host what the guest wrote is
 * compared with the host's own copy, and each difference goes through the
 * same setter the trap would have called, which is where validation and
 * invalidation live. Nothing is taken on the guest's word: a mark or a count
 * the routines leave says only where to look, a mark on a word that did not
 * change costs a comparison, and a word written by other means than the
 * routines is not looked at until one of them marks it -- the device keeps
 * what it was last told, never anything unchecked. The host writes the block
 * only to mirror its own state into it -- at creation, after a state block
 * is applied, after a reset -- so that "unchanged" in the block means
 * "unchanged" on the device.
 *
 * Two things the fast path cannot do stay with the host. While a state block
 * is recording, the block must capture what the program set rather than what
 * changed, so the host raises a flag the fast path checks and falls back on.
 * And a value the device would refuse is refused by the host at the next
 * entry rather than at the call; the program was told success, and the
 * difference is reported as a divergence once.
 *
 * The block also counts the calls it absorbed, because the host no longer
 * sees them and a saving nobody can measure is a belief. It counts them per
 * group and once more in all, and an entry reads the one count first: an
 * entry after no setter reads one word. After some, the host looks at the
 * small groups whose count moved, whole, and at the three large ones --
 * 256 render states, 28 matrices, 256 stage states -- through marks: the
 * routine marks the word or matrix it wrote, a bit each, and the host
 * compares only what is marked. A burst of render states between two draws
 * costs the next draw the states that were set, not a scan of the 256.
 *
 * A getter answers from the block too, where what it answers cannot change:
 * a texture's level is one surface however often it is asked for, so the
 * pointer sits in the texture's own block and the guest reads it. What such a
 * call owes is a reference, and a reference cannot be taken without the host
 * -- so the guest counts them and the host charges the count before any
 * reference of that texture is read or given back.
 *
 * A pointer the guest wrote names an object only while the program holds
 * it. When the last reference goes the host marks every slot still naming
 * that pointer as stale -- in the block and in its copy -- so the device
 * keeps what it had bound, as the runtime does, and a later write of the
 * same pointer, which by then may name a new object, is seen as the change
 * it is.
 */

import { D3DERR_INVALIDCALL, D3DTSS } from '../d3d8/constants.js';

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
    /** Fast-path SetRenderState calls, counted by the guest. */
    RENDER_STATE_CALLS: 4,
    /** Fast-path SetTransform calls, counted by the guest. */
    TRANSFORM_CALLS: 8,
    /**
     * Every call the routines take, counted once more: the one word an entry
     * reads when nothing was set.
     */
    CALLS: 12,
    /** 256 dwords, one per D3DRENDERSTATETYPE below 256. */
    RENDER_STATES: 16,
    RENDER_STATE_COUNT: 256,
    /** 28 matrices of 16 floats: types 0..23 as they are, then WORLD..WORLD3. */
    TRANSFORMS: 16 + 256 * 4,
    TRANSFORM_SLOTS: 28,
    /** Fast-path SetStreamSource, SetIndices and SetVertexShader calls. */
    BINDING_CALLS: 2832,
    /** Fast-path buffer locks and unlocks. */
    LOCK_CALLS: 2836,
    UNLOCK_CALLS: 2840,
    /** How many buffer blocks the ring holds: raised by an unlock, zeroed by the host. */
    RING_HEAD: 2844,
    /** 16 streams of { buffer pointer, stride }. */
    STREAMS: 2848,
    STREAM_COUNT: 16,
    INDICES: 2976,
    BASE_VERTEX: 2980,
    VERTEX_SHADER: 2984,
    /** The buffers unlocked since the host last looked, as their block addresses. */
    RING: 2988,
    RING_CAPACITY: 64,
    /** Fast-path SetTexture, SetTextureStageState and SetMaterial calls. */
    TEXTURE_CALLS: 3244,
    STAGE_STATE_CALLS: 3248,
    MATERIAL_CALLS: 3252,
    /** 8 texture pointers, one per stage. */
    TEXTURES: 3256,
    STAGE_COUNT: 8,
    /** D3DMATERIAL8: four colours of four floats and a power. */
    MATERIAL: 3288,
    MATERIAL_WORDS: 17,
    /** 8 stages of 32 dwords, one per D3DTEXTURESTAGESTATETYPE below 32. */
    STAGE_STATES: 3356,
    STAGE_STATE_STRIDE: 32,
    /**
     * The marks: a bit per word or matrix the guest wrote since the host last
     * looked. 256 bits over 8 dwords for the render states, one dword for
     * the 28 matrices, and a dword per stage for the stage states. One run,
     * so the host clears them all with one write.
     */
    MARKS: 4380,
    RENDER_STATE_MARKS: 4380,
    TRANSFORM_MARKS: 4412,
    STAGE_STATE_MARKS: 4416,
    MARK_WORDS: 17,
    /**
     * A bit per render state the device answers for, set by the host when it
     * mirrors: the getter answers those from the block and leaves the rest,
     * which the device refuses, to the host.
     */
    RENDER_STATE_VALID: 4448,
    /**
     * A byte per D3DSAMP type below 16: the stage state slot a sampler state
     * of that type is kept in, zero for one the block does not hold. Written
     * by the host for a device that has sampler states; zero throughout for
     * one that does not, which sends every call to the host.
     */
    SAMPLER_KEYS: 4480,
    SAMPLER_KEY_COUNT: 16,
    /**
     * Direct3D 9: each stream's offset, beside its pointer and stride in
     * `STREAMS`, and the vertex declaration's and the pixel shader's
     * pointers; its indices and its vertex shader take Direct3D 8's slots.
     */
    STREAM_OFFSETS: 4496,
    DECLARATION: 4560,
    PIXEL_SHADER: 4564,
    SIZE: 4568,
};

/**
 * A pointer slot whose object the program let go of. Not an address a
 * program can hold, so a slot reading it was written by the host, and a slot
 * that still reads it was not written by the program since.
 */
export const STALE_POINTER = 0xffffffff;

/** The counters, in the order the host keeps its copy of them. */
const COUNTERS = [
    SHADOW.RENDER_STATE_CALLS, SHADOW.TRANSFORM_CALLS, SHADOW.BINDING_CALLS, SHADOW.LOCK_CALLS,
    SHADOW.UNLOCK_CALLS, SHADOW.RING_HEAD, SHADOW.TEXTURE_CALLS, SHADOW.STAGE_STATE_CALLS,
    SHADOW.MATERIAL_CALLS,
];
const [RENDER_STATE_GROUP, TRANSFORM_GROUP, BINDING_GROUP, LOCK_GROUP, UNLOCK_GROUP,
    RING_GROUP, TEXTURE_GROUP, STAGE_STATE_GROUP, MATERIAL_GROUP] = COUNTERS.keys();

/**
 * The stage state types this version has, as a bit per type: the guest
 * routine takes those and leaves the rest to the host, which refuses them.
 */
const STAGE_STATE_TYPES = Object.values(D3DTSS).reduce((mask, type)=>mask | (1 << type), 0) >>> 0;

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
    SIZE: 32,
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
     * Levels handed out by the guest routine, counted by it. Each is a
     * reference the program owns and the host has not charged yet.
     */
    REFS: 8,
    /** A pointer per level, zero for one the host has not published yet. */
    LEVELS: 12,
    LEVEL_SLOTS: 16,
    SIZE: 12 + 16 * 4,
};

export const FLAG_SLOW_PATH = 1;

/** What the host clears the marks and the ring's head with; never written to. */
const ZERO_MARKS = new Uint8Array(SHADOW.MARK_WORDS * 4);

/** A lock for reading has nothing to remember; the host takes it. */
const D3DLOCK_READONLY = 0x10;

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
 * Lays out a routine whose short branches name their targets, so that no
 * displacement is counted by hand: a part is bytes, a label, or a branch
 * `{ jcc, to }` that becomes two bytes once every label has a position.
 * A branch that cannot be reached with a byte is a mistake in the routine
 * and is refused rather than truncated.
 *
 * @param {(number[] | { label: string } | { jcc: number, to: string })[]} parts
 * @returns {Uint8Array}
 */
function assemble(parts){
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
            at += 2;
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
const prologue = (slow = 'slow')=>[
    [0x8b, 0x4c, 0x24, 0x04],                                // mov ecx, [esp+4]
    [0x8b, 0x49, 0x04],                                      // mov ecx, [ecx+4]
    [0x85, 0xc9],                                            // test ecx, ecx
    { jcc: 0x74, to: slow },                                 // jz slow
    [0xf7, 0x01, ...dword(FLAG_SLOW_PATH)],                  // test dword [ecx], 1
    { jcc: 0x75, to: slow },                                 // jnz slow
];

/**
 * A routine's bytes: its body, then the jump to the trap its slow label
 * lands on.
 *
 * @param {number} at @param {number} trap
 * @param {(number[] | { label: string } | { jcc: number, to: string })[]} parts
 */
const routine = (at, trap, parts)=>{
    const body = assemble([...parts, { label: 'slow' }]);
    return new Uint8Array([...body, ...jump(at + body.length, trap)]);
};

/**
 * `bts [ecx + marks], eax`: marks word `eax` of a group as written. With a
 * register offset into memory, `bts` addresses a string of bits, so the
 * index is the bit whatever dword of the marks it falls in.
 *
 * A routine marks after it writes and counts after it marks. Another thread
 * can enter the host between any two of its instructions, and the host
 * adopts every word marked when it looks and clears every mark: a word is
 * marked only once it holds the value, so a mark adopted early adopts that
 * value, and a count that comes after its word was adopted finds it done.
 *
 * @param {number} marks  The group's marks, as an offset in the block.
 * @returns {number[]}
 */
const mark = marks=>[0x0f, 0xab, 0x81, ...dword(marks)];

/**
 * `inc dword [reg + CALLS]`, a routine's last write: the call counted where
 * an entry looks first. The register holds the device's block.
 *
 * @param {number} reg  1 for ECX, 2 for EDX, 3 for EBX.
 * @returns {number[]}
 */
const counted = reg=>[0xff, 0x40 | reg, SHADOW.CALLS];

/**
 * HRESULT SetRenderState(this, D3DRENDERSTATETYPE state, DWORD value), as
 * guest code. The block is one word past `this`.
 *
 *     mov ecx, [esp+4]            ; this
 *     mov ecx, [ecx+4]            ; the block
 *     test ecx, ecx
 *     jz slow                     ; no block: the host's
 *     test dword [ecx], 1         ; the host wants the slow path?
 *     jnz slow
 *     mov eax, [esp+8]            ; state
 *     cmp eax, 256
 *     jae slow                    ; not a state the block holds
 *     mov edx, [esp+12]           ; value
 *     mov [ecx + eax*4 + RENDER_STATES], edx
 *     bts [ecx + RENDER_STATE_MARKS], eax
 *     inc dword [ecx + RENDER_STATE_CALLS]
 *     inc dword [ecx + CALLS]
 *     xor eax, eax                ; D3D_OK
 *     ret 12
 *   slow:
 *     jmp trap
 *
 * @param {number} at    Where these bytes will live.
 * @param {number} trap  The method's own trap.
 * @returns {Uint8Array}
 */
export function setRenderStateCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.RENDER_STATE_COUNT)],             // cmp eax, 256
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0x8b, 0x54, 0x24, 0x0c],                                // mov edx, [esp+12]
        [0x89, 0x94, 0x81, ...dword(SHADOW.RENDER_STATES)],      // mov [ecx+eax*4+disp], edx
        mark(SHADOW.RENDER_STATE_MARKS),                         // bts [ecx+disp], eax
        [0xff, 0x41, SHADOW.RENDER_STATE_CALLS],                 // inc dword [ecx+4]
        counted(1),                                              // inc dword [ecx+12]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x0c, 0x00],                                      // ret 12
    ]);
}

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
        ...prologue(),
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
 * HRESULT SetTransform(this, D3DTRANSFORMSTATETYPE type, const D3DMATRIX*),
 * as guest code. Copies the sixteen floats into the type's slot.
 *
 *     mov ecx, [esp+4]
 *     mov ecx, [ecx+4]
 *     test ecx, ecx
 *     jz slow
 *     test dword [ecx], 1
 *     jnz slow
 *     mov eax, [esp+8]            ; type
 *     cmp eax, 24
 *     jb slot
 *     sub eax, 232                ; WORLD..WORLD3 -> 24..27; anything else out of range
 *     cmp eax, 24
 *     jb slow
 *     cmp eax, 28
 *     jae slow
 *   slot:
 *     mov edx, [esp+12]           ; the matrix
 *     test edx, edx
 *     jz slow                     ; NULL is refused by the host
 *     push esi
 *     push edi
 *     mov esi, edx
 *     mov edi, eax
 *     shl edi, 6                  ; slot * 64
 *     lea edi, [ecx + edi + TRANSFORMS]
 *     mov edx, ecx                ; the block, kept across the copy
 *     mov ecx, 16
 *     rep movsd
 *     bts [edx + TRANSFORM_MARKS], eax   ; the slot, once it holds the matrix
 *     inc dword [edx + TRANSFORM_CALLS]
 *     inc dword [edx + CALLS]
 *     pop edi
 *     pop esi
 *     xor eax, eax
 *     ret 12                      ; this, the type and the matrix pointer
 *   slow:
 *     jmp trap
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function setTransformCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(WORLD_SLOT)],                            // cmp eax, 24
        { jcc: 0x72, to: 'slot' },                               // jb slot
        [0x2d, ...dword(WORLD_TYPE - WORLD_SLOT)],               // sub eax, 232
        [0x3d, ...dword(WORLD_SLOT)],                            // cmp eax, 24
        { jcc: 0x72, to: 'slow' },                               // jb slow
        [0x3d, ...dword(SHADOW.TRANSFORM_SLOTS)],                // cmp eax, 28
        { jcc: 0x73, to: 'slow' },                               // jae slow
        { label: 'slot' },
        [0x8b, 0x54, 0x24, 0x0c],                                // mov edx, [esp+12]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x56],                                                  // push esi
        [0x57],                                                  // push edi
        [0x89, 0xd6],                                            // mov esi, edx
        [0x89, 0xc7],                                            // mov edi, eax
        [0xc1, 0xe7, 0x06],                                      // shl edi, 6
        [0x8d, 0xbc, 0x39, ...dword(SHADOW.TRANSFORMS)],         // lea edi, [ecx+edi+disp]
        [0x89, 0xca],                                            // mov edx, ecx
        [0xb9, ...dword(16)],                                    // mov ecx, 16
        [0xf3, 0xa5],                                            // rep movsd
        [0x0f, 0xab, 0x82, ...dword(SHADOW.TRANSFORM_MARKS)],    // bts [edx+disp], eax
        [0xff, 0x42, SHADOW.TRANSFORM_CALLS],                    // inc dword [edx+8]
        counted(2),                                              // inc dword [edx+12]
        [0x5f],                                                  // pop edi
        [0x5e],                                                  // pop esi
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x0c, 0x00],                                      // ret 12
    ]);
}

/**
 * HRESULT Lock(this, UINT offset, UINT size, BYTE** out, DWORD flags), as
 * guest code for a vertex or index buffer. The address handed back is the
 * buffer's own storage; what is remembered is the range, as a union with
 * what was locked before the host last looked, and the flags.
 *
 * The cases left to the host: a lock already held (the host refuses it), a
 * lock for reading, an empty or out-of-range lock, and a null out-pointer.
 *
 *     cmp dword [ecx+LOCKED], 0
 *     jne slow
 *     test dword [esp+20], READONLY
 *     jnz slow
 *     mov eax, [esp+8]            ; offset
 *     mov edx, [esp+12]           ; size
 *     test edx, edx
 *     jnz sized
 *     mov edx, [ecx+LENGTH]       ; zero: to the end
 *     sub edx, eax
 *   sized:
 *     test edx, edx
 *     jz slow
 *     add edx, eax                ; end
 *     jc slow
 *     cmp edx, [ecx+LENGTH]
 *     ja slow
 *     cmp dword [esp+16], 0
 *     je slow
 *     jmp take
 *   hop:                          ; the checks above are too far from the end
 *     jmp slow                    ; for a byte's reach, so they hop through here
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
 *     mov ebx, [esp+20]           ; out
 *     add eax, [ecx+BASE]
 *     mov [ebx], eax
 *     mov dword [ecx+LOCKED], 1
 *     mov ebx, [ecx+DEVICE]
 *     inc dword [ebx+LOCK_CALLS]
 *     inc dword [ebx+CALLS]
 *     pop ebx
 *     xor eax, eax
 *     ret 20
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function lockCode(at, trap){
    return routine(at, trap, [
        ...prologue('hop'),
        [0x83, 0x79, BUFFER.LOCKED, 0x00],                       // cmp dword [ecx+12], 0
        { jcc: 0x75, to: 'hop' },                                // jne hop
        [0xf7, 0x44, 0x24, 0x14, ...dword(D3DLOCK_READONLY)],    // test dword [esp+20], 0x10
        { jcc: 0x75, to: 'hop' },                                // jnz hop
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x8b, 0x54, 0x24, 0x0c],                                // mov edx, [esp+12]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x75, to: 'sized' },                              // jnz sized
        [0x8b, 0x51, BUFFER.LENGTH],                             // mov edx, [ecx+8]
        [0x29, 0xc2],                                            // sub edx, eax
        { label: 'sized' },
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'hop' },                                // jz hop
        [0x01, 0xc2],                                            // add edx, eax
        { jcc: 0x72, to: 'hop' },                                // jc hop
        [0x3b, 0x51, BUFFER.LENGTH],                             // cmp edx, [ecx+8]
        { jcc: 0x77, to: 'hop' },                                // ja hop
        [0x83, 0x7c, 0x24, 0x10, 0x00],                          // cmp dword [esp+16], 0
        { jcc: 0x74, to: 'hop' },                                // je hop
        { jcc: 0xeb, to: 'take' },                               // jmp take
        { label: 'hop' },
        { jcc: 0xeb, to: 'slow' },                               // jmp slow
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
        [0x8b, 0x5c, 0x24, 0x14],                                // mov ebx, [esp+20]
        [0x03, 0x41, BUFFER.BASE],                               // add eax, [ecx+4]
        [0x89, 0x03],                                            // mov [ebx], eax
        [0xc7, 0x41, BUFFER.LOCKED, ...dword(1)],                // mov dword [ecx+12], 1
        [0x8b, 0x59, BUFFER.DEVICE],                             // mov ebx, [ecx+28]
        [0xff, 0x83, ...dword(SHADOW.LOCK_CALLS)],               // inc dword [ebx+disp]
        counted(3),                                              // inc dword [ebx+12]
        [0x5b],                                                  // pop ebx
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x14, 0x00],                                      // ret 20
    ]);
}

/**
 * HRESULT Unlock(this), as guest code. The buffer's block goes on the
 * device's ring for the host to find; a full ring, or no lock to release,
 * is the host's.
 *
 *     cmp dword [ecx+LOCKED], 0
 *     je slow
 *     mov edx, [ecx+DEVICE]
 *     mov eax, [edx+RING_HEAD]
 *     cmp eax, RING_CAPACITY
 *     jae slow
 *     mov [edx + eax*4 + RING], ecx
 *     inc dword [edx+RING_HEAD]
 *     mov dword [ecx+LOCKED], 0
 *     inc dword [edx+UNLOCK_CALLS]
 *     inc dword [edx+CALLS]
 *     xor eax, eax
 *     ret 4
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function unlockCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x83, 0x79, BUFFER.LOCKED, 0x00],                       // cmp dword [ecx+12], 0
        { jcc: 0x74, to: 'slow' },                               // je slow
        [0x8b, 0x51, BUFFER.DEVICE],                             // mov edx, [ecx+28]
        [0x8b, 0x82, ...dword(SHADOW.RING_HEAD)],                // mov eax, [edx+disp]
        [0x3d, ...dword(SHADOW.RING_CAPACITY)],                  // cmp eax, 64
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0x89, 0x8c, 0x82, ...dword(SHADOW.RING)],               // mov [edx+eax*4+disp], ecx
        [0xff, 0x82, ...dword(SHADOW.RING_HEAD)],                // inc dword [edx+disp]
        [0xc7, 0x41, BUFFER.LOCKED, ...dword(0)],                // mov dword [ecx+12], 0
        [0xff, 0x82, ...dword(SHADOW.UNLOCK_CALLS)],             // inc dword [edx+disp]
        counted(2),                                              // inc dword [edx+12]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x04, 0x00],                                      // ret 4
    ]);
}

/**
 * HRESULT SetStreamSource(this, UINT index, IDirect3DVertexBuffer8*, UINT
 * stride), as guest code. Unbinding is the host's, the block untouched: the
 * device keeps the stride a null buffer comes with, so a bind just before it,
 * which did set the stride, has to reach the device first -- and the host
 * adopts the block before any call it takes.
 *
 *     mov eax, [esp+8]            ; index
 *     cmp eax, STREAM_COUNT
 *     jae slow
 *     mov edx, [esp+12]           ; the buffer
 *     test edx, edx
 *     jz slow
 *     mov [ecx + eax*8 + STREAMS], edx
 *     mov edx, [esp+16]           ; stride
 *     mov [ecx + eax*8 + STREAMS + 4], edx
 *     inc dword [ecx+BINDING_CALLS]
 *     inc dword [ecx+CALLS]
 *     xor eax, eax
 *     ret 16
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function setStreamSourceCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.STREAM_COUNT)],                   // cmp eax, 16
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0x8b, 0x54, 0x24, 0x0c],                                // mov edx, [esp+12]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x89, 0x94, 0xc1, ...dword(SHADOW.STREAMS)],            // mov [ecx+eax*8+disp], edx
        [0x8b, 0x54, 0x24, 0x10],                                // mov edx, [esp+16]
        [0x89, 0x94, 0xc1, ...dword(SHADOW.STREAMS + 4)],        // mov [ecx+eax*8+disp+4], edx
        [0xff, 0x81, ...dword(SHADOW.BINDING_CALLS)],            // inc dword [ecx+disp]
        counted(1),                                              // inc dword [ecx+12]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x10, 0x00],                                      // ret 16
    ]);
}

/**
 * HRESULT SetIndices(this, IDirect3DIndexBuffer8*, UINT baseVertexIndex),
 * as guest code.
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function setIndicesCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x89, 0x81, ...dword(SHADOW.INDICES)],                  // mov [ecx+disp], eax
        [0x8b, 0x44, 0x24, 0x0c],                                // mov eax, [esp+12]
        [0x89, 0x81, ...dword(SHADOW.BASE_VERTEX)],              // mov [ecx+disp], eax
        [0xff, 0x81, ...dword(SHADOW.BINDING_CALLS)],            // inc dword [ecx+disp]
        counted(1),                                              // inc dword [ecx+12]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x0c, 0x00],                                      // ret 12
    ]);
}

/**
 * HRESULT SetVertexShader(this, DWORD handle), as guest code. A vertex
 * format is taken; a shader handle has bit zero set and is the host's,
 * which knows whether it is live.
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function setVertexShaderCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0xa8, 0x01],                                            // test al, 1
        { jcc: 0x75, to: 'slow' },                               // jnz slow
        [0x89, 0x81, ...dword(SHADOW.VERTEX_SHADER)],            // mov [ecx+disp], eax
        [0xff, 0x81, ...dword(SHADOW.BINDING_CALLS)],            // inc dword [ecx+disp]
        counted(1),                                              // inc dword [ecx+12]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x08, 0x00],                                      // ret 8
    ]);
}

/**
 * HRESULT SetStreamSource(this, UINT index, IDirect3DVertexBuffer9*, UINT
 * offset, UINT stride), as guest code: Direct3D 9's, with an offset.
 * Unbinding is the host's, as Direct3D 8's is: the device keeps the offset
 * and the stride a null buffer comes with.
 *
 *     mov eax, [esp+8]            ; index
 *     cmp eax, STREAM_COUNT
 *     jae slow
 *     mov edx, [esp+12]           ; the buffer
 *     test edx, edx
 *     jz slow
 *     mov [ecx + eax*8 + STREAMS], edx
 *     mov edx, [esp+20]           ; stride
 *     mov [ecx + eax*8 + STREAMS + 4], edx
 *     mov edx, [esp+16]           ; offset
 *     mov [ecx + eax*4 + STREAM_OFFSETS], edx
 *     inc dword [ecx+BINDING_CALLS]
 *     inc dword [ecx+CALLS]
 *     xor eax, eax
 *     ret 20
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function setStreamSource9Code(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.STREAM_COUNT)],                   // cmp eax, 16
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0x8b, 0x54, 0x24, 0x0c],                                // mov edx, [esp+12]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x89, 0x94, 0xc1, ...dword(SHADOW.STREAMS)],            // mov [ecx+eax*8+disp], edx
        [0x8b, 0x54, 0x24, 0x14],                                // mov edx, [esp+20]
        [0x89, 0x94, 0xc1, ...dword(SHADOW.STREAMS + 4)],        // mov [ecx+eax*8+disp+4], edx
        [0x8b, 0x54, 0x24, 0x10],                                // mov edx, [esp+16]
        [0x89, 0x94, 0x81, ...dword(SHADOW.STREAM_OFFSETS)],     // mov [ecx+eax*4+disp], edx
        [0xff, 0x81, ...dword(SHADOW.BINDING_CALLS)],            // inc dword [ecx+disp]
        counted(1),                                              // inc dword [ecx+12]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x14, 0x00],                                      // ret 20
    ]);
}

/**
 * A Direct3D 9 binding made by one pointer -- SetVertexDeclaration,
 * SetIndices, SetVertexShader, SetPixelShader: HRESULT (this, interface*) --
 * as guest code. The pointer is stored as it is, a null one too, which
 * leaves nothing behind that the device keeps; the host turns it into what
 * it names when it next looks.
 *
 * @param {number} at @param {number} trap
 * @param {number} slot  `SHADOW.DECLARATION`, `INDICES`, `VERTEX_SHADER` or
 *     `PIXEL_SHADER`.
 * @returns {Uint8Array}
 */
export function setBindingCode(at, trap, slot){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x89, 0x81, ...dword(slot)],                            // mov [ecx+disp], eax
        [0xff, 0x81, ...dword(SHADOW.BINDING_CALLS)],            // inc dword [ecx+disp]
        counted(1),                                              // inc dword [ecx+12]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x08, 0x00],                                      // ret 8
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

/**
 * HRESULT SetTexture(this, DWORD stage, IDirect3DBaseTexture8*), as guest
 * code. The pointer is stored as it is; the host turns it into the object it
 * names when it next looks, and refuses one that names nothing. A stage past
 * the block's eight is invalid to Direct3D 8; Direct3D 9, whose samplers go
 * further, sends it to the host (`beyond` 'slow').
 *
 *     mov eax, [esp+8]            ; stage
 *     cmp eax, 8
 *     jae invalid
 *     mov edx, [esp+12]           ; the texture
 *     mov [ecx + eax*4 + TEXTURES], edx
 *     inc dword [ecx+TEXTURE_CALLS]
 *     inc dword [ecx+CALLS]
 *     xor eax, eax
 *     ret 12
 *
 * @param {number} at @param {number} trap @param {'invalid' | 'slow'} [beyond]
 * @returns {Uint8Array}
 */
export function setTextureCode(at, trap, beyond = 'invalid'){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.STAGE_COUNT)],                    // cmp eax, 8
        { jcc: 0x73, to: beyond },                               // jae beyond
        [0x8b, 0x54, 0x24, 0x0c],                                // mov edx, [esp+12]
        [0x89, 0x94, 0x81, ...dword(SHADOW.TEXTURES)],           // mov [ecx+eax*4+disp], edx
        [0xff, 0x81, ...dword(SHADOW.TEXTURE_CALLS)],            // inc dword [ecx+disp]
        counted(1),                                              // inc dword [ecx+12]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x0c, 0x00],                                      // ret 12
        ...invalidTail(12),
    ]);
}

/**
 * HRESULT SetTextureStageState(this, DWORD stage, D3DTEXTURESTAGESTATETYPE
 * type, DWORD value), as guest code. A type this version has not got is the
 * host's, which refuses it; a stage past the last is refused here.
 *
 *     mov eax, [esp+12]           ; type
 *     cmp eax, 32
 *     jae slow
 *     mov edx, STAGE_STATE_TYPES
 *     bt edx, eax
 *     jnc slow                    ; not a type of this version
 *     mov eax, [esp+8]            ; stage
 *     cmp eax, 8
 *     jae invalid
 *     shl eax, 5                  ; stage * 32
 *     add eax, [esp+12]           ; + type
 *     mov edx, [esp+16]           ; value
 *     mov [ecx + eax*4 + STAGE_STATES], edx
 *     bts [ecx + STAGE_STATE_MARKS], eax  ; the stage's dword, the type's bit
 *     inc dword [ecx+STAGE_STATE_CALLS]
 *     inc dword [ecx+CALLS]
 *     xor eax, eax
 *     ret 16
 *
 * @param {number} at @param {number} trap
 * @param {number} [types]  The stage state types the routine takes, a bit
 *     each below 32; Direct3D 8's by default. The rest go to the host.
 * @returns {Uint8Array}
 */
export function setTextureStageStateCode(at, trap, types = STAGE_STATE_TYPES){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x0c],                                // mov eax, [esp+12]
        [0x3d, ...dword(SHADOW.STAGE_STATE_STRIDE)],             // cmp eax, 32
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0xba, ...dword(types)],                                 // mov edx, imm32
        [0x0f, 0xa3, 0xc2],                                      // bt edx, eax
        { jcc: 0x73, to: 'slow' },                               // jnc slow
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.STAGE_COUNT)],                    // cmp eax, 8
        { jcc: 0x73, to: 'invalid' },                            // jae invalid
        [0xc1, 0xe0, 0x05],                                      // shl eax, 5
        [0x03, 0x44, 0x24, 0x0c],                                // add eax, [esp+12]
        [0x8b, 0x54, 0x24, 0x10],                                // mov edx, [esp+16]
        [0x89, 0x94, 0x81, ...dword(SHADOW.STAGE_STATES)],       // mov [ecx+eax*4+disp], edx
        mark(SHADOW.STAGE_STATE_MARKS),                          // bts [ecx+disp], eax
        [0xff, 0x81, ...dword(SHADOW.STAGE_STATE_CALLS)],        // inc dword [ecx+disp]
        counted(1),                                              // inc dword [ecx+12]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x10, 0x00],                                      // ret 16
        ...invalidTail(16),
    ]);
}

/** The transform types below WORLD a device answers for: VIEW, PROJECTION, TEXTURE0..7. */
const ANSWERED_TRANSFORMS = (1 << 2 | 1 << 3 | 0xff << 16) >>> 0;

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
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function getTransformCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(WORLD_SLOT)],                            // cmp eax, 24
        { jcc: 0x72, to: 'low' },                                // jb low
        [0x2d, ...dword(WORLD_TYPE - WORLD_SLOT)],               // sub eax, 232
        [0x3d, ...dword(WORLD_SLOT)],                            // cmp eax, 24
        { jcc: 0x72, to: 'slow' },                               // jb slow
        [0x3d, ...dword(SHADOW.TRANSFORM_SLOTS)],                // cmp eax, 28
        { jcc: 0x73, to: 'slow' },                               // jae slow
        { jcc: 0xeb, to: 'slot' },                               // jmp slot
        { label: 'low' },
        [0xba, ...dword(ANSWERED_TRANSFORMS)],                   // mov edx, imm32
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
 * type, DWORD *value), as guest code: a type the version's setter takes is
 * kept in the block, where the guest's own writes land and the host mirrors
 * every change it makes itself, so the answer is read there. A stage past the
 * block, a type the setter leaves to the host, a null pointer and the host's
 * flag go to the host.
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
 * @param {number} [types]  The stage state types the setter takes, Direct3D 8's by default.
 * @returns {Uint8Array}
 */
export function getTextureStageStateCode(at, trap, types = STAGE_STATE_TYPES){
    return routine(at, trap, [
        ...prologue(),
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
 * HRESULT SetSamplerState(this, DWORD sampler, D3DSAMPLERSTATETYPE type,
 * DWORD value), as guest code: the state is kept in its sampler's stage
 * state slot for its type, which the block's table names, and marked there
 * as a stage state is. A sampler past the block's stages -- the higher pixel
 * samplers, the displacement and vertex ones -- and a type the table has no
 * slot for go to the host.
 *
 *     (prologue)
 *     mov eax, [esp+12]           ; type
 *     cmp eax, 16
 *     jae slow
 *     movzx eax, byte [ecx + eax + SAMPLER_KEYS]
 *     test eax, eax
 *     jz slow
 *     mov edx, [esp+8]            ; sampler
 *     cmp edx, 8
 *     jae slow
 *     shl edx, 5
 *     add eax, edx                ; sampler * 32 + slot
 *     mov edx, [esp+16]           ; value
 *     mov [ecx + eax*4 + STAGE_STATES], edx
 *     bts [ecx + STAGE_STATE_MARKS], eax
 *     inc dword [ecx + STAGE_STATE_CALLS]
 *     inc dword [ecx + CALLS]
 *     xor eax, eax
 *     ret 16
 *   slow:
 *     jmp trap
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function setSamplerStateCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x44, 0x24, 0x0c],                                // mov eax, [esp+12]
        [0x3d, ...dword(SHADOW.SAMPLER_KEY_COUNT)],              // cmp eax, 16
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0x0f, 0xb6, 0x84, 0x01, ...dword(SHADOW.SAMPLER_KEYS)], // movzx eax, byte [ecx+eax+disp]
        [0x85, 0xc0],                                            // test eax, eax
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x54, 0x24, 0x08],                                // mov edx, [esp+8]
        [0x81, 0xfa, ...dword(SHADOW.STAGE_COUNT)],              // cmp edx, 8
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0xc1, 0xe2, 0x05],                                      // shl edx, 5
        [0x01, 0xd0],                                            // add eax, edx
        [0x8b, 0x54, 0x24, 0x10],                                // mov edx, [esp+16]
        [0x89, 0x94, 0x81, ...dword(SHADOW.STAGE_STATES)],       // mov [ecx+eax*4+disp], edx
        mark(SHADOW.STAGE_STATE_MARKS),                          // bts [ecx+disp], eax
        [0xff, 0x81, ...dword(SHADOW.STAGE_STATE_CALLS)],        // inc dword [ecx+disp]
        counted(1),                                              // inc dword [ecx+12]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x10, 0x00],                                      // ret 16
    ]);
}

/**
 * HRESULT SetMaterial(this, const D3DMATERIAL8*), as guest code. Copies the
 * seventeen floats into the block; a null pointer is the host's to refuse.
 * The call is counted once the copy is done, so that an entry another
 * thread makes during it does not take half a material as the whole.
 *
 *     mov edx, [esp+8]            ; the material
 *     test edx, edx
 *     jz slow
 *     push esi
 *     push edi
 *     mov esi, edx
 *     lea edi, [ecx + MATERIAL]
 *     mov edx, ecx                ; the block, kept across the copy
 *     mov ecx, 17
 *     rep movsd
 *     inc dword [edx+MATERIAL_CALLS]
 *     inc dword [edx+CALLS]
 *     pop edi
 *     pop esi
 *     xor eax, eax
 *     ret 8
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function setMaterialCode(at, trap){
    return routine(at, trap, [
        ...prologue(),
        [0x8b, 0x54, 0x24, 0x08],                                // mov edx, [esp+8]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x56],                                                  // push esi
        [0x57],                                                  // push edi
        [0x89, 0xd6],                                            // mov esi, edx
        [0x8d, 0xb9, ...dword(SHADOW.MATERIAL)],                 // lea edi, [ecx+disp]
        [0x89, 0xca],                                            // mov edx, ecx
        [0xb9, ...dword(SHADOW.MATERIAL_WORDS)],                 // mov ecx, 17
        [0xf3, 0xa5],                                            // rep movsd
        [0xff, 0x82, ...dword(SHADOW.MATERIAL_CALLS)],           // inc dword [edx+disp]
        counted(2),                                              // inc dword [edx+12]
        [0x5f],                                                  // pop edi
        [0x5e],                                                  // pop esi
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x08, 0x00],                                      // ret 8
    ]);
}

/**
 * HRESULT GetSurfaceLevel(this, UINT level, IDirect3DSurface8** out), as
 * guest code for a texture. The pointer is the one the host published for
 * that level, out of the texture's own block; a level the texture has not
 * got is refused here, as the interface refuses it.
 *
 * The reference the call owes is counted rather than taken: taking one is
 * the host's business, and the count is what the host charges before any
 * reference of that texture is read or given back. A level the host has not
 * published yet reads zero and goes to the host, which makes the surface and
 * fills the slot in.
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
 *     mov eax, [esp+12]           ; out
 *     test eax, eax
 *     jz slow                     ; a null out-pointer is the host's to refuse
 *     mov [eax], edx
 *     inc dword [ecx + REFS]
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
        [0x8b, 0x44, 0x24, 0x0c],                                // mov eax, [esp+12]
        [0x85, 0xc0],                                            // test eax, eax
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x89, 0x10],                                            // mov [eax], edx
        [0xff, 0x41, TEXTURE.REFS],                              // inc dword [ecx+8]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x0c, 0x00],                                      // ret 12
        ...invalidTail(12),
    ]);
}

/**
 * @typedef {Object} ShadowMaterial
 * @property {{ r: number, g: number, b: number, a: number }} Diffuse
 * @property {{ r: number, g: number, b: number, a: number }} Ambient
 * @property {{ r: number, g: number, b: number, a: number }} Specular
 * @property {{ r: number, g: number, b: number, a: number }} Emissive
 * @property {number} Power
 */

/**
 * A material from the seventeen floats D3DMATERIAL8 lays out.
 *
 * @param {ArrayLike<number>} f
 * @returns {ShadowMaterial}
 */
export function materialOf(f){
    const colour = (/** @type {number} */ at)=>(
        { r: f[at], g: f[at + 1], b: f[at + 2], a: f[at + 3] });
    return {
        Diffuse: colour(0),
        Ambient: colour(4),
        Specular: colour(8),
        Emissive: colour(12),
        Power: f[16],
    };
}

/**
 * @param {ShadowMaterial} material
 * @returns {Float32Array} the seventeen floats D3DMATERIAL8 lays out
 */
export function materialFloats(material){
    const colours = [material.Diffuse, material.Ambient, material.Specular, material.Emissive];
    return Float32Array.from([
        ...colours.flatMap(one=>[one.r, one.g, one.b, one.a]),
        material.Power,
    ]);
}

/**
 * @typedef {Object} ShadowBuffer
 * @property {number} base        Where its bytes are in guest memory.
 * @property {number} length
 * @property {number} type        D3DRTYPE, which says which interface it is published as.
 * @property {number} refCount
 * @property {() => number} release
 * @property {(offset: number, size: number, out: { pBits?: number }, flags?: number) => number
 *     } Lock
 * @property {() => number} Unlock
 */

/**
 * @typedef {Object} ShadowTexture
 * @property {number} levels
 * @property {() => number} addRef
 *
 * @typedef {Object} ShadowDevice
 * @property {(state: number, value: number) => number} SetRenderState
 * @property {(state: number, out: { value?: number }) => number} GetRenderState
 * @property {(type: number, matrix: ArrayLike<number>) => number} SetTransform
 * @property {(type: number, out: { matrix?: ArrayLike<number> }) => number} GetTransform
 * @property {(index: number, buffer: any, offsetOrStride: number, stride?: number) => number
 *     } SetStreamSource  Direct3D 8's (index, buffer, stride) or 9's (index, buffer,
 *     offset, stride).
 * @property {(index: number, out: { buffer?: any, offset?: number, stride?: number }) => number
 *     } GetStreamSource
 * @property {(declaration: any) => number} [SetVertexDeclaration]  Direct3D 9's.
 * @property {(buffer: any, base?: number) => number} SetIndices  Direct3D 9's has no base.
 * @property {(out: { buffer?: any, baseVertexIndex?: number }) => number} GetIndices
 * @property {(handleOrShader: any) => number} SetVertexShader  Direct3D 8's handle or 9's
 *     shader.
 * @property {(shader: any) => number} [SetPixelShader]  Direct3D 9's.
 * @property {(out: { handle?: number }) => number} GetVertexShader
 * @property {(stage: number, texture: any) => number} SetTexture
 * @property {(sampler: number, type: number, value: number) => number} [SetSamplerState]
 * @property {(sampler: number, type: number, out: { value?: number }) => number} [GetSamplerState]
 * @property {(stage: number, type: number, value: number) => number} SetTextureStageState
 * @property {(stage: number, type: number, out: { value?: number }) => number
 *     } GetTextureStageState
 * @property {(material: ShadowMaterial) => number} SetMaterial
 * @property {(out: { material?: ShadowMaterial }) => number} GetMaterial
 */

/**
 * @typedef {Object} ShadowDeps
 * @property {(bytes: number) => number} allocate     Guest memory.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 *     May answer with the guest's own bytes rather than a copy; nothing here
 *     keeps what it returns past the call that read it.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => number} [readU32]
 *     A dword read in place, for the count looked at on every call: a view
 *     per call was a measured share of a frame.
 * @property {ShadowDevice} device
 * @property {(pointer: number) => any} objectAt    The object a pointer the guest wrote names.
 * @property {(buffer: ShadowBuffer) => number} pointerOf   The pointer a buffer is published as.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {readonly number[]} [samplerStates]  For a device with sampler
 *     states (Direct3D 9), the stage state slot each D3DSAMP type is kept in,
 *     by type: the guest writes one there, and the host sets it back through
 *     SetSamplerState.
 * @property {string} [name]  The device interface a refusal names.
 * @property {boolean | 'd3d9'} [bindings]  Whose bindings the block holds:
 *     Direct3D 8's streams, indices and vertex shader (the default), Direct3D
 *     9's streams with their offsets and its declaration (`'d3d9'`), or none.
 */

/**
 * The host's side of one device's block.
 *
 * @param {ShadowDeps} deps
 */
export function createShadow(deps){
    const { device } = deps;
    const name = deps.name ?? 'IDirect3DDevice8';
    /** The D3DSAMP type kept in each stage state slot, or 0 for a stage state. */
    const samplerTypes = new Uint8Array(SHADOW.STAGE_STATE_STRIDE);
    (deps.samplerStates ?? []).forEach((key, type)=>{
        if (type !== 0 && key < SHADOW.STAGE_STATE_STRIDE && type < SHADOW.SAMPLER_KEY_COUNT)
        {
            samplerTypes[key] = type;
        }
    });
    let address = 0;
    /** What the host last saw in the block, and so what the device holds. */
    const seenStates = new Uint32Array(SHADOW.RENDER_STATE_COUNT);
    const seenTransforms = new Uint32Array(SHADOW.TRANSFORM_SLOTS * 16);
    const seenStreams = new Uint32Array(SHADOW.STREAM_COUNT * 2);
    const seenOffsets = new Uint32Array(SHADOW.STREAM_COUNT);
    let seenDeclaration = 0;
    const nine = deps.bindings === 'd3d9';
    let seenIndices = 0;
    let seenBaseVertex = 0;
    let seenShader = 0;
    let seenPixelShader = 0;
    const seenTextures = new Uint32Array(SHADOW.STAGE_COUNT);
    const seenStageStates = new Uint32Array(SHADOW.STAGE_COUNT * SHADOW.STAGE_STATE_STRIDE);
    const seenMaterial = new Uint32Array(SHADOW.MATERIAL_WORDS);
    /**
     * The guest's counters as of the last sync, in the order of COUNTERS;
     * a group whose count is unchanged has nothing to adopt.
     */
    const seenCounters = new Uint32Array(COUNTERS.length);
    /** The count of every call the routines took, as of the last entry. */
    let seenCalls = 0;
    const counters = new Uint32Array(COUNTERS.length);
    /** The counters as the last entry that found something read them. */
    const absorbed = new Uint32Array(COUNTERS.length);
    /** @param {number} group */
    const changed = group=>counters[group] !== seenCounters[group];
    let refused = 0;
    /** Words of the block compared with the host's copy, over every entry. */
    let compared = 0;
    let slow = false;
    let synced = 0;
    let skipped = 0;
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
     * The textures with a block, with how many of the references the guest
     * took on their levels the host has charged. One count for the texture
     * and all of its levels, because that is how the resource itself counts
     * them.
     *
     * @type {WeakMap<object, { block: number, charged: number }>}
     */
    const textureBlocks = new WeakMap();
    /** References charged so far, which is what the guest routine absorbed. */
    let levelRefs = 0;
    /** Resource blocks are carved from pages of their own, for the same reason as the device's. */
    const pool = { at: 0, left: 0 };

    /** @param {number} value */
    const dwordBytes = value=>new Uint8Array(dword(value));
    /** @param {number[]} values */
    const dwordsBytes = values=>new Uint8Array(values.flatMap(dword));
    /**
     * Guest bytes as words, in place when they are aligned for it and copied
     * when they are not: the block is read on every device call.
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
     * Writes the device's current values into the block, so that the block
     * and the copy agree with the device before the guest touches either.
     */
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
            const value = answered ?? 0;
            seenStates[state] = value;
            view.setUint32(state * 4, value, true);
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
        seenTransforms.set(new Uint32Array(matrices.buffer));
        deps.writeMemory(address + SHADOW.TRANSFORMS, matrices);
    };

    /**
     * Direct3D 9's bindings, as stale pointers beside the offset and stride
     * the device holds: the next pointer the guest writes is a change whatever
     * it names, and reading the bound buffer back would take a reference.
     *
     * @param {number} index
     */
    const mirrorStream9 = index=>{
        /** @type {{ buffer?: ShadowBuffer, offset?: number, stride?: number }} */
        const out = {};
        const ok = device.GetStreamSource(index, out) === 0;
        out.buffer?.release();
        seenStreams[index * 2] = STALE_POINTER;
        seenStreams[index * 2 + 1] = ok ? (out.stride ?? 0) >>> 0 : 0;
        seenOffsets[index] = ok ? (out.offset ?? 0) >>> 0 : 0;
        deps.writeMemory(address + SHADOW.STREAMS + index * 8,
            dwordsBytes([seenStreams[index * 2], seenStreams[index * 2 + 1]]));
        deps.writeMemory(address + SHADOW.STREAM_OFFSETS + index * 4,
            dwordBytes(seenOffsets[index]));
    };
    const mirrorDeclaration = ()=>{
        seenDeclaration = STALE_POINTER;
        deps.writeMemory(address + SHADOW.DECLARATION, dwordBytes(seenDeclaration));
    };
    const mirrorIndices9 = ()=>{
        seenIndices = STALE_POINTER;
        deps.writeMemory(address + SHADOW.INDICES, dwordBytes(seenIndices));
    };
    const mirrorShaders9 = ()=>{
        seenShader = STALE_POINTER;
        seenPixelShader = STALE_POINTER;
        deps.writeMemory(address + SHADOW.VERTEX_SHADER, dwordBytes(STALE_POINTER));
        deps.writeMemory(address + SHADOW.PIXEL_SHADER, dwordBytes(STALE_POINTER));
    };

    /**
     * Direct3D 8's stream, as the pointer the program knows the buffer by. A
     * Get* adds a reference the caller owes back.
     *
     * @param {number} index
     */
    const readStream8 = index=>{
        /** @type {{ buffer?: ShadowBuffer, stride?: number }} */
        const out = {};
        const ok = device.GetStreamSource(index, out) === 0;
        seenStreams[index * 2] = ok && out.buffer ? deps.pointerOf(out.buffer) : 0;
        seenStreams[index * 2 + 1] = ok ? (out.stride ?? 0) >>> 0 : 0;
        out.buffer?.release();
    };

    const mirrorBindings = ()=>{
        if (nine)
        {
            for (let index = 0; index < SHADOW.STREAM_COUNT; index++)
            {
                mirrorStream9(index);
            }
            mirrorDeclaration();
            mirrorIndices9();
            mirrorShaders9();
            return;
        }
        for (let index = 0; index < (deps.bindings === false ? 0 : SHADOW.STREAM_COUNT); index++)
        {
            readStream8(index);
        }
        /** @type {{ buffer?: ShadowBuffer, baseVertexIndex?: number }} */
        const indices = {};
        const hasIndices = deps.bindings !== false && device.GetIndices(indices) === 0;
        seenIndices = hasIndices && indices.buffer ? deps.pointerOf(indices.buffer) : 0;
        seenBaseVertex = hasIndices ? (indices.baseVertexIndex ?? 0) >>> 0 : 0;
        indices.buffer?.release();
        /** @type {{ handle?: number }} */
        const shader = {};
        seenShader = deps.bindings !== false && device.GetVertexShader(shader) === 0
            ? (shader.handle ?? 0) >>> 0 : 0;
        deps.writeMemory(address + SHADOW.STREAMS,
            dwordsBytes([...seenStreams, seenIndices, seenBaseVertex, seenShader]));
    };

    const mirrorTextures = ()=>{
        // The textures are mirrored as stale rather than as pointers: a
        // program that never writes a stage leaves the device with what it
        // holds, and reading a bound texture back would take a reference on
        // one the program may already have let go of.
        seenTextures.fill(STALE_POINTER);
        deps.writeMemory(address + SHADOW.TEXTURES, dwordsBytes([...seenTextures]));
    };

    const mirrorStageStates = ()=>{
        for (let stage = 0; stage < SHADOW.STAGE_COUNT; stage++)
        {
            for (let type = 0; type < SHADOW.STAGE_STATE_STRIDE; type++)
            {
                /** @type {{ value?: number }} */
                const out = {};
                const value = device.GetTextureStageState(stage, type, out) === 0
                    ? (out.value ?? 0) >>> 0
                    : 0;
                seenStageStates[stage * SHADOW.STAGE_STATE_STRIDE + type] = value;
            }
        }
        // A sampler state is kept in the slot of its stage state key, read as
        // the device answers it for that sampler.
        const keys = new Uint8Array(SHADOW.SAMPLER_KEY_COUNT);
        (deps.samplerStates ?? []).forEach((key, type)=>{
            if (type === 0 || key >= SHADOW.STAGE_STATE_STRIDE || type >= SHADOW.SAMPLER_KEY_COUNT)
            {
                return;
            }
            keys[type] = key;
            for (let stage = 0; stage < SHADOW.STAGE_COUNT; stage++)
            {
                /** @type {{ value?: number }} */
                const out = {};
                seenStageStates[stage * SHADOW.STAGE_STATE_STRIDE + key] =
                    device.GetSamplerState?.(stage, type, out) === 0 ? (out.value ?? 0) >>> 0 : 0;
            }
        });
        deps.writeMemory(address + SHADOW.SAMPLER_KEYS, keys);
        deps.writeMemory(address + SHADOW.STAGE_STATES, dwordsBytes([...seenStageStates]));
    };

    const mirrorMaterial = ()=>{
        /** @type {{ material?: ShadowMaterial }} */
        const held = {};
        const material = device.GetMaterial(held) === 0 && held.material
            ? materialFloats(held.material)
            : new Float32Array(SHADOW.MATERIAL_WORDS);
        seenMaterial.set(new Uint32Array(material.buffer));
        deps.writeMemory(address + SHADOW.MATERIAL, new Uint8Array(material.buffer));
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
        const floats = new Float32Array(out.matrix);
        seenTransforms.set(new Uint32Array(floats.buffer), slot * 16);
        deps.writeMemory(address + SHADOW.TRANSFORMS + slot * 64,
            new Uint8Array(floats.buffer));
    };

    const mirror = ()=>{
        mirrorRenderStates();
        mirrorTransforms();
        mirrorBindings();
        mirrorTextures();
        mirrorStageStates();
        mirrorMaterial();
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
            }
            else
            {
                refuse('IDirect3DVertexBuffer8::Lock',
                    `a lock of ${from}..${to} taken in the guest was accepted;`
                    + ' the buffer refuses it');
            }
            deps.writeMemory(block + BUFFER.FROM, new Uint8Array(12));
        }
        if (entry.hostLocked && !locked)
        {
            entry.buffer.Unlock();
            entry.hostLocked = false;
        }
    };

    // Each group below reads the block through `block`, one view of all of
    // it, taken once per entry: a view per group, or a read per word, each
    // cost more than the words they read. A difference goes through the
    // device's own setter; a value the setter refuses is reported once and
    // kept as the guest set it, so it is not reported again.

    /**
     * The render states and stage states marked in one group's marks, each
     * adopted in ascending order -- the order a scan of the whole group took
     * them in -- by `adopt`. Answers whether any was marked.
     *
     * @param {Uint32Array} block
     * @param {number} marksAt  The group's marks, as an offset in the block.
     * @param {(block: Uint32Array, index: number) => void} adopt
     */
    const takeMarked = (block, marksAt, adopt)=>{
        let any = false;
        for (let row = 0; row < 8; row++)
        {
            const marks = block[(marksAt >>> 2) + row];
            if (marks === 0)
            {
                continue;
            }
            any = true;
            for (let bits = marks; bits !== 0; bits &= bits - 1)
            {
                compared++;
                adopt(block, row * 32 + (31 - Math.clz32(bits & -bits)));
            }
        }
        return any;
    };

    /** @param {Uint32Array} block @param {number} state */
    const adoptRenderState = (block, state)=>{
        const value = block[(SHADOW.RENDER_STATES >>> 2) + state];
        if (value === seenStates[state])
        {
            return;
        }
        seenStates[state] = value;
        if (device.SetRenderState(state, value) !== 0)
        {
            refuse(`${name}::SetRenderState`,
                `state ${state} set to ${value} in the guest was accepted;`
                + ' the device refuses it');
        }
    };

    /** @param {Uint32Array} block @param {number} at  The stage times 32, plus the type. */
    const adoptStageState = (block, at)=>{
        const value = block[(SHADOW.STAGE_STATES >>> 2) + at];
        if (value === seenStageStates[at])
        {
            return;
        }
        seenStageStates[at] = value;
        const stage = at >>> 5;
        const type = at & (SHADOW.STAGE_STATE_STRIDE - 1);
        const sampler = samplerTypes[type];
        if (sampler)
        {
            if (device.SetSamplerState?.(stage, sampler, value) !== 0)
            {
                refuse('IDirect3DDevice9::SetSamplerState',
                    `sampler ${stage} state ${sampler} set to ${value} in the guest was accepted;`
                    + ' the device refuses it');
            }
            return;
        }
        if (device.SetTextureStageState(stage, type, value) !== 0)
        {
            refuse(`${name}::SetTextureStageState`,
                `stage ${stage} state ${type} set to ${value} in the guest was accepted;`
                + ' the device refuses it');
        }
    };

    /**
     * A transform is sixteen words and there are 28, so its marks are one
     * dword. A mark past the 28 names nothing: only a write by other means
     * than the routines puts one there.
     *
     * @param {Uint32Array} block
     */
    const syncTransforms = block=>{
        const marks = block[SHADOW.TRANSFORM_MARKS >>> 2];
        for (let bits = marks; bits !== 0; bits &= bits - 1)
        {
            const slot = 31 - Math.clz32(bits & -bits);
            if (slot >= SHADOW.TRANSFORM_SLOTS)
            {
                continue;
            }
            compared += 16;
            const from = (SHADOW.TRANSFORMS >>> 2) + slot * 16;
            let same = true;
            for (let word = 0; word < 16; word++)
            {
                if (block[from + word] !== seenTransforms[slot * 16 + word])
                {
                    same = false;
                    break;
                }
            }
            if (same)
            {
                continue;
            }
            const words = block.subarray(from, from + 16);
            seenTransforms.set(words, slot * 16);
            const matrix = new Float32Array(words.buffer, words.byteOffset, 16);
            if (device.SetTransform(transformType(slot), matrix) !== 0)
            {
                refuse(`${name}::SetTransform`,
                    `type ${transformType(slot)} set in the guest was accepted;`
                    + ' the device refuses it');
            }
        }
        return marks !== 0;
    };

    /**
     * What a pointer the guest bound names. One that names nothing this
     * device published unbinds, as the call through the trap does with what
     * it cannot look up, and says so.
     *
     * @param {number} pointer @param {string} method
     * @returns {any}
     */
    const named9 = (pointer, method)=>{
        const object = pointer === 0 ? null : deps.objectAt(pointer) ?? null;
        if (pointer !== 0 && !object)
        {
            refuse(`${name}::${method}`, `0x${pointer.toString(16)} set in the guest is`
                + ' not an interface this device published');
        }
        return object;
    };

    /** @param {Uint32Array} block */
    const syncBindings9 = block=>{
        const from = SHADOW.STREAMS >>> 2;
        const offsets = SHADOW.STREAM_OFFSETS >>> 2;
        compared += SHADOW.STREAM_COUNT * 3 + 4;
        for (let index = 0; index < SHADOW.STREAM_COUNT; index++)
        {
            const pointer = block[from + index * 2];
            const stride = block[from + index * 2 + 1];
            const offset = block[offsets + index];
            if (pointer === seenStreams[index * 2] && stride === seenStreams[index * 2 + 1]
                && offset === seenOffsets[index])
            {
                continue;
            }
            seenStreams[index * 2] = pointer;
            seenStreams[index * 2 + 1] = stride;
            seenOffsets[index] = offset;
            const buffer = pointer === 0 ? null : deps.objectAt(pointer);
            if (pointer !== 0 && !buffer)
            {
                refuse(`${name}::SetStreamSource`,
                    `stream ${index} bound in the guest to 0x${pointer.toString(16)},`
                    + ' which is not an interface this device published');
            }
            else if (device.SetStreamSource(index, buffer, offset, stride) !== 0)
            {
                refuse(`${name}::SetStreamSource`,
                    `stream ${index} bound in the guest was accepted; the device refuses it`);
            }
        }
        const declaration = block[SHADOW.DECLARATION >>> 2];
        if (declaration !== seenDeclaration)
        {
            seenDeclaration = declaration;
            device.SetVertexDeclaration?.(named9(declaration, 'SetVertexDeclaration'));
        }
        const indices = block[SHADOW.INDICES >>> 2];
        if (indices !== seenIndices)
        {
            seenIndices = indices;
            device.SetIndices(named9(indices, 'SetIndices'));
        }
        const vertexShader = block[SHADOW.VERTEX_SHADER >>> 2];
        if (vertexShader !== seenShader)
        {
            seenShader = vertexShader;
            device.SetVertexShader(named9(vertexShader, 'SetVertexShader'));
        }
        const pixelShader = block[SHADOW.PIXEL_SHADER >>> 2];
        if (pixelShader !== seenPixelShader)
        {
            seenPixelShader = pixelShader;
            device.SetPixelShader?.(named9(pixelShader, 'SetPixelShader'));
        }
    };

    // The three small groups are compared whole: a scan of thirty-five words,
    // eight or seventeen costs less than keeping marks for them would.
    /** @param {Uint32Array} block */
    const syncBindings = block=>{
        if (nine)
        {
            syncBindings9(block);
            return;
        }
        const from = SHADOW.STREAMS >>> 2;
        compared += SHADOW.STREAM_COUNT * 2 + 3;
        for (let index = 0; index < SHADOW.STREAM_COUNT; index++)
        {
            const pointer = block[from + index * 2];
            const stride = block[from + index * 2 + 1];
            if (pointer === seenStreams[index * 2] && stride === seenStreams[index * 2 + 1])
            {
                continue;
            }
            seenStreams[index * 2] = pointer;
            seenStreams[index * 2 + 1] = stride;
            const buffer = pointer === 0 ? null : deps.objectAt(pointer);
            if (pointer !== 0 && !buffer)
            {
                refuse(`${name}::SetStreamSource`,
                    `stream ${index} bound in the guest to 0x${pointer.toString(16)},`
                    + ' which is not an interface this device published');
            }
            else if (device.SetStreamSource(index, buffer, stride) !== 0)
            {
                refuse(`${name}::SetStreamSource`,
                    `stream ${index} bound in the guest was accepted; the device refuses it`);
            }
        }
        const indices = block[SHADOW.INDICES >>> 2];
        const baseVertex = block[SHADOW.BASE_VERTEX >>> 2];
        if (indices !== seenIndices || baseVertex !== seenBaseVertex)
        {
            seenIndices = indices;
            seenBaseVertex = baseVertex;
            const buffer = seenIndices === 0 ? null : deps.objectAt(seenIndices);
            if (seenIndices !== 0 && !buffer)
            {
                refuse(`${name}::SetIndices`,
                    `indices bound in the guest to 0x${seenIndices.toString(16)},`
                    + ' which is not an interface this device published');
            }
            else if (device.SetIndices(buffer, seenBaseVertex) !== 0)
            {
                refuse(`${name}::SetIndices`,
                    'indices bound in the guest were accepted; the device refuses them');
            }
        }
        const shader = block[SHADOW.VERTEX_SHADER >>> 2];
        if (shader !== seenShader)
        {
            seenShader = shader;
            if (device.SetVertexShader(seenShader) !== 0)
            {
                refuse(`${name}::SetVertexShader`,
                    `vertex format 0x${seenShader.toString(16)} set in the guest was`
                    + ' accepted; the device refuses it');
            }
        }
    };

    /** @param {Uint32Array} block */
    const syncTextures = block=>{
        const from = SHADOW.TEXTURES >>> 2;
        compared += SHADOW.STAGE_COUNT;
        for (let stage = 0; stage < SHADOW.STAGE_COUNT; stage++)
        {
            const pointer = block[from + stage];
            if (pointer === seenTextures[stage])
            {
                continue;
            }
            seenTextures[stage] = pointer;
            const texture = pointer === 0 ? null : deps.objectAt(pointer);
            if (pointer !== 0 && !texture)
            {
                refuse(`${name}::SetTexture`,
                    `stage ${stage} bound in the guest to 0x${pointer.toString(16)},`
                    + ' which is not an interface this device published');
            }
            else if (device.SetTexture(stage, texture) !== 0)
            {
                refuse(`${name}::SetTexture`,
                    `stage ${stage} bound in the guest was accepted; the device refuses it`);
            }
        }
    };

    /** @param {Uint32Array} block */
    const syncMaterial = block=>{
        const from = SHADOW.MATERIAL >>> 2;
        compared += SHADOW.MATERIAL_WORDS;
        let same = true;
        for (let word = 0; word < SHADOW.MATERIAL_WORDS; word++)
        {
            if (block[from + word] !== seenMaterial[word])
            {
                same = false;
                break;
            }
        }
        if (same)
        {
            return;
        }
        const words = block.subarray(from, from + SHADOW.MATERIAL_WORDS);
        seenMaterial.set(words);
        const floats = new Float32Array(words.buffer, words.byteOffset, SHADOW.MATERIAL_WORDS);
        if (device.SetMaterial(materialOf(floats)) !== 0)
        {
            refuse(`${name}::SetMaterial`,
                'a material set in the guest was accepted; the device refuses it');
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
            }
        }
        return address;
    };

    return {
        address: place,

        /**
         * Whether the fast path is to stand aside. Raised while a state block
         * records, so the block captures what was set and not what changed.
         *
         * @param {boolean} on
         */
        slowPath(on){
            slow = on;
            if (address !== 0)
            {
                deps.writeMemory(address + SHADOW.FLAGS, dwordBytes(on ? FLAG_SLOW_PATH : 0));
            }
        },

        /**
         * After the host changed state on its own -- a state block applied, a
         * reset -- the block is brought to what the device now holds: the
         * groups named, or all of it. A small state block applied between
         * draws is common, and reading back every state the block holds cost
         * each Apply hundreds of calls into the device.
         *
         * @param {{ renderStates?: Iterable<number>, transforms?: Iterable<number>,
         *     bindings?: boolean, textures?: boolean, stageStates?: boolean,
         *     material?: boolean }} [touched]
         */
        remirror(touched){
            if (address === 0)
            {
                return;
            }
            if (!touched)
            {
                mirror();
                return;
            }
            for (const state of touched.renderStates ?? [])
            {
                if (state >= 0 && state < SHADOW.RENDER_STATE_COUNT)
                {
                    seenStates[state] = renderStateOf(state) ?? 0;
                    deps.writeMemory(address + SHADOW.RENDER_STATES + state * 4,
                        dwordBytes(seenStates[state]));
                }
            }
            for (const type of touched.transforms ?? [])
            {
                refreshTransform(type);
            }
            if (touched.bindings)
            {
                mirrorBindings();
            }
            if (touched.textures)
            {
                mirrorTextures();
            }
            if (touched.stageStates)
            {
                mirrorStageStates();
            }
            if (touched.material)
            {
                mirrorMaterial();
            }
        },

        /**
         * After a call through the trap set a value the block holds -- a
         * shader handle, which the routine leaves to the host -- the block and
         * the copy take the value the device now holds. Otherwise the guest's
         * next write of the value before would read as no change, and the
         * device would keep the handle.
         */
        refreshShader(){
            if (address === 0)
            {
                return;
            }
            /** @type {{ handle?: number }} */
            const shader = {};
            seenShader = device.GetVertexShader(shader) === 0 ? (shader.handle ?? 0) >>> 0 : 0;
            deps.writeMemory(address + SHADOW.VERTEX_SHADER, dwordBytes(seenShader));
        },

        /**
         * The same after a user-pointer draw, which empties stream zero and the
         * index binding on the device: without it a program binding the
         * buffer it had bound before would read as no change.
         */
        refreshStreamZero(){
            if (address !== 0 && nine)
            {
                mirrorStream9(0);
                mirrorIndices9();
                return;
            }
            if (address === 0 || deps.bindings === false
                || (seenStreams[0] === 0 && seenStreams[1] === 0 && seenIndices === 0
                    && seenBaseVertex === 0))
            {
                return;
            }
            /** @type {{ stride?: number }} */
            const out = {};
            device.GetStreamSource(0, out);
            /** @type {any} */ (out).buffer?.release();
            seenStreams[0] = 0;
            seenStreams[1] = (out.stride ?? 0) >>> 0;
            seenIndices = 0;
            seenBaseVertex = 0;
            deps.writeMemory(address + SHADOW.STREAMS, dwordsBytes([0, seenStreams[1]]));
            deps.writeMemory(address + SHADOW.INDICES, dwordsBytes([0, 0]));
        },

        /**
         * The same for a transform the host changed itself -- one multiplied
         * by MultiplyTransform, which works on what the device holds.
         *
         * @param {number} type
         */
        refreshTransform,

        /**
         * Adopts whatever the guest wrote since the last entry. Every
         * difference goes through the device's own setter, and a value the
         * setter refuses is reported once and left as the guest set it, so
         * it is not reported again.
         */
        sync(){
            if (address === 0)
            {
                return;
            }
            const calls = readWord(address + SHADOW.CALLS);
            if (calls === seenCalls)
            {
                // Nothing was set and nothing unlocked since the last look:
                // the routines count every call they take.
                skipped++;
                return;
            }
            const block = readWords(address, SHADOW.SIZE >>> 2);
            if (block.length < SHADOW.SIZE >>> 2)
            {
                // No memory to read -- a machine that has stopped: nothing
                // the guest wrote is there to adopt.
                return;
            }
            seenCalls = calls;
            synced++;
            for (let group = 0; group < COUNTERS.length; group++)
            {
                counters[group] = block[COUNTERS[group] >>> 2];
            }
            // By index: `set` on arrays this short cost more than the loop.
            for (let group = 0; group < COUNTERS.length; group++)
            {
                absorbed[group] = counters[group];
            }
            // The marked groups are taken by their marks whichever count
            // moved, and every mark with them, so that one write clears the
            // lot: a routine that marked and has not counted yet is adopted
            // here, and its count finds nothing left to do.
            let marked = takeMarked(block, SHADOW.RENDER_STATE_MARKS, adoptRenderState);
            marked = syncTransforms(block) || marked;
            if (changed(BINDING_GROUP))
            {
                syncBindings(block);
            }
            if (changed(TEXTURE_GROUP))
            {
                syncTextures(block);
            }
            marked = takeMarked(block, SHADOW.STAGE_STATE_MARKS, adoptStageState) || marked;
            if (changed(MATERIAL_GROUP))
            {
                syncMaterial(block);
            }
            if (marked)
            {
                deps.writeMemory(address + SHADOW.MARKS, ZERO_MARKS);
            }
            for (let group = 0; group < COUNTERS.length; group++)
            {
                seenCounters[group] = counters[group];
            }

            const ringHead = counters[RING_GROUP];
            if (ringHead !== 0)
            {
                const ring = block.slice((SHADOW.RING >>> 2),
                    (SHADOW.RING >>> 2) + Math.min(ringHead, SHADOW.RING_CAPACITY));
                for (const buffer of ring)
                {
                    settle(buffer);
                }
                deps.writeMemory(address + SHADOW.RING_HEAD, ZERO_MARKS.subarray(0, 4));
                seenCounters[RING_GROUP] = 0;
            }
        },

        /**
         * After the program let go of an object: every slot still naming its
         * pointer is made stale, in the block and in the copy, so the device
         * keeps what it had bound and the pointer's next appearance -- which
         * may be a new object's -- is a change.
         *
         * @param {number} pointer
         */
        forgetPointer(pointer){
            if (address === 0 || pointer === 0)
            {
                return;
            }
            const stale = dwordBytes(STALE_POINTER);
            for (let stage = 0; stage < SHADOW.STAGE_COUNT; stage++)
            {
                if (seenTextures[stage] === pointer)
                {
                    seenTextures[stage] = STALE_POINTER;
                    deps.writeMemory(address + SHADOW.TEXTURES + stage * 4, stale);
                }
            }
            for (let index = 0; index < SHADOW.STREAM_COUNT; index++)
            {
                if (seenStreams[index * 2] === pointer)
                {
                    seenStreams[index * 2] = STALE_POINTER;
                    deps.writeMemory(address + SHADOW.STREAMS + index * 8, stale);
                }
            }
            if (seenIndices === pointer)
            {
                seenIndices = STALE_POINTER;
                deps.writeMemory(address + SHADOW.INDICES, stale);
            }
            if (nine && seenDeclaration === pointer)
            {
                mirrorDeclaration();
            }
            if (nine && seenShader === pointer)
            {
                seenShader = STALE_POINTER;
                deps.writeMemory(address + SHADOW.VERTEX_SHADER, stale);
            }
            if (nine && seenPixelShader === pointer)
            {
                seenPixelShader = STALE_POINTER;
                deps.writeMemory(address + SHADOW.PIXEL_SHADER, stale);
            }
        },

        /**
         * After a call through the trap changed a stream -- the routine's
         * slow path -- the block takes what the device now holds, so the
         * guest's next write of the binding before is the change it is.
         *
         * @param {number} index
         */
        refreshStream(index){
            if (address === 0 || deps.bindings === false || index < 0
                || index >= SHADOW.STREAM_COUNT)
            {
                return;
            }
            if (nine)
            {
                mirrorStream9(index);
                return;
            }
            readStream8(index);
            deps.writeMemory(address + SHADOW.STREAMS + index * 8,
                dwordsBytes([seenStreams[index * 2], seenStreams[index * 2 + 1]]));
        },

        /**
         * The same after the declaration changed through the trap: SetFVF,
         * which makes a declaration the guest has no pointer to, or the
         * routine's slow path.
         */
        refreshDeclaration(){
            if (address !== 0 && nine)
            {
                mirrorDeclaration();
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
                dwordsBytes([0, buffer.base, buffer.length, 0, 0, 0, 0, owner]));
            blocks.set(block, { buffer, hostLocked: false });
            blockOf.set(buffer, block);
            return block;
        },

        /**
         * A texture's block, made on first use: how many levels it has, and a
         * table of their pointers the host fills in as it publishes them.
         *
         * @param {ShadowTexture} texture
         * @returns {number} the block, or 0 when there is no memory for one
         */
        attachTexture(texture){
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
            deps.writeMemory(block, zeroed);
            textureBlocks.set(texture, { block, charged: 0 });
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
         * Charges the references the guest took on a texture's levels.
         *
         * Called before any reference of that texture -- or of one of its
         * levels, which share its count -- is read or given back, and that is
         * the whole of what keeps the count honest: a Release the program
         * makes for a level it obtained in the guest would otherwise take the
         * count one past what it owes, and a texture the program still holds
         * would be destroyed under it.
         *
         * @param {ShadowTexture} texture
         */
        settleTexture(texture){
            const entry = textureBlocks.get(texture);
            if (!entry)
            {
                return;
            }
            const taken = readWord(entry.block + TEXTURE.REFS);
            for (let owed = taken - entry.charged; owed > 0; owed--)
            {
                texture.addRef();
                levelRefs++;
            }
            entry.charged = taken;
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
                settle(block);
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
            entry.hostLocked = locked;
            deps.writeMemory(block + BUFFER.LOCKED, dwordBytes(locked ? 1 : 0));
        },

        diagnostics: ()=>({
            // Numbers rather than booleans: a report keeps a flat structure of
            // numbers and drops anything else.
            placed: address !== 0 ? 1 : 0,
            slowPath: slow ? 1 : 0,
            // What never crossed into the host, which is the point of all this.
            renderStateCalls: absorbed[RENDER_STATE_GROUP],
            transformCalls: absorbed[TRANSFORM_GROUP],
            bindingCalls: absorbed[BINDING_GROUP],
            lockCalls: absorbed[LOCK_GROUP],
            unlockCalls: absorbed[UNLOCK_GROUP],
            textureCalls: absorbed[TEXTURE_GROUP],
            stageStateCalls: absorbed[STAGE_STATE_GROUP],
            materialCalls: absorbed[MATERIAL_GROUP],
            buffers: blocks.size,
            // Levels handed out in the guest, as the references charged for
            // them: a level the program still holds is counted once the host
            // next looks at that texture's references.
            surfaceLevelCalls: levelRefs,
            // How often an entry found something to adopt, against how often
            // the counters said there was nothing.
            synced,
            skipped,
            // Words compared with the host's copy: what the entries cost,
            // which follows what the guest set, not the size of the block.
            compared,
            refused,
        }),
    };
}
