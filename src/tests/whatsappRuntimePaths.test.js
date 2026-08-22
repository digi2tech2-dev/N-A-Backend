'use strict';

const fs = require('fs/promises');
const path = require('path');
const {
    validateWhatsAppRuntimePaths,
    deleteSessionDirectories,
} = require('../modules/whatsapp/whatsapp.service');

const ENV_KEYS = [
    'WHATSAPP_DATA_ROOT',
    'WHATSAPP_AUTH_DATA_PATH',
    'WHATSAPP_CACHE_DATA_PATH',
];

let originalEnv;
let tempRoots;

const restoreEnv = () => {
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
};

const makeTempRoot = async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), '.na-hub-whatsapp-test-'));
    tempRoots.push(root);
    return root;
};

const expectInvalidRuntimePaths = () => {
    expect(() => validateWhatsAppRuntimePaths()).toThrow(/runtime path configuration is invalid/i);
};

beforeEach(() => {
    originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    tempRoots = [];
    for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
    restoreEnv();
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('WhatsApp runtime physical path containment', () => {
    it('accepts the normal non-symlink N&A default auth and cache paths', () => {
        const runtimePaths = validateWhatsAppRuntimePaths();
        const expectedRoot = path.join(process.cwd(), '.na-hub-whatsapp');

        expect(runtimePaths.dataRoot).toBe(expectedRoot);
        expect(runtimePaths.authDataPath).toBe(path.join(expectedRoot, 'auth'));
        expect(runtimePaths.cacheDataPath).toBe(path.join(expectedRoot, 'cache'));
    });

    it('accepts valid nested auth/cache overrides below a normal root', async () => {
        const root = await makeTempRoot();
        process.env.WHATSAPP_DATA_ROOT = root;
        process.env.WHATSAPP_AUTH_DATA_PATH = path.join(root, 'sessions', 'auth');
        process.env.WHATSAPP_CACHE_DATA_PATH = path.join(root, 'sessions', 'cache');

        const runtimePaths = validateWhatsAppRuntimePaths();

        expect(runtimePaths.authDataPath).toBe(path.join(root, 'sessions', 'auth'));
        expect(runtimePaths.cacheDataPath).toBe(path.join(root, 'sessions', 'cache'));
    });

    it('rejects a data-root symlink to another directory', async () => {
        const owner = await makeTempRoot();
        const outside = await makeTempRoot();
        const linkedRoot = path.join(owner, 'linked-runtime');
        const outsideFile = path.join(outside, 'preserve.txt');
        await fs.writeFile(outsideFile, 'keep');
        await fs.symlink(outside, linkedRoot, 'dir');

        process.env.WHATSAPP_DATA_ROOT = linkedRoot;
        process.env.WHATSAPP_AUTH_DATA_PATH = path.join(linkedRoot, 'auth');
        process.env.WHATSAPP_CACHE_DATA_PATH = path.join(linkedRoot, 'cache');

        expectInvalidRuntimePaths();
        await expect(deleteSessionDirectories()).rejects.toThrow(/runtime path configuration is invalid/i);
        await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('keep');
    });

    it('rejects auth, cache, nested-parent, and broken symlink components', async () => {
        const root = await makeTempRoot();
        const outside = await makeTempRoot();
        const normalCache = path.join(root, 'cache');
        await fs.mkdir(normalCache, { recursive: true });

        process.env.WHATSAPP_DATA_ROOT = root;
        process.env.WHATSAPP_CACHE_DATA_PATH = normalCache;

        const authLink = path.join(root, 'auth-link');
        await fs.symlink(outside, authLink, 'dir');
        process.env.WHATSAPP_AUTH_DATA_PATH = authLink;
        expectInvalidRuntimePaths();

        await fs.rm(authLink);
        const cacheLink = path.join(root, 'cache-link');
        await fs.symlink(outside, cacheLink, 'dir');
        process.env.WHATSAPP_AUTH_DATA_PATH = path.join(root, 'auth');
        process.env.WHATSAPP_CACHE_DATA_PATH = cacheLink;
        expectInvalidRuntimePaths();

        await fs.rm(cacheLink);
        const nestedLink = path.join(root, 'nested');
        await fs.symlink(outside, nestedLink, 'dir');
        process.env.WHATSAPP_AUTH_DATA_PATH = path.join(nestedLink, 'auth');
        process.env.WHATSAPP_CACHE_DATA_PATH = normalCache;
        expectInvalidRuntimePaths();

        await fs.rm(nestedLink);
        const brokenLink = path.join(root, 'broken-cache');
        await fs.symlink(path.join(outside, 'missing-target'), brokenLink, 'dir');
        process.env.WHATSAPP_AUTH_DATA_PATH = path.join(root, 'auth');
        process.env.WHATSAPP_CACHE_DATA_PATH = brokenLink;
        expectInvalidRuntimePaths();
    });

    it('rejects lexical escapes, filesystem/project roots, outside paths, and identical paths', async () => {
        const root = await makeTempRoot();
        const outside = await makeTempRoot();
        process.env.WHATSAPP_DATA_ROOT = root;
        process.env.WHATSAPP_CACHE_DATA_PATH = path.join(root, 'cache');

        process.env.WHATSAPP_AUTH_DATA_PATH = path.join(root, '..', 'escape');
        expectInvalidRuntimePaths();

        process.env.WHATSAPP_AUTH_DATA_PATH = path.join(outside, 'auth');
        expectInvalidRuntimePaths();

        process.env.WHATSAPP_DATA_ROOT = path.parse(root).root;
        expectInvalidRuntimePaths();

        process.env.WHATSAPP_DATA_ROOT = process.cwd();
        expectInvalidRuntimePaths();

        process.env.WHATSAPP_DATA_ROOT = path.join(process.cwd(), '..', 'other-project-whatsapp-runtime');
        expectInvalidRuntimePaths();

        process.env.WHATSAPP_DATA_ROOT = root;
        process.env.WHATSAPP_AUTH_DATA_PATH = path.join(root, 'same');
        process.env.WHATSAPP_CACHE_DATA_PATH = path.join(root, 'same');
        expectInvalidRuntimePaths();
    });

    it('rejects invalid/symlink configuration before deleting anything outside or inside the root', async () => {
        const root = await makeTempRoot();
        const outside = await makeTempRoot();
        const authLink = path.join(root, 'auth');
        const cachePath = path.join(root, 'cache');
        const outsideFile = path.join(outside, 'preserve.txt');
        await fs.symlink(outside, authLink, 'dir');
        await fs.mkdir(cachePath, { recursive: true });
        await fs.writeFile(outsideFile, 'keep');
        await fs.writeFile(path.join(cachePath, 'keep.txt'), 'keep');

        process.env.WHATSAPP_DATA_ROOT = root;
        process.env.WHATSAPP_AUTH_DATA_PATH = authLink;
        process.env.WHATSAPP_CACHE_DATA_PATH = cachePath;

        await expect(deleteSessionDirectories()).rejects.toThrow(/runtime path configuration is invalid/i);
        await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('keep');
        await expect(fs.readFile(path.join(cachePath, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    });

    it('revalidates immediately before deletion when a path becomes a symlink', async () => {
        const root = await makeTempRoot();
        const outside = await makeTempRoot();
        const authPath = path.join(root, 'auth');
        const cachePath = path.join(root, 'cache');
        const outsideFile = path.join(outside, 'preserve.txt');
        await fs.mkdir(authPath, { recursive: true });
        await fs.mkdir(cachePath, { recursive: true });
        await fs.writeFile(outsideFile, 'keep');

        process.env.WHATSAPP_DATA_ROOT = root;
        process.env.WHATSAPP_AUTH_DATA_PATH = authPath;
        process.env.WHATSAPP_CACHE_DATA_PATH = cachePath;
        const validatedPaths = validateWhatsAppRuntimePaths();

        await fs.rm(authPath, { recursive: true, force: true });
        await fs.symlink(outside, authPath, 'dir');

        await expect(deleteSessionDirectories(validatedPaths)).rejects.toThrow(/runtime path configuration is invalid/i);
        await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('keep');
        await expect(fs.stat(cachePath)).resolves.toBeDefined();
    });

    it('deletes only validated non-symlink auth/cache descendants', async () => {
        const root = await makeTempRoot();
        const outside = await makeTempRoot();
        const authPath = path.join(root, 'sessions', 'auth');
        const cachePath = path.join(root, 'sessions', 'cache');
        const outsideFile = path.join(outside, 'preserve.txt');
        await fs.mkdir(authPath, { recursive: true });
        await fs.mkdir(cachePath, { recursive: true });
        await fs.writeFile(path.join(authPath, 'session.txt'), 'test');
        await fs.writeFile(path.join(cachePath, 'cache.txt'), 'test');
        await fs.writeFile(outsideFile, 'keep');

        process.env.WHATSAPP_DATA_ROOT = root;
        process.env.WHATSAPP_AUTH_DATA_PATH = authPath;
        process.env.WHATSAPP_CACHE_DATA_PATH = cachePath;
        await deleteSessionDirectories();

        await expect(fs.stat(authPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.stat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('keep');
    });
});
