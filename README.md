# 照片筛选

本机运行的照片筛选工具，在浏览器中查看相机卡照片，把选中的原图复制到 NAS。原始文件留在相机卡上。

## 启动

需要 Node.js 22 或更新版本。

```sh
npm install
npm start
```

打开 <http://localhost:3000>。macOS 也可双击仓库里的 `启动照片筛选.command`（首次仍需安装依赖）。

## 使用

- 默认照片来源：`/Volumes/NIKON Z5_2 /DCIM`。设备名 `NIKON Z5_2 ` 末尾有一个空格。会递归读取子文件夹并过滤隐藏文件。
- 默认保存位置：`/Volumes/nas/生活/2026`，对应服务器 `192.168.1.66` 的 `nas/生活/2026`。
- 「选择来源」可以在页面中浏览文件夹、输入绝对路径，或使用 macOS 系统目录选择器。
- 用「上一张」「下一张」、方向键或附近缩略图浏览。可全屏查看照片。
- 在右侧进入子文件夹；「更换」可选择其他目录；「新建文件夹」创建后会立即选中。
- 点击「保存原图」或按 `S`，将当前照片复制到选中的文件夹。保存过程中可以浏览其他照片，复制对象和目标仍以点击时为准。
- 保存会校验 SHA-256；内容相同的照片不会重复复制，同名但内容不同的照片会自动加 `_1`、`_2` 等编号，现有文件不会被覆盖。
- 上次使用的来源与目标路径保存在本机 `.data/settings.json`，下次启动恢复。删除该文件即可恢复默认路径。

支持 JPG/JPEG、PNG、WebP、TIFF、HEIC/HEIF、AVIF；具体解码能力取决于本机 Sharp/libvips，无法预览时仍可保存原图。首版不支持 Nikon NEF RAW。原图保存完整保留文件内的 EXIF 等元数据；浏览预览会按 EXIF 方向调整，并缩小到最长边 2200 像素，缩略图为 240 像素。不会把照片上传到外部服务。

## NAS 挂载

在运行工具的这台 Mac 上，通过 Finder →「前往」→「连接服务器」（⌘K）连接：

```text
smb://192.168.1.66/nas
```

登录后确认共享挂载在 `/Volumes/nas`，且 `生活/2026` 目录存在。如果实际挂载路径不同，使用页面的「更换」选择对应目录。

NAS 未挂载或目标目录丢失时，工具不会自动在本机建立假的 NAS 目录。对 `/Volumes/nas` 下的写入会确认它仍是 `192.168.1.66/nas` 的 SMB 挂载。程序仅监听本机 `127.0.0.1`，浏览器和服务应运行在同一台电脑；页面中的路径都是服务端所在电脑的路径。

## 配置与检查

```sh
PORT=3001 npm start
PHOTO_SOURCE='/其他照片路径' PHOTO_DESTINATION='/其他目标路径' npm start
npm run check
npm test
```

`PHOTO_SOURCE`、`PHOTO_DESTINATION` 指定初始默认值，已有本机路径偏好会优先恢复；可删除 `.data/settings.json` 或指定新的 `PHOTO_SELECTOR_DATA_DIR`。测试在系统临时目录中创建图片，不改动相机卡或 NAS 中的照片。

界面为无框架的 HTML/CSS/JavaScript，后端使用 Node.js 内置 HTTP 与文件系统模块；Sharp 生成有界缓存的预览。复制行为使用 Node 的排他写入标志 [COPYFILE_EXCL](https://nodejs.org/api/fs.html#fspromisescopyfilesrc-dest-mode)；预览通过 Sharp 的 [autoOrient](https://sharp.pixelplumbing.com/api-operation/#autoorient) 和 [resize](https://sharp.pixelplumbing.com/api-resize/) 处理。
