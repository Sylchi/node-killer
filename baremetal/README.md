# qnode Bare-Metal Kernel for Raspberry Pi 4

A bare-metal JavaScript runtime for Pi 4B with 7" touchscreen, running without Linux.

## Overview

This is a freestanding ARM64 kernel that boots directly on Raspberry Pi 4 hardware,
providing a Node.js-compatible environment with Web Platform APIs — no Linux kernel
required.

The project leverages the existing qnode codebase:
- **QuickJS** engine (JavaScript runtime)
- **netstack** (in-process TCP/IP stack, OS-independent)
- **libev** (event loop)
- **mbedtls/libsodium** (TLS/crypto)

## Current Status: Phase 2 ✅

Phase 1 implements the minimal boot environment:

| Component | Status | Description |
|-----------|--------|-------------|
| `start.S` | ✅ Done | ARM64 entry, exception vectors, BSS clear |
| `linker.ld` | ✅ Done | Memory layout, 0x80000 load address |
| `bcm2711.h` | ✅ Done | Hardware register definitions |
| `uart.c/h` | ✅ Done | PL011 UART driver (115200 8N1) |
| `timer.c/h` | ✅ Done | System timer (1 MHz microsecond counter) |
| `main.c` | ✅ Done | Boot message + display test pattern |
| `mailbox.c/h` | ✅ Done | VideoCore mailbox interface |
| `framebuffer.c/h` | ✅ Done | Framebuffer driver (800x480 @ 32bpp) |
| `config.txt` | ✅ Done | Pi 4 boot configuration |
| `Makefile` | ✅ Done | Cross-compilation build system |

## Building

Requires `aarch64-none-elf-gcc` cross-compiler.

```bash
cd baremetal
make
```

Output: `kernel8.img`

## Booting on Pi 4

Create a FAT32 boot partition on SD card with these files:

1. **From Raspberry Pi firmware** (get from [rpi-firmware](https://github.com/raspberrypi/firmware)):
   - `bootcode.bin`
   - `start.elf` (or `start4.elf` for Pi 4)
   - `fixup.dat` (or `fixup4.dat`)

2. **Config file** — `config.txt`:
   ```
   arm_64bit=1
   enable_uart=1
   kernel=kernel8.img
   
   # Disable BT UART to free up PL011
   dtoverlay=disable-bt
   ```

3. **Our kernel**:
   - `kernel8.img` (built from this project)

Insert SD card, power on Pi 4. Connect USB serial to GPIO 14/15 (TX/RX) at 115200 baud.

## Expected Output

### Phase 1 Output (UART):
```
========================================
qnode bare-metal kernel for Pi 4
========================================

Phase 1: UART initialized
Timer frequency: 1 MHz

Testing timer... delayed for ~1000000 us (expected ~1000000)

Phase 1 complete. Entering main loop...
Type characters to see them echoed back (Ctrl+C to halt)
```

### Phase 2 Output (Display):
```
========================================
qnode bare-metal kernel for Pi 4
Phase 2: Display Support
========================================

Initializing framebuffer...
Requesting 800x480 @ 32bpp
SUCCESS: Framebuffer initialized
Base address: 0x...
Size: 1536000 bytes
Pitch: 3200 bytes/row
Drawing test pattern...
Test pattern drawn!
You should see colored rectangles on the display.

Phase 2 complete. System running.
UART echo active. Type characters to see them echoed.
```

The display should show a test pattern with colored rectangles on a dark blue background.

## Roadmap

### Phase 1 — Boot Infrastructure ✅
- ARM64 boot code (start.S)
- PL011 UART driver
- System timer
- Heap allocator
- Cross-compilation setup

### Phase 2 — Display ✅
- VideoCore mailbox driver
- Framebuffer (800x480 RGB)
- Test pattern rendering

### Phase 3 — Touch Input
- FT5406 touch controller driver
- Touch event handling
- Input abstraction layer

### Phase 4 — JS Runtime
- libev virtual fd polling backend
- QuickJS integration with UART console
- setTimeout/setInterval support
- Web API polyfills

### Phase 5 — Storage + Network
- SD card driver (SDHOST or mailbox)
- FAT32 reader (read-only, or Petit FATFS)
- Ethernet (GENET MAC) → plug into netstack
- WiFi (optional, via SDIO)

## Memory Map

```
0x00000000 - 0x0007FFFF : Reserved (GPU)
0x00080000 - ???         : Kernel image (loaded by firmware)
??? - 0x00080000         : Stack (64KB, grows down)
0xFE000000 - 0xFFFFFFFF : BCM2711 peripherals
0xFF800000 - 0xFF8FFFFF : ARM local peripherals (GIC, timers)
```

## License

Same as qnode (MIT).
