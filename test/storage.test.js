import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { PhotoLibrary, createFolder, listFolders, absolutePath } from '../lib/storage.js';
import { createApp } from '../server.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-selector-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'NIKON Z5_2 ', 'DCIM');
  const target = path.join(root, 'nas', '生活', '2026');
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(target, { recursive: true });
  const image = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#84ae48' } }).jpeg().toBuffer();
  await fs.writeFile(path.join(source, 'DSC_2.JPG'), image);
  return { root, source, target, image };
}

test('递归扫描包含空格的目录，过滤隐藏文件和符号链接，按数字排序', async t => {
  const { source, root, image } = await fixture(t);
  await fs.mkdir(path.join(source, '117NZ5_2'));
  await fs.writeFile(path.join(source, 'DSC_10.JPG'), image);
  await fs.writeFile(path.join(source, '._DSC_2.JPG'), image);
  await fs.writeFile(path.join(source, '117NZ5_2', 'DSC_20.JPG'), image);
  await fs.writeFile(path.join(source, 'NC_FLLST.DAT'), 'data');
  await fs.writeFile(path.join(root, 'outside.JPG'), image);
  await fs.symlink(path.join(root, 'outside.JPG'), path.join(source, 'linked.JPG'));
  const result = await new PhotoLibrary().scan(source);
  assert.equal(result.total, 3);
  assert.deepEqual(result.photos.filter(p => !p.relativePath.includes('/')).map(p => p.name), ['DSC_2.JPG', 'DSC_10.JPG']);
  assert.ok(result.photos.every(p => !('fullPath' in p)));
});

test('保存原图完整不变，重复和并发保存只保留一份', async t => {
  const { source, target, image } = await fixture(t);
  const library = new PhotoLibrary(); const { photos } = await library.scan(source);
  const results = await Promise.all(Array.from({ length: 5 }, () => library.save(photos[0].id, target)));
  assert.ok(results.every(r => r.path === results[0].path));
  assert.deepEqual(await fs.readdir(target), ['DSC_2.JPG']);
  assert.deepEqual(await fs.readFile(results[0].path), image);
  assert.deepEqual(await fs.readFile(path.join(source, 'DSC_2.JPG')), image);
  assert.equal((await library.save(photos[0].id, target)).alreadyExists, true);
});

test('已有同名不同照片和符号链接不会被覆盖', async t => {
  const { source, target, root, image } = await fixture(t);
  await fs.writeFile(path.join(target, 'DSC_2.JPG'), 'existing photo');
  const outside = path.join(root, 'valuable.JPG'); await fs.writeFile(outside, 'keep');
  await fs.symlink(outside, path.join(target, 'DSC_2_1.JPG'));
  const library = new PhotoLibrary(); const { photos } = await library.scan(source);
  const result = await library.save(photos[0].id, target);
  assert.equal(result.name, 'DSC_2_2.JPG'); assert.equal(result.renamed, true);
  assert.deepEqual(await fs.readFile(result.path), image);
  assert.equal(await fs.readFile(path.join(target, 'DSC_2.JPG'), 'utf8'), 'existing photo');
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
});

test('只读源照片也可归档，源权限与内容保持不变', async t => {
  const { source, target, image } = await fixture(t);
  const original = path.join(source, 'DSC_2.JPG');
  await fs.chmod(original, 0o444);
  const library = new PhotoLibrary(); const { photos } = await library.scan(source);
  const saved = await library.save(photos[0].id, target);
  assert.deepEqual(await fs.readFile(saved.path), image);
  assert.equal((await fs.stat(original)).mode & 0o777, 0o444);
});

test('源文件被修改或替换为符号链接时拒绝复制', async t => {
  const { source, target, root } = await fixture(t);
  const library = new PhotoLibrary(); const { photos } = await library.scan(source);
  await fs.writeFile(path.join(source, 'DSC_2.JPG'), 'changed');
  await assert.rejects(library.save(photos[0].id, target), /照片已变化/);
  await fs.unlink(path.join(source, 'DSC_2.JPG')); await fs.writeFile(path.join(root, 'outside.JPG'), 'outside');
  await fs.symlink(path.join(root, 'outside.JPG'), path.join(source, 'DSC_2.JPG'));
  await assert.rejects(library.save(photos[0].id, target), /路径已变化/);
  assert.equal((await fs.readdir(target)).length, 0);
});

test('中文文件夹创建、选择及路径校验，不能自动创建丢失的 NAS 根目录', async t => {
  const { target, root } = await fixture(t);
  const created = await createFolder(target, '202610 · 国庆旅行');
  assert.equal((await listFolders(target)).folders[0].path, created.path);
  await assert.rejects(createFolder(target, '../越界'));
  await assert.rejects(createFolder(target, '/绝对路径'));
  await assert.rejects(createFolder(target, '.隐藏'));
  await assert.rejects(createFolder(target, '202610 · 国庆旅行'), /已存在/);
  await assert.rejects(createFolder(path.join(root, 'missing'), 'child'));
  await assert.rejects(fs.stat(path.join(root, 'missing')));
  assert.throws(() => absolutePath('relative/path'));
});

test('预览遵循方向且缩小，原文件不变；坏照片不影响保存原图', async t => {
  const { source, target, image } = await fixture(t);
  const oriented = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#ffffff' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await fs.writeFile(path.join(source, 'portrait.JPG'), oriented);
  const library = new PhotoLibrary(); const { photos } = await library.scan(source);
  const preview = await library.preview(photos.find(p => p.name === 'portrait.JPG').id, 'thumb');
  const info = await sharp(preview).metadata();
  assert.equal(info.height, 240); assert.equal(info.width, 80);
  assert.deepEqual(await fs.readFile(path.join(source, 'DSC_2.JPG')), image);
  await fs.writeFile(path.join(source, 'broken.JPG'), 'not an image');
  const broken = (await library.scan(source)).photos.find(p => p.name === 'broken.JPG');
  await assert.rejects(library.preview(broken.id, 'preview'));
  const saved = await library.save(broken.id, target);
  assert.equal(await fs.readFile(saved.path, 'utf8'), 'not an image');
});

test('剪贴板图片为完整尺寸的 PNG，遵循 EXIF 方向且与预览缓存独立', async t => {
  const { source } = await fixture(t);
  const original = await sharp({ create: { width: 2600, height: 1300, channels: 3, background: '#84ae48' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const file = path.join(source, 'portrait.JPG');
  await fs.writeFile(file, original);
  const library = new PhotoLibrary();
  const { photos } = await library.scan(source);
  const photo = photos.find(p => p.name === 'portrait.JPG');
  const preview = await sharp(await library.preview(photo.id, 'preview')).metadata();
  assert.equal(preview.format, 'jpeg'); assert.equal(preview.height, 2200);
  const [first, second] = await Promise.all([library.preview(photo.id, 'clipboard'), library.preview(photo.id, 'clipboard')]);
  const copied = await sharp(first).metadata();
  assert.equal(copied.format, 'png'); assert.equal(copied.width, 1300); assert.equal(copied.height, 2600);
  assert.equal(first, second);
  assert.deepEqual(await fs.readFile(file), original);
});

test('剪贴板 PNG 保留透明度和像素内容', async t => {
  const { source } = await fixture(t);
  const original = await sharp({ create: { width: 32, height: 48, channels: 4, background: { r: 50, g: 100, b: 150, alpha: 0.5 } } }).png().toBuffer();
  await fs.writeFile(path.join(source, 'transparent.png'), original);
  const library = new PhotoLibrary();
  const { photos } = await library.scan(source);
  const copied = await library.preview(photos.find(p => p.name === 'transparent.png').id, 'clipboard');
  assert.equal((await sharp(copied).metadata()).hasAlpha, true);
  assert.deepEqual(await sharp(copied).raw().toBuffer(), await sharp(original).raw().toBuffer());
});

test('HTTP 完整流程与跨站防护；目录配置可恢复', async t => {
  const { root, source, target, image } = await fixture(t);
  const dataDir = path.join(root, 'settings');
  const { server } = await createApp({ dataDir, sourcePath: source, destinationRoot: target });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, headers = {}) => fetch(`${origin}${route}`, { ...(body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } } : { headers }) });
  assert.equal((await request('/')).status, 200);
  const config = await (await request('/api/config')).json();
  const token = { 'X-Photo-Token': config.csrfToken };
  assert.equal((await request('/api/photos', { path: source })).status, 403);
  assert.equal((await request('/api/photos', { path: source }, { ...token, Origin: 'https://evil.example' })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(`${origin}/api/config`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await request('/api/photos', { path: source }, { ...token, 'Content-Type': 'text/plain' })).status, 415);
  const photos = await (await request('/api/photos', { path: source }, token)).json();
  const folder = await (await request('/api/folders', { parent: target, name: '测试归档' }, token)).json();
  assert.equal((await request('/api/settings', { targetPath: folder.path }, token)).status, 200);
  const previewResponse = await request(`/api/photo/${photos.photos[0].id}?size=thumb`);
  assert.equal(previewResponse.status, 200); assert.equal(previewResponse.headers.get('Content-Type'), 'image/jpeg');
  const clipboardResponse = await request(`/api/photo/${photos.photos[0].id}?size=clipboard`);
  assert.equal(clipboardResponse.status, 200); assert.equal(clipboardResponse.headers.get('Content-Type'), 'image/png');
  const clipboardImage = await sharp(Buffer.from(await clipboardResponse.arrayBuffer())).metadata();
  assert.equal(clipboardImage.format, 'png'); assert.equal(clipboardImage.width, 48); assert.equal(clipboardImage.height, 32);
  assert.equal((await request(`/api/photo/${'0'.repeat(32)}?size=clipboard`)).status, 404);
  const saved = await (await request('/api/save', { id: photos.photos[0].id }, token)).json();
  assert.deepEqual(await fs.readFile(saved.path), image);
  assert.equal((await request('/api/save', { id: 'invalid' }, token)).status, 404);
  assert.equal((await request('/api/save', { id: photos.photos[0].id, target: path.join(root, 'unmounted') }, token)).status, 404);
  const restored = await createApp({ dataDir, sourcePath: source, destinationRoot: target });
  await new Promise(resolve => restored.server.listen(0, '127.0.0.1', resolve));
  const restoredOrigin = `http://127.0.0.1:${restored.server.address().port}`;
  const restoredConfig = await (await fetch(`${restoredOrigin}/api/config`)).json();
  assert.equal(restoredConfig.targetPath, folder.path);
  await new Promise(resolve => restored.server.close(resolve));
});
