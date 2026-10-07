/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An installer session: a package opened to be installed, and everything the
 * installer works out about it before a file is touched -- its properties,
 * where each directory goes, which features and components are to be
 * installed and where each file lands.
 *
 * Properties start from three places, later ones winning: what the
 * installer knows about the machine (the Windows version, the shell's
 * folders, the user), the package's Property table, and the command line.
 * Directories resolve from TARGETDIR down, each one its parent and its own
 * default name, unless a property of its own name already says where it is
 * -- which is how ProgramFilesFolder and the other system folders arrive,
 * and how a setup's chosen INSTALLDIR wins over the default. A feature is
 * installed when its level is at most INSTALLLEVEL and not zero, a component
 * when a feature that installs it is and its condition holds.
 */

import { MSICONDITION, evaluateCondition } from './condition.js';
import { formatRecord } from './format.js';
import { shellFolders } from '../advapi32/registry.js';
import { readSummary, PID } from './summary.js';
import { createRecord } from './record.js';
import { installerVersion } from './version.js';
import { MSITYPE } from './database.js';

/** INSTALLSTATE values. */
export const INSTALLSTATE = Object.freeze({
    NOTUSED: -7, BADCONFIG: -6, INCOMPLETE: -5, SOURCEABSENT: -4, MOREDATA: -3,
    INVALIDARG: -2, UNKNOWN: -1, BROKEN: 0, ADVERTISED: 1, ABSENT: 2, LOCAL: 3, SOURCE: 4,
    DEFAULT: 5,
});

/** Component attributes that change where it goes. */
const COMPONENT_SOURCE_ONLY = 0x1;
const COMPONENT_OPTIONAL = 0x2;

/** Feature attributes. */
const FEATURE_FAVOR_SOURCE = 0x1;
const FEATURE_FOLLOW_PARENT = 0x2;
const FEATURE_UI_DISALLOW_ABSENT = 0x10;

/**
 * @typedef {Object} Folder
 * @property {string} key
 * @property {string | null} parent
 * @property {string} targetDefault  The long target name; '' for the parent itself.
 * @property {string} sourceShort
 * @property {string} sourceLong
 * @property {string | null} target   Resolved, with a trailing backslash.
 * @property {string | null} source
 */

/**
 * @typedef {Object} Feature
 * @property {string} key
 * @property {string | null} parent
 * @property {string} title
 * @property {number} level
 * @property {number} attributes
 * @property {number} display
 * @property {string | null} directory
 * @property {number} installed
 * @property {number} request   What was asked for it.
 * @property {number} action
 * @property {string[]} components
 */

/**
 * @typedef {Object} Component
 * @property {string} key
 * @property {string | null} id
 * @property {string} directory
 * @property {number} attributes
 * @property {string | null} condition
 * @property {string | null} keyPath
 * @property {boolean} enabled
 * @property {number} installed
 * @property {number} action
 * @property {string[]} features
 */

/**
 * @typedef {Object} PackageFile
 * @property {string} key
 * @property {string} component
 * @property {string} name     The long name.
 * @property {string} shortName
 * @property {number} size
 * @property {string | null} version
 * @property {number} attributes
 * @property {number} sequence
 * @property {string | null} target  Full path, once costed.
 */

/**
 * The machine the installer describes in its properties.
 *
 * @typedef {Object} Machine
 * @property {import('../kernel32/versions.js').WindowsVersion} windows
 * @property {string} computerName
 * @property {string} userName
 * @property {string} userSid
 * @property {number} language
 * @property {number} screenWidth
 * @property {number} screenHeight
 * @property {number} colorBits
 * @property {number} memoryMegabytes
 * @property {string} tempFolder   With a trailing backslash.
 * @property {(name: string) => string | null} environment
 * @property {() => Date} now
 */

/** @param {string} path */
const slashed = path=>(path.endsWith('\\') ? path : `${path}\\`);

/**
 * The properties the installer sets about the machine before the package's.
 *
 * @param {Machine} machine
 * @returns {Map<string, string>}
 */
export function machineProperties(machine){
    const { windows } = machine;
    const folders = shellFolders(windows);
    const version = installerVersion(windows);
    const now = machine.now();
    /** @param {number} value */
    const two = value=>String(value).padStart(2, '0');
    const windowsFolder = slashed(folders.Windows);
    /** @type {[string, string | number][]} */
    const entries = [
        ['VersionNT', windows.major * 100 + windows.minor],
        ['WindowsBuild', windows.build],
        ['ServicePackLevel', windows.servicePackMajor],
        ['ServicePackLevelMinor', windows.servicePackMinor],
        ['MsiNTProductType', windows.productType],
        ['Intel', 6],
        ['VersionMsi', `${version[0]}.${two(version[1])}`],
        ['WindowsFolder', windowsFolder],
        ['WindowsVolume', windowsFolder.slice(0, 3)],
        ['SystemFolder', slashed(folders.System)],
        ['System16Folder', `${windowsFolder}system\\`],
        ['TempFolder', slashed(machine.tempFolder)],
        ['ProgramFilesFolder', slashed(folders.ProgramFiles)],
        ['CommonFilesFolder', slashed(folders.CommonFiles)],
        ['FontsFolder', slashed(folders.Fonts)],
        ['AppDataFolder', slashed(folders.AppData)],
        ['LocalAppDataFolder', slashed(folders['Local AppData'])],
        ['CommonAppDataFolder', slashed(folders['Common AppData'])],
        ['PersonalFolder', slashed(folders.Personal)],
        ['DesktopFolder', slashed(folders['Common Desktop'])],
        ['ProgramMenuFolder', slashed(folders['Common Programs'])],
        ['StartMenuFolder', slashed(folders['Common Start Menu'])],
        ['StartupFolder', slashed(folders['Common Startup'])],
        ['SendToFolder', `${slashed(folders.Profile)}SendTo\\`],
        ['FavoritesFolder', `${slashed(folders.Profile)}Favorites\\`],
        ['TemplateFolder', `${slashed(folders.Profile)}Templates\\`],
        ['NetHoodFolder', `${slashed(folders.Profile)}NetHood\\`],
        ['PrintHoodFolder', `${slashed(folders.Profile)}PrintHood\\`],
        ['RecentFolder', `${slashed(folders.Profile)}Recent\\`],
        ['MyPicturesFolder', `${slashed(folders.Personal)}My Pictures\\`],
        ['AdminToolsFolder', `${slashed(folders['Common Programs'])}Administrative Tools\\`],
        ['ROOTDRIVE', windowsFolder.slice(0, 3)],
        ['Privileged', 1],
        ['AdminUser', 1],
        ['LogonUser', machine.userName],
        ['UserSID', machine.userSid],
        ['ComputerName', machine.computerName],
        ['UserLanguageID', machine.language],
        ['SystemLanguageID', machine.language],
        ['ScreenX', machine.screenWidth],
        ['ScreenY', machine.screenHeight],
        ['ColorBits', machine.colorBits],
        ['PhysicalMemory', machine.memoryMegabytes],
        ['VirtualMemory', machine.memoryMegabytes * 2],
        ['TTCSupport', 1],
        ['ShellAdvtSupport', 1],
        ['OLEAdvtSupport', 1],
        ['Time', `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`],
        ['Date', `${two(now.getMonth() + 1)}/${two(now.getDate())}/${now.getFullYear()}`],
        ['ALLUSERS', ''],
        ['INSTALLLEVEL', 1],
    ];
    return new Map(entries.filter(([, value])=>value !== '')
        .map(([name, value])=>[name, String(value)]));
}

/**
 * Splits `target:source` and each half's `short|long`, `.` meaning the
 * parent itself.
 *
 * @param {string} defaultDir
 */
export function splitDefaultDir(defaultDir){
    const [target, source = null] = defaultDir.split(/:(.*)/s, 2);
    /** @param {string} half */
    const names = half=>{
        const [short, long = short] = half.split(/\|(.*)/s, 2);
        const fix = (/** @type {string} */ name)=>(name === '.' ? '' : name);
        return { short: fix(short), long: fix(long) };
    };
    const targetNames = names(target);
    const sourceNames = source === null ? targetNames : names(source);
    return { target: targetNames.long, sourceShort: sourceNames.short,
        sourceLong: sourceNames.long };
}

/**
 * A command line's properties: NAME=value pairs, a value in double quotes
 * keeping its spaces and "" standing for one quote.
 *
 * @param {string} text @returns {Map<string, string>}
 */
export function parseCommandLine(text){
    /** @type {Map<string, string>} */
    const properties = new Map();
    let at = 0;
    while (at < text.length)
    {
        while (at < text.length && text[at] === ' ')
        {
            at++;
        }
        const equals = text.indexOf('=', at);
        if (equals < 0)
        {
            break;
        }
        const name = text.slice(at, equals).trim();
        at = equals + 1;
        let value = '';
        let quoted = false;
        while (at < text.length && (quoted || text[at] !== ' '))
        {
            if (text[at] === '"')
            {
                if (quoted && text[at + 1] === '"')
                {
                    value += '"';
                    at += 2;
                    continue;
                }
                quoted = !quoted;
                at++;
                continue;
            }
            value += text[at++];
        }
        if (name !== '')
        {
            properties.set(name, value);
        }
    }
    return properties;
}

/**
 * @typedef {Object} SessionOptions
 * @property {import('./database.js').Database} db
 * @property {string} packagePath   The package's full path.
 * @property {Machine} machine
 * @property {string} [commandLine]
 * @property {(productCode: string) => boolean} [isInstalled]
 */

/**
 * @param {SessionOptions} options
 */
export function createSession({ db, packagePath, machine, commandLine = '', isInstalled }){
    /** @type {Map<string, string>} */
    const properties = machineProperties(machine);
    const summary = readSummary(db.summaryStream());

    /** @param {string} table @returns {import('./database.js').Row[]} */
    const rowsOf = table=>db.table(table)?.rows ?? [];
    /** @param {string} table @param {string} column */
    const columnOf = (table, column)=>
        db.table(table)?.columns.findIndex(entry=>entry.name === column) ?? -1;

    for (const row of rowsOf('Property'))
    {
        if (row[0] !== null && row[1] !== null)
        {
            properties.set(String(row[0]), String(row[1]));
        }
    }
    const sourceDir = packagePath.slice(0, packagePath.lastIndexOf('\\') + 1);
    properties.set('OriginalDatabase', packagePath);
    properties.set('DATABASE', packagePath);
    properties.set('SourceDir', sourceDir);
    properties.set('SOURCEDIR', sourceDir);
    const packageCode = summary.get(PID.REVNUMBER)?.value;
    if (typeof packageCode === 'string')
    {
        properties.set('PackageCode', packageCode.slice(0, 38));
    }
    const schema = summary.get(PID.PAGECOUNT)?.value;
    if (typeof schema === 'number')
    {
        properties.set('VersionDatabase', String(schema));
    }
    const productCode = properties.get('ProductCode') ?? '';
    if (productCode && isInstalled?.(productCode))
    {
        properties.set('Installed', '1');
        properties.set('ProductState', String(INSTALLSTATE.DEFAULT));
    }
    else
    {
        properties.set('ProductState', String(INSTALLSTATE.UNKNOWN));
    }
    for (const [name, value] of parseCommandLine(commandLine))
    {
        properties.set(name, value);
    }

    /** @param {string} name */
    const getProperty = name=>properties.get(name) ?? '';
    /** @param {string} name @param {string | null} value */
    const setProperty = (name, value)=>{
        if (value === null || value === '')
        {
            properties.delete(name);
        }
        else
        {
            properties.set(name, value);
        }
    };

    /** @type {Map<string, Folder>} */
    const folders = new Map();
    for (const row of rowsOf('Directory'))
    {
        const key = String(row[0]);
        const split = splitDefaultDir(String(row[2] ?? ''));
        folders.set(key, {
            key, parent: row[1] === null || row[1] === key ? null : String(row[1]),
            targetDefault: split.target, sourceShort: split.sourceShort,
            sourceLong: split.sourceLong, target: null, source: null,
        });
    }

    /** @type {Map<string, Feature>} */
    const features = new Map();
    for (const row of rowsOf('Feature'))
    {
        features.set(String(row[0]), {
            key: String(row[0]), parent: row[1] === null ? null : String(row[1]),
            title: String(row[2] ?? ''), display: Number(row[4] ?? 0),
            level: Number(row[5] ?? 0), directory: row[6] === null ? null : String(row[6]),
            attributes: Number(row[7] ?? 0), installed: INSTALLSTATE.ABSENT,
            request: INSTALLSTATE.UNKNOWN, action: INSTALLSTATE.UNKNOWN, components: [],
        });
    }
    /** @type {Map<string, Component>} */
    const components = new Map();
    for (const row of rowsOf('Component'))
    {
        components.set(String(row[0]), {
            key: String(row[0]), id: row[1] === null ? null : String(row[1]),
            directory: String(row[2] ?? ''), attributes: Number(row[3] ?? 0),
            condition: row[4] === null ? null : String(row[4]),
            keyPath: row[5] === null ? null : String(row[5]),
            enabled: true, installed: INSTALLSTATE.ABSENT, action: INSTALLSTATE.UNKNOWN,
            features: [],
        });
    }
    for (const row of rowsOf('FeatureComponents'))
    {
        const feature = features.get(String(row[0]));
        const component = components.get(String(row[1]));
        if (feature && component)
        {
            feature.components.push(component.key);
            component.features.push(feature.key);
        }
    }
    /** @type {Map<string, PackageFile>} */
    const files = new Map();
    for (const row of rowsOf('File'))
    {
        const [shortName, longName = shortName] = String(row[2] ?? '').split('|');
        files.set(String(row[0]), {
            key: String(row[0]), component: String(row[1]), name: longName, shortName,
            size: Number(row[3] ?? 0), version: row[4] === null ? null : String(row[4]),
            attributes: Number(row[6] ?? 0), sequence: Number(row[7] ?? 0), target: null,
        });
    }

    /**
     * Resolves every directory's target, each from its parent, a property of
     * its own name winning; and sets that property, as CostFinalize does.
     */
    const resolveTargets = ()=>{
        for (const folder of folders.values())
        {
            folder.target = null;
        }
        /** @type {Set<string>} */
        const resolving = new Set();
        /** @param {string} key @returns {string} */
        const resolve = key=>{
            const folder = folders.get(key);
            if (!folder)
            {
                return slashed(getProperty('ROOTDRIVE') || 'C:\\');
            }
            if (folder.target !== null)
            {
                return folder.target;
            }
            if (resolving.has(key))
            {
                return slashed(getProperty('ROOTDRIVE') || 'C:\\');
            }
            resolving.add(key);
            let path = getProperty(key);
            if (path === '')
            {
                if (key === 'TARGETDIR' || folder.parent === null)
                {
                    path = key === 'TARGETDIR' ? getProperty('ROOTDRIVE') || 'C:\\'
                        : folder.targetDefault;
                }
                else
                {
                    path = resolve(folder.parent) + folder.targetDefault;
                }
            }
            folder.target = normalize(path);
            setProperty(key, folder.target);
            return folder.target;
        };
        for (const key of folders.keys())
        {
            resolve(key);
        }
        placeFiles();
    };

    /** Each file's target, from its component's directory. */
    const placeFiles = ()=>{
        for (const file of files.values())
        {
            const component = components.get(file.component);
            const directory = component ? folders.get(component.directory)?.target : null;
            file.target = directory ? `${directory}${file.name}` : null;
        }
    };

    /**
     * MsiSetTargetPath: the directory moves, and every directory under it
     * follows from its parent whatever its own property says; the rest stay.
     * Before costing there is nothing resolved to move, and the property is
     * what costing will read.
     *
     * @param {string} key @param {string} path @returns {boolean} whether it is a directory
     */
    const setTargetPath = (key, path)=>{
        const folder = folders.get(key);
        if (!folder || folder.target === null)
        {
            setProperty(key, path);
            return Boolean(folder);
        }
        folder.target = normalize(path);
        setProperty(key, folder.target);
        /** @param {string} parent */
        const follow = parent=>{
            for (const child of folders.values())
            {
                if (child.parent === parent && child.key !== parent)
                {
                    child.target = normalize(`${folders.get(parent)?.target ?? ''}`
                        + `${child.targetDefault}`);
                    setProperty(child.key, child.target);
                    follow(child.key);
                }
            }
        };
        follow(key);
        placeFiles();
        return true;
    };

    /**
     * A directory's source: the package's own directory, then the source
     * names down the tree. A compressed package's files are not under it at
     * all, but an uncompressed one's are.
     *
     * @param {string} key @returns {string}
     */
    const sourcePath = key=>{
        const folder = folders.get(key);
        if (!folder)
        {
            return sourceDir;
        }
        if (folder.source !== null)
        {
            return folder.source;
        }
        const base = folder.parent === null ? getProperty('SourceDir') || sourceDir
            : sourcePath(folder.parent);
        const shortNames = (Number(summary.get(PID.WORDCOUNT)?.value ?? 0) & 1) !== 0;
        const name = folder.parent === null ? '' : shortNames ? folder.sourceShort
            : folder.sourceLong;
        folder.source = normalize(base + name);
        return folder.source;
    };

    /** Feature and component states, as CostFinalize settles them. */
    const settleStates = ()=>{
        const level = Number(getProperty('INSTALLLEVEL')) || 1;
        for (const row of rowsOf('Condition'))
        {
            const feature = features.get(String(row[0]));
            if (feature && row[2] !== null && evaluate(String(row[2])) === MSICONDITION.TRUE)
            {
                feature.level = Number(row[1] ?? 0);
            }
        }
        /** @param {string} name */
        const listed = name=>{
            const value = getProperty(name);
            return value === '' ? null : value === 'ALL' ? 'ALL'
                : new Set(value.split(',').map(entry=>entry.trim()));
        };
        const addLocal = listed('ADDLOCAL');
        const addSource = listed('ADDSOURCE');
        const remove = listed('REMOVE');
        const anyRequest = addLocal || addSource || remove || listed('ADDDEFAULT')
            || listed('REINSTALL');
        /** @param {Set<string> | 'ALL' | null} list @param {string} key */
        const names = (list, key)=>list === 'ALL' || (list?.has(key) ?? false);
        const installed = getProperty('Installed') !== '';
        for (const feature of features.values())
        {
            if (feature.request !== INSTALLSTATE.UNKNOWN)
            {
                feature.action = feature.request;
                continue;
            }
            if (names(remove, feature.key))
            {
                feature.action = INSTALLSTATE.ABSENT;
            }
            else if (names(addLocal, feature.key))
            {
                feature.action = INSTALLSTATE.LOCAL;
            }
            else if (names(addSource, feature.key))
            {
                feature.action = INSTALLSTATE.SOURCE;
            }
            else if (anyRequest || installed)
            {
                feature.action = INSTALLSTATE.UNKNOWN;
            }
            else if (feature.level > 0 && feature.level <= level)
            {
                feature.action = (feature.attributes & FEATURE_FAVOR_SOURCE) !== 0
                    ? INSTALLSTATE.SOURCE : INSTALLSTATE.LOCAL;
            }
            else
            {
                feature.action = INSTALLSTATE.UNKNOWN;
            }
        }
        // A child follows a parent that is not installed; one that follows
        // its parent takes its parent's state.
        for (const feature of features.values())
        {
            const parent = feature.parent ? features.get(feature.parent) : null;
            if (!parent)
            {
                continue;
            }
            const parentState = parent.action === INSTALLSTATE.UNKNOWN ? parent.installed
                : parent.action;
            if (parentState === INSTALLSTATE.ABSENT && feature.action !== INSTALLSTATE.UNKNOWN
                && (feature.attributes & FEATURE_UI_DISALLOW_ABSENT) === 0)
            {
                feature.action = INSTALLSTATE.UNKNOWN;
            }
            if ((feature.attributes & FEATURE_FOLLOW_PARENT) !== 0
                && parent.action !== INSTALLSTATE.UNKNOWN)
            {
                feature.action = parent.action;
            }
        }
        for (const component of components.values())
        {
            component.enabled = component.condition === null
                || evaluate(component.condition) !== MSICONDITION.FALSE;
            if (!component.enabled)
            {
                component.action = INSTALLSTATE.UNKNOWN;
                continue;
            }
            const states = component.features.map(key=>features.get(key)?.action
                ?? INSTALLSTATE.UNKNOWN);
            if (states.includes(INSTALLSTATE.LOCAL) || states.includes(INSTALLSTATE.SOURCE))
            {
                component.action = (component.attributes & COMPONENT_SOURCE_ONLY) !== 0
                    || (states.includes(INSTALLSTATE.SOURCE) && !states.includes(INSTALLSTATE.LOCAL)
                        && (component.attributes & COMPONENT_OPTIONAL) !== 0)
                    ? INSTALLSTATE.SOURCE : INSTALLSTATE.LOCAL;
            }
            else if (states.includes(INSTALLSTATE.ABSENT)
                && component.installed !== INSTALLSTATE.ABSENT)
            {
                component.action = INSTALLSTATE.ABSENT;
            }
            else
            {
                component.action = INSTALLSTATE.UNKNOWN;
            }
        }
    };

    /** @type {import('./condition.js').ConditionEnvironment} */
    const conditionEnvironment = {
        property: getProperty,
        environment: machine.environment,
        component: key=>{
            const component = components.get(key);
            return component ? { installed: component.installed, action: component.action } : null;
        },
        feature: key=>{
            const feature = features.get(key);
            return feature ? { installed: feature.installed, action: feature.action } : null;
        },
    };
    /** @param {string} text */
    const evaluate = text=>evaluateCondition(text, conditionEnvironment);

    /** @type {import('./format.js').FormatEnvironment} */
    const formatEnvironment = {
        property: getProperty,
        environment: machine.environment,
        file: (key, short)=>{
            const file = files.get(key);
            if (!file || file.target === null)
            {
                return null;
            }
            return short ? file.target.replace(/[^\\]+$/, file.shortName) : file.target;
        },
        component: key=>{
            const component = components.get(key);
            return component ? folders.get(component.directory)?.target ?? null : null;
        },
    };

    /**
     * @param {import('./record.js').Record} record @param {boolean} [deferred]
     */
    const format = (record, deferred = false)=>formatRecord({
        count: record.fields.length - 1,
        field: index=>{
            const value = record.fields[index] ?? null;
            return value !== null && typeof value === 'object' ? null : value;
        },
    }, deferred ? { ...formatEnvironment, deferred: true } : formatEnvironment);

    /** @param {string} text */
    const formatText = text=>{
        const record = createRecord(0);
        record.fields[0] = text;
        return format(record);
    };

    /**
     * The session's database as MsiGetActiveDatabase hands it out: the
     * package's tables and, as Windows keeps them, the session's properties
     * as the temporary table _Property, one row a property that has a value.
     * A script reads it to carry what the user chose into the installation it
     * starts in a session of its own.
     */
    const active = /** @type {typeof db} */ (Object.assign(Object.create(db), {
        /** @param {string} name */
        table: name=>(name === '_Property' ? {
            name,
            columns: [
                { table: name, number: 1, name: 'Property',
                    type: MSITYPE.VALID | MSITYPE.STRING | MSITYPE.KEY | MSITYPE.TEMPORARY | 72 },
                { table: name, number: 2, name: 'Value',
                    type: MSITYPE.VALID | MSITYPE.STRING | MSITYPE.TEMPORARY },
            ],
            rows: [...properties].filter(([, value])=>value !== '')
                .map(([property, value])=>[property, value]),
            temporary: true, temporaryRows: new Set(), hold: 0,
        } : db.table(name)),
    }));

    return {
        db, active, summary, properties, folders, features, components, files,
        getProperty, setProperty, evaluate, format, formatText,
        resolveTargets, setTargetPath, sourcePath, settleStates,
        packagePath, sourceDir, machine,
        /** Set when a sequence is running; MsiGetMode answers from these. */
        mode: { scheduled: false, rollback: false, commit: false, admin: false,
            advertise: false, maintenance: getProperty('Installed') !== '', rollbackEnabled: true,
            logEnabled: false, operations: false, rebootAtEnd: false, rebootNow: false,
            cabinet: false, sourceShortNames: false, targetShortNames: false, windows9x: false,
            zawEnabled: false },
        /** @type {{ name: string, run: () => Promise<number> }[]} */
        script: [],
        columnOf,
    };
}

/** @typedef {ReturnType<typeof createSession>} Session */

/**
 * A path with single separators and a trailing one, `.` and `..` resolved.
 *
 * @param {string} path
 */
export function normalize(path){
    const parts = [];
    for (const part of path.replace(/\//g, '\\').split('\\'))
    {
        if (part === '' || part === '.')
        {
            continue;
        }
        if (part === '..' && parts.length > 1)
        {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    const unc = path.startsWith('\\\\');
    return `${unc ? '\\\\' : ''}${parts.join('\\')}\\`;
}
