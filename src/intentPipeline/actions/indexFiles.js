import { scanAllowedFiles } from '../fileEngine.js';
import { upsertIndexRow } from '../indexStore.js';
import { extractTextFromFile } from '../contentParsers.js';

const TEXT_EXTRACT_LIMIT = 4000;

export async function indexFilesAction(_intent, ctx) {
    const { allowedDirs } = ctx;
    const files = await scanAllowedFiles(allowedDirs);

    let indexed = 0;
    for (const file of files) {
        let extractedText = '';
        try {
            extractedText = await extractTextFromFile(file.path);
        } catch {
            extractedText = '';
        }

        upsertIndexRow({
            path: file.path,
            name: file.name,
            modifiedMs: file.modifiedMs,
            extractedText: String(extractedText || '').slice(0, TEXT_EXTRACT_LIMIT)
        });
        indexed += 1;
    }

    return {
        ok: true,
        text: `Indexed ${indexed} files from allowed directories.`
    };
}
