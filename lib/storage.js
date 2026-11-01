import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import sharp from 'sharp';

export const DEFAULT_SOURCE = '/Volumes/NIKON Z5_2 /DCIM';
export const DEFAULT_DESTINATION = '/Volumes/nas/生活/2026';
const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.heic', '.heif', '.avif']);
const collator = new Intl.Collator('zh-CN', { numeric: true });
const execFileAsync = promisify(execFile);

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function absolutePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new AppError('请输入有效的文件夹路径。');
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new AppError('请使用完整路径，例如 /Volumes/nas/生活/2026。');
  return path.resolve(expanded);
}

export async function directory(value) {
  const requested = absolutePath(value);
  const resolved = await fs.realpath(requested);
  if (!(await fs.stat(resolved)).isDirectory()) throw new AppError('所选路径不是文件夹。');
  return resolved;
}

export async function listFolders(value) {
  const folder = await directory(value);
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => collator.compare(a.name, b.name))
    .map(e => ({ name: e.name, path: path.join(folder, e.name) }));
  return { path: folder, parent: path.dirname(folder), folders };
}

export async function assertMountedVolume(folder) {
  if (process.platform !== 'darwin' || !folder.startsWith('/Volumes/')) return;
  const volume = path.join('/Volumes', folder.split('/')[2]);
  const [volumeStat, parentStat] = await Promise.all([fs.stat(volume), fs.stat('/Volumes')]);
  if (volumeStat.dev === parentStat.dev) throw new AppError('目标磁盘未挂载，请连接磁盘或 NAS 后重试。', 409);
  if (volume === '/Volumes/nas') {
    const { stdout } = await execFileAsync('/sbin/mount', [], { timeout: 5000 });
    if (!/\/\/[^\n]*192\.168\.1\.66\/nas on \/Volumes\/nas \(smbfs[,)]/.test(stdout)) {
      throw new AppError('NAS 未连接到 192.168.1.66/nas，请重新挂载后再保存。', 409);
    }
  }
}

export async function checkDestination(value) {
  const result = await listFolders(value);
  await assertMountedVolume(result.path);
  await fs.access(result.path, constants.W_OK);
  return result;
}

export async function createFolder(parent, name) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || /[\/\\\0]/.test(name) || name === '.' || name === '..' || name.startsWith('.') || name.length > 200) {
    throw new AppError('文件夹名不能以点开头或包含斜杠，且首尾不能有空格。');
  }
  const parentFolder = await directory(parent);
  await assertMountedVolume(parentFolder);
  const folder = path.join(parentFolder, name);
  try { await fs.mkdir(folder); }
  catch (error) { if (error.code === 'EEXIST') throw new AppError('同名文件夹已存在，请换一个名称。', 409); throw error; }
  return { path: folder, name };
}

export class PhotoLibrary {
  constructor() {
    this.photos = new Map();
    this.cache = new Map();
    this.cacheBytes = 0;
    this.pendingPreviews = new Map();
    this.pendingSaves = new Map();
    // Bound CPU use and memory when several thumbnails arrive together.
    sharp.concurrency(2);
    sharp.cache({ memory: 48, files: 16, items: 64 });
    this.previewWorkers = 0;
    this.previewQueue = [];
  }

  async scan(value) {
    const root = await directory(value);
    const photos = [];
    const warnings = [];
    const walk = async folder => {
      let entries;
      try { entries = await fs.readdir(folder, { withFileTypes: true }); }
      catch (error) { if (folder === root) throw error; warnings.push(`无法读取 ${path.relative(root, folder)}`); return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(fullPath);
        // Do not follow symlinks to files or directories outside the chosen source.
        else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
          try {
            const stats = await fs.stat(fullPath);
            const id = createHash('sha256').update(`${fullPath}\0${stats.size}\0${stats.mtimeMs}`).digest('hex').slice(0, 32);
            photos.push({ id, name: entry.name, relativePath: path.relative(root, fullPath), size: stats.size, modifiedAt: stats.mtime.toISOString(), fullPath, root, mtimeMs: stats.mtimeMs });
          } catch { warnings.push(`无法读取 ${entry.name}`); }
        }
      }
    };
    await walk(root);
    photos.sort((a, b) => collator.compare(a.relativePath, b.relativePath));
    for (const photo of photos) this.photos.set(photo.id, photo);
    // Retain already-open libraries for in-flight browser requests, with a bound.
    if (this.photos.size > 50000) this.photos = new Map(photos.map(p => [p.id, p]));
    return { path: root, total: photos.length, warnings, photos: photos.map(({ fullPath, root, mtimeMs, ...photo }) => photo) };
  }

  get(id) {
    const photo = this.photos.get(id);
    if (!photo) throw new AppError('照片列表已过期，请重新扫描照片目录。', 404);
    return photo;
  }

  async checkedPhoto(id) {
    const photo = this.get(id);
    const resolved = await fs.realpath(photo.fullPath);
    if (resolved !== photo.fullPath) throw new AppError('照片路径已变化，请重新扫描。', 409);
    const stats = await fs.stat(resolved);
    if (!stats.isFile() || stats.size !== photo.size || stats.mtimeMs !== photo.mtimeMs) throw new AppError('照片已变化，请重新扫描后再保存。', 409);
    return { photo, stats };
  }

  async preview(id, size) {
    const photo = this.get(id);
    const kind = size === 'thumb' || size === 'clipboard' ? size : 'preview';
    const key = `${id}:${kind}`;
    if (this.cache.has(key)) {
      const data = this.cache.get(key);
      this.cache.delete(key); this.cache.set(key, data);
      return data;
    }
    if (this.pendingPreviews.has(key)) return this.pendingPreviews.get(key);
    const work = (async () => {
      if (this.previewWorkers >= 3) await new Promise(resolve => {
        // Keep user-requested images ahead of background thumbnails.
        if (kind !== 'thumb') this.previewQueue.unshift(resolve); else this.previewQueue.push(resolve);
      });
      else this.previewWorkers++;
      try {
        await this.checkedPhoto(id);
        const pipeline = sharp(photo.fullPath, { limitInputPixels: 120000000 }).autoOrient();
        if (kind !== 'clipboard') {
          const max = kind === 'thumb' ? 240 : 2200;
          pipeline.resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true });
        }
        const result = await (kind === 'clipboard' ? pipeline.png() : pipeline.jpeg({ quality: kind === 'thumb' ? 75 : 90 })).toBuffer();
        this.cache.set(key, result); this.cacheBytes += result.length;
        while (this.cacheBytes > 80 * 1024 * 1024 && this.cache.size > 1) {
          const oldest = this.cache.keys().next().value;
          this.cacheBytes -= this.cache.get(oldest).length; this.cache.delete(oldest);
        }
        return result;
      } finally {
        const next = this.previewQueue.shift();
        if (next) next(); else this.previewWorkers--;
      }
    })();
    this.pendingPreviews.set(key, work);
    try { return await work; } finally { this.pendingPreviews.delete(key); }
  }

  async save(id, target) {
    const folder = await directory(target);
    await assertMountedVolume(folder);
    const key = `${id}:${folder}`;
    if (this.pendingSaves.has(key)) return this.pendingSaves.get(key);
    const work = this.copyOriginal(id, folder);
    this.pendingSaves.set(key, work);
    try { return await work; } finally { this.pendingSaves.delete(key); }
  }

  async copyOriginal(id, folder) {
    const { photo, stats } = await this.checkedPhoto(id);
    const { name, ext } = path.parse(photo.name);
    let sourceHash;
    const originalHash = async () => sourceHash ??= await hashFile(photo.fullPath);
    for (let index = 0; index < 10000; index++) {
      const fileName = index ? `${name}_${index}${ext}` : photo.name;
      const destination = path.join(folder, fileName);
      try {
        const existing = await fs.lstat(destination);
        if (existing.isFile() && existing.size === stats.size && await hashFile(destination) === await originalHash()) {
          return { name: fileName, path: destination, target: folder, alreadyExists: true, renamed: index > 0 };
        }
        continue;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }

      // EXCL guarantees we never replace another photo, even with simultaneous saves.
      try { await fs.copyFile(photo.fullPath, destination, constants.COPYFILE_EXCL); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      try {
        const handle = await fs.open(destination, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
        await this.checkedPhoto(id);
        if (await hashFile(destination) !== await originalHash()) throw new AppError('复制校验失败，请检查 NAS 连接后重试。', 500);
      } catch (error) {
        await fs.unlink(destination).catch(() => {});
        throw error;
      }
      // Some NAS shares allow copying but not changing file timestamps.
      // A metadata restriction must not discard the successfully verified original.
      let timestampPreserved = true;
      try { await fs.utimes(destination, stats.atime, stats.mtime); } catch { timestampPreserved = false; }
      return { name: fileName, path: destination, target: folder, alreadyExists: false, renamed: index > 0, timestampPreserved };
    }
    throw new AppError('同名文件过多，请选择其他文件夹。', 409);
  }
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function friendlyError(error) {
  if (error instanceof AppError) return { status: error.status, message: error.message };
  if (['ENOENT', 'ENOTDIR', 'ENXIO', 'EIO', 'ENODEV', 'ESTALE', 'ETIMEDOUT'].includes(error.code)) return { status: 404, message: '目录或照片无法访问。请确认相机卡已连接，NAS 已挂载，再重试。' };
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return { status: 403, message: '没有读写权限。请检查目录权限或 NAS 共享权限。' };
  if (['ENOSPC', 'EDQUOT'].includes(error.code)) return { status: 507, message: '目标磁盘空间不足，请释放空间或更换文件夹。' };
  return { status: 500, message: '操作失败，请检查连接后重试。' };
}
