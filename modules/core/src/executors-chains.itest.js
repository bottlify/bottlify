/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of an executor keeping its thread past a slice:
 * while no ready thread waits for an executor, another executor runs its thread
 * slice after slice without a word to the process -- a word a slice cost as much
 * as the slice's own work, and 7-Zip's benchmark had the second of two
 * executors waiting on the process for over half its time.
 *
 * What it must not cost: a thread that sleeps on the process's own executor
 * wakes at its time, though the other executor says nothing until then; and a
 * thread suspended while it runs on another executor stops there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { EXECUTORS_OPENED_KEY } from './layers/cpu/module.js';
import { EXECUTORS_WAIT_MS } from './layers/kernel/internal/threads.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WORKER_OFFSET = 0x200;
/** CreateThread's flag: the thread made stopped, until ResumeThread. */
const CREATE_SUSPENDED = 4;

/**
 * A program of a main thread and a worker routine at `WORKER_OFFSET`.
 *
 * @param {string[]} imports  KERNEL32's, CreateThread among them
 * @param {Record<string, number[]>} data
 * @param {(tools: { call: (name: string) => number[], at: (name: string) => number,
 *     start: (slot: string, flags?: number) => number[] }) => { main: number[],
 *     worker: number[] }} parts
 */
function buildProgram(imports, data, parts){
    return buildExe({
        imports: { 'KERNEL32.dll': imports },
        codeSize: WORKER_OFFSET + 0x80,
        data,
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /**
             * CreateThread(NULL, 0, worker, NULL, flags, NULL), the handle to `slot`.
             * @param {string} slot @param {number} [flags]
             */
            const start = (slot, flags = 0)=>[
                0x6a, 0x00, 0x6a, flags, 0x6a, 0x00, 0x68, ...u32(code(WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at(slot)),
            ];
            const { main, worker } = parts({ call, at, start });
            if (main.length > WORKER_OFFSET)
            {
                throw new Error(`the program's main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_OFFSET - main.length).fill(0x90), ...worker];
        },
    });
}

/**
 * The exit code, and the scheduler's account.
 *
 * @param {Uint8Array} executable @param {number} cores
 */
async function run(executable, cores){
    const app = await createApp({ executable, cpu: { cores, eager: true } });
    try
    {
        const code = await app.run({ timeoutMs: 60_000 });
        const tables = await app.diagnostics();
        const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
        return { code: code >>> 0,
            scheduler: kernel?.metrics?.scheduler ?? kernel?.metrics ?? null };
    }
    finally
    {
        await app.dispose();
    }
}

/** Times round a worker's loop: 60 million instructions, a thousand quanta and more. */
const LOOPS = 30_000_000;

test('two threads computing on two executors keep them, not handing their thread back a slice'
    + ' at a time -- the one whose own executor is taken running on the process\'s', async()=>{
    // The main thread counts as a thread of the process's executor, so both
    // workers call the other executor theirs: one runs there, the other here.
    const executable = buildProgram(['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
        { first: [0, 0, 0, 0], second: [0, 0, 0, 0] }, ({ call, at, start })=>{
            /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
            const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                ...call('WaitForSingleObject')];
            return {
                main: [...start('first'), ...start('second'), ...wait('first'), ...wait('second'),
                    0x6a, 0x07, ...call('ExitProcess')],
                worker: [
                    0xb9, ...u32(LOOPS), //            mov ecx, LOOPS
                    0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                    0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
                ],
            };
        });
    const { code, scheduler } = await run(executable, 2);
    assert.equal(code, 7);
    assert.ok(scheduler?.mostAtOnce >= 2, 'both workers at once');
    // A slice a quantum would be six hundred; kept, a few, as the thread on the
    // process's executor moves to its own once the first is done.
    assert.ok(scheduler?.executorSlices > 0 && scheduler.executorSlices < 60,
        `${scheduler?.executorSlices} slices on the other executor`);
});

test('three threads computing on two executors take turns there a turn long, not a slice',
    async()=>{
        // One more thread than the executors: the other executor's is wanted by
        // a waiting thread at every slice's end. It gives it up when it has held
        // it a turn (`executorHoldMs`), not after each quantum, which took a
        // round trip through the process every 50 us and left it idle for
        // almost half its time.
        const executable = buildProgram(['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
            { first: [0, 0, 0, 0], second: [0, 0, 0, 0], third: [0, 0, 0, 0] },
            ({ call, at, start })=>{
                /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
                const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                    ...call('WaitForSingleObject')];
                return {
                    main: [...start('first'), ...start('second'), ...start('third'),
                        ...wait('first'), ...wait('second'), ...wait('third'),
                        0x6a, 0x07, ...call('ExitProcess')],
                    worker: [
                        0xb9, ...u32(LOOPS * 2), //        mov ecx, 2 * LOOPS
                        0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                        0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
                    ],
                };
            });
        const app = await createApp({ executable, cpu: { cores: 2, eager: true } });
        try
        {
            const began = performance.now();
            assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
            const ms = performance.now() - began;
            const tables = await app.diagnostics();
            const kernel = (Array.isArray(tables) ? tables : [])
                .find(table=>table.name === 'kernel');
            const scheduler = kernel?.metrics?.scheduler ?? kernel?.metrics;
            // A turn a millisecond is about one a millisecond; a quantum each, ten.
            assert.ok(scheduler?.executorSlices > 0 && scheduler.executorSlices < ms * 3,
                `${scheduler?.executorSlices} slices elsewhere in ${Math.round(ms)} ms`);
        }
        finally
        {
            await app.dispose();
        }
    });

test('a thread started while the first still ran, left alone when the first waits for it, comes'
    + ' to the process\'s own executor', async()=>{
    // Started while the main thread runs here, the worker goes to the other
    // executor; once the main thread waits, this one has nothing to run and
    // takes the worker over: its code is translated here for this executor's
    // own layout, and its calls into the host cross nothing.
    const executable = buildProgram(['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
        { first: [0, 0, 0, 0] }, ({ call, at, start })=>({
            main: [...start('first'), 0x6a, 0xff, 0xff, 0x35, ...u32(at('first')),
                ...call('WaitForSingleObject'), 0x6a, 0x07, ...call('ExitProcess')],
            worker: [
                0xb9, ...u32(LOOPS * 5), //        mov ecx, 5 * LOOPS
                0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
            ],
        }));
    const { code, scheduler } = await run(executable, 2);
    assert.equal(code, 7);
    const shared = JSON.parse(scheduler?.sharedTime ?? '{}');
    const here = shared.hereRetired ?? 0;
    const total = here + (shared.elsewhereRetired ?? 0);
    assert.ok(total >= LOOPS * 10, `${total} instructions`);
    // Three hundred million instructions: at most the one run elsewhere it was
    // placed in as it started, ended by this executor calling it back, and the
    // rest here -- not a chain of runs there. How far that run got before the
    // call back is the machine's to say: a busy one keeps this thread off its
    // core while the other runs on.
    const recalled = JSON.parse(scheduler?.recalls ?? '{}')['thread-2']?.recalled ?? 0;
    assert.ok(scheduler?.executorSlices <= 1 && recalled === scheduler?.executorSlices,
        `${scheduler?.executorSlices} runs on the other executor, ${recalled} called back;`
        + ` ${here} of ${total} instructions here`);
});

test('a program of one thread on a machine of four opens no executor past the process\'s own',
    async()=>{
        const executable = buildProgram(['ExitProcess'], {}, ({ call })=>({
            main: [
                0xb9, ...u32(LOOPS), //            mov ecx, LOOPS
                0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                0x6a, 0x07, ...call('ExitProcess'),
            ],
            worker: [],
        }));
        const app = await createApp({ executable, cpu: { cores: 4, eager: false } });
        try
        {
            assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
            const tables = await app.diagnostics();
            const cpu = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'cpu');
            assert.deepEqual(cpu?.metrics?.executors, [], 'no worker opened for a thread alone');
        }
        finally
        {
            await app.dispose();
        }
    });

test('two threads computing open the executor they want, and run at once on it', async()=>{
    const executable = buildProgram(['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
        { first: [0, 0, 0, 0], second: [0, 0, 0, 0] }, ({ call, at, start })=>{
            /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
            const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                ...call('WaitForSingleObject')];
            return {
                main: [...start('first'), ...start('second'), ...wait('first'), ...wait('second'),
                    0x6a, 0x07, ...call('ExitProcess')],
                worker: [
                    0xb9, ...u32(LOOPS * 10), //       mov ecx, 10 * LOOPS
                    0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                    0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
                ],
            };
        });
    const app = await createApp({ executable, cpu: { cores: 4, eager: false } });
    try
    {
        assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
        const tables = await app.diagnostics();
        const byName = Object.fromEntries((Array.isArray(tables) ? tables : [])
            .map(table=>[table.name, table]));
        const scheduler = byName.kernel?.metrics?.scheduler ?? byName.kernel?.metrics;
        // Opened as the ready threads wanted them: the main thread may still
        // have been ready beside the two as they started, never more.
        const opened = byName.cpu?.metrics?.executors?.length ?? 0;
        assert.ok(opened >= 1 && opened <= 2, `${opened} executors opened of the 3 there are`);
        assert.ok(scheduler?.mostAtOnce >= 2, 'the two ran at once once it opened');
    }
    finally
    {
        await app.dispose();
    }
});

test('a run keeps in its store how many executors its threads opened, and the next run of the'
    + ' bundle opens as many at its start, before a thread wants one', async()=>{
    /** @type {Map<string, Uint8Array>} */
    const records = new Map();
    const store = {
        get: async(/** @type {string} */ key)=>records.get(key) ?? null,
        put: async(/** @type {string} */ key, /** @type {Uint8Array} */ bytes)=>{
            records.set(key, bytes.slice());
        },
    };
    // Two threads computing, each pinned to a processor of its own past the
    // first: neither runs anywhere but on its own executor, so the run cannot
    // end before both have opened, however long a busy machine takes to open
    // them.
    const twoComputing = buildProgram(['CreateThread', 'SetThreadAffinityMask', 'ResumeThread',
        'WaitForSingleObject', 'ExitProcess'],
    { first: [0, 0, 0, 0], second: [0, 0, 0, 0] }, ({ call, at, start })=>{
        /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
        const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
            ...call('WaitForSingleObject')];
        /**
         * Made suspended, pinned to `processor`, and let go.
         * @param {string} slot @param {number} processor
         */
        const pinned = (slot, processor)=>[...start(slot, CREATE_SUSPENDED),
            0x6a, 1 << processor, 0xff, 0x35, ...u32(at(slot)), ...call('SetThreadAffinityMask'),
            0xff, 0x35, ...u32(at(slot)), ...call('ResumeThread')];
        return {
            main: [...pinned('first', 1), ...pinned('second', 2), ...wait('first'),
                ...wait('second'), 0x6a, 0x07, ...call('ExitProcess')],
            worker: [
                0xb9, ...u32(LOOPS), //            mov ecx, LOOPS
                0x49, 0x75, 0xfd, //               L: dec ecx; jnz L
                0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
            ],
        };
    });
    // One thread that wants no executor, alive long enough for the store's
    // answer to have come at the start.
    const oneSleeping = buildProgram(['Sleep', 'ExitProcess'], {}, ({ call })=>({
        main: [0x68, ...u32(1500), ...call('Sleep'), 0x6a, 0x07, ...call('ExitProcess')],
        worker: [],
    }));
    /**
     * @param {Uint8Array} executable
     * @returns {Promise<{ open: number, opening: number }>} executors open, and asked for
     *     and still opening, at the run's end
     */
    const opened = async executable=>{
        const app = await createApp({ executable, cpu: { cores: 4, eager: false },
            cork: { config: { store } } });
        try
        {
            assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
            const tables = await app.diagnostics();
            const cpu = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'cpu');
            return { open: cpu?.metrics?.executors?.length ?? 0,
                opening: cpu?.metrics?.executorsOpening?.length ?? 0 };
        }
        finally
        {
            await app.dispose();
        }
    };
    const { open: first } = await opened(twoComputing);
    assert.ok(first >= 2, `${first} executors opened by two threads pinned past the first`);
    const kept = ()=>[...(records.get(EXECUTORS_OPENED_KEY) ?? [])];
    assert.deepEqual(kept(), [first], 'kept as they opened');
    // Asked for at the start, before any thread wanted one: open, or still
    // opening where the machine is slow to open a worker -- a run of a second
    // and a half is no bound on that.
    const next = await opened(oneSleeping);
    assert.equal(next.open + next.opening, first, 'opened at the start of the next run');
    assert.deepEqual(kept(), [first], 'and kept, not lowered');
});

test('a worker its main thread waits on each round, both computing as much between, runs on its'
    + ' own executor and is not kept on the process\'s', async t=>{
    // A frame and its render thread: the main thread sets `go`, computes,
    // waits for `done`; the worker waits for `go`, computes, sets `done`. Each
    // wait leaves the process's executor idle and calls the worker back from
    // its own; counted as the two taking turns, it came to be kept here, the
    // two running one after the other while the other executor idled.
    const ROUNDS = 150;
    const WORK = 1_000_000;
    const executable = buildProgram(
        ['CreateEventA', 'CreateThread', 'SetEvent', 'WaitForSingleObject', 'ExitProcess'],
        { go: [0, 0, 0, 0], done: [0, 0, 0, 0], first: [0, 0, 0, 0] }, ({ call, at, start })=>{
            /** CreateEventA(NULL, FALSE, FALSE, NULL), the handle to `slot`. @param {string} slot */
            const event = slot=>[0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                ...call('CreateEventA'), 0xa3, ...u32(at(slot))];
            /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
            const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                ...call('WaitForSingleObject')];
            /** SetEvent([slot]) @param {string} slot */
            const set = slot=>[0xff, 0x35, ...u32(at(slot)), ...call('SetEvent')];
            // mov ecx, WORK; L: dec ecx; jnz L
            const compute = [0xb9, ...u32(WORK), 0x49, 0x75, 0xfd];
            const round = [...set('go'), ...compute, ...wait('done'), 0x4e]; // ...; dec esi
            const work = [...wait('go'), ...compute, ...set('done')];
            return {
                main: [...event('go'), ...event('done'), ...start('first'),
                    0xbe, ...u32(ROUNDS), //       mov esi, ROUNDS
                    ...round, 0x0f, 0x85, ...u32(-(round.length + 6) >>> 0), // jnz round
                    0x6a, 0x07, ...call('ExitProcess')],
                worker: [...work, 0xe9, ...u32(-(work.length + 5) >>> 0)], // jmp work
            };
        });
    const { code, scheduler } = await run(executable, 2);
    assert.equal(code, 7);
    const shared = JSON.parse(scheduler?.sharedTime ?? '{}');
    const elsewhere = shared.elsewhereRetired ?? 0;
    const total = (shared.hereRetired ?? 0) + elsewhere;
    assert.ok(total >= ROUNDS * WORK * 2, `${total} instructions`);
    // Whether the two ran at once is the machine's to say: on one busy with
    // other runs the other executor's thread gets less of a processor, does
    // less beside this one than it is called back after, and is rightly
    // counted as taking turns. So each call back is held to what the two sides
    // retired meanwhile (`COUPLED_WORK`), as measured, and the worker's share
    // elsewhere to what those counts allow: where they could not have raised
    // its coupling past `COUPLED` -- reckoned without the share's halving over
    // time and the runs that ended without a call back, which only lower it --
    // it was never kept here. Its work then ran there but for what its call
    // backs brought here, and those that counted as running beside had done
    // half a round's work there first: past a tenth of the run's instructions
    // even with as many taking turns as keep the coupling under a half (kept,
    // a hundredth; on its own executor, near a half).
    const recalled = String(scheduler?.recentRecalls ?? '').split(' | ').filter(Boolean)
        .map(record=>/^(\S+) (\d+)\/(\d+) (turns|beside)$/.exec(record) ?? [record]);
    let coupled = 0;
    let most = 0;
    for (const [record, name, there, beside, verdict] of recalled)
    {
        assert.equal(verdict, Number(beside) === 0 || Number(there) < Number(beside) / 2
            ? 'turns' : 'beside', `counted by what each side did: ${record}`);
        if (name !== 'main')
        {
            coupled = coupled * 0.75 + (verdict === 'turns' ? 0.25 : 0);
            most = Math.max(most, coupled);
        }
    }
    assert.ok(recalled.length < 1024, 'every call back in the record');
    t.diagnostic(`${elsewhere} of ${total} elsewhere; calls back ${scheduler?.recalls},`
        + ` coupled at most ${most.toFixed(3)}`);
    if (most <= 0.5)
    {
        assert.ok(elsewhere > total * 0.1, `never coupled past a half, yet ${elsewhere} of`
            + ` ${total} instructions on the other executor`);
    }
});

test('a thread reads one time-stamp counter on every executor: never back, whichever it last'
    + ' ran on', async()=>{
    // The main thread is pinned to the process's executor and the worker to
    // the other; they take turns reading the counter, each comparing with the
    // last read of either. The other executor opens once the main thread has
    // run a while: counted from that executor's own opening, its counter was
    // behind by as long, every read there went back, and a game timing its
    // frames by it slept as long.
    const ROUNDS = 100;
    // rdtsc; if edx:eax is below [last], inc [backward]; [last] = edx:eax
    /** @param {(name: string) => number} at */
    const read = at=>[
        0x0f, 0x31, //                                     rdtsc
        0x3b, 0x15, ...u32(at('last') + 4), //             cmp edx, [last+4]
        0x77, 16, //                                       ja keep
        0x72, 8, //                                        jb back
        0x3b, 0x05, ...u32(at('last')), //                 cmp eax, [last]
        0x73, 6, //                                        jae keep
        0xff, 0x05, ...u32(at('backward')), //             back: inc dword [backward]
        0xa3, ...u32(at('last')), //                       keep: mov [last], eax
        0x89, 0x15, ...u32(at('last') + 4), //             mov [last+4], edx
    ];
    const executable = buildProgram(['CreateEventA', 'CreateThread', 'ResumeThread', 'SetEvent',
        'SetThreadAffinityMask', 'Sleep', 'WaitForSingleObject', 'ExitProcess'],
    { go: [0, 0, 0, 0], done: [0, 0, 0, 0], first: [0, 0, 0, 0], last: new Array(8).fill(0),
        backward: [0, 0, 0, 0] }, ({ call, at, start })=>{
        /** CreateEventA(NULL, FALSE, FALSE, NULL), the handle to `slot`. @param {string} slot */
        const event = slot=>[0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
            ...call('CreateEventA'), 0xa3, ...u32(at(slot))];
        /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
        const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
            ...call('WaitForSingleObject')];
        /** SetEvent([slot]) @param {string} slot */
        const set = slot=>[0xff, 0x35, ...u32(at(slot)), ...call('SetEvent')];
        const round = [...read(at), ...set('go'), ...wait('done'), 0x4e]; // ...; dec esi
        const turn = [...wait('go'), ...read(at), ...set('done')];
        return {
            main: [
                0x6a, 0x01, 0x6a, 0xfe, ...call('SetThreadAffinityMask'), // (current, 1)
                0x68, ...u32(300), ...call('Sleep'), //  Sleep(300)
                ...event('go'), ...event('done'),
                ...start('first', 4), //             CREATE_SUSPENDED
                0x6a, 0x02, 0xff, 0x35, ...u32(at('first')), ...call('SetThreadAffinityMask'),
                0xff, 0x35, ...u32(at('first')), ...call('ResumeThread'),
                0xbe, ...u32(ROUNDS), //             mov esi, ROUNDS
                ...round, 0x0f, 0x85, ...u32(-(round.length + 6) >>> 0), // jnz round
                0xff, 0x35, ...u32(at('backward')), ...call('ExitProcess'),
            ],
            worker: [...turn, 0xe9, ...u32(-(turn.length + 5) >>> 0)], // jmp turn
        };
    });
    const app = await createApp({ executable, cpu: { cores: 2, eager: false } });
    try
    {
        assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 0,
            'reads that went back from the one before');
        const tables = await app.diagnostics();
        const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
        const shared = JSON.parse((kernel?.metrics?.scheduler ?? kernel?.metrics)
            ?.sharedTime ?? '{}');
        assert.ok(shared.elsewhereRetired > 0, 'the worker ran on the other executor');
    }
    finally
    {
        await app.dispose();
    }
});

test('a thread on another executor polling an event spins in the guest and takes each signal'
    + ' once', async()=>{
    // The worker, pinned to the other executor, polls `go` until a poll takes
    // it, counts, and signals `ack`; the main thread computes and sets `go`,
    // ROUNDS times, each after the last `ack`. Every poll of `go`, the one
    // that takes it too, is answered by the worker's own guest code from the
    // event's word: only the SetEvent of `ack` the main thread waits on
    // crosses, about one a round, where every poll crossed and waited for the
    // process's executor to answer.
    const ROUNDS = 200;
    const executable = buildProgram(['CreateEventA', 'CreateThread', 'ResumeThread', 'SetEvent',
        'SetThreadAffinityMask', 'WaitForSingleObject', 'ExitProcess'],
    { go: [0, 0, 0, 0], ack: [0, 0, 0, 0], first: [0, 0, 0, 0], count: [0, 0, 0, 0] },
    ({ call, at, start })=>{
        /** CreateEventA(NULL, FALSE, FALSE, NULL), the handle to `slot`. @param {string} slot */
        const event = slot=>[0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
            ...call('CreateEventA'), 0xa3, ...u32(at(slot))];
        /** WaitForSingleObject([slot], timeout) @param {string} slot @param {number} timeout */
        const wait = (slot, timeout)=>[0x68, ...u32(timeout), 0xff, 0x35, ...u32(at(slot)),
            ...call('WaitForSingleObject')];
        /** SetEvent([slot]) @param {string} slot */
        const set = slot=>[0xff, 0x35, ...u32(at(slot)), ...call('SetEvent')];
        // mov ecx, 200 000; L: dec ecx; jnz L -- the worker polls meanwhile
        const compute = [0xb9, ...u32(200_000), 0x49, 0x75, 0xfd];
        const round = [...compute, ...set('go'), ...wait('ack', 0xffffffff), 0x4e]; // dec esi
        const poll = [...wait('go', 0), 0x85, 0xc0]; // ...; test eax, eax
        const turn = [...poll, 0x75, -(poll.length + 2) & 0xff, // jnz poll
            0xff, 0x05, ...u32(at('count')), ...set('ack')]; //   inc dword [count]; SetEvent(ack)
        return {
            main: [
                0x6a, 0x01, 0x6a, 0xfe, ...call('SetThreadAffinityMask'), // (current, 1)
                ...event('go'), ...event('ack'),
                ...start('first', 4), //                 CREATE_SUSPENDED
                0x6a, 0x02, 0xff, 0x35, ...u32(at('first')), ...call('SetThreadAffinityMask'),
                0xff, 0x35, ...u32(at('first')), ...call('ResumeThread'),
                0xbe, ...u32(ROUNDS), //                 mov esi, ROUNDS
                ...round, 0x0f, 0x85, ...u32(-(round.length + 6) >>> 0), // jnz round
                0xff, 0x35, ...u32(at('count')), ...call('ExitProcess'),
            ],
            worker: [...turn, 0xe9, ...u32(-(turn.length + 5) >>> 0)], // jmp turn
        };
    });
    const { code, scheduler } = await run(executable, 2);
    assert.equal(code, ROUNDS, 'every signal taken once');
    const shared = JSON.parse(scheduler?.sharedTime ?? '{}');
    assert.ok(shared.elsewhereRetired > 0, 'the worker ran on the other executor');
    assert.ok(shared.crossings < ROUNDS * 2,
        `${shared.crossings} calls crossed from the other executor in ${ROUNDS} rounds`);
});

test('the process\'s first thread keeps the process\'s own executor when the executor a thread'
    + ' it started wants opens', async()=>{
    // The main thread calls into the host CALLS times while its worker spins
    // on a word it sets after; the worker's executor opens while both are
    // ready, and the worker, if asked about first, is still not the one given
    // this executor: the main thread's calls are answered where it runs, not
    // crossing from the other executor between this one's turns.
    const CALLS = 20_000;
    // Instructions between two calls: the main thread's run, a few hundred
    // milliseconds, is longer than an executor takes to open.
    const BETWEEN = 5_000;
    const executable = buildProgram(
        ['CreateThread', 'WaitForSingleObject', 'GetCurrentProcessId', 'ExitProcess'],
        { first: [0, 0, 0, 0], stop: [0, 0, 0, 0] }, ({ call, at, start })=>({
            main: [
                ...start('first'),
                0xbe, ...u32(CALLS), //            mov esi, CALLS
                ...call('GetCurrentProcessId'), // L: call [GetCurrentProcessId]
                0xb9, ...u32(BETWEEN), //          mov ecx, BETWEEN
                0x49, 0x75, 0xfd, //               M: dec ecx; jnz M
                0x4e, 0x75, 0xef, //               dec esi; jnz L
                0xc7, 0x05, ...u32(at('stop')), ...u32(1), // mov dword [stop], 1
                0x6a, 0xff, 0xff, 0x35, ...u32(at('first')), ...call('WaitForSingleObject'),
                0x6a, 0x07, ...call('ExitProcess'),
            ],
            worker: [
                0x83, 0x3d, ...u32(at('stop')), 0x00, // W: cmp dword [stop], 0
                0x74, 0xf7, //                     je W
                0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
            ],
        }));
    // Which thread is asked about first once the executor opens is the run
    // loop's turn order at that moment: without the first thread's home, one
    // run in three put it on the other executor (13592 crossings), so three.
    for (let attempt = 0; attempt < 3; attempt++)
    {
        const app = await createApp({ executable, cpu: { cores: 4, eager: false } });
        try
        {
            assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
            const tables = await app.diagnostics();
            const kernel = (Array.isArray(tables) ? tables : [])
                .find(table=>table.name === 'kernel');
            const shared = JSON.parse((kernel?.metrics?.scheduler ?? kernel?.metrics)
                ?.sharedTime ?? '{}');
            assert.ok(shared.crossings !== undefined,
                'the scheduler counts the others\' crossings');
            assert.ok(shared.crossings < CALLS / 10, `run ${attempt}: ${shared.crossings} of the`
                + ` main thread's ${CALLS} calls crossed from another executor`);
        }
        finally
        {
            await app.dispose();
        }
    }
});

test('a thread on another executor calling into the host is answered at the process\'s next back'
    + ' edge while the process\'s own thread only computes', async()=>{
    // The worker calls into the host CALLS times; the main thread spins on a
    // word the worker sets after, never calling. Each call is answered inside
    // the main thread's turn, which the other executor's ask interrupts
    // (`interruptProcess`): its turns stay long, not one a call -- where the
    // asks waited for the turn's end, a turn was a quantum, and each call
    // waited 0.57 ms for it. A thread calling into the host this often runs on
    // the process's executor when it may (`keptHere`): the worker is pinned to
    // the other one, as a program that pins it.
    const CALLS = 20_000;
    const executable = buildProgram(
        ['CreateThread', 'SetThreadAffinityMask', 'WaitForSingleObject', 'GetCurrentProcessId',
            'ExitProcess'],
        { first: [0, 0, 0, 0], done: [0, 0, 0, 0] }, ({ call, at, start })=>({
            main: [
                ...start('first'),
                0x6a, 0x02, 0xff, 0x35, ...u32(at('first')), // SetThreadAffinityMask(first, 2)
                ...call('SetThreadAffinityMask'),
                0x83, 0x3d, ...u32(at('done')), 0x00, // S: cmp dword [done], 0
                0x74, 0xf7, //                     je S
                0x6a, 0xff, 0xff, 0x35, ...u32(at('first')), ...call('WaitForSingleObject'),
                0x6a, 0x07, ...call('ExitProcess'),
            ],
            worker: [
                0xbe, ...u32(CALLS), //            mov esi, CALLS
                ...call('GetCurrentProcessId'), // L: call [GetCurrentProcessId]
                0x4e, 0x75, 0xf7, //               dec esi; jnz L
                0xc7, 0x05, ...u32(at('done')), ...u32(1), // mov dword [done], 1
                0x31, 0xc0, 0xc2, 0x04, 0x00, //   xor eax, eax; ret 4
            ],
        }));
    const app = await createApp({ executable, cpu: { cores: 2, eager: true } });
    try
    {
        assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 7);
        const tables = await app.diagnostics();
        const byName = Object.fromEntries((Array.isArray(tables) ? tables : [])
            .map(table=>[table.name, table]));
        const scheduler = byName.kernel?.metrics?.scheduler ?? byName.kernel?.metrics;
        const shared = JSON.parse(scheduler?.sharedTime ?? '{}');
        assert.ok(shared.crossings >= CALLS, `${shared.crossings} calls crossed from the worker`);
        assert.ok(byName.cpu?.metrics?.interrupts > 0, 'the process\'s slices were interrupted');
        // Counted, not timed: the turns a run takes go with how fast the worker
        // makes its calls, and on a loaded machine 20 000 calls took 4 000.
        assert.ok(shared.crossingsInTurn * 10 >= shared.crossings * 9,
            `${shared.crossingsInTurn} of ${shared.crossings} crossings answered inside the`
            + ' process\'s own turns');
    }
    finally
    {
        await app.dispose();
    }
});

test('a thread sleeping on the process\'s executor wakes at its time while the other executor'
    + ' runs a thread that never calls into the host', async t=>{
    const SLEEPS = 5;
    const SLEEP_MS = 20;
    const executable = buildProgram(['CreateThread', 'WaitForSingleObject', 'ExitProcess',
        'Sleep', 'GetTickCount'], {
        spinner: [0, 0, 0, 0], flag: [0, 0, 0, 0], count: [0, 0, 0, 0], began: [0, 0, 0, 0],
    }, ({ call, at, start })=>({
        main: [
            ...start('spinner'),
            ...call('GetTickCount'), 0xa3, ...u32(at('began')),
            ...Array.from({ length: SLEEPS }, ()=>[0x6a, SLEEP_MS, ...call('Sleep')]).flat(),
            ...call('GetTickCount'), 0x2b, 0x05, ...u32(at('began')), //  sub eax, [began]
            0x89, 0xc3, //                                                 mov ebx, eax
            0xc7, 0x05, ...u32(at('flag')), ...u32(1), //                 mov [flag], 1
            0x6a, 0xff, 0xff, 0x35, ...u32(at('spinner')), ...call('WaitForSingleObject'),
            0x53, ...call('ExitProcess'), //                               ExitProcess(ebx)
        ],
        worker: [
            0xff, 0x05, ...u32(at('count')), //                L: inc [count]
            0x83, 0x3d, ...u32(at('flag')), 0x00, //           cmp [flag], 0
            0x74, 0xf1, //                                     je L
            0x31, 0xc0, 0xc2, 0x04, 0x00, //                   xor eax, eax; ret 4
        ],
    }));
    // Every wait of the process's thread for the other executor, read off the
    // waits it made: a look of EXECUTORS_WAIT_MS at most, so it comes back to
    // the sleeper's deadline -- not the quarter of a second each the other
    // executor went without a word. Its wall time, which a busy machine
    // stretches past any figure, is held only from below.
    const waits = t.mock.method(Atomics, 'wait');
    const { code } = await run(executable, 2);
    const asked = waits.mock.calls.map(one=>Number(one.arguments[3] ?? Infinity));
    waits.mock.restore();
    assert.ok(code >= SLEEPS * SLEEP_MS, `${SLEEPS} sleeps of ${SLEEP_MS} ms took ${code} ms`);
    assert.ok(asked.length > 0 && asked.every(ms=>ms <= EXECUTORS_WAIT_MS),
        `the process waited for the other executor ${asked.length} times, up to`
        + ` ${Math.max(...asked)} ms`);
});

/** CONTEXT_i386 | CONTEXT_CONTROL: eip, esp and the flags. */
const CONTEXT_CONTROL = 0x10001;

for (const cores of [1, 2])
{
    test(`a thread suspended while it runs stops, on ${cores} executor${cores > 1 ? 's' : ''}`,
        async()=>{
            // SuspendThread stops a thread on another processor a little
            // later, as on Windows; reading its context waits for the stop.
            const executable = buildProgram(['CreateThread', 'SuspendThread', 'ExitProcess',
                'Sleep', 'GetThreadContext'], { runner: [0, 0, 0, 0], count: [0, 0, 0, 0],
                seen: [0, 0, 0, 0],
                context: [...u32(CONTEXT_CONTROL), ...new Array(0x2c8).fill(0)] },
            ({ call, at, start })=>({
                main: [
                    ...start('runner'),
                    0x6a, 0x64, ...call('Sleep'), //                         Sleep(100)
                    0xff, 0x35, ...u32(at('runner')), ...call('SuspendThread'),
                    0x68, ...u32(at('context')), 0xff, 0x35, ...u32(at('runner')),
                    ...call('GetThreadContext'), //       GetThreadContext(runner, &context)
                    0xa1, ...u32(at('count')), 0xa3, ...u32(at('seen')), // seen = count
                    0x6a, 0x3c, ...call('Sleep'), //                         Sleep(60)
                    0xa1, ...u32(at('count')), 0x2b, 0x05, ...u32(at('seen')),
                    0x50, ...call('ExitProcess'), //               ExitProcess(count - seen)
                ],
                worker: [
                    0xff, 0x05, ...u32(at('count')), //            L: inc [count]
                    0xeb, 0xf8, //                                 jmp L
                ],
            }));
            const { code } = await run(executable, cores);
            assert.equal(code, 0, `${code} increments after the thread was suspended`);
        });
}

test('a process that pins itself to the second processor and sleeps runs on there once its'
    + ' executor opens', async()=>{
    // A program measuring each processor in turn (Crysis's CPU detection)
    // narrows the process to one and sleeps. With executors opened as they
    // are wanted, the sleeper woke before the second had opened and the turn
    // read as a machine with nothing left to run.
    const executable = buildProgram(['SetProcessAffinityMask', 'Sleep', 'ExitProcess'], {},
        ({ call })=>({
            main: [
                0x6a, 0x02, 0x6a, 0xff, ...call('SetProcessAffinityMask'), // (-1, 2)
                0x6a, 0x64, ...call('Sleep'), //                             Sleep(100)
                0x6a, 0x07, ...call('ExitProcess'),
            ],
            worker: [0xc3],
        }));
    const app = await createApp({ executable, cpu: { cores: 2, eager: false } });
    try
    {
        assert.equal(await app.run({ timeoutMs: 30_000 }), 7);
    }
    finally
    {
        await app.dispose();
    }
});
