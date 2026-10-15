/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The processors' gate: a program is told it has one processor for each of
 * its executors, the same number by every road an engine takes to size its
 * thread pool -- GetSystemInfo, the process block, CPUID's logical count,
 * NUMBER_OF_PROCESSORS, GetLogicalProcessorInformation's cores, the
 * registry's CentralProcessor keys -- and a thread pinned to a processor runs
 * there: CPUID's APIC id read after SetThreadAffinityMask is that processor's,
 * as Intel's way of counting cores relies on, for the thread pinning itself in
 * turn and for one pinned before it starts. One executor answers one, as
 * every program has been told so far.
 *
 * The program exits with a bit for each answer that was right.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text @returns {number[]} */
const z = text=>[...text].map(char=>char.charCodeAt(0)).concat(0);

const HKEY_LOCAL_MACHINE = 0x80000002;
const KEY_READ = 0x20019;
const CREATE_SUSPENDED = 4;
const WORKER_OFFSET = 0x400;
const GLPI_BYTES = 24 * 96;

/** The answers' bits, by what was asked. */
const BIT = Object.freeze({
    systemInfo: 1 << 0, processBlock: 1 << 1, cpuidCount: 1 << 2, environment: 1 << 3,
    cores: 1 << 4, pinnedBefore: 1 << 5, lastKey: 1 << 6, noKeyPast: 1 << 7,
    /** @param {number} processor */
    pinned: processor=>1 << 8 + processor,
});

/** @param {number} processors @returns {number} the bits of a program told the truth */
const allOf = processors=>Object.values(BIT).filter(bit=>typeof bit === 'number')
    .reduce((bits, bit)=>bits | /** @type {number} */ (bit), 0)
    | Array.from({ length: processors }, (_, index)=>BIT.pinned(index))
        .reduce((bits, bit)=>bits | bit, 0);

/**
 * The program, for a machine of `processors`: it asks, then compares each
 * answer with `processors` and exits with the bits of those that matched.
 *
 * @param {number} processors
 */
function buildAskingExe(processors){
    const keyOf = (/** @type {number} */ index)=>
        z(`HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\${index}`);
    return buildExe({
        imports: {
            'KERNEL32.dll': ['GetSystemInfo', 'GetCurrentThread', 'SetThreadAffinityMask',
                'GetEnvironmentVariableA', 'GetLogicalProcessorInformation', 'CreateThread',
                'ResumeThread', 'WaitForSingleObject', 'ExitProcess'],
            'ADVAPI32.dll': ['RegOpenKeyExA', 'RegCloseKey'],
        },
        codeSize: WORKER_OFFSET + 0x40,
        data: {
            systemInfo: new Array(36).fill(0), processBlock: [0, 0, 0, 0], logical: [0, 0, 0, 0],
            apic: new Array(4 * 32).fill(0), workerApic: [0xff, 0, 0, 0],
            variable: z('NUMBER_OF_PROCESSORS'), value: new Array(16).fill(0),
            glpiLength: u32(GLPI_BYTES), glpi: new Array(GLPI_BYTES).fill(0), cores: [0, 0, 0, 0],
            lastKey: keyOf(processors - 1), keyPast: keyOf(processors), key: [0, 0, 0, 0],
        },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** cmp dword [address], value; jne over; or edi, bit @param {number} address @param {number} value @param {number} bit */
            const check = (address, value, bit)=>[
                0x81, 0x3d, ...u32(address), ...u32(value), 0x75, 0x06, 0x81, 0xcf, ...u32(bit),
            ];
            /** RegOpenKeyExA(HKLM, [name], 0, KEY_READ, &key): eax the status @param {string} name */
            const open = name=>[
                0x68, ...u32(at('key')), 0x68, ...u32(KEY_READ), 0x6a, 0x00,
                0x68, ...u32(at(name)), 0x68, ...u32(HKEY_LOCAL_MACHINE), ...call('RegOpenKeyExA'),
            ];
            // mov eax, 1; xor ecx, ecx; cpuid; shr ebx, 24 -- the APIC id in ebx
            const apicId = [0xb8, ...u32(1), 0x31, 0xc9, 0x0f, 0xa2, 0xc1, 0xeb, 0x18];
            const pinEach = [
                0x31, 0xf6, //                                   xor esi, esi
                // L: cmp esi, processors; jae done
                0x81, 0xfe, ...u32(processors), 0x73, 0x00, // (patched below)
                // mov eax, 1; mov ecx, esi; shl eax, cl
                0xb8, ...u32(1), 0x89, 0xf1, 0xd3, 0xe0,
                0x50, ...call('GetCurrentThread'), 0x50, //       push mask; push GetCurrentThread()
                ...call('SetThreadAffinityMask'),
                ...apicId,
                0x89, 0x1c, 0xb5, ...u32(at('apic')), //         mov [apic + esi*4], ebx
                0x46, //                                         inc esi
                0xeb, 0x00, //                                   jmp L (patched below)
            ];
            const loopAt = 2;
            const exitAt = pinEach.length;
            pinEach[loopAt + 7] = exitAt - (loopAt + 8);
            pinEach[pinEach.length - 1] = (loopAt - pinEach.length) & 0xff;
            const coresCount = [
                0x8b, 0x0d, ...u32(at('glpiLength')), //          mov ecx, [glpiLength]
                0x31, 0xd2, //                                   xor edx, edx
                0xb8, ...u32(at('glpi')), //                      mov eax, glpi
                0x83, 0xf9, 0x18, 0x72, 0x0f, //                 G: cmp ecx, 24; jb end
                // cmp dword [eax+4], 0; jne +1; inc edx -- a core
                0x83, 0x78, 0x04, 0x00, 0x75, 0x01, 0x42,
                0x83, 0xc0, 0x18, 0x83, 0xe9, 0x18, //              add eax, 24; sub ecx, 24
                0xeb, 0xec, //                                      jmp G
                0x89, 0x15, ...u32(at('cores')), //            end: mov [cores], edx
            ];
            const main = [
                0x68, ...u32(at('systemInfo')), ...call('GetSystemInfo'),
                0x64, 0xa1, ...u32(0x30), //                      mov eax, fs:[0x30]
                0x8b, 0x40, 0x64, 0xa3, ...u32(at('processBlock')), // mov eax, [eax+0x64]; store
                0xb8, ...u32(1), 0x31, 0xc9, 0x0f, 0xa2, //       mov eax, 1; xor ecx, ecx; cpuid
                0xc1, 0xeb, 0x10, 0x0f, 0xb6, 0xc3, //            shr ebx, 16; movzx eax, bl
                0xa3, ...u32(at('logical')),
                0x6a, 0x10, 0x68, ...u32(at('value')), 0x68, ...u32(at('variable')),
                ...call('GetEnvironmentVariableA'),
                0x68, ...u32(at('glpiLength')), 0x68, ...u32(at('glpi')),
                ...call('GetLogicalProcessorInformation'),
                ...coresCount,
                ...pinEach,
                // CreateThread(NULL, 0, worker, NULL, CREATE_SUSPENDED, NULL), pinned
                // to the last processor before it runs, then let go and waited for
                0x6a, 0x00, 0x6a, CREATE_SUSPENDED, 0x6a, 0x00, 0x68, ...u32(code(WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'),
                0x89, 0xc3, //                                   mov ebx, eax
                0x68, ...u32(1 << processors - 1 >>> 0), 0x53, ...call('SetThreadAffinityMask'),
                0x53, ...call('ResumeThread'),
                0x6a, 0xff, 0x53, ...call('WaitForSingleObject'),
                0x31, 0xff, //                                   xor edi, edi
                ...check(at('systemInfo') + 20, processors, BIT.systemInfo),
                ...check(at('processBlock'), processors, BIT.processBlock),
                ...check(at('logical'), processors, BIT.cpuidCount),
                ...check(at('value'), 0x30 + processors, BIT.environment),
                ...check(at('cores'), processors, BIT.cores),
                ...check(at('workerApic'), processors - 1, BIT.pinnedBefore),
                ...Array.from({ length: processors }, (_, index)=>
                    check(at('apic') + 4 * index, index, BIT.pinned(index))).flat(),
                ...open('lastKey'), 0x85, 0xc0, 0x75, 0x06, 0x81, 0xcf, ...u32(BIT.lastKey),
                ...open('keyPast'), 0x85, 0xc0, 0x74, 0x06, 0x81, 0xcf, ...u32(BIT.noKeyPast),
                0x57, ...call('ExitProcess'), //                 ExitProcess(edi)
            ];
            const worker = [
                0x53, //                                         push ebx
                ...apicId,
                0x89, 0x1d, ...u32(at('workerApic')), //         mov [workerApic], ebx
                0x5b, 0x31, 0xc0, 0xc2, 0x04, 0x00, //           pop ebx; xor eax, eax; ret 4
            ];
            if (main.length > WORKER_OFFSET)
            {
                throw new Error(`the program's main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_OFFSET - main.length).fill(0x90), ...worker];
        },
    });
}

/**
 * @param {number} executors
 * @param {1 | 2} [concurrency]  2: the program in a process worker of its own, the run's
 *     registry the system's
 */
async function ask(executors, concurrency = 1){
    const app = await createApp({ executable: buildAskingExe(executors), cpu: { cores: executors },
        concurrency });
    try
    {
        return await app.run({ timeoutMs: 60_000 });
    }
    finally
    {
        await app.dispose();
    }
}

/** @param {number} bits @param {number} processors */
const missing = (bits, processors)=>Object.entries(BIT).flatMap(([name, bit])=>
    (typeof bit === 'number' ? (bits & bit) === 0 ? [name] : []
        : Array.from({ length: processors }, (_, index)=>
            ((bits & bit(index)) === 0 ? [`pinned to ${index}`] : [])).flat()));

test('a program in a process worker of its own on 2 executors is told of 2 processors, the'
    + ' run\'s registry among them', async()=>{
    const code = await ask(2, 2);
    assert.deepEqual(missing(code >>> 0, 2), [], `exit code 0x${(code >>> 0).toString(16)}`);
});

for (const executors of [1, 2, 4])
{
    test(`a program on ${executors} executor${executors > 1 ? 's' : ''} is told of as many`
        + ' processors everywhere, and a thread pinned to one runs there', async()=>{
        const code = await ask(executors);
        assert.deepEqual(missing(code >>> 0, executors), [],
            `exit code 0x${(code >>> 0).toString(16)}`);
        assert.equal(code >>> 0, allOf(executors));
    });
}
