import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { AppError, PhotoLibrary, DEFAULT_SOURCE, DEFAULT_DESTINATION, directory, listFolders, checkDestination, createFolder, friendlyError } from './lib/storage.js';

const execFileAsync = promisify(execFile);
const projectDir = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);

async function readJSON(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16384) throw new AppError('请求内容过长。', 413);
  }
  try { return JSON.parse(body || '{}'); } catch { throw new AppError('请求格式错误。'); }
}

export async function createApp({ dataDir = process.env.PHOTO_SELECTOR_DATA_DIR || path.join(projectDir, '.data'), sourcePath = process.env.PHOTO_SOURCE || DEFAULT_SOURCE, destinationRoot = process.env.PHOTO_DESTINATION || DEFAULT_DESTINATION } = {}) {
  const library = new PhotoLibrary();
  const csrfToken = randomBytes(32).toString('hex');
  let settings = { sourcePath, destinationRoot, targetPath: destinationRoot };
  try {
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    for (const key of Object.keys(settings)) if (typeof saved[key] === 'string' && path.isAbsolute(saved[key])) settings[key] = saved[key];
  } catch {}
  let settingsWrite = Promise.resolve();
  let scanRequestVersion = 0;
  let targetRequestVersion = 0;
  const saveSettings = async () => {
    const snapshot = JSON.stringify(settings, null, 2);
    settingsWrite = settingsWrite.catch(() => {}).then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const temporary = path.join(dataDir, 'settings.tmp');
      await fs.writeFile(temporary, snapshot, { mode: 0o600 });
      await fs.rename(temporary, path.join(dataDir, 'settings.json'));
    });
    await settingsWrite;
  };

  const server = http.createServer(async (request, response) => {
    const send = (data, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = request.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) throw new AppError('仅允许通过本机地址访问。', 403);
      const url = new URL(request.url, `http://${host}`);
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}`) throw new AppError('不允许跨站访问。', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('不允许跨站访问。', 403);
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) throw new AppError('不支持的操作。', 405);
      if (request.method === 'POST') {
        if (request.headers['x-photo-token'] !== csrfToken) throw new AppError('页面已过期，请刷新后重试。', 403);
        if (!request.headers['content-type']?.startsWith('application/json')) throw new AppError('请求格式错误。', 415);
      }
      if (url.pathname === '/api/config' && request.method === 'GET') {
        const [source, destination] = await Promise.allSettled([directory(settings.sourcePath), checkDestination(settings.targetPath)]);
        return send({ ...settings, csrfToken, defaults: { sourcePath, destinationRoot }, server: '192.168.1.66', sourceAvailable: source.status === 'fulfilled', destinationAvailable: destination.status === 'fulfilled', nativePicker: process.platform === 'darwin' });
      }
      if (url.pathname === '/api/locations' && request.method === 'GET') {
        let volumes = [];
        try { volumes = (await listFolders('/Volumes')).folders; } catch {}
        return send({ locations: [{ name: '用户目录', path: os.homedir() }, ...volumes] });
      }
      if (url.pathname === '/api/folders' && request.method === 'GET') return send(await listFolders(url.searchParams.get('path')));
      if (url.pathname === '/api/target' && request.method === 'GET') return send(await checkDestination(url.searchParams.get('path')));
      if (url.pathname === '/api/photos' && request.method === 'POST') {
        const version = ++scanRequestVersion;
        const body = await readJSON(request);
        const result = await library.scan(body.path ?? settings.sourcePath);
        if (version === scanRequestVersion) { settings.sourcePath = result.path; await saveSettings(); }
        return send(result);
      }
      if (url.pathname === '/api/settings' && request.method === 'POST') {
        const version = ++targetRequestVersion;
        const body = await readJSON(request);
        const folder = await directory(body.targetPath);
        const root = body.destinationRoot ? await directory(body.destinationRoot) : settings.destinationRoot;
        const result = { ...settings, targetPath: folder, destinationRoot: root };
        if (version === targetRequestVersion) { settings = result; await saveSettings(); }
        return send(result);
      }
      if (url.pathname === '/api/folders' && request.method === 'POST') {
        const body = await readJSON(request);
        return send(await createFolder(body.parent, body.name), 201);
      }
      if (url.pathname === '/api/save' && request.method === 'POST') {
        const body = await readJSON(request);
        return send(await library.save(body.id, body.target ?? settings.targetPath));
      }
      if (url.pathname === '/api/pick-folder' && request.method === 'POST') {
        if (process.platform !== 'darwin') throw new AppError('当前系统请使用页面中的目录浏览器。');
        const body = await readJSON(request);
        const prompt = body.kind === 'source' ? '选择照片来源文件夹' : '选择保存照片的目标文件夹';
        // Pass the prompt as an argv value rather than interpolating user text into AppleScript.
        try {
          const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'return POSIX path of (choose folder with prompt (item 1 of argv))', '-e', 'end run', prompt], { timeout: 120000 });
          return send({ path: await directory(stdout.trim()), cancelled: false });
        } catch (error) {
          if (error.stderr?.includes('(-128)')) return send({ cancelled: true });
          throw new AppError('系统目录选择器不可用，请在页面中浏览或输入路径。');
        }
      }
      const photoMatch = /^\/api\/photo\/([a-f0-9]{32})$/.exec(url.pathname);
      if (photoMatch && request.method === 'GET') {
        const image = await library.preview(photoMatch[1], url.searchParams.get('size'));
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': image.length, 'Cache-Control': 'private, max-age=3600' });
        return response.end(image);
      }
      const file = staticFiles.get(url.pathname);
      if (file && ['GET', 'HEAD'].includes(request.method)) {
        const content = await fs.readFile(path.join(projectDir, 'public', file[0]));
        response.writeHead(200, { 'Content-Type': file[1], 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      throw new AppError('页面或接口不存在。', 404);
    } catch (error) {
      const { status, message } = friendlyError(error);
      if (status === 500) console.error(error.message);
      if (!response.headersSent) send({ error: message }, status); else response.destroy();
    }
  });
  return { server, library };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数。');
  const { server } = await createApp();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，可用 PORT=3001 npm start 更换端口。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`照片筛选工具已启动：http://localhost:${port}`));
}
