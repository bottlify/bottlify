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
 * the block directly. On every entry into the host the block is compared
 * whole with the host's own copy, and each difference goes through the same
 * setter the trap would have called, which is where validation and
 * invalidation live. Nothing depends on the guest having set a flag, because
 * the guest can write the block by any means at all. The host writes the
 * block only to mirror its own state into it -- at creation, after a state
 * block is applied, after a reset -- so that "unchanged" in the block means
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
 * sees them and a saving nobody can measure is a belief.
 */

/** Byte offsets within the block. */
/**
 * The block takes a page of its own. The routines that write it are guest
 * code the emulator compiles, and a write into a page that holds compiled
 * code makes the emulator discard everything compiled for that page -- so a
 * block laid right after the routines, out of the same heap, would have every
 * SetRenderState throw the routines away and run them interpreted after.
 */
const PAGE = 4096;

export const SHADOW = {
    /** Bit 0 set by the host: take the slow path. */
    FLAGS: 0,
    /** Fast-path SetRenderState calls, counted by the guest. */
    RENDER_STATE_CALLS: 4,
    /** Fast-path SetTransform calls, counted by the guest. */
    TRANSFORM_CALLS: 8,
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
    SIZE: 2988 + 64 * 4,
};

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

export const FLAG_SLOW_PATH = 1;

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
 *     inc dword [ecx + RENDER_STATE_CALLS]
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
        [0xff, 0x41, SHADOW.RENDER_STATE_CALLS],                 // inc dword [ecx+4]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x0c, 0x00],                                      // ret 12
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
 *     shl eax, 6                  ; slot * 64
 *     lea eax, [ecx + eax + TRANSFORMS]
 *     inc dword [ecx + TRANSFORM_CALLS]
 *     push esi
 *     push edi
 *     mov esi, edx
 *     mov edi, eax
 *     mov ecx, 16
 *     rep movsd
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
        [0xc1, 0xe0, 0x06],                                      // shl eax, 6
        [0x8d, 0x84, 0x01, ...dword(SHADOW.TRANSFORMS)],         // lea eax, [ecx+eax+disp]
        [0xff, 0x41, SHADOW.TRANSFORM_CALLS],                    // inc dword [ecx+8]
        [0x56],                                                  // push esi
        [0x57],                                                  // push edi
        [0x89, 0xd6],                                            // mov esi, edx
        [0x89, 0xc7],                                            // mov edi, eax
        [0xb9, ...dword(16)],                                    // mov ecx, 16
        [0xf3, 0xa5],                                            // rep movsd
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
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x04, 0x00],                                      // ret 4
    ]);
}

/**
 * HRESULT SetStreamSource(this, UINT index, IDirect3DVertexBuffer8*, UINT
 * stride), as guest code. Unbinding leaves the stride, as the device does.
 *
 *     mov eax, [esp+8]            ; index
 *     cmp eax, STREAM_COUNT
 *     jae slow
 *     mov edx, [esp+12]           ; the buffer
 *     mov [ecx + eax*8 + STREAMS], edx
 *     test edx, edx
 *     jz unbound
 *     mov edx, [esp+16]           ; stride
 *     mov [ecx + eax*8 + STREAMS + 4], edx
 *   unbound:
 *     inc dword [ecx+BINDING_CALLS]
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
        [0x89, 0x94, 0xc1, ...dword(SHADOW.STREAMS)],            // mov [ecx+eax*8+disp], edx
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'unbound' },                            // jz unbound
        [0x8b, 0x54, 0x24, 0x10],                                // mov edx, [esp+16]
        [0x89, 0x94, 0xc1, ...dword(SHADOW.STREAMS + 4)],        // mov [ecx+eax*8+disp+4], edx
        { label: 'unbound' },
        [0xff, 0x81, ...dword(SHADOW.BINDING_CALLS)],            // inc dword [ecx+disp]
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
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x08, 0x00],                                      // ret 8
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
 * @typedef {Object} ShadowDevice
 * @property {(state: number, value: number) => number} SetRenderState
 * @property {(state: number, out: { value?: number }) => number} GetRenderState
 * @property {(type: number, matrix: ArrayLike<number>) => number} SetTransform
 * @property {(type: number, out: { matrix?: ArrayLike<number> }) => number} GetTransform
 * @property {(index: number, buffer: any, stride: number) => number} SetStreamSource
 * @property {(index: number, out: { buffer?: any, stride?: number }) => number} GetStreamSource
 * @property {(buffer: any, base: number) => number} SetIndices
 * @property {(out: { buffer?: any, baseVertexIndex?: number }) => number} GetIndices
 * @property {(handle: number) => number} SetVertexShader
 * @property {(out: { handle?: number }) => number} GetVertexShader
 */

/**
 * @typedef {Object} ShadowDeps
 * @property {(bytes: number) => number} allocate     Guest memory.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 *     May answer with the guest's own bytes rather than a copy; nothing here
 *     keeps what it returns past the call that read it.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {ShadowDevice} device
 * @property {(pointer: number) => any} objectAt    The object a pointer the guest wrote names.
 * @property {(buffer: ShadowBuffer) => number} pointerOf   The pointer a buffer is published as.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * The host's side of one device's block.
 *
 * @param {ShadowDeps} deps
 */
export function createShadow(deps){
    const { device } = deps;
    let address = 0;
    /** What the host last saw in the block, and so what the device holds. */
    const seenStates = new Uint32Array(SHADOW.RENDER_STATE_COUNT);
    const seenTransforms = new Uint32Array(SHADOW.TRANSFORM_SLOTS * 16);
    const seenStreams = new Uint32Array(SHADOW.STREAM_COUNT * 2);
    let seenIndices = 0;
    let seenBaseVertex = 0;
    let seenShader = 0;
    /** The guest's counters as of the last sync; unchanged, there is nothing to adopt. */
    const seenCounters = new Uint32Array(6);
    let calls = { renderStates: 0, transforms: 0, bindings: 0, locks: 0, unlocks: 0 };
    let refused = 0;
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
    /** Buffer blocks are carved from pages of their own, for the same reason as the device's. */
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
    /** @param {number} bytes @returns {number} a page-aligned span, or 0 */
    const allocatePage = bytes=>{
        // Two pages, so that a whole page is ours whichever boundary the
        // allocation straddles.
        const span = deps.allocate(bytes + PAGE);
        return span === 0 ? 0 : (span + PAGE - 1) & ~(PAGE - 1);
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
    const mirror = ()=>{
        const states = new Uint8Array(SHADOW.RENDER_STATE_COUNT * 4);
        const view = new DataView(states.buffer);
        for (let state = 0; state < SHADOW.RENDER_STATE_COUNT; state++)
        {
            /** @type {{ value?: number }} */
            const out = {};
            const value = device.GetRenderState(state, out) === 0 ? (out.value ?? 0) >>> 0 : 0;
            seenStates[state] = value;
            view.setUint32(state * 4, value, true);
        }
        deps.writeMemory(address + SHADOW.RENDER_STATES, states);

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

        // The bindings, as the pointers the program knows the buffers by. A
        // Get* adds a reference the caller owes back.
        for (let index = 0; index < SHADOW.STREAM_COUNT; index++)
        {
            /** @type {{ buffer?: ShadowBuffer, stride?: number }} */
            const out = {};
            const ok = device.GetStreamSource(index, out) === 0;
            seenStreams[index * 2] = ok && out.buffer ? deps.pointerOf(out.buffer) : 0;
            seenStreams[index * 2 + 1] = ok ? (out.stride ?? 0) >>> 0 : 0;
            out.buffer?.release();
        }
        /** @type {{ buffer?: ShadowBuffer, baseVertexIndex?: number }} */
        const indices = {};
        const hasIndices = device.GetIndices(indices) === 0;
        seenIndices = hasIndices && indices.buffer ? deps.pointerOf(indices.buffer) : 0;
        seenBaseVertex = hasIndices ? (indices.baseVertexIndex ?? 0) >>> 0 : 0;
        indices.buffer?.release();
        /** @type {{ handle?: number }} */
        const shader = {};
        seenShader = device.GetVertexShader(shader) === 0 ? (shader.handle ?? 0) >>> 0 : 0;
        deps.writeMemory(address + SHADOW.STREAMS,
            dwordsBytes([...seenStreams, seenIndices, seenBaseVertex, seenShader]));
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

    /** The block, made and mirrored on first use. */
    const place = ()=>{
        if (address === 0)
        {
            address = allocatePage(PAGE);
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
         * reset -- the block is brought to what the device now holds.
         */
        remirror(){
            if (address !== 0)
            {
                mirror();
            }
        },

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
            const head = readWords(address, 4);
            const tail = readWords(address + SHADOW.BINDING_CALLS, 4);
            const counters = [head[1], head[2], tail[0], tail[1], tail[2], tail[3]];
            if (counters.every((value, index)=>value === seenCounters[index]))
            {
                // Nothing was set and nothing unlocked since the last look;
                // the block can only differ from the copy through the
                // routines, which count.
                skipped++;
                return;
            }
            seenCounters.set(counters);
            synced++;
            calls = {
                renderStates: head[1], transforms: head[2],
                bindings: tail[0], locks: tail[1], unlocks: tail[2],
            };

            const states = deps.readMemory(address + SHADOW.RENDER_STATES,
                SHADOW.RENDER_STATE_COUNT * 4);
            const stateView = new DataView(states.buffer, states.byteOffset, states.byteLength);
            for (let state = 0; state < SHADOW.RENDER_STATE_COUNT; state++)
            {
                const value = stateView.getUint32(state * 4, true);
                if (value === seenStates[state])
                {
                    continue;
                }
                seenStates[state] = value;
                if (device.SetRenderState(state, value) !== 0)
                {
                    refused++;
                    deps.divergence?.('IDirect3DDevice8::SetRenderState',
                        `state ${state} set to ${value} in the guest was accepted;`
                        + ' the device refuses it');
                }
            }

            const words = readWords(address + SHADOW.TRANSFORMS, SHADOW.TRANSFORM_SLOTS * 16);
            for (let slot = 0; slot < SHADOW.TRANSFORM_SLOTS; slot++)
            {
                let same = true;
                for (let word = slot * 16; word < slot * 16 + 16; word++)
                {
                    if (words[word] !== seenTransforms[word])
                    {
                        same = false;
                        break;
                    }
                }
                if (same)
                {
                    continue;
                }
                seenTransforms.set(words.subarray(slot * 16, slot * 16 + 16), slot * 16);
                const matrix = new Float32Array(words.buffer, words.byteOffset + slot * 64, 16);
                if (device.SetTransform(transformType(slot), matrix) !== 0)
                {
                    refused++;
                    deps.divergence?.('IDirect3DDevice8::SetTransform',
                        `type ${transformType(slot)} set in the guest was accepted;`
                        + ' the device refuses it');
                }
            }

            const bound = readWords(address + SHADOW.STREAMS, SHADOW.STREAM_COUNT * 2 + 3);
            for (let index = 0; index < SHADOW.STREAM_COUNT; index++)
            {
                const pointer = bound[index * 2];
                const stride = bound[index * 2 + 1];
                if (pointer === seenStreams[index * 2] && stride === seenStreams[index * 2 + 1])
                {
                    continue;
                }
                seenStreams[index * 2] = pointer;
                seenStreams[index * 2 + 1] = stride;
                const buffer = pointer === 0 ? null : deps.objectAt(pointer);
                if (pointer !== 0 && !buffer)
                {
                    refuse('IDirect3DDevice8::SetStreamSource',
                        `stream ${index} bound in the guest to 0x${pointer.toString(16)},`
                        + ' which is not an interface this device published');
                }
                else if (device.SetStreamSource(index, buffer, stride) !== 0)
                {
                    refuse('IDirect3DDevice8::SetStreamSource',
                        `stream ${index} bound in the guest was accepted; the device refuses it`);
                }
            }
            const indicesAt = SHADOW.STREAM_COUNT * 2;
            if (bound[indicesAt] !== seenIndices || bound[indicesAt + 1] !== seenBaseVertex)
            {
                seenIndices = bound[indicesAt];
                seenBaseVertex = bound[indicesAt + 1];
                const buffer = seenIndices === 0 ? null : deps.objectAt(seenIndices);
                if (seenIndices !== 0 && !buffer)
                {
                    refuse('IDirect3DDevice8::SetIndices',
                        `indices bound in the guest to 0x${seenIndices.toString(16)},`
                        + ' which is not an interface this device published');
                }
                else if (device.SetIndices(buffer, seenBaseVertex) !== 0)
                {
                    refuse('IDirect3DDevice8::SetIndices',
                        'indices bound in the guest were accepted; the device refuses them');
                }
            }
            if (bound[indicesAt + 2] !== seenShader)
            {
                seenShader = bound[indicesAt + 2];
                if (device.SetVertexShader(seenShader) !== 0)
                {
                    refuse('IDirect3DDevice8::SetVertexShader',
                        `vertex format 0x${seenShader.toString(16)} set in the guest was`
                        + ' accepted; the device refuses it');
                }
            }

            const ringHead = tail[3];
            if (ringHead !== 0)
            {
                const ring = readWords(address + SHADOW.RING,
                    Math.min(ringHead, SHADOW.RING_CAPACITY));
                for (const block of ring)
                {
                    settle(block);
                }
                deps.writeMemory(address + SHADOW.RING_HEAD, dwordBytes(0));
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
            if (pool.left < BUFFER.SIZE)
            {
                pool.at = allocatePage(PAGE);
                pool.left = pool.at === 0 ? 0 : PAGE;
                if (pool.at === 0)
                {
                    return 0;
                }
            }
            const block = pool.at;
            pool.at += BUFFER.SIZE;
            pool.left -= BUFFER.SIZE;
            deps.writeMemory(block,
                dwordsBytes([0, buffer.base, buffer.length, 0, 0, 0, 0, owner]));
            blocks.set(block, { buffer, hostLocked: false });
            blockOf.set(buffer, block);
            return block;
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
            renderStateCalls: calls.renderStates,
            transformCalls: calls.transforms,
            bindingCalls: calls.bindings,
            lockCalls: calls.locks,
            unlockCalls: calls.unlocks,
            buffers: blocks.size,
            // How often an entry found something to adopt, against how often
            // the counters said there was nothing.
            synced,
            skipped,
            refused,
        }),
    };
}
