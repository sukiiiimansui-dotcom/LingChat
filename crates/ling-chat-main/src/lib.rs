//! LingChat 业务主 crate。
//!
//! 原本是 `src-tauri` 内的单体模块集合，拆分为独立 crate 后，`src-tauri` 只保留
//! Tauri 外壳（lib.rs / main.rs 与 app 装配层），业务模块全部在此，由外壳与
//! `ling-chat-plugins` 共同依赖。
//!
//! 模块一律 `pub mod`：插件 crate 需要经此访问 `AppState`、`api`、`db`、
//! `ai_service` 等宿主能力。

pub mod achievements;
pub mod adventures;
pub mod ai_service;
pub mod api;
pub mod cast;
pub mod config;
pub mod data_dir;
pub mod db;
pub mod lan_sync;
pub mod manifest;
pub mod migration;
pub mod plugin_contract;
pub mod resource_sync;
pub mod state;
pub mod utils;

// 世界模拟（地图系统）Rust 后端：地理数据 / 渲染 / 地图库 / 实时流 / 移动状态机 / 事件引擎。
// 原本挂在 `src-tauri/src/world_map`（外壳里），跟随后端 workspace 化搬进本 crate —— 
// Tauri 侧只保留 `world_map_*` 命令与 Android 定位插件的注册（见 `src-tauri/src/app/`）。
pub mod world_map;

// 全局状态容器定义在 `state`，这里重导出以保持 `crate::AppState` 等既有路径不变。
pub use state::{AppState, ChatComponents, InnerAppState, ScreenshotCaptureState};
