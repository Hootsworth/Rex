import fs from 'fs';
import path from 'path';

/**
 * Validates that the requested path is safely within the current working directory.
 * Prevents Path Traversal attacks (e.g., ../../etc/passwd or C:\\Windows)
 */
function getSafePath(relativePath) {
    const cwd = process.cwd();
    // Resolve calculates the absolute path, normalizing away any ../ or ./
    const targetPath = path.resolve(cwd, relativePath || '.');

    // Ensure the resolved path is inside CWD (or exactly CWD).
    // Use a separator-boundary check to avoid prefix bypasses like:
    // CWD=C:\project and target=C:\project-backup
    const isWindows = process.platform === 'win32';
    const normalizeForCompare = (v) => {
        const normalized = path.resolve(v);
        return isWindows ? normalized.toLowerCase() : normalized;
    };

    const normalizedCwd = normalizeForCompare(cwd);
    const normalizedTarget = normalizeForCompare(targetPath);
    const cwdWithSep = normalizedCwd.endsWith(path.sep) ? normalizedCwd : `${normalizedCwd}${path.sep}`;
    const startsWithCwd = normalizedTarget === normalizedCwd || normalizedTarget.startsWith(cwdWithSep);

    if (!startsWithCwd) {
        throw new Error(`SECURITY EXCEPTION: Access denied. Path traversal detected. Rex is restricted to the current working directory (${cwd}).`);
    }

    return targetPath;
}

/**
 * Safely reads a file's content
 */
export async function read_file(filePath) {
    try {
        const safePath = getSafePath(filePath);
        if (!fs.existsSync(safePath)) {
            return `Error: File not found at ${filePath}`;
        }
        
        const stats = fs.statSync(safePath);
        if (stats.isDirectory()) {
            return `Error: ${filePath} is a directory, not a file.`;
        }

        // Prevent reading massive binary files or huge logs that would overflow the context window
        if (stats.size > 1024 * 500) { // 500KB limit
            return `Error: File ${filePath} is too large (${Math.round(stats.size/1024)}KB) to read into context. Maximum allowed is 500KB.`;
        }

        return fs.readFileSync(safePath, 'utf8');
    } catch (err) {
        return `Error reading file ${filePath}: ${err.message}`;
    }
}

/**
 * Safely writes content to a file. Overwrites if it exists.
 */
export async function write_file(filePath, content) {
    try {
        const safePath = getSafePath(filePath);
        
        // Ensure the directory exists before writing
        const dir = path.dirname(safePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(safePath, content, 'utf8');
        return `Successfully wrote to ${filePath}`;
    } catch (err) {
        return `Error writing to file ${filePath}: ${err.message}`;
    }
}

/**
 * Patches a specific target string with a new replacement string inside a file.
 * Returns an error if the target text is not found exactly once.
 */
export async function patch_file(filePath, targetContent, replacementContent) {
    try {
        if (typeof targetContent !== 'string' || targetContent.length === 0) {
            return `Error patching ${filePath}: targetContent must be a non-empty string.`;
        }

        const safePath = getSafePath(filePath);
        if (!fs.existsSync(safePath)) {
            return `Error: File not found at ${filePath}`;
        }

        const content = fs.readFileSync(safePath, 'utf8');
        
        // Count occurrences
        const occurrences = content.split(targetContent).length - 1;
        
        if (occurrences === 0) {
            return `Error patching ${filePath}: Target string not found in file. Ensure exact whitespace and linebreaks match.`;
        }
        
        if (occurrences > 1) {
            return `Error patching ${filePath}: Target string found ${occurrences} times. The target context must be unique to avoid patching the wrong location. Please include more surrounding lines in your targetContent.`;
        }

        const newContent = content.replace(targetContent, replacementContent);
        fs.writeFileSync(safePath, newContent, 'utf8');
        
        return `Successfully patched ${filePath}`;
    } catch (err) {
        return `Error patching file ${filePath}: ${err.message}`;
    }
}

/**
 * Safely lists directory contents
 */
export async function read_dir(dirPath) {
    try {
        const safePath = getSafePath(dirPath || '.');
        if (!fs.existsSync(safePath)) {
            return `Error: Directory not found at ${dirPath}`;
        }

        const stats = fs.statSync(safePath);
        if (!stats.isDirectory()) {
            return `Error: ${dirPath} is a file, not a directory.`;
        }

        const items = fs.readdirSync(safePath);
        return items.join('\n');
    } catch (err) {
        return `Error reading directory ${dirPath}: ${err.message}`;
    }
}
