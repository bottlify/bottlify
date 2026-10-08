/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msiexec.exe: the Windows Installer's command line, over msi.dll's own
 * exports.
 *
 * Everything the program does is a call a program could make itself:
 * MsiSetInternalUI for the /q options, MsiEnableLog for /l, then one of
 * MsiInstallProduct, MsiConfigureProductEx, MsiReinstallProduct,
 * MsiApplyPatch, MsiRemovePatches or MsiAdvertiseProduct -- and the process
 * exits with what that answered, which is what a bootstrapper waiting on
 * msiexec reads: 0, 3010 for a restart wanted, 1602 for a cancel, 1603 for a
 * failure. A line msiexec would not take exits 1639, ERROR_INVALID_COMMAND_LINE.
 *
 * The options are the ones Microsoft documents for msiexec ("Command-Line
 * Options" and "Standard Installer Command-Line Options" in the Windows
 * Installer reference); the parse is ours.
 */

import { argumentsOf, splitArguments } from './command-line.js';

export const ERROR_INVALID_COMMAND_LINE = 1639;
const ERROR_SUCCESS = 0;
const ERROR_SUCCESS_REBOOT_REQUIRED = 3010;

/** INSTALLUILEVEL: what MsiSetInternalUI is told. */
export const INSTALLUILEVEL = Object.freeze({
    NONE: 2, BASIC: 3, REDUCED: 4, FULL: 5,
    ENDDIALOG: 0x80, PROGRESSONLY: 0x40, HIDECANCEL: 0x20,
});
/** MsiConfigureProductEx's level and states. */
const INSTALLLEVEL_DEFAULT = 0;
const INSTALLSTATE_ABSENT = 2;
const INSTALLSTATE_DEFAULT = 5;
/** MsiApplyPatch's kinds of target: the product's own, or an administrative image. */
const INSTALLTYPE_DEFAULT = 0;
const INSTALLTYPE_NETWORK_IMAGE = 1;
/** MsiRemovePatches' only kind. */
const INSTALLTYPE_SINGLE_INSTANCE = 2;
/** MsiAdvertiseProduct's script argument when the advertising is to this machine. */
const ADVERTISEFLAGS_MACHINEASSIGN = 0;
const ADVERTISEFLAGS_USERASSIGN = 1;
/** MsiEnableLog's attributes: '+' appends to the file, '!' writes each line out. */
const INSTALLLOGATTRIBUTES_APPEND = 0x1;
const INSTALLLOGATTRIBUTES_FLUSHEACHLINE = 0x2;

/** MessageBox's buttons and icon for the usage text. */
const MB_ICONINFORMATION = 0x40;

/**
 * REINSTALLMODE's letters, each the REINSTALLMODE_* bit MsiReinstallProduct
 * takes for it, from 0x2 up: missing, older, equal, exact, checksum, all,
 * machine data, user data, shortcuts, package. 0x1 is REINSTALLMODE_REPAIR,
 * which no letter spells.
 */
const REPAIR_LETTERS = 'poedcamusv';
/** What /f with no letters asks for, as the documentation gives it. */
const DEFAULT_REPAIR = 'omus';

/** /l's letters, each the INSTALLLOGMODE bit for one kind of message. */
const LOG_MODES = Object.freeze({
    m: 0x1, e: 0x2, w: 0x4, u: 0x8, i: 0x10, c: 0x800, a: 0x100, r: 0x200, o: 0x80,
    p: 0x400, v: 0x1000, x: 0x2000,
});
/** /l with no letters, as the documentation gives it. */
const DEFAULT_LOG = 'iwearmo';
/** '*': every kind but the verbose and the extra debugging ones. */
const LOG_ALL = 'iwearucmop';

/** A product code: a GUID in braces, which is what the installer names a product by. */
const PRODUCT_CODE = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;

/** A property on the command line: a name, an equals sign, and its value as typed. */
const PROPERTY = /^[A-Za-z_][A-Za-z0-9_.]*=/;

/**
 * @typedef {'install' | 'uninstall' | 'repair' | 'admin' | 'patch' | 'advertise'
 *     | 'removePatches'} MsiexecAction
 */

/**
 * @typedef {Object} MsiexecPlan
 * @property {MsiexecAction | 'service' | 'usage'} action
 *     `service` for the options that register msiexec as the installer's
 *     service, which there is nothing to do for; `usage` for a line msiexec
 *     would not take, or a request for its help.
 * @property {string} target    The package, the product code, or for a patch the
 *     patch -- several separated by semicolons.
 * @property {string} [image]   The administrative image a patch is applied to.
 * @property {string} [product] Whose patches /uninstall removes.
 * @property {string} repairMode  REINSTALLMODE's letters, for /f.
 * @property {number | null} ui  The interface level asked for; null when none was.
 * @property {{ mode: number, attributes: number, path: string } | null} log
 * @property {string} properties  What the installation is handed as its command
 *     line: the properties as typed, then those the options stand for.
 * @property {string | null} transforms  /t's list.
 * @property {number} language  /g's language, for an advertisement.
 * @property {number} assign  Whom /j advertises to: ADVERTISEFLAGS_*.
 * @property {string} [reason]  Why the line is refused.
 */

/** @param {string} text */
export const isProductCode = text=>PRODUCT_CODE.test(text);

/**
 * The letters of a /q option as an interface level, or null when they are
 * not a level msiexec knows.
 *
 * @param {string} letters  What follows the q.
 * @returns {number | null}
 */
function uiLevelOf(letters){
    const match = /^([nbrf]?)([+\-!]*)$/i.exec(letters);
    if (!match)
    {
        return null;
    }
    const base = { '': INSTALLUILEVEL.NONE, n: INSTALLUILEVEL.NONE, b: INSTALLUILEVEL.BASIC,
        r: INSTALLUILEVEL.REDUCED, f: INSTALLUILEVEL.FULL }[match[1].toLowerCase()]
        ?? INSTALLUILEVEL.NONE;
    let level = base;
    for (const modifier of match[2])
    {
        level |= modifier === '+' ? INSTALLUILEVEL.ENDDIALOG
            : modifier === '-' ? INSTALLUILEVEL.PROGRESSONLY : INSTALLUILEVEL.HIDECANCEL;
    }
    return level;
}

/**
 * The letters of a /l option as MsiEnableLog's mode and attributes, or null
 * when one of them is not a letter /l takes.
 *
 * @param {string} letters
 * @returns {{ mode: number, attributes: number } | null}
 */
function logModeOf(letters){
    let mode = 0;
    let attributes = 0;
    let kinds = '';
    for (const letter of letters.toLowerCase())
    {
        if (letter === '+')
        {
            attributes |= INSTALLLOGATTRIBUTES_APPEND;
        }
        else if (letter === '!')
        {
            attributes |= INSTALLLOGATTRIBUTES_FLUSHEACHLINE;
        }
        else if (letter === '*')
        {
            kinds += LOG_ALL;
        }
        else if (letter in LOG_MODES)
        {
            kinds += letter;
        }
        else
        {
            return null;
        }
    }
    for (const letter of kinds === '' ? DEFAULT_LOG : kinds)
    {
        mode |= LOG_MODES[/** @type {keyof typeof LOG_MODES} */ (letter)];
    }
    return { mode, attributes };
}

/**
 * REINSTALLMODE's letters as the bits MsiReinstallProduct takes.
 *
 * @param {string} letters
 * @returns {number}
 */
export function repairBits(letters){
    let bits = 0;
    for (const letter of letters.toLowerCase())
    {
        bits |= 1 << (REPAIR_LETTERS.indexOf(letter) + 1);
    }
    return bits >>> 0;
}

/**
 * What a msiexec command line asks for, from the arguments after argv[0].
 *
 * Options open with `/` or `-` and are read without regard to case; an
 * option's argument is the next argument, or for /i, /x, /a and /p what is
 * written straight after the letter, as an uninstall string writes
 * `/X{GUID}`. A property is NAME=value anywhere on the line, kept as typed.
 *
 * @param {string} line
 * @returns {MsiexecPlan}
 */
export function parseMsiexec(line){
    const args = splitArguments(line);
    /** @type {MsiexecPlan} */
    const plan = {
        action: 'usage', target: '', repairMode: DEFAULT_REPAIR, ui: null, log: null,
        properties: '', transforms: null, language: 0, assign: ADVERTISEFLAGS_MACHINEASSIGN,
    };
    /** @param {string} reason */
    const refuse = reason=>Object.assign(plan, { action: 'usage', reason });
    /** @type {string[]} */
    const properties = [];
    /** @type {{ kind: string, target: string }[]} */
    const asked = [];
    let restart = '';
    let index = 0;

    /**
     * An option's argument: what was written straight after it, or the
     * argument after it when that is not an option itself.
     *
     * @param {string} glued
     * @returns {string | null}
     */
    const argumentOf = glued=>{
        if (glued !== '')
        {
            return glued;
        }
        const next = args[index + 1];
        if (!next || /^[/-]/.test(next.text) || next.text === '')
        {
            return null;
        }
        index++;
        return next.text;
    };

    for (; index < args.length; index++)
    {
        const { raw, text } = args[index];
        if (!/^[/-]./.test(text))
        {
            if (!PROPERTY.test(text))
            {
                return refuse(`"${text}" is neither an option nor a property`);
            }
            properties.push(raw);
            continue;
        }
        const option = text.slice(1);
        const word = option.toLowerCase();
        if (word === '?' || word === 'h' || word === 'help')
        {
            return refuse('help was asked for');
        }
        if (word === 'quiet' || word === 'passive')
        {
            plan.ui = word === 'quiet' ? INSTALLUILEVEL.NONE
                : INSTALLUILEVEL.BASIC | INSTALLUILEVEL.PROGRESSONLY | INSTALLUILEVEL.HIDECANCEL;
            continue;
        }
        if (word === 'norestart' || word === 'forcerestart' || word === 'promptrestart')
        {
            restart = { norestart: 'REBOOT=ReallySuppress', forcerestart: 'REBOOT=Force',
                promptrestart: '' }[word];
            continue;
        }
        if (word === 'regserver' || word === 'unregserver' || word === 'unregister')
        {
            asked.push({ kind: 'service', target: '' });
            continue;
        }
        if (word === 'package' || word === 'uninstall' || word === 'update' || word === 'log')
        {
            const target = argumentOf('');
            if (target === null)
            {
                return refuse(`/${option} needs an argument`);
            }
            if (word === 'log')
            {
                plan.log = { ...logModeOf('*') ?? { mode: 0, attributes: 0 }, path: target };
                continue;
            }
            asked.push({ kind: word, target });
            continue;
        }
        const letter = word[0];
        const rest = option.slice(1);
        if (letter === 'i' || letter === 'x' || letter === 'a' || letter === 'p')
        {
            const target = argumentOf(rest);
            if (target === null)
            {
                return refuse(`/${letter} needs a package or a product code`);
            }
            asked.push({ kind: { i: 'install', x: 'uninstall', a: 'admin', p: 'patch' }[letter],
                target });
            continue;
        }
        if (letter === 'f')
        {
            const glued = rest.startsWith('{') ? rest : '';
            const letters = glued === '' ? rest : '';
            if (![...letters.toLowerCase()].every(each=>REPAIR_LETTERS.includes(each)))
            {
                return refuse(`/f takes the letters ${REPAIR_LETTERS}, not "${letters}"`);
            }
            const target = argumentOf(glued);
            if (target === null)
            {
                return refuse('/f needs a package or a product code');
            }
            plan.repairMode = letters === '' ? DEFAULT_REPAIR : letters.toLowerCase();
            asked.push({ kind: 'repair', target });
            continue;
        }
        if (letter === 'j')
        {
            const to = rest.toLowerCase();
            if (to !== 'u' && to !== 'm')
            {
                return refuse('/j advertises to the user (/ju) or to the machine (/jm)');
            }
            const target = argumentOf('');
            if (target === null)
            {
                return refuse('/j needs a package');
            }
            plan.assign = to === 'u' ? ADVERTISEFLAGS_USERASSIGN : ADVERTISEFLAGS_MACHINEASSIGN;
            asked.push({ kind: 'advertise', target });
            continue;
        }
        if (letter === 'q')
        {
            const level = uiLevelOf(rest);
            if (level === null)
            {
                return refuse(`/q${rest} is not an interface level`);
            }
            plan.ui = level;
            continue;
        }
        if (letter === 'l')
        {
            const mode = logModeOf(rest);
            const path = mode && argumentOf('');
            if (!mode || !path)
            {
                return refuse(`/l${rest} needs a log file, after letters /l takes`);
            }
            plan.log = { ...mode, path };
            continue;
        }
        if (letter === 't' || letter === 'g')
        {
            const value = argumentOf(rest);
            if (value === null || (letter === 'g' && !/^\d+$/.test(value)))
            {
                return refuse(`/${letter} needs `
                    + `${letter === 't' ? 'a transform list' : 'a language'}`);
            }
            if (letter === 't')
            {
                plan.transforms = value;
            }
            else
            {
                plan.language = Number(value);
            }
            continue;
        }
        return refuse(`/${option} is not an option msiexec takes`);
    }

    const kinds = asked.map(entry=>entry.kind);
    /** @param {string} kind */
    const targetOf = kind=>asked.find(entry=>entry.kind === kind)?.target ?? '';
    if (kinds.length === 2 && kinds.includes('uninstall') && kinds.includes('package'))
    {
        // /uninstall with /package names patches to take off a product.
        Object.assign(plan, { action: 'removePatches', target: targetOf('uninstall'),
            product: targetOf('package') });
    }
    else if (kinds.length === 2 && kinds.includes('patch') && kinds.includes('admin'))
    {
        Object.assign(plan, { action: 'patch', target: targetOf('patch'),
            image: targetOf('admin') });
    }
    else if (kinds.length === 1)
    {
        const kind = kinds[0];
        Object.assign(plan, {
            action: kind === 'package' ? 'install' : kind === 'update' ? 'patch' : kind,
            target: asked[0].target,
        });
    }
    else
    {
        return refuse(kinds.length === 0 ? 'nothing to do was asked for'
            : `more than one thing to do was asked for: ${kinds.join(', ')}`);
    }

    if (plan.transforms !== null && plan.action !== 'advertise')
    {
        properties.push(`TRANSFORMS="${plan.transforms}"`);
    }
    if (restart !== '')
    {
        properties.push(restart);
    }
    plan.properties = properties.join(' ');
    return plan;
}

/**
 * @typedef {Object} ProgramContext
 * @property {string} commandLine  The process's own, argv[0] and all.
 * @property {(library: string, name: string, args: number[]) => Promise<number>} call
 *     An export of this process's libraries, called as the program would call it.
 * @property {(entry: number, args: number[]) => Promise<number>} callGuest
 *     A routine in the guest, run on the program's own thread.
 * @property {(text: string) => number} wide  A copy of a string in the guest, as
 *     UTF-16, held until the program ends.
 * @property {(text: string) => number} ansi  The same, in the ANSI code page.
 * @property {(address: number, length: number) => Uint8Array} read
 *     A copy of guest memory: what a call the program made wrote there.
 * @property {(size: number) => number} block
 *     Zeroed guest memory for a call to write into, held until the program ends.
 * @property {(data: Uint8Array) => number} bytes
 *     A copy of a structure in the guest, for a call to read, held the same way.
 * @property {(text: string, caption: string, type: number) => Promise<number>} message
 *     A message box, as the program shows one.
 */

const USAGE = 'Windows Installer\n\n'
    + 'msiexec /i | /package <Product.msi | ProductCode> [PROPERTY=value ...]\n'
    + 'msiexec /x | /uninstall <Product.msi | ProductCode>\n'
    + 'msiexec /f[p|o|e|d|c|a|u|m|s|v] <Product.msi | ProductCode>\n'
    + 'msiexec /a <Product.msi>    msiexec /p | /update <Patch.msp[;...]>\n'
    + 'msiexec /j<u|m> <Product.msi> [/t <Transforms>] [/g <LanguageID>]\n'
    + 'msiexec /uninstall <Patch[;...]> /package <Product.msi | ProductCode>\n\n'
    + 'Display: /quiet /passive /q[n|b|r|f][+|-|!]    '
    + 'Restart: /norestart /promptrestart /forcerestart\n'
    + 'Logging: /l[i|w|e|a|r|u|c|m|o|p|v|x|+|!|*] <LogFile>    /log <LogFile>';

/**
 * Runs msiexec over the process's command line; its answer is the exit code.
 *
 * @param {ProgramContext} context
 * @returns {Promise<number>}
 */
export async function runMsiexec(context){
    const plan = parseMsiexec(argumentsOf(context.commandLine));
    if (plan.action === 'usage')
    {
        // msiexec shows its usage in a box, unless it was told to be quiet.
        if (plan.ui === null || (plan.ui & 0xf) !== INSTALLUILEVEL.NONE)
        {
            await context.message(USAGE, 'Windows Installer', MB_ICONINFORMATION);
        }
        return ERROR_INVALID_COMMAND_LINE;
    }
    if (plan.action === 'service')
    {
        return ERROR_SUCCESS;
    }
    // Without a /q option msiexec runs with the full interface, which is not
    // msi.dll's own default.
    await context.call('MSI.dll', 'MsiSetInternalUI', [plan.ui ?? INSTALLUILEVEL.FULL, 0]);
    if (plan.log)
    {
        await context.call('MSI.dll', 'MsiEnableLogW',
            [plan.log.mode, context.wide(plan.log.path), plan.log.attributes]);
    }
    const { target } = plan;
    const code = isProductCode(target);
    /** @param {string} name @param {number[]} args */
    const msi = (name, args)=>context.call('MSI.dll', name, args);
    /** @param {string} extra  What the action stands for, ahead of what was typed. */
    const line = extra=>context.wide([extra, plan.properties].filter(Boolean).join(' '));
    switch (plan.action)
    {
        case 'install':
            return code
                ? msi('MsiConfigureProductExW', [context.wide(target), INSTALLLEVEL_DEFAULT,
                    INSTALLSTATE_DEFAULT, line('')])
                : msi('MsiInstallProductW', [context.wide(target), line('')]);
        case 'uninstall':
            return code
                ? msi('MsiConfigureProductExW', [context.wide(target), INSTALLLEVEL_DEFAULT,
                    INSTALLSTATE_ABSENT, line('')])
                : msi('MsiInstallProductW', [context.wide(target), line('REMOVE=ALL')]);
        case 'repair':
            // A repair takes no properties from the line, as documented.
            return code
                ? msi('MsiReinstallProductW', [context.wide(target), repairBits(plan.repairMode)])
                : msi('MsiInstallProductW', [context.wide(target),
                    context.wide(`REINSTALL=ALL REINSTALLMODE=${plan.repairMode}`)]);
        case 'admin':
            return msi('MsiInstallProductW', [context.wide(target), line('ACTION=ADMIN')]);
        case 'advertise':
            return msi('MsiAdvertiseProductW', [context.wide(target), plan.assign,
                plan.transforms === null ? 0 : context.wide(plan.transforms), plan.language]);
        case 'removePatches':
            return msi('MsiRemovePatchesW', [context.wide(target),
                context.wide(plan.product ?? ''), INSTALLTYPE_SINGLE_INSTANCE, line('')]);
        case 'patch':
        {
            // Each patch of a list in turn, stopping at the first that fails; a
            // restart any of them wants is the answer once all are on.
            let answer = ERROR_SUCCESS;
            for (const patch of target.split(';').map(each=>each.trim()).filter(Boolean))
            {
                const applied = await msi('MsiApplyPatchW', [context.wide(patch),
                    plan.image ? context.wide(plan.image) : 0,
                    plan.image ? INSTALLTYPE_NETWORK_IMAGE : INSTALLTYPE_DEFAULT, line('')]);
                if (applied !== ERROR_SUCCESS && applied !== ERROR_SUCCESS_REBOOT_REQUIRED)
                {
                    return applied;
                }
                answer = answer === ERROR_SUCCESS ? applied : answer;
            }
            return answer;
        }
        default:
            return ERROR_INVALID_COMMAND_LINE;
    }
}
