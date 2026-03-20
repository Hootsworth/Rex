import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { manager } from './webTools.js';

export async function take_snapshot(args, signal = null) {
    if (signal?.aborted) return 'Aborted';
    
    const { name, fullPage } = args;
    if (!name || typeof name !== 'string') {
        return 'Error: take_snapshot requires a "name" argument.';
    }

    try {
        const page = await manager.getPage();
        
        // ensure regression snapshots directory exists
        const snapsDir = path.join(process.cwd(), '.agent', 'snapshots');
        if (!fs.existsSync(snapsDir)) {
            fs.mkdirSync(snapsDir, { recursive: true });
        }

        const snapshotPath = path.join(snapsDir, `${name}.png`);
        
        await page.screenshot({ 
            path: snapshotPath, 
            fullPage: !!fullPage,
            timeout: 15000 
        });

        return `Snapshot saved to ${snapshotPath}`;
    } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) return 'Aborted';
        return `Error taking snapshot: ${err.message}`;
    }
}

export async function compare_snapshots(args, signal = null) {
    if (signal?.aborted) return 'Aborted';

    const { baselineActionName, newActionName, diffName } = args;
    
    if (!baselineActionName || !newActionName) {
        return 'Error: compare_snapshots requires "baselineActionName" and "newActionName" arguments.';
    }

    try {
        const snapsDir = path.join(process.cwd(), '.agent', 'snapshots');
        const img1Path = path.join(snapsDir, `${baselineActionName}.png`);
        const img2Path = path.join(snapsDir, `${newActionName}.png`);
        const diffPath = diffName 
            ? path.join(snapsDir, `${diffName}.png`)
            : path.join(snapsDir, `diff-${baselineActionName}-${newActionName}.png`);

        if (!fs.existsSync(img1Path)) return `Error: Baseline snapshot not found at ${img1Path}`;
        if (!fs.existsSync(img2Path)) return `Error: New snapshot not found at ${img2Path}`;

        const img1 = PNG.sync.read(fs.readFileSync(img1Path));
        const img2 = PNG.sync.read(fs.readFileSync(img2Path));

        const { width, height } = img1;
        const diff = new PNG({ width, height });

        // Handle dimension mismatches
        if (img1.width !== img2.width || img1.height !== img2.height) {
            return `Error: Snapshots have different dimensions. Baseline: ${img1.width}x${img1.height}, New: ${img2.width}x${img2.height}.`;
        }

        const numDiffPixels = pixelmatch(
            img1.data, 
            img2.data, 
            diff.data, 
            width, 
            height, 
            { threshold: 0.1 }
        );

        fs.writeFileSync(diffPath, PNG.sync.write(diff));

        const totalPixels = width * height;
        const diffPercentage = ((numDiffPixels / totalPixels) * 100).toFixed(2);

        if (numDiffPixels > 0) {
            return `Snapshots differ by ${numDiffPixels} pixels (${diffPercentage}%).\nDiff image saved to ${diffPath}`;
        } else {
            return `Snapshots are identical. (0 pixels differ)`;
        }
    } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) return 'Aborted';
        return `Error comparing snapshots: ${err.message}`;
    }
}
