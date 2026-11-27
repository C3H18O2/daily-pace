// 最小 service worker：只为满足 Chrome 的 PWA 可安装条件。
// 刻意不缓存任何内容——跳转页必须永远拿最新版，缓存旧版会跳过新加的地址逻辑。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
