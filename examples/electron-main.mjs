/**
 * Electron 主进程示例（宿主桥）：凭据只存在于主进程。
 *
 * 渲染进程拿不到 secretKey，也不能让主进程对任意内容签名；
 * 它只能提交「对象名 + 方法名 + 参数」，且必须在下面的白名单里。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { createClient, createHostHandler } from '@yungot/unicloud-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(__dirname, 'preload.js');

const cloud = createClient({
  space: {
    provider: 'alipay',
    spaceId: process.env.UNICLOUD_SPACE_ID ?? '',
    spaceAppId: process.env.UNICLOUD_SPACE_APP_ID,
    accessKey: process.env.UNICLOUD_ACCESS_KEY,
    secretKey: process.env.UNICLOUD_SECRET_KEY,
  },
  appId: '__UNI__YOUR_APP',
  osName: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
});

const handle = createHostHandler(cloud, {
  // 白名单：只有这里列出的「云对象.方法」能被渲染进程调用
  objects: {
    music: ['search', 'getPlayUrl', 'getLyric', 'listPlaylist', 'addFavorite'],
  },
  // 幂等方法：网络错误 / 5xx 时自动重试；addFavorite 是写操作，不在其中
  idempotent: {
    music: ['search', 'getPlayUrl', 'getLyric', 'listPlaylist'],
  },
});

// handle 永不抛异常，返回 { ok, result } 或 { ok: false, error: { errCode, errMsg, requestId } }
ipcMain.handle('cloud:call', (_event, call) => handle(call));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: PRELOAD_PATH },
  });
  win.loadFile('index.html');
});

// preload.js：
//   const { contextBridge, ipcRenderer } = require('electron')
//   contextBridge.exposeInMainWorld('cloud', { call: (c) => ipcRenderer.invoke('cloud:call', c) })
//
// 渲染进程（写法与 createClient 一致）：
//   import { createRemoteClient } from '@yungot/unicloud-sdk'
//   const music = createRemoteClient((c) => window.cloud.call(c)).importObject('music')
//   const { list } = await music.search('晴天')
