import { searchIndex } from '../indexStore.js';

export async function searchFilesAction(intent) {
    const query = String(intent.query || '').trim();
    if (!query) {
        return { ok: false, text: 'Please provide a search query.' };
    }

    const rows = searchIndex(query, 10);
    if (!rows.length) {
        return { ok: true, text: `No indexed files matched "${query}". Run index first.` };
    }

    const list = rows.map((r, idx) => `${idx + 1}. ${r.name} -> ${r.path}`).join('\n');
    return {
        ok: true,
        text: `Indexed matches for "${query}":\n${list}`,
        data: { matches: rows }
    };
}
