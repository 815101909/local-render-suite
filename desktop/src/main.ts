import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  SUBTITLE_ANIMATION_OPTIONS,
  getSubtitleAnimationOption,
  type SubtitleAnimationOption,
} from './subtitle-animations';
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
  progress?: PipelineProgressPayload | null;
}

interface PipelineResult {
  task: TaskRecord;
  outputDir: string;
  manifestPath: string;
  composeScriptPath: string;
  note: string;
}

interface PipelineProgressPayload {
  uid: string;
  stage: string;
  message: string;
  currentFile: string;
  currentShotNo: number;
  completedShots: number;
  totalShots: number;
  currentFileDownloadedBytes: number;
  currentFileTotalBytes: number;
  currentFileProgress: number;
  overallCompleted: number;
  overallTotal: number;
  overallProgress: number;
  updatedAt: number;
}

interface ExecutionQueueItem {
  uid: string;
  backendUrl: string;
  outputRoot: string;
  status: string;
  stage: string;
  message: string;
  projectName: string;
  createdAt: number;
  startedAt: number;
  updatedAt: number;
  outputDir: string;
  note: string;
  subtitleAnimationKey: string;
  subtitleAnimationName: string;
  progress: PipelineProgressPayload | null;
  task: TaskRecord | null;
}

interface QueueStats {
  running: number;
  finished: number;
  failed: number;
}

type NoticeTone = 'info' | 'success' | 'error';

const DEFAULT_BACKEND_URL = 'http://tb.8000gp.com:19001';
const TASK_STATUS_POLL_INTERVAL = 1000;
const PIPELINE_PROGRESS_EVENT = 'local-render-progress';
const OUTPUT_ROOT_STORAGE_KEY = 'local-render-suite.output-root';
const EXECUTION_QUEUE_STORAGE_KEY = 'local-render-suite.execution-queue';
const MAX_QUEUE_ITEMS = 18;
const DEFAULT_SUBTITLE_ANIMATION_KEY = 'inherit';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App root not found');
}

app.innerHTML = `
  <div class="shell">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">LOCAL RENDER STATION</p>
        <h1>输入任务 UID，在这台电脑上下载素材并生成剪映草稿</h1>
        <p class="hero-text">
          点击开始后，任务会像下载器一样进入右侧本地任务列表，持续显示下载、裁切、草稿生成等实时进度。
        </p>
      </div>
      <div class="device-panel" id="device-panel">正在读取本机身份...</div>
    </section>

    <main class="content-grid">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>执行面板</h2>
            <p>输入任务 UID 后即可在当前电脑下载素材并生成剪映草稿。</p>
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

          <label class="field">
            <span>字幕入场动画（本地覆盖）</span>
            <select id="subtitle-animation"></select>
            <small id="subtitle-animation-help" class="field-help">
              默认跟随后端蓝图；改动只在当前桌面端任务生效，不回写服务端。
            </small>
          </label>
        </div>

        <div class="action-row">
          <button id="load-task-btn" class="ghost-btn" type="button">读取任务</button>
          <button id="run-task-btn" class="primary-btn" type="button">开始本地执行</button>
          <button id="pick-output-btn" class="ghost-btn" type="button">选择输出目录</button>
          <button id="open-output-btn" class="ghost-btn" type="button">打开输出目录</button>
        </div>

        <div id="notice-bar" class="notice-bar notice-bar-info">
          开始本地执行后，任务会自动加入右侧列表，你可以随时切换查看各自进度。
        </div>

        <div id="result-card" class="result-card">
          <div class="empty-tip">选择一个任务后，这里会显示实时进度概览</div>
        </div>

        <div class="result-card execution-log-panel">
          <div class="panel-subhead">
            <strong>执行日志</strong>
            <span id="execution-log-status">同步展示任务状态日志与实时进度</span>
          </div>
          <div id="execution-log-card" class="log-box embedded-log-box">
            <div class="empty-tip">开始本地执行后，这里的日志会自动刷新</div>
          </div>
        </div>
      </section>

      <div class="side-stack">
        <section class="panel queue-panel">
          <div class="panel-head">
            <div>
              <h2>本地任务列表</h2>
              <p>开始执行后自动入列，像下载器一样持续追踪每个任务。</p>
            </div>
            <div id="queue-summary" class="queue-summary">等待加入任务</div>
          </div>
          <div id="execution-queue-card" class="execution-queue-card">
            <div class="empty-tip">点击“开始本地执行”后，任务会出现在这里</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>任务详情</h2>
              <p>点击右侧任务项后，这里会切换到对应任务的详情和原始信息。</p>
            </div>
          </div>
          <div id="task-card" class="task-card">
            <div class="empty-tip">先读取任务，或从右侧本地任务列表里选择一个任务</div>
          </div>
        </section>
      </div>
    </main>
  </div>
`;

const devicePanel = document.querySelector<HTMLDivElement>('#device-panel');
const backendUrlInput = document.querySelector<HTMLInputElement>('#backend-url');
const taskUidInput = document.querySelector<HTMLInputElement>('#task-uid');
const outputRootInput = document.querySelector<HTMLInputElement>('#output-root');
const subtitleAnimationSelect = document.querySelector<HTMLSelectElement>('#subtitle-animation');
const subtitleAnimationHelp = document.querySelector<HTMLParagraphElement>('#subtitle-animation-help');
const pickOutputBtn = document.querySelector<HTMLButtonElement>('#pick-output-btn');
const loadTaskBtn = document.querySelector<HTMLButtonElement>('#load-task-btn');
const runTaskBtn = document.querySelector<HTMLButtonElement>('#run-task-btn');
const openOutputBtn = document.querySelector<HTMLButtonElement>('#open-output-btn');
const noticeBar = document.querySelector<HTMLDivElement>('#notice-bar');
const resultCard = document.querySelector<HTMLDivElement>('#result-card');
const executionLogStatus = document.querySelector<HTMLSpanElement>('#execution-log-status');
const executionLogCard = document.querySelector<HTMLDivElement>('#execution-log-card');
const queueSummary = document.querySelector<HTMLDivElement>('#queue-summary');
const executionQueueCard = document.querySelector<HTMLDivElement>('#execution-queue-card');
const taskCard = document.querySelector<HTMLDivElement>('#task-card');

let deviceIdentity: DeviceIdentity | null = null;
let currentTask: TaskRecord | null = null;
let currentPipelineProgress: PipelineProgressPayload | null = null;
let latestOutputDir = '';
let taskStatusPollTimer: ReturnType<typeof window.setTimeout> | null = null;
let taskStatusPolling = false;
let previewTaskPollingEnabled = false;
let selectedExecutionUid = '';
let unlistenPipelineProgress: UnlistenFn | null = null;

let executionQueue: ExecutionQueueItem[] = [];
const activeExecutionRuns = new Set<string>();
const runtimeLogLinesByUid = new Map<string, string[]>();
const lastRuntimeLogKeyByUid = new Map<string, string>();

function formatTime(value: number) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function escapeHtml(text: string) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function getBackendUrl() {
  return String(backendUrlInput?.value || '').trim().replace(/\/+$/g, '');
}

function getTaskUid() {
  return String(taskUidInput?.value || '').trim().toUpperCase();
}

function getOutputRootValue() {
  return String(outputRootInput?.value || '').trim();
}

function getSubtitleAnimationLabel(option: SubtitleAnimationOption, includeVipTag = false) {
  if (includeVipTag && option.isVip) {
    return `${option.name} · 会员效果`;
  }
  return option.name;
}

function renderSubtitleAnimationHelp(option = getSubtitleAnimationOption(DEFAULT_SUBTITLE_ANIMATION_KEY)) {
  if (!subtitleAnimationHelp) return;

  if (option.key === 'inherit') {
    subtitleAnimationHelp.textContent = '默认跟随后端蓝图；改动只在当前桌面端任务生效，不回写服务端。';
    return;
  }

  if (option.key === 'none') {
    subtitleAnimationHelp.textContent = '本地写草稿时会移除字幕入场动画；只对当前桌面端任务生效，不回写服务端。';
    return;
  }

  subtitleAnimationHelp.textContent = `${option.name}${option.isVip ? '（会员效果）' : ''} 会在本地写草稿时覆盖字幕入场动画，不回写服务端。`;
}

function renderSubtitleAnimationOptions() {
  if (!subtitleAnimationSelect) return;

  subtitleAnimationSelect.innerHTML = SUBTITLE_ANIMATION_OPTIONS.map(option => `
    <option value="${escapeHtml(option.key)}">${escapeHtml(getSubtitleAnimationLabel(option, true))}</option>
  `).join('');
}

function getSelectedSubtitleAnimationKey() {
  return String(subtitleAnimationSelect?.value || '').trim() || DEFAULT_SUBTITLE_ANIMATION_KEY;
}

function getSelectedSubtitleAnimationOption() {
  return getSubtitleAnimationOption(getSelectedSubtitleAnimationKey());
}

function applySubtitleAnimationToForm(key?: string | null) {
  const option = getSubtitleAnimationOption(key);
  if (subtitleAnimationSelect) {
    subtitleAnimationSelect.value = option.key;
  }
  renderSubtitleAnimationHelp(option);
}

function getExecutionItemSubtitleAnimation(item?: Pick<ExecutionQueueItem, 'subtitleAnimationKey' | 'subtitleAnimationName'> | null) {
  if (!item) {
    return getSelectedSubtitleAnimationOption();
  }

  const option = getSubtitleAnimationOption(item.subtitleAnimationKey);
  if (item.subtitleAnimationKey && option.key === item.subtitleAnimationKey) {
    return option;
  }

  if (item.subtitleAnimationName) {
    return {
      key: item.subtitleAnimationKey || DEFAULT_SUBTITLE_ANIMATION_KEY,
      name: item.subtitleAnimationName,
      effectId: '',
      resourceId: '',
      defaultDurationUs: 0,
      isVip: false,
    } as SubtitleAnimationOption;
  }

  return option;
}

function getStageLabel(stage: string) {
  const normalized = String(stage || '').trim();
  if (normalized === 'queued') return '等待启动';
  if (normalized === 'loaded') return '任务已加载';
  if (normalized === 'claiming') return '正在认领';
  if (normalized === 'preparing') return '准备目录';
  if (normalized === 'downloading') return '下载素材';
  if (normalized === 'building_draft') return '生成草稿';
  if (normalized === 'writing_manifest') return '生成清单';
  if (normalized === 'prepared') return '草稿就绪';
  if (normalized === 'completed') return '已完成';
  if (normalized === 'failed') return '失败';
  return normalized || '执行中';
}

function isTerminalStage(stage: string) {
  const normalized = String(stage || '').trim();
  return normalized === 'prepared' || normalized === 'completed' || normalized === 'failed';
}

function inferStagePercent(stage: string, fallback = 0) {
  const normalized = String(stage || '').trim();
  if (normalized === 'queued' || normalized === 'loaded') return Math.max(fallback, 2);
  if (normalized === 'claiming') return Math.max(fallback, 8);
  if (normalized === 'preparing') return Math.max(fallback, 16);
  if (normalized === 'downloading') return Math.max(fallback, 28);
  if (normalized === 'building_draft') return Math.max(fallback, 84);
  if (normalized === 'prepared' || normalized === 'completed') return 100;
  if (normalized === 'failed') return fallback;
  return fallback;
}

function normalizePipelineProgress(raw: Partial<PipelineProgressPayload> | null | undefined) {
  if (!raw || typeof raw !== 'object') return null;
  const uid = String(raw.uid || '').trim().toUpperCase();
  const stage = String(raw.stage || '').trim();
  if (!uid || !stage) return null;

  return {
    uid,
    stage,
    message: String(raw.message || ''),
    currentFile: String(raw.currentFile || ''),
    currentShotNo: Number(raw.currentShotNo || 0) || 0,
    completedShots: Number(raw.completedShots || 0) || 0,
    totalShots: Number(raw.totalShots || 0) || 0,
    currentFileDownloadedBytes: Number(raw.currentFileDownloadedBytes || 0) || 0,
    currentFileTotalBytes: Number(raw.currentFileTotalBytes || 0) || 0,
    currentFileProgress: Number(raw.currentFileProgress || 0) || 0,
    overallCompleted: Number(raw.overallCompleted || 0) || 0,
    overallTotal: Number(raw.overallTotal || 0) || 0,
    overallProgress: Number(raw.overallProgress || 0) || 0,
    updatedAt: Number(raw.updatedAt || 0) || 0,
  };
}

function createSyntheticProgress(
  uid: string,
  stage: string,
  message: string,
  base?: PipelineProgressPayload | null,
) {
  const overallTotal = Math.max(Number(base?.overallTotal || 0), Number(base?.overallCompleted || 0));
  const overallProgress = inferStagePercent(stage, Number(base?.overallProgress || 0));

  return {
    uid,
    stage,
    message,
    currentFile: String(base?.currentFile || ''),
    currentShotNo: Number(base?.currentShotNo || 0) || 0,
    completedShots: Number(base?.completedShots || 0) || 0,
    totalShots: Number(base?.totalShots || 0) || 0,
    currentFileDownloadedBytes: Number(base?.currentFileDownloadedBytes || 0) || 0,
    currentFileTotalBytes: Number(base?.currentFileTotalBytes || 0) || 0,
    currentFileProgress: Number(base?.currentFileProgress || 0) || 0,
    overallCompleted: stage === 'prepared' || stage === 'completed'
      ? Math.max(overallTotal, Number(base?.overallCompleted || 0))
      : Number(base?.overallCompleted || 0) || 0,
    overallTotal,
    overallProgress,
    updatedAt: Date.now(),
  } as PipelineProgressPayload;
}

function shouldApplyPipelineProgress(current: PipelineProgressPayload | null, next: PipelineProgressPayload | null) {
  if (!next) return false;
  if (!current) return true;
  const nextUpdatedAt = Number(next.updatedAt || 0);
  const currentUpdatedAt = Number(current.updatedAt || 0);
  if (nextUpdatedAt && currentUpdatedAt) {
    return nextUpdatedAt >= currentUpdatedAt;
  }
  if (Number(next.overallCompleted || 0) !== Number(current.overallCompleted || 0)) {
    return Number(next.overallCompleted || 0) >= Number(current.overallCompleted || 0);
  }
  if (Number(next.overallProgress || 0) !== Number(current.overallProgress || 0)) {
    return Number(next.overallProgress || 0) >= Number(current.overallProgress || 0);
  }
  if (String(next.stage || '') !== String(current.stage || '')) {
    return true;
  }
  return true;
}

function readSavedOutputRoot() {
  try {
    return String(window.localStorage.getItem(OUTPUT_ROOT_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function saveOutputRoot(value: string) {
  const normalized = String(value || '').trim();
  try {
    if (!normalized) {
      window.localStorage.removeItem(OUTPUT_ROOT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(OUTPUT_ROOT_STORAGE_KEY, normalized);
  } catch {
    // ignore
  }
}

function restoreSavedOutputRoot() {
  if (!outputRootInput) return;
  const savedOutputRoot = readSavedOutputRoot();
  if (savedOutputRoot) {
    outputRootInput.value = savedOutputRoot;
  }
}

function normalizeExecutionQueueItem(raw: Partial<ExecutionQueueItem> | null | undefined) {
  if (!raw || typeof raw !== 'object') return null;
  const uid = String(raw.uid || '').trim().toUpperCase();
  if (!uid) return null;

  const progress = normalizePipelineProgress(raw.progress || null);
  const subtitleAnimation = getSubtitleAnimationOption(
    String(raw.subtitleAnimationKey || '').trim() || DEFAULT_SUBTITLE_ANIMATION_KEY,
  );
  return {
    uid,
    backendUrl: String(raw.backendUrl || DEFAULT_BACKEND_URL).trim().replace(/\/+$/g, ''),
    outputRoot: String(raw.outputRoot || '').trim(),
    status: String(raw.status || progress?.stage || 'queued').trim(),
    stage: String(raw.stage || progress?.stage || 'queued').trim(),
    message: String(raw.message || progress?.message || '已加入本地任务列表').trim(),
    projectName: String(raw.projectName || '').trim(),
    createdAt: Number(raw.createdAt || 0) || Date.now(),
    startedAt: Number(raw.startedAt || 0) || Date.now(),
    updatedAt: Number(raw.updatedAt || progress?.updatedAt || 0) || Date.now(),
    outputDir: String(raw.outputDir || '').trim(),
    note: String(raw.note || '').trim(),
    subtitleAnimationKey: subtitleAnimation.key,
    subtitleAnimationName: String(raw.subtitleAnimationName || subtitleAnimation.name).trim() || subtitleAnimation.name,
    progress,
    task: null,
  } as ExecutionQueueItem;
}

function readSavedExecutionQueue() {
  try {
    const raw = window.localStorage.getItem(EXECUTION_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => normalizeExecutionQueueItem(item))
      .filter((item): item is ExecutionQueueItem => !!item);
  } catch {
    return [];
  }
}

function saveExecutionQueue() {
  try {
    const payload = executionQueue.slice(0, MAX_QUEUE_ITEMS).map(item => ({
      uid: item.uid,
      backendUrl: item.backendUrl,
      outputRoot: item.outputRoot,
      status: item.status,
      stage: item.stage,
      message: item.message,
      projectName: item.projectName,
      createdAt: item.createdAt,
      startedAt: item.startedAt,
      updatedAt: item.updatedAt,
      outputDir: item.outputDir,
      note: item.note,
      subtitleAnimationKey: item.subtitleAnimationKey,
      subtitleAnimationName: item.subtitleAnimationName,
      progress: item.progress,
    }));
    window.localStorage.setItem(EXECUTION_QUEUE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function getExecutionSortWeight(item: ExecutionQueueItem) {
  if (activeExecutionRuns.has(item.uid)) return 0;
  if (item.stage === 'queued') return 1;
  if (item.stage === 'failed' || item.status === 'failed') return 2;
  if (isTerminalStage(item.stage)) return 3;
  return 0;
}

function compareExecutionQueueItems(left: ExecutionQueueItem, right: ExecutionQueueItem) {
  const weightDiff = getExecutionSortWeight(left) - getExecutionSortWeight(right);
  if (weightDiff !== 0) return weightDiff;
  return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
}

function getExecutionItem(uid: string) {
  const normalized = String(uid || '').trim().toUpperCase();
  return executionQueue.find(item => item.uid === normalized) || null;
}

function upsertExecutionItem(patch: Partial<ExecutionQueueItem> & Pick<ExecutionQueueItem, 'uid'>) {
  const normalizedUid = String(patch.uid || '').trim().toUpperCase();
  const existing = getExecutionItem(normalizedUid);
  const nextProgress = patch.progress !== undefined ? patch.progress : (existing?.progress || null);
  const nextTask = patch.task !== undefined ? patch.task : (existing?.task || null);
  const subtitleAnimation = getSubtitleAnimationOption(
    String(
      patch.subtitleAnimationKey
      || existing?.subtitleAnimationKey
      || getSelectedSubtitleAnimationKey()
      || DEFAULT_SUBTITLE_ANIMATION_KEY,
    ).trim(),
  );

  const nextItem: ExecutionQueueItem = {
    uid: normalizedUid,
    backendUrl: String(patch.backendUrl || existing?.backendUrl || getBackendUrl() || DEFAULT_BACKEND_URL)
      .trim()
      .replace(/\/+$/g, ''),
    outputRoot: String(patch.outputRoot || existing?.outputRoot || getOutputRootValue() || '').trim(),
    status: String(patch.status || existing?.status || nextProgress?.stage || 'queued').trim(),
    stage: String(patch.stage || existing?.stage || nextProgress?.stage || 'queued').trim(),
    message: String(patch.message || existing?.message || nextProgress?.message || '已加入本地任务列表').trim(),
    projectName: String(patch.projectName || existing?.projectName || nextTask?.project?.name || '').trim(),
    createdAt: Number(patch.createdAt || existing?.createdAt || Date.now()) || Date.now(),
    startedAt: Number(patch.startedAt || existing?.startedAt || Date.now()) || Date.now(),
    updatedAt: Number(patch.updatedAt || nextProgress?.updatedAt || existing?.updatedAt || Date.now()) || Date.now(),
    outputDir: String(patch.outputDir || existing?.outputDir || nextTask?.outputs?.outputDir || '').trim(),
    note: String(patch.note || existing?.note || nextTask?.outputs?.note || '').trim(),
    subtitleAnimationKey: subtitleAnimation.key,
    subtitleAnimationName: String(patch.subtitleAnimationName || existing?.subtitleAnimationName || subtitleAnimation.name).trim()
      || subtitleAnimation.name,
    progress: nextProgress,
    task: nextTask,
  };

  if (nextTask) {
    nextItem.projectName = nextTask.project?.name || nextItem.projectName;
    nextItem.status = String(nextTask.status || nextItem.status).trim();
    nextItem.outputDir = String(nextTask.outputs?.outputDir || nextItem.outputDir).trim();
    nextItem.note = String(nextTask.outputs?.note || nextItem.note).trim();
    nextItem.updatedAt = Math.max(nextItem.updatedAt, Number(nextTask.updatedAt || 0));
  }

  if (nextItem.progress) {
    nextItem.stage = String(nextItem.progress.stage || nextItem.stage).trim();
    nextItem.message = String(nextItem.progress.message || nextItem.message).trim();
    nextItem.updatedAt = Math.max(nextItem.updatedAt, Number(nextItem.progress.updatedAt || 0));
  }

  executionQueue = [
    nextItem,
    ...executionQueue.filter(item => item.uid !== normalizedUid),
  ].sort(compareExecutionQueueItems).slice(0, MAX_QUEUE_ITEMS);

  saveExecutionQueue();
  renderExecutionQueue();
  return nextItem;
}

function getQueueStats(): QueueStats {
  return executionQueue.reduce<QueueStats>((stats, item) => {
    if (item.stage === 'failed' || item.status === 'failed') {
      stats.failed += 1;
      return stats;
    }
    if (isTerminalStage(item.stage)) {
      stats.finished += 1;
      return stats;
    }
    stats.running += 1;
    return stats;
  }, { running: 0, finished: 0, failed: 0 });
}

function getExecutionItemLabel(item: ExecutionQueueItem) {
  if (item.stage === 'failed' || item.status === 'failed') return '失败';
  if (item.stage === 'prepared') return '草稿就绪';
  if (item.stage === 'completed') return '已完成';
  if (item.stage === 'queued') return '队列中';
  return getStageLabel(item.stage || item.status);
}

function getExecutionItemTone(item: ExecutionQueueItem) {
  if (item.stage === 'failed' || item.status === 'failed') return 'failed';
  if (item.stage === 'prepared' || item.stage === 'completed') return 'done';
  if (item.stage === 'queued') return 'queued';
  return 'running';
}

function shouldKeepPolling() {
  if (executionQueue.some(item => !isTerminalStage(item.stage))) return true;
  if (previewTaskPollingEnabled && getBackendUrl() && getTaskUid()) return true;
  return false;
}

function getSelectedExecutionItem() {
  return getExecutionItem(selectedExecutionUid);
}

function appendRuntimeLog(uid: string, status: string, message: string) {
  const normalizedUid = String(uid || '').trim().toUpperCase();
  if (!normalizedUid) return;
  const nextLines = [ ...(runtimeLogLinesByUid.get(normalizedUid) || []) ];
  nextLines.push(`[${formatTime(Date.now())}] [${status}] ${message}`);
  runtimeLogLinesByUid.set(normalizedUid, nextLines.slice(-240));
}

function resetRuntimeLogs(uid: string) {
  const normalizedUid = String(uid || '').trim().toUpperCase();
  if (!normalizedUid) return;
  runtimeLogLinesByUid.set(normalizedUid, []);
  lastRuntimeLogKeyByUid.delete(normalizedUid);
}

function recordPipelineProgressLog(progress: PipelineProgressPayload) {
  const uid = String(progress.uid || '').trim().toUpperCase();
  if (!uid) return;

  const stage = String(progress.stage || '').trim();
  const stageLabel = getStageLabel(stage);
  const currentPercent = Math.max(0, Math.min(100, Number(progress.currentFileProgress || 0)));
  const percentBucket = Math.min(100, Math.floor(currentPercent / 5) * 5);
  const shotSummary = `${progress.completedShots || 0}/${progress.totalShots || 0}`;
  const resourceSummary = `${progress.overallCompleted || 0}/${progress.overallTotal || 0}`;
  const fileSummary = progress.currentFile
    ? `${progress.currentFile} · ${formatBytes(progress.currentFileDownloadedBytes)}`
      + (progress.currentFileTotalBytes ? ` / ${formatBytes(progress.currentFileTotalBytes)}` : '')
      + (stage === 'downloading' ? ` · ${currentPercent.toFixed(1)}%` : '')
    : '';
  const detail = [
    progress.message || stageLabel,
    `镜头 ${shotSummary}`,
    `资源 ${resourceSummary}`,
    progress.currentShotNo ? `当前第 ${progress.currentShotNo} 镜` : '',
    fileSummary,
  ].filter(Boolean).join(' | ');
  const dedupeKey = stage === 'downloading'
    ? [uid, stage, progress.currentFile, progress.currentShotNo, percentBucket, progress.overallCompleted, progress.completedShots].join('|')
    : [uid, stage, progress.message, progress.currentFile, progress.currentShotNo, progress.overallCompleted, progress.completedShots].join('|');

  if (dedupeKey === lastRuntimeLogKeyByUid.get(uid)) return;

  lastRuntimeLogKeyByUid.set(uid, dedupeKey);
  appendRuntimeLog(uid, stage, detail);
}

function renderNotice(message: string, tone: NoticeTone = 'info') {
  if (!noticeBar) return;
  noticeBar.className = `notice-bar notice-bar-${tone}`;
  noticeBar.textContent = message;
}

function renderExecutionLogStatus(progress: PipelineProgressPayload | null, item?: ExecutionQueueItem | null) {
  if (!executionLogStatus) return;
  if (progress) {
    const stageLabel = getStageLabel(progress.stage);
    if (progress.totalShots > 0) {
      executionLogStatus.textContent = `${stageLabel}（${progress.completedShots || 0}/${progress.totalShots}）`;
      return;
    }
    executionLogStatus.textContent = stageLabel;
    return;
  }
  if (item) {
    executionLogStatus.textContent = getExecutionItemLabel(item);
    return;
  }
  executionLogStatus.textContent = '同步展示任务状态日志与实时进度';
}

function renderExecutionLogs(task: TaskRecord | null, item?: ExecutionQueueItem | null) {
  if (!executionLogCard) return;
  const uid = String(item?.uid || task?.uid || '').trim().toUpperCase();
  const taskLogs = Array.isArray(task?.logs) ? task.logs : [];
  const taskLines = taskLogs.map(logItem => `[${formatTime(logItem.time)}] [${logItem.status}] ${logItem.message}`);
  const runtimeLines = uid ? (runtimeLogLinesByUid.get(uid) || []) : [];
  const allLines = [ ...taskLines, ...runtimeLines ];

  renderExecutionLogStatus(item?.progress || currentPipelineProgress, item);

  if (!allLines.length) {
    executionLogCard.innerHTML = '<div class="empty-tip">开始本地执行后，这里的日志会自动刷新</div>';
    return;
  }

  executionLogCard.textContent = allLines.join('\n');
  if (runtimeLines.length) {
    executionLogCard.scrollTop = executionLogCard.scrollHeight;
  }
}

function buildStageTrack(stage: string) {
  const steps = [
    { key: 'queued', label: '入列' },
    { key: 'claiming', label: '认领' },
    { key: 'preparing', label: '蓝图' },
    { key: 'downloading', label: '下载' },
    { key: 'building_draft', label: '草稿' },
    { key: 'prepared', label: '就绪' },
  ];

  const stageOrder = new Map(steps.map((item, index) => [item.key, index]));
  let currentIndex = stageOrder.get(stage) ?? 0;
  if (stage === 'loaded') currentIndex = 0;
  if (stage === 'completed' || stage === 'failed') currentIndex = steps.length - 1;

  return steps.map((item, index) => {
    const state = stage === 'failed' && index === steps.length - 1
      ? 'failed'
      : index < currentIndex
        ? 'done'
        : index === currentIndex
          ? 'active'
          : 'todo';
    return { ...item, state };
  });
}

function renderPipelineProgress(
  progress: PipelineProgressPayload | null,
  item?: ExecutionQueueItem | null,
  task?: TaskRecord | null,
) {
  if (!resultCard) return;

  const effectiveTask = task || item?.task || currentTask;
  const effectiveItem = item || getSelectedExecutionItem();
  const effectiveProgress = progress
    || effectiveItem?.progress
    || normalizePipelineProgress(effectiveTask?.progress || null)
    || (effectiveTask ? createSyntheticProgress(
      effectiveTask.uid,
      String(effectiveTask.status || 'loaded'),
      String(effectiveTask.message || '任务已加载'),
    ) : null);

  if (!effectiveProgress) {
    renderExecutionLogStatus(null, effectiveItem || null);
    resultCard.innerHTML = '<div class="empty-tip">选择一个任务后，这里会显示实时进度概览</div>';
    return;
  }

  const stageLabel = getStageLabel(effectiveProgress.stage);
  const currentPercent = Math.max(0, Math.min(100, Number(effectiveProgress.currentFileProgress || 0)));
  const overallPercent = Math.max(0, Math.min(100, Number(
    effectiveProgress.overallProgress || inferStagePercent(effectiveProgress.stage, 0),
  )));
  const shotPercent = effectiveProgress.totalShots
    ? Math.max(0, Math.min(100, Number(effectiveProgress.completedShots || 0) / Number(effectiveProgress.totalShots) * 100))
    : inferStagePercent(effectiveProgress.stage, 0);
  const currentFileText = effectiveProgress.currentFile
    ? `${escapeHtml(effectiveProgress.currentFile)} · ${formatBytes(effectiveProgress.currentFileDownloadedBytes)}`
      + (effectiveProgress.currentFileTotalBytes ? ` / ${formatBytes(effectiveProgress.currentFileTotalBytes)}` : '')
    : '当前阶段没有具体文件';
  const currentShotText = effectiveProgress.currentShotNo ? `当前镜头：第 ${effectiveProgress.currentShotNo} 镜` : '当前镜头：无';
  const stageTrack = buildStageTrack(effectiveProgress.stage)
    .map(trackItem => `
      <div class="stage-node stage-node-${trackItem.state}">
        <span class="stage-node-dot"></span>
        <span class="stage-node-label">${escapeHtml(trackItem.label)}</span>
      </div>
    `)
    .join('');

  renderExecutionLogStatus(effectiveProgress, effectiveItem || null);
  resultCard.innerHTML = `
    <div class="progress-box">
      <div class="progress-hero">
        <div>
          <div class="progress-hero-label">${effectiveItem ? '选中任务' : '当前任务'}</div>
          <div class="progress-hero-title">${escapeHtml(effectiveTask?.project?.name || effectiveItem?.projectName || effectiveProgress.uid)}</div>
          <div class="progress-hero-subtitle">${escapeHtml(effectiveProgress.uid)}</div>
        </div>
        <div class="hero-percent-ring">
          <strong>${overallPercent.toFixed(0)}%</strong>
          <span>${escapeHtml(stageLabel)}</span>
        </div>
      </div>

      <div class="stage-track">${stageTrack}</div>

      <div class="progress-box-head">
        <strong>实时进度追踪</strong>
        <span>${escapeHtml(stageLabel)}</span>
      </div>
      <div class="progress-message">${escapeHtml(effectiveProgress.message || effectiveItem?.message || '等待更新')}</div>

      <div class="metric-grid">
        <div class="metric-card">
          <span>当前阶段</span>
          <strong>${escapeHtml(stageLabel)}</strong>
          <em>${escapeHtml(effectiveProgress.message || effectiveItem?.message || '等待更新')}</em>
        </div>
        <div class="metric-card">
          <span>镜头进度</span>
          <strong>${effectiveProgress.completedShots || 0} / ${effectiveProgress.totalShots || 0}</strong>
          <em>${shotPercent.toFixed(1)}%</em>
        </div>
        <div class="metric-card">
          <span>资源进度</span>
          <strong>${effectiveProgress.overallCompleted} / ${effectiveProgress.overallTotal || 0}</strong>
          <em>${overallPercent.toFixed(1)}%</em>
        </div>
        <div class="metric-card">
          <span>当前镜头</span>
          <strong>${effectiveProgress.currentShotNo ? `第 ${effectiveProgress.currentShotNo} 镜` : '无'}</strong>
          <em>${escapeHtml(effectiveProgress.currentFile || '当前阶段没有具体文件')}</em>
        </div>
      </div>

      <div class="progress-meta">${currentShotText}</div>
      <div class="progress-label-row">
        <span>镜头完成度</span>
        <span>${shotPercent.toFixed(1)}%</span>
      </div>
      <div class="progress-bar progress-bar-shots">
        <div class="progress-bar-fill progress-bar-fill-shots" style="width: ${shotPercent}%;"></div>
      </div>

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
      <div class="progress-meta">已完成 ${effectiveProgress.overallCompleted} / ${effectiveProgress.overallTotal || 0}</div>
      ${effectiveItem?.outputDir ? `<div class="progress-meta">输出目录：${escapeHtml(effectiveItem.outputDir)}</div>` : ''}
      ${effectiveItem?.note ? `<div class="progress-meta">${escapeHtml(effectiveItem.note)}</div>` : ''}
    </div>
  `;
}

function renderTaskCard(task: TaskRecord | null, item?: ExecutionQueueItem | null) {
  if (!taskCard) return;
  const subtitleAnimation = getExecutionItemSubtitleAnimation(item || null);
  const subtitleAnimationLabel = getSubtitleAnimationLabel(subtitleAnimation, true);

  if (!task && !item) {
    taskCard.innerHTML = '<div class="empty-tip">先读取任务，或从右侧本地任务列表里选择一个任务</div>';
    return;
  }

  if (!task && item) {
    taskCard.innerHTML = `
      <div class="uid-line">
        <span class="uid-chip">${escapeHtml(item.uid)}</span>
        <span class="status-chip status-chip-${getExecutionItemTone(item)}">${escapeHtml(getExecutionItemLabel(item))}</span>
      </div>
      <p><strong>项目：</strong>${escapeHtml(item.projectName || '等待读取任务信息')}</p>
      <p><strong>当前说明：</strong>${escapeHtml(item.message || '-')}</p>
      <p><strong>开始时间：</strong>${formatTime(item.startedAt)}</p>
      <p><strong>更新时间：</strong>${formatTime(item.updatedAt)}</p>
      <p><strong>字幕入场：</strong>${escapeHtml(subtitleAnimationLabel)}</p>
      <p><strong>输出目录：</strong>${escapeHtml(item.outputDir || item.outputRoot || '-')}</p>
      <p><strong>备注：</strong>${escapeHtml(item.note || '正在等待后端返回更多信息')}</p>
    `;
    return;
  }

  taskCard.innerHTML = `
    <div class="uid-line">
      <span class="uid-chip">${escapeHtml(task!.uid)}</span>
      <span class="status-chip status-chip-${item ? getExecutionItemTone(item) : 'queued'}">${escapeHtml(item ? getExecutionItemLabel(item) : task!.status)}</span>
    </div>
    <p><strong>项目：</strong>${escapeHtml(task!.project?.name || item?.projectName || '-')}</p>
    <p><strong>比例：</strong>${escapeHtml(task!.project?.aspectRatio || '-')}</p>
    <p><strong>镜头数：</strong>${task!.shots?.length || 0}</p>
    <p><strong>当前说明：</strong>${escapeHtml(item?.message || task!.message || '-')}</p>
    <p><strong>认领设备：</strong>${task!.claim ? `${escapeHtml(task!.claim.deviceName)} (${escapeHtml(task!.claim.deviceId)})` : '未认领'}</p>
    <p><strong>创建时间：</strong>${formatTime(task!.createdAt)}</p>
    <p><strong>更新时间：</strong>${formatTime(item?.updatedAt || task!.updatedAt)}</p>
    <p><strong>字幕入场：</strong>${escapeHtml(item ? subtitleAnimationLabel : getSubtitleAnimationLabel(getSelectedSubtitleAnimationOption(), true))}</p>
    <p><strong>输出目录：</strong>${escapeHtml(item?.outputDir || task!.outputs?.outputDir || item?.outputRoot || '-')}</p>
    <details class="debug-details">
      <summary>查看任务原始数据</summary>
      <div class="json-box">${escapeHtml(JSON.stringify(task, null, 2))}</div>
    </details>
  `;
}

function refreshSelectedView() {
  const selectedItem = getSelectedExecutionItem();
  const effectiveTask = selectedItem?.task || currentTask;
  const effectiveProgress = selectedItem?.progress || currentPipelineProgress;

  if (selectedItem) {
    latestOutputDir = selectedItem.outputDir || selectedItem.task?.outputs?.outputDir || latestOutputDir;
    currentTask = effectiveTask || null;
    currentPipelineProgress = effectiveProgress || null;
  }

  renderTaskCard(effectiveTask || null, selectedItem || null);
  renderExecutionLogs(effectiveTask || null, selectedItem || null);
  renderPipelineProgress(effectiveProgress || null, selectedItem || null, effectiveTask || null);
}

function renderExecutionQueue() {
  if (!executionQueueCard || !queueSummary) return;

  const stats = getQueueStats();
  queueSummary.innerHTML = `
    <span>执行中 ${stats.running}</span>
    <span>已完成 ${stats.finished}</span>
    <span>失败 ${stats.failed}</span>
  `;

  if (!executionQueue.length) {
    executionQueueCard.innerHTML = '<div class="empty-tip">点击“开始本地执行”后，任务会出现在这里</div>';
    return;
  }

  executionQueueCard.innerHTML = executionQueue.map(item => {
    const progress = item.progress || createSyntheticProgress(item.uid, item.stage || item.status || 'queued', item.message || '等待启动');
    const selected = item.uid === selectedExecutionUid;
    const overallPercent = Math.max(0, Math.min(100, Number(progress.overallProgress || inferStagePercent(progress.stage, 0))));
    const currentPercent = Math.max(0, Math.min(100, Number(progress.currentFileProgress || 0)));
    const tone = getExecutionItemTone(item);
    const subtitleAnimation = getExecutionItemSubtitleAnimation(item);
    const title = escapeHtml(item.projectName || item.uid);
    const subTitle = escapeHtml(item.uid);
    const summary = escapeHtml(progress.message || item.message || getExecutionItemLabel(item));
    const metaText = escapeHtml(progress.currentFile || item.outputDir || item.outputRoot || '等待新的进度回传');

    return `
      <button class="queue-item queue-item-${tone}${selected ? ' queue-item-active' : ''}" type="button" data-uid="${escapeHtml(item.uid)}">
        <div class="queue-item-head">
          <div class="queue-item-title">
            <strong>${title}</strong>
            <span>${subTitle}</span>
          </div>
          <span class="queue-chip queue-chip-${tone}">${escapeHtml(getExecutionItemLabel(item))}</span>
        </div>
        <div class="queue-item-meta">
          <span>${escapeHtml(getStageLabel(progress.stage || item.stage || item.status))}</span>
          <span>${formatTime(item.updatedAt || item.startedAt || item.createdAt)}</span>
        </div>
        <div class="queue-item-summary">${summary}</div>
        <div class="queue-item-meta">
          <span>字幕入场</span>
          <span>${escapeHtml(getSubtitleAnimationLabel(subtitleAnimation, true))}</span>
        </div>
        <div class="queue-progress-row">
          <span>整体</span>
          <span>${overallPercent.toFixed(1)}%</span>
        </div>
        <div class="queue-progress-bar">
          <div class="queue-progress-fill" style="width: ${overallPercent}%;"></div>
        </div>
        <div class="queue-progress-row queue-progress-row-thin">
          <span>当前文件</span>
          <span>${currentPercent.toFixed(1)}%</span>
        </div>
        <div class="queue-progress-bar queue-progress-bar-thin">
          <div class="queue-progress-fill queue-progress-fill-thin" style="width: ${currentPercent}%;"></div>
        </div>
        <div class="queue-item-footer">
          <span>${metaText}</span>
          <span>${progress.currentShotNo ? `第 ${progress.currentShotNo} 镜` : '等待执行'}</span>
        </div>
      </button>
    `;
  }).join('');
}

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

  if (outputRootInput && !outputRootInput.value) {
    outputRootInput.value = deviceIdentity.suggestedOutputRoot;
    saveOutputRoot(deviceIdentity.suggestedOutputRoot);
  }
}

function syncQueueItemFromTask(task: TaskRecord, backendUrl: string, outputRoot: string) {
  const uid = String(task.uid || '').trim().toUpperCase();
  if (!uid) return;

  const existing = getExecutionItem(uid);
  const taskProgress = normalizePipelineProgress(task.progress || null);
  const mergedProgress = shouldApplyPipelineProgress(existing?.progress || null, taskProgress)
    ? taskProgress
    : (existing?.progress || null);

  upsertExecutionItem({
    uid,
    backendUrl,
    outputRoot,
    task,
    status: String(task.status || existing?.status || 'loaded'),
    stage: String(mergedProgress?.stage || existing?.stage || task.status || 'loaded'),
    message: String(task.message || mergedProgress?.message || existing?.message || ''),
    progress: mergedProgress || existing?.progress || null,
    projectName: task.project?.name || existing?.projectName || '',
    outputDir: task.outputs?.outputDir || existing?.outputDir || '',
    note: task.outputs?.note || existing?.note || '',
    updatedAt: Math.max(
      Number(task.updatedAt || 0),
      Number(mergedProgress?.updatedAt || 0),
      Number(existing?.updatedAt || 0),
    ),
  });
}

function selectExecution(uid: string) {
  const item = getExecutionItem(uid);
  if (!item) return;

  selectedExecutionUid = item.uid;
  previewTaskPollingEnabled = false;
  currentTask = item.task || currentTask;
  currentPipelineProgress = item.progress || currentPipelineProgress;
  latestOutputDir = item.outputDir || item.task?.outputs?.outputDir || latestOutputDir;

  if (taskUidInput) {
    taskUidInput.value = item.uid;
  }
  if (backendUrlInput) {
    backendUrlInput.value = item.backendUrl;
  }
  if (outputRootInput && item.outputRoot) {
    outputRootInput.value = item.outputRoot;
    saveOutputRoot(item.outputRoot);
  }
  applySubtitleAnimationToForm(item.subtitleAnimationKey);

  renderExecutionQueue();
  refreshSelectedView();
}

async function bindPipelineProgressListener() {
  if (unlistenPipelineProgress) return;

  unlistenPipelineProgress = await getCurrentWindow().listen<PipelineProgressPayload>(PIPELINE_PROGRESS_EVENT, event => {
    const payload = normalizePipelineProgress(event.payload);
    if (!payload) return;

    const existing = getExecutionItem(payload.uid);
    const nextProgress = shouldApplyPipelineProgress(existing?.progress || null, payload)
      ? payload
      : (existing?.progress || payload);

    const nextItem = upsertExecutionItem({
      uid: payload.uid,
      backendUrl: existing?.backendUrl || getBackendUrl() || DEFAULT_BACKEND_URL,
      outputRoot: existing?.outputRoot || getOutputRootValue(),
      status: payload.stage === 'failed' ? 'failed' : (existing?.status || payload.stage),
      stage: payload.stage,
      message: payload.message,
      progress: nextProgress,
      updatedAt: Date.now(),
    });

    recordPipelineProgressLog(nextProgress);

    if (!selectedExecutionUid && getTaskUid() === payload.uid) {
      selectedExecutionUid = payload.uid;
    }

    if (selectedExecutionUid === payload.uid) {
      currentTask = nextItem.task || currentTask;
      currentPipelineProgress = nextProgress;
      refreshSelectedView();
      return;
    }

    if (currentTask?.uid === payload.uid && !selectedExecutionUid) {
      currentPipelineProgress = nextProgress;
      refreshSelectedView();
    }
  });
}

function clearTaskStatusPollTimer() {
  if (taskStatusPollTimer !== null) {
    window.clearTimeout(taskStatusPollTimer);
    taskStatusPollTimer = null;
  }
}

async function pollTaskStatus(options?: { silent?: boolean }) {
  if (taskStatusPolling) return;

  const queueTargets = executionQueue
    .filter(item => !isTerminalStage(item.stage))
    .map(item => ({
      uid: item.uid,
      backendUrl: item.backendUrl,
      outputRoot: item.outputRoot,
    }));

  const previewUid = getTaskUid();
  const previewBackendUrl = getBackendUrl();
  if (
    previewTaskPollingEnabled
    && previewUid
    && previewBackendUrl
    && !queueTargets.some(item => item.uid === previewUid)
  ) {
    queueTargets.push({
      uid: previewUid,
      backendUrl: previewBackendUrl,
      outputRoot: getOutputRootValue(),
    });
  }

  if (!queueTargets.length) {
    clearTaskStatusPollTimer();
    return;
  }

  taskStatusPolling = true;
  try {
    const results = await Promise.allSettled(queueTargets.map(target => invoke<TaskRecord>('fetch_task_summary', {
      backendUrl: target.backendUrl,
      uid: target.uid,
    })));

    results.forEach((result, index) => {
      const target = queueTargets[index];
      if (result.status === 'fulfilled') {
        const task = result.value;
        const normalizedUid = String(task.uid || target.uid).trim().toUpperCase();

        if (getExecutionItem(normalizedUid)) {
          syncQueueItemFromTask(task, target.backendUrl, target.outputRoot);
        }

        if (previewTaskPollingEnabled && normalizedUid === getTaskUid()) {
          currentTask = task;
          currentPipelineProgress = normalizePipelineProgress(task.progress || null)
            || createSyntheticProgress(task.uid, String(task.status || 'loaded'), String(task.message || '任务已加载'));
        }

        if (selectedExecutionUid === normalizedUid) {
          currentTask = task;
        }
        return;
      }

      if (!options?.silent && target.uid === selectedExecutionUid) {
        renderNotice(`任务 ${target.uid} 状态刷新失败：${String(result.reason)}`, 'error');
      }
    });
  } finally {
    taskStatusPolling = false;
    renderExecutionQueue();
    refreshSelectedView();
    clearTaskStatusPollTimer();
    if (shouldKeepPolling()) {
      taskStatusPollTimer = window.setTimeout(() => {
        void pollTaskStatus({ silent: true });
      }, TASK_STATUS_POLL_INTERVAL);
    }
  }
}

function startTaskStatusPolling(options?: { immediate?: boolean; silent?: boolean }) {
  clearTaskStatusPollTimer();
  if (!shouldKeepPolling()) return;
  if (options?.immediate) {
    void pollTaskStatus({ silent: options?.silent });
    return;
  }
  taskStatusPollTimer = window.setTimeout(() => {
    void pollTaskStatus({ silent: options?.silent });
  }, TASK_STATUS_POLL_INTERVAL);
}

async function loadDeviceIdentity() {
  deviceIdentity = await invoke<DeviceIdentity>('get_device_identity');
  renderDevicePanel();
}

async function loadTask() {
  const backendUrl = getBackendUrl();
  const uid = getTaskUid();
  if (!backendUrl) {
    renderNotice('请先填写后端地址', 'error');
    return;
  }
  if (!uid) {
    renderNotice('请先填写 UID', 'error');
    return;
  }

  try {
    const task = await invoke<TaskRecord>('fetch_task_summary', {
      backendUrl,
      uid,
    });

    const existing = getExecutionItem(uid);
    if (existing) {
      syncQueueItemFromTask(task, existing.backendUrl, existing.outputRoot);
      selectExecution(uid);
      renderNotice(`任务 ${uid} 已刷新并切换到列表中的对应项`, 'success');
      startTaskStatusPolling({ silent: true });
      return;
    }

    selectedExecutionUid = '';
    previewTaskPollingEnabled = true;
    currentTask = task;
    currentPipelineProgress = normalizePipelineProgress(task.progress || null)
      || createSyntheticProgress(task.uid, String(task.status || 'loaded'), String(task.message || '任务已加载'));
    latestOutputDir = String(task.outputs?.outputDir || latestOutputDir || '');

    renderExecutionQueue();
    refreshSelectedView();
    renderNotice(`任务 ${uid} 读取成功，已开始自动刷新状态`, 'success');
    startTaskStatusPolling({ silent: true });
  } catch (error) {
    renderNotice(`读取任务失败：${String(error)}`, 'error');
  }
}

async function hydrateExecutionTask(uid: string, backendUrl: string, outputRoot: string) {
  try {
    const task = await invoke<TaskRecord>('fetch_task_summary', {
      backendUrl,
      uid,
    });
    syncQueueItemFromTask(task, backendUrl, outputRoot);
    if (selectedExecutionUid === uid) {
      currentTask = task;
      currentPipelineProgress = getExecutionItem(uid)?.progress
        || normalizePipelineProgress(task.progress || null)
        || createSyntheticProgress(task.uid, String(task.status || 'loaded'), String(task.message || '任务已加载'));
      refreshSelectedView();
    }
  } catch {
    // ignore
  }
}

async function executeQueuedTask(uid: string, backendUrl: string, outputRoot: string) {
  if (activeExecutionRuns.has(uid)) return;

  activeExecutionRuns.add(uid);
  const existing = getExecutionItem(uid);
  const queuedItem = upsertExecutionItem({
    uid,
    backendUrl,
    outputRoot,
    status: existing?.status || 'queued',
    stage: 'queued',
    message: existing?.message || '任务已进入本地执行队列',
    progress: existing?.progress || createSyntheticProgress(uid, 'queued', '任务已进入本地执行队列'),
    subtitleAnimationKey: existing?.subtitleAnimationKey || getSelectedSubtitleAnimationKey(),
    subtitleAnimationName: existing?.subtitleAnimationName || getSelectedSubtitleAnimationOption().name,
    updatedAt: Date.now(),
  });
  renderExecutionQueue();

  try {
    const subtitleAnimation = getExecutionItemSubtitleAnimation(queuedItem);
    const result = await invoke<PipelineResult>('run_local_pipeline', {
      backendUrl,
      uid,
      outputRoot: outputRoot || null,
      subtitleAnimation: subtitleAnimation.key === 'inherit' ? null : subtitleAnimation,
    });

    const completedProgress = normalizePipelineProgress(result.task.progress || null)
      || createSyntheticProgress(uid, 'prepared', result.note || '本地任务已完成', getExecutionItem(uid)?.progress || null);

    const nextItem = upsertExecutionItem({
      uid,
      backendUrl,
      outputRoot,
      task: result.task,
      status: String(result.task.status || 'prepared'),
      stage: completedProgress.stage || 'prepared',
      message: result.note || result.task.message || '本地任务已完成',
      progress: completedProgress,
      outputDir: result.outputDir,
      note: result.note,
      updatedAt: Date.now(),
    });

    appendRuntimeLog(uid, 'prepared', `执行完成，输出目录：${result.outputDir}`);
    currentTask = nextItem.task || currentTask;
    currentPipelineProgress = completedProgress;
    latestOutputDir = result.outputDir || latestOutputDir;

    if (selectedExecutionUid === uid) {
      refreshSelectedView();
    }
    renderNotice(`任务 ${uid} 已完成，本地草稿已经生成`, 'success');
  } catch (error) {
    const failedMessage = String(error);
    const failedProgress = createSyntheticProgress(uid, 'failed', failedMessage, getExecutionItem(uid)?.progress || null);
    upsertExecutionItem({
      uid,
      backendUrl,
      outputRoot,
      status: 'failed',
      stage: 'failed',
      message: failedMessage,
      progress: failedProgress,
      updatedAt: Date.now(),
    });
    appendRuntimeLog(uid, 'failed', `本地执行失败：${failedMessage}`);
    if (selectedExecutionUid === uid) {
      currentPipelineProgress = failedProgress;
      refreshSelectedView();
    }
    renderNotice(`任务 ${uid} 执行失败，再点一次开始即可按已完成步骤续跑`, 'error');
  } finally {
    activeExecutionRuns.delete(uid);
    renderExecutionQueue();
    startTaskStatusPolling({ silent: true });
  }
}

function runTask() {
  const backendUrl = getBackendUrl();
  const uid = getTaskUid();
  const outputRoot = getOutputRootValue();
  const subtitleAnimation = getSelectedSubtitleAnimationOption();
  if (!backendUrl || !uid) {
    renderNotice('请先填写后端地址和任务 UID', 'error');
    return;
  }

  if (activeExecutionRuns.has(uid)) {
    selectExecution(uid);
    renderNotice(`任务 ${uid} 已在本地执行中，已为你切换到对应列表项`, 'info');
    return;
  }

  const existing = getExecutionItem(uid);
  const startMessage = existing?.stage === 'failed'
    ? '重新加入本地执行队列，本次会尽量复用已完成步骤'
    : '已加入本地任务列表，等待桌面端开始执行';

  resetRuntimeLogs(uid);
  appendRuntimeLog(uid, 'queued', startMessage);

  const nextItem = upsertExecutionItem({
    uid,
    backendUrl,
    outputRoot,
    task: existing?.task || (currentTask?.uid === uid ? currentTask : null),
    status: 'queued',
    stage: 'queued',
    message: startMessage,
    progress: createSyntheticProgress(uid, 'queued', startMessage, existing?.progress || currentPipelineProgress),
    projectName: existing?.projectName || currentTask?.project?.name || '',
    outputDir: existing?.outputDir || '',
    note: existing?.note || '',
    subtitleAnimationKey: subtitleAnimation.key,
    subtitleAnimationName: subtitleAnimation.name,
    createdAt: existing?.createdAt || Date.now(),
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });

  selectedExecutionUid = uid;
  previewTaskPollingEnabled = false;
  currentTask = nextItem.task || currentTask;
  currentPipelineProgress = nextItem.progress;
  latestOutputDir = nextItem.outputDir || latestOutputDir;

  renderExecutionQueue();
  refreshSelectedView();
  renderNotice(`任务 ${uid} 已加入本地任务列表，你可以继续添加其他任务`, 'success');
  startTaskStatusPolling({ immediate: true, silent: true });

  void hydrateExecutionTask(uid, backendUrl, outputRoot);
  void executeQueuedTask(uid, backendUrl, outputRoot);
}

async function openOutputDir() {
  const selectedItem = getSelectedExecutionItem();
  const target = selectedItem?.outputDir
    || currentTask?.outputs?.outputDir
    || latestOutputDir
    || getOutputRootValue();

  if (!target) {
    renderNotice('还没有可打开的输出目录', 'error');
    return;
  }

  try {
    await invoke('open_in_explorer', { path: target });
    renderNotice('已打开输出目录', 'success');
  } catch (error) {
    renderNotice(`打开输出目录失败：${String(error)}`, 'error');
  }
}

async function pickOutputDirectory() {
  try {
    const currentPath = getOutputRootValue();
    const nextPath = await invoke<string | null>('pick_output_directory', {
      currentPath: currentPath || null,
    });
    if (!nextPath || !outputRootInput) return;
    outputRootInput.value = nextPath;
    saveOutputRoot(nextPath);
    renderNotice('输出目录已更新', 'success');
  } catch (error) {
    renderNotice(`选择输出目录失败：${String(error)}`, 'error');
  }
}

function restoreSavedExecutionList() {
  executionQueue = readSavedExecutionQueue().sort(compareExecutionQueueItems);
  const firstActiveItem = executionQueue.find(item => !isTerminalStage(item.stage));
  const firstItem = firstActiveItem || executionQueue[0] || null;
  if (firstItem) {
    selectedExecutionUid = firstItem.uid;
    currentTask = firstItem.task || null;
    currentPipelineProgress = firstItem.progress || null;
    latestOutputDir = firstItem.outputDir || '';
  }
  applySubtitleAnimationToForm(firstItem?.subtitleAnimationKey || DEFAULT_SUBTITLE_ANIMATION_KEY);
  renderExecutionQueue();
  refreshSelectedView();
}

loadTaskBtn?.addEventListener('click', () => {
  void loadTask();
});

runTaskBtn?.addEventListener('click', () => {
  runTask();
});

pickOutputBtn?.addEventListener('click', () => {
  void pickOutputDirectory();
});

openOutputBtn?.addEventListener('click', () => {
  void openOutputDir();
});

executionQueueCard?.addEventListener('click', event => {
  const target = event.target as HTMLElement | null;
  const itemNode = target?.closest<HTMLElement>('[data-uid]');
  if (!itemNode?.dataset.uid) return;
  selectExecution(itemNode.dataset.uid);
});

outputRootInput?.addEventListener('input', () => {
  if (!outputRootInput) return;
  saveOutputRoot(outputRootInput.value);
});

subtitleAnimationSelect?.addEventListener('change', () => {
  const subtitleAnimation = getSelectedSubtitleAnimationOption();
  renderSubtitleAnimationHelp(subtitleAnimation);

  const targetUid = selectedExecutionUid || getTaskUid();
  const existing = targetUid ? getExecutionItem(targetUid) : null;
  if (existing) {
    upsertExecutionItem({
      uid: existing.uid,
      subtitleAnimationKey: subtitleAnimation.key,
      subtitleAnimationName: subtitleAnimation.name,
      updatedAt: Date.now(),
    });
  }

  refreshSelectedView();
});

taskUidInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void loadTask();
  }
});

taskUidInput?.addEventListener('input', () => {
  const normalizedUid = getTaskUid();
  if (selectedExecutionUid && normalizedUid === selectedExecutionUid) {
    return;
  }

  previewTaskPollingEnabled = false;
  selectedExecutionUid = '';
  currentTask = null;
  currentPipelineProgress = null;
  const existing = normalizedUid ? getExecutionItem(normalizedUid) : null;
  applySubtitleAnimationToForm(existing?.subtitleAnimationKey || DEFAULT_SUBTITLE_ANIMATION_KEY);
  renderExecutionQueue();
  refreshSelectedView();
});

window.addEventListener('beforeunload', () => {
  clearTaskStatusPollTimer();
  if (unlistenPipelineProgress) {
    unlistenPipelineProgress();
    unlistenPipelineProgress = null;
  }
});

restoreSavedOutputRoot();
renderSubtitleAnimationOptions();
restoreSavedExecutionList();
void bindPipelineProgressListener();
void loadDeviceIdentity();
startTaskStatusPolling({ silent: true });
