/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The walks the dialog manager makes over a dialog's controls: from one tab
 * stop to the next, and within a group. Both search through a shown, enabled
 * child with WS_EX_CONTROLPARENT as if its controls were the dialog's own,
 * as a property sheet's page is inside the sheet.
 *
 * Kept apart from the dialog functions and the dialog class's procedure
 * because both walk: GetNextDlgTabItem, GetNextDlgGroupItem and the Tab key
 * on one side, DefDlgProc's WM_NEXTDLGCTL on the other.
 */

const WS_VISIBLE = 0x10000000;
const WS_DISABLED = 0x08000000;
const WS_GROUP = 0x00020000;
const WS_TABSTOP = 0x00010000;
const WS_EX_CONTROLPARENT = 0x00010000;

/**
 * @param {Object} windows
 * @param {(record: any) => any[]} windows.children  A window's live children, in order.
 * @param {(hwnd: number) => any | null | undefined} windows.recordOf  A window by handle.
 */
export function createTabWalk({ children, recordOf }){
    /** @param {any} child  Whether the walks search its controls rather than it. */
    const searchedThrough = child=>(child.exStyle & WS_EX_CONTROLPARENT) !== 0
        && (child.style & (WS_VISIBLE | WS_DISABLED)) === WS_VISIBLE;

    /** @param {any} child  Whether Tab stops at it. */
    const stopsTab = child=>!searchedThrough(child)
        && (child.style & (WS_TABSTOP | WS_VISIBLE | WS_DISABLED)) === (WS_TABSTOP | WS_VISIBLE);

    /**
     * The windows inside a dialog in the order Tab meets them: each child,
     * then, for one it searches through, that child's own. The windows
     * around `from` are laid out too, so a control Tab could not have
     * reached is searched from where it stands.
     *
     * @param {any} dialog @param {number} from
     * @returns {any[]}
     */
    const tabSequence = (dialog, from)=>{
        const around = new Set();
        for (let at = recordOf(from); at && at.hwnd !== dialog.hwnd; at = recordOf(at.parent))
        {
            around.add(at.hwnd);
        }
        /** @type {any[]} */
        const sequence = [];
        /** @param {any} parent */
        const visit = parent=>{
            for (const child of children(parent))
            {
                sequence.push(child);
                if (searchedThrough(child) || around.has(child.hwnd))
                {
                    visit(child);
                }
            }
        };
        visit(dialog);
        return sequence;
    };

    /**
     * The control after -- or before -- one that stops Tab, wrapping round.
     * From nothing, or from outside the dialog, the first or the last.
     *
     * @param {any} dialog @param {number} from  A control's handle, or zero.
     * @param {boolean} forward
     * @returns {any | null}
     */
    const nextTabStop = (dialog, from, forward)=>{
        const sequence = tabSequence(dialog, from);
        const at = from === 0 ? -1 : sequence.findIndex(child=>child.hwnd === from);
        if (at === -1)
        {
            const stops = sequence.filter(stopsTab);
            return (forward ? stops[0] : stops[stops.length - 1]) ?? null;
        }
        for (let step = 1; step <= sequence.length; step++)
        {
            const child = sequence[(at + (forward ? step : sequence.length - step))
                % sequence.length];
            if (stopsTab(child))
            {
                return child;
            }
        }
        return null;
    };

    /** @param {any} child  Whether it is shown and enabled. */
    const usable = child=>(child.style & (WS_VISIBLE | WS_DISABLED)) === WS_VISIBLE;

    /**
     * The control after -- or before -- one within its group. A group runs
     * from one WS_GROUP control to the next, round the end of the dialog to
     * its start, whatever either is showing; the next shown and enabled one
     * in it, wrapping within the group, or the control itself when there is
     * none. From nothing, or from outside the dialog, the first shown and
     * enabled control going forward, and none going back.
     *
     * @param {any} dialog @param {number} from  A control's handle, or zero.
     * @param {boolean} forward
     * @returns {any | null}
     */
    const nextGroupItem = (dialog, from, forward)=>{
        // A child searched through is its controls, and no item of its own.
        const items = tabSequence(dialog, from).filter(child=>!searchedThrough(child)
            || child.hwnd === from);
        const at = from === 0 ? -1 : items.findIndex(child=>child.hwnd === from);
        if (at === -1)
        {
            return forward ? items.find(usable) ?? null : null;
        }
        const count = items.length;
        /** @param {number} index */
        const opens = index=>(items[index].style & WS_GROUP) !== 0;
        let start = at;
        for (let step = 0; step < count && !opens(start); step++)
        {
            start = (start + count - 1) % count;
        }
        /** @type {any[]} */
        const group = [items[start]];
        for (let index = (start + 1) % count; index !== start && !opens(index);
            index = (index + 1) % count)
        {
            group.push(items[index]);
        }
        const place = group.indexOf(items[at]);
        for (let step = 1; step < group.length; step++)
        {
            const child = group[(place + (forward ? step : group.length - step)) % group.length];
            if (usable(child))
            {
                return child;
            }
        }
        return items[at];
    };

    return { nextTabStop, nextGroupItem };
}
