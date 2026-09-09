/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Device state that a program sets without leaving the guest.
 *
 * A program of this era sets render states and transforms hundreds of times a
 * frame, and every one was a crossing into the host: measured on a real
 * title's menu, four hundred and eighty transforms and two hundred render
 * states a frame, each a trap, a dispatch and a return. The state itself is a
 * dword or sixteen floats. So the two most frequent setters are guest code
 * that writes into a block of guest memory the device owns, and the host
 * reads the block on its way into any method of its own.
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
    SIZE: 16 + 256 * 4 + 28 * 64,
};

export const FLAG_SLOW_PATH = 1;

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
    const body = assemble([
        [0x8b, 0x4c, 0x24, 0x04],                                // mov ecx, [esp+4]
        [0x8b, 0x49, 0x04],                                      // mov ecx, [ecx+4]
        [0x85, 0xc9],                                            // test ecx, ecx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0xf7, 0x01, ...dword(FLAG_SLOW_PATH)],                  // test dword [ecx], 1
        { jcc: 0x75, to: 'slow' },                               // jnz slow
        [0x8b, 0x44, 0x24, 0x08],                                // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.RENDER_STATE_COUNT)],             // cmp eax, 256
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0x8b, 0x54, 0x24, 0x0c],                                // mov edx, [esp+12]
        [0x89, 0x94, 0x81, ...dword(SHADOW.RENDER_STATES)],      // mov [ecx+eax*4+disp], edx
        [0xff, 0x41, SHADOW.RENDER_STATE_CALLS],                 // inc dword [ecx+4]
        [0x31, 0xc0],                                            // xor eax, eax
        [0xc2, 0x0c, 0x00],                                      // ret 12
        { label: 'slow' },
    ]);
    return new Uint8Array([...body, ...jump(at + body.length, trap)]);
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
    const body = assemble([
        [0x8b, 0x4c, 0x24, 0x04],                                // mov ecx, [esp+4]
        [0x8b, 0x49, 0x04],                                      // mov ecx, [ecx+4]
        [0x85, 0xc9],                                            // test ecx, ecx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0xf7, 0x01, ...dword(FLAG_SLOW_PATH)],                  // test dword [ecx], 1
        { jcc: 0x75, to: 'slow' },                               // jnz slow
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
        { label: 'slow' },
    ]);
    return new Uint8Array([...body, ...jump(at + body.length, trap)]);
}

/**
 * @typedef {Object} ShadowDevice
 * @property {(state: number, value: number) => number} SetRenderState
 * @property {(state: number, out: { value?: number }) => number} GetRenderState
 * @property {(type: number, matrix: ArrayLike<number>) => number} SetTransform
 * @property {(type: number, out: { matrix?: ArrayLike<number> }) => number} GetTransform
 */

/**
 * @typedef {Object} ShadowDeps
 * @property {(bytes: number) => number} allocate     Guest memory.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {ShadowDevice} device
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
    let calls = { renderStates: 0, transforms: 0 };
    let refused = 0;
    let slow = false;

    /** @param {number} value */
    const dwordBytes = value=>new Uint8Array(dword(value));

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
    };

    return {
        /** The block, made and mirrored on first use. */
        address(){
            if (address === 0)
            {
                // Two pages, so that a whole page is the block's whichever
                // boundary the allocation straddles.
                const span = deps.allocate(2 * PAGE);
                if (span !== 0)
                {
                    address = (span + PAGE - 1) & ~(PAGE - 1);
                    deps.writeMemory(address, new Uint8Array(SHADOW.SIZE));
                    mirror();
                }
            }
            return address;
        },

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
            const head = deps.readMemory(address, SHADOW.RENDER_STATES);
            const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
            calls = {
                renderStates: headView.getUint32(SHADOW.RENDER_STATE_CALLS, true),
                transforms: headView.getUint32(SHADOW.TRANSFORM_CALLS, true),
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

            const matrices = deps.readMemory(address + SHADOW.TRANSFORMS,
                SHADOW.TRANSFORM_SLOTS * 64);
            const words = new Uint32Array(matrices.buffer.slice(
                matrices.byteOffset, matrices.byteOffset + matrices.byteLength));
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
                const matrix = new Float32Array(words.buffer, slot * 64, 16);
                if (device.SetTransform(transformType(slot), matrix) !== 0)
                {
                    refused++;
                    deps.divergence?.('IDirect3DDevice8::SetTransform',
                        `type ${transformType(slot)} set in the guest was accepted;`
                        + ' the device refuses it');
                }
            }
        },

        diagnostics: ()=>({
            // Numbers rather than booleans: a report keeps a flat structure of
            // numbers and drops anything else.
            placed: address !== 0 ? 1 : 0,
            slowPath: slow ? 1 : 0,
            // What never crossed into the host, which is the point of all this.
            renderStateCalls: calls.renderStates,
            transformCalls: calls.transforms,
            refused,
        }),
    };
}
