#ifndef HEAP_H
#define HEAP_H

#include <stddef.h>

// Initialize heap allocator
void heap_init(void *start, size_t size);

// Allocate memory
void *heap_alloc(size_t size);

// Free memory
void heap_free(void *ptr);

// Reallocate memory
void *heap_realloc(void *ptr, size_t size);

// Get heap statistics
size_t heap_get_free(void);
size_t heap_get_used(void);

#endif // HEAP_H
