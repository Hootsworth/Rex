import path from 'path';
import { extractTextFromFile } from '../contentParsers.js';
import { findBestFileMatch } from '../fileEngine.js';
import { rememberLastAccessedFile } from '../memoryStore.js';
import { isPathAllowed } from '../security.js';

export async function readFileAction(intent, ctx) {
    const { allowedDirs } = ctx;
    const directPath = intent.file_path ? path.resolve(intent.file_path) : '';
    const match = directPath
        ? { path: directPath, name: path.basename(directPath) }
        : await findBestFileMatch({ query: intent.query, time: intent.time }, allowedDirs);

    if (!match) {
        return { ok: false, text: 'Could not find a file to read.' };
    }

    if (!isPathAllowed(match.path, allowedDirs)) {
        return { ok: false, text: 'File is outside allowed folders. Access denied.' };
    }

    const text = await extractTextFromFile(match.path);
    rememberLastAccessedFile(match.path, 'read_file');

    return {
        ok: true,
        text: `Read ${path.basename(match.path)}\n\n${String(text || '').slice(0, 1800)}`,
        data: { filePath: match.path }
    };
}
