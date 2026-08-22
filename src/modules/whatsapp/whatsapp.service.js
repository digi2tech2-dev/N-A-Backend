'use strict';

const fs = require('fs/promises');
const fsNative = require('fs');
const path = require('path');
const qrcode = require('qrcode');

let Client = null;
let LocalAuth = null;
let dependencyLoadError = null;

try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
} catch (err) {
    dependencyLoadError = err;
}

const WHATSAPP_STATE = Object.freeze({
    IDLE: 'IDLE',
    INITIALIZING: 'INITIALIZING',
    QR_READY: 'QR_READY',
    AUTHENTICATED: 'AUTHENTICATED',
    CONNECTED: 'CONNECTED',
    DISCONNECTED: 'DISCONNECTED',
    ERROR: 'ERROR',
});

const PROJECT_ROOT = path.resolve(process.cwd());
const PROJECT_ROOT_REAL = fsNative.realpathSync(PROJECT_ROOT);
const DEFAULT_DATA_ROOT = path.join(PROJECT_ROOT, '.na-hub-whatsapp');

const createRuntimePathError = () => {
    const error = new Error('WhatsApp runtime path configuration is invalid.');
    error.code = 'WHATSAPP_RUNTIME_PATH_INVALID';
    return error;
};

const resolveConfiguredPath = (value, fallback) => {
    if (value === undefined || value === null || value === '') {
        return path.resolve(fallback);
    }
    return path.resolve(String(value).trim());
};

const isStrictDescendant = (parentPath, childPath) => {
    const relative = path.relative(parentPath, childPath);
    return Boolean(relative)
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
};

const isFilesystemRoot = (targetPath) => targetPath === path.parse(targetPath).root;

const isSameOrDescendant = (parentPath, childPath) => {
    const relative = path.relative(parentPath, childPath);
    return relative === '' || (
        relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
    );
};

/**
 * Prove that every existing component below the Backend root is a real
 * directory, never a symlink, and physically remains below that root. Missing
 * children are allowed for first-run LocalAuth/cache creation; the known safe
 * existing parent is checked again immediately before every deletion.
 */
const assertPhysicalOwnedPath = (targetPath) => {
    const relative = path.relative(PROJECT_ROOT, targetPath);
    if (!isStrictDescendant(PROJECT_ROOT, targetPath)) {
        throw createRuntimePathError();
    }

    const components = relative.split(path.sep).filter(Boolean);
    let currentPath = PROJECT_ROOT;

    for (const component of components) {
        currentPath = path.join(currentPath, component);

        let entry;
        try {
            entry = fsNative.lstatSync(currentPath);
        } catch (err) {
            if (err.code === 'ENOENT') return;
            throw createRuntimePathError();
        }

        if (!entry.isDirectory() || entry.isSymbolicLink()) {
            throw createRuntimePathError();
        }

        let physicalPath;
        try {
            physicalPath = fsNative.realpathSync(currentPath);
        } catch (_) {
            throw createRuntimePathError();
        }

        if (!isSameOrDescendant(PROJECT_ROOT_REAL, physicalPath)) {
            throw createRuntimePathError();
        }
    }
};

const validateResolvedRuntimePaths = ({ dataRoot, authDataPath, cacheDataPath }) => {
    // WHATSAPP_DATA_ROOT is the explicit ownership boundary. It cannot be the
    // filesystem/project root or a parent directory that contains the project.
    if (
        isFilesystemRoot(dataRoot)
        || dataRoot === PROJECT_ROOT
        || isStrictDescendant(dataRoot, PROJECT_ROOT)
        || !isStrictDescendant(PROJECT_ROOT, dataRoot)
    ) {
        throw createRuntimePathError();
    }

    // Auth/cache directories must be distinct descendants of the approved root.
    if (
        !isStrictDescendant(dataRoot, authDataPath)
        || !isStrictDescendant(dataRoot, cacheDataPath)
        || authDataPath === cacheDataPath
        || isFilesystemRoot(authDataPath)
        || isFilesystemRoot(cacheDataPath)
    ) {
        throw createRuntimePathError();
    }

    // path.resolve()/path.relative() prove lexical containment only. Inspect
    // every existing component to reject data-root, nested, and broken symlinks
    // before either LocalAuth or reset can use the path.
    assertPhysicalOwnedPath(dataRoot);
    assertPhysicalOwnedPath(authDataPath);
    assertPhysicalOwnedPath(cacheDataPath);

    return { dataRoot, authDataPath, cacheDataPath };
};

const validateWhatsAppRuntimePaths = () => {
    const dataRoot = resolveConfiguredPath(
        process.env.WHATSAPP_DATA_ROOT,
        DEFAULT_DATA_ROOT
    );
    const authDataPath = resolveConfiguredPath(
        process.env.WHATSAPP_AUTH_DATA_PATH,
        path.join(dataRoot, 'auth')
    );
    const cacheDataPath = resolveConfiguredPath(
        process.env.WHATSAPP_CACHE_DATA_PATH,
        path.join(dataRoot, 'cache')
    );

    return validateResolvedRuntimePaths({ dataRoot, authDataPath, cacheDataPath });
};

let client = null;
let currentQrCode = null;
let currentState = WHATSAPP_STATE.IDLE;
let lastError = null;
let isInitializing = false;
let reconnectTimer = null;
let manualShutdown = false;
let lifecycleOperationId = 0;

const setState = (state) => {
    currentState = state;
};

const setLastError = (err) => {
    lastError = err
        ? {
            message: err.message || String(err),
            at: new Date().toISOString(),
        }
        : null;
};

const normalizeAdminChatId = () => {
    const rawNumber = String(process.env.ADMIN_NOTIFICATION_NUMBER || '').trim();
    if (!rawNumber) return null;

    const normalized = rawNumber.replace(/[^\d]/g, '');
    return normalized ? `${normalized}@c.us` : null;
};

const getStatus = () => ({
    state: currentState,
    qrCode: currentState === WHATSAPP_STATE.QR_READY ? currentQrCode : null,
    hasQrCode: Boolean(currentState === WHATSAPP_STATE.QR_READY && currentQrCode),
    isConnected: currentState === WHATSAPP_STATE.CONNECTED,
    isInitializing,
    adminNumberConfigured: Boolean(normalizeAdminChatId()),
    dependencyAvailable: Boolean(Client && LocalAuth),
    lastError,
});

const scheduleReconnect = () => {
    if (manualShutdown || reconnectTimer || isInitializing) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        initializeWhatsAppClient().catch((err) => {
            setLastError(err);
            setState(WHATSAPP_STATE.ERROR);
            console.error('[WhatsApp] automatic reconnect failed:', err.message);
        });
    }, Number(process.env.WHATSAPP_RECONNECT_DELAY_MS || 5000));
};

const attachClientEvents = (nextClient) => {
    nextClient.on('qr', async (qr) => {
        try {
            currentQrCode = await qrcode.toDataURL(qr);
            setLastError(null);
            setState(WHATSAPP_STATE.QR_READY);
            console.info('[WhatsApp] QR code ready.');
        } catch (err) {
            currentQrCode = null;
            setLastError(err);
            setState(WHATSAPP_STATE.ERROR);
            console.error('[WhatsApp] failed to generate QR code:', err.message);
        }
    });

    nextClient.on('authenticated', () => {
        currentQrCode = null;
        setLastError(null);
        setState(WHATSAPP_STATE.AUTHENTICATED);
        console.info('[WhatsApp] authenticated.');
    });

    nextClient.on('ready', () => {
        currentQrCode = null;
        setLastError(null);
        setState(WHATSAPP_STATE.CONNECTED);
        console.info('[WhatsApp] client ready.');
    });

    nextClient.on('auth_failure', (message) => {
        currentQrCode = null;
        setLastError(new Error(message || 'WhatsApp authentication failed.'));
        setState(WHATSAPP_STATE.ERROR);
        console.error('[WhatsApp] authentication failed:', message);
    });

    nextClient.on('disconnected', (reason) => {
        currentQrCode = null;
        client = null;
        setLastError(reason ? new Error(String(reason)) : null);
        setState(WHATSAPP_STATE.DISCONNECTED);
        console.warn('[WhatsApp] disconnected:', reason || 'unknown reason');
        scheduleReconnect();
    });
};

const buildClient = (runtimePaths = validateWhatsAppRuntimePaths()) => {
    if (!Client || !LocalAuth) {
        throw new Error(
            `whatsapp-web.js is not installed or could not be loaded. ${dependencyLoadError?.message || ''}`.trim()
        );
    }

    return new Client({
        authStrategy: new LocalAuth({
            clientId: process.env.WHATSAPP_CLIENT_ID || 'na-hub-admin-notifications',
            dataPath: runtimePaths.authDataPath,
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ],
        },
        webVersionCache: {
            // Keep version-cache files separate from every other deployment.
            // An empty local cache safely falls back to the latest version.
            type: 'local',
            path: runtimePaths.cacheDataPath,
        },
    });
};

const destroyWhatsAppClient = async () => {
    manualShutdown = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    const existingClient = client;
    client = null;
    currentQrCode = null;

    if (existingClient) {
        try {
            await existingClient.destroy();
        } catch (err) {
            console.warn('[WhatsApp] destroy failed:', err.message);
        }
    }

    setState(WHATSAPP_STATE.DISCONNECTED);
    manualShutdown = false;
};

const initializeWhatsAppClient = async ({ force = false, runtimePaths = null } = {}) => {
    if (isInitializing && !force) return getStatus();
    if (client && !force) return getStatus();

    const validatedRuntimePaths = runtimePaths || validateWhatsAppRuntimePaths();

    const operationId = ++lifecycleOperationId;
    isInitializing = true;
    currentQrCode = null;
    setLastError(null);
    setState(WHATSAPP_STATE.INITIALIZING);

    try {
        if (force && client) {
            await destroyWhatsAppClient();
            setState(WHATSAPP_STATE.INITIALIZING);
        }

        manualShutdown = false;
        client = buildClient(validatedRuntimePaths);
        attachClientEvents(client);
        await client.initialize();
        return getStatus();
    } catch (err) {
        if (operationId === lifecycleOperationId) {
            client = null;
            currentQrCode = null;
            setLastError(err);
            setState(WHATSAPP_STATE.ERROR);
        }
        console.error('[WhatsApp] initialization failed:', err.message);
        return getStatus();
    } finally {
        if (operationId === lifecycleOperationId) {
            isInitializing = false;
        }
    }
};

const reconnectWhatsAppClient = async () => {
    const runtimePaths = validateWhatsAppRuntimePaths();
    await destroyWhatsAppClient();
    return initializeWhatsAppClient({ force: true, runtimePaths });
};

const deleteSessionDirectories = async (runtimePaths = null) => {
    const paths = runtimePaths
        ? validateResolvedRuntimePaths(runtimePaths)
        : validateWhatsAppRuntimePaths();

    // Re-validate each physical target directly before deletion. This catches a
    // symlink introduced after initialization/config validation and fails closed.
    for (const targetPath of [paths.authDataPath, paths.cacheDataPath]) {
        validateResolvedRuntimePaths(paths);
        await fs.rm(targetPath, { recursive: true, force: true });
    }
};

const resetWhatsAppClient = async () => {
    // Validate before shutdown and again immediately before deletion so an
    // invalid configuration never deletes or disrupts an existing client.
    const runtimePaths = validateWhatsAppRuntimePaths();
    lifecycleOperationId += 1;
    await destroyWhatsAppClient();
    await deleteSessionDirectories(runtimePaths);
    return initializeWhatsAppClient({ force: true, runtimePaths });
};

const sendAdminNotification = async (message) => {
    const chatId = normalizeAdminChatId();

    if (!chatId) {
        throw new Error('ADMIN_NOTIFICATION_NUMBER is not configured.');
    }

    if (!client || currentState !== WHATSAPP_STATE.CONNECTED) {
        throw new Error('WhatsApp client is not connected.');
    }

    const safeMessage = String(message || '').trim();
    if (!safeMessage) {
        throw new Error('WhatsApp notification message cannot be empty.');
    }

    return client.sendMessage(chatId, safeMessage);
};

module.exports = {
    WHATSAPP_STATE,
    initializeWhatsAppClient,
    reconnectWhatsAppClient,
    resetWhatsAppClient,
    destroyWhatsAppClient,
    getStatus,
    sendAdminNotification,
    validateWhatsAppRuntimePaths,
    deleteSessionDirectories,
};
