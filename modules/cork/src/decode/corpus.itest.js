/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The decoder against every case of the hardware corpus: a linear decode of
 * each case's bytes must land exactly on the `hlt` that ends them, or on the
 * instruction the processor faulted at, refusing nothing on the way -- except
 * where the processor raised #UD, where the decoder must refuse too. A wrong
 * length anywhere derails the walk into the middle of an instruction and is
 * caught by the byte it lands on; an encoding the table lacks is caught by
 * name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from './decoder.js';
import { CORPUS_LAYOUT, loadX86Corpus } from '../testing/x86-corpus.js';

test('a linear decode of every corpus case reaches its hlt, refusing only where the processor did',
    ()=>{
        const cases = loadX86Corpus();
        /** @type {string[]} */
        const failures = [];
        /** @type {Set<string>} */
        const ops = new Set();
        let instructions = 0;
        let invalidNamed = 0;
        for (const one of cases)
        {
            const { CODE_AT } = CORPUS_LAYOUT;
            const end = CODE_AT + one.code.length - 1;
            /** @param {number} address */
            const read = address=>one.code[address - CODE_AT] ?? 0;
            // Up to the fault, where the processor stopped: what lies past it never ran.
            const invalidAt = one.fault?.vector === 6 ? one.fault.eip : -1;
            const last = one.fault ? one.fault.eip : end;
            let eip = CODE_AT;
            while (eip < end && eip <= last)
            {
                const decoded = decode(read, eip);
                if ('refused' in decoded)
                {
                    if (eip === invalidAt && decoded.reason !== 'not user mode')
                    {
                        invalidNamed++;
                    }
                    else
                    {
                        failures.push(`${one.name}: refused ${decoded.opcode} (${decoded.reason})`
                            + ` at 0x${eip.toString(16)}`);
                    }
                    break;
                }
                if (eip === invalidAt)
                {
                    if (decoded.faults === 'invalid')
                    {
                        invalidNamed++;
                    }
                    else
                    {
                        failures.push(`${one.name}: accepted ${decoded.opcode} as ${decoded.op}`
                            + ` at 0x${eip.toString(16)}, where the processor raised #UD`);
                    }
                    break;
                }
                instructions++;
                ops.add(decoded.op);
                eip += decoded.length;
                if (eip > end)
                {
                    failures.push(`${one.name}: ${decoded.op} ran past the case's end`
                        + ` to 0x${eip.toString(16)}`);
                }
            }
        }
        console.log(`decoded ${instructions} instructions over ${cases.length} cases`
            + ` (${ops.size} distinct ops, ${invalidNamed} invalid encodings named where the`
            + ' processor raised #UD)');
        assert.equal(failures.length, 0,
            `${failures.length} cases:\n${failures.slice(0, 40).join('\n')}`);
    });
