/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * volatile — a routine's bytes for a 64-bit process, on registers the caller
 * does not expect back.
 *
 * A 64-bit program's frames are unwound by the function table of the image
 * they run in; code with no entry there is a leaf to the unwinder: its return
 * address at RSP, and RBX, RBP, RSI, RDI and R12 to R15 as the caller left
 * them. The engine's routines have no entry, so that is what they must be,
 * at every instruction - a fault through a pointer of the program's, a thread
 * suspended and its stack walked, land anywhere in one.
 *
 * The routines are written once, on the i386's registers, and use EBX, ESI
 * and EDI where EAX, ECX and EDX do not suffice. For a 64-bit process each
 * instruction is laid out again with R9 for EBX, R10 for ESI and R11 for EDI
 * (`relaid`), which the convention lets a callee change, and the entry has
 * already put R9's argument into its home slot. `rep movs` reads RSI and RDI
 * by its definition and cannot be renamed: it becomes a loop over R10 and R11
 * (`copyLoop`), sixteen bytes a turn through XMM0, then its elements through
 * R8 - both the caller's to lose as well. Nothing is pushed, so RSP is the
 * caller's too.
 *
 * The decoder here knows the instructions the routines are written in and
 * refuses any other, loudly, where the routine is built: a form it would
 * misread is a routine nobody can run. `tools/checks/check-routine-leaves.mjs`
 * holds every routine's result to the rule with the translator's decoder.
 */

/** EBX, ESI and EDI to R9, R10 and R11: the number's low three bits. */
const RENAMED = Object.freeze({ 3: 1, 6: 2, 7: 3 });

/** One-byte opcodes whose ModR/M `reg` field extends the opcode. */
const GROUPS = new Set([0x80, 0x81, 0x83, 0x8f, 0xc0, 0xc1, 0xc6, 0xc7, 0xd0, 0xd1, 0xd2, 0xd3,
    0xf6, 0xf7, 0xfe, 0xff]);
/** One-byte opcodes of byte operands, where a register past 3 is AH to BH without REX. */
const BYTES = new Set([0x84, 0x86, 0x88, 0x8a, 0x80, 0xc0, 0xc6, 0xd0, 0xd2, 0xf6, 0xfe]);
/** One-byte opcodes that are whole by themselves. */
const ALONE = new Set([0x90, 0x98, 0x99, 0xc3, 0xcc, 0xf4, 0xf5, 0xf8, 0xf9, 0xfc]);
/** 0F-map opcodes with a ModR/M byte of general registers and no immediate. */
const TWO = new Set([0xa3, 0xab, 0xaf, 0xb1, 0xb3, 0xb6, 0xb7, 0xbb, 0xbe, 0xbf, 0xc1]);

/**
 * `rep movs` of `unit` bytes an element (ECX of them from [ESI] to [EDI],
 * forwards) as a loop on R10, R11, R8 and XMM0. It leaves what the string
 * instruction leaves in the three registers; the flags it does not keep.
 *
 *   wide:  cmp ecx, 16/unit ; jb rest
 *          movdqu xmm0, [r10] ; movdqu [r11], xmm0
 *          add r10, 16 ; add r11, 16 ; sub ecx, 16/unit ; jmp wide
 *   rest:  jrcxz done
 *   each:  mov r8, [r10] ; mov [r11], r8 ; add r10, unit ; add r11, unit ; loop each
 *   done:
 *
 * @param {1 | 4} unit
 */
const copyLoop = unit=>[
    0x83, 0xf9, 16 / unit, 0x72, 0x17,
    0xf3, 0x41, 0x0f, 0x6f, 0x02, 0xf3, 0x41, 0x0f, 0x7f, 0x03,
    0x49, 0x83, 0xc2, 0x10, 0x49, 0x83, 0xc3, 0x10, 0x83, 0xe9, 16 / unit, 0xeb, 0xe4,
    0xe3, 0x10,
    0x45, unit === 1 ? 0x8a : 0x8b, 0x02, 0x45, unit === 1 ? 0x88 : 0x89, 0x03,
    0x49, 0x83, 0xc2, unit, 0x49, 0x83, 0xc3, unit, 0xe2, 0xf0,
];

/**
 * A run of whole instructions with EBX, ESI and EDI renamed and `rep movs`
 * made a loop.
 *
 * @param {number[]} bytes
 * @returns {number[]}
 */
export function relaid(bytes){
    /** @type {number[]} */
    const out = [];
    /** @param {number} at @param {string} why @returns {never} */
    const refuse = (at, why)=>{
        throw new Error(`shadow: ${why} at byte ${at} of ${bytes.map(byte=>
            byte.toString(16).padStart(2, '0')).join(' ')}`);
    };
    for (let at = 0; at < bytes.length;)
    {
        const start = at;
        /** @type {number[]} */
        const prefixes = [];
        while ([0x66, 0xf0, 0xf2, 0xf3, 0x64, 0x65].includes(bytes[at]))
        {
            prefixes.push(bytes[at++]);
        }
        if (prefixes.includes(0xf3) && (bytes[at] === 0xa4 || bytes[at] === 0xa5))
        {
            out.push(...copyLoop(bytes[at] === 0xa4 ? 1 : 4));
            at++;
            continue;
        }
        const had = (bytes[at] & 0xf0) === 0x40;
        let rex = had ? bytes[at++] : 0x40;
        const wide = (rex & 8) !== 0;
        const word = prefixes.includes(0x66);
        let opcode = bytes[at++];
        const map = opcode === 0x0f;
        if (map)
        {
            opcode = bytes[at++];
        }
        /** The opcode's own register (its low three bits), renamed. @param {boolean} byte */
        const inOpcode = byte=>{
            const reg = opcode & 7;
            if ((rex & 1) === 0 && reg in RENAMED && !(byte && reg > 3))
            {
                opcode = opcode & ~7 | RENAMED[/** @type {3 | 6 | 7} */ (reg)];
                rex |= 1;
            }
            else if (byte && reg > 3 && (rex & 1) === 0)
            {
                refuse(start, 'AH to BH in a routine');
            }
        };
        let modrm = false;
        let immediate = 0;
        let group = false;
        let byteReg = false;
        let byteRm = false;
        if (map)
        {
            if (TWO.has(opcode))
            {
                modrm = true;
                byteRm = opcode === 0xb6 || opcode === 0xbe;
            }
            else if (opcode >= 0x40 && opcode < 0x50)
            {
                modrm = true;
            }
            else if (opcode >= 0x90 && opcode < 0xa0)
            {
                modrm = true;
                group = true;
                byteRm = true;
            }
            else if (opcode === 0xba)
            {
                modrm = true;
                group = true;
                immediate = 1;
            }
            else
            {
                refuse(start, `0f ${opcode?.toString(16)} is not an instruction a routine is laid`
                    + ' out by');
            }
        }
        else if (opcode < 0x40 && (opcode & 7) < 6)
        {
            modrm = (opcode & 7) < 4;
            byteReg = byteRm = modrm && (opcode & 1) === 0;
            immediate = (opcode & 7) === 4 ? 1 : (opcode & 7) === 5 ? word ? 2 : 4 : 0;
        }
        else if (GROUPS.has(opcode) || opcode >= 0x84 && opcode < 0x8e)
        {
            modrm = true;
            group = GROUPS.has(opcode);
            byteReg = byteRm = BYTES.has(opcode);
            immediate = [0x80, 0x83, 0xc0, 0xc1, 0xc6].includes(opcode) ? 1
                : opcode === 0x81 || opcode === 0xc7 ? word ? 2 : 4 : 0;
        }
        else if (opcode === 0x69 || opcode === 0x6b)
        {
            modrm = true;
            immediate = opcode === 0x6b ? 1 : word ? 2 : 4;
        }
        else if (opcode >= 0xb0 && opcode < 0xc0)
        {
            inOpcode(opcode < 0xb8);
            immediate = opcode < 0xb8 ? 1 : wide ? 8 : word ? 2 : 4;
        }
        else if (opcode >= 0x91 && opcode < 0x98)
        {
            inOpcode(false);
        }
        else if (opcode === 0xa8 || opcode === 0xa9 || opcode === 0x68 || opcode === 0x6a)
        {
            immediate = opcode === 0xa8 || opcode === 0x6a ? 1 : word ? 2 : 4;
        }
        else if (opcode === 0xe8 || opcode === 0xe9)
        {
            // A jump the routine's maker writes the distance of afterwards.
            immediate = 4;
        }
        else if (opcode === 0xc2)
        {
            immediate = 2;
        }
        else if (!ALONE.has(opcode))
        {
            refuse(start, `${opcode?.toString(16)} is not an instruction a routine is laid out`
                + ' by');
        }
        /** @type {number[]} */
        const operand = [];
        if (modrm)
        {
            let byte = bytes[at++];
            const mod = byte >>> 6;
            const reg = byte >>> 3 & 7;
            const rm = byte & 7;
            if ((opcode === 0xf6 || opcode === 0xf7) && !map && reg < 2)
            {
                immediate = opcode === 0xf6 ? 1 : word ? 2 : 4;
            }
            /** Whether a register field of `value` is renamed; AH to BH are refused.
             * @param {number} value @param {boolean} asByte @param {number} extended */
            const renames = (value, asByte, extended)=>{
                if ((rex & extended) !== 0)
                {
                    return false;
                }
                if (asByte && value > 3)
                {
                    return refuse(start, 'AH to BH in a routine');
                }
                return value in RENAMED;
            };
            if (!group && renames(reg, byteReg, 4))
            {
                byte = byte & ~0x38 | RENAMED[/** @type {3 | 6 | 7} */ (reg)] << 3;
                rex |= 4;
            }
            if (mod === 3)
            {
                if (renames(rm, byteRm, 1))
                {
                    byte = byte & ~7 | RENAMED[/** @type {3 | 6 | 7} */ (rm)];
                    rex |= 1;
                }
                operand.push(byte);
            }
            else if (rm === 4)
            {
                let sib = bytes[at++];
                const index = sib >>> 3 & 7;
                const base = sib & 7;
                if ((rex & 2) === 0 && index in RENAMED)
                {
                    sib = sib & ~0x38 | RENAMED[/** @type {3 | 6 | 7} */ (index)] << 3;
                    rex |= 2;
                }
                const based = !(base === 5 && mod === 0);
                if (based && (rex & 1) === 0 && base in RENAMED)
                {
                    sib = sib & ~7 | RENAMED[/** @type {3 | 6 | 7} */ (base)];
                    rex |= 1;
                }
                const disp = mod === 1 ? 1 : mod === 2 || !based ? 4 : 0;
                operand.push(byte, sib, ...bytes.slice(at, at + disp));
                at += disp;
            }
            else
            {
                const relative = mod === 0 && rm === 5;
                if (!relative && (rex & 1) === 0 && rm in RENAMED)
                {
                    byte = byte & ~7 | RENAMED[/** @type {3 | 6 | 7} */ (rm)];
                    rex |= 1;
                }
                const disp = mod === 1 ? 1 : mod === 2 || relative ? 4 : 0;
                operand.push(byte, ...bytes.slice(at, at + disp));
                at += disp;
            }
        }
        if (at + immediate > bytes.length)
        {
            refuse(start, 'an instruction cut short');
        }
        out.push(...prefixes, ...(had || rex !== 0x40 ? [rex] : []), ...(map ? [0x0f] : []),
            opcode, ...operand, ...bytes.slice(at, at + immediate));
        at += immediate;
    }
    return out;
}
