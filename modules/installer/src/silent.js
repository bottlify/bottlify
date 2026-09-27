/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Running an installer without its dialogs.
 *
 * Every installer engine of the period has an unattended mode, switched on
 * from the command line and answered from a file, and the launcher would
 * rather use it than click through a wizard on the person's behalf: the
 * dialogs never appear, the destination is decided here, and what lands on
 * the volume is the progress.
 *
 * Which engine a distribution is built with is read off its bytes -- a
 * runtime the stub extracts, a section the packer names, an archive signature
 * behind the image, the engine's own files beside the entry -- never off the
 * program's name, size or hash. A family is an engine, and everything built
 * with that engine takes the same switches.
 *
 * The destination is `C:\App`, the directory a bundle is mounted at, so the
 * installed tree already has the shape it will be mounted in. Each engine is
 * told that in its own way, and one of them cannot be told at all; the caller
 * reads `destination` rather than assuming it.
 */

import { MEDIA_DIRECTORY } from './prefix.js';

/** Where an unattended install goes, and where a bundle is mounted. */
export const DESTINATION = 'C:\\App';

/**
 * @typedef {'wise' | 'installshield' | 'winzip-sfx' | 'winrar-sfx' | 'msi'} Family
 */

/**
 * @typedef {Object} SeededFile
 * @property {string} path    Absolute guest path.
 * @property {Uint8Array} bytes
 */

/**
 * @typedef {Object} SilentOptions
 * @property {Family} family
 * @property {string} commandLine  argv[0] included and quoted, as `createApp` wants it.
 * @property {SeededFile[]} seeded  Files the engine reads its answers from, put on the
 *                                  volume before the first instruction.
 * @property {string | null} destination  Where the tree will be, or null for an engine
 *                                        that cannot be told and puts it where its own
 *                                        script says.
 */

/**
 * @typedef {Object} PackagedEntry
 * @property {string} name
 * @property {number} at     Where its bytes start.
 * @property {number} size
 */

/** @param {string} text */
const latin1 = text=>Uint8Array.from(text, character=>character.charCodeAt(0) & 0xff);

/** @param {Uint8Array} bytes @param {number} from @param {number} to */
const ascii = (bytes, from, to)=>{
    let text = '';
    const end = Math.min(to, bytes.length);
    for (let at = from; at < end; at++)
    {
        text += String.fromCharCode(bytes[at]);
    }
    return text;
};

/** @param {Uint8Array} bytes @param {string} marker @param {number} at */
const startsWithAt = (bytes, marker, at)=>{
    if (at < 0 || at + marker.length > bytes.length)
    {
        return false;
    }
    for (let index = 0; index < marker.length; index++)
    {
        if (bytes[at + index] !== marker.charCodeAt(index))
        {
            return false;
        }
    }
    return true;
};

/**
 * The parts of a PE this module looks at: the section names, and where the
 * image ends and the overlay -- the payload appended after it -- begins.
 *
 * @param {Uint8Array} bytes
 * @returns {{ sections: string[], overlay: number } | null}  null for a file that is not a PE.
 */
export function readImage(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 0x40 || view.getUint16(0, true) !== 0x5a4d)
    {
        return null;
    }
    const pe = view.getUint32(0x3c, true);
    if (pe + 24 > bytes.length || view.getUint32(pe, true) !== 0x4550)
    {
        return null;
    }
    const count = view.getUint16(pe + 6, true);
    const headers = pe + 24 + view.getUint16(pe + 20, true);
    /** @type {string[]} */
    const sections = [];
    let overlay = headers + count * 40;
    for (let index = 0; index < count; index++)
    {
        const at = headers + index * 40;
        if (at + 40 > bytes.length)
        {
            return null;
        }
        sections.push(ascii(bytes, at, at + 8).replace(/\0+$/, ''));
        overlay = Math.max(overlay, view.getUint32(at + 20, true) + view.getUint32(at + 16, true));
    }
    return { sections, overlay: Math.min(overlay, bytes.length) };
}

/**
 * The files the InstallShield player carries behind its image: a name, a
 * path on the disc, a version and a decimal size, each NUL-ended, and then the
 * bytes. Walked by size, so a payload of any length costs a read per entry.
 *
 * @param {Uint8Array} bytes
 * @param {number} overlay
 * @returns {PackagedEntry[]}  Empty when nothing of that shape is there.
 */
export function packagedEntries(bytes, overlay){
    /** @type {PackagedEntry[]} */
    const entries = [];
    let at = overlay;
    /** @returns {string | null} */
    const field = ()=>{
        const end = bytes.indexOf(0, at);
        if (end < 0 || end - at > 512)
        {
            return null;
        }
        const text = ascii(bytes, at, end);
        at = end + 1;
        return text;
    };
    while (at < bytes.length)
    {
        // The first entry may sit behind padding the packer left.
        const name = field()?.replace(/^(X?PADDING)+X?/, '');
        const path = field();
        const version = field();
        const size = Number(field());
        if (!name || path === null || version === null || !Number.isInteger(size) || size < 0)
        {
            break;
        }
        entries.push({ name, at, size });
        at += size;
    }
    return entries;
}

/** OLE compound file header: what an .msi begins with. */
const COMPOUND_FILE = '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1';
/** RAR 1.5 to 4.x, and RAR 5, as an SFX carries them behind its image. */
const RAR_SIGNATURES = ['Rar!\x1a\x07\x00', 'Rar!\x1a\x07\x01\x00'];
/**
 * What the InstallShield player needs beside or behind itself: its cabinets
 * and settings, and an engine -- `engine32.cab` from version 6, the
 * self-contained `_inst32i.ex_` before it.
 */
const INSTALLSHIELD_FILES = ['data1.cab', 'setup.ini'];
const INSTALLSHIELD_ENGINES = ['engine32.cab', '_inst32i.ex_'];

/**
 * A file's family, from its bytes.
 *
 * - Wise Installation System: a small stub whose runtime, `Wise0132.dll`, is
 *   extracted from the payload and entered at `WiseMain`. Both names sit in
 *   the stub's own image.
 * - WinZip Self-Extractor: the payload is a PE section named `_winzip_`.
 * - WinRAR SFX: a RAR archive begins where the image ends.
 * - InstallShield: the Setup Player names itself in its image, and carries
 *   the engine's own files -- `data1.cab`, `engine32.cab`, `setup.ini` --
 *   either in an appended directory or beside the entry on a disc.
 * - Windows Installer: a compound file rather than a PE.
 *
 * @param {Uint8Array} bytes  The entry executable.
 * @param {string[]} [beside]  Names of the files beside it on the media.
 * @returns {Family | null}
 */
export function detectFamily(bytes, beside = []){
    if (startsWithAt(bytes, COMPOUND_FILE, 0))
    {
        return 'msi';
    }
    const image = readImage(bytes);
    if (!image)
    {
        return null;
    }
    if (image.sections.includes('_winzip_'))
    {
        return 'winzip-sfx';
    }
    if (RAR_SIGNATURES.some(signature=>startsWithAt(bytes, signature, image.overlay)))
    {
        return 'winrar-sfx';
    }
    // The stub's own image is small; the payload behind it is not, and a
    // marker found there would be found in whatever the payload happens to
    // carry. Names are matched without regard to case, as the files are.
    const stub = ascii(bytes, 0, image.overlay).toLowerCase();
    if (stub.includes('wisemain') && stub.includes('wise0132.dll'))
    {
        return 'wise';
    }
    const names = [...beside, ...packagedEntries(bytes, image.overlay).map(entry=>entry.name)]
        .map(name=>name.toLowerCase());
    if (stub.includes('installshield') && INSTALLSHIELD_FILES.every(name=>names.includes(name))
        && INSTALLSHIELD_ENGINES.some(name=>names.includes(name)))
    {
        return 'installshield';
    }
    return null;
}

/**
 * The `Key=value` in a section of an ini text, or null.
 *
 * @param {string} text @param {string} section @param {string} key
 */
const iniValue = (text, section, key)=>{
    let inside = false;
    for (const line of text.split(/\r?\n/))
    {
        const heading = /^\s*\[(.*)\]\s*$/.exec(line);
        if (heading)
        {
            inside = heading[1].toLowerCase() === section.toLowerCase();
            continue;
        }
        const pair = inside ? /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line) : null;
        if (pair && pair[1].toLowerCase() === key.toLowerCase())
        {
            return pair[2];
        }
    }
    return null;
};

/**
 * The response file an InstallScript engine reads in silent mode.
 *
 * Every dialog the script shows is looked up by name under the product's
 * GUID, and one that is not there stops the install with -3. So every
 * dialog the engine's standard script library has is answered here, each
 * with Next and the destination where a dialog asks for one; a project's own
 * dialog, one this list does not know, is what the launcher then reads about
 * in the engine's log. The order is the one recording writes; the engine
 * finds each answer by the dialog's name.
 *
 * @param {string} guid  Without braces.
 * @param {string} destination
 * @returns {string}
 */
export function responseFile(guid, destination){
    const product = `{${guid}}`;
    /** @type {[string, string[]][]} */
    const dialogs = [
        ['SdWelcome', ['Result=1']],
        ['SdLicense', ['Result=1']],
        ['SdLicense2', ['Result=1']],
        ['SdLicenseEx', ['Result=1']],
        ['SdRegisterUser', ['Result=1', 'szName=User', 'szCompany=']],
        ['SdAskDestPath', ['Result=1', `szDir=${destination}`]],
        ['SdAskDestPath2', ['Result=1', `szDir=${destination}`]],
        ['SdSetupType', ['Result=301', `szDir=${destination}`]],
        ['SdSetupTypeEx', ['Result=1', 'szSetupType=Typical']],
        ['SdComponentDialog2', ['Result=1']],
        ['SdSelectFolder', ['Result=1', 'szFolder=Games']],
        ['SdStartCopy', ['Result=1']],
        ['SdStartCopy2', ['Result=1']],
        ['SdFinish', ['Result=1', 'bOpt1=0', 'bOpt2=0']],
        ['SdFinishReboot', ['Result=1', 'BootOption=0']],
    ];
    const lines = [
        '[InstallShield Silent]',
        'Version=v7.00',
        'File=Response File',
        '[File Transfer]',
        'OverwrittenReadOnly=NoToAll',
        `[${product}-DlgOrder]`,
        ...dialogs.map(([name], index)=>`Dlg${index}=${product}-${name}-0`),
        `Count=${dialogs.length}`,
    ];
    for (const [name, answers] of dialogs)
    {
        lines.push(`[${product}-${name}-0]`, ...answers);
    }
    return `${lines.join('\r\n')}\r\n`;
}

/** What each standard dialog is answered with: Next, and the destination where it asks. */
const DIALOG_ANSWERS = /** @type {Record<string, (destination: string) => string[]>} */ ({
    SdWelcome: ()=>['Result=1'],
    SdLicense: ()=>['Result=1'],
    SdShowInfoList: ()=>['Result=1'],
    SdRegisterUser: ()=>['Result=1', 'szName=User', 'szCompany='],
    SdRegisterUserEx: ()=>['Result=1', 'szName=User', 'szCompany=', 'szSerial='],
    SdConfirmRegistration: ()=>['Result=1'],
    SdAskDestPath: destination=>['Result=1', `szDir=${destination}`],
    SdSetupType: destination=>['Result=301', `szDir=${destination}`],
    SdSelectFolder: ()=>['Result=1', 'szFolder=Games'],
    SdStartCopy: ()=>['Result=1'],
    SdFinish: ()=>['Result=1', 'bOpt1=0', 'bOpt2=0'],
    SdFinishReboot: ()=>['Result=1', 'BootOption=0'],
});

/**
 * The response file an InstallShield 5 engine reads in silent mode.
 *
 * Unlike a later engine's, it names each dialog without a product GUID and
 * holds the engine to the order in `[DlgOrder]`: a dialog the script shows
 * that is neither the next one listed nor the one after it ends the install
 * with -12. That order is the script's own and is not written down anywhere
 * outside it, so it is learned by running -- the dialog each run reached
 * (see `dialogCalled`) is added to the next run's list, which is how the
 * engine's own record mode learns it from a person.
 *
 * @param {string[]} order  Dialog names in the order the script shows them.
 * @param {string} destination
 * @returns {string}
 */
export function responseFileV5(order, destination){
    // A dialog is the first of its name unless the name says which: the
    // script's own message boxes are counted, MessageBox-0, MessageBox-1.
    const section = (/** @type {string} */ name)=>(/-\d+$/.test(name) ? name : `${name}-0`);
    const lines = [
        '[InstallShield Silent]',
        'Version=v5.00.000',
        'File=Response File',
        '[File Transfer]',
        'OverwriteReadOnly=NoToAll',
        '[DlgOrder]',
        ...order.map((name, index)=>`Dlg${index}=${section(name)}`),
        `Count=${order.length}`,
    ];
    for (const name of order)
    {
        lines.push(`[${section(name)}]`,
            ...(DIALOG_ANSWERS[name.replace(/-\d+$/, '')]?.(destination) ?? ['Result=1']));
    }
    return `${lines.join('\r\n')}\r\n`;
}

/**
 * The dialog an InstallShield 5 engine is about to show in silent mode, read
 * off the call that names its section (`wsprintfA(buffer, "%s-%ld", name, n)`),
 * or the script's own message box, which is named by its count
 * (`wsprintfA(buffer, "MessageBox-%d", n)`), or null for any other call.
 *
 * @param {{ name: string, strings?: (string | null)[], args?: number[] }} call
 *     A bridge call record.
 * @returns {string | null}
 */
export function dialogCalled(call){
    if (!/wsprintfA$/.test(call.name))
    {
        return null;
    }
    if (call.strings?.[1] === 'MessageBox-%d')
    {
        return `MessageBox-${call.args?.[2] ?? 0}`;
    }
    return call.strings?.[1] === '%s-%ld' ? call.strings?.[2] ?? null : null;
}

/**
 * The product GUID an InstallShield response file is keyed by, from the
 * `setup.ini` the player carries or the disc holds.
 *
 * @param {import('./prefix.js').InstallMedia} media
 * @returns {string | null}
 */
const productGuid = media=>{
    const image = readImage(media.bytes);
    const beside = (media.files ?? []).find(file=>file.name.toLowerCase() === 'setup.ini');
    const packaged = image
        ? packagedEntries(media.bytes, image.overlay)
            .find(entry=>entry.name.toLowerCase() === 'setup.ini')
        : undefined;
    const ini = beside?.bytes
        ?? (packaged ? media.bytes.subarray(packaged.at, packaged.at + packaged.size) : null);
    if (!ini)
    {
        return null;
    }
    const guid = iniValue(ascii(ini, 0, ini.length), 'Startup', 'ProductGUID');
    return guid === null ? null : guid.replace(/^\{|\}$/g, '');
};

/**
 * How to run a distribution unattended, or null when its engine has no such
 * mode this module knows.
 *
 * - **Wise**: `/S` is the stub's own switch and has to come first. The
 *   destination goes through the runtime's `/M=<file>` values file, read at
 *   every `Set Variable` the script marked for it. The wizard-built scripts
 *   set `MAINDIR` to a bare name there and prepend the Program Files
 *   directory afterwards, so the value is `..\App`: under Program Files
 *   that resolves to the destination, and a script that takes the value as
 *   a whole path resolves it against the media directory to the same place.
 * - **InstallShield**: `/s` with a response file named by `/f1` and a log
 *   by `/f2`, both absolute because the player runs from a temporary copy.
 *   A package carrying an `.msi` is driven through Windows Installer's own
 *   switches instead, passed on with `/v`.
 * - **WinZip Self-Extractor**: `/auto <folder>` presses Unzip for the
 *   person; the extractor still shows its progress.
 * - **WinRAR SFX**: `-s` skips the start and licence dialogs. The module
 *   reads no destination switch; the archive's own script decides.
 * - **Windows Installer**: nothing in the guest runs an `.msi`.
 *
 * Silent is a choice, not a default: an install with a screen runs the
 * distribution's own wizard, and only a run with none -- a terminal, a
 * script -- asks for this, and passes createApp's `unattended` beside it so
 * that a dialog the silent run raises anyway is answered rather than waited on.
 *
 * @param {import('./prefix.js').InstallMedia} media
 * @param {{ silent?: boolean, dialogs?: string[] }} [choice]  `silent` asks for the
 *     unattended mode, which nothing gets without it; `dialogs` is an InstallShield 5
 *     script's dialog order as far as earlier runs found it (`responseFileV5`).
 * @returns {SilentOptions | null}
 */
export function silentOptions(media, choice = {}){
    if (choice.silent !== true)
    {
        return null;
    }
    const learned = choice;
    const beside = (media.files ?? []).map(file=>file.name);
    const family = detectFamily(media.bytes, beside);
    const image = `${MEDIA_DIRECTORY}\\${media.name}`;
    switch (family){
        case 'wise': {
            const values = `${MEDIA_DIRECTORY}\\bottlify-wise.txt`;
            return {
                family,
                commandLine: `"${image}" /S /M=${values}`,
                seeded: [{ path: values, bytes: latin1('MAINDIR=..\\App\r\n') }],
                destination: DESTINATION,
            };
        }
        case 'installshield': {
            if (beside.some(name=>/\.msi$/i.test(name)))
            {
                return {
                    family,
                    commandLine: `"${image}" /s /v"/qn INSTALLDIR=${DESTINATION}"`,
                    seeded: [],
                    destination: DESTINATION,
                };
            }
            const response = `${MEDIA_DIRECTORY}\\bottlify.iss`;
            const log = `${MEDIA_DIRECTORY}\\bottlify.log`;
            if (beside.some(name=>name.toLowerCase() === '_inst32i.ex_'))
            {
                return {
                    family,
                    commandLine: `"${image}" -s -f1${response} -f2${log}`,
                    seeded: [{ path: response,
                        bytes: latin1(responseFileV5(learned.dialogs ?? ['SdWelcome'],
                            DESTINATION)) }],
                    destination: DESTINATION,
                };
            }
            const guid = productGuid(media);
            if (guid === null)
            {
                return null;
            }
            return {
                family,
                commandLine: `"${image}" /s /f1"${response}" /f2"${log}"`,
                seeded: [{ path: response, bytes: latin1(responseFile(guid, DESTINATION)) }],
                destination: DESTINATION,
            };
        }
        case 'winzip-sfx':
            return {
                family,
                commandLine: `"${image}" /auto ${DESTINATION}`,
                seeded: [],
                destination: DESTINATION,
            };
        case 'winrar-sfx':
            return {
                family,
                commandLine: `"${image}" -s`,
                seeded: [],
                destination: null,
            };
        default:
            return null;
    }
}
