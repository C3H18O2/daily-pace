// 最小 service worker：存在的唯一目的是让 Chrome 认为本页「可安装」（PWA 安装
// 要求注册带 fetch 处理的 SW）。不做任何缓存——工时数据必须实时，缓存出旧数据
// 比没有离线能力更糟。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
