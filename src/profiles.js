import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.power-cli');
const PROFILES_DIR = path.join(CONFIG_DIR, 'profiles');

function ensureProfilesDir() {
    if (!fs.existsSync(PROFILES_DIR)) {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
    }
}

/**
 * Saves the current config as a named profile
 * @param {string} name - Profile name (e.g. "work", "personal", "client-x")
 * @param {object} config - The config object to save
 */
export function saveProfile(name, config) {
    ensureProfilesDir();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filePath = path.join(PROFILES_DIR, `${slug}.json`);
    const profile = {
        name,
        slug,
        createdAt: new Date().toISOString(),
        config
    };
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');
    return filePath;
}

/**
 * Loads a named profile
 * @param {string} name
 * @returns {object|null} The config from the profile, or null
 */
export function loadProfile(name) {
    ensureProfilesDir();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filePath = path.join(PROFILES_DIR, `${slug}.json`);
    if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return data.config;
    }
    return null;
}

/**
 * Lists all saved profiles
 * @returns {Array<{name, slug, createdAt}>}
 */
export function listProfiles() {
    ensureProfilesDir();
    const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf-8'));
            return { name: data.name, slug: data.slug, createdAt: data.createdAt };
        } catch (e) {
            return null;
        }
    }).filter(Boolean);
}

/**
 * Deletes a profile
 * @param {string} name
 * @returns {boolean}
 */
export function deleteProfile(name) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filePath = path.join(PROFILES_DIR, `${slug}.json`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
    }
    return false;
}
