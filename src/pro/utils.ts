import * as https from 'https';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fsSync from 'fs'; // Import standard fs module for streams
import * as path from 'path';
import extract from 'extract-zip';
import { getFoundryConfigPath } from '../utils';

export const RECON_URL = 'https://staging.getrecon.xyz';
export const CLIENT_ID = 'Iv1.0f964a64e6e49997';

export async function proxyRequest(method: string, endpoint: string, token?: string, data?: any): Promise<Response> {
    const response = await fetch(`${RECON_URL}/api/proxy`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            method,
            endpoint,
            token,
            data
        })
    });

    if (!response.ok) {
        throw new Error(`Proxy request failed: ${response.statusText}`);
    }

    return response;
}

export async function downloadAndExtractCorpus(url: string, workspaceRoot: string): Promise<string> {
    // Create a temporary directory for the zip file
    const tempDir = path.join(os.tmpdir(), 'recon-corpus-' + Date.now());
    await fs.mkdir(tempDir, { recursive: true });
    const zipFile = path.join(tempDir, 'corpus.zip');
    
    // Download the zip file
    await new Promise<void>((resolve, reject) => {
        const file = fsSync.createWriteStream(zipFile); // Use standard fs for streams
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            // Use fs/promises for unlink, but handle it properly
            fs.unlink(zipFile).catch(() => {});
            reject(err);
        });
    });
    
    // Extract to a temp directory first to identify the root directory name
    const extractTemp = path.join(tempDir, 'extract');
    await fs.mkdir(extractTemp, { recursive: true });
    await extract(zipFile, { dir: extractTemp });
    
    // Get the first directory in the extracted content (corpus root)
    const entries = await fs.readdir(extractTemp);
    const corpusDir = entries[0]; // Assume first entry is the corpus directory
    
    if (!corpusDir) {
        throw new Error('No corpus directory found in zip file');
    }
    
    // Get foundry root directory
    const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
    const foundryRoot = path.dirname(foundryConfigPath);
    const targetPath = path.join(foundryRoot, corpusDir);
    
    // Check if target directory already exists
    try {
        await fs.access(targetPath);
        // Directory exists, rename it with timestamp
        const timestamp = Date.now();
        const backupPath = `${targetPath}_${timestamp}`;
        await fs.rename(targetPath, backupPath);
    } catch (err) {
        // Directory doesn't exist, continue
    }
    
    // Move the corpus directory to the foundry root
    await fs.rename(path.join(extractTemp, corpusDir), targetPath);
    
    // Clean up temp files
    try {
        await fs.rm(tempDir, { recursive: true, force: true });
    } catch (err) {
        console.error('Failed to clean up temp files:', err);
    }
    
    return targetPath;
}
