/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MMX and SSE in the evaluator (plan step 5.2, the family order of
 * `emit/simd.js`). This first piece is the bitwise family and `emms`, which
 * every corpus preamble needs; the arithmetic, compares, shuffles and
 * conversions follow.
 *
 * An XMM register is four words on the state; an MMX register is the low
 * sixty-four bits of a physical x87 register, so `state.f80bits` is read and
 * written directly and the two views stay one machine. An instruction with an
 * `mm` operand leaves the stack in the MMX state (top zero, every register
 * held), as the emitter's tracker does.
 */

/** @param {import('./decode/decoder.js').Instruction} instruction */
export function isSimdOp(instruction){
    return instruction.op === 'emms'
        || instruction.operands.some(operand=>operand.kind === 'xmm' || operand.kind === 'mm');
}

/**
 * Reads an XMM, MMX or memory operand into `out`, `width` bytes.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {import('./decode/decoder.js').Operand} operand
 * @param {number} width @param {Uint8Array} out
 * @param {(operand: import('./decode/decoder.js').Operand) => number} address
 */
function readVec(state, operand, width, out, address){
    if (operand.kind === 'xmm')
    {
        const base = /** @type {number} */ (operand.reg) * 4;
        for (let i = 0; i < width; i++)
        {
            out[i] = state.xmm[base + (i >> 2)] >>> ((i & 3) * 8) & 0xff;
        }
        return;
    }
    if (operand.kind === 'mm')
    {
        const word = state.f80bits[/** @type {number} */ (operand.reg)];
        for (let i = 0; i < width; i++)
        {
            out[i] = Number(word >> BigInt(i * 8) & 0xffn);
        }
        return;
    }
    const at = address(operand);
    for (let i = 0; i < width; i++)
    {
        out[i] = state.memory.read(at + i, 1) & 0xff;
    }
}

/**
 * Writes `width` bytes to an XMM or MMX register.
 *
 * @param {import('./ir.js').EvalState} state
 * @param {import('./decode/decoder.js').Operand} operand
 * @param {number} width @param {Uint8Array} value
 */
function writeVec(state, operand, width, value){
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
    let word = 0n;
    for (let i = width - 1; i >= 0; i--)
    {
        word = word << 8n | BigInt(value[i] & 0xff);
    }
    state.f80bits[/** @type {number} */ (operand.reg)] = BigInt.asIntN(64, word);
}

/** @param {import('./ir.js').EvalState} state */
export function mmxState(state){
    state.top = 0;
    state.empty = 0;
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
    const isMm = operands.some(operand=>operand.kind === 'mm');
    const width = dst?.kind === 'mm' || src?.kind === 'mm' ? 8 : 16;
    /** @type {Uint8Array} */
    const a = new Uint8Array(16);
    /** @type {Uint8Array} */
    const b = new Uint8Array(16);

    switch (op)
    {
        case 'emms':
            state.empty = 0xff;
            return true;
        case 'andps': case 'andpd': case 'pand':
        case 'orps': case 'orpd': case 'por':
        case 'xorps': case 'xorpd': case 'pxor':
        case 'andnps': case 'andnpd': case 'pandn':
        {
            readVec(state, dst, width, a, address);
            readVec(state, src, width, b, address);
            const mode = op.startsWith('andn') || op === 'pandn' ? 2
                : op.startsWith('or') || op === 'por' ? 1 : 0;
            for (let i = 0; i < width; i++)
            {
                if (mode === 0)
                {
                    a[i] &= b[i];
                }
                else if (mode === 1)
                {
                    a[i] |= b[i];
                }
                else
                {
                    a[i] = ~a[i] & b[i];
                }
            }
            writeVec(state, dst, width, a);
            if (isMm)
            {
                mmxState(state);
            }
            return true;
        }
        default:
            return false;
    }
}
