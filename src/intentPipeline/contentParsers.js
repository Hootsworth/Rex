import fs from 'fs/promises';
import path from 'path';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.log', '.js', '.ts', '.html', '.css', '.py']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff']);

export async function extractTextFromFile(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();

    if (TEXT_EXTENSIONS.has(ext)) {
        return await fs.readFile(filePath, 'utf-8');
    }

    if (ext === '.pdf') {
        const pdfLib = await import('pdf-parse');
        const pdfParse = pdfLib.default || pdfLib;
        const buf = await fs.readFile(filePath);
        const parsed = await pdfParse(buf);
        return parsed.text || '';
    }

    if (ext === '.docx') {
        const mammoth = await import('mammoth');
        const buf = await fs.readFile(filePath);
        const res = await mammoth.extractRawText({ buffer: buf });
        return res.value || '';
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
        return await runOcr(filePath);
    }

    return '';
}

export async function runOcr(filePath) {
    const tesseract = await import('tesseract.js');
    const worker = await tesseract.createWorker('eng');
    try {
        const result = await worker.recognize(filePath);
        return result?.data?.text || '';
    } finally {
        await worker.terminate();
    }
}
