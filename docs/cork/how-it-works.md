# How cork works

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "basis", "nodeSpacing": 28, "rankSpacing": 40, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart LR
  subgraph main["Main thread"]
    I["Interpreter<br/>runs new code,<br/>counts jumps"]
    R["Region<br/>a loop or a function<br/>with its small callees"]
    S[("Saved translations<br/>OPFS")]
    T["Translated code<br/>WebAssembly functions"]
  end
  subgraph worker["Translation worker"]
    W["x86 to WebAssembly"]
    C["Compile"]
  end
  I -->|"hot address"| R
  R -->|"saved before"| S
  R -->|"new"| W --> C
  C -->|"module"| T
  C -.->|"save"| S
  S --> T
  T -->|"untranslated target"| I
```

1. **Interpreter.** New code runs in the interpreter, which also counts how many times the program
   jumps to each address. An address jumped to often enough (twice in Bottlify, 50 times on cork's
   own machine) becomes a candidate for translation.
2. **Region.** From the candidate cork gathers every block reachable by ordinary jumps (up to 128
   blocks or 8 KiB of code) and builds in the small functions they call.
3. **Translation.** Regions go to the translation thread in batches of 32 or more, each batch one
   WebAssembly module. When the queue is deep, as while a game loads, a batch takes a quarter of
   what waits, up to 256.
4. **Running.** Translated regions call each other directly. They leave only when there is no
   other way:

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "basis", "nodeSpacing": 22, "rankSpacing": 50, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart LR
  R["Translated region"] -->|"jump or call to a translated address"| N["Next region,<br/>no stop between"]
  R -->|"jump to an untranslated address"| I["Interpreter"]
  R -->|"int n, out to the trap port"| H["Host<br/>(Windows, in Bottlify)"]
  R -->|"time slice used up"| P["Scheduler,<br/>another thread"]
  R -->|"write into code"| D["Translation dropped,<br/>made again"]
  R -->|"fault"| F["Host, with the exact<br/>address and registers"]
```

5. **The next run.** Translations are kept in OPFS, so the second run of the same program loads
   what the first one translated instead of translating it again. A region is kept under its entry,
   the x87 stack top it is entered at (any top when it has no x87 code) and the translator's modes,
   and a block reached first in another order is taken as the stored region that holds it.

All of the program's memory is one `WebAssembly.Memory`. In Bottlify the program's address `a` is
at offset `a` in it, and cork's own state lies in the program's first 64 KiB, which a Windows
program never maps:

```
0x00000   the program's first page: a read through a null pointer finds zeroes there
0x01000   registers and cork's own state, then the wasm interpreter's data, to 0x05000;
          a store of the program's there faults
0x05000   the program's memory from here on (1 GiB in Bottlify)
  end     cork's tables: one byte of flags for every 4 KiB page (closed, holds translated code,
          watched for writes, ...), where code lies in each page, the entry hash
  past    with several executors, each other executor's state and tables; the page flags
          stay one table for all of them
```

Memory addressed from its start is shorter machine code: on ARM a load of the program's memory
is one instruction, where an offset of 64 KiB took two more. A program that may use its first
64 KiB gets cork's own default instead: its address `a` at `0x10000 + a`, the state below it.
