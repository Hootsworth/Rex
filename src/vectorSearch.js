import { semanticSearch as deepSearch } from './memory.js';

/**
 * Performs a semantic search over the project codebase using local embeddings.
 * Falls back to basic keyword matching if the deep index is missing.
 */
export async function semanticSearch(query) {
    return await deepSearch(query);
}
