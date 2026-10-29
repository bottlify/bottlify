/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Rewrites of the C++ exception tables in a 64-bit compiler's assembly, for
 * the fixtures that exercise the runtime's other frame handlers.
 *
 * The compiler here emits only the tables `__CxxFrameHandler3` reads. The
 * later handler, `__CxxFrameHandler4`, reads the same facts in a compressed
 * form: one header byte per function or catch funclet saying which fields
 * follow, unsigned numbers in one to five bytes whose low bits give their
 * length, image-relative offsets as plain 32-bit words, an unwind map whose
 * entries name their next state by a backward byte distance, and an
 * IP-to-state map per function or funclet whose addresses are deltas from its
 * start and whose states are biased by one. `toFrameHandler4` re-encodes every
 * table of an assembly file into that form and points each frame at the new
 * handler, so one C++ source is run under both.
 *
 * `throughGuestHandler` names a language handler of the program's own for the
 * frames of chosen functions, the way a /GS build names `__GSHandlerCheck_EH`,
 * which checks the frame's cookie and then hands the frame to the runtime's.
 *
 * Both work on the text the compiler wrote: the procedures between
 * `.seh_proc` and `.seh_endproc`, the `.seh_handler` each names, the word its
 * handler data starts with, and the labelled `.long` lists of the tables.
 */

/** The FuncInfo the compiler emits, in order, as `.long` operands. */
const FUNC_INFO_FIELDS = 10;

/** FuncInfo4 header bits. */
const FH4 = Object.freeze({
    IS_CATCH: 0x01, UNWIND_MAP: 0x08, TRY_BLOCK_MAP: 0x10, EHS: 0x20,
});

/** HandlerType4 header bits. */
const HANDLER4 = Object.freeze({ ADJECTIVES: 0x01, TYPE: 0x02, CATCH_OBJECT: 0x04 });

/** The unwind map entry types: nothing to run, or a funclet by its offset. */
const UNWIND4 = Object.freeze({ NONE: 0, RVA: 3 });

/**
 * An unsigned number in the compressed form: the low bits of the first byte
 * say how many bytes follow, the rest is the value.
 *
 * @param {number} value
 * @returns {number[]}
 */
export function compressed(value){
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    {
        throw new Error(`no compressed form for ${value}`);
    }
    if (value < 1 << 7)
    {
        return [value << 1];
    }
    if (value < 1 << 14)
    {
        const word = value << 2 | 1;
        return [word & 0xff, word >>> 8];
    }
    if (value < 1 << 21)
    {
        const word = value << 3 | 3;
        return [word & 0xff, word >>> 8 & 0xff, word >>> 16];
    }
    if (value < 1 << 28)
    {
        const word = (value << 4 | 7) >>> 0;
        return [word & 0xff, word >>> 8 & 0xff, word >>> 16 & 0xff, word >>> 24];
    }
    return [0x0f, value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24];
}

/** @param {number[]} bytes */
const byteLine = bytes=>`\t.byte\t${bytes.join(', ')}`;

/** A symbol as an expression may name it: quoted unless it is a plain identifier. @param {string} name */
const symbol = name=>(/^[A-Za-z_.$][\w.$]*$/.test(name) ? name : `"${name}"`);

/** @param {string} line */
const stripComment = line=>line.replace(/\s#.*$/, '').trim();

/**
 * A `.long` operand: a number, or a symbol's image-relative offset plus a
 * constant.
 *
 * @param {string} text
 * @returns {{ value: number } | { label: string, addend: number }}
 */
function operand(text){
    const plain = text.trim();
    if (/^-?\d+$/.test(plain))
    {
        return { value: Number(plain) };
    }
    const match = /^\(?\s*("([^"]+)"|[^\s()@"]+)\s*\)?@IMGREL(?:\s*\+\s*(\d+))?$/.exec(plain);
    if (!match)
    {
        throw new Error(`an operand the tables do not use: ${plain}`);
    }
    return { label: match[2] ?? match[1], addend: Number(match[3] ?? 0) };
}

/** @param {string} line */
const labelOf = line=>{
    const match = /^("([^"]+)"|[A-Za-z_.$?@][\w.$?@]*):/.exec(line.trim());
    return match ? match[2] ?? match[1] : null;
};

/**
 * The procedures of an assembly file and the code labels inside each.
 *
 * @param {string[]} lines
 */
function procedures(lines){
    /** @type {{ name: string, start: number, end: number, handlerLine: number,
     *     dataLine: number }[]} */
    const procs = [];
    /** @type {Map<string, string>} which procedure a code label lies in */
    const owner = new Map();
    /** @type {string[]} */
    let pending = [];
    let inText = true;
    /** @type {typeof procs[number] | null} */
    let current = null;
    let afterHandlerData = false;
    lines.forEach((raw, index)=>{
        const line = stripComment(raw);
        if (/^\.text\b/.test(line) || /^\.section\s+\.text\b/.test(line))
        {
            inText = true;
            return;
        }
        if (/^\.section\b/.test(line))
        {
            inText = false;
            return;
        }
        if (line === '.seh_handlerdata')
        {
            inText = false;
            afterHandlerData = true;
            return;
        }
        const proc = /^\.seh_proc\s+(.+)$/.exec(line);
        if (proc)
        {
            current = { name: proc[1].replace(/^"|"$/g, ''), start: index, end: -1,
                handlerLine: -1, dataLine: -1 };
            procs.push(current);
            for (const label of pending)
            {
                owner.set(label, current.name);
            }
            pending = [];
            return;
        }
        if (!current)
        {
            const label = labelOf(line);
            if (label && inText)
            {
                pending.push(label);
            }
            return;
        }
        if (line === '.seh_endproc')
        {
            current.end = index;
            current = null;
            return;
        }
        if (line.startsWith('.seh_handler '))
        {
            current.handlerLine = index;
            return;
        }
        if (afterHandlerData && line.startsWith('.long'))
        {
            current.dataLine = index;
            afterHandlerData = false;
            return;
        }
        afterHandlerData = false;
        const label = labelOf(line);
        if (label && inText)
        {
            owner.set(label, current.name);
        }
    });
    return { procs, owner };
}

/**
 * The `.long` operands after a label, `count` of them.
 *
 * @param {string[]} lines @param {string} label @param {number} count
 */
function longsAfter(lines, label, count){
    const at = lines.findIndex(line=>labelOf(stripComment(line)) === label);
    if (at < 0)
    {
        throw new Error(`no label ${label}`);
    }
    /** @type {ReturnType<typeof operand>[]} */
    const found = [];
    for (let index = at + 1; found.length < count && index < lines.length; index++)
    {
        const line = stripComment(lines[index]);
        const long = /^\.long\s+(.+)$/.exec(line);
        if (long)
        {
            found.push(operand(long[1]));
        }
        else if (line !== '' && !line.startsWith('.p2align') && labelOf(line) === null)
        {
            throw new Error(`the table at ${label} ends after ${found.length} of ${count} words`);
        }
    }
    return found;
}

/** @param {ReturnType<typeof operand>} op */
const numberOf = op=>{
    if (!('value' in op))
    {
        throw new Error(`a number was expected, not ${op.label}`);
    }
    return op.value;
};

/** @param {ReturnType<typeof operand>} op */
const labelIn = op=>{
    if (!('label' in op))
    {
        return null;
    }
    return op.label;
};

/**
 * The FH3 tables of one function, read from the assembly.
 *
 * @param {string[]} lines @param {string} infoLabel
 */
function readFunction(lines, infoLabel){
    const info = longsAfter(lines, infoLabel, FUNC_INFO_FIELDS);
    const maxState = numberOf(info[1]);
    const tryCount = numberOf(info[3]);
    const ipCount = numberOf(info[5]);
    const ehFlags = numberOf(info[9]);
    const unwind = [];
    if (maxState > 0)
    {
        const words = longsAfter(lines, /** @type {string} */ (labelIn(info[2])), maxState * 2);
        for (let state = 0; state < maxState; state++)
        {
            unwind.push({ to: numberOf(words[state * 2]), action: labelIn(words[state * 2 + 1]) });
        }
    }
    const tries = [];
    if (tryCount > 0)
    {
        const words = longsAfter(lines, /** @type {string} */ (labelIn(info[4])), tryCount * 5);
        for (let index = 0; index < tryCount; index++)
        {
            const entry = words.slice(index * 5, index * 5 + 5);
            const count = numberOf(entry[3]);
            const handlerWords = count > 0
                ? longsAfter(lines, /** @type {string} */ (labelIn(entry[4])), count * 5) : [];
            tries.push({
                low: numberOf(entry[0]), high: numberOf(entry[1]), catchHigh: numberOf(entry[2]),
                handlers: Array.from({ length: count }, (_, at)=>{
                    const words5 = handlerWords.slice(at * 5, at * 5 + 5);
                    return {
                        adjectives: numberOf(words5[0]),
                        type: labelIn(words5[1]),
                        catchObject: numberOf(words5[2]),
                        handler: /** @type {string} */ (labelIn(words5[3])),
                        frame: numberOf(words5[4]),
                    };
                }),
            });
        }
    }
    const ip = [];
    if (ipCount > 0)
    {
        const words = longsAfter(lines, /** @type {string} */ (labelIn(info[6])), ipCount * 2);
        for (let index = 0; index < ipCount; index++)
        {
            const at = words[index * 2];
            if (!('label' in at))
            {
                throw new Error(`an IP-to-state entry at a plain number in ${infoLabel}`);
            }
            ip.push({ label: at.label, addend: at.addend, state: numberOf(words[index * 2 + 1]) });
        }
    }
    return { unwind, tries, ip, ehFlags };
}

/**
 * The unwind map in the compressed form: each entry's next state as the
 * byte distance back to that entry, past the start of the map for none.
 *
 * @param {{ to: number, action: string | null }[]} unwind
 * @returns {string[]}
 */
function unwindMap4(unwind){
    /** @type {number[]} */
    const offsets = [];
    const out = [byteLine(compressed(unwind.length))];
    let at = 0;
    unwind.forEach((entry, state)=>{
        if (entry.to >= state)
        {
            throw new Error(`state ${state} unwinds to ${entry.to}, not to one before it`);
        }
        offsets.push(at);
        const distance = entry.to < 0 ? at + 1 : at - offsets[entry.to];
        const type = entry.action ? UNWIND4.RVA : UNWIND4.NONE;
        const head = compressed((distance << 2 | type) >>> 0);
        out.push(byteLine(head));
        at += head.length;
        if (entry.action)
        {
            out.push(`\t.long\t${symbol(entry.action)}@IMGREL`);
            at += 4;
        }
    });
    return out;
}

/**
 * Rewrites every `__CxxFrameHandler3` frame of the file to `__CxxFrameHandler4`
 * with its tables re-encoded.
 *
 * @param {string} text
 * @returns {string}
 */
export function toFrameHandler4(text){
    const lines = text.split('\n');
    const { procs, owner } = procedures(lines);
    /** @type {Map<string, typeof procs>} */
    const byInfo = new Map();
    for (const proc of procs)
    {
        if (proc.handlerLine < 0 || !/__CxxFrameHandler3\b/.test(lines[proc.handlerLine]))
        {
            continue;
        }
        const data = /\.long\s+(.+)$/.exec(stripComment(lines[proc.dataLine]));
        const info = data && labelIn(operand(data[1]));
        if (!info)
        {
            throw new Error(`${proc.name} names __CxxFrameHandler3 without its tables`);
        }
        byInfo.set(info, [...byInfo.get(info) ?? [], proc]);
    }

    /** @type {string[]} */
    const tables = ['\t.section\t.xdata,"dr"'];
    for (const [info, users] of byInfo)
    {
        const fn = readFunction(lines, info);
        const unwindLabel = `$fh4unwind$${info}`;
        const tryLabel = `$fh4try$${info}`;
        if (fn.unwind.length > 0)
        {
            tables.push(`${symbol(unwindLabel)}:`, ...unwindMap4(fn.unwind));
        }
        if (fn.tries.length > 0)
        {
            tables.push(`${symbol(tryLabel)}:`, byteLine(compressed(fn.tries.length)));
            fn.tries.forEach((entry, index)=>{
                tables.push(byteLine([...compressed(entry.low), ...compressed(entry.high),
                    ...compressed(entry.catchHigh)]),
                `\t.long\t${symbol(`$fh4handlers$${index}$${info}`)}@IMGREL`);
            });
            fn.tries.forEach((entry, index)=>{
                tables.push(`${symbol(`$fh4handlers$${index}$${info}`)}:`,
                    byteLine(compressed(entry.handlers.length)));
                for (const handler of entry.handlers)
                {
                    const header = (handler.adjectives !== 0 ? HANDLER4.ADJECTIVES : 0)
                        | (handler.type ? HANDLER4.TYPE : 0)
                        | (handler.catchObject !== 0 ? HANDLER4.CATCH_OBJECT : 0);
                    tables.push(byteLine([header]));
                    if (handler.adjectives !== 0)
                    {
                        tables.push(byteLine(compressed(handler.adjectives)));
                    }
                    if (handler.type)
                    {
                        tables.push(`\t.long\t${symbol(handler.type)}@IMGREL`);
                    }
                    if (handler.catchObject !== 0)
                    {
                        tables.push(byteLine(compressed(handler.catchObject)));
                    }
                    tables.push(`\t.long\t${symbol(handler.handler)}@IMGREL`);
                }
            });
        }
        for (const proc of users)
        {
            const caught = fn.tries.flatMap(entry=>entry.handlers)
                .find(handler=>handler.handler === proc.name);
            const header = (caught ? FH4.IS_CATCH : 0)
                | (fn.unwind.length > 0 ? FH4.UNWIND_MAP : 0)
                | (fn.tries.length > 0 ? FH4.TRY_BLOCK_MAP : 0)
                | ((fn.ehFlags & 1) !== 0 ? FH4.EHS : 0);
            const infoLabel = `$fh4info$${proc.name}`;
            const ipLabel = `$fh4ip$${proc.name}`;
            tables.push(`${symbol(infoLabel)}:`, byteLine([header]));
            if (fn.unwind.length > 0)
            {
                tables.push(`\t.long\t${symbol(unwindLabel)}@IMGREL`);
            }
            if (fn.tries.length > 0)
            {
                tables.push(`\t.long\t${symbol(tryLabel)}@IMGREL`);
            }
            tables.push(`\t.long\t${symbol(ipLabel)}@IMGREL`);
            if (caught)
            {
                tables.push(byteLine(compressed(caught.frame)));
            }
            // The procedure's own entries, its addresses as deltas from its
            // start in the five-byte form an assembler expression can fill.
            const mine = fn.ip.filter(entry=>(owner.get(entry.label) ?? '') === proc.name);
            tables.push(`${symbol(ipLabel)}:`, byteLine(compressed(mine.length)));
            let previous = symbol(proc.name);
            for (const entry of mine)
            {
                const here = `${symbol(entry.label)}+${entry.addend}`;
                // The entry at the procedure's own symbol is at its start: the
                // assembler takes a difference that begins at a function's
                // symbol as a relocation, so that one is written as a number.
                tables.push(...entry.label === proc.name
                    ? [byteLine(compressed(entry.addend))]
                    : [byteLine([0x0f]), `\t.long\t(${here})-(${previous})`],
                byteLine(compressed(entry.state + 1)));
                previous = here;
            }
            lines[proc.handlerLine] = lines[proc.handlerLine]
                .replace(/__CxxFrameHandler3\b/, '__CxxFrameHandler4');
            lines[proc.dataLine] = `\t.long\t${symbol(infoLabel)}@IMGREL`;
        }
    }
    tables.push('\t.text');
    return `${lines.join('\n')}\n${tables.join('\n')}\n`;
}

/**
 * Names `handler` as the language handler of every frame of the procedures
 * whose names contain `marker`, in place of the runtime's C++ handler.
 *
 * @param {string} text @param {string} marker @param {string} handler
 * @returns {string}
 */
export function throughGuestHandler(text, marker, handler){
    const lines = text.split('\n');
    let changed = 0;
    for (const proc of procedures(lines).procs)
    {
        if (proc.handlerLine >= 0 && proc.name.includes(marker))
        {
            lines[proc.handlerLine] = lines[proc.handlerLine]
                .replace(/__CxxFrameHandler[34]\b/, handler);
            changed++;
        }
    }
    if (changed === 0)
    {
        throw new Error(`no frame of a procedure named like ${marker} has a C++ handler`);
    }
    return lines.join('\n');
}
