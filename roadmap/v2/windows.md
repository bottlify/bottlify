# One window state for the run

Русская версия: [windows.ru.md](windows.ru.md).

**Status:** plan, no code. 2026-10-05, against `cork2` 1ad2506c. Part of v2 stage 2; it comes
before the translation pools. File references are to `modules/core/src/` unless said otherwise.

## Why

A window exists today only inside the process that made it. The run knows its handle, its owner,
its class and its title (`layers/win32/user32/directory.js`), and nothing else: no rectangle, no
visibility, no place among the other processes' windows, no foreground window. Everything that
involves two processes' windows is therefore decided by a rule that ignores them:

- **The screen.** Each process paints its own full-screen desktop (`layers/graphics/module.js`,
  `desktopSurface`), and its frames carry no source. The presenter shows whichever frame came last
  (`webgpu/internal/presenter.js`, `show`), and the canvas takes that frame's size. Two processes
  that both draw overwrite each other's whole picture. The graphics worker keeps one `newest` slot
  for every client's Direct3D frames (`layers/graphics/remote/worker.js`), so one device's frame
  replaces another's. When a child exits, its parent repaints everything (`app.js`,
  `refreshWindows`) to get its picture back.
- **Input.** It goes to the process that started last (`app.js`, `facade.input`, `forwarding`,
  `across().at(-1)`), not to the window under the cursor or the active one.
- **Activation.** Each process has its own active window (`user32/windows.js`, `activeWindow`)
  and believes no other program has one (WM_ACTIVATEAPP). `GetForegroundWindow`, `WindowFromPoint`
  and `EnumWindows` answer for one process.
- **Z-order.** It is the insertion order of one process's `Map` of windows. `HWND_TOPMOST` raises
  and nothing keeps a topmost band. `HWND_BOTTOM` does not move a top-level window.

On Windows this state is win32k's, one per session; a process changes it by calling, and every
process sees the same answer. That is the model here.

## Target

### The window station

The system half of user32 keeps, beside the directory, one record per top-level window of the run:

| Field | Meaning |
| --- | --- |
| `hwnd`, `processId`, `threadId` | whose it is |
| `rect`, `client` | window and client rectangles, screen coordinates |
| `visible`, `minimized`, `maximized` | WS_VISIBLE, WS_MINIMIZE, WS_MAXIMIZE as the window has them |
| `topmost` | WS_EX_TOPMOST: the band it is ordered in |
| `owner` | an owned window stays above its owner |
| `region` | a window region's bounding box, or none |

And for the run: one z-order of top-level windows (the topmost band above the rest; an owned window
above its owner), one foreground window, and the window that has captured the mouse.

A process keeps everything else of its windows: class, procedure, children, painting. Its top-level
placement it writes through to the station at the few places where it changes:

- `makeWindow`, `forget`;
- `place` (SetWindowPos, MoveWindow, BringWindowToTop, DeferWindowPos), `showNow` (ShowWindow);
- `raise`, `activateNow`.

The changes that today mutate a record directly and repaint nothing go through `place` first:
`SetWindowPlacement`, `SetWindowLong(GWL_STYLE/GWL_EXSTYLE)` flipping WS_VISIBLE, and
`windowService.place`. That is a fix on its own: the window did not repaint either.

A write is a link call that does not block; the process does not wait for the station. What the
station answers that the process asks (foreground, z-order across processes, the window at a
point) is a blocking ask, as the directory's are now.

### Activation across processes

`SetForegroundWindow`, a click, a `ShowWindow` that activates: the station moves the foreground.
The process losing it gets WM_ACTIVATE (WA_INACTIVE) and WM_ACTIVATEAPP (FALSE, with the other
thread's id), and the process gaining it gets them with TRUE, through the directory's endpoint as a
sent message is delivered today. `GetForegroundWindow` answers the run's foreground window, and
`GetActiveWindow` the thread's own, which is the foreground only when it is that thread's.
DirectDraw's lost exclusive mode reads the station's foreground.

### The screen

Every frame says whose it is. A process's display port is already one per process (`app.js`,
`display`), and the graphics worker's client port too; the graphics worker keeps one `newest` slot
per client instead of one for all.

The presenter keeps the newest frame of each source as a layer (a texture) and composes the screen
from the station: bottom to top, each visible top-level window is drawn from its process's layer,
scissored to its rectangle minus everything above it, and what no window covers is the desktop
background. The canvas is the screen's size. A layer is uploaded only when its process sends a new
frame. A frame of a size other than the screen's (a DirectDraw primary in exclusive mode, a
Direct3D back buffer) is its window's whole rectangle, as it is today for one process.

The same holds with `concurrency` 1: the processes beside each other on the engine thread present
to the run's presenter through attachments of their own (`presenter.attach`), each a source.
`refreshWindows` on a child's exit goes.

### Input

The page's mouse goes to the process whose window is under the cursor (the station's z-order and
rectangles), or the one that captured it; the keyboard goes to the foreground window's process.
`facade.input` stops being "the newest process".

## Steps

Each step lands with its tests, the full suite run before it goes to `cork2`.

1. **The station, written through.** The record table, the z-order with its topmost band and
   owners, foreground and capture, at the system; the write-through from the choke points above,
   with the direct mutations moved to `place`; a diagnostics table of it. Tests: the station's own
   unit tests (order, bands, owners, foreground); a gate that runs seeded sequences of window calls
   in a process and checks after each that the station's records equal what the process holds
   (rectangle, visibility, order of its own windows); the window-across itest at every concurrency.
2. **Activation and the questions across processes.** Foreground moves through the station, with
   the activation messages delivered to both processes; `GetForegroundWindow`, `WindowFromPoint`,
   `EnumWindows`, `GetWindow(GW_HWNDNEXT)` answer for the run. Tests: a fixture of two processes
   that activate each other's windows and check the messages, at concurrency 1, 2 and 4.
3. **Layers and composition.** Sources on frames, a slot per client in the graphics worker, the
   presenter's layers and the composition by the station, the canvas at the screen's size. Gate: a
   CPU reference composer and the GPU composition, given seeded random layouts of two and three
   processes' windows over random layers, give the same pixels. An itest of two processes whose
   windows overlap, the screen read back and compared with the reference.
4. **Input.** Mouse by the window under the cursor or capture, keyboard by the foreground. Tests:
   input routed to the right process in the two-process fixture.
5. **What it replaces goes.** `refreshWindows` on exit, last-frame-wins, the newest-process input
   rule, the per-process "no other program is active" answers. `docs/core/limits.md` and
   `docs/architecture.md` updated.

## Done when

The steps' tests pass at concurrency 1, 2 and 4, and in a browser a launcher and the game it starts,
and an installer with its child processes, show every process's windows at once in their order,
with no picture of one process replacing another's. The browser check is the person's: it is not
measured here.
