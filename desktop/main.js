const { app, BrowserWindow, ipcMain, safeStorage, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fileURLToPath } = require('node:url');

const PRODUCT = 'OfficeStock';
let mainWindow;
let pendingAuthCallback = null;

function configPath(name) {
  return path.join(app.getPath('userData'), `${name}.bin`);
}

function assertLocalSender(event) {
  const url = event.senderFrame?.url || '';
  let sourcePath = '';
  try { sourcePath = path.resolve(fileURLToPath(url)).toLowerCase(); } catch (_) { /* rejected below */ }
  const uiRoot = path.resolve(__dirname, 'ui').toLowerCase() + path.sep.toLowerCase();
  if (!url.startsWith('file://') || !sourcePath.startsWith(uiRoot)) {
    throw new Error('Rejected an IPC request from an untrusted page.');
  }
}

function handleAuthDeepLink(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'officestock:' || parsed.hostname !== 'auth' || parsed.pathname !== '/callback') return;
    const values = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const accessToken = values.get('access_token');
    const refreshToken = values.get('refresh_token');
    const expiresIn = Number(values.get('expires_in') || 3600);
    const type = values.get('type') || '';
    if (!accessToken || !refreshToken || accessToken.length > 12000 || refreshToken.length > 12000) return;
    pendingAuthCallback = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      type,
      recovery: type === 'recovery'
    };
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('auth:callback', pendingAuthCallback);
      pendingAuthCallback = null;
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (_) { /* Ignore malformed or unrelated protocol URLs. */ }
}

function encrypt(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure storage is unavailable. Your settings were not saved.');
  }
  return safeStorage.encryptString(JSON.stringify(value));
}

async function readSecure(name) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure storage is unavailable.');
    }
    const bytes = await fs.readFile(configPath(name));
    return JSON.parse(safeStorage.decryptString(bytes));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not read protected ${name} data: ${error.message}`);
  }
}

async function writeSecure(name, value) {
  const destination = configPath(name);
  const temporary = `${destination}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const bytes = encrypt(value);
  await fs.writeFile(temporary, bytes, { mode: 0o600 });
  await fs.rename(temporary, destination);
}

function validatePublicConfig(config) {
  if (!config || typeof config.url !== 'string' || typeof config.publishableKey !== 'string') {
    throw new Error('Enter the Supabase project URL and publishable key.');
  }
  let parsed;
  try { parsed = new URL(config.url.trim()); } catch { throw new Error('Enter a valid Supabase project URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('The Supabase URL must be an HTTPS project origin, without a path or credentials.');
  }
  const key = config.publishableKey.trim();
  if (!key.startsWith('sb_publishable_') || /service_role|secret/i.test(key)) {
    throw new Error('Use the Supabase publishable key. Privileged keys are not accepted.');
  }
  return { url: parsed.origin, publishableKey: key };
}

ipcMain.handle('settings:read', async (event) => {
  assertLocalSender(event);
  return readSecure('connection');
});

ipcMain.handle('settings:validate-and-save', async (event, input) => {
  assertLocalSender(event);
  const config = validatePublicConfig(input);
  let response;
  try {
    response = await net.fetch(`${config.url}/auth/v1/settings`, {
      method: 'GET',
      headers: { apikey: config.publishableKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000)
    });
  } catch {
    throw new Error('Could not reach Supabase. Check the URL and your internet connection.');
  }
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? 'Supabase rejected the publishable key. Check that it belongs to this project.'
      : `Supabase connection check failed (HTTP ${response.status}).`);
  }
  await writeSecure('connection', config);
  return { ok: true };
});

ipcMain.handle('secure:read', async (event, name) => {
  assertLocalSender(event);
  if (name !== 'session') throw new Error('Invalid secure storage item.');
  return readSecure(name);
});

ipcMain.handle('secure:write', async (event, name, value) => {
  assertLocalSender(event);
  if (name !== 'session') throw new Error('Invalid secure storage item.');
  if (!value || typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string') {
    throw new Error('Invalid session data.');
  }
  await writeSecure(name, value);
  return { ok: true };
});

ipcMain.handle('secure:clear', async (event, name) => {
  assertLocalSender(event);
  if (name !== 'session') throw new Error('Invalid secure storage item.');
  await fs.rm(configPath(name), { force: true });
  return { ok: true };
});

ipcMain.on('auth:callback-ready', (event) => {
  assertLocalSender(event);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: PRODUCT,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingAuthCallback) {
      mainWindow.webContents.send('auth:callback', pendingAuthCallback);
      pendingAuthCallback = null;
    }
  });
}

const hasAppLock = app.requestSingleInstanceLock();
if (!hasAppLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.officestock.desktop');
    app.setAsDefaultProtocolClient('officestock');
    const firstLink = process.argv.find(arg => arg.startsWith('officestock://'));
    if (firstLink) setTimeout(() => handleAuthDeepLink(firstLink), 500);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('open-url', (event, url) => { event.preventDefault(); handleAuthDeepLink(url); });
app.on('second-instance', (_event, commandLine) => {
  const link = commandLine.find(arg => arg.startsWith('officestock://'));
  if (link) handleAuthDeepLink(link);
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

