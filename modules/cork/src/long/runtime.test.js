/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The long-mode translator judged by the long-mode interpreter: every case of
 * the hardware corpus (`x64-corpus.json.gz`), seeded programs drawn from it
 * and directed ones run twice over the same machine -- once as translated
 * regions (each start translated the first time it is met, the interpreter
 * taking what a block stops before), once on the interpreter alone -- and
 * everything a program can see compared: the sixteen registers, RIP, the
 * instructions retired, the whole flags word (undefined flags included: the
 * translator keeps them as the model does), the XMM registers, the x87 unit
 * the MMX registers are part of, the data buffer, and a fault's vector and
 * instruction.
 *
 * The interpreter is itself judged by the processor (`ir64-corpus.test.js`),
 * so this is the translator against the hardware one step removed, exact
 * where the hardware leaves a flag to the implementation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageFlagsAt } from '../runtime/layout.js';
import { PageFlag } from '../runtime/pages.js';
import { interpret64 } from '../interp64.js';

import {
    CORPUS, EXIT, HOISTED_SWITCHES, SWITCHES, compare, load, machine, nested, pool, program, run,
} from '../testing/long-machine.js';

test('seeded long programs run translated as they run interpreted', ()=>{
    const instructions = pool();
    assert.ok(instructions.length > 1000, `${instructions.length} instructions in the pool`);
    const cases = Array.from({ length: 600 },
        (_, i)=>program(instructions, 0x5eed + i, 20 + i % 60));
    for (const transfers of [true, false])
    {
        const { failures, stats, exits } = compare(cases, 7, transfers);
        // A division from the pool raises #DE in some (both ways alike); most run through.
        assert.ok(exits > cases.length * 0.6, `${exits} programs ran to their exit`);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > stats.interpreted * 2,
            `translated ${stats.translated}, interpreted ${stats.interpreted}`);
    }
});

/**
 * MMX forms at 64 bits, as bytes: the saturating, multiplying, unpacking,
 * packing, shuffling and shifting ones, moves among the MMX registers, the
 * general ones and memory (through rbx, rsi and rdi, which hold the corpus's
 * data pointers), with the integer and x87 instructions around them that
 * leave and enter the MMX state.
 */
const MMX_POOL = [
    '0f6f4b10', '0f6f5e08', '0f6f6718', '0f7f4320', '0f7f6e28', '0f7e5730', '0f6e7334',
    '0fe74b38', '0f6ffb', '0f7fe8', '410f6ef8', '490f6ed1', '410f7eca', '490f7ee3', '480f7ec0',
    '0f7ef1', '0fe9c3', '0fedc7', '0fddcc', '0fd8e3', '0fdbef', '0fdfc1', '0febd6', '0fefdb',
    '0f75f6', '0f64d1', '0f764e10', '0ffcca', '0ffdca', '0ffedc', '0fd4c1', '0ffb13', '0f60d1',
    '0f68d1', '0f61ff', '0f69cb', '0f62ff', '0f6ae8', '0f605f04', '0fe5e7', '0fd5cf', '0fe4d3',
    '0ff4ca', '0ff5d9', '0ff6d4', '0fe0ca', '0fe3d8', '0fdac2', '0feee9', '0f70c11b',
    '0f7053084e', '0f71e707', '0f73f310', '0f73d720', '0f72d121', '0f72e228', '0ff1c1', '0fd3d3',
    '0fe16618', '0f63c1', '0f67d3', '0f6be5', '0fd7ca', '440fd7c8', '0fc5c802', '440fc5c307',
    '0fc4e801', '0fc44f1206', 'b80180ff7f', '01c8', '4989c0', 'd9e8', '0f77', 'f30fd6ca',
    'f20fd6dc',
].map(hex=>Buffer.from(hex, 'hex'));

test('MMX runs translated as interpreted, the x87 unit it leaves in its state included', ()=>{
    const cases = Array.from({ length: 400 }, (_, i)=>program(MMX_POOL, 0x3d00 + i, 3 + i % 14));
    for (const budget of [7, 100000])
    {
        const { failures, exits, stats } = compare(cases, budget);
        assert.equal(exits, cases.length);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > stats.interpreted * 2,
            `translated ${stats.translated}, interpreted ${stats.interpreted}`);
    }
});

/**
 * x87 forms at 64 bits, as bytes: loads, stores and arithmetic of every
 * memory width through rbx and rsi (the corpus's data pointers), the stack
 * forms, compares into the flags and the status word, the transcendentals,
 * the control word from memory, the environment's image (which a region
 * leaves to the interpreter), and the integer instructions that read what
 * `fcomi`, `fnstsw ax` and `cmp` leave.
 */
const X87_POOL = [
    'dd4310', 'd94318', 'db6b20', 'db4328', 'df6b30', 'df4338', 'dd5e08', 'd95610', 'db7e18',
    'df7e28', 'db5630', 'db4e34', 'df5e38', 'dc4310', 'd84b18', 'dc6340', 'd87b44', 'da4328',
    'dc5310', 'd85b18', 'd97e40', 'd96b48', 'dd7e44', 'd9e8', 'd9ee', 'd9eb', 'd9ea', 'd9c1',
    'ddd9', 'd9c9', 'd9cb', 'dec1', 'dee1', 'dec9', 'def9', 'd8c2', 'dccb', 'd9e0', 'd9e1',
    'd9fa', 'd9fc', 'd9fd', 'd9f0', 'd9f1', 'd9f8', 'd9e5', 'd9e4', 'dbf1', 'dfe9', 'd8d9',
    'ded9', 'dae9', 'dfe0', 'dac1', 'daca', 'dbd1', 'ddc2', 'd9f7', 'd9f6', 'dbe3', 'dbe2', '9b',
    'd9fe', 'd9ff', 'd9f3', 'd9f2', 'd9f4', 'd9fb', 'd97650', 'd96650', '0f97c0', '0f42ca', '9e',
    '39c8',
].map(hex=>Buffer.from(hex, 'hex'));

test('x87 runs in regions as the interpreter runs it, the unit and what it leaves outside', ()=>{
    const cases = Array.from({ length: 400 }, (_, i)=>program(X87_POOL, 0x8700 + i, 3 + i % 14));
    for (const budget of [7, 100000])
    {
        const { failures, exits, stats } = compare(cases, budget);
        assert.equal(exits, cases.length);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > stats.interpreted * 4,
            `translated ${stats.translated}, interpreted ${stats.interpreted}`);
    }
});

test('an x87 run whose later store finds a closed page faults where the interpreter faults', ()=>{
    // fld qword [rbx]; fld qword [rbx + 8]; faddp; fstp qword [rcx]; fld1; fstp qword [rbx]
    const code = 'dd03dd4308dec1dd19d9e8dd1b';
    const base = CORPUS.cases[0];
    const end = CORPUS.dataAt + CORPUS.dataSize;
    const cases = [BigInt(CORPUS.dataAt + 64), BigInt(end - 4), BigInt(CORPUS.dataAt - 8),
        1n << 32n, (1n << 32n) + BigInt(CORPUS.dataAt)].map(rcx=>{
        const regs = [...base.regs];
        regs[1] = rcx.toString(16);
        regs[3] = (CORPUS.dataAt + 16).toString(16);
        return { ...base, text: `x87 run rcx=${rcx.toString(16)}`, code, regs };
    });
    for (const budget of [3, 100000])
    {
        const { failures, exits, stats } = compare(cases, budget, true, true);
        assert.deepEqual(failures, [], `budget ${budget}`);
        // The one open place ran to its exit; the others faulted at the store.
        assert.equal(exits, 1);
        assert.ok(stats.translated > 0);
    }
});

test('nested loops, jumps over them, out of them and into them run as interpreted', ()=>{
    const instructions = pool();
    const cases = Array.from({ length: 400 }, (_, i)=>nested(instructions, 0x1005 + i));
    for (const [budget, transfers] of /** @type {const} */ ([[7, true], [1000, true], [5, false]]))
    {
        const { failures, exits } = compare(cases, budget, transfers);
        assert.ok(exits > cases.length * 0.6, `${exits} programs ran to their exit`);
        assert.deepEqual(failures.slice(0, 20), [],
            `${failures.length} differences, budget ${budget}`);
    }
});

test('the cases of a switch join its region, its jump going among them as interpreted', ()=>{
    // Eight rounds through four switches, then eight more after a table is rewritten
    // (tools: GNU as, `ld -Ttext=0x20000000 --oformat binary`):
    //   jmp [tableA + rax*8]                 GCC's absolute quadwords, bound by cmp esi, 5; ja
    //   lea rdx, [rip + base]; mov ecx, [rdx + rax*4 + tableB - base]; add rcx, rdx; jmp rcx
    //                                        MSVC's RVAs from a base below the code (the
    //                                        image's), the index widened by movsxd
    //   lea rdx, [rip + tableC]; movsxd rax, [rdx + rax*4]; add rax, rdx; jmp rax
    //                                        MinGW's offsets, the bound tested in memory
    //   jmp [0x10000040 + rax*8]             a table in the data area, filled by the program
    //                                        (read at forming before or after the fill), and
    //                                        an entry rewritten once its region has run
    // Each case changes a word of [rbx] differently, a default the indices past the bound.
    const code = SWITCHES;
    const cases = CORPUS.cases.slice(0, 6).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `switch ${i}`, code }));
    for (const [budget, transfers] of /** @type {const} */ ([[7, true], [100000, true], [50, false]]))
    {
        const { failures, exits, stats } = compare(cases, budget, transfers);
        assert.deepEqual(failures, [], `budget ${budget}, transfers ${transfers}`);
        assert.equal(exits, cases.length);
        // GCC's, MSVC's and MinGW's tables in the code are read wherever they are formed.
        assert.ok(stats.switches >= 3, JSON.stringify(stats));
    }
});

test('a switch whose table base is set before its block joins its region all the same', ()=>{
    // Clang's tables, the base's lea hoisted out of the loop:
    //         lea r13, [rip + table]; xor esi, esi; lea rax, [rip + loop]; jmp rax
    // loop:   mov eax, esi; and eax, 3; cmp rax, 3; ja next     entered through a register:
    //         movsxd rcx, [r13 + rax*4]; add rcx, r13; jmp rcx  the base only in r13
    // c0..c3: add [rbx], 1 / add [rbx], 10 / [rbx] *= 3 / sub [rbx], 7; jmp next
    // next:   inc esi; cmp esi, 200; jb loop
    //         lea r12, [rip + table2]; xor esi, esi; jmp loop2
    // loop2:  as loop through r12 and table2                   the lea in the region
    // d0..d3: xor [rbx + 8], rsi / add 5 / rol 3 / not; next2: as next
    //         xor esi, esi; lea rax, [rip + loop3]; jmp rax
    // loop3:  mov ecx, esi; and ecx, 3; cmp rcx, 3; ja next3   the index written over
    //         movsxd rcx, [r13 + rcx*4 - 16]; add rcx, r13; jmp rcx   by the table's read
    // e0..e3: add [rbx + 16], 3 / [rbx + 16] *= 5 / xor rsi / ror 7; next3: as next; jmp done
    // table3, table, table2: the cases' offsets from table (table3's) or their own table
    const code = HOISTED_SWITCHES;
    const cases = CORPUS.cases.slice(0, 3).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `hoisted switch ${i}`, code }));
    for (const [budget, transfers] of /** @type {const} */ ([[7, true], [100000, true], [100000, false]]))
    {
        const { failures, exits, stats } = compare(cases, budget, transfers);
        assert.deepEqual(failures, [], `budget ${budget}`);
        assert.equal(exits, cases.length);
        // The three tables read in every case, each loop one region with its
        // cases: a jump whose table was not read left for regions of its
        // cases, more regions over the three cases than the 9 these make.
        assert.ok(stats.switches >= 3 * cases.length && stats.regions <= 3 * cases.length,
            JSON.stringify(stats));
        // Without the transfer every case the dispatch missed goes out to the
        // host: 459 to 609 entries with the index taken after the read.
        assert.ok(transfers || stats.entered <= 3 * cases.length, JSON.stringify(stats));
    }
});

test('a write to the trap port leaves its region past it, trapped as interpreted', ()=>{
    // loop: mov edx, 0xb077; lea eax, [rcx + 0x100]; out dx, eax   the trap port
    //       mov edx, 0x80; out dx, eax                              a device's port
    //       inc ecx; cmp ecx, 20; jb loop
    const PORT = 0xb077;
    const code = 'ba77b000008d8100010000efba80000000efffc183f91472e7';
    const regs = [...CORPUS.cases[0].regs];
    regs[1] = '0';
    const one = { ...CORPUS.cases[0], text: 'trap port', code, regs };
    /** @param {boolean} translated */
    const outcome = translated=>{
        const m = machine(true, undefined, undefined, undefined, true, 0, PORT);
        load(m, one);
        /** @type {number[]} */
        const trapped = [];
        let fault = 'ran on';
        try
        {
            for (let round = 0; round < 1000; round++)
            {
                if (translated)
                {
                    m.runner.run(m.state, 1000);
                }
                else
                {
                    m.state.syncIn();
                    interpret64(m.state, 1000);
                }
                m.state.syncOut();
                trapped.push(...m.state.trapped.splice(0));
            }
        }
        catch (e){
            m.state.syncOut();
            fault = /** @type {{ eip?: number }} */ (e).eip === EXIT ? 'exit' : String(e);
        }
        return { fault, trapped, writes: m.writes, retired: m.state.retired,
            regs: [...new BigUint64Array(m.memory.buffer, m.layout.regs, 16)].map(String),
            traps: m.runner.stats.traps };
    };
    const interpreted = outcome(false);
    const translated = outcome(true);
    assert.equal(interpreted.fault, 'exit');
    assert.deepEqual(interpreted.trapped, Array.from({ length: 20 }, (_, i)=>0x100 + i));
    assert.equal(interpreted.writes.length, 20);
    assert.deepEqual({ ...translated, traps: 0 }, { ...interpreted, traps: 0 });
    // Every write to the trap port left its region but the first, run cold.
    assert.ok(translated.traps >= 19, `${translated.traps} traps`);
});

test('an access across into a closed page or past 4 GiB faults where the interpreter faults', ()=>{
    const base = CORPUS.cases[0];
    const end = CORPUS.dataAt + CORPUS.dataSize;
    /** @param {string} code @param {bigint} rbx */
    const edge = (code, rbx)=>{
        const regs = [...base.regs];
        regs[3] = rbx.toString(16);
        return { ...base, text: `${code} rbx=${rbx.toString(16)}`, code, regs };
    };
    const cases = [];
    // mov rax, [rbx]; mov [rbx], rax; mov eax, [rbx]; mov [rbx], eax; mov ax, [rbx];
    // mov word [rbx], 1; movzx rax, byte [rbx]; push qword [rbx]; add [rbx], rax
    for (const code of ['488b03', '488903', '8b03', '8903', '668b03', '66c7030100', '480fb603',
        'ff33', '480103'])
    {
        for (const rbx of [BigInt(end - 8), BigInt(end - 4), BigInt(end - 2), BigInt(end - 1),
            BigInt(CORPUS.dataAt - 1), 1n << 32n, (1n << 32n) - 4n, (1n << 64n) - 4n,
            // Past 4 GiB with an open page under its low half.
            (1n << 32n) + BigInt(CORPUS.dataAt + 16)])
        {
            cases.push(edge(code, rbx));
        }
    }
    // Reads tested, as a program that has faulted on a read once has them.
    const { failures, exits } = compare(cases, 7, true, true);
    assert.deepEqual(failures, []);
    // Some ran clean, most faulted: both ways were taken.
    assert.ok(exits > 0 && exits < cases.length, `${exits} of ${cases.length} ran to their exit`);
});

test('a store through rsp tests no page until code is translated on a noted stack', ()=>{
    // mov dword [rsp], 0x90c8ff48 over the next instruction, inc rax; nop, which
    // it makes dec rax: code on the page rsp points into.
    const code = 'c7042448ffc89048ffc090';
    const regs = [...CORPUS.cases[0].regs];
    regs[0] = '10';
    regs[4] = (CORPUS.codeAt + 7).toString(16);
    const one = { ...CORPUS.cases[0], text: 'store over the code through rsp', code, regs };
    /** @param {ReturnType<typeof machine>} m @param {boolean} translated */
    const rax = (m, translated)=>{
        m.runner.invalidate(CORPUS.codeAt, CORPUS.codeSize);
        load(m, one);
        return run(m, translated).regs[0];
    };
    const interpreted = rax(machine(), false);
    assert.equal(interpreted, 'f');
    // Tested, as the interpreter does it.
    assert.equal(rax(machine(true, undefined, false), true), interpreted);
    // Loose, with the code's page named a stack: made again tested, once.
    const noted = machine();
    noted.runner.noteStack(CORPUS.codeAt, 0x1000);
    assert.equal(rax(noted, true), interpreted);
    assert.equal(noted.runner.stats.stackSwitches, 1);
    // Loose with no stack named there, the store went untested: the code it
    // wrote over ran as it was, which a thread's stack never holds.
    assert.equal(rax(machine(), true), '11');
});

test('a translated read wraps into RAM until the program faults on a page, then faults', ()=>{
    // mov rax, [rbx] with rbx on the closed page past the data; then hlt-free exit.
    const base = CORPUS.cases[0];
    const closed = CORPUS.dataAt + CORPUS.dataSize + 0x10;
    const regs = [...base.regs];
    regs[3] = closed.toString(16);
    const one = { ...base, text: 'read a closed page', code: '488b03', regs };
    const m = machine();
    load(m, one);
    const wrapped = run(m, true);
    // RAM a power of two here: the address itself, which is in RAM, read as it stands.
    assert.equal(wrapped.fault, 'exit', 'the translated read did not test its page');
    const ram = new DataView(m.memory.buffer).getBigUint64(closed, true);
    assert.equal(wrapped.regs[0], ram.toString(16));
    m.runner.readsFaulted();
    assert.equal(m.runner.stats.readSwitches, 1);
    load(m, one);
    const faulted = run(m, true);
    const interpreted = run((()=>{
        const other = machine();
        load(other, one);
        return other;
    })(), false);
    assert.equal(faulted.fault, interpreted.fault, 'after the switch it faults as the interpreter');
    assert.notEqual(faulted.fault, 'exit');
});

test('an instruction whose two operands are one register runs translated as interpreted', ()=>{
    // xadd rax, rax; xadd eax, eax; xchg rax, rax; cmpxchg rax, rax; cmpxchg ecx, ecx;
    // bsf rax, rax; bsr eax, eax; imul rax, rax; bts rax, rax; btc eax, eax; mul rax;
    // div rdx; idiv rax; xadd al, al; xadd ah, ah (in 32-bit form)
    const codes = ['480fc1c0', '0fc1c0', '4887c0', '480fb1c0', '0fb1c9', '480fbcc0', '0fbdc0',
        '480fafc0', '480fabc0', '0fbbc0', '48f7e0', '48f7f2', '48f7f8', '0fc0c0', '0fc0e4'];
    const cases = CORPUS.cases.slice(0, 20).flatMap((/** @type {any} */ one)=>codes.map(code=>({
        ...one, text: `${code} on ${one.text}`, code,
        regs: one.regs.map((/** @type {string} */ value, /** @type {number} */ i)=>(i === 0 || i === 2
            ? (Number.parseInt(value.slice(-2), 16) & 7).toString(16) : value)),
    })));
    const { failures } = compare(cases);
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
});

test('a run comes back once it has interpreted its limit, the budget left over', ()=>{
    const m = machine();
    // Twenty cpuids, which no block holds: each one the interpreter's.
    const code = Buffer.alloc(0x100, 0x90);
    for (let i = 0; i < 20; i++)
    {
        code.set([0x0f, 0xa2], i * 2);
    }
    load(m, { ...CORPUS.cases[0], code: code.toString('hex') });
    const interpreted = m.runner.stats.interpreted;
    m.runner.run(m.state, 1000000, { interpretLimit: 4 });
    const spent = m.runner.stats.interpreted - interpreted;
    assert.ok(spent >= 4 && spent < 8, `${spent} interpreted`);
    assert.ok(m.state.retired < 1000000);
});

test('a block that loops onto itself goes round in wasm until its budget is spent', ()=>{
    // mov ecx, 30000; l: add rax, rcx; dec ecx; jnz l
    const code = 'b9307500004801c8ffc975f9';
    const m = machine();
    load(m, { ...CORPUS.cases[0], code });
    const translated = m.runner.stats.translated;
    /** @type {number[]} */
    const runs = [];
    for (let i = 0; i < 40; i++)
    {
        const before = m.state.retired;
        m.runner.run(m.state, 1000);
        runs.push(m.state.retired - before);
    }
    // Each run its budget, and at most the rest of the turn it was spent in.
    assert.ok(runs.every(retired=>retired >= 1000 && retired < 1003), runs.join(' '));
    assert.ok(m.runner.stats.translated - translated > 30000);
    const { failures } = compare([{ ...CORPUS.cases[0], text: 'self loop', code }], 1000);
    assert.deepEqual(failures, []);
});

test('calls from region to region return where they were made, and leave where they cannot', ()=>{
    // start:  mov ecx, 12; call fib; mov [rbx], rax          fib(12), nested wasm calls
    //         mov ecx, 80; call depth; mov [rbx + 8], rax     deeper than CALL_DEPTH
    //         call skip; mov qword [rbx + 16], 1             skip returns 8 bytes on,
    //         mov qword [rbx + 24], 2                          past the first store
    //         call cold; mov [rbx + 32], rax; jmp done       cold starts untranslated
    // fib:    cmp ecx, 2; jb small; push rcx; dec ecx; call fib; pop rcx; push rax;
    //         sub ecx, 2; call fib; pop rdx; add rax, rdx; ret
    // small:  mov eax, ecx; ret
    // depth:  test ecx, ecx; jz zero; dec ecx; call depth; inc rax; ret
    // zero:   xor eax, eax; ret
    // skip:   add qword [rsp], 8; ret
    // cold:   pxor xmm0, xmm0; mov eax, 7; ret
    // done:
    const code = 'b90c000000e831000000488903b950000000e84300000048894308e84c00000048c7431001'
        + '00000048c7431802000000e83d00000048894320eb4183f902721751ffc9e8f3ffffff595083e902e8'
        + 'e9ffffff5a4801d0c389c8c385c9740bffc9e8f5ffffff48ffc0c331c0c34883042408c3660fefc0b8'
        + '07000000c3';
    const cases = CORPUS.cases.slice(0, 8).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `calls ${i}`, code }));
    /** @type {Record<string, number>} */
    const entered = {};
    for (const budget of [7, 100000])
    {
        for (const transfers of [true, false])
        {
            // Every call a wasm call, and skip and cold formed into their callers.
            for (const leafCalls of [false, true])
            {
                const { failures, exits, stats } = compare(cases, budget, transfers, undefined,
                    undefined, leafCalls);
                assert.deepEqual(failures, [],
                    `budget ${budget}, transfers ${transfers}, leafCalls ${leafCalls}`);
                assert.equal(exits, cases.length);
                // Many short runs: regions gathered into modules between them --
                // where calls are wasm calls: with its leaves formed in, a case is
                // two regions, fewer than a pack takes.
                assert.ok(budget > 7 || leafCalls || stats.packs > 0, JSON.stringify(stats));
                entered[`${budget} ${transfers} ${leafCalls}`] = stats.entered;
            }
        }
    }
    // The returns past a call too deep and the jumps out of a region go on
    // in wasm: the host enters regions less often.
    assert.ok(entered['100000 true false'] * 2 < entered['100000 false false'],
        JSON.stringify(entered));
});

test('a call loads back only what the code after it touches, and no store undoes a callee', ()=>{
    //         jmp start
    // f1:     add ebx, 7; movd xmm3, ebx; ret          writes what the caller then leaves alone
    // f2:     lea rax, [rbx + 100]; movd edx, xmm3     reads it, and writes it,
    //         add ebx, 3; paddd xmm3, xmm3; ret        which the caller's exit must keep
    // body:   test r10, r10; jz b
    //         mov ebx, 1; movd xmm3, ebx; jmp q        one way to q writes rbx and xmm3,
    // b:      call f1                                  the other comes from f1's return,
    // q:      call f2                                  whose values the call must keep
    //         add r13, rax; add r13, rdx; ret
    // start:  mov r12d, 4
    // again:  call body; dec r12d; jnz again           the later rounds' calls in wasm
    const code = 'eb3983c307660f6edbc3488d4364660f7eda83c303660ffedbc34d85d2740bbb01000000660f6edb'
        + 'eb05e8d3ffffffe8d6ffffff4901c54901d5c341bc04000000e8d4ffffff41ffcc75f6';
    const cases = CORPUS.cases.slice(0, 8).map((/** @type {any} */ one, /** @type {number} */ i)=>{
        const regs = [...one.regs];
        regs[10] = i % 2 === 0 ? '0' : '1';
        return { ...one, text: `fresh ${i}`, code, regs };
    });
    for (const budget of [7, 100000])
    {
        // Every call a wasm call, and the small callees formed into their callers.
        for (const leafCalls of [false, true])
        {
            const { failures, exits } = compare(cases, budget, true, undefined, undefined,
                leafCalls);
            assert.deepEqual(failures, [], `budget ${budget}, leafCalls ${leafCalls}`);
            assert.equal(exits, cases.length);
        }
    }
});

test('a callee formed in reads what a wasm call before it left in the state block', ()=>{
    //         mov ecx, 3
    // loop:   call g; call leaf               g a wasm call once made, leaf formed in
    //         dec ecx; jnz loop; jmp done
    // g:      add eax, 0x1234; call h; ret    no leaf: it calls
    // h:      ret
    // leaf:   mov [rbx], rax; add rbx, 8; ret reads what g wrote, nothing after it does
    // done:
    const code = 'b903000000e80b000000e812000000ffc975f2eb140534120000e801000000c3c3'
        + '4889034883c308c3';
    const cases = CORPUS.cases.slice(0, 4).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `formed after a call ${i}`, code }));
    for (const budget of [7, 100000])
    {
        const { failures, exits, stats } = compare(cases, budget);
        assert.deepEqual(failures, [], `budget ${budget}`);
        assert.equal(exits, cases.length);
        assert.ok(stats.leaves > 0);
    }
});

test('an indirect call\'s sampled callees are formed in and run as interpreted', ()=>{
    //         mov ecx, 20000
    // loop:   mov eax, ecx; xor edx, edx; mov r9d, 3; div r9d    edx = ecx % 3
    //         lea rax, [rip + f0]; shl edx, 3; add rax, rdx
    //         lea r10, [rcx + 7]                                 written before the call,
    //         call rax                                           stored by the next one
    //         call g; dec ecx; jnz loop; jmp done
    // f0..f2: add rbx, 1 / 2 / 4; ret                            eight bytes apart
    // g:      add rbx, r10; call h; ret                          no leaf: a wasm call
    // h:      ret
    // done:
    const code = 'b9204e000089c831d241b90300000041f7f1488d0517000000c1e2034801d04c8d5107ffd0'
        + 'e81e000000ffc975d7eb224883c301c39090904883c302c39090904883c304c3909090'
        + '4c01d3e801000000c3c3';
    const cases = CORPUS.cases.slice(0, 2).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `predicted ${i}`, code }));
    for (const budget of [7, 1000])
    {
        const { failures, exits, stats } = compare(cases, budget);
        assert.deepEqual(failures, [], `budget ${budget}`);
        assert.equal(exits, cases.length);
        // All three callees decided and formed in.
        assert.ok(stats.predicted >= 3, JSON.stringify(stats));
    }
});

test('a store beside code on its page stays in the region; one into the code still leaves', ()=>{
    //         mov edi, 0x20001000; mov byte [rdi + 0xf00], 0xc3   f: ret, a page on
    //         lea rax, [rdi + 0xf00]; call rax                    f translated
    //         mov ecx, 2000
    // l:      mov [rdi], rcx; add [rdi + 8], rcx                  stores before f's granules
    //         lea rax, [rdi + 0xf00]; call rax; dec ecx; jnz l
    //         mov dword [rdi + 0xf00], 0xc3c0ff                   f: inc eax; ret
    //         lea rdx, [rdi + 0xf00]; call rdx; call rdx          the new f, twice
    const code = 'bf00100020c687000f0000c3488d87000f0000ffd0b9d007000048890f48014f08488d87000f'
        + '0000ffd0ffc975ecc787000f0000ffc0c300488d97000f0000ffd2ffd2';
    const cases = CORPUS.cases.slice(0, 2).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `beside code ${i}`, code }));
    for (const budget of [7, 1000])
    {
        const { failures, exits, stats } = compare(cases, budget);
        assert.deepEqual(failures, [], `budget ${budget}`);
        assert.equal(exits, cases.length);
        // Two stores a round on f's page: each left the region before the
        // granules were looked at, 8000 times; now each until it is tested
        // to the granule (`GRANULAR_AFTER`), and the store into f.
        assert.ok(stats.granular === 2 && stats.exits < 60, JSON.stringify(stats));
    }
    // A watched page leaves at its first store, which marks it written, and
    // not at the next 999. mov ecx, 1000; l: mov [rbx], rcx; dec ecx; jnz l
    const m = machine();
    load(m, { ...CORPUS.cases[0], code: 'b9e803000048890bffc975f9' });
    const page = Number.parseInt(CORPUS.cases[0].regs[3], 16) >>> 12;
    const flags = new Uint8Array(m.memory.buffer, pageFlagsAt(m.layout), 1 << 20);
    flags[page] = PageFlag.WATCH;
    assert.throws(()=>m.runner.run(m.state, 1000000),
        (/** @type {{ eip?: number }} */ error)=>error.eip === EXIT);
    assert.equal(flags[page], PageFlag.WRITTEN);
    assert.equal(m.runner.stats.exits, 1);
});

test('a page whose code is written again and again is left to the interpreter', ()=>{
    //         mov r8d, 0x20001000; scale's 24 bytes written there, a page on
    //         mov ecx, 3000
    // l:      mov esi, ecx; shr esi, 4; mov edi, ecx       a new factor every 16 calls
    //         call r8; add r13, rax; dec ecx; jnz l
    // scale:  cmp [rip + step - 4], esi; je 1f
    //         mov [rip + step - 4], esi                    into imul's immediate
    // 1:      imul eax, edi, 0x12345678
    // step:   add eax, 7; ret
    const code = '41b80010002048b839350a000000740649890048b889350200000069c74989400848b878563412'
        + '83c007c349894010b9b80b000089cec1ee0489cf41ffd04901c5ffc975ef';
    const cases = CORPUS.cases.slice(0, 2).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `patched ${i}`, code }));
    for (const budget of [7, 1000])
    {
        // A window no run of the test outlasts, however loaded the machine.
        const { failures, exits, stats } = compare(cases, budget, true, undefined, undefined,
            true, 60000);
        assert.deepEqual(failures, [], `budget ${budget}`);
        assert.equal(exits, cases.length);
        // Translated again at each of the 188 writes a case, it was a region a write.
        assert.ok(stats.volatilePages >= 1 && stats.regions < 60, JSON.stringify(stats));
    }
});

test('a callee predicted on code since rewritten is not formed in from what replaced it', ()=>{
    //         mov edi, 0x20002000                        a buffer two pages on
    //         mov dword [rdi], 0x01c58349; mov byte [rdi + 4], 0xc3     add r13, 1; ret
    //         mov rsi, rdi; lea r8, [rbx + 0x100]; mov ecx, 3000
    //         call caller                                its callee predicted, formed in
    //         mov qword [rdi], 0                         the buffer's code gone,
    //         lea rsi, [rip + f]; lea r8, [rdi + 0x800]  its page now data the loop writes
    //         mov ecx, 3000; call caller; jmp done
    // caller: mov [r8], rcx; call rsi; dec ecx; jnz caller; ret
    // f:      add r13, 2; ret
    // done:
    const code = 'bf00200020c7074983c501c64704c34889fe4c8d8300010000b9b80b0000e82100000048c707'
        + '00000000488d351d0000004c8d8700080000b9b80b0000e802000000eb0f498908ffd6ffc975f7c3'
        + '4983c502c3';
    const cases = CORPUS.cases.slice(0, 2).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `rewritten callee ${i}`, code }));
    for (const budget of [7, 1000])
    {
        const { failures, exits, stats } = compare(cases, budget);
        assert.deepEqual(failures, [], `budget ${budget}`);
        assert.equal(exits, cases.length);
        assert.ok(stats.predicted >= 1, JSON.stringify(stats));
        // Formed again with the old callee's address, the caller's region took
        // the zeros there for code, over a thousand blocks of them, and their
        // page with them: every store of the loop left it.
        assert.ok(stats.blocks < 200 && stats.exits < 20, JSON.stringify(stats));
    }
});

test('indirect calls are wasm calls that return where they were made', ()=>{
    // start:  mov esi, 3
    // again:  lea rdx, [rip + fib]; mov ecx, 10; call rdx; add [rbx], rax
    //         lea rax, [rip + small]; mov [rbx + 64], rax; mov ecx, 7
    //         call qword [rbx + 64]; add [rbx + 8], rax; dec esi; jnz again; jmp done
    // fib:    cmp ecx, 2; jb small; push rcx; dec ecx; lea rdx, [rip + fib]; call rdx
    //         pop rcx; push rax; sub ecx, 2; call fib; pop rdx; add rax, rdx; ret
    // small:  mov eax, ecx; ret
    // done:
    const code = 'be03000000488d1527000000b90a000000ffd2480103488d053600000048894340b9070000'
        + '00ff534048014308ffce75d4eb2383f902721b51ffc9488d15f1ffffffffd2595083e902e8e5ff'
        + 'ffff5a4801d0c389c8c3';
    const cases = CORPUS.cases.slice(0, 4).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `indirect ${i}`, code }));
    /** @type {Record<string, number>} */
    const entered = {};
    for (const budget of [7, 100000])
    {
        for (const transfers of [true, false])
        {
            const { failures, exits, stats } = compare(cases, budget, transfers);
            assert.deepEqual(failures, [], `budget ${budget}, transfers ${transfers}`);
            assert.equal(exits, cases.length);
            entered[`${budget} ${transfers}`] = stats.entered;
        }
    }
    assert.ok(entered['100000 true'] * 4 < entered['100000 false'], JSON.stringify(entered));
});

test('a function called indirectly that jumps out past its caller does not return to it', ()=>{
    // start:  mov esi, 2
    // again:  xor eax, eax; call f
    // after:  add [rbx], rax; dec esi; jnz again; jmp done
    // f:      lea rdx, [rip + g]; call rdx; mov eax, 1000; ret
    // g:      mov eax, 7; add rsp, 16; lea rdx, [rip + after]; jmp rdx
    // done:
    // g leaves both frames by a jump to `after`, where the call to f waits:
    // the wasm call to g waits at f's `mov`, and must not take it for its own.
    const code = 'be0200000031c0e809000000480103ffce75f2eb21488d1508000000ffd2b8e8030000c3b8'
        + '070000004883c410488d15d8ffffffffe2';
    const cases = CORPUS.cases.slice(0, 4).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `jumped out ${i}`, code }));
    for (const budget of [7, 100000])
    {
        // Every call a wasm call, and the small callees formed into their callers.
        for (const leafCalls of [false, true])
        {
            const { failures, exits } = compare(cases, budget, true, undefined, undefined,
                leafCalls);
            assert.deepEqual(failures, [], `budget ${budget}, leafCalls ${leafCalls}`);
            assert.equal(exits, cases.length);
        }
    }
});

test('a region left by a jump goes on expecting the return its caller waits for', ()=>{
    // start:  mov esi, 2
    // again:  mov ecx, 3; xor eax, eax; call f; add [rbx], rax; dec esi; jnz again; jmp done
    // f:      call g                                 a call made inside f's region
    // L:      inc eax; dec ecx; jz fret; lea rdx, [rip + far]; jmp rdx
    // fret:   ret
    // g:      ret
    // far:    add eax, 100; lea rdx, [rip + L]; jmp rdx
    // done:
    // The second pass calls f as a wasm call waiting at `add`; far, entered by a
    // transfer, leaves for L, the address f's own call to g waited at: only the
    // return `add` expects may end the wasm call, not that one.
    const code = 'be02000000b90300000031c0e809000000480103ffce75edeb22e810000000ffc0ffc97409'
        + '488d1504000000ffe2c3c383c064488d15e5ffffffffe2';
    const cases = CORPUS.cases.slice(0, 4).map((/** @type {any} */ one, /** @type {number} */ i)=>
        ({ ...one, text: `expect ${i}`, code }));
    for (const budget of [7, 100000])
    {
        // Every call a wasm call, and the small callees formed into their callers.
        for (const leafCalls of [false, true])
        {
            const { failures, exits } = compare(cases, budget, true, undefined, undefined,
                leafCalls);
            assert.deepEqual(failures, [], `budget ${budget}, leafCalls ${leafCalls}`);
            assert.equal(exits, cases.length);
        }
    }
});

/** SSE forms, one instruction each, as llvm-mc assembles them. */
const SSE_FORMS = [
    ['f30f58c1', 'addss xmm0, xmm1'], ['f20f58c1', 'addsd xmm0, xmm1'],
    ['0f58c1', 'addps xmm0, xmm1'], ['660f58c1', 'addpd xmm0, xmm1'],
    ['0f5cd3', 'subps xmm2, xmm3'], ['f20f5cd3', 'subsd xmm2, xmm3'],
    ['0f59c1', 'mulps xmm0, xmm1'], ['f20f59e5', 'mulsd xmm4, xmm5'],
    ['0f5ec1', 'divps xmm0, xmm1'], ['f20f5ec1', 'divsd xmm0, xmm1'],
    ['f30f5ef7', 'divss xmm6, xmm7'], ['0f51c1', 'sqrtps xmm0, xmm1'],
    ['660f51c1', 'sqrtpd xmm0, xmm1'], ['f30f51d3', 'sqrtss xmm2, xmm3'],
    ['f20f51d3', 'sqrtsd xmm2, xmm3'], ['0f5dc1', 'minps xmm0, xmm1'],
    ['0f5fc1', 'maxps xmm0, xmm1'], ['660f5dc1', 'minpd xmm0, xmm1'],
    ['660f5fc1', 'maxpd xmm0, xmm1'], ['f30f5dc1', 'minss xmm0, xmm1'],
    ['f20f5fc1', 'maxsd xmm0, xmm1'], ['0fc2c100', 'cmpps xmm0, xmm1, 0'],
    ['0fc2c101', 'cmpps xmm0, xmm1, 1'], ['0fc2c102', 'cmpps xmm0, xmm1, 2'],
    ['0fc2c103', 'cmpps xmm0, xmm1, 3'], ['0fc2c104', 'cmpps xmm0, xmm1, 4'],
    ['0fc2c105', 'cmpps xmm0, xmm1, 5'], ['0fc2c106', 'cmpps xmm0, xmm1, 6'],
    ['0fc2c107', 'cmpps xmm0, xmm1, 7'], ['660fc2c101', 'cmppd xmm0, xmm1, 1'],
    ['f20fc2c105', 'cmpsd xmm0, xmm1, 5'], ['f30fc2c103', 'cmpss xmm0, xmm1, 3'],
    ['0f2fc1', 'comiss xmm0, xmm1'], ['0f2ec1', 'ucomiss xmm0, xmm1'],
    ['660f2fc1', 'comisd xmm0, xmm1'], ['660f2ec1', 'ucomisd xmm0, xmm1'],
    ['f3480f2ac0', 'cvtsi2ss xmm0, rax'], ['f2480f2ac0', 'cvtsi2sd xmm0, rax'],
    ['f30f2ac0', 'cvtsi2ss xmm0, eax'], ['f20f2ac0', 'cvtsi2sd xmm0, eax'],
    ['f30f2cc0', 'cvttss2si eax, xmm0'], ['f3480f2cc0', 'cvttss2si rax, xmm0'],
    ['f20f2cc0', 'cvttsd2si eax, xmm0'], ['f2480f2cc0', 'cvttsd2si rax, xmm0'],
    ['f30f2dc0', 'cvtss2si eax, xmm0'], ['f2480f2dc0', 'cvtsd2si rax, xmm0'],
    ['0f5bc1', 'cvtdq2ps xmm0, xmm1'], ['f30f5bc1', 'cvttps2dq xmm0, xmm1'],
    ['660f5bc1', 'cvtps2dq xmm0, xmm1'], ['f30fe6c1', 'cvtdq2pd xmm0, xmm1'],
    ['660fe6c1', 'cvttpd2dq xmm0, xmm1'], ['f20fe6c1', 'cvtpd2dq xmm0, xmm1'],
    ['f30f5ac1', 'cvtss2sd xmm0, xmm1'], ['f20f5ac1', 'cvtsd2ss xmm0, xmm1'],
    ['0f5ac1', 'cvtps2pd xmm0, xmm1'], ['660f5ac1', 'cvtpd2ps xmm0, xmm1'],
    ['0f53c1', 'rcpps xmm0, xmm1'], ['f30f53d3', 'rcpss xmm2, xmm3'],
    ['0f52c1', 'rsqrtps xmm0, xmm1'], ['f30f52d3', 'rsqrtss xmm2, xmm3'],
    ['660ff1c1', 'psllw xmm0, xmm1'], ['660fd2c1', 'psrld xmm0, xmm1'],
    ['660fe1c1', 'psraw xmm0, xmm1'], ['660fe2c1', 'psrad xmm0, xmm1'],
    ['660fd3c1', 'psrlq xmm0, xmm1'], ['660f73f03f', 'psllq xmm0, 63'],
    ['660f71d010', 'psrlw xmm0, 16'], ['660f71e014', 'psraw xmm0, 20'],
    ['660f73f805', 'pslldq xmm0, 5'], ['660f73d811', 'psrldq xmm0, 17'],
    ['660fe5c1', 'pmulhw xmm0, xmm1'], ['660fe4c1', 'pmulhuw xmm0, xmm1'],
    ['660ff4c1', 'pmuludq xmm0, xmm1'], ['660ff5c1', 'pmaddwd xmm0, xmm1'],
    ['660ff6c1', 'psadbw xmm0, xmm1'], ['660f63c1', 'packsswb xmm0, xmm1'],
    ['660f6bc1', 'packssdw xmm0, xmm1'], ['660f67c1', 'packuswb xmm0, xmm1'],
    ['660fd7c0', 'pmovmskb eax, xmm0'], ['0f50c0', 'movmskps eax, xmm0'],
    ['660f50c0', 'movmskpd eax, xmm0'], ['660fc5c005', 'pextrw eax, xmm0, 5'],
    ['660fc4c003', 'pinsrw xmm0, eax, 3'], ['660f70c11b', 'pshufd xmm0, xmm1, 0x1b'],
    ['f20f70c193', 'pshuflw xmm0, xmm1, 0x93'], ['f30f70c14e', 'pshufhw xmm0, xmm1, 0x4e'],
    ['0fc6c1b1', 'shufps xmm0, xmm1, 0xb1'], ['660fc6c102', 'shufpd xmm0, xmm1, 2'],
    ['0f14c1', 'unpcklps xmm0, xmm1'], ['660f15c1', 'unpckhpd xmm0, xmm1'],
    ['0f12c1', 'movhlps xmm0, xmm1'], ['0f16c1', 'movlhps xmm0, xmm1'],
    ['660f6ec0', 'movd xmm0, eax'], ['66480f6ec0', 'movq xmm0, rax'],
    ['66480f7ec0', 'movq rax, xmm0'], ['660f7ec0', 'movd eax, xmm0'],
    ['f30f7ec1', 'movq xmm0, xmm1'], ['f30f10c1', 'movss xmm0, xmm1'],
    ['f20f10c1', 'movsd xmm0, xmm1'], ['660fdfc1', 'pandn xmm0, xmm1'],
    ['0f55c1', 'andnps xmm0, xmm1'], ['660f66c1', 'pcmpgtd xmm0, xmm1'],
    ['660fe0c1', 'pavgb xmm0, xmm1'],
];

test('SSE on NaNs, infinities, zeros, denormals and the edges of conversion', ()=>{
    const singles = [0x00000000, 0x80000000, 0x3f800000, 0xbf800000, 0x3fc00000, 0x40200000,
        0xc0200000, 0x3f000000, 0x4f000000, 0xcf000000, 0x4effffff, 0xcf000001, 0x7f800000,
        0xff800000, 0x7fc00001, 0x7f800001, 0xffc00002, 0xff800003, 0x00000001, 0x80000003,
        0x7f7fffff, 0x5f000000, 0xdf000000, 0x4f800000];
    const doubles = [0n, 1n << 63n, 0x3ff0000000000000n, 0xbff0000000000000n, 0x3ff8000000000000n,
        0x4004000000000000n, 0xc004000000000000n, 0x3fe0000000000000n, 0x41e0000000000000n,
        0xc1e0000000000000n, 0x41dfffffffe00000n, 0xc1e0000000100000n, 0xc1e0000000200000n,
        0x7ff0000000000000n, 0xfff0000000000000n, 0x7ff8000000000001n, 0x7ff0000000000001n,
        0xfff8000000000002n, 0xfff0000000000003n, 1n, 0x8000000000000003n, 0x7fefffffffffffffn,
        0x43e0000000000000n, 0xc3e0000000000000n, 0x4340000000000001n, 0x36a0000000000000n];
    const integers = [0n, 1n, (1n << 64n) - 1n, 0x7fffffffn, 0x80000000n, (1n << 63n) - 1n,
        1n << 63n, 0x20000001n, 0x0123456789abcdefn, (1n << 53n) + 1n,
        (1n << 64n) - (1n << 53n) - 1n, 0xffffffffn];
    let x = 0x9e3779b9;
    const next = ()=>{
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x;
    };
    const base = CORPUS.cases[0];
    const cases = [];
    for (const [code, text] of SSE_FORMS)
    {
        for (let k = 0; k < 24; k++)
        {
            const xmm = new Uint8Array(256);
            const view = new DataView(xmm.buffer);
            for (let reg = 0; reg < 16; reg++)
            {
                const kind = next() % 3;
                for (let lane = 0; lane < (kind === 1 ? 2 : 4); lane++)
                {
                    if (kind === 1)
                    {
                        view.setBigUint64(reg * 16 + lane * 8, doubles[next() % doubles.length],
                            true);
                    }
                    else
                    {
                        view.setUint32(reg * 16 + lane * 4,
                            kind === 0 ? singles[next() % singles.length] : next(), true);
                    }
                }
            }
            const regs = [...base.regs];
            regs[0] = integers[next() % integers.length].toString(16);
            // Rounding to nearest mostly; down, up and toward zero now and then.
            const mxcsr = 0x1f80 | (k % 4 === 3 ? (next() % 4) << 13 : 0);
            cases.push({ ...base, text: `${text} #${k}`, code, regs, xmm, mxcsr });
        }
    }
    // Both ways a host may be: an x86 one leaves a NaN as its instruction does, which is
    // the processor's; one whose default NaN is positive has an invalid operation's put
    // right, which on this host must change nothing either.
    for (const defaultNaNNegative of [undefined, false])
    {
        const { failures, stats } = compare(cases, 7, true, undefined, defaultNaNNegative);
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > cases.length / 2, JSON.stringify(stats));
    }
});
