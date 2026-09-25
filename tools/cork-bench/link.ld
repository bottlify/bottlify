ENTRY(_start)
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
