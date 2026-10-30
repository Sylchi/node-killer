# Makefile for qnode bare-metal kernel (Pi 4)
#
# Builds a bare-metal ARM64 kernel that runs directly on the Pi 4
# without Linux. Output is kernel8.img for the boot partition.

CROSS ?= aarch64-none-elf-
CC = $(CROSS)gcc
AS = $(CROSS)as
LD = $(CROSS)ld
OBJCOPY = $(CROSS)objcopy

# Compiler flags for bare-metal ARM64
CFLAGS = -Wall -O2 -ffreestanding -nostdlib -nostartfiles
CFLAGS += -march=armv8-a -mtune=cortex-a72
CFLAGS += -I./include -I../include -I..

# Assembler flags
ASFLAGS = -march=armv8-a

# Linker flags
LDFLAGS = -T linker.ld -nostdlib

# Source files
ASM_SRCS = src/start.S
C_SRCS = src/uart.c src/timer.c src/mailbox.c src/framebuffer.c src/touch.c src/heap.c src/baremetal_libc.c src/main.c

# QuickJS source (from parent directory)
# Note: We only use quickjs.c (the core engine), not quickjs-libc.c which requires filesystem
QUICKJS_SRCS = ../quickjs.c ../libregexp.c ../libunicode.c ../dtoa.c
QUICKJS_OBJS = quickjs.o libregexp.o libunicode.o dtoa.o

# Object files
ASM_OBJS = $(ASM_SRCS:.S=.o)
C_OBJS = $(C_SRCS:.c=.o)
OBJS = $(ASM_OBJS) $(C_OBJS) $(QUICKJS_OBJS)

# Output files
TARGET = kernel8.elf
IMG = kernel8.img

.PHONY: all clean

all: $(IMG)

# Link object files into ELF (use CC driver to find libgcc)
$(TARGET): $(OBJS) linker.ld
	$(CC) $(CFLAGS) -T linker.ld -nostdlib -nostartfiles $(OBJS) -lgcc -o $(TARGET)

# Convert ELF to raw binary image
$(IMG): $(TARGET)
	$(OBJCOPY) -O binary $(TARGET) $(IMG)

# Compile C files
%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

# Assemble assembly files
%.o: %.S
	$(AS) $(ASFLAGS) $< -o $@

# Compile QuickJS files from parent directory
quickjs.o: ../quickjs.c src/baremetal_stubs.h
	$(CC) $(CFLAGS) -I../include -I./src -include baremetal_stubs.h -DCONFIG_BIGNUM -DCONFIG_CHECK_JSVALUE -mno-outline-atomics -c $< -o $@

libregexp.o: ../libregexp.c src/baremetal_stubs.h
	$(CC) $(CFLAGS) -I../include -I./src -include baremetal_stubs.h -mno-outline-atomics -c $< -o $@

libunicode.o: ../libunicode.c src/baremetal_stubs.h
	$(CC) $(CFLAGS) -I../include -I./src -include baremetal_stubs.h -mno-outline-atomics -c $< -o $@

dtoa.o: ../dtoa.c src/baremetal_stubs.h
	$(CC) $(CFLAGS) -I../include -I./src -include baremetal_stubs.h -mno-outline-atomics -c $< -o $@

clean:
	rm -f $(OBJS) $(TARGET) $(IMG)

# Show size of the kernel
size: $(TARGET)
	$(CROSS)size $(TARGET)

# Deploy to SD card (assuming /boot is mounted)
deploy: $(IMG)
	@echo "Copy $(IMG) to your SD card's boot partition"
	@echo "Required files: kernel8.img, config.txt, start.elf, fixup.dat"
