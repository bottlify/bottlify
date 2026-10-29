/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * BuildCommDCB's device-control strings, as the `mode` command takes them,
 * read into the DCB fields they set. Two forms, after an optional `COMn:`:
 *
 *   baud=9600 parity=e data=7 stop=1 xon=on odsr=off octs=off dtr=on
 *       rts=on idsr=on to=on       -- one space or more between pairs
 *   96,e,7,1[,x|p]                 -- the old one; the baud may be abbreviated
 *
 * A field the string does not name is left as it was, except the stop bits,
 * which the new form sets to one when it is not given. The old form sets the
 * flow control too: none, XON/XOFF (`x`) or hardware (`p`). What Windows NT
 * leaves alone is left alone here: the length, fBinary and fParity.
 */

/** DCB, 28 bytes: the fields' offsets, and the bit field's bits. */
const DCB = Object.freeze({ BaudRate: 4, bits: 8, ByteSize: 18, Parity: 19, StopBits: 20 });
const DCB_SIZE = 28;
const BITS = Object.freeze({
    fOutxCtsFlow: [2, 1], fOutxDsrFlow: [3, 1], fDtrControl: [4, 3], fDsrSensitivity: [6, 1],
    fOutX: [8, 1], fInX: [9, 1], fRtsControl: [12, 3],
});
/** COMMTIMEOUTS: five DWORDs; `to=on` is a minute's write timeout and nothing else. */
const TIMEOUTS_SIZE = 20;
const WRITE_TIMEOUT_ON = 60000;

const PARITY = Object.freeze({ n: 0, o: 1, e: 2, m: 3, s: 4 });
const STOP_BITS = Object.freeze({ 1: 0, '1.5': 1, 2: 2 });
const SWITCH = Object.freeze({ on: 1, off: 0 });
const DTR = Object.freeze({ on: 1, off: 0, hs: 2 });
const RTS = Object.freeze({ on: 1, off: 0, hs: 2, tg: 3 });
/** The old form's two-digit baud rates. */
const ABBREVIATED_BAUD = Object.freeze({ 11: 110, 15: 150, 30: 300, 60: 600, 12: 1200,
    24: 2400, 48: 4800, 96: 9600, 19: 19200 });

/**
 * What a control string sets, or null when Windows refuses it.
 *
 * @typedef {Object} CommSettings
 * @property {Record<string, number>} fields  DCB byte fields and BaudRate, by name
 * @property {Record<string, number>} bits  the bit field's members, by name
 * @property {'on' | 'off' | null} timeouts  `to=`, or null when not given
 */

/** @param {string} text */
const baudOf = text=>(/^\d+$/.test(text) && Number(text) <= 0xffffffff ? Number(text) : null);

/**
 * @param {string} text
 * @returns {CommSettings | null}
 */
export function parseCommString(text){
    let rest = text;
    const device = /^COM(\d+)\s*:\s*/i.exec(rest);
    if (device)
    {
        if (Number(device[1]) === 0)
        {
            return null;
        }
        rest = rest.slice(device[0].length);
    }
    return /^\d/.test(rest) ? oldForm(rest) : newForm(rest);
}

/** @param {string} text @returns {CommSettings | null} */
function oldForm(text){
    const parts = text.split(',').map(part=>part.trim());
    if (parts.length < 4 || parts.length > 5)
    {
        return null;
    }
    const [baudText, parityText, dataText, stopText, flowText = ''] = parts;
    const baud = /^\d\d$/.test(baudText) && baudText in ABBREVIATED_BAUD
        ? ABBREVIATED_BAUD[/** @type {'11'} */ (baudText)] : baudOf(baudText);
    const parity = parityText.length === 1
        ? PARITY[/** @type {'n'} */ (parityText.toLowerCase())] : undefined;
    const data = /^[5-8]$/.test(dataText) ? Number(dataText) : null;
    const stop = STOP_BITS[/** @type {'1'} */ (stopText)];
    const flow = flowText.toLowerCase();
    if (baud === null || parity === undefined || data === null || stop === undefined
        || !['', 'x', 'p'].includes(flow))
    {
        return null;
    }
    const hardware = flow === 'p' ? 1 : 0;
    const software = flow === 'x' ? 1 : 0;
    return {
        fields: { BaudRate: baud, Parity: parity, ByteSize: data, StopBits: stop },
        bits: { fOutxCtsFlow: hardware, fOutxDsrFlow: hardware, fDtrControl: hardware ? 2 : 1,
            fRtsControl: hardware ? 2 : 1, fOutX: software, fInX: software },
        timeouts: null,
    };
}

/** @param {string} text @returns {CommSettings | null} */
function newForm(text){
    if (/^\s/.test(text))
    {
        return null;
    }
    /** @type {CommSettings} */
    const settings = { fields: { StopBits: STOP_BITS[1] }, bits: {}, timeouts: null };
    for (const pair of text.split(' ').filter(part=>part !== ''))
    {
        const match = /^([a-z]+)=(\S+)$/i.exec(pair);
        if (!match)
        {
            return null;
        }
        const key = match[1].toLowerCase();
        const value = match[2].toLowerCase();
        /** @param {Readonly<Record<string, number>>} table */
        const from = table=>(Object.hasOwn(table, value) ? table[value] : undefined);
        /** @type {number | null | undefined} */
        let known;
        switch (key)
        {
            case 'baud':
                known = settings.fields.BaudRate = baudOf(value) ?? NaN;
                break;
            case 'parity':
                known = settings.fields.Parity = from(PARITY) ?? NaN;
                break;
            case 'data':
                known = settings.fields.ByteSize = /^[5-8]$/.test(value) ? Number(value) : NaN;
                break;
            case 'stop':
                known = settings.fields.StopBits = from(STOP_BITS) ?? NaN;
                break;
            case 'xon':
                known = from(SWITCH);
                settings.bits.fOutX = settings.bits.fInX = known ?? 0;
                break;
            case 'odsr':
                known = settings.bits.fOutxDsrFlow = from(SWITCH) ?? NaN;
                break;
            case 'octs':
                known = settings.bits.fOutxCtsFlow = from(SWITCH) ?? NaN;
                break;
            case 'idsr':
                known = settings.bits.fDsrSensitivity = from(SWITCH) ?? NaN;
                break;
            case 'dtr':
                known = settings.bits.fDtrControl = from(DTR) ?? NaN;
                break;
            case 'rts':
                known = settings.bits.fRtsControl = from(RTS) ?? NaN;
                break;
            case 'to':
                known = from(SWITCH);
                settings.timeouts = known === 1 ? 'on' : 'off';
                break;
            default:
                return null;
        }
        if (known === undefined || known === null || Number.isNaN(known))
        {
            return null;
        }
    }
    return settings;
}

/**
 * The DCB and COMMTIMEOUTS a control string makes of the ones given.
 *
 * @param {CommSettings} settings @param {Uint8Array} dcb  DCB_SIZE bytes
 * @param {Uint8Array | null} timeouts  TIMEOUTS_SIZE bytes, when asked for
 */
export function applyCommSettings(settings, dcb, timeouts){
    const view = new DataView(dcb.buffer, dcb.byteOffset, DCB_SIZE);
    for (const [name, value] of Object.entries(settings.fields))
    {
        const at = DCB[/** @type {'Parity'} */ (name)];
        if (name === 'BaudRate')
        {
            view.setUint32(at, value, true);
        }
        else
        {
            view.setUint8(at, value);
        }
    }
    let bits = view.getUint32(DCB.bits, true);
    for (const [name, value] of Object.entries(settings.bits))
    {
        const [shift, mask] = BITS[/** @type {'fOutX'} */ (name)];
        bits = ((bits & ~(mask << shift)) | ((value & mask) << shift)) >>> 0;
    }
    view.setUint32(DCB.bits, bits, true);
    if (timeouts && settings.timeouts !== null)
    {
        timeouts.fill(0);
        if (settings.timeouts === 'on')
        {
            new DataView(timeouts.buffer, timeouts.byteOffset, TIMEOUTS_SIZE)
                .setUint32(16, WRITE_TIMEOUT_ON, true);
        }
    }
}

export { DCB_SIZE, TIMEOUTS_SIZE };
