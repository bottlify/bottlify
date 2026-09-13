/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createSeh, RECORD, CONTEXT, Disposition, END_OF_CHAIN, EH_UNWINDING, STATUS,
} from './seh.js';

const TEB = 0x8000;
const STACK = 0x40000;

/**
 * Guest memory, a thread block, and a record of what was called.
 *
 * @param {Object} [options]
 * @param {(entry: number, args: number[]) => number} [options.answer]
 */
function machine(options = {}){
    const bytes = new Uint8Array(0x80000);
    const view = new DataView(bytes.buffer);
    /** @type {{ entry: number, args: number[] }[]} */
    const called = [];
    let registers = {
        eax: 0x11, ecx: 0x22, edx: 0x33, ebx: 0x44,
        esp: STACK, ebp: 0x55, esi: 0x66, edi: 0x77,
        eip: 0x401000, eflags: 0x202,
    };

    const host = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        /** @param {number} at @param {Uint8Array} value */
        writeMemory: (at, value)=>bytes.set(value, at),
        // Everything inside the buffer is there; nothing outside is. A bounds
        // test and nothing else, because images are readable rather than
        // executable and asking for execute rejects a real handler.
        /** @param {number} at */
        isMapped: at=>at > 0 && at < bytes.length,
        teb: ()=>TEB,
        registers: ()=>({ ...registers }),
        /** @param {Record<string, number>} values */
        setRegisters: values=>{
            registers = { ...registers, ...values };
        },
        /** @param {{ entry: number, args: number[], stackAtRest?: number }} call */
        callGuest: async call=>{
            called.push({ entry: call.entry, args: [...call.args] });
            return options.answer
                ? options.answer(call.entry, call.args)
                : Disposition.CONTINUE_SEARCH;
        },
    };

    /** @param {number} at @param {number} value */
    const put = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {number} at */
    const get = at=>view.getUint32(at, true);

    /**
     * Builds a chain of frames at ascending addresses, each naming a handler.
     *
     * @param {number[]} handlers
     */
    const registerFrames = handlers=>{
        const frames = handlers.map((handler, index)=>{
            const frame = 0x20000 + index * 0x100;
            put(frame + 4, handler);
            return frame;
        });
        frames.forEach((frame, index)=>
            put(frame, index + 1 < frames.length ? frames[index + 1] : END_OF_CHAIN));
        put(TEB, frames.length > 0 ? frames[0] : END_OF_CHAIN);
        return frames;
    };

    return {
        host, called, put, get, registerFrames,
        seh: createSeh(host),
        registers: ()=>registers,
    };
}

test('the record is eighty bytes, and the parameters are where a handler reads them', ()=>{
    // Sharing the word after the record with its last parameter is invisible
    // while the parameter count is zero, and lethal to a handler that copies
    // the whole structure.
    assert.equal(RECORD.SIZE, 0x50);
    assert.equal(RECORD.INFORMATION, 0x14, 'fifteen parameters follow four dwords and a count');
    assert.equal(RECORD.INFORMATION + 15 * 4, RECORD.SIZE, 'and they fill it exactly');
});

test('the guest context is the layout a handler was compiled against', ()=>{
    // Not the shape the emulator keeps. Every one of these is a translation,
    // and a wrong offset hands a handler a plausible number from the next
    // field along.
    assert.equal(CONTEXT.SIZE, 0x2cc);
    assert.deepEqual(
        [CONTEXT.EDI, CONTEXT.ESI, CONTEXT.EBX, CONTEXT.EDX, CONTEXT.ECX, CONTEXT.EAX],
        [0x9c, 0xa0, 0xa4, 0xa8, 0xac, 0xb0]);
    assert.deepEqual([CONTEXT.EBP, CONTEXT.EIP, CONTEXT.EFLAGS, CONTEXT.ESP],
        [0xb4, 0xb8, 0xc0, 0xc4]);
});

test('every frame is offered the exception, in chain order', async()=>{
    const m = machine();
    m.registerFrames([0x51000, 0x52000, 0x53000]);

    await m.seh.dispatch({ code: STATUS.ACCESS_VIOLATION, address: 0x401000 });

    assert.deepEqual(m.called.map(call=>call.entry), [0x51000, 0x52000, 0x53000],
        'a frame skipped lands the exception in one that should never have seen it');
});

test('a handler is handed the record, its own frame and a context', async()=>{
    const m = machine();
    const [frame] = m.registerFrames([0x51000]);

    await m.seh.dispatch({ code: 0xdeadbeef, address: 0x401234, parameters: [7, 9] });

    const [call] = m.called;
    const [record, given, context] = call.args;
    assert.equal(given, frame, 'the frame it was registered as');
    assert.equal(m.get(record + RECORD.CODE), 0xdeadbeef);
    assert.equal(m.get(record + RECORD.ADDRESS), 0x401234);
    assert.equal(m.get(record + RECORD.PARAMETER_COUNT), 2);
    assert.equal(m.get(record + RECORD.INFORMATION), 7);
    assert.equal(m.get(record + RECORD.INFORMATION + 4), 9);
    assert.equal(context, record + RECORD.SIZE + 4,
        'the context clears the record and the word after it');
    assert.equal(m.get(context + CONTEXT.EIP), 0x401000, 'the registers as they stood');
    assert.equal(m.get(context + CONTEXT.EAX), 0x11);
});

test('the record is built on the program\'s stack, below where it was', async()=>{
    // A fixed address aliases the record a rethrow still points at.
    const m = machine();
    m.registerFrames([0x51000]);

    await m.seh.dispatch({ code: 1, address: 0x401000 });

    const [{ args: [record] }] = m.called;
    assert.ok(record < STACK, 'below the stack pointer, not above it');
    assert.ok(STACK - record >= RECORD.SIZE + CONTEXT.SIZE,
        'with room for the record, the context and the handlers that run below them');
});

test('handlers run below the record they were handed', async()=>{
    // They push onto the same stack. A frame built where the call in flight
    // left the stack has the first handler's own frames grow down over the
    // context and then the record it is reading -- and a C++ frame handler
    // that reads a return address where the exception code was takes the
    // exception for a foreign one and declines it.
    /** @type {(number | undefined)[]} */
    const seen = [];
    const m = machine();
    const original = m.host.callGuest;
    m.host.callGuest = async call=>{
        seen.push(call.stackAtRest);
        return original(call);
    };
    m.registerFrames([0x51000, 0x52000]);

    await m.seh.dispatch({ code: 1, address: 0x401000 });
    await m.seh.unwind(0x20100, 0x401010);

    const [{ args: [record] }] = m.called;
    assert.equal(seen.length, 3);
    for (const stackAtRest of seen)
    {
        assert.ok(stackAtRest !== undefined && stackAtRest <= record,
            'the frame is built at or below the record');
    }
});

test('a context a handler changed is what execution continues with', async()=>{
    // Including the stack pointer: restoring only the instruction pointer
    // leaves the stack a frame out, every time.
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);
    let recorded = 0;
    const original = m.host.callGuest;
    m.host.callGuest = async call=>{
        recorded = call.args[2];
        m.put(recorded + CONTEXT.EIP, 0x77000);
        m.put(recorded + CONTEXT.ESP, 0x3f000);
        m.put(recorded + CONTEXT.EAX, 0xabc);
        return original(call);
    };

    const result = await m.seh.dispatch({ code: 1, address: 0x401000 });

    assert.equal(result.handled, true);
    assert.equal(result.registers?.eip, 0x77000);
    assert.equal(result.registers?.esp, 0x3f000, 'the stack pointer too, not only the address');
    assert.equal(result.registers?.eax, 0xabc);
});

test('a frame whose handler is not there is passed over, not refused', async()=>{
    // The check is a bounds test. Demanding execute permission rejects the
    // program's own handler, because images are mapped readable.
    const m = machine();
    m.registerFrames([0, 0x52000]);

    await m.seh.dispatch({ code: 1, address: 0x401000 });

    assert.deepEqual(m.called.map(call=>call.entry), [0x52000]);
});

test('a nested exception stops the walk instead of repeating it', async()=>{
    const m = machine({ answer: entry=>
        entry === 0x52000 ? Disposition.NESTED_EXCEPTION : Disposition.CONTINUE_SEARCH });
    m.registerFrames([0x51000, 0x52000, 0x53000]);

    await m.seh.dispatch({ code: 1, address: 0x401000 });

    assert.deepEqual(m.called.map(call=>call.entry), [0x51000, 0x52000],
        'the third is not called; carrying on would not terminate');
});

test('a chain that points backwards ends the walk rather than looping', async()=>{
    const m = machine();
    const frames = m.registerFrames([0x51000, 0x52000]);
    m.put(frames[1], frames[0]); // second points back at the first

    const { frames: walked, damaged } = m.seh.chain();

    assert.equal(damaged, true);
    assert.equal(walked.length, 2, 'what was reached before it doubled back');
});

test('unwinding calls each handler with the unwinding flag, and stops at the target', async()=>{
    // A runtime that is not this compiler's depends on being called that way.
    const m = machine();
    const frames = m.registerFrames([0x51000, 0x52000, 0x53000]);

    const result = await m.seh.unwind(frames[2], 0x401000);

    assert.deepEqual(m.called.map(call=>call.entry), [0x51000, 0x52000]);
    const [{ args: [record] }] = m.called;
    assert.equal(m.get(record + RECORD.FLAGS) & EH_UNWINDING, EH_UNWINDING);
    assert.equal(result.unwound, true);
    assert.equal(m.get(TEB), frames[2], 'and the head becomes the target');
});

test('a walk that never reached its target leaves the head alone', async()=>{
    // Writing back the frame the walk gave up on publishes the damage for the
    // next throw to walk again.
    const m = machine();
    const frames = m.registerFrames([0x51000, 0x52000]);

    const result = await m.seh.unwind(0x79000, 0x401000);

    assert.equal(result.unwound, false);
    assert.equal(m.get(TEB), frames[0], 'unchanged');
});

test('a processor fault becomes an exception a program can handle', async()=>{
    const m = machine({ answer: ()=>Disposition.CONTINUE_EXECUTION });
    m.registerFrames([0x51000]);

    const result = await m.seh.onFault({ vector: 14, eip: 0x401500, errorCode: 2 });

    assert.equal(result.handled, true, 'a program that faults on purpose is ordinary');
    const [{ args: [record] }] = m.called;
    assert.equal(m.get(record + RECORD.CODE), STATUS.ACCESS_VIOLATION);
    assert.equal(m.get(record + RECORD.INFORMATION), 1, 'error code bit 1 says it was a write');
});

test('a vector no program can handle is not dressed up as one it can', async()=>{
    const m = machine();
    m.registerFrames([0x51000]);

    const result = await m.seh.onFault({ vector: 8, eip: 0x401500, errorCode: 0 });

    assert.equal(result.handled, false);
    assert.equal(m.called.length, 0, 'a double fault is not offered to the program');
});

test('the top-level filter is guest code, and is called', async()=>{
    // A program's last-chance handler is where it writes its own account of the
    // failure; declining to run it is declining that account.
    const m = machine({ answer: ()=>1 });
    const { table } = m.seh;

    const previous = table.SetUnhandledExceptionFilter.handler([0x61000]);
    assert.equal(previous, 0, 'the one it replaced, so a caller can chain to it');

    const answer = await table.UnhandledExceptionFilter.handler([0x1234]);
    assert.equal(answer, 1);
    assert.deepEqual(m.called, [{ entry: 0x61000, args: [0x1234] }]);
});

test('RaiseException dispatches instead of throwing', async()=>{
    const m = machine();
    m.registerFrames([0x51000]);
    m.put(0x30000, 0xaa);
    m.put(0x30004, 0xbb);

    await m.seh.table.RaiseException.handler([0xe0000001, 0, 2, 0x30000]);

    const [{ args: [record] }] = m.called;
    assert.equal(m.get(record + RECORD.CODE), 0xe0000001);
    assert.equal(m.get(record + RECORD.INFORMATION), 0xaa);
    assert.equal(m.get(record + RECORD.INFORMATION + 4), 0xbb);
});

test('an unhandled non-continuable exception is reported, not returned from', async()=>{
    const m = machine();
    m.registerFrames([]);

    await assert.rejects(
        ()=>m.seh.table.RaiseException.handler([0xc0000017, 1, 0, 0]),
        /could not continue/);
});
