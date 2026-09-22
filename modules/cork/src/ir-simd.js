/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MMX and SSE in the evaluator (plan step 5.2, the family order of
 * `emit/simd.js`): the moves and the bitwise family first, which every corpus
 * preamble and teardown needs; the arithmetic, compares, shuffles and
 * conversions follow.
 *
 * An XMM register is four words on the state; an MMX register is the low
 * sixty-four bits of a physical x87 register (`state.f80bits`), so the two
 * views stay one machine. An instruction with an `mm` operand leaves the stack
 * in the MMX state (top zero, every register held), which the caller applies
 * after the operation.
 */

/** @param {import('./decode/decoder.js').Instruction} instruction */
export function isSimdOp(instruction){
    return instruction.op === 'emms'
        || instruction.operands.some(operand=>operand.kind === 'xmm' || operand.kind === 'mm');
}

/** @param {import('./ir.js').EvalState} state */
export function mmxState(state){
    state.top = 0;
    state.empty = 0;
}

/**
 * Reads an XMM, MMX or memory operand, `width` bytes.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {import('./decode/decoder.js').Operand} operand @param {number} width
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 * @returns {Uint8Array}
 */
function readVector(state, operand, width, address){
    const out = new Uint8Array(16);
    if (operand.kind === 'xmm')
    {
        const base = /** @type {number} */ (operand.reg) * 4;
        for (let i = 0; i < width; i++)
        {
            out[i] = state.xmm[base + (i >> 2)] >>> ((i & 3) * 8) & 0xff;
        }
    }
    else if (operand.kind === 'mm')
    {
        const word = state.f80bits[/** @type {number} */ (operand.reg)];
        for (let i = 0; i < width; i++)
        {
            out[i] = Number(word >> BigInt(i * 8) & 0xffn);
        }
    }
    else
    {
        const at = address(operand);
        for (let i = 0; i < width; i++)
        {
            out[i] = state.memory.read(at + i, 1) & 0xff;
        }
    }
    return out;
}

/**
 * Writes `width` bytes to an XMM, MMX or memory operand.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {import('./decode/decoder.js').Operand} operand @param {number} width
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 * @param {Uint8Array} value
 */
function writeVector(state, operand, width, address, value){
    if (operand.kind === 'xmm')
    {
        const base = /** @type {number} */ (operand.reg) * 4;
        for (let i = 0; i < width; i++)
        {
            const word = base + (i >> 2);
            const shift = (i & 3) * 8;
            state.xmm[word] = (state.xmm[word] & ~(0xff << shift)
                | (value[i] & 0xff) << shift) >>> 0;
        }
        return;
    }
    if (operand.kind === 'mm')
    {
        let word = 0n;
        for (let i = width - 1; i >= 0; i--)
        {
            word = word << 8n | BigInt(value[i] & 0xff);
        }
        state.f80bits[/** @type {number} */ (operand.reg)] = BigInt.asIntN(64, word);
        return;
    }
    const at = address(operand);
    for (let i = 0; i < width; i++)
    {
        state.memory.write(at + i, 1, value[i] & 0xff);
    }
}

/**
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {import('./ir.js').EvalState} state
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 * @returns {boolean}
 */
export function evaluateSimd(instruction, state, address){
    const { op, operands } = instruction;
    const [dst, src] = operands;
    const width = dst?.kind === 'mm' || src?.kind === 'mm' ? 8 : 16;
    const a = new Uint8Array(16);
    const b = new Uint8Array(16);

    switch (op)
    {
        case 'emms':
            state.empty = 0xff;
            return true;
        case 'movaps': case 'movups': case 'movapd': case 'movupd': case 'movdqa': case 'movdqu':
        case 'lddqu': case 'movntps': case 'movntpd': case 'movntdq':
            writeVector(state, dst, 16, address, readVector(state, src, 16, address));
            return true;
        case 'movss': case 'movsd':
        {
            const lane = op === 'movss' ? 4 : 8;
            if (dst.kind === 'xmm' && src.kind === 'xmm')
            {
                a.set(readVector(state, dst, 16, address));
                b.set(readVector(state, src, 16, address));
                a.set(b.subarray(0, lane), 0);
                writeVector(state, dst, 16, address, a);
                return true;
            }
            if (dst.kind === 'xmm')
            {
                a.fill(0);
                a.set(readVector(state, src, lane, address).subarray(0, lane), 0);
                writeVector(state, dst, 16, address, a);
                return true;
            }
            writeVector(state, dst, lane, address, readVector(state, src, 16, address));
            return true;
        }
        case 'movlps': case 'movlpd': case 'movhps': case 'movhpd':
        {
            const high = op.startsWith('movh');
            if (dst.kind === 'mem')
            {
                a.set(readVector(state, src, 16, address));
                writeVector(state, dst, 8, address, a.subarray(high ? 8 : 0, high ? 16 : 8));
                return true;
            }
            if (src.kind === 'mem')
            {
                a.set(readVector(state, dst, 16, address));
                b.set(readVector(state, src, 8, address));
                a.set(b.subarray(0, 8), high ? 8 : 0);
                writeVector(state, dst, 16, address, a);
                return true;
            }
            a.set(readVector(state, dst, 16, address));
            b.set(readVector(state, src, 16, address));
            if (high)
            {
                a.set(b.subarray(0, 8), 8);
            }
            else
            {
                a.set(b.subarray(8, 16), 0);
            }
            writeVector(state, dst, 16, address, a);
            return true;
        }
        case 'movd':
            if (dst.kind === 'xmm')
            {
                a.fill(0);
                a.set(readVector(state, src, 4, address).subarray(0, 4), 0);
                writeVector(state, dst, 16, address, a);
                return true;
            }
            if (dst.kind === 'mm')
            {
                a.fill(0);
                a.set(readVector(state, src, 4, address).subarray(0, 4), 0);
                writeVector(state, dst, 8, address, a);
                return true;
            }
            if (src.kind === 'xmm')
            {
                a.set(readVector(state, src, 16, address));
                writeVector(state, dst, dst.kind === 'mem' ? 4 : 4, address, a.subarray(0, 4));
            }
            else
            {
                a.set(readVector(state, src, 8, address));
                writeVector(state, dst, 4, address, a.subarray(0, 4));
            }
            return true;
        case 'movntq':
            writeVector(state, dst, 8, address, readVector(state, src, 8, address));
            return true;
        case 'movddup':
        {
            a.set(readVector(state, src, src.kind === 'mem' ? 8 : 16, address));
            a.set(a.subarray(0, 8), 8);
            writeVector(state, dst, 16, address, a);
            return true;
        }
        case 'movsldup': case 'movshdup':
        {
            b.set(readVector(state, src, 16, address));
            const lane = op === 'movsldup' ? 0 : 1;
            a.set(b.subarray(lane * 4, lane * 4 + 4), 0);
            a.set(b.subarray(lane * 4, lane * 4 + 4), 4);
            a.set(b.subarray((2 + lane) * 4, (2 + lane) * 4 + 4), 8);
            a.set(b.subarray((2 + lane) * 4, (2 + lane) * 4 + 4), 12);
            writeVector(state, dst, 16, address, a);
            return true;
        }
        case 'stmxcsr':
            address(dst);
            state.memory.write(address(dst), 4, state.mxcsr >>> 0);
            return true;
        case 'ldmxcsr':
            state.mxcsr = state.memory.read(address(dst), 4) >>> 0;
            return true;
        case 'movq':
            if (dst.kind === 'mm' || (dst.kind === 'mem' && src.kind === 'mm'))
            {
                writeVector(state, dst, 8, address, readVector(state, src, 8, address));
                return true;
            }
            if (dst.kind === 'xmm')
            {
                a.fill(0);
                a.set(readVector(state, src, 8, address).subarray(0, 8), 0);
                writeVector(state, dst, 16, address, a);
                return true;
            }
            writeVector(state, dst, 8, address, readVector(state, src, 16, address));
            return true;
        case 'movq2dq':
        {
            a.fill(0);
            a.set(readVector(state, src, 8, address).subarray(0, 8), 0);
            writeVector(state, dst, 16, address, a);
            return true;
        }
        case 'movdq2q':
        {
            a.set(readVector(state, src, 16, address));
            writeVector(state, dst, 8, address, a.subarray(0, 8));
            return true;
        }
        case 'andps': case 'andpd': case 'pand':
        case 'orps': case 'orpd': case 'por':
        case 'xorps': case 'xorpd': case 'pxor':
        case 'andnps': case 'andnpd': case 'pandn':
        {
            a.set(readVector(state, dst, width, address));
            b.set(readVector(state, src, width, address));
            const mode = op.startsWith('andn') || op === 'pandn' ? 2
                : op.startsWith('or') || op === 'por' ? 1 : 0;
            for (let i = 0; i < width; i++)
            {
                a[i] = mode === 0 ? a[i] & b[i] : mode === 1 ? a[i] | b[i] : ~a[i] & b[i];
            }
            writeVector(state, dst, width, address, a);
            return true;
        }
        default:
            return false;
    }
}
