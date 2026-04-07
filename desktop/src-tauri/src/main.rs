#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/*
 * @Author: Codex
 * @Date: 2026-04-06 00:00:00
 * @LastEditTime: 2026-04-06 00:00:00
 * @LastEditors: Codex
 * @Description: Local Render Suite 桌面端本地执行入口
 */

use reqwest::{header::ACCEPT_ENCODING, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::env;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, Window};
use tokio::fs;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity {
  device_id: String,
  device_name: String,
  platform: String,
  suggested_output_root: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TaskClaim {
  device_id: String,
  device_name: String,
  claimed_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TaskProject {
  name: String,
  aspect_ratio: String,
  audio_url: String,
  cover_url: String,
  notes: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TaskCropConfig {
  scale: f64,
  offset_x: f64,
  offset_y: f64,
  ratio: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TaskShot {
  shot_no: u32,
  title: String,
  asset_type: String,
  asset_url: String,
  duration_ms: u64,
  source_kind: Option<String>,
  crop_config: Option<TaskCropConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TaskOutputs {
  output_dir: Option<String>,
  manifest_path: Option<String>,
  compose_script_path: Option<String>,
  final_video_path: Option<String>,
  note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TaskLog {
  time: u64,
  status: String,
  message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct TaskRecord {
  uid: String,
  status: String,
  message: String,
  created_at: u64,
  updated_at: u64,
  claim: Option<TaskClaim>,
  outputs: Option<TaskOutputs>,
  project: TaskProject,
  shots: Vec<TaskShot>,
  logs: Vec<TaskLog>,
  progress: Option<PipelineProgressPayload>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct DraftBlueprintResource {
  r#type: String,
  media_type: String,
  shot_no: Option<u32>,
  title: Option<String>,
  source_url: String,
  relative_path: String,
  absolute_path: String,
  ffmpeg_crop_args: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct DraftBlueprint {
  uid: String,
  draft_id: String,
  draft_name: String,
  draft_dir_name: String,
  draft_root_path: String,
  draft_content: Value,
  draft_meta_info: Value,
  manifest: Value,
  readme: String,
  resource_plan: Vec<DraftBlueprintResource>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineResult {
  task: TaskRecord,
  output_dir: String,
  manifest_path: String,
  compose_script_path: String,
  note: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct PipelineProgressPayload {
  uid: String,
  stage: String,
  message: String,
  current_file: String,
  current_shot_no: u32,
  completed_shots: u32,
  total_shots: u32,
  current_file_downloaded_bytes: u64,
  current_file_total_bytes: u64,
  current_file_progress: f64,
  overall_completed: u32,
  overall_total: u32,
  overall_progress: f64,
  updated_at: u64,
}

struct DownloadProgressMeta {
  uid: String,
  stage: String,
  message: String,
  current_file: String,
  current_shot_no: u32,
  completed_shots: u32,
  total_shots: u32,
  overall_completed: u32,
  overall_total: u32,
}

const PIPELINE_PROGRESS_EVENT: &str = "local-render-progress";

#[derive(Default)]
struct PipelineProgressStore {
  entries: Mutex<HashMap<String, PipelineProgressPayload>>,
}

impl PipelineProgressStore {
  /**
   * 保存任务的最新进度
   * @param payload 最新进度对象
   */
  fn save(&self, payload: PipelineProgressPayload) {
    let mut entries = self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.insert(payload.uid.clone(), payload);
  }

  /**
   * 读取任务的最新进度
   * @param uid 任务 UID
   * @return {Option<PipelineProgressPayload>} 最近一次进度
   */
  fn get(&self, uid: &str) -> Option<PipelineProgressPayload> {
    let entries = self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.get(uid).cloned()
  }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusUpdatePayload {
  device_id: String,
  status: String,
  message: String,
  outputs: Option<TaskOutputs>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimPayload {
  device_id: String,
  device_name: String,
}

/**
 * 当前时间戳
 * @return {u64} 毫秒时间戳
 */
fn now_millis() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis() as u64)
    .unwrap_or(0)
}

/**
 * 归一化百分比
 * @param numerator 当前值
 * @param denominator 总值
 * @return {f64} 百分比
 */
fn to_progress_percent(numerator: u64, denominator: u64) -> f64 {
  if denominator == 0 {
    return 0.0;
  }
  let progress = (numerator as f64 / denominator as f64) * 100.0;
  progress.clamp(0.0, 100.0)
}

/**
 * 发送进度事件
 * @param window 当前窗口
 * @param payload 进度载荷
 */
fn emit_pipeline_progress(window: &Window, mut payload: PipelineProgressPayload) {
  payload.updated_at = now_millis();
  let progress_store = window.state::<PipelineProgressStore>();
  progress_store.save(payload.clone());
  let _ = window.emit(PIPELINE_PROGRESS_EVENT, payload);
}

/**
 * 发送简单阶段进度
 * @param window 当前窗口
 * @param uid 任务 UID
 * @param stage 阶段名
 * @param message 提示信息
 * @param current_file 当前文件
 * @param overall_completed 已完成项数
 * @param overall_total 总项数
 */
fn emit_stage_progress(
  window: &Window,
  uid: &str,
  stage: &str,
  message: &str,
  current_file: &str,
  current_shot_no: u32,
  completed_shots: u32,
  total_shots: u32,
  overall_completed: u32,
  overall_total: u32,
) {
  emit_pipeline_progress(window, PipelineProgressPayload {
    uid: uid.to_string(),
    stage: stage.to_string(),
    message: message.to_string(),
    current_file: current_file.to_string(),
    current_shot_no,
    completed_shots,
    total_shots,
    current_file_downloaded_bytes: 0,
    current_file_total_bytes: 0,
    current_file_progress: 0.0,
    overall_completed,
    overall_total,
    overall_progress: to_progress_percent(overall_completed as u64, overall_total as u64),
    updated_at: 0,
  });
}

/**
 * 标准化后端地址
 * @param raw 原始地址
 * @return {String} 标准化后的地址
 */
fn normalize_backend_url(raw: &str) -> String {
  raw.trim().trim_end_matches('/').to_string()
}

/**
 * 标准化 UID
 * @param raw 原始 UID
 * @return {String} 标准化后的 UID
 */
fn normalize_uid(raw: &str) -> String {
  raw.trim().to_uppercase()
}

/**
 * 获取默认输出目录
 * @return {PathBuf} 默认目录
 */
fn default_output_root() -> PathBuf {
  if let Ok(user_profile) = env::var("USERPROFILE") {
    return PathBuf::from(user_profile)
      .join("Documents")
      .join("LocalRenderTasks");
  }
  env::current_dir()
    .unwrap_or_else(|_| PathBuf::from("."))
    .join("LocalRenderTasks")
}

/**
 * 清洗文件名
 * @param raw 原始名称
 * @return {String} 安全文件名
 */
fn sanitize_file_name(raw: &str) -> String {
  let cleaned = raw
    .chars()
    .map(|char| match char {
      '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
      _ => char,
    })
    .collect::<String>()
    .trim()
    .replace(' ', "_");

  if cleaned.is_empty() {
    "untitled".to_string()
  } else {
    cleaned
  }
}

/**
 * 路径转字符串
 * @param target 目标路径
 * @return {String} 标准化后的字符串
 */
fn path_to_string(target: &Path) -> String {
  target.to_string_lossy().replace('\\', "/")
}

/**
 * PowerShell 安全引用
 * @param raw 原始文本
 * @return {String} 引号包裹后的文本
 */

/**
 * URL 推导文件名
 * @param raw_url 原始 URL
 * @param fallback 兜底文件名
 * @return {String} 文件名
 */
fn file_name_from_url(raw_url: &str, fallback: &str) -> String {
  Url::parse(raw_url)
    .ok()
    .and_then(|url| {
      url
        .path_segments()
        .and_then(|segments| segments.last().map(|item| item.to_string()))
    })
    .filter(|value| !value.trim().is_empty())
    .unwrap_or_else(|| fallback.to_string())
}

/**
 * 根据比例返回统一分辨率
 * @param aspect_ratio 比例
 * @return {(u32, u32)} 宽高
 */

/**
 * 预览图高度
 * @param preview_width 预览宽度
 * @param ratio 画幅比例
 * @return {f64} 预览高度
 */

/**
 * 构建 atlas 裁切表达式
 * @param shot_no 镜头号
 * @param ratio 画幅比例
 * @param crop_config 裁切配置
 * @return {String} ffmpeg filter 片段
 */

/**
 * 当前电脑是否具备 ffmpeg
 * @return {bool} 是否存在
 */
fn has_ffmpeg() -> bool {
  Command::new("ffmpeg")
    .arg("-version")
    .output()
    .map(|output| output.status.success())
    .unwrap_or(false)
}

/**
 * 读取视频真实时长
 * @param file_path 本地视频路径
 * @return {u64} 微秒时长
 */
fn get_video_duration_us(file_path: &Path) -> u64 {
  let output = create_hidden_command("ffprobe")
    .args([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      &path_to_string(file_path),
    ])
    .output();

  let Ok(output) = output else {
    return 0;
  };
  if !output.status.success() {
    return 0;
  }

  let duration_seconds = String::from_utf8_lossy(&output.stdout).trim().parse::<f64>().unwrap_or(0.0);
  if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
    return 0;
  }
  (duration_seconds * 1_000_000.0).round() as u64
}

/**
 * 判断文件是否可直接复用
 * @param file_path 目标文件路径
 * @return {bool} 是否已存在完整文件
 */
fn is_reusable_file(file_path: &Path) -> bool {
  std::fs::metadata(file_path)
    .map(|metadata| metadata.is_file() && metadata.len() > 0)
    .unwrap_or(false)
}

/**
 * 下载后修正草稿里的视频变速与源时长
 * @param draft_content 草稿内容 JSON
 * @param manifest 清单 JSON
 * @param duration_by_absolute_path 绝对路径到真实时长映射
 * @param duration_by_relative_path 相对路径到真实时长映射
 */
fn repair_downloaded_video_timings(
  draft_content: &mut Value,
  manifest: &mut Value,
  duration_by_absolute_path: &HashMap<String, u64>,
  duration_by_relative_path: &HashMap<String, u64>,
) {
  let mut material_duration_by_id: HashMap<String, u64> = HashMap::new();
  let mut speed_by_id: HashMap<String, f64> = HashMap::new();

  if let Some(video_materials) = draft_content
    .get_mut("materials")
    .and_then(|value| value.get_mut("videos"))
    .and_then(Value::as_array_mut)
  {
    for material in video_materials.iter_mut() {
      let material_type = material.get("type").and_then(Value::as_str).unwrap_or("");
      if material_type != "video" {
        continue;
      }
      let material_path = material
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .replace('\\', "/");
      let Some(&actual_duration_us) = duration_by_absolute_path.get(&material_path) else {
        continue;
      };
      if let Some(object) = material.as_object_mut() {
        object.insert("duration".to_string(), json!(actual_duration_us));
      }
      if let Some(material_id) = material.get("id").and_then(Value::as_str) {
        material_duration_by_id.insert(material_id.to_string(), actual_duration_us);
      }
    }
  }

  if let Some(tracks) = draft_content.get_mut("tracks").and_then(Value::as_array_mut) {
    for track in tracks.iter_mut() {
      let Some(segments) = track.get_mut("segments").and_then(Value::as_array_mut) else {
        continue;
      };
      for segment in segments.iter_mut() {
        if segment.get("type").and_then(Value::as_str) != Some("video") {
          continue;
        }
        let Some(material_id) = segment.get("material_id").and_then(Value::as_str) else {
          continue;
        };
        let Some(&actual_duration_us) = material_duration_by_id.get(material_id) else {
          continue;
        };
        let target_duration_us = segment
          .get("target_timerange")
          .and_then(|value| value.get("duration"))
          .and_then(Value::as_u64)
          .unwrap_or(0);
        if target_duration_us == 0 {
          continue;
        }
        let source_duration_us = actual_duration_us.min(target_duration_us);
        let playback_speed = if actual_duration_us < target_duration_us {
          actual_duration_us as f64 / target_duration_us as f64
        } else {
          1.0
        };

        if let Some(source_timerange) = segment
          .get_mut("source_timerange")
          .and_then(Value::as_object_mut)
        {
          source_timerange.insert("duration".to_string(), json!(source_duration_us));
        }
        if let Some(object) = segment.as_object_mut() {
          object.insert("speed".to_string(), json!(playback_speed));
        }

        if let Some(extra_refs) = segment.get("extra_material_refs").and_then(Value::as_array) {
          for extra_ref in extra_refs {
            let Some(speed_id) = extra_ref.as_str() else {
              continue;
            };
            speed_by_id.entry(speed_id.to_string()).or_insert(playback_speed);
          }
        }
      }
    }
  }

  if let Some(speed_materials) = draft_content
    .get_mut("materials")
    .and_then(|value| value.get_mut("speeds"))
    .and_then(Value::as_array_mut)
  {
    for material in speed_materials.iter_mut() {
      let Some(speed_id) = material.get("id").and_then(Value::as_str) else {
        continue;
      };
      let Some(&playback_speed) = speed_by_id.get(speed_id) else {
        continue;
      };
      if let Some(object) = material.as_object_mut() {
        object.insert("speed".to_string(), json!(playback_speed));
      }
    }
  }

  if let Some(shots) = manifest.get_mut("shots").and_then(Value::as_array_mut) {
    for shot in shots.iter_mut() {
      let relative_path = shot
        .get("file")
        .and_then(Value::as_str)
        .unwrap_or("")
        .replace('\\', "/");
      let Some(&actual_duration_us) = duration_by_relative_path.get(&relative_path) else {
        continue;
      };
      if let Some(object) = shot.as_object_mut() {
        object.insert("source_duration_ms".to_string(), json!(actual_duration_us / 1000));
      }
    }
  }
}

/**
 * 生成本机身份
 * @return {DeviceIdentity} 设备身份对象
 */
fn build_device_identity() -> DeviceIdentity {
  let computer_name = env::var("COMPUTERNAME").unwrap_or_else(|_| "UNKNOWN-PC".to_string());
  let user_name = env::var("USERNAME").unwrap_or_else(|_| "unknown-user".to_string());
  let seed = format!("{}::{}", computer_name, user_name);
  let mut hasher = DefaultHasher::new();
  seed.hash(&mut hasher);
  let hash = format!("{:X}", hasher.finish());
  let output_root = default_output_root();

  DeviceIdentity {
    device_id: format!("{}-{}", computer_name.to_uppercase(), hash),
    device_name: computer_name,
    platform: "windows".to_string(),
    suggested_output_root: path_to_string(&output_root),
  }
}

/**
 * 构建统一 HTTP 客户端
 * @return {Result<Client, String>} HTTP 客户端
 */
fn build_http_client() -> Result<Client, String> {
  Client::builder()
    .no_proxy()
    .no_gzip()
    .no_brotli()
    .no_deflate()
    .build()
    .map_err(|err| format!("创建 HTTP 客户端失败: {}", err))
}

fn create_hidden_command(program: &str) -> Command {
  let mut command = Command::new(program);
  command.creation_flags(CREATE_NO_WINDOW);
  command
}

/**
 * 统一提取任务对象，兼容独立后端和现有业务后端两种响应壳
 * @param payload 原始响应 JSON
 * @return {Result<TaskRecord, String>} 任务对象
 */
fn extract_task_from_payload(payload: Value) -> Result<TaskRecord, String> {
  if payload.get("ok").and_then(|value| value.as_bool()).is_some() {
    let ok = payload
      .get("ok")
      .and_then(|value| value.as_bool())
      .unwrap_or(false);
    if !ok {
      return Err(payload
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or("任务请求失败")
        .to_string());
    }

    let task_value = payload
      .get("task")
      .cloned()
      .ok_or_else(|| "响应中缺少 task".to_string())?;
    return serde_json::from_value::<TaskRecord>(task_value).map_err(|err| err.to_string());
  }

  let status = payload.get("status").and_then(|value| value.as_i64()).unwrap_or(-1);
  let message = payload
    .get("message")
    .and_then(|value| value.as_str())
    .unwrap_or("任务请求失败")
    .to_string();
  if status != 0 {
    return Err(message);
  }

  let result_value = payload
    .get("result")
    .cloned()
    .ok_or_else(|| "响应中缺少 result".to_string())?;
  if let Some(ok) = result_value.get("ok").and_then(|value| value.as_bool()) {
    if !ok {
      return Err(message);
    }
    let task_value = result_value
      .get("task")
      .cloned()
      .ok_or_else(|| "响应 result 中缺少 task".to_string())?;
    return serde_json::from_value::<TaskRecord>(task_value).map_err(|err| err.to_string());
  }

  serde_json::from_value::<TaskRecord>(result_value).map_err(|err| err.to_string())
}

fn extract_blueprint_from_payload(payload: Value) -> Result<DraftBlueprint, String> {
  if payload.get("ok").and_then(|value| value.as_bool()).is_some() {
    let ok = payload.get("ok").and_then(|value| value.as_bool()).unwrap_or(false);
    if !ok {
      return Err(payload
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or("草稿蓝图请求失败")
        .to_string());
    }
    let blueprint_value = payload
      .get("blueprint")
      .cloned()
      .ok_or_else(|| "响应中缺少 blueprint".to_string())?;
    return serde_json::from_value::<DraftBlueprint>(blueprint_value).map_err(|err| err.to_string());
  }

  let status = payload.get("status").and_then(|value| value.as_i64()).unwrap_or(-1);
  let message = payload
    .get("message")
    .and_then(|value| value.as_str())
    .unwrap_or("草稿蓝图请求失败")
    .to_string();
  if status != 0 {
    return Err(message);
  }

  let result_value = payload
    .get("result")
    .cloned()
    .ok_or_else(|| "响应中缺少 result".to_string())?;
  if let Some(ok) = result_value.get("ok").and_then(|value| value.as_bool()) {
    if !ok {
      return Err(message);
    }
    let blueprint_value = result_value
      .get("blueprint")
      .cloned()
      .ok_or_else(|| "响应 result 中缺少 blueprint".to_string())?;
    return serde_json::from_value::<DraftBlueprint>(blueprint_value).map_err(|err| err.to_string());
  }

  serde_json::from_value::<DraftBlueprint>(result_value).map_err(|err| err.to_string())
}

/**
 * 下载接口响应 JSON
 * @param response HTTP 响应
 * @return {Result<Value, String>} JSON 值
 */
async fn read_response_json(response: reqwest::Response, context: &str) -> Result<Value, String> {
  let bytes = response
    .bytes()
    .await
    .map_err(|err| format!("{}: 读取响应体失败: {}", context, err))?;
  serde_json::from_slice::<Value>(&bytes)
    .map_err(|err| {
      let preview = String::from_utf8_lossy(&bytes);
      format!(
        "{}: JSON 解析失败: {} | body={}",
        context,
        err,
        preview.chars().take(500).collect::<String>(),
      )
    })
}

/**
 * 使用系统 curl 兜底请求 JSON
 * @param method 请求方法
 * @param url 请求地址
 * @param body 请求体
 * @param context 上下文
 * @return {Result<Value, String>} JSON 值
 */
fn request_json_via_curl(method: &str, url: &str, body: Option<&str>, context: &str) -> Result<Value, String> {
  let mut command = create_hidden_command("curl.exe");
  command
    .arg("-sS")
    .arg("-L")
    .arg("--noproxy")
    .arg("*")
    .arg("--request")
    .arg(method)
    .arg("--header")
    .arg("Accept-Encoding: identity");
  if let Some(payload) = body {
    command
      .arg("--header")
      .arg("Content-Type: application/json")
      .arg("--data-binary")
      .arg(payload);
  }
  command.arg(url);

  let output = command
    .output()
    .map_err(|err| format!("{}: 启动 curl 失败: {}", context, err))?;
  if !output.status.success() {
    return Err(format!(
      "{}: curl 请求失败: {}",
      context,
      String::from_utf8_lossy(&output.stderr),
    ));
  }

  let stdout = String::from_utf8_lossy(&output.stdout).to_string();
  serde_json::from_str::<Value>(&stdout).map_err(|err| {
    format!(
      "{}: curl JSON 解析失败: {} | body={}",
      context,
      err,
      stdout.chars().take(500).collect::<String>(),
    )
  })
}

async fn fetch_draft_blueprint(
  client: &Client,
  backend_url: &str,
  uid: &str,
  draft_root_base_path: &str,
) -> Result<DraftBlueprint, String> {
  let endpoint = format!(
    "{}/api/tasks/{}/draft-blueprint",
    normalize_backend_url(backend_url),
    normalize_uid(uid),
  );
  let request_body = json!({
    "draft_root_base_path": draft_root_base_path,
  }).to_string();
  let response = client
    .post(&endpoint)
    .body(request_body.clone())
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .send()
    .await
    .map_err(|err| err.to_string())?;
  let status = response.status();
  let payload = if !status.is_success() {
    request_json_via_curl("POST", &endpoint, Some(&request_body), "fetch_draft_blueprint")?
  } else {
    match read_response_json(response, "fetch_draft_blueprint").await {
      Ok(value) => value,
      Err(err) => {
        if err.contains("EOF while parsing a value") || err.contains("读取响应体失败") {
          request_json_via_curl("POST", &endpoint, Some(&request_body), "fetch_draft_blueprint")?
        } else {
          return Err(err);
        }
      }
    }
  };
  extract_blueprint_from_payload(payload)
}

/**
 * 查询任务详情
 * @param client HTTP 客户端
 * @param backend_url 后端地址
 * @param uid 任务 UID
 * @return {Result<TaskRecord, String>} 任务对象
 */
async fn fetch_task(client: &Client, backend_url: &str, uid: &str) -> Result<TaskRecord, String> {
  let endpoint = format!("{}/api/tasks/{}", normalize_backend_url(backend_url), normalize_uid(uid));
  let response = client.get(&endpoint).send().await.map_err(|err| err.to_string())?;
  let status = response.status();
  if !status.is_success() {
    return extract_task_from_payload(request_json_via_curl("GET", &endpoint, None, "fetch_task")?);
  }
  let payload = match read_response_json(response, "fetch_task").await {
    Ok(value) => value,
    Err(err) => {
      if err.contains("EOF while parsing a value") || err.contains("读取响应体失败") {
        request_json_via_curl("GET", &endpoint, None, "fetch_task")?
      } else {
        return Err(err);
      }
    }
  };

  extract_task_from_payload(payload)
}

/**
 * 认领任务
 * @param client HTTP 客户端
 * @param backend_url 后端地址
 * @param uid 任务 UID
 * @param device 设备身份
 * @return {Result<TaskRecord, String>} 任务对象
 */
async fn claim_task(
  client: &Client,
  backend_url: &str,
  uid: &str,
  device: &DeviceIdentity,
) -> Result<TaskRecord, String> {
  let endpoint = format!(
    "{}/api/tasks/{}/claim",
    normalize_backend_url(backend_url),
    normalize_uid(uid),
  );
  let request_body = serde_json::to_string(&ClaimPayload {
    device_id: device.device_id.clone(),
    device_name: device.device_name.clone(),
  }).map_err(|err| format!("claim_task: 序列化请求体失败: {}", err))?;
  let response = client
    .post(&endpoint)
    .body(request_body.clone())
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .send()
    .await
    .map_err(|err| err.to_string())?;
  let status = response.status();
  if !status.is_success() {
    return extract_task_from_payload(request_json_via_curl("POST", &endpoint, Some(&request_body), "claim_task")?);
  }
  let payload = match read_response_json(response, "claim_task").await {
    Ok(value) => value,
    Err(err) => {
      if err.contains("EOF while parsing a value") || err.contains("读取响应体失败") {
        request_json_via_curl("POST", &endpoint, Some(&request_body), "claim_task")?
      } else {
        return Err(err);
      }
    }
  };

  extract_task_from_payload(payload)
}

/**
 * 回写任务状态
 * @param client HTTP 客户端
 * @param backend_url 后端地址
 * @param uid 任务 UID
 * @param status 任务状态
 * @param message 状态说明
 * @param device 设备身份
 * @param outputs 输出信息
 * @return {Result<TaskRecord, String>} 任务对象
 */
async fn update_task_status(
  client: &Client,
  backend_url: &str,
  uid: &str,
  status: &str,
  message: &str,
  device: &DeviceIdentity,
  outputs: Option<TaskOutputs>,
) -> Result<TaskRecord, String> {
  let endpoint = format!(
    "{}/api/tasks/{}/status",
    normalize_backend_url(backend_url),
    normalize_uid(uid),
  );
  let request_body = serde_json::to_string(&StatusUpdatePayload {
    device_id: device.device_id.clone(),
    status: status.to_string(),
    message: message.to_string(),
    outputs,
  }).map_err(|err| format!("update_task_status: 序列化请求体失败: {}", err))?;
  let response = client
    .post(&endpoint)
    .body(request_body.clone())
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .send()
    .await
    .map_err(|err| err.to_string())?;
  let status_code = response.status();
  if !status_code.is_success() {
    return extract_task_from_payload(request_json_via_curl("POST", &endpoint, Some(&request_body), "update_task_status")?);
  }
  let payload = match read_response_json(response, "update_task_status").await {
    Ok(value) => value,
    Err(err) => {
      if err.contains("EOF while parsing a value") || err.contains("读取响应体失败") {
        request_json_via_curl("POST", &endpoint, Some(&request_body), "update_task_status")?
      } else {
        return Err(err);
      }
    }
  };

  extract_task_from_payload(payload)
}

/**
 * 下载远程文件并实时回传进度
 * @param window 当前窗口
 * @param client HTTP 客户端
 * @param remote_url 远程 URL
 * @param target_path 本地路径
 * @param meta 进度上下文
 * @return {Result<(), String>} 执行结果
 */
async fn download_file_with_progress(
  window: &Window,
  client: &Client,
  remote_url: &str,
  target_path: &Path,
  meta: DownloadProgressMeta,
) -> Result<(), String> {
  let response = client
    .get(remote_url)
    .header(ACCEPT_ENCODING, "identity")
    .send()
    .await
    .map_err(|err| format!("下载失败: {}", err))?;

  if !response.status().is_success() {
    return Err(format!("下载失败，HTTP {}", response.status()));
  }

  if let Some(parent) = target_path.parent() {
    fs::create_dir_all(parent)
      .await
      .map_err(|err| format!("创建目录失败: {}", err))?;
  }

  let temp_path = PathBuf::from(format!("{}.part", target_path.to_string_lossy()));
  let _ = fs::remove_file(&temp_path).await;

  let total_bytes = response.content_length().unwrap_or(0);
  let mut downloaded_bytes = 0_u64;
  let mut file = File::create(&temp_path).map_err(|err| format!("创建文件失败: {}", err))?;

  emit_pipeline_progress(window, PipelineProgressPayload {
    uid: meta.uid.clone(),
    stage: meta.stage.clone(),
    message: meta.message.clone(),
    current_file: meta.current_file.clone(),
    current_shot_no: meta.current_shot_no,
    completed_shots: meta.completed_shots,
    total_shots: meta.total_shots,
    current_file_downloaded_bytes: 0,
    current_file_total_bytes: total_bytes,
    current_file_progress: 0.0,
    overall_completed: meta.overall_completed,
    overall_total: meta.overall_total,
    overall_progress: to_progress_percent(meta.overall_completed as u64, meta.overall_total as u64),
    updated_at: 0,
  });

  let mut response = response;
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|err| format!("读取下载流失败: {}", err))?
  {
    file.write_all(&chunk).map_err(|err| format!("写入下载文件失败: {}", err))?;
    downloaded_bytes += chunk.len() as u64;
    let current_file_progress = to_progress_percent(downloaded_bytes, total_bytes);
    let overall_units = if meta.overall_total == 0 {
      0.0
    } else {
      meta.overall_completed as f64 + (current_file_progress / 100.0)
    };
    emit_pipeline_progress(window, PipelineProgressPayload {
      uid: meta.uid.clone(),
      stage: meta.stage.clone(),
      message: meta.message.clone(),
      current_file: meta.current_file.clone(),
      current_shot_no: meta.current_shot_no,
      completed_shots: meta.completed_shots,
      total_shots: meta.total_shots,
      current_file_downloaded_bytes: downloaded_bytes,
      current_file_total_bytes: total_bytes,
      current_file_progress,
      overall_completed: meta.overall_completed,
      overall_total: meta.overall_total,
      overall_progress: if meta.overall_total == 0 {
        0.0
      } else {
        (overall_units / meta.overall_total as f64 * 100.0).clamp(0.0, 100.0)
      },
      updated_at: 0,
    });
  }

  file.flush().map_err(|err| format!("刷新下载文件失败: {}", err))?;
  drop(file);
  fs::rename(&temp_path, target_path)
    .await
    .map_err(|err| format!("写入目标文件失败: {}", err))?;

  Ok(())
}

/**
 * 生成 PowerShell 合成脚本
 * @param script_path 脚本路径
 * @param local_assets 本地素材列表
 * @param audio_path 音频路径
 * @param final_video_path 最终视频路径
 * @param width 宽
 * @param height 高
 * @return {Result<(), String>} 执行结果
 */
#[cfg(any())]
async fn write_compose_script(
  script_path: &Path,
  local_assets: &[LocalAssetManifestItem],
  audio_path: Option<&Path>,
  final_video_path: &Path,
  width: u32,
  height: u32,
) -> Result<(), String> {
  let concat_path = final_video_path
    .parent()
    .unwrap_or_else(|| Path::new("."))
    .join("concat.txt");

  let mut lines = vec![
    "$ErrorActionPreference = 'Stop'".to_string(),
    "$ffmpeg = 'ffmpeg'".to_string(),
    format!("$width = {}", width),
    format!("$height = {}", height),
    String::new(),
  ];

  for asset in local_assets {
    let local_path = ps_quote(&asset.local_path);
    let segment_path = ps_quote(&asset.segment_path);
    let mut filters: Vec<String> = Vec::new();
    if asset.source_kind == "atlas_crop" {
      if let Some(crop_config) = &asset.crop_config {
        let crop_ratio = if crop_config.ratio.trim().is_empty() { "16:9" } else { crop_config.ratio.as_str() };
        filters.push(build_atlas_crop_filter(asset.shot_no, crop_ratio, crop_config));
      }
    }
    filters.push("scale=$width:$height:force_original_aspect_ratio=increase".to_string());
    filters.push("crop=$width:$height".to_string());
    filters.push("format=yuv420p".to_string());
    let filter = filters.join(",");

    if asset.asset_type == "image" {
      let duration = (asset.duration_ms as f64 / 1000.0).max(1.0);
      lines.push(format!(
        "& $ffmpeg -y -loop 1 -i {} -t {:.3} -vf \"{}\" -r 30 -an -c:v libx264 -pix_fmt yuv420p {}",
        local_path, duration, filter, segment_path,
      ));
    } else {
      lines.push(format!(
        "& $ffmpeg -y -i {} -vf \"{}\" -r 30 -an -c:v libx264 -pix_fmt yuv420p {}",
        local_path, filter, segment_path,
      ));
    }
  }

  let concat_items = local_assets
    .iter()
    .map(|item| {
      let normalized = item.segment_path.replace('\\', "/").replace('"', "`\"");
      format!("\"file '{}'\"", normalized)
    })
    .collect::<Vec<_>>()
    .join(",\n");

  lines.push(String::new());
  lines.push(format!(
    "@(\n{}\n) | Set-Content -Path {} -Encoding UTF8",
    concat_items,
    ps_quote(&path_to_string(&concat_path)),
  ));

  let concat_path_text = ps_quote(&path_to_string(&concat_path));
  let final_path_text = ps_quote(&path_to_string(final_video_path));
  if let Some(audio_path) = audio_path {
    lines.push(format!(
      "& $ffmpeg -y -f concat -safe 0 -i {} -i {} -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest {}",
      concat_path_text,
      ps_quote(&path_to_string(audio_path)),
      final_path_text,
    ));
  } else {
    lines.push(format!(
      "& $ffmpeg -y -f concat -safe 0 -i {} -c:v libx264 -pix_fmt yuv420p {}",
      concat_path_text, final_path_text,
    ));
  }

  fs::write(script_path, lines.join("\n"))
    .await
    .map_err(|err| format!("写入 compose.ps1 失败: {}", err))
}

/**
 * 运行 ffmpeg 并实时解析进度
 * @param window 当前窗口
 * @param uid 任务 UID
 * @param stage 进度阶段
 * @param message 进度说明
 * @param current_file 当前文件
 * @param current_shot_no 当前镜头号
 * @param completed_steps 已完成步骤
 * @param total_steps 总步骤数
 * @param expected_duration_ms 预估时长
 * @param args ffmpeg 参数
 * @return {Result<(), String>} 执行结果
 */
#[cfg(any())]
fn run_ffmpeg_with_progress(
  window: &Window,
  uid: &str,
  stage: &str,
  message: &str,
  current_file: &str,
  current_shot_no: u32,
  completed_steps: u32,
  total_steps: u32,
  expected_duration_ms: u64,
  args: &[String],
) -> Result<(), String> {
  let mut command = create_hidden_command("ffmpeg");
  command
    .args(args)
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
  let mut child = command.spawn().map_err(|err| format!("启动 ffmpeg 失败: {}", err))?;
  let stdout = child.stdout.take().ok_or_else(|| "无法获取 ffmpeg 输出流".to_string())?;
  let reader = BufReader::new(stdout);

  emit_pipeline_progress(window, PipelineProgressPayload {
    uid: uid.to_string(),
    stage: stage.to_string(),
    message: message.to_string(),
    current_file: current_file.to_string(),
    current_shot_no,
    current_file_downloaded_bytes: 0,
    current_file_total_bytes: expected_duration_ms,
    current_file_progress: 0.0,
    overall_completed: completed_steps,
    overall_total: total_steps,
    overall_progress: to_progress_percent(completed_steps as u64, total_steps as u64),
  });

  for line in reader.lines() {
    let content = line.map_err(|err| format!("读取 ffmpeg 进度失败: {}", err))?;
    let Some((key, value)) = content.split_once('=') else {
      continue;
    };
    if key != "out_time_ms" && key != "out_time_us" && key != "progress" {
      continue;
    }

    if key == "progress" && value == "end" {
      emit_pipeline_progress(window, PipelineProgressPayload {
        uid: uid.to_string(),
        stage: stage.to_string(),
        message: message.to_string(),
        current_file: current_file.to_string(),
        current_shot_no,
        current_file_downloaded_bytes: expected_duration_ms,
        current_file_total_bytes: expected_duration_ms,
        current_file_progress: 100.0,
        overall_completed: completed_steps.saturating_add(1),
        overall_total: total_steps,
        overall_progress: to_progress_percent(completed_steps.saturating_add(1) as u64, total_steps as u64),
      });
      continue;
    }

    let raw_value = value.trim().parse::<u64>().unwrap_or(0);
    let processed_ms = if expected_duration_ms > 0 && raw_value > expected_duration_ms.saturating_mul(1000) {
      raw_value / 1000
    } else {
      raw_value
    };
    let current_file_progress = to_progress_percent(processed_ms, expected_duration_ms);
    let overall_units = if total_steps == 0 {
      0.0
    } else {
      completed_steps as f64 + (current_file_progress / 100.0)
    };
    emit_pipeline_progress(window, PipelineProgressPayload {
      uid: uid.to_string(),
      stage: stage.to_string(),
      message: message.to_string(),
      current_file: current_file.to_string(),
      current_shot_no,
      current_file_downloaded_bytes: processed_ms,
      current_file_total_bytes: expected_duration_ms,
      current_file_progress,
      overall_completed: completed_steps,
      overall_total: total_steps,
      overall_progress: if total_steps == 0 {
        0.0
      } else {
        (overall_units / total_steps as f64 * 100.0).clamp(0.0, 100.0)
      },
    });
  }

  let status = child.wait().map_err(|err| format!("等待 ffmpeg 结束失败: {}", err))?;
  if !status.success() {
    return Err(format!("ffmpeg 执行失败，退出码 {:?}", status.code()));
  }
  Ok(())
}

/**
 * 自动执行 ffmpeg 合成
 * @param local_assets 本地素材
 * @param audio_path 音频路径
 * @param output_dir 输出目录
 * @param width 宽
 * @param height 高
 * @return {Result<String, String>} 最终视频路径
 */
#[cfg(any())]
fn try_compose_with_ffmpeg(
  window: &Window,
  uid: &str,
  local_assets: &[LocalAssetManifestItem],
  audio_path: Option<&Path>,
  output_dir: &Path,
  width: u32,
  height: u32,
) -> Result<String, String> {
  let concat_path = output_dir.join("concat.txt");
  let final_video_path = output_dir.join("final.mp4");
  let total_steps = local_assets.len() as u32 + 1;
  let total_duration_ms = local_assets.iter().map(|item| item.duration_ms).sum::<u64>();

  for (index, asset) in local_assets.iter().enumerate() {
    let mut filters: Vec<String> = Vec::new();
    if asset.source_kind == "atlas_crop" {
      if let Some(crop_config) = &asset.crop_config {
        let crop_ratio = if crop_config.ratio.trim().is_empty() { "16:9" } else { crop_config.ratio.as_str() };
        filters.push(build_atlas_crop_filter(asset.shot_no, crop_ratio, crop_config));
      }
    }
    filters.push(format!(
      "scale={}:{}:force_original_aspect_ratio=increase",
      width, height,
    ));
    filters.push(format!("crop={}:{}", width, height));
    filters.push("format=yuv420p".to_string());
    let filter = filters.join(",");
    let mut args = vec![
      "-y".to_string(),
      "-progress".to_string(),
      "pipe:1".to_string(),
      "-nostats".to_string(),
      "-v".to_string(),
      "error".to_string(),
    ];

    if asset.asset_type == "image" {
      args.extend([
        "-loop".to_string(),
        "1".to_string(),
        "-i".to_string(),
        asset.local_path.clone(),
        "-t".to_string(),
        format!("{:.3}", (asset.duration_ms as f64 / 1000.0).max(1.0)),
        "-vf".to_string(),
        filter.clone(),
        "-r".to_string(),
        "30".to_string(),
        "-an".to_string(),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        asset.segment_path.clone(),
      ]);
    } else {
      args.extend([
        "-i".to_string(),
        asset.local_path.clone(),
        "-vf".to_string(),
        filter.clone(),
        "-r".to_string(),
        "30".to_string(),
        "-an".to_string(),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        asset.segment_path.clone(),
      ]);
    }

    run_ffmpeg_with_progress(
      window,
      uid,
      "composing_segment",
      &format!("正在合成镜头 {} 片段", asset.shot_no),
      &asset.title,
      asset.shot_no,
      index as u32,
      total_steps,
      asset.duration_ms,
      &args,
    )?;
  }

  let concat_content = local_assets
    .iter()
    .map(|item| format!("file '{}'", item.segment_path.replace('\\', "/")))
    .collect::<Vec<_>>()
    .join("\n");
  std::fs::write(&concat_path, concat_content).map_err(|err| err.to_string())?;

  let mut final_args = vec![
    "-y".to_string(),
    "-progress".to_string(),
    "pipe:1".to_string(),
    "-nostats".to_string(),
    "-v".to_string(),
    "error".to_string(),
    "-f".to_string(),
    "concat".to_string(),
    "-safe".to_string(),
    "0".to_string(),
    "-i".to_string(),
    path_to_string(&concat_path),
  ];

  if let Some(audio_path) = audio_path {
    final_args.extend([
      "-i".to_string(),
      path_to_string(audio_path),
      "-c:v".to_string(),
      "libx264".to_string(),
      "-pix_fmt".to_string(),
      "yuv420p".to_string(),
      "-c:a".to_string(),
      "aac".to_string(),
      "-shortest".to_string(),
      path_to_string(&final_video_path),
    ]);
  } else {
    final_args.extend([
      "-c:v".to_string(),
      "libx264".to_string(),
      "-pix_fmt".to_string(),
      "yuv420p".to_string(),
      path_to_string(&final_video_path),
    ]);
  }

  run_ffmpeg_with_progress(
    window,
    uid,
    "composing_final",
    "正在合成最终成片",
    "final.mp4",
    0,
    local_assets.len() as u32,
    total_steps,
    total_duration_ms,
    &final_args,
  )?;

  Ok(path_to_string(&final_video_path))
}

/**
 * 实际执行本地任务流程
 * @param backend_url 后端地址
 * @param uid 任务 UID
 * @param output_root 输出根目录
 * @param device 设备身份
 * @return {Result<PipelineResult, String>} 执行结果
 */
async fn run_local_pipeline_inner(
  window: &Window,
  backend_url: &str,
  uid: &str,
  output_root: Option<String>,
  device: &DeviceIdentity,
) -> Result<PipelineResult, String> {
  let client = build_http_client()?;
  let task_detail = fetch_task(&client, backend_url, uid).await?;
  let total_shots = task_detail.shots.len() as u32;
  emit_stage_progress(window, uid, "loaded", "任务详情已加载", "", 0, 0, total_shots, 0, 0);
  emit_stage_progress(window, uid, "claiming", "正在认领任务", "", 0, 0, total_shots, 0, 0);
  claim_task(&client, backend_url, uid, device).await?;
  update_task_status(
    &client,
    backend_url,
    uid,
    "downloading",
    "桌面端开始下载素材",
    device,
    None,
  )
  .await?;
  emit_stage_progress(window, uid, "preparing", "正在生成草稿蓝图", "", 0, 0, total_shots, 0, 0);
  let output_root_dir = output_root
    .map(PathBuf::from)
    .filter(|value| !value.as_os_str().is_empty())
    .unwrap_or_else(default_output_root);
  let mut blueprint = fetch_draft_blueprint(&client, backend_url, uid, &path_to_string(&output_root_dir)).await?;
  let output_dir = PathBuf::from(&blueprint.draft_root_path);
  fs::create_dir_all(&output_dir)
    .await
    .map_err(|err| format!("创建草稿目录失败: {}", err))?;

  let ffmpeg_available = has_ffmpeg();
  let mut completed = 0_u32;
  let total = blueprint.resource_plan.len() as u32;
  let mut completed_shot_nos: HashSet<u32> = HashSet::new();
  let mut video_duration_by_absolute_path: HashMap<String, u64> = HashMap::new();
  let mut video_duration_by_relative_path: HashMap<String, u64> = HashMap::new();
  let mut reused_resources = 0_u32;
  let temp_root = default_output_root().join("_draft_tmp").join(uid);
  fs::create_dir_all(&temp_root)
    .await
    .map_err(|err| format!("创建临时目录失败: {}", err))?;

  for resource in &blueprint.resource_plan {
    let target_path = PathBuf::from(resource.absolute_path.replace('/', "\\"));
    if let Some(parent) = target_path.parent() {
      fs::create_dir_all(parent)
        .await
        .map_err(|err| format!("创建资源目录失败: {}", err))?;
    }

    match resource.r#type.as_str() {
      "download" => {
        if is_reusable_file(&target_path) {
          reused_resources += 1;
          emit_stage_progress(
            window,
            uid,
            "downloading",
            &format!("复用已下载素材 {}", resource.relative_path),
            &resource.relative_path,
            resource.shot_no.unwrap_or(0),
            completed_shot_nos.len() as u32,
            total_shots,
            completed,
            total,
          );
        } else {
          download_file_with_progress(
            window,
            &client,
            &resource.source_url,
            &target_path,
            DownloadProgressMeta {
              uid: uid.to_string(),
              stage: "downloading".to_string(),
              message: format!("正在下载{}", resource.title.clone().unwrap_or_else(|| resource.relative_path.clone())),
              current_file: resource.relative_path.clone(),
              current_shot_no: resource.shot_no.unwrap_or(0),
              completed_shots: completed_shot_nos.len() as u32,
              total_shots,
              overall_completed: completed,
              overall_total: total,
            },
          )
          .await?;
        }
        if resource.media_type == "video" {
          let actual_duration_us = get_video_duration_us(&target_path);
          if actual_duration_us > 0 {
            video_duration_by_absolute_path.insert(path_to_string(&target_path), actual_duration_us);
            video_duration_by_relative_path.insert(resource.relative_path.replace('\\', "/"), actual_duration_us);
          }
        }
      }
      "download_convert_cover" => {
        let source_temp_path = temp_root.join(sanitize_file_name(&file_name_from_url(&resource.source_url, "cover_source")));
        if is_reusable_file(&target_path) {
          reused_resources += 1;
          emit_stage_progress(
            window,
            uid,
            "downloading",
            "复用已生成封面",
            &resource.relative_path,
            0,
            completed_shot_nos.len() as u32,
            total_shots,
            completed,
            total,
          );
        } else {
          if !ffmpeg_available {
            return Err("当前电脑缺少 ffmpeg，无法把封面转成剪映要求的 JPG".to_string());
          }
          const _: () = ();
          if is_reusable_file(&source_temp_path) {
            reused_resources += 1;
            emit_stage_progress(
              window,
              uid,
              "downloading",
              "复用已下载封面源文件",
              &resource.relative_path,
              0,
              completed_shot_nos.len() as u32,
              total_shots,
              completed,
              total,
            );
          } else {
            download_file_with_progress(
              window,
              &client,
              &resource.source_url,
              &source_temp_path,
              DownloadProgressMeta {
                uid: uid.to_string(),
                stage: "downloading".to_string(),
                message: "正在下载并转换封面".to_string(),
                current_file: resource.relative_path.clone(),
                current_shot_no: 0,
                completed_shots: completed_shot_nos.len() as u32,
                total_shots,
                overall_completed: completed,
                overall_total: total,
              },
            )
            .await?;
          }
          let status = create_hidden_command("ffmpeg")
            .args([
              "-y",
              "-i",
              &path_to_string(&source_temp_path),
              "-frames:v",
              "1",
              "-update",
              "1",
              "-q:v",
              "2",
              &path_to_string(&target_path),
            ])
            .status()
            .map_err(|err| format!("执行 ffmpeg 转封面失败: {}", err))?;
          if !status.success() {
            return Err("封面 JPG 转换失败".to_string());
          }
        }
      }
      "atlas_crop" => {
        let atlas_temp_name = sanitize_file_name(&file_name_from_url(
          &resource.source_url,
          &format!("atlas_{}.png", resource.shot_no.unwrap_or(0)),
        ));
        let atlas_temp_path = temp_root.join(atlas_temp_name);
        if is_reusable_file(&target_path) {
          reused_resources += 1;
          emit_stage_progress(
            window,
            uid,
            "building_draft",
            &format!("复用镜头 {} 的静态图", resource.shot_no.unwrap_or(0)),
            &resource.relative_path,
            resource.shot_no.unwrap_or(0),
            completed_shot_nos.len() as u32,
            total_shots,
            completed,
            total,
          );
        } else {
          if !ffmpeg_available {
            return Err("当前电脑缺少 ffmpeg，无法从 atlas 裁切静态镜头".to_string());
          }
          if is_reusable_file(&atlas_temp_path) {
            reused_resources += 1;
            emit_stage_progress(
              window,
              uid,
              "downloading",
              &format!("复用镜头 {} 的 atlas 原图", resource.shot_no.unwrap_or(0)),
              &resource.relative_path,
              resource.shot_no.unwrap_or(0),
              completed_shot_nos.len() as u32,
              total_shots,
              completed,
              total,
            );
          } else {
            download_file_with_progress(
              window,
              &client,
              &resource.source_url,
              &atlas_temp_path,
              DownloadProgressMeta {
                uid: uid.to_string(),
                stage: "downloading".to_string(),
                message: format!("正在准备镜头 {} 的 atlas 原图", resource.shot_no.unwrap_or(0)),
                current_file: resource.relative_path.clone(),
                current_shot_no: resource.shot_no.unwrap_or(0),
                completed_shots: completed_shot_nos.len() as u32,
                total_shots,
                overall_completed: completed,
                overall_total: total,
              },
            )
            .await?;
          }
          emit_stage_progress(
            window,
            uid,
            "building_draft",
            &format!("正在裁切镜头 {} 的静态图", resource.shot_no.unwrap_or(0)),
            &resource.relative_path,
            resource.shot_no.unwrap_or(0),
            completed_shot_nos.len() as u32,
            total_shots,
            completed,
            total,
          );
          let crop_args = resource.ffmpeg_crop_args.clone().unwrap_or_default();
          let status = create_hidden_command("ffmpeg")
            .args([
              "-y",
              "-i",
              &path_to_string(&atlas_temp_path),
              "-vf",
              &crop_args,
              "-frames:v",
              "1",
              "-update",
              "1",
              &path_to_string(&target_path),
            ])
            .status()
            .map_err(|err| format!("执行 ffmpeg 裁切 atlas 失败: {}", err))?;
          if !status.success() {
            return Err(format!("镜头 {} atlas 裁切失败", resource.shot_no.unwrap_or(0)));
          }
        }
      }
      _ => {
        return Err(format!("未知资源处理类型: {}", resource.r#type));
      }
    }

    if let Some(shot_no) = resource.shot_no.filter(|value| *value > 0) {
      completed_shot_nos.insert(shot_no);
    }
    completed += 1;
    emit_stage_progress(
      window,
      uid,
      "downloading",
      &format!("{} 已就绪", resource.relative_path),
      &resource.relative_path,
      resource.shot_no.unwrap_or(0),
      completed_shot_nos.len() as u32,
      total_shots,
      completed,
      total,
    );
  }

  emit_stage_progress(
    window,
    uid,
    "building_draft",
    "正在写入剪映草稿文件",
    "",
    0,
    completed_shot_nos.len() as u32,
    total_shots,
    completed,
    total,
  );
  repair_downloaded_video_timings(
    &mut blueprint.draft_content,
    &mut blueprint.manifest,
    &video_duration_by_absolute_path,
    &video_duration_by_relative_path,
  );
  let draft_content_path = output_dir.join("draft_content.json");
  let draft_meta_info_path = output_dir.join("draft_meta_info.json");
  let manifest_path = output_dir.join("manifest.json");
  let readme_path = output_dir.join("README.txt");

  fs::write(
    &draft_content_path,
    serde_json::to_vec_pretty(&blueprint.draft_content).map_err(|err| err.to_string())?,
  )
  .await
  .map_err(|err| format!("写入 draft_content.json 失败: {}", err))?;
  fs::write(
    &draft_meta_info_path,
    serde_json::to_vec_pretty(&blueprint.draft_meta_info).map_err(|err| err.to_string())?,
  )
  .await
  .map_err(|err| format!("写入 draft_meta_info.json 失败: {}", err))?;
  fs::write(
    &manifest_path,
    serde_json::to_vec_pretty(&blueprint.manifest).map_err(|err| err.to_string())?,
  )
  .await
  .map_err(|err| format!("写入 manifest.json 失败: {}", err))?;
  fs::write(&readme_path, blueprint.readme.as_bytes())
    .await
    .map_err(|err| format!("写入 README.txt 失败: {}", err))?;

  let note = if reused_resources > 0 {
    format!("已在本机生成剪映草稿文件夹，本次续跑复用了 {} 个已完成步骤", reused_resources)
  } else {
    "已在本机生成剪映草稿文件夹".to_string()
  };
  let outputs = TaskOutputs {
    output_dir: Some(path_to_string(&output_dir)),
    manifest_path: Some(path_to_string(&manifest_path)),
    compose_script_path: Some(path_to_string(&draft_content_path)),
    final_video_path: None,
    note: Some(note.clone()),
  };
  let task = update_task_status(
    &client,
    backend_url,
    uid,
    "prepared",
    &note,
    device,
    Some(outputs.clone()),
  )
  .await?;
  emit_stage_progress(
    window,
    uid,
    "completed",
    &note,
    &blueprint.draft_dir_name,
    0,
    completed_shot_nos.len() as u32,
    total_shots,
    total,
    total,
  );

  let _ = fs::remove_dir_all(&temp_root).await;

  Ok(PipelineResult {
    task,
    output_dir: outputs.output_dir.clone().unwrap_or_default(),
    manifest_path: outputs.manifest_path.clone().unwrap_or_default(),
    compose_script_path: outputs.compose_script_path.clone().unwrap_or_default(),
    note,
  })
}

#[tauri::command]
async fn get_device_identity() -> Result<DeviceIdentity, String> {
  Ok(build_device_identity())
}

#[tauri::command]
async fn fetch_task_summary(
  progress_store: tauri::State<'_, PipelineProgressStore>,
  backend_url: String,
  uid: String,
) -> Result<TaskRecord, String> {
  let client = build_http_client()?;
  let mut task = fetch_task(&client, &backend_url, &uid).await?;
  task.progress = progress_store.get(&task.uid);
  Ok(task)
}

#[tauri::command]
async fn run_local_pipeline(
  progress_store: tauri::State<'_, PipelineProgressStore>,
  window: Window,
  backend_url: String,
  uid: String,
  output_root: Option<String>,
) -> Result<PipelineResult, String> {
  let device = build_device_identity();
  let mut result = run_local_pipeline_inner(&window, &backend_url, &uid, output_root, &device).await;
  if let Ok(pipeline_result) = &mut result {
    pipeline_result.task.progress = progress_store.get(&uid);
  }
  if let Err(error) = &result {
    emit_stage_progress(&window, &uid, "failed", &format!("本地执行失败：{}", error), "", 0, 0, 0, 0, 0);
    if let Ok(client) = build_http_client() {
      let _ = update_task_status(
        &client,
        &backend_url,
        &uid,
        "failed",
        &format!("本地执行失败：{}", error),
        &device,
        None,
      )
      .await;
    }
  }
  result
}

#[tauri::command]
async fn open_in_explorer(path: String) -> Result<(), String> {
  Command::new("explorer")
    .arg(path)
    .spawn()
    .map_err(|err| err.to_string())?;
  Ok(())
}

#[tauri::command]
async fn pick_output_directory(current_path: Option<String>) -> Result<Option<String>, String> {
  let initial_path = current_path
    .map(|value| value.trim().replace('\'', "''"))
    .filter(|value| !value.is_empty())
    .unwrap_or_default();
  let script = if initial_path.is_empty() {
    [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '请选择桌面端输出目录'",
      "$dialog.ShowNewFolderButton = $true",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "  Write-Output $dialog.SelectedPath",
      "}",
    ].join("; ")
  } else {
    [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '请选择桌面端输出目录'",
      "$dialog.ShowNewFolderButton = $true",
      &format!("$dialog.SelectedPath = '{}'", initial_path),
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "  Write-Output $dialog.SelectedPath",
      "}",
    ].join("; ")
  };

  let output = create_hidden_command("powershell.exe")
    .args([
      "-NoProfile",
      "-STA",
      "-Command",
      &script,
    ])
    .output()
    .map_err(|err| format!("打开目录选择器失败: {}", err))?;
  if !output.status.success() {
    return Err(format!("目录选择器执行失败: {}", String::from_utf8_lossy(&output.stderr)));
  }

  let selected_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
  if selected_path.is_empty() {
    return Ok(None);
  }
  Ok(Some(selected_path.replace('\\', "/")))
}

fn main() {
  tauri::Builder::default()
    .manage(PipelineProgressStore::default())
    .invoke_handler(tauri::generate_handler![
      get_device_identity,
      fetch_task_summary,
      run_local_pipeline,
      open_in_explorer,
      pick_output_directory
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
