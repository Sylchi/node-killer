#include "heap.h"
#include <stdint.h>

// Memory block header
typedef struct Block {
    size_t size;           // Size of this block (excluding header)
    struct Block *next;    // Next block in free list
    int free;              // 1 if free, 0 if allocated
} Block;

#define BLOCK_HEADER_SIZE sizeof(Block)
#define ALIGN_SIZE 8

static void *heap_start = NULL;
static size_t heap_size = 0;
static Block *free_list = NULL;
static size_t free_bytes = 0;
static size_t used_bytes = 0;

// Align size up to ALIGN_SIZE boundary
static size_t align_size(size_t size) {
    return (size + ALIGN_SIZE - 1) & ~(ALIGN_SIZE - 1);
}

void heap_init(void *start, size_t size) {
    heap_start = start;
    heap_size = size;
    
    // Initialize first block spanning entire heap
    Block *first = (Block *)start;
    first->size = size - BLOCK_HEADER_SIZE;
    first->next = NULL;
    first->free = 1;
    
    free_list = first;
    free_bytes = first->size;
    used_bytes = 0;
}

void *heap_alloc(size_t size) {
    if (size == 0) return NULL;
    
    size = align_size(size);
    
    // First-fit search
    Block *prev = NULL;
    Block *curr = free_list;
    
    while (curr != NULL) {
        if (curr->free && curr->size >= size) {
            // Found a suitable block
            if (curr->size > size + BLOCK_HEADER_SIZE + ALIGN_SIZE) {
                // Split the block
                Block *new_block = (Block *)((uint8_t *)curr + BLOCK_HEADER_SIZE + size);
                new_block->size = curr->size - size - BLOCK_HEADER_SIZE;
                new_block->next = curr->next;
                new_block->free = 1;
                
                curr->size = size;
                curr->next = new_block;
                
                free_bytes -= (size + BLOCK_HEADER_SIZE);
            }
            
            curr->free = 0;
            used_bytes += curr->size;
            
            return (void *)((uint8_t *)curr + BLOCK_HEADER_SIZE);
        }
        
        prev = curr;
        curr = curr->next;
    }
    
    // No suitable block found
    return NULL;
}

void heap_free(void *ptr) {
    if (ptr == NULL) return;
    
    Block *block = (Block *)((uint8_t *)ptr - BLOCK_HEADER_SIZE);
    block->free = 1;
    used_bytes -= block->size;
    free_bytes += block->size;
    
    // Coalesce with next block if it's free
    if (block->next != NULL && block->next->free) {
        block->size += BLOCK_HEADER_SIZE + block->next->size;
        block->next = block->next->next;
    }
    
    // Coalesce with previous block if it's free
    Block *prev = NULL;
    Block *curr = free_list;
    
    while (curr != NULL && curr != block) {
        prev = curr;
        curr = curr->next;
    }
    
    if (prev != NULL && prev->free) {
        prev->size += BLOCK_HEADER_SIZE + block->size;
        prev->next = block->next;
    }
}

void *heap_realloc(void *ptr, size_t size) {
    if (ptr == NULL) {
        return heap_alloc(size);
    }
    
    if (size == 0) {
        heap_free(ptr);
        return NULL;
    }
    
    Block *block = (Block *)((uint8_t *)ptr - BLOCK_HEADER_SIZE);
    
    if (block->size >= size) {
        // Current block is large enough
        return ptr;
    }
    
    // Allocate new block and copy data
    void *new_ptr = heap_alloc(size);
    if (new_ptr == NULL) {
        return NULL;
    }
    
    // Copy old data
    size_t copy_size = block->size < size ? block->size : size;
    uint8_t *src = (uint8_t *)ptr;
    uint8_t *dst = (uint8_t *)new_ptr;
    for (size_t i = 0; i < copy_size; i++) {
        dst[i] = src[i];
    }
    
    heap_free(ptr);
    return new_ptr;
}

size_t heap_get_free(void) {
    return free_bytes;
}

size_t heap_get_used(void) {
    return used_bytes;
}
