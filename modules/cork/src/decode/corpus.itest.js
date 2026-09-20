/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The decoder against every image in the corpus: a linear decode from each
 * case's entry must land exactly on the footer's `hlt` with the `jmp` behind
 * it, having refused nothing on the way. A wrong length anywhere derails the
 * walk into the middle of an instruction and is caught by the byte it lands
 * on; an encoding the table lacks is caught by name.
 *
 * Needs the corpus (`npm run fetch:corpus`); no emulator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { decode } from './decoder.js';
import { loadCorpus } from '../testing/corpus.js';

const CORPUS = new URL('../../vendor/nasm-corpus.json.gz', import.meta.url);

test('a linear decode of every corpus case reaches its hlt, refusing nothing',
    { skip: !existsSync(CORPUS) && `missing ${CORPUS.href}` },
    async()=>{
        const { cases } = loadCorpus(await readFile(CORPUS));
        /** @type {string[]} */
        const failures = [];
        /** @type {Map<string, number>} */
        const refusals = new Map();
        /** @type {Map<string, number>} */
        const ops = new Map();
        let instructions = 0;
        const skipped = 0;
        let invalidNamed = 0;
        for (const one of cases)
        {
            const text = one.segments.find(
                s=>s.address <= one.entry && one.entry < s.address + s.bytes.length);
            if (!text)
            {
                failures.push(`${one.name}: entry outside every segment`);
                continue;
            }
            const end = text.address + text.bytes.length;
            /** @param {number} address */
            const read = address=>text.bytes[address - text.address] ?? 0;
            // A case the hardware killed with #UD holds an encoding that is
            // not an instruction; the decoder must say so at exactly that
            // address, and the walk ends there.
            const invalidAt = one.expected.exception === 'UD' ? one.expected.eip : -1;
            let eip = one.entry;
            let reached = false;
            for (let steps = 0; steps < 100_000 && eip < end; steps++)
            {
                const decoded = decode(read, eip);
                if ('refused' in decoded)
                {
                    if (eip === invalidAt && decoded.reason !== 'not user mode')
                    {
                        invalidNamed++;
                        reached = true;
                        break;
                    }
                    refusals.set(decoded.opcode, (refusals.get(decoded.opcode) ?? 0) + 1);
                    failures.push(`${one.name}: refused ${decoded.opcode} (${decoded.reason})`
                        + ` at 0x${eip.toString(16)}`);
                    break;
                }
                if (decoded.faults === 'invalid' && eip === invalidAt)
                {
                    invalidNamed++;
                    reached = true;
                    break;
                }
                if (eip === invalidAt)
                {
                    failures.push(`${one.name}: accepted ${decoded.opcode} as ${decoded.op}`
                        + ` at 0x${eip.toString(16)}, where the hardware raised #UD`);
                    break;
                }
                instructions++;
                ops.set(decoded.op, (ops.get(decoded.op) ?? 0) + 1);
                eip += decoded.length;
                if (decoded.op === 'hlt')
                {
                    // The footer: `hlt; jmp loop` -- the jump must be right behind.
                    if (read(eip) === 0xeb && read(eip + 1) === 0xfd)
                    {
                        reached = true;
                    }
                    else
                    {
                        failures.push(
                            `${one.name}: hlt at 0x${(eip - 1).toString(16)} is not the footer`);
                    }
                    break;
                }
            }
            if (!reached && !failures.some(f=>f.startsWith(`${one.name}:`)))
            {
                failures.push(
                    `${one.name}: the walk left the text at 0x${eip.toString(16)} without a hlt`);
            }
        }
        const top = [...refusals].sort((a, b)=>b[1] - a[1]).slice(0, 20)
            .map(([opcode, count])=>`${opcode}×${count}`).join(' ');
        console.log(`decoded ${instructions} instructions over ${cases.length - skipped} cases`
            + ` (${ops.size} distinct ops, ${skipped} skipped, ${invalidNamed} invalid encodings`
            + ` named where the hardware raised #UD); refusals: ${top || 'none'}`);
        assert.equal(failures.length, 0,
            `${failures.length} cases:\n${failures.slice(0, 40).join('\n')}`);
    });
