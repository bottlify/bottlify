/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A buffer's and a texture level's Lock and Unlock in the guest: an address
 * handed back and a range remembered in the object's block, replayed by the
 * host when it next looks (`shadow.js`), and a dynamic buffer's DISCARD moved
 * onto another storage while draws still read the one it held.
 */

import {
    EAX, EBX, ECX, EDI, EDX, ESI, I386, assemble, dword, laidParts, letHeldGo, prologue, routine,
    takeHeld,
} from './assemble.js';
import {
    BUFFER, COMMAND, D3DLOCK_DISCARD, D3DLOCK_NOOVERWRITE, D3DLOCK_READONLY, FLAG_SLOW_PATH, LEVEL,
    LOCK_IN_PLACE, SHADOW, SURFACE, TEXTURE,
} from '../block.js';

/**
 * HRESULT Lock(this, UINT offset, UINT size, BYTE** out, DWORD flags), as
 * guest code for a vertex or index buffer. The address handed back is the
 * buffer's own storage; what is remembered is the range, as a union with
 * what was locked before the host last looked, and the flags.
 *
 * The cases left to the host: the device's lock held (`SHADOW.HELD`), a lock
 * of the buffer already held (the host refuses it), a lock for reading, an
 * empty or out-of-range lock, a null out-pointer -- and, while the device's
 * command ring holds a draw the host has not made, any lock without
 * NOOVERWRITE: the bytes that draw reads are the buffer's until then, and the host
 * makes it before it takes the lock. A DISCARD with it promises nothing about
 * those bytes, and the buffer has one storage. So too while what was unlocked
 * may be lent to the graphics worker: the host claims it before the program
 * writes over it. The device's lock is let go before the program's pointer is
 * written, which may fault. A lock with both DISCARD and NOOVERWRITE is a
 * NOOVERWRITE, taken in place and remembered without the DISCARD (Wine's
 * `wined3d_resource_sanitise_map_flags`; its d3d8 and d3d9
 * test_map_synchronisation find such a lock unsynchronised).
 *
 * Unless, for a DISCARD alone, the buffer has another storage the host has let
 * go of (`SPARES`, `SPARE_FREE`; `renameSlot` given): then the buffer moves
 * onto it here, the move goes into the device's command ring (`Buffer.Rename`,
 * the buffer's pointer and the storage) for the host to make after the draws
 * before it, the storage left takes the spare's place, and the lock goes on as
 * a NOOVERWRITE of the new storage -- the flags the host replays it with. Not
 * while a lock the host replays before the ring's run is in the block
 * (`LOCK_IN_PLACE`, which the lock sets for anything without NOOVERWRITE),
 * nor for a lock the host refuses: the move would hold that replay back past
 * the draws after it, or move a buffer whose lock failed.
 *
 * What the buffer held outside the lock comes along (`copyAt`, `moveCopyCode`):
 * the host's DISCARD keeps the buffer's storage, as a driver hands the same
 * memory back once the GPU is done with it, and a program may draw after a
 * DISCARD what it wrote before it past the range it locked -- from a storage
 * that held another lap's bytes there, had the move left them. Inside the
 * lock the program writes; a DISCARD of the whole buffer copies nothing. The
 * copy is code a slice may end inside, which this routine is not, so the
 * routine goes on to it once the lock is taken, the storage left in the slot
 * of `this`.
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
 *     test eax, NOOVERWRITE
 *     jnz free
 *     cmp eax, DISCARD            ; with renameSlot, else jmp held
 *     jne held
 *     test dword [ecx+LOCK_FLAGS], LOCK_IN_PLACE
 *     jnz held
 *     mov eax, [esp+12]           ; the checks at `free`, before the move
 *     test eax, eax
 *     jnz sizedMove
 *     mov eax, [ecx+LENGTH]
 *     sub eax, [esp+8]
 *   sizedMove:
 *     test eax, eax
 *     jz held
 *     add eax, [esp+8]
 *     jc held
 *     cmp eax, [ecx+LENGTH]
 *     ja held
 *     cmp dword [esp+16], 0
 *     je held
 *     cmp dword [ecx+SPARE_FREE], 0
 *     jne first
 *     cmp dword [ecx+SPARE_FREE+4], 0
 *     je held
 *     mov eax, 4
 *     jmp move
 *   first:
 *     xor eax, eax
 *   move:
 *     push ebx
 *     push esi
 *     mov ebx, eax                ; which spare, as a byte offset
 *     cmp dword [edx+COMMANDS], 0
 *     je full
 *   reserve:                      ; the record: slot, 16, this, storage
 *     mov eax, [edx+COMMAND_HEAD]
 *     lea esi, [eax+16]
 *     cmp esi, [edx+COMMAND_BYTES]
 *     ja full
 *     lock cmpxchg [edx+COMMAND_HEAD], esi
 *     jne reserve
 *     add eax, [edx+COMMANDS]
 *     mov dword [eax+SLOT], renameSlot
 *     mov esi, [esp+12]           ; this, two words further for the pushes
 *     mov [eax+ARGS], esi
 *     mov esi, [ecx+ebx+SPARES]
 *     mov [eax+ARGS+4], esi
 *     xchg esi, [ecx+BASE]        ; the move: the storage left in the spare's place
 *     mov [ecx+ebx+SPARES], esi
 *     mov [esp+12], esi           ; and in the slot of this, for the copy
 *     mov dword [ecx+ebx+SPARE_FREE], 0
 *     mov dword [ecx+LENT], 0     ; the new storage was never lent
 *     mov dword [eax+BYTES], 16   ; the record counts from here
 *     mov dword [esp+28], NOOVERWRITE
 *     pop esi
 *     pop ebx
 *     jmp free
 *   full:
 *     pop esi
 *     pop ebx
 *     jmp held
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
 *     test ebx, NOOVERWRITE
 *     jz inPlace
 *     and ebx, ~DISCARD           ; with NOOVERWRITE, a NOOVERWRITE
 *     jmp alone
 *   inPlace:
 *     or ebx, LOCK_IN_PLACE
 *   alone:
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
 *     mov edx, [esp+4]            ; this, or the storage a move left (with renameSlot)
 *     cmp edx, [ecx+SPARES]
 *     je moved
 *     cmp edx, [ecx+SPARES+4]
 *     je moved
 *     xor eax, eax
 *     ret 20
 *   moved:
 *     jmp copyAt                  ; EAX the address handed out
 *
 * @param {number} at @param {number} trap
 * @param {number} [renameSlot]  `Buffer.Rename`'s slot in the device's ring; without it a
 *     DISCARD under draws or over lent bytes is always the host's
 * @param {number} [copyAt]  where `moveCopyCode` is, with `renameSlot`
 * @param {import('./assemble.js').Width} [width]
 * @returns {Uint8Array}
 */
export function lockCode(at, trap, renameSlot, copyAt, width = I386){
    if (renameSlot !== undefined && copyAt === undefined)
    {
        throw new Error('shadow: a lock routine that moves a buffer needs the copy it goes on to');
    }
    /** The move onto a spare storage, for a DISCARD alone: the comment's, from `guarded`. */
    const move = renameSlot === undefined ? [{ jcc: 0xeb, to: 'held' }] : [
        [0x3d, ...dword(D3DLOCK_DISCARD)],                       // cmp eax, 0x2000
        { jcc: 0x75, to: 'held' },                               // jne held
        [0xf7, 0x41, BUFFER.LOCK_FLAGS, ...dword(LOCK_IN_PLACE)], // test dword [ecx+24], imm
        { jcc: 0x75, to: 'held' },                               // jnz held
        width.arg(EAX, 2),                                       // mov eax, [esp+12]
        [0x85, 0xc0],                                            // test eax, eax
        { jcc: 0x75, to: 'sizedMove' },                          // jnz sizedMove
        [0x8b, 0x41, BUFFER.LENGTH],                             // mov eax, [ecx+8]
        width.argOp([0x2b], EAX, 1),                             // sub eax, [esp+8]
        { label: 'sizedMove' },
        [0x85, 0xc0],                                            // test eax, eax
        { jcc: 0x74, to: 'held' },                               // jz held
        width.argOp([0x03], EAX, 1),                             // add eax, [esp+8]
        { jcc: 0x72, to: 'held' },                               // jc held
        [0x3b, 0x41, BUFFER.LENGTH],                             // cmp eax, [ecx+8]
        { jcc: 0x77, to: 'held' },                               // ja held
        [...width.pointerOp([0x83], 7, 3), 0x00],                // cmp dword [esp+16], 0
        { jcc: 0x74, to: 'held' },                               // je held
        [0x83, 0x79, BUFFER.SPARE_FREE, 0x00],                   // cmp dword [ecx+48], 0
        { jcc: 0x75, to: 'first' },                              // jne first
        [0x83, 0x79, BUFFER.SPARE_FREE + 4, 0x00],               // cmp dword [ecx+52], 0
        { jcc: 0x74, to: 'held' },                               // je held
        [0xb8, ...dword(4)],                                     // mov eax, 4
        { jcc: 0xeb, to: 'move' },                               // jmp move
        { label: 'first' },
        [0x31, 0xc0],                                            // xor eax, eax
        { label: 'move' },
        width.save([EBX, ESI]),                                  // push ebx; push esi
        [0x89, 0xc3],                                            // mov ebx, eax
        [0x83, 0xba, ...dword(SHADOW.COMMANDS), 0x00],           // cmp dword [edx+disp], 0
        { jcc: 0x74, to: 'full' },                               // je full
        { label: 'reserve' },
        [0x8b, 0x82, ...dword(SHADOW.COMMAND_HEAD)],             // mov eax, [edx+disp]
        [0x8d, 0x70, COMMAND.ARGS + 8],                          // lea esi, [eax+16]
        [0x3b, 0xb2, ...dword(SHADOW.COMMAND_BYTES)],            // cmp esi, [edx+disp]
        { jcc: 0x77, to: 'full' },                               // ja full
        [0xf0, 0x0f, 0xb1, 0xb2, ...dword(SHADOW.COMMAND_HEAD)], // lock cmpxchg [edx+disp], esi
        { jcc: 0x75, to: 'reserve' },                            // jne reserve
        [0x03, 0x82, ...dword(SHADOW.COMMANDS)],                 // add eax, [edx+disp]
        [0xc7, 0x40, COMMAND.SLOT, ...dword(renameSlot)],        // mov dword [eax], slot
        width.arg(ESI, 0, 2),                                    // mov esi, [esp+12]
        [0x89, 0x70, COMMAND.ARGS],                              // mov [eax+8], esi
        [0x8b, 0x74, 0x19, BUFFER.SPARES],                       // mov esi, [ecx+ebx+40]
        [0x89, 0x70, COMMAND.ARGS + 4],                          // mov [eax+12], esi
        [0x87, 0x71, BUFFER.BASE],                               // xchg esi, [ecx+4]
        [0x89, 0x74, 0x19, BUFFER.SPARES],                       // mov [ecx+ebx+40], esi
        width.argOp([0x89], ESI, 0, 2),                          // mov [esp+12], esi
        [0xc7, 0x44, 0x19, BUFFER.SPARE_FREE, ...dword(0)],      // mov dword [ecx+ebx+48], 0
        [0xc7, 0x41, BUFFER.LENT, ...dword(0)],                  // mov dword [ecx+32], 0
        // The record whole, published with `xchg` as every record's length is.
        [0xbe, ...dword(COMMAND.ARGS + 8)],                      // mov esi, 16
        [0x87, 0x70, COMMAND.BYTES],                             // xchg [eax+4], esi
        [...width.argOp([0xc7], 0, 4, 2), ...dword(D3DLOCK_NOOVERWRITE)], // [esp+28] = imm
        width.restore([ESI, EBX]),                               // pop esi; pop ebx
        { jcc: 0xeb, to: 'free' },                               // jmp free
        { label: 'full' },
        width.restore([ESI, EBX]),                               // pop esi; pop ebx
        { jcc: 0xeb, to: 'held' },                               // jmp held
    ];
    const parts = [
        ...prologue('early', FLAG_SLOW_PATH, width),
        { jcc: 0xeb, to: 'body' },                               // jmp body
        { label: 'early' },
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        { label: 'body' },
        [0x8b, 0x51, BUFFER.DEVICE],                             // mov edx, [ecx+28]
        ...takeHeld(EDX, 'slow'),
        [0x83, 0x79, BUFFER.LOCKED, 0x00],                       // cmp dword [ecx+12], 0
        { jcc: 0x75, to: 'held' },                               // jne held
        [...width.argOp([0xf7], 0, 4), ...dword(D3DLOCK_READONLY)], // test dword [esp+20], 0x10
        { jcc: 0x75, to: 'held' },                               // jnz held
        [0x83, 0xba, ...dword(SHADOW.DRAWS_PENDING), 0x00],      // cmp dword [edx+disp], 0
        { jcc: 0x75, to: 'guarded' },                            // jne guarded
        [0x83, 0x79, BUFFER.LENT, 0x00],                         // cmp dword [ecx+32], 0
        { jcc: 0x74, to: 'free' },                               // je free
        { label: 'guarded' },
        width.arg(EAX, 4),                                       // mov eax, [esp+20]
        [0x25, ...dword(D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD)], // and eax, 0x3000
        [0xa9, ...dword(D3DLOCK_NOOVERWRITE)],                   // test eax, 0x1000
        { jcc: 0x75, to: 'free' },                               // jnz free
        ...move,
        { label: 'free' },
        width.arg(EAX, 1),                                       // mov eax, [esp+8]
        width.arg(EDX, 2),                                       // mov edx, [esp+12]
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
        [...width.pointerOp([0x83], 7, 3), 0x00],                // cmp dword [esp+16], 0
        { jcc: 0x74, to: 'held' },                               // je held
        { jcc: 0xeb, to: 'take' },                               // jmp take
        { label: 'held' },
        [0x8b, 0x41, BUFFER.DEVICE],                             // mov eax, [ecx+28]
        letHeldGo(0),                                            // mov dword [eax+HELD], 0
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        { label: 'take' },
        width.save([EBX]),                                       // push ebx
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
        width.arg(EBX, 4, 1),                                    // mov ebx, [esp+24]
        [0xf7, 0xc3, ...dword(D3DLOCK_NOOVERWRITE)],             // test ebx, 0x1000
        { jcc: 0x74, to: 'inPlace' },                            // jz inPlace
        [0x81, 0xe3, ...dword(~D3DLOCK_DISCARD >>> 0)],          // and ebx, ~0x2000
        { jcc: 0xeb, to: 'alone' },                              // jmp alone
        { label: 'inPlace' },
        [0x81, 0xcb, ...dword(LOCK_IN_PLACE)],                   // or ebx, imm
        { label: 'alone' },
        [0x09, 0x59, BUFFER.LOCK_FLAGS],                         // or [ecx+24], ebx
        [0x03, 0x41, BUFFER.BASE],                               // add eax, [ecx+4]
        [0xc7, 0x41, BUFFER.LOCKED, ...dword(1)],                // mov dword [ecx+12], 1
        [0x8b, 0x59, BUFFER.DEVICE],                             // mov ebx, [ecx+28]
        [0x8b, 0x93, ...dword(SHADOW.LOCK_CALLS)],               // mov edx, [ebx+disp]
        [0x83, 0xe2, SHADOW.LOCK_RING_CAPACITY - 1],             // and edx, 15
        [0x89, 0x8c, 0x93, ...dword(SHADOW.LOCK_RING)],          // mov [ebx+edx*4+disp], ecx
        [0xff, 0x83, ...dword(SHADOW.LOCK_CALLS)],               // inc dword [ebx+disp]
        letHeldGo(EBX),                                          // mov dword [ebx+HELD], 0
        width.pointer(EBX, 3, 1),                                // mov ebx, [esp+20]
        width.storePointer(EBX, EAX, 0),                         // mov [ebx], eax
        width.restore([EBX]),                                    // pop ebx
        ...(renameSlot === undefined ? [] : [
            width.arg(EDX, 0),                                   // mov edx, [esp+4]
            [0x3b, 0x51, BUFFER.SPARES],                         // cmp edx, [ecx+40]
            { jcc: 0x74, to: 'moved' },                          // je moved
            [0x3b, 0x51, BUFFER.SPARES + 4],                     // cmp edx, [ecx+44]
            { jcc: 0x74, to: 'moved' },                          // je moved
        ]),
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(5),                                            // ret 20
    ];
    if (renameSlot === undefined)
    {
        return routine(at, trap, parts, {}, width);
    }
    // The move puts the checks further from their targets than a byte reaches.
    return routine(at, trap, parts.map(part=>(
        'jcc' in part && part.jcc !== 0xeb ? { ...part, near: true } : part)),
    { moved: /** @type {number} */ (copyAt) }, width);
}

/**
 * The rest of a Lock whose routine moved the buffer (`lockCode`): what the
 * buffer held outside the lock, copied from the storage left into the new
 * one, and counted in the device's block (`MOVE_COPIED`). Code a slice may
 * end inside, as the routine is not: a copy of most of a buffer of hundreds
 * of kilobytes is more than the steps that finish a routine take. The lock is
 * taken and the device's lock let go of already; nothing else writes either
 * storage while the program holds the lock, and the new one's pages are the
 * GPU's to upload from here as draws reach them, whenever the ring's move is
 * made. Entered with EAX the address handed out, ECX the buffer's block, and
 * the storage left in the slot of `this` - in a 64-bit process the home
 * slot of RCX, which the routine's entry filled and the move wrote over.
 *
 *     push esi
 *     push edi
 *     push ebx
 *     mov edx, [ecx+LENGTH]
 *     mov ebx, [esp+24]           ; size, three words further for the pushes
 *     test ebx, ebx
 *     jnz sized
 *     mov ebx, edx
 *     sub ebx, [esp+20]           ; zero: to the end
 *   sized:
 *     mov edi, eax
 *     sub edi, [esp+20]           ; the new storage
 *     mov esi, [esp+16]           ; the storage left
 *     sub edx, ebx                ; the bytes outside the lock
 *     mov eax, [ecx+DEVICE]
 *     lock add [eax+MOVE_COPIED], edx
 *     jnc counted
 *     lock inc dword [eax+MOVE_COPIED+4]
 *   counted:
 *     mov ecx, [esp+20]           ; offset: the bytes before the lock
 *     cld
 *     rep movsb
 *     add esi, ebx
 *     add edi, ebx                ; past the lock
 *     mov ecx, edx
 *     sub ecx, [esp+20]           ; the bytes after it
 *     rep movsb
 *     pop ebx
 *     pop edi
 *     pop esi
 *     xor eax, eax
 *     ret 20
 *
 * @param {import('./assemble.js').Width} [width]  the routine's that goes on to it
 * @returns {Uint8Array}
 */
export function moveCopyCode(width = I386){
    return assemble(laidParts([
        width.save([ESI, EDI, EBX]),                             // push esi; push edi; push ebx
        [0x8b, 0x51, BUFFER.LENGTH],                             // mov edx, [ecx+8]
        width.arg(EBX, 2, 3),                                    // mov ebx, [esp+24]
        [0x85, 0xdb],                                            // test ebx, ebx
        { jcc: 0x75, to: 'sized' },                              // jnz sized
        [0x89, 0xd3],                                            // mov ebx, edx
        width.argOp([0x2b], EBX, 1, 3),                          // sub ebx, [esp+20]
        { label: 'sized' },
        [0x89, 0xc7],                                            // mov edi, eax
        width.argOp([0x2b], EDI, 1, 3),                          // sub edi, [esp+20]
        width.arg(ESI, 0, 3),                                    // mov esi, [esp+16]
        [0x29, 0xda],                                            // sub edx, ebx
        [0x8b, 0x41, BUFFER.DEVICE],                             // mov eax, [ecx+28]
        [0xf0, 0x01, 0x90, ...dword(SHADOW.MOVE_COPIED)],        // lock add [eax+disp], edx
        { jcc: 0x73, to: 'counted' },                            // jnc counted
        [0xf0, 0xff, 0x80, ...dword(SHADOW.MOVE_COPIED + 4)],    // lock inc dword [eax+disp]
        { label: 'counted' },
        width.arg(ECX, 1, 3),                                    // mov ecx, [esp+20]
        [0xfc],                                                  // cld
        [0xf3, 0xa4],                                            // rep movsb
        [0x01, 0xde],                                            // add esi, ebx
        [0x01, 0xdf],                                            // add edi, ebx
        [0x89, 0xd1],                                            // mov ecx, edx
        width.argOp([0x2b], ECX, 1, 3),                          // sub ecx, [esp+20]
        [0xf3, 0xa4],                                            // rep movsb
        width.restore([EBX, EDI, ESI]),                          // pop ebx; pop edi; pop esi
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(5),                                            // ret 20
    ], width));
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
 *     test dword [esp+8], NOOVERWRITE   ; with DISCARD too, a NOOVERWRITE
 *     jz held
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
 *     test ebx, NOOVERWRITE
 *     jz alone
 *     and ebx, ~DISCARD           ; with NOOVERWRITE, a NOOVERWRITE
 *   alone:
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
        [0xf7, 0x44, 0x24, 0x08, ...dword(D3DLOCK_NOOVERWRITE)], // test dword [esp+8], 0x1000
        { jcc: 0x74, to: 'held' },                               // jz held
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
        [0xf7, 0xc3, ...dword(D3DLOCK_NOOVERWRITE)],             // test ebx, 0x1000
        { jcc: 0x74, to: 'alone' },                              // jz alone
        [0x81, 0xe3, ...dword(~D3DLOCK_DISCARD >>> 0)],          // and ebx, ~0x2000
        { label: 'alone' },
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
 * device's ring for the host to find, once until the host empties it; the
 * device's lock held, a full ring, or no lock to release, is the host's.
 *
 *     mov edx, [ecx+DEVICE]
 *     (take the device's lock through EDX, or slow)
 *     cmp dword [ecx+LOCKED], 0
 *     je held
 *     cmp dword [ecx+QUEUED], 0
 *     jne queued                  ; on the ring already
 *     mov eax, [edx+RING_HEAD]
 *     cmp eax, RING_CAPACITY
 *     jae held
 *     mov [edx + eax*4 + RING], ecx
 *     inc dword [edx+RING_HEAD]
 *     mov dword [ecx+QUEUED], 1
 *   queued:
 *     mov dword [ecx+LOCKED], 0
 *     inc dword [edx+UNLOCK_CALLS]
 *     mov dword [edx+HELD], 0
 *     xor eax, eax
 *     ret 4
 *   held:
 *     mov dword [edx+HELD], 0     ; and on to the host
 *
 * @param {number} at @param {number} trap @param {import('./assemble.js').Width} [width]
 * @returns {Uint8Array}
 */
export function unlockCode(at, trap, width = I386){
    return routine(at, trap, [
        ...prologue('slow', FLAG_SLOW_PATH, width),
        [0x8b, 0x51, BUFFER.DEVICE],                             // mov edx, [ecx+28]
        // A Direct3D 7 buffer no device's block has taken yet: the host's.
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'slow' },                               // jz slow
        ...takeHeld(EDX, 'slow'),
        [0x83, 0x79, BUFFER.LOCKED, 0x00],                       // cmp dword [ecx+12], 0
        { jcc: 0x74, to: 'held' },                               // je held
        [0x83, 0x79, BUFFER.QUEUED, 0x00],                       // cmp dword [ecx+36], 0
        { jcc: 0x75, to: 'queued' },                             // jne queued
        [0x8b, 0x82, ...dword(SHADOW.RING_HEAD)],                // mov eax, [edx+disp]
        [0x3d, ...dword(SHADOW.RING_CAPACITY)],                  // cmp eax, 64
        { jcc: 0x73, to: 'held' },                               // jae held
        [0x89, 0x8c, 0x82, ...dword(SHADOW.RING)],               // mov [edx+eax*4+disp], ecx
        [0xff, 0x82, ...dword(SHADOW.RING_HEAD)],                // inc dword [edx+disp]
        [0xc7, 0x41, BUFFER.QUEUED, ...dword(1)],                // mov dword [ecx+36], 1
        { label: 'queued' },
        [0xc7, 0x41, BUFFER.LOCKED, ...dword(0)],                // mov dword [ecx+12], 0
        [0xff, 0x82, ...dword(SHADOW.UNLOCK_CALLS)],             // inc dword [edx+disp]
        letHeldGo(EDX),                                          // mov dword [edx+HELD], 0
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(1),                                            // ret 4
        { label: 'held' },
        letHeldGo(EDX),                                          // mov dword [edx+HELD], 0
    ], {}, width);
}

/**
 * The level a texture's or a surface's lock names, its block into ECX
 * (`LEVEL`), from the object's block the prologue left there: a texture's
 * table of them (`TEXTURE.LOCKS`) at the level its first argument names, or
 * a surface's own. No block, or the host's flag on it, leaves for `slow`.
 *
 *   texture:
 *     mov eax, [esp+8]            ; level
 *     cmp eax, [ecx+LEVEL_COUNT]
 *     jae slow                    ; the host refuses it
 *     cmp eax, LEVEL_SLOTS
 *     jae slow
 *     mov ecx, [ecx + eax*4 + LOCKS]
 *   surface:
 *     mov ecx, [ecx+LEVEL]
 *   both:
 *     test ecx, ecx
 *     jz slow
 *     test dword [ecx], 1
 *     jnz slow
 *
 * @param {'texture' | 'surface'} find @param {string} slow
 * @param {import('./assemble.js').Width} width
 * @returns {(number[] | { jcc: number, to: string })[]}
 */
const findLevel = (find, slow, width)=>[
    ...(find === 'texture'
        ? [
            width.arg(EAX, 1),                                   // mov eax, [esp+8]
            [0x3b, 0x41, TEXTURE.LEVEL_COUNT],                   // cmp eax, [ecx+4]
            { jcc: 0x73, to: slow },                             // jae slow
            [0x3d, ...dword(TEXTURE.LEVEL_SLOTS)],               // cmp eax, 16
            { jcc: 0x73, to: slow },                             // jae slow
            [0x8b, 0x8c, 0x81, ...dword(TEXTURE.LOCKS)],         // mov ecx, [ecx+eax*4+disp]
        ]
        : [[0x8b, 0x49, SURFACE.LEVEL]]),                        // mov ecx, [ecx+40]
    [0x85, 0xc9],                                                // test ecx, ecx
    { jcc: 0x74, to: slow },                                     // jz slow
    [0xf7, 0x01, ...dword(FLAG_SLOW_PATH)],                      // test dword [ecx], 1
    { jcc: 0x75, to: slow },                                     // jnz slow
];

/**
 * HRESULT LockRect(this, [UINT level,] D3DLOCKED_RECT *out, const RECT *rect,
 * DWORD flags) of a texture or a surface, and HRESULT LockBox(this, UINT
 * level, D3DLOCKED_BOX *out, const D3DBOX *box, DWORD flags) of a volume
 * texture, as guest code for a level with a block (`LEVEL`). The address
 * handed back is the level's own bytes at the rectangle or box, which is
 * kept with the flags for the host to replay the lock with at its next
 * entry; the block goes on the device's ring of blocks to settle at once,
 * so a lock held across an entry is the host's from then on too.
 *
 * The cases left to the host: the device's lock held, a lock of the level
 * already held, one the host has not replayed yet (a second would leave it
 * one box to replay for two), a null out-pointer, a full ring, a rectangle
 * or box that is empty or leaves the level -- which the
 * versions answer differently -- and, for a level a draw may read, a draw in
 * the device's command ring the host has not made: it reads the bytes the
 * program would write over. The device's lock is let go before the
 * program's out-pointer is written, which may fault.
 *
 *     (the object's block, then the level's: slow)
 *     mov edx, [ecx+DEVICE]
 *     (take the device's lock through EDX, or slow)
 *     cmp dword [ecx+LOCKED], 0
 *     jne held
 *     cmp dword [ecx+TAKEN], 0
 *     jne held
 *     cmp dword [ecx+SAMPLED], 0
 *     je unsampled
 *     cmp dword [edx+DRAWS_PENDING], 0
 *     jne held
 *   unsampled:
 *     cmp dword [ecx+QUEUED], 0
 *     jne room
 *     cmp dword [edx+RING_HEAD], RING_CAPACITY
 *     jae held
 *   room:
 *     cmp dword [esp+out], 0
 *     je held
 *     push ebx; push esi; push edi
 *     mov esi, [esp+rect+12]
 *     xor ebx, ebx                ; the byte offset of what is locked
 *     mov [ecx+BOXED], ebx
 *     test esi, esi
 *     jz take                     ; all of it
 *     (right <= WIDTH, left < right, bottom <= HEIGHT, top < bottom,
 *      [back <= DEPTH, front < back], unsigned: or refused)
 *     ebx = left*TEXEL_BYTES + top*ROW_PITCH [+ front*SLICE_PITCH]
 *     (the rectangle or box into BOX, a rectangle one slice deep)
 *     mov dword [ecx+BOXED], 1
 *   take:
 *     mov eax, [esp+flags+12]
 *     mov [ecx+LOCK_FLAGS], eax
 *     mov dword [ecx+LOCKED], 1
 *     mov dword [ecx+TAKEN], 1
 *     mov edx, [ecx+DEVICE]
 *     cmp dword [ecx+QUEUED], 0
 *     jne queued
 *     mov eax, [edx+RING_HEAD]
 *     mov [edx + eax*4 + RING], ecx
 *     inc dword [edx+RING_HEAD]
 *     mov dword [ecx+QUEUED], 1
 *   queued:
 *     mov dword [edx+HELD], 0
 *     mov eax, ebx
 *     add eax, [ecx+BASE]
 *     mov edi, [esp+out+12]
 *     (ROW_PITCH [, SLICE_PITCH], then the address, into [edi])
 *     pop edi; pop esi; pop ebx
 *     xor eax, eax
 *     ret 4*args
 *   refused:
 *     pop edi; pop esi; pop ebx
 *   held:
 *     mov eax, [ecx+DEVICE]
 *     mov dword [eax+HELD], 0     ; and on to the host
 *
 * @param {number} at @param {number} trap
 * @param {{ find: 'texture' | 'surface', box?: boolean }} kind  a box only for a texture
 * @param {import('./assemble.js').Width} [width]
 * @returns {Uint8Array}
 */
export function lockLevelCode(at, trap, { find, box = false }, width = I386){
    // Which arguments the out-pointer, the rectangle or box and the flags are.
    const out = find === 'texture' ? 2 : 1;
    const rect = out + 1;
    const flags = out + 2;
    /** `mov eax, [esi+from]; mov [ecx+to], eax`. @param {number} from @param {number} to */
    const copy = (from, to)=>[[0x8b, 0x46, from], [0x89, 0x41, to]];
    return routine(at, trap, [
        ...prologue('early', FLAG_SLOW_PATH, width),
        ...findLevel(find, 'early', width),
        { jcc: 0xeb, to: 'body' },                               // jmp body
        { label: 'early' },
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        { label: 'body' },
        [0x8b, 0x51, LEVEL.DEVICE],                              // mov edx, [ecx+28]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'early' },                              // jz early
        ...takeHeld(EDX, 'slow'),
        [0x83, 0x79, LEVEL.LOCKED, 0x00],                        // cmp dword [ecx+12], 0
        { jcc: 0x75, to: 'held', near: true },                   // jne held
        [0x83, 0x79, LEVEL.TAKEN, 0x00],                         // cmp dword [ecx+16], 0
        { jcc: 0x75, to: 'held', near: true },                   // jne held
        [0x83, 0x79, LEVEL.SAMPLED, 0x00],                       // cmp dword [ecx+56], 0
        { jcc: 0x74, to: 'unsampled' },                          // je unsampled
        [0x83, 0xba, ...dword(SHADOW.DRAWS_PENDING), 0x00],      // cmp dword [edx+disp], 0
        { jcc: 0x75, to: 'held', near: true },                   // jne held
        { label: 'unsampled' },
        [0x83, 0x79, LEVEL.QUEUED, 0x00],                        // cmp dword [ecx+36], 0
        { jcc: 0x75, to: 'room' },                               // jne room
        [0x81, 0xba, ...dword(SHADOW.RING_HEAD), ...dword(SHADOW.RING_CAPACITY)], // cmp [edx+d], 64
        { jcc: 0x73, to: 'held', near: true },                   // jae held
        { label: 'room' },
        [...width.pointerOp([0x83], 7, out), 0x00],              // cmp dword [esp+out], 0
        { jcc: 0x74, to: 'held', near: true },                   // je held
        width.save([EBX, ESI, EDI]),                             // push ebx; push esi; push edi
        width.pointer(ESI, rect, 3),                             // mov esi, [esp+rect+12]
        [0x31, 0xdb],                                            // xor ebx, ebx
        [0x89, 0x59, LEVEL.BOXED],                               // mov [ecx+60], ebx
        width.testPointer(ESI),                                  // test esi, esi
        { jcc: 0x74, to: 'take', near: true },                   // jz take
        [0x8b, 0x46, 0x08],                                      // mov eax, [esi+8]: right
        [0x3b, 0x41, LEVEL.WIDTH],                               // cmp eax, [ecx+40]
        { jcc: 0x77, to: 'refused', near: true },                // ja refused
        [0x39, 0x06],                                            // cmp [esi], eax: left
        { jcc: 0x73, to: 'refused', near: true },                // jae refused
        [0x8b, 0x46, 0x0c],                                      // mov eax, [esi+12]: bottom
        [0x3b, 0x41, LEVEL.HEIGHT],                              // cmp eax, [ecx+44]
        { jcc: 0x77, to: 'refused', near: true },                // ja refused
        [0x39, 0x46, 0x04],                                      // cmp [esi+4], eax: top
        { jcc: 0x73, to: 'refused', near: true },                // jae refused
        ...(box
            ? [
                [0x8b, 0x46, 0x14],                              // mov eax, [esi+20]: back
                [0x3b, 0x41, LEVEL.DEPTH],                       // cmp eax, [ecx+48]
                { jcc: 0x77, to: 'refused', near: true },        // ja refused
                [0x39, 0x46, 0x10],                              // cmp [esi+16], eax: front
                { jcc: 0x73, to: 'refused', near: true },        // jae refused
            ]
            : []),
        [0x8b, 0x1e],                                            // mov ebx, [esi]
        [0x0f, 0xaf, 0x59, LEVEL.TEXEL_BYTES],                   // imul ebx, [ecx+52]
        [0x8b, 0x46, 0x04],                                      // mov eax, [esi+4]
        [0x0f, 0xaf, 0x41, LEVEL.ROW_PITCH],                     // imul eax, [ecx+20]
        [0x01, 0xc3],                                            // add ebx, eax
        ...(box
            ? [
                [0x8b, 0x46, 0x10],                              // mov eax, [esi+16]
                [0x0f, 0xaf, 0x41, LEVEL.SLICE_PITCH],           // imul eax, [ecx+32]
                [0x01, 0xc3],                                    // add ebx, eax
            ]
            : []),
        ...[0, 4, 8, 12].flatMap(offset=>copy(offset, LEVEL.BOX + offset)),
        ...(box
            ? [...copy(16, LEVEL.BOX + 16), ...copy(20, LEVEL.BOX + 20)]
            : [
                [0xc7, 0x41, LEVEL.BOX + 16, ...dword(0)],       // mov dword [ecx+80], 0
                [0xc7, 0x41, LEVEL.BOX + 20, ...dword(1)],       // mov dword [ecx+84], 1
            ]),
        [0xc7, 0x41, LEVEL.BOXED, ...dword(1)],                  // mov dword [ecx+60], 1
        { label: 'take' },
        width.arg(EAX, flags, 3),                                // mov eax, [esp+flags+12]
        [0x89, 0x41, LEVEL.LOCK_FLAGS],                          // mov [ecx+24], eax
        [0xc7, 0x41, LEVEL.LOCKED, ...dword(1)],                 // mov dword [ecx+12], 1
        [0xc7, 0x41, LEVEL.TAKEN, ...dword(1)],                  // mov dword [ecx+16], 1
        [0x8b, 0x51, LEVEL.DEVICE],                              // mov edx, [ecx+28]
        [0x83, 0x79, LEVEL.QUEUED, 0x00],                        // cmp dword [ecx+36], 0
        { jcc: 0x75, to: 'queued' },                             // jne queued
        [0x8b, 0x82, ...dword(SHADOW.RING_HEAD)],                // mov eax, [edx+disp]
        [0x89, 0x8c, 0x82, ...dword(SHADOW.RING)],               // mov [edx+eax*4+disp], ecx
        [0xff, 0x82, ...dword(SHADOW.RING_HEAD)],                // inc dword [edx+disp]
        [0xc7, 0x41, LEVEL.QUEUED, ...dword(1)],                 // mov dword [ecx+36], 1
        { label: 'queued' },
        letHeldGo(EDX),                                          // mov dword [edx+HELD], 0
        [0x89, 0xd8],                                            // mov eax, ebx
        [0x03, 0x41, LEVEL.BASE],                                // add eax, [ecx+4]
        width.pointer(EDI, out, 3),                              // mov edi, [esp+out+12]
        [0x8b, 0x51, LEVEL.ROW_PITCH],                           // mov edx, [ecx+20]
        [0x89, 0x17],                                            // mov [edi], edx
        // pBits after the pitch, or after the two of a box: a pointer, at 4 in a
        // 32-bit process's D3DLOCKED_RECT and at 8, aligned, in a 64-bit one's.
        ...(box
            ? [
                [0x8b, 0x51, LEVEL.SLICE_PITCH],                 // mov edx, [ecx+32]
                [0x89, 0x57, 0x04],                              // mov [edi+4], edx
                width.storePointer(EDI, EAX, 8),                 // mov [edi+8], eax
            ]
            : [width.storePointer(EDI, EAX, width.word)]),       // mov [edi+4], eax
        width.restore([EDI, ESI, EBX]),                          // pop edi; pop esi; pop ebx
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(flags + 1),                                    // ret: this and the arguments
        { label: 'refused' },
        width.restore([EDI, ESI, EBX]),                          // pop edi; pop esi; pop ebx
        { label: 'held' },
        [0x8b, 0x41, LEVEL.DEVICE],                              // mov eax, [ecx+28]
        letHeldGo(0),                                            // mov dword [eax+HELD], 0
    ], {}, width);
}

/**
 * HRESULT UnlockRect(this, [UINT level]) of a texture or a surface, and
 * HRESULT UnlockBox(this, UINT level) of a volume texture, as guest code for
 * a level with a block: the buffers' Unlock (`unlockCode`), less their count
 * of unlocks, which a level's lock does not keep either.
 *
 * @param {number} at @param {number} trap
 * @param {{ find: 'texture' | 'surface' }} kind
 * @param {import('./assemble.js').Width} [width]
 * @returns {Uint8Array}
 */
export function unlockLevelCode(at, trap, { find }, width = I386){
    return routine(at, trap, [
        ...prologue('early', FLAG_SLOW_PATH, width),
        ...findLevel(find, 'early', width),
        { jcc: 0xeb, to: 'body' },                               // jmp body
        { label: 'early' },
        { jcc: 0xeb, to: 'slow', near: true },                   // jmp slow
        { label: 'body' },
        [0x8b, 0x51, LEVEL.DEVICE],                              // mov edx, [ecx+28]
        [0x85, 0xd2],                                            // test edx, edx
        { jcc: 0x74, to: 'early' },                              // jz early
        ...takeHeld(EDX, 'slow'),
        [0x83, 0x79, LEVEL.LOCKED, 0x00],                        // cmp dword [ecx+12], 0
        { jcc: 0x74, to: 'held' },                               // je held
        [0x83, 0x79, LEVEL.QUEUED, 0x00],                        // cmp dword [ecx+36], 0
        { jcc: 0x75, to: 'queued' },                             // jne queued
        [0x8b, 0x82, ...dword(SHADOW.RING_HEAD)],                // mov eax, [edx+disp]
        [0x3d, ...dword(SHADOW.RING_CAPACITY)],                  // cmp eax, 64
        { jcc: 0x73, to: 'held' },                               // jae held
        [0x89, 0x8c, 0x82, ...dword(SHADOW.RING)],               // mov [edx+eax*4+disp], ecx
        [0xff, 0x82, ...dword(SHADOW.RING_HEAD)],                // inc dword [edx+disp]
        [0xc7, 0x41, LEVEL.QUEUED, ...dword(1)],                 // mov dword [ecx+36], 1
        { label: 'queued' },
        [0xc7, 0x41, LEVEL.LOCKED, ...dword(0)],                 // mov dword [ecx+12], 0
        letHeldGo(EDX),                                          // mov dword [edx+HELD], 0
        [0x31, 0xc0],                                            // xor eax, eax
        width.ret(find === 'texture' ? 2 : 1),                   // ret 8 or 4
        { label: 'held' },
        letHeldGo(EDX),                                          // mov dword [edx+HELD], 0
    ], {}, width);
}

