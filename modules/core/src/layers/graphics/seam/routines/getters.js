/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The getters a device answers in the guest, from the block its setters and
 * the host keep: render, sampler and stage states, transforms, the viewport,
 * the scissor rectangle, shaders, targets, a texture's levels and their descriptions.
 */

import {
    EAX, EBX, ECX, EDI, EDX, ESI, I386, dword, getterPrologue, invalidTail, letHeldGo, prologue,
    routine, takeHeld,
} from './assemble.js';
import { FLAG_SLOW_PATH, SHADOW, SURFACE, TEXTURE, WORLD_SLOT, WORLD_TYPE } from '../block.js';

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
 * @param {number} at @param {number} trap @param {import('./assemble.js').Width} [width]
 * @returns {Uint8Array}
 */
export function getRenderStateCode(at, trap, width = I386){
    return routine(at, trap, [
        ...getterPrologue(width),
        width.arg(EAX, 1),                                       // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.RENDER_STATE_COUNT)],             // cmp eax, 256
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0x0f, 0xa3, 0x81, ...dword(SHADOW.RENDER_STATE_VALID)], // bt [ecx+disp], eax
        { jcc: 0x73, to: 'slow' },                               // jnc slow
        width.pointer(EDX, 2),                                       // mov edx, [esp+12]
        width.testPointer(EDX),                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x84, 0x81, ...dword(SHADOW.RENDER_STATES)],      // mov eax, [ecx+eax*4+disp]
        [0x89, 0x02],                                            // mov [edx], eax
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(3),                                            // ret 12
    ], {}, width);
}

/** The transform types below WORLD a device answers for: VIEW, PROJECTION, TEXTURE0..7. */
export const ANSWERED_TRANSFORMS = (1 << 2 | 1 << 3 | 0xff << 16) >>> 0;
/** Direct3D 7's: WORLD, VIEW, PROJECTION, WORLD1..3 and TEXTURE0..7. */
export const TRANSFORMS_7 = (0x7e | 0xff << 16) >>> 0;

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
export function getTransformCode(at, trap, version7 = false, width = I386){
    return routine(at, trap, [
        ...getterPrologue(width),
        width.arg(EAX, 1),                                       // mov eax, [esp+8]
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
        width.pointer(EDX, 2),                                       // mov edx, [esp+12]
        width.testPointer(EDX),                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        width.save([ESI, EDI]),                                  // push esi; push edi
        width.movePointer(EDI, EDX),                             // mov edi, edx
        [0x89, 0xc6],                                            // mov esi, eax
        [0xc1, 0xe6, 0x06],                                      // shl esi, 6
        [0x8d, 0xb4, 0x31, ...dword(SHADOW.TRANSFORMS)],         // lea esi, [ecx+esi+disp]
        [0xb9, ...dword(16)],                                    // mov ecx, 16
        [0xf3, 0xa5],                                            // rep movsd
        width.restore([EDI, ESI]),                               // pop edi; pop esi
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(3),                                       // ret 12
    ], {}, width);
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
export function getTextureStageStateCode(at, trap, types, width = I386){
    return routine(at, trap, [
        ...getterPrologue(width),
        width.arg(EAX, 2),                                       // mov eax, [esp+12]
        [0x3d, ...dword(SHADOW.STAGE_STATE_STRIDE)],             // cmp eax, 32
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0xba, ...dword(types)],                                 // mov edx, imm32
        [0x0f, 0xa3, 0xc2],                                      // bt edx, eax
        { jcc: 0x73, to: 'slow' },                               // jnc slow
        width.arg(EAX, 1),                                       // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.STAGE_COUNT)],                    // cmp eax, 8
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0xc1, 0xe0, 0x05],                                      // shl eax, 5
        width.argOp([0x03], EAX, 2),                             // add eax, [esp+12]
        width.pointer(EDX, 3),                                       // mov edx, [esp+16]
        width.testPointer(EDX),                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x84, 0x81, ...dword(SHADOW.STAGE_STATES)],       // mov eax, [ecx+eax*4+disp]
        [0x89, 0x02],                                            // mov [edx], eax
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(4),                                       // ret 16
    ], {}, width);
}

/**
 * A getter that copies a run of the block's dwords out, as guest code: the
 * block holds what the device holds, which a setter's routine keeps and the
 * host mirrors whenever it changes it itself (a render target, a reset, a
 * state block). A null pointer and the host's flag go to the host.
 *
 *     (prologue)
 *     mov edx, [esp+8]            ; out
 *     test edx, edx
 *     jz slow
 *     push esi
 *     push edi
 *     lea esi, [ecx + from]
 *     mov edi, edx
 *     mov ecx, dwords
 *     rep movsd
 *     pop edi
 *     pop esi
 *     xor eax, eax                ; D3D_OK
 *     ret 8
 *
 * @param {number} at @param {number} trap @param {number} from @param {number} dwords
 * @param {import('./assemble.js').Width} width
 * @returns {Uint8Array}
 */
function copyOutCode(at, trap, from, dwords, width){
    return routine(at, trap, [
        ...getterPrologue(width),
        width.pointer(EDX, 1),                                   // mov edx, [esp+8]
        width.testPointer(EDX),                                  // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        width.save([ESI, EDI]),                                  // push esi; push edi
        [0x8d, 0xb1, ...dword(from)],                            // lea esi, [ecx+disp]
        width.movePointer(EDI, EDX),                             // mov edi, edx
        [0xb9, ...dword(dwords)],                                // mov ecx, dwords
        [0xf3, 0xa5],                                            // rep movsd
        width.restore([EDI, ESI]),                               // pop edi; pop esi
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(2),                                            // ret 8
    ], {}, width);
}

/**
 * HRESULT GetViewport(this, D3DVIEWPORT *out), as guest code (`copyOutCode`).
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function getViewportCode(at, trap, width = I386){
    return copyOutCode(at, trap, SHADOW.VIEWPORT, 6, width);
}

/**
 * HRESULT GetScissorRect(this, RECT *out), as guest code (`copyOutCode`).
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function getScissorCode(at, trap, width = I386){
    return copyOutCode(at, trap, SHADOW.SCISSOR, 4, width);
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
export function getShaderCode(at, trap, which, width = I386){
    return routine(at, trap, [
        ...getterPrologue(width),
        [0x83, 0xb9, ...dword(SHADOW.SHADERS_VALID), 0x00],      // cmp dword [ecx+disp], 0
        { jcc: 0x74, to: 'slow' },                               // je slow
        width.pointer(EDX, 1),                                       // mov edx, [esp+8]
        width.testPointer(EDX),                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x81, ...dword(SHADOW.SHADERS + 4 * which)],      // mov eax, [ecx+disp]
        [0x89, 0x02],                                            // mov [edx], eax
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(2),                                       // ret 8
    ], {}, width);
}

/** D3DERR_NOTFOUND: no depth surface is set. */
const D3DERR_NOTFOUND = 0x88760866;

/**
 * HRESULT GetRenderTarget(this, [DWORD index,] IDirect3DSurface **out) or
 * GetDepthStencilSurface(this, IDirect3DSurface **out), as guest code: the
 * pointer the program was handed for the surface, out of the device's block
 * (`SHADOW.TARGETS`) once the host has said the pair there is the device's,
 * and the reference the call owes taken in the word the surface counts in. A
 * count at zero is a first reference, taken here for a surface whose first
 * reference is one on its device, the device's word moved with it; for any
 * other the step the host takes. A null
 * out-pointer, an index but the first and a pair the host has not written go
 * to the host. A depth pair of zeros is no depth surface: the out-pointer is
 * cleared, as the host clears it, and the answer is D3DERR_NOTFOUND.
 *
 *     (prologue)
 *     [cmp dword [esp+8], 0       ; Direct3D 9's index
 *      jne slow]
 *     mov edx, [esp+out]
 *     test edx, edx
 *     jz slow
 *     (take the device's lock through ECX, or slow)
 *     test dword [ecx+TARGETS_VALID], bit
 *     jz held
 *     push ebx
 *     mov ebx, [ecx + pair + 4]   ; the count's word
 *     mov eax, [ecx + pair]       ; the pointer
 *     test eax, eax
 *     jz none
 *     test ebx, ebx
 *     jz busy
 *   retry:
 *     mov eax, [ebx]
 *     test eax, eax
 *     jz first                    ; at zero: the owner's, or the host's
 *     lea edx, [eax+1]
 *     lock cmpxchg [ebx], edx
 *     jne retry
 *     mov eax, [ecx + pair]
 *     pop ebx
 *     mov dword [ecx+HELD], 0     ; let go before the program's pointer
 *     mov edx, [esp+out]
 *     mov [edx], eax
 *     xor eax, eax                ; D3D_OK
 *     ret n
 *   none:                         ; the depth pair only; a target's is the host's
 *     pop ebx
 *     mov dword [ecx+HELD], 0
 *     mov edx, [esp+out]
 *     mov dword [edx], 0
 *     mov eax, D3DERR_NOTFOUND
 *     ret n
 *   first:                        ; one on the device, as the count's AddRef takes it
 *     mov eax, [ecx + pair]
 *     mov eax, [eax + owner]      ; the interface's fourth word
 *     test eax, eax
 *     jz busy
 *     cmp dword [eax], 0
 *     je busy
 *     lock inc dword [eax]
 *     mov edx, 1
 *     xor eax, eax
 *     lock cmpxchg [ebx], edx
 *     je took
 *     mov eax, [ecx + pair]
 *     mov eax, [eax + owner]
 *     lock dec dword [eax]
 *     jmp retry
 *   busy:
 *     pop ebx
 *   held:
 *     mov dword [ecx+HELD], 0
 *     jmp slow
 *
 * @param {number} at @param {number} trap
 * @param {{ depth: boolean, indexed: boolean }} which  the depth surface or the
 *     target; whether the call names the target by index (Direct3D 9's)
 * @returns {Uint8Array}
 */
export function getTargetCode(at, trap, { depth, indexed }, width = I386){
    const out = indexed ? 2 : 1;
    const popped = indexed ? 12 : 8;
    const pair = SHADOW.TARGETS + (depth ? 8 : 0);
    /** The interface's fourth word, where the count's owner's word is (`vtable.js`). */
    const ownerAt = 3 * width.word;
    return routine(at, trap, [
        ...prologue('early', undefined, width),
        { jcc: 0xeb, to: 'body' },                               // jmp body
        { label: 'early' },
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        { label: 'body' },
        ...(indexed ? [
            [...width.argOp([0x83], 7, 1), 0x00],                // cmp dword [esp+8], 0
            { jcc: 0x75, to: 'slow', near: true },               // jne slow
        ] : []),
        width.pointer(EDX, out),                                     // mov edx, [esp+out]
        width.testPointer(EDX),                                            // test edx, edx
        { jcc: 0x74, to: 'slow', near: true },                   // jz slow
        ...takeHeld(ECX, 'slow'),
        [0xf7, 0x81, ...dword(SHADOW.TARGETS_VALID), ...dword(depth ? 2 : 1)], // test [ecx+d], bit
        { jcc: 0x74, to: 'held', near: true },                   // jz held
        width.save([EBX]),                                       // push ebx
        [0x8b, 0x99, ...dword(pair + 4)],                        // mov ebx, [ecx+disp]
        [0x8b, 0x81, ...dword(pair)],                            // mov eax, [ecx+disp]
        [0x85, 0xc0],                                            // test eax, eax
        { jcc: 0x74, to: depth ? 'none' : 'busy', near: true },  // jz none
        [0x85, 0xdb],                                            // test ebx, ebx
        { jcc: 0x74, to: 'busy', near: true },                   // jz busy
        { label: 'retry' },
        [0x8b, 0x03],                                            // mov eax, [ebx]
        [0x85, 0xc0],                                            // test eax, eax
        { jcc: 0x74, to: 'first', near: true },                  // jz first
        [0x8d, 0x50, 0x01],                                      // lea edx, [eax+1]
        [0xf0, 0x0f, 0xb1, 0x13],                                // lock cmpxchg [ebx], edx
        { jcc: 0x75, to: 'retry' },                              // jne retry
        { label: 'took' },
        [0x8b, 0x81, ...dword(pair)],                            // mov eax, [ecx+disp]
        width.restore([EBX]),                                    // pop ebx
        letHeldGo(ECX),                                          // mov dword [ecx+HELD], 0
        width.pointer(EDX, out),                                 // mov edx, [esp+out]
        width.storePointer(EDX, EAX, 0),                         // mov [edx], eax
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(popped / 4),                                   // ret n
        ...(depth ? [
            { label: 'none' },
            width.restore([EBX]),                                // pop ebx
            letHeldGo(ECX),                                      // mov dword [ecx+HELD], 0
            width.pointer(EDX, out),                             // mov edx, [esp+out]
            [...(width.word === 8 ? [0x48] : []), 0xc7, 0x02, ...dword(0)], // mov [edx], 0
            [0xb8, ...dword(D3DERR_NOTFOUND)],                   // mov eax, D3DERR_NOTFOUND
            width.ret(popped / 4),                               // ret n
        ] : []),
        // The first reference of a surface whose first reference is one on
        // its device (`ReferenceCount.owner`): the device's word moved
        // first, and back if the count's move fails, as the count's AddRef.
        // In EAX: EDX is where the program's pointer is written, plainly.
        { label: 'first' },
        [0x8b, 0x81, ...dword(pair)],                            // mov eax, [ecx+disp]
        [0x8b, 0x40, ownerAt],                                   // mov eax, [eax+owner]
        [0x85, 0xc0],                                            // test eax, eax
        { jcc: 0x74, to: 'busy', near: true },                   // jz busy
        [0x83, 0x38, 0x00],                                      // cmp dword [eax], 0
        { jcc: 0x74, to: 'busy', near: true },                   // je busy
        [0xf0, 0xff, 0x00],                                      // lock inc dword [eax]
        [0xba, ...dword(1)],                                     // mov edx, 1
        [0x31, 0xc0],                                            // xor eax, eax
        [0xf0, 0x0f, 0xb1, 0x13],                                // lock cmpxchg [ebx], edx
        { jcc: 0x74, to: 'took', near: true },                   // je took
        [0x8b, 0x81, ...dword(pair)],                            // mov eax, [ecx+disp]
        [0x8b, 0x40, ownerAt],                                   // mov eax, [eax+owner]
        [0xf0, 0xff, 0x08],                                      // lock dec dword [eax]
        { jcc: 0xeb, to: 'retry', near: true },                  // jmp retry
        { label: 'busy' },
        width.restore([EBX]),                                    // pop ebx
        { label: 'held' },
        letHeldGo(ECX),                                          // mov dword [ecx+HELD], 0
    ], {}, width);
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
export function getSurfaceDescCode(at, trap, width = I386){
    return routine(at, trap, [
        ...prologue('slow', undefined, width),
        width.pointer(EDX, 1),                                       // mov edx, [esp+8]
        width.testPointer(EDX),                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        width.save([ESI, EDI]),                                  // push esi; push edi
        [0x8d, 0x71, SURFACE.DESC],                              // lea esi, [ecx+4]
        width.movePointer(EDI, EDX),                             // mov edi, edx
        [0xb9, ...dword(SURFACE.DESC_WORDS)],                    // mov ecx, 8
        [0xf3, 0xa5],                                            // rep movsd
        width.restore([EDI, ESI]),                               // pop edi; pop esi
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(2),                                       // ret 8
    ], {}, width);
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
export function getSamplerStateCode(at, trap, width = I386){
    return routine(at, trap, [
        ...getterPrologue(width),
        width.arg(EAX, 2),                                       // mov eax, [esp+12]
        [0x3d, ...dword(SHADOW.SAMPLER_STATE_STRIDE)],           // cmp eax, 16
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0xba, ...dword(SAMPLER_STATE_TYPES)],                   // mov edx, imm32
        [0x0f, 0xa3, 0xc2],                                      // bt edx, eax
        { jcc: 0x73, to: 'slow' },                               // jnc slow
        width.arg(EAX, 1),                                       // mov eax, [esp+8]
        [0x3d, ...dword(SHADOW.SAMPLER_COUNT)],                  // cmp eax, 16
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0xc1, 0xe0, 0x04],                                      // shl eax, 4
        width.argOp([0x03], EAX, 2),                             // add eax, [esp+12]
        width.pointer(EDX, 3),                                       // mov edx, [esp+16]
        width.testPointer(EDX),                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0x8b, 0x84, 0x81, ...dword(SHADOW.SAMPLER_STATES)],     // mov eax, [ecx+eax*4+disp]
        [0x89, 0x02],                                            // mov [edx], eax
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(4),                                       // ret 16
    ], {}, width);
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
export function getSurfaceLevelCode(at, trap, width = I386){
    return routine(at, trap, [
        ...prologue('slow', undefined, width),
        width.arg(EAX, 1),                                       // mov eax, [esp+8]
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
        width.pointer(EAX, 2),                                       // mov eax, [esp+12]
        width.testPointer(EAX),                                            // test eax, eax
        { jcc: 0x74, to: 'slow' },                               // jz slow
        width.storePointer(EAX, EDX, 0),                         // mov [eax], edx
        [0xf0, 0xff, 0x01],                                      // lock inc dword [ecx]
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(3),                                       // ret 12
        ...invalidTail(12, width),
    ], {}, width);
}

/**
 * HRESULT GetLevelDesc(this, UINT level, D3DSURFACE_DESC *out), as guest
 * code for a texture: a level's description is its surface's, so it is read
 * out of the block of the surface the texture's table holds for that level
 * (`SURFACE.DESC`, one owner of it) rather than kept twice. A level the
 * texture has not got is refused here; one not published yet, a surface
 * without a block and a null pointer go to the host.
 *
 *     (prologue)
 *     mov eax, [esp+8]            ; level
 *     cmp eax, [ecx+LEVEL_COUNT]
 *     jae invalid
 *     cmp eax, LEVEL_SLOTS
 *     jae slow
 *     mov edx, [ecx + eax*4 + LEVELS]
 *     test edx, edx
 *     jz slow                     ; not published yet
 *     mov edx, [edx+4]            ; the surface's block
 *     test edx, edx
 *     jz slow
 *     test dword [edx], 1
 *     jnz slow
 *     mov eax, [esp+12]           ; out
 *     test eax, eax
 *     jz slow
 *     push esi
 *     push edi
 *     lea esi, [edx + DESC]
 *     mov edi, eax
 *     mov ecx, 8
 *     rep movsd
 *     pop edi
 *     pop esi
 *     xor eax, eax                ; D3D_OK
 *     ret 12
 *
 * @param {number} at @param {number} trap
 * @returns {Uint8Array}
 */
export function getLevelDescCode(at, trap, width = I386){
    return routine(at, trap, [
        ...prologue('slow', undefined, width),
        width.arg(EAX, 1),                                       // mov eax, [esp+8]
        [0x3b, 0x41, TEXTURE.LEVEL_COUNT],                       // cmp eax, [ecx+4]
        { jcc: 0x73, to: 'invalid' },                            // jae invalid
        [0x3d, ...dword(TEXTURE.LEVEL_SLOTS)],                   // cmp eax, 16
        { jcc: 0x73, to: 'slow' },                               // jae slow
        [0x8b, 0x94, 0x81, ...dword(TEXTURE.LEVELS)],            // mov edx, [ecx+eax*4+disp]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        width.blockOf(EDX, EDX),                                 // mov edx, [edx+4]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        [0xf7, 0x02, ...dword(FLAG_SLOW_PATH)],                  // test dword [edx], 1
        { jcc: 0x75, to: 'slow' },                               // jnz slow
        width.pointer(EAX, 2),                                       // mov eax, [esp+12]
        width.testPointer(EAX),                                            // test eax, eax
        { jcc: 0x74, to: 'slow' },                               // jz slow
        width.save([ESI, EDI]),                                  // push esi; push edi
        [0x8d, 0x72, SURFACE.DESC],                              // lea esi, [edx+4]
        width.movePointer(EDI, EAX),                             // mov edi, eax
        [0xb9, ...dword(SURFACE.DESC_WORDS)],                    // mov ecx, 8
        [0xf3, 0xa5],                                            // rep movsd
        width.restore([EDI, ESI]),                               // pop edi; pop esi
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(3),                                       // ret 12
        ...invalidTail(12, width),
    ], {}, width);
}

