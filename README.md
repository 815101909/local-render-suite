# Local Render Station

`local-render-suite` 现在只保留桌面端，用于配合现有项目的“渲染工厂”完成本地草稿生成。

## 它是做什么的

这个桌面端的目标不是在服务器上合成视频，而是：

1. 在现有 Web 的渲染工厂里生成一个任务 UID。
2. 在桌面端输入这个 UID。
3. 桌面端从现有服务端拉取任务详情和草稿蓝图。
4. 桌面端在本机下载素材、裁切 Atlas、生成剪映草稿目录。

当前产物是：

- 一个本地剪映草稿文件夹
- 其中包含 `draft_content.json`
- 其中包含 `draft_meta_info.json`
- 其中包含 `manifest.json`
- 其中包含 `Resources/local/*`

不会再生成：

- `final.mp4`
- ZIP 压缩包

## 当前目录

```text
local-render-suite/
└─ desktop/
```

## 桌面端依赖的现有服务端接口

桌面端直接调用当前项目服务端 `aigc-factory-service`，默认地址：

- `http://127.0.0.1:19001`

会用到这些接口：

- `GET /api/tasks/:uid`
- `POST /api/tasks/:uid/claim`
- `POST /api/tasks/:uid/status`
- `POST /api/tasks/:uid/draft-blueprint`

## 使用流程

1. 启动当前项目服务端 `aigc-factory-service`
2. 在渲染工厂里点击“生成任务UID”
3. 复制任务 UID
4. 打开桌面端
5. 输入任务 UID
6. 选择或手动填写输出目录
7. 点击“读取任务”
8. 点击“开始本地执行”

## 桌面端当前能力

- 支持手动输入服务端地址
- 默认服务端地址为 `http://127.0.0.1:19001`
- 支持手动输入输出目录
- 支持点击按钮选择输出目录
- 支持实时下载进度显示
- 支持显示当前镜头号
- 支持把 Atlas 原图裁成静态镜头图
- 支持生成与服务端一致方向的剪映草稿文件夹

## 运行要求

桌面端本机需要：

- Windows
- Rust / Cargo
- WebView2 Runtime
- Node.js
- `ffmpeg`

说明：

- 桌面端本地裁切静态镜头时会调用 `ffmpeg`
- 如果本机没有 `ffmpeg`，Atlas 裁切和封面转换就无法完成

## 开发运行

```powershell
cd local-render-suite\desktop
npm install
npm run tauri:dev
```

## 构建桌面端

```powershell
cd local-render-suite\desktop
npm run tauri:build
```

构建产物：

- `local-render-suite\desktop\src-tauri\target\release\local-render-suite-desktop.exe`

## 桌面端源码位置

- 前端界面：`desktop/src/main.ts`
- 前端样式：`desktop/src/styles.css`
- Tauri 入口：`desktop/src-tauri/src/main.rs`

## 备注

- 这个目录现在只介绍桌面端，不再包含独立 demo 后端和独立 demo Web。
- 桌面端当前已经对接现有项目服务端，不再依赖 `local-render-suite/server` 或 `local-render-suite/web`。
