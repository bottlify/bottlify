/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The start-up that runs before `main`. What is checked here is what a wrong
 * answer costs: a program whose start-up cannot complete never reaches a line
 * anybody wrote, and from outside it is a process that maps, resolves every
 * import and exits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStartupFunctions, splitCommandLine } from './startup.js';

const HEAP_BASE = 0x00500000;

/** Guest memory as a flat array, plus a bump allocator over the top of it. */
function fakeMachine(commandLine = '"C:\\App\\Game.exe"'){
    const bytes = new Uint8Array(0x600000);
    let next = HEAP_BASE;
    /** @type {number[]} */
    const called = [];
    /** @type {number[]} */
    const exited = [];

    const machine = {
        bytes,
        called,
        exited,
        /** @param {number} address */
        u32: address=>(bytes[address] | bytes[address + 1] << 8
            | bytes[address + 2] << 16 | bytes[address + 3] << 24) >>> 0,
        /** @param {number} address @param {number[]} values */
        putU32s(address, values){
            values.forEach((value, index)=>{
                const at = address + index * 4;
                bytes[at] = value & 0xff;
                bytes[at + 1] = (value >>> 8) & 0xff;
                bytes[at + 2] = (value >>> 16) & 0xff;
                bytes[at + 3] = (value >>> 24) & 0xff;
            });
        },
        /** @param {number} address */
        string(address){
            let end = address;
            while (bytes[end] !== 0)
            {
                end++;
            }
            return new TextDecoder('latin1').decode(bytes.subarray(address, end));
        },
        /** The vector at `address`, as the strings it points at. */
        /** @param {number} address */
        vector(address){
            const out = [];
            for (let at = address; machine.u32(at) !== 0; at += 4)
            {
                out.push(machine.string(machine.u32(at)));
            }
            return out;
        },
    };

    const fns = createStartupFunctions({
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} size */
        allocate(size){
            const at = next;
            next += size + 15 & ~15;
            return at;
        },
        commandLine: ()=>commandLine,
        /** @param {number} entry */
        callGuest: entry=>{
            called.push(entry);
            return Promise.resolve(0);
        },
        /** @param {number} code */
        exitProcess: code=>{
            exited.push(code);
            return 'parked';
        },
    });
    return { machine, fns };
}

// --- the command line ---

test('a command line splits the way the C runtime splits it', ()=>{
    assert.deepEqual(splitCommandLine('game.exe -install'), ['game.exe', '-install']);
    assert.deepEqual(splitCommandLine('  game.exe\t-a  -b '), ['game.exe', '-a', '-b']);
    assert.deepEqual(splitCommandLine(''), [], 'no arguments at all is not one empty one');
});

test('a quoted path with a space in it stays one argument', ()=>{
    // The failure this prevents: a program splits its own installation
    // directory in two and then cannot find itself.
    assert.deepEqual(
        splitCommandLine('"C:\\Program Files\\Game\\game.exe" -q'),
        ['C:\\Program Files\\Game\\game.exe', '-q']);
});

test('backslashes before a quote follow the runtime\'s halving rule', ()=>{
    // An even run is halved and the quote still toggles; an odd run is halved
    // and the quote is a literal character. This is the runtime's rule and not
    // the shell's, and a path ending in a separator depends on it.
    assert.deepEqual(splitCommandLine('a\\\\"b c"'), ['a\\b c']);
    assert.deepEqual(splitCommandLine('a\\\\\\"b c'), ['a\\"b', 'c']);
    assert.deepEqual(splitCommandLine('"C:\\dir\\\\" next'), ['C:\\dir\\', 'next']);
});

test('an empty quoted argument is an argument', ()=>{
    assert.deepEqual(splitCommandLine('game.exe "" -x'), ['game.exe', '', '-x']);
});

// --- what the start-up asks for ---

test('__getmainargs hands back a vector the program can walk', ()=>{
    const { machine, fns } = fakeMachine('"C:\\App\\Setup.exe" /S "two words"');
    const ARGC = 0x1000;
    const ARGV = 0x1010;
    const ENV = 0x1020;

    assert.equal(fns.__getmainargs.handler([ARGC, ARGV, ENV, 0, 0]), 0);
    assert.equal(machine.u32(ARGC), 3);
    assert.deepEqual(machine.vector(machine.u32(ARGV)),
        ['C:\\App\\Setup.exe', '/S', 'two words']);

    // Not null: a program walks the environment to a terminator, and a null
    // pointer is what it checks to decide the runtime failed.
    assert.notEqual(machine.u32(ENV), 0);
    assert.deepEqual(machine.vector(machine.u32(ENV)), []);
});

test('asking twice gets the same vector, not a second one', ()=>{
    // Some start-up paths ask more than once, and two vectors leave a program
    // comparing pointers that are both its own and never equal.
    const { machine, fns } = fakeMachine();
    const ARGC = 0x1000;
    const ARGV = 0x1010;
    const ENV = 0x1020;

    fns.__getmainargs.handler([ARGC, ARGV, ENV, 0, 0]);
    const first = machine.u32(ARGV);
    fns.__getmainargs.handler([ARGC, ARGV, ENV, 0, 0]);

    assert.equal(machine.u32(ARGV), first);
});

test('__getmainargs writes nothing through a null pointer', ()=>{
    const { fns } = fakeMachine();
    assert.equal(fns.__getmainargs.handler([0, 0, 0, 0, 0]), 0);
});

// --- the static constructors ---

test('_initterm calls every entry in the table, in order', ()=>{
    // These are the static constructors of every C++ object with global
    // lifetime. Skipping them is not a crash: it is a program whose globals are
    // all zero, behaving as though nothing was ever configured.
    const { machine, fns } = fakeMachine();
    const TABLE = 0x2000;
    machine.putU32s(TABLE, [0x401000, 0x402000, 0x403000]);

    const result = fns._initterm.handler([TABLE, TABLE + 12]);
    assert.equal(typeof result.then, 'function', 'running guest code waits');

    return result.then(()=>{
        assert.deepEqual(machine.called, [0x401000, 0x402000, 0x403000]);
    });
});

test('_initterm steps over the gaps the linker left', ()=>{
    // A padded section leaves null entries, and calling one is a jump to zero.
    const { machine, fns } = fakeMachine();
    const TABLE = 0x2000;
    machine.putU32s(TABLE, [0, 0x401000, 0, 0x402000, 0]);

    return fns._initterm.handler([TABLE, TABLE + 20]).then(()=>{
        assert.deepEqual(machine.called, [0x401000, 0x402000]);
    });
});

test('_initterm over an empty or backwards range calls nothing', ()=>{
    const { machine, fns } = fakeMachine();
    assert.equal(fns._initterm.handler([0x2000, 0x2000]), 0);
    assert.equal(fns._initterm.handler([0x2000, 0x1000]), 0);
    assert.equal(fns._initterm.handler([0, 0x2000]), 0);
    assert.deepEqual(machine.called, []);
});

test('_initterm_e stops at the first initialiser that fails', ()=>{
    // Each of these answers with a code, and running the rest after one has
    // failed runs initialisers that depend on it.
    const bytes = new Uint8Array(0x600000);
    /** @type {number[]} */
    const called = [];
    const fns = createStartupFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        allocate: ()=>HEAP_BASE,
        commandLine: ()=>'game.exe',
        callGuest: entry=>{
            called.push(entry);
            return Promise.resolve(entry === 0x402000 ? 7 : 0);
        },
        exitProcess: ()=>'parked',
    });
    const TABLE = 0x2000;
    [0x401000, 0x402000, 0x403000].forEach((value, index)=>{
        const at = TABLE + index * 4;
        bytes[at] = value & 0xff;
        bytes[at + 1] = (value >>> 8) & 0xff;
        bytes[at + 2] = (value >>> 16) & 0xff;
        bytes[at + 3] = (value >>> 24) & 0xff;
    });

    return fns._initterm_e.handler([TABLE, TABLE + 12]).then((/** @type {number} */ code)=>{
        assert.equal(code, 7);
        assert.deepEqual(called, [0x401000, 0x402000], 'the third was not reached');
    });
});

// --- the runtime's own state ---

test('_controlfp changes only the bits the mask names, and reports the word', ()=>{
    // A program sets this to make its arithmetic reproducible and reads it back
    // to check; an answer that is not what it asked for fails that check.
    const { fns } = fakeMachine();

    const initial = fns._controlfp.handler([0, 0]);
    assert.equal(initial, 0x0009001f, 'the MSVC default');

    // The rounding-control pair, which the default leaves clear.
    assert.equal(fns._controlfp.handler([0x00000200, 0x00000300]), 0x0009021f);
    assert.equal(fns._controlfp.handler([0, 0]), 0x0009021f, 'and it stays changed');
    assert.equal(fns._controlfp.handler([0xffffffff, 0]), 0x0009021f,
        'a mask of nothing changes nothing, whatever is asked for');
    assert.equal(fns._controlfp.handler([0, 0x00000300]), 0x0009001f, 'and it clears back');
});

test('the runtime\'s globals are reachable and stay at one address', ()=>{
    // A program linked against the DLL cannot name these, so it reaches them
    // through an accessor -- and it writes through what it gets back, so the
    // same call has to answer with the same address every time.
    const { machine, fns } = fakeMachine();

    const commode = fns.__p__commode.handler([]);
    const fmode = fns.__p__fmode.handler([]);
    assert.notEqual(commode, 0);
    assert.notEqual(fmode, 0);
    assert.notEqual(commode, fmode, 'two globals, two addresses');
    assert.equal(fns.__p__commode.handler([]), commode);
    assert.equal(machine.u32(commode), 0);
});

test('exit ends the process and does not come back', ()=>{
    const { machine, fns } = fakeMachine();

    assert.equal(fns.exit.handler([3]), 'parked');
    assert.equal(fns._exit.handler([4]), 'parked');
    assert.equal(fns._amsg_exit.handler([5]), 'parked');
    assert.deepEqual(machine.exited, [3, 4, 5]);
});

test('_cexit runs the teardown and returns, which is not the same as exiting', ()=>{
    // A program calls this when it means to keep going afterwards, and ending
    // here would take away the rest of its shutdown.
    const { machine, fns } = fakeMachine();

    assert.equal(fns._cexit.handler([]), 0);
    assert.equal(fns._c_exit.handler([]), 0);
    assert.deepEqual(machine.exited, []);
});

test('every entry point is cdecl and declares the stack it does not pop', ()=>{
    // The C runtime is cdecl: the caller cleans up. A handler marked stdcall
    // would have the stub pop the arguments as well, and the caller's stack
    // would be adrift by exactly the argument list on every call.
    const { fns } = fakeMachine();
    for (const [name, entry] of Object.entries(fns))
    {
        assert.equal(entry.convention, 'cdecl', `${name} is cdecl`);
    }
    assert.equal(fns.__getmainargs.argBytes, 20);
    assert.equal(fns._initterm.argBytes, 8);
    assert.equal(fns._controlfp.argBytes, 8);
    assert.equal(fns.__p__commode.argBytes, 0);
    assert.equal(fns.exit.argBytes, 4);
});
