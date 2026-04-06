/*
 * @Author: Codex
 * @Date: 2026-04-06 00:00:00
 * @LastEditTime: 2026-04-06 00:00:00
 * @LastEditors: Codex
 * @Description: Local Render Station 桌面端页面逻辑
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import './styles.css';

interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  platform: string;
  suggestedOutputRoot: string;
}

interface TaskClaim {
  deviceId: string;
  deviceName: string;
  claimedAt: number;
}

interface TaskProject {
  name: string;
  aspectRatio: string;
  audioUrl: string;
  coverUrl: string;
  notes: string;
}

interface TaskShot {
  shotNo: number;
  title: string;
  assetType: 'video' | 'image';
  assetUrl: string;
  durationMs: number;
  sourceKind?: 'direct' | 'atlas_crop' | string;
  cropConfig?: {
    scale: number;
    offsetX: number;
    offsetY: number;
    ratio: string;
  };
}

interface TaskOutputs {
  outputDir?: string;
  manifestPath?: string;
  composeScriptPath?: string;
  finalVideoPath?: string;
  note?: string;
}

interface TaskLog {
  time: number;
  status: string;
  message: string;
}

interface TaskRecord {
  uid: string;
  status: string;
  message: string;
  createdAt: number;
  updatedAt: number;
  claim: TaskClaim | null;
  outputs: TaskOutputs | null;
  project: TaskProject;
  shots: TaskShot[];
  logs: TaskLog[];
}

interface PipelineResult {
  task: TaskRecord;
  outputDir: string;
  manifestPath: string;
  composeScriptPath: string;
  finalVideoPath?: string;
  ffmpegExecuted: boolean;
  note: string;
}

interface PipelineProgressPayload {
  uid: string;
  stage: string;
  message: string;
  currentFile: string;
  currentShotNo: number;
  currentFileDownloadedBytes: number;
  currentFileTotalBytes: number;
  currentFileProgress: number;
  overallCompleted: number;
  overallTotal: number;
  overallProgress: number;
}

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8006';
const TASK_STATUS_POLL_INTERVAL = 3000;
const PIPELINE_PROGRESS_EVENT = 'local-render-progress';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App root not found');
}

app.innerHTML = `
  <div class="shell">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">LOCAL RENDER STATION</p>
        <h1>输入任务 UID，在这台电脑上执行下载与合成</h1>
        <p class="hero-text">
          桌面端会先认领任务，再下载素材、生成本地清单和合成脚本；如果本机已安装 ffmpeg，会继续尝试自动生成 final.mp4。
        </p>
      </div>
      <div class="device-panel" id="device-panel">正在读取本机身份...</div>
    </section>

    <main class="content-grid">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>执行面板</h2>
            <p>输入任务 UID 后即可在当前电脑下载素材并本地合成。</p>
          </div>
        </div>

        <div class="field-stack">
          <label class="field">
            <span>后端地址</span>
            <input id="backend-url" type="text" value="${DEFAULT_BACKEND_URL}" />
          </label>

          <div class="inline-grid">
            <label class="field">
              <span>任务 UID</span>
              <input id="task-uid" type="text" placeholder="输入全大写 UID" />
            </label>
            <label class="field">
              <span>输出目录</span>
              <input id="output-root" type="text" placeholder="默认写入 Documents\\LocalRenderTasks，可手动输入或点击选择目录" />
            </label>
          </div>
        </div>

        <div class="action-row">
          <button id="load-task-btn" class="ghost-btn" type="button">读取任务</button>
          <button id="run-task-btn" class="primary-btn" type="button">开始本地执行</button>
          <button id="pick-output-btn" class="ghost-btn" type="button">选择输出目录</button>
          <button id="open-output-btn" class="ghost-btn" type="button">打开输出目录</button>
        </div>

        <div id="result-card" class="result-card">
          <div class="empty-tip">桌面端执行结果会显示在这里</div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>任务详情</h2>
            <p>便于在桌面端确认当前认领状态和素材数量。</p>
          </div>
        </div>
        <div id="task-card" class="task-card">
          <div class="empty-tip">先输入 UID，再读取任务</div>
        </div>
      </section>
    </main>
  </div>
`;

const devicePanel = document.querySelector<HTMLDivElement>('#device-panel');
const backendUrlInput = document.querySelector<HTMLInputElement>('#backend-url');
const taskUidInput = document.querySelector<HTMLInputElement>('#task-uid');
const outputRootInput = document.querySelector<HTMLInputElement>('#output-root');
const pickOutputBtn = document.querySelector<HTMLButtonElement>('#pick-output-btn');
const loadTaskBtn = document.querySelector<HTMLButtonElement>('#load-task-btn');
const runTaskBtn = document.querySelector<HTMLButtonElement>('#run-task-btn');
const openOutputBtn = document.querySelector<HTMLButtonElement>('#open-output-btn');
const resultCard = document.querySelector<HTMLDivElement>('#result-card');
const taskCard = document.querySelector<HTMLDivElement>('#task-card');

let deviceIdentity: DeviceIdentity | null = null;
let currentTask: TaskRecord | null = null;
let latestOutputDir = '';
let taskStatusPollTimer: ReturnType<typeof window.setTimeout> | null = null;
let taskStatusPolling = false;
let currentPipelineProgress: PipelineProgressPayload | null = null;
let unlistenPipelineProgress: UnlistenFn | null = null;

/**
 * 时间格式化
 * @param value 毫秒时间戳
 * @returns 格式化后的时间
 */
function formatTime(value: number) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

/**
 * 安全转义 HTML
 * @param text 原始文本
 * @returns 转义后的字符串
 */
function escapeHtml(text: string) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 字节格式化
 * @param value 字节数
 * @returns 友好的文本
 */
function formatBytes(value: number) {
  const bytes = Number(value || 0);
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let currentValue = bytes;
  let unitIndex = 0;
  while (currentValue >= 1024 && unitIndex < units.length - 1) {
    currentValue /= 1024;
    unitIndex += 1;
  }
  return `${currentValue.toFixed(currentValue >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * 进度阶段文案
 * @param stage 阶段值
 * @returns 展示文案
 */
function getStageLabel(stage: string) {
  const normalized = String(stage || '').trim();
  if (normalized === 'loaded') return '任务已加载';
  if (normalized === 'claiming') return '正在认领';
  if (normalized === 'preparing') return '准备目录';
  if (normalized === 'downloading') return '下载素材';
  if (normalized === 'writing_manifest') return '生成清单';
  if (normalized === 'composing') return '准备合成';
  if (normalized === 'composing_segment') return '镜头合成';
  if (normalized === 'composing_final') return '最终合成';
  if (normalized === 'prepared') return '本地任务已就绪';
  if (normalized === 'completed') return '已完成';
  if (normalized === 'failed') return '失败';
  return normalized || '执行中';
}

/**
 * 当前后端地址
 * @returns 标准化后的地址
 */
function getBackendUrl() {
  return String(backendUrlInput?.value || '').trim().replace(/\/+$/g, '');
}

/**
 * 当前 UID
 * @returns 标准化后的 UID
 */
function getTaskUid() {
  return String(taskUidInput?.value || '').trim().toUpperCase();
}

/**
 * 显示本机信息
 */
function renderDevicePanel() {
  if (!devicePanel) return;
  if (!deviceIdentity) {
    devicePanel.innerHTML = '<div class="empty-tip">本机信息读取失败</div>';
    return;
  }

  devicePanel.innerHTML = `
    <div class="device-label">当前设备</div>
    <div class="device-name">${escapeHtml(deviceIdentity.deviceName)}</div>
    <div class="device-meta">Device ID: <code>${escapeHtml(deviceIdentity.deviceId)}</code></div>
    <div class="device-meta">推荐输出目录：${escapeHtml(deviceIdentity.suggestedOutputRoot)}</div>
  `;

  if (!outputRootInput?.value) {
    outputRootInput!.value = deviceIdentity.suggestedOutputRoot;
  }
}

/**
 * 渲染任务卡片
 * @param task 任务对象
 */
function renderTaskCard(task: TaskRecord | null) {
  if (!taskCard) return;
  if (!task) {
    taskCard.innerHTML = '<div class="empty-tip">先输入 UID，再读取任务</div>';
    return;
  }

  const logs = Array.isArray(task.logs) ? task.logs : [];
  taskCard.innerHTML = `
    <div class="uid-line">
      <span class="uid-chip">${escapeHtml(task.uid)}</span>
      <span class="status-chip">${escapeHtml(task.status)}</span>
    </div>
    <p><strong>项目：</strong>${escapeHtml(task.project?.name || '-')}</p>
    <p><strong>比例：</strong>${escapeHtml(task.project?.aspectRatio || '-')}</p>
    <p><strong>镜头数：</strong>${task.shots?.length || 0}</p>
    <p><strong>当前说明：</strong>${escapeHtml(task.message || '-')}</p>
    <p><strong>认领设备：</strong>${task.claim ? `${escapeHtml(task.claim.deviceName)} (${escapeHtml(task.claim.deviceId)})` : '未认领'}</p>
    <p><strong>创建时间：</strong>${formatTime(task.createdAt)}</p>
    <p><strong>更新时间：</strong>${formatTime(task.updatedAt)}</p>
    <div class="json-box">${escapeHtml(JSON.stringify(task, null, 2))}</div>
    <div class="log-box">${escapeHtml(logs.map(item => `[${formatTime(item.time)}] [${item.status}] ${item.message}`).join('\n') || '暂无日志')}</div>
  `;
}

/**
 * 渲染执行结果
 * @param html 结果 HTML
 */
function renderResult(html: string) {
  if (!resultCard) return;
  resultCard.innerHTML = html;
}

/**
 * 渲染实时进度
 * @param progress 进度对象
 */
function renderPipelineProgress(progress: PipelineProgressPayload | null) {
  if (!progress) {
    renderResult('<div class="empty-tip">桌面端执行结果会显示在这里</div>');
    return;
  }

  const currentPercent = Math.max(0, Math.min(100, Number(progress.currentFileProgress || 0)));
  const overallPercent = Math.max(0, Math.min(100, Number(progress.overallProgress || 0)));
  const currentFileText = progress.currentFile
    ? `${escapeHtml(progress.currentFile)} · ${formatBytes(progress.currentFileDownloadedBytes)}`
      + (progress.currentFileTotalBytes ? ` / ${formatBytes(progress.currentFileTotalBytes)}` : '')
    : '当前阶段没有具体文件';
  const currentShotText = progress.currentShotNo ? `当前镜头：第 ${progress.currentShotNo} 镜` : '当前镜头：无';

  renderResult(`
    <div class="progress-box">
      <div class="progress-box-head">
        <strong>实时进度追踪</strong>
        <span>${escapeHtml(getStageLabel(progress.stage))}</span>
      </div>
      <div class="progress-message">${escapeHtml(progress.message || '')}</div>
      <div class="progress-meta">${currentShotText}</div>
      <div class="progress-label-row">
        <span>当前文件</span>
        <span>${currentPercent.toFixed(1)}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-bar-fill" style="width: ${currentPercent}%;"></div>
      </div>
      <div class="progress-meta">${currentFileText}</div>
      <div class="progress-label-row">
        <span>整体进度</span>
        <span>${overallPercent.toFixed(1)}%</span>
      </div>
      <div class="progress-bar progress-bar-overall">
        <div class="progress-bar-fill" style="width: ${overallPercent}%;"></div>
      </div>
      <div class="progress-meta">已完成 ${progress.overallCompleted} / ${progress.overallTotal || 0}</div>
    </div>
  `);
}

/**
 * 绑定实时进度事件
 */
async function bindPipelineProgressListener() {
  if (unlistenPipelineProgress) return;
  unlistenPipelineProgress = await listen<PipelineProgressPayload>(PIPELINE_PROGRESS_EVENT, event => {
    const payload = event.payload;
    if (!payload) return;
    const activeUid = getTaskUid();
    if (activeUid && String(payload.uid || '').trim().toUpperCase() !== activeUid) {
      return;
    }
    currentPipelineProgress = payload;
    renderPipelineProgress(payload);
  });
}

/**
 * 清理任务状态轮询
 */
function clearTaskStatusPollTimer() {
  if (taskStatusPollTimer !== null) {
    window.clearTimeout(taskStatusPollTimer);
    taskStatusPollTimer = null;
  }
}

/**
 * 是否需要继续轮询
 * @param task 任务对象
 * @returns 是否继续
 */
function shouldKeepPolling(task: TaskRecord | null) {
  if (!task) return false;
  return !!String(task.uid || '').trim();
}

/**
 * 轮询任务状态
 * @param options 配置项
 */
async function pollTaskStatus(options?: { silent?: boolean }) {
  if (taskStatusPolling) return;
  const backendUrl = getBackendUrl();
  const uid = getTaskUid();
  if (!backendUrl || !uid) return;

  taskStatusPolling = true;
  try {
    const task = await invoke<TaskRecord>('fetch_task_summary', {
      backendUrl,
      uid,
    });
    currentTask = task;
    renderTaskCard(task);
    latestOutputDir = String(task.outputs?.outputDir || latestOutputDir || '');
    if (!options?.silent) {
      renderResult(`<div class="success-tip">已刷新任务状态：${escapeHtml(task.message || task.status)}</div>`);
    }
  } catch (error) {
    if (!options?.silent) {
      renderResult(`<div class="error-tip">${escapeHtml(String(error))}</div>`);
    }
  } finally {
    taskStatusPolling = false;
    clearTaskStatusPollTimer();
    if (shouldKeepPolling(currentTask) && getTaskUid() === String(currentTask?.uid || '').trim().toUpperCase()) {
      taskStatusPollTimer = window.setTimeout(() => {
        void pollTaskStatus({ silent: true });
      }, TASK_STATUS_POLL_INTERVAL);
    }
  }
}

/**
 * 启动任务状态轮询
 * @param options 配置项
 */
function startTaskStatusPolling(options?: { immediate?: boolean; silent?: boolean }) {
  clearTaskStatusPollTimer();
  if (!getTaskUid()) return;
  if (options?.immediate) {
    void pollTaskStatus({ silent: options?.silent });
    return;
  }
  taskStatusPollTimer = window.setTimeout(() => {
    void pollTaskStatus({ silent: options?.silent });
  }, TASK_STATUS_POLL_INTERVAL);
}

/**
 * 载入本机设备信息
 */
async function loadDeviceIdentity() {
  deviceIdentity = await invoke<DeviceIdentity>('get_device_identity');
  renderDevicePanel();
}

/**
 * 读取任务详情
 */
async function loadTask() {
  const backendUrl = getBackendUrl();
  const uid = getTaskUid();
  if (!backendUrl) {
    renderResult('<div class="error-tip">请先填写后端地址</div>');
    return;
  }
  if (!uid) {
    renderResult('<div class="error-tip">请先填写 UID</div>');
    return;
  }
  try {
    currentTask = await invoke<TaskRecord>('fetch_task_summary', {
      backendUrl,
      uid,
    });
    renderTaskCard(currentTask);
    latestOutputDir = String(currentTask.outputs?.outputDir || latestOutputDir || '');
    renderResult('<div class="success-tip">任务详情读取成功，已开启按 UID 自动轮询状态</div>');
    startTaskStatusPolling({ silent: true });
  } catch (error) {
    renderResult(`<div class="error-tip">${escapeHtml(String(error))}</div>`);
  }
}

/**
 * 执行本地任务
 */
async function runTask() {
  const backendUrl = getBackendUrl();
  const uid = getTaskUid();
  const outputRoot = String(outputRootInput?.value || '').trim();
  if (!backendUrl || !uid) {
    renderResult('<div class="error-tip">请先填写后端地址和任务 UID</div>');
    return;
  }

  runTaskBtn!.disabled = true;
  currentPipelineProgress = null;
  renderPipelineProgress(null);
  renderResult('<div class="loading-tip">正在本地执行，请稍候...</div>');

  try {
    const result = await invoke<PipelineResult>('run_local_pipeline', {
      backendUrl,
      uid,
      outputRoot: outputRoot || null,
    });
    currentTask = result.task;
    latestOutputDir = result.outputDir;
    renderTaskCard(currentTask);
    renderResult(`
      <div class="success-tip">
        <div><strong>执行完成</strong></div>
        <div>执行位置：当前桌面端所在本机</div>
        <div>输出目录：${escapeHtml(result.outputDir)}</div>
        <div>清单文件：${escapeHtml(result.manifestPath)}</div>
        <div>脚本文件：${escapeHtml(result.composeScriptPath)}</div>
        <div>自动合成：${result.ffmpegExecuted ? '已执行 ffmpeg' : '未执行 ffmpeg'}</div>
        <div>${escapeHtml(result.note)}</div>
        ${result.finalVideoPath ? `<div>最终成片：${escapeHtml(result.finalVideoPath)}</div>` : ''}
      </div>
    `);
    startTaskStatusPolling({ silent: true });
  } catch (error) {
    renderResult(`<div class="error-tip">${escapeHtml(String(error))}</div>`);
  } finally {
    runTaskBtn!.disabled = false;
  }
}

/**
 * 打开输出目录
 */
async function openOutputDir() {
  const target = latestOutputDir || String(outputRootInput?.value || '').trim();
  if (!target) {
    renderResult('<div class="error-tip">还没有可打开的输出目录</div>');
    return;
  }
  try {
    await invoke('open_in_explorer', { path: target });
  } catch (error) {
    renderResult(`<div class="error-tip">${escapeHtml(String(error))}</div>`);
  }
}

/**
 * 选择输出目录
 */
async function pickOutputDirectory() {
  try {
    const currentPath = String(outputRootInput?.value || '').trim();
    const nextPath = await invoke<string | null>('pick_output_directory', {
      currentPath: currentPath || null,
    });
    if (!nextPath || !outputRootInput) return;
    outputRootInput.value = nextPath;
    renderResult('<div class="success-tip">输出目录已更新</div>');
  } catch (error) {
    renderResult(`<div class="error-tip">${escapeHtml(String(error))}</div>`);
  }
}

loadTaskBtn?.addEventListener('click', () => {
  void loadTask();
});

runTaskBtn?.addEventListener('click', () => {
  void runTask();
});

pickOutputBtn?.addEventListener('click', () => {
  void pickOutputDirectory();
});

openOutputBtn?.addEventListener('click', () => {
  void openOutputDir();
});

taskUidInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void loadTask();
  }
});

taskUidInput?.addEventListener('input', () => {
  clearTaskStatusPollTimer();
  currentTask = null;
  currentPipelineProgress = null;
  renderPipelineProgress(null);
});

window.addEventListener('beforeunload', () => {
  clearTaskStatusPollTimer();
  if (unlistenPipelineProgress) {
    unlistenPipelineProgress();
    unlistenPipelineProgress = null;
  }
});

void bindPipelineProgressListener();
void loadDeviceIdentity();
