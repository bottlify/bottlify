ENTRY(_start)
/* lua-x87's heap, past the stack bench.mjs starts at 0x800000; no other image asks for it. */
PROVIDE(__heap_start = 0x900000);
PROVIDE(__heap_end = 0xf00000);
SECTIONS {
  . = 0x401000;
  .text : { *(.text.start) *(.text*) }
  . = ALIGN(4096);
  .rodata : { *(.rodata*) }
  . = ALIGN(4096);
  .data : { *(.data*) }
  . = ALIGN(4096);
  .bss : { *(.bss*) *(COMMON) }
  /DISCARD/ : { *(.comment) *(.eh_frame*) *(.note*) }
}
