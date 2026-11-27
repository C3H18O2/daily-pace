let state = null;
let currentTab = "today";
let tickHandle = null;
let calCursor = null;      // 日历当前月份（Date，月初）
let calOcc = {};           // 日历投影缓存："YYYY-MM" -> [{date,title,project,color,routine}]
let calLoading = {};       // 正在拉投影的月份："YYYY-MM" -> 发起时刻（只防重复请求，别拿它当缓存）
let selectedTask = null;   // 任务池里点选待排期的任务 id
const openProjects = new Set(); // 项目页里被展开的项目 id
const openSuspended = new Set(); // 「挂起中」折叠区被展开的项目 id（refresh 重建 DOM 得记着）
let trashOpen = false;         // 项目页底部垃圾桶是否展开（refresh 会重建 DOM，得记着）
let exportOpen = false;        // 设置页「历史数据导出」折叠卡是否展开（同理）
let recCfgOpen = false;        // 今日页「下一件推荐」的齿轮设置区是否展开（同理）
let todayProjOpen = false;   // 今日页项目统计卡是否展开
let waitReplyOpen = false;   // 今日页「等待回复」块是否展开
let projectFilter = "";      // 项目页项目名筛选
let dayModal = null;         // 日历「全天条目」浮层
let whatsNewModal = null;    // 新版本更新提示浮层
let whatsNewVer = "";        // 正在弹的那版（关闭时写进 localStorage）
let calibData = null;        // /api/stats/loop-calib 缓存：进统计页拉一次，采用后清空重拉
let calibMap = null;         // (project_id, title) -> 校准项，供 loop 行就地查
let calibLoading = false;
let calibMinN = 3;           // 后端给的「至少几次样本才开口」，文案里的 2/3 用它
let calibFills = [];         // 本轮渲染出来的「重画这个项目卡」回调，数据到货后刷一遍
// 今日页折叠状态持久化（localStorage，刷新不丢）
const foldGet = (k) => localStorage.getItem("pace_fold_" + k) === "1";
const foldSet = (k, v) => localStorage.setItem("pace_fold_" + k, v ? "1" : "0");

// 皮肤是纯前端偏好：存在这台设备的浏览器里，不走服务端设置（手机可以跟电脑选不同的）。
// 首屏那次应用不在此处，在 index.html 头部的内联脚本里，防闪烁
const THEME_KEY = "pace_theme";
// 名字跟 skin-preview.html 的预览命名对齐，下拉里直接用
const THEME_NAMES = [
  ["classic", "经典 · 纸面"],
  ["night", "夜间 · 夜间档案"],
  ["tech", "机能 · FIELD OPS"],
  ["nature", "自然 · 森林露营"],
  ["nasa", "NASA 朋克 · 轨道计划"],
];
const themeGet = () => {
  const saved = localStorage.getItem(THEME_KEY) || "classic";
  return THEME_NAMES.some(([name]) => name === saved) ? saved : "classic";
};
const themeSet = (v) => {
  localStorage.setItem(THEME_KEY, v);
  if (v === "classic") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", v);
};

// 每日鞭策「今日不做，明日更多」：每天第一次打开弹一次。纯前端偏好，跟皮肤一样
// 只存这台设备（pace_nag_enabled 缺省算开；pace_nag_last 记上次弹的日期）
const NAG_ON_KEY = "pace_nag_enabled";
const NAG_LAST_KEY = "pace_nag_last";

// 默认自动更新源（可被 settings.update_url 覆盖）
const UPDATE_BASE = "https://c3h18o2.github.io/daily-pace/release";

// 新版本更新提示的文案表：版本号 → 几条大白话，只说「加了 / 改了 / 修了什么」。
// 只留最近一两个版本（更早的看 更新日志.txt），每条 20 字以内，一屏放得下。
// 发新版时在这里加一条，弹不弹由 state.version 和 localStorage 里记着的版本比出来。
const WHATS_NEW = {
  "1.7.2": [
    "跳转页地址可在系统设置中修改",
    "设置保存在本机，重启和升级都保留",
    "二维码每次打开都会使用最新地址",
  ],
  "1.7.1": [
    "经典皮肤加深，各皮肤按钮分别适配",
    "左对齐页头的功能按钮跟着靠左",
    "手机访问弹层补充跳转页说明",
  ],
  "1.7.0": [
    "下一件推荐可以直接勾掉完成",
    "今日已投入旁增加补记入口",
  ],
  "1.6.0": [
    "跨天任务统计现在会计入整个实例的工时",
    "计时和完成增加防重，连点不会重复记账",
    "日历单击只看详情，取消排期改用明确按钮",
    "备份可在页面内恢复，覆盖前自动留回滚点",
  ],
  "1.5.4": [
    "修复：从对端更新时中文文件（使用说明、更新日志、bat）下载 404，更新源路由补 URL 解码",
  ],
  "1.5.3": [
    "修复：备份满 7 份时，刚做的「同步覆盖前」备份可能被立刻清掉（手动备份文件名排序误导清理逻辑）",
  ],
  "1.5.2": [
    "修复：设置页的「局域网同步」「自动更新」卡片按钮消失、显示一串 [object ...] 乱码的问题",
  ],
  "1.5.1": [
    "从对端更新：两台电脑同局域网时，可直接把另一台 pace 当更新源，不用连 GitHub",
    "自动更新支持临时换源：检查/应用时都能指定 base URL",
  ],
  "1.5.0": [
    "自动更新：可从 GitHub Pages 更新源检查并下载新版，自动备份旧文件，app.py 更新后重启即生效",
    "开发机保险：文件夹里有 DEV-NO-UPDATE 时自动更新会被禁用，避免开发中的自己被线上版本覆盖",
  ],
  "1.4.0": [
    "局域网同步：设置页填对端地址，即可在两台电脑间拉取/推送整库，换电脑前推一下、换电脑后拉一下",
    "同步前会自动备份，方向错了会拦：不会用旧数据覆盖新数据",
  ],
  "1.3.0": [
    "手机访问：页头「手机访问」点开二维码，扫一扫自动登记地址并跳转，换网络也不怕",
    "可以「添加到主屏幕」了：手机/电脑桌面多个像素女仆图标，点图标直接进",
  ],
  "1.2.4": [
    "安全线也按剩余来：一次性任务已做的工时不再重复收，推荐和安全线永远同数",
  ],
  "1.2.3": [
    "下一件推荐也按剩余来：已做的工时从预估里扣，做满没勾的自动退出推荐",
  ],
  "1.2.2": [
    "提前窗口里的重复任务按天均摊：90m 提前 5 天不再每天背一整份，括号提示今天建议量",
    "周期重复按剩余预估结算：本期已做的工时不重复催",
  ],
  "1.2.1": [
    "重复任务挪了排期以挪的为准：规则日不再硬冒出来，挪到哪天算哪天",
  ],
  "1.2.0": [
    "移除滴答清单集成，重复任务用本地规则就够",
  ],
  "1.1.0": [
    "新重复：每N周一次、每月第N个工作日",
    "提前勾掉重复任务，下一件不再落回本期",
  ],
  "1.0.2": [
    "没勾的日常不再失踪，自动顺延到今天",
  ],
  "1.0.1": [
    "计时条显示项目名，多线并行不分错",
    "深色皮肤日期选择看得清了",
    "提前量任务的日历虚影补上了",
  ],
  "1.0.0": [
    "正式版：四个 beta 功能全部定型",
    "六套界面皮肤，设置里下拉即换",
    "日目标和安全线两种达标挑战",
    "今日任务按必做和日常重复分组",
    "挂起自动清空 due 和排期",
  ],
};
const WN_SEEN_KEY = "pace_whatsnew_seen";

const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// 图标：全部来自 index.html 的 <symbol> sprite，描边款吃 currentColor 跟按钮字色走，
// 填充款（play/stop/pause/more 等）在 sprite 里自己声明了 fill。换皮肤只改 token。
// 名字对应旧字符：play=▶ stop=⏹ pause=⏸ check=☐/✓ undo=↩ file=📄 pencil=✏️
// more=⋯ trash=🗑 copy=⧉ up/down=▲▼ repeat=🔁 loop=🌀 flag=🏁 x=✕
function icon(name, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ic" + (cls ? " " + cls : ""));
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

// 下拉框处于默认/未选状态时显示浅灰字，提示这个框是干什么的
function selPH(sel, emptyVal = "") {
  const sync = () => sel.classList.toggle("sel-empty", sel.value === String(emptyVal));
  sel.addEventListener("change", sync);
  sync();
}

function fmt(min) {
  min = Math.round(min || 0);
  if (min <= 0) return "0m";
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
}

function dstr(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// 预估分钟：null = 暂无预估（不占安全线），显示成文字而不是 0m/NaN
function fmtEst(min) {
  return min == null ? "无预估" : fmt(min);
}

// 图例色块：■ 用传入的颜色，和后面对应的柱子/轨道段保持一致
function legendChip(color, text) {
  const item = el("span", "legend-chip");
  const dot = el("span", "legend-dot");
  dot.style.background = color;
  item.append(dot, text);
  return item;
}

async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  // 先解析再判状态：服务端崩在半路时响应体是空的，res.json() 直接抛，
  // 用户看到的会是「Unexpected end of JSON input」这种英文，不如自己给一句人话
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("服务器没有正常响应，请重试");
  }
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

// 重启之后等页面重新连上：一直轮询到拿到一份合法 state 为止。
// 重启期间「连不上」是正常现象（旧进程已经关了、新的还在 bind），所以这期间
// 不报错；只有等到超时才认失败，并把最后一次的原因说清楚。
async function waitServerBack(totalMs = 30000) {
  const t0 = Date.now();
  let lastErr = "";
  while (Date.now() - t0 < totalMs) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        if (d && d.version) return d;
      }
      lastErr = `服务回来了但状态不对（HTTP ${res.status}）`;
    } catch {
      lastErr = "连不上本地服务";
    }
  }
  throw new Error(`重启后等不到服务（${lastErr || "超时"}）`);
}

async function refresh() {
  state = await api("/api/state");
  calOcc = {};  // 数据变了，日历投影缓存作废
  $(".subtitle").textContent =
    `每天推进一点点，事事都能有着落 · v${state.version}`;
  const lanLine = $("#lan-line");
  // 用运行态地址而不是配置：关了开关但还没重启时，页面确实还能被手机打开，
  // 这时候把那行藏掉等于骗人，得写明「现在仍开放、重启后关闭」
  const lanUrl = state.lan_url_runtime !== undefined ? state.lan_url_runtime : state.lan_url;
  if (lanUrl) {
    lanLine.textContent = `📱 手机连同一 Wi-Fi 访问：${lanUrl}` +
      (state.lan_restart_pending && state.lan_access === false ? "（已保存、待重启；现在仍开放局域网）" : "");
    lanLine.classList.remove("hidden");
  } else if (state.lan_restart_pending) {
    lanLine.textContent = "📱 局域网访问：已保存，重启后生效";
    lanLine.classList.remove("hidden");
  } else {
    lanLine.classList.add("hidden");
  }
  renderTimer();
  render();
}

/* ── 计时条 ─────────────────────────── */

function renderTimer() {
  const bar = $("#timerbar");
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  const t = state.active_timer;
  if (!t) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  // 带上项目名：同名的例行任务（如各项目的 QC）只看标题分不清在计哪条线
  const proj = (state.projects || []).find(p => p.id === t.project_id);
  $("#timer-title").textContent = (proj ? proj.name + " · " : "") + (t.task_title || "未命名任务");
  // 手动按本地时间解析：部分老手机浏览器把无时区的 ISO 时间当 UTC，会导致计时恒为 00:00
  const tm = String(t.start_at).match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/);
  const start = tm
    ? new Date(+tm[1], +tm[2] - 1, +tm[3], +tm[4], +tm[5], +tm[6])
    : new Date(t.start_at);
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    $("#timer-elapsed").textContent =
      (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + String(ss).padStart(2, "0");
  };
  tick();
  tickHandle = setInterval(tick, 1000);
}

/* ── 共用 ───────────────────────────── */

function parseDayList(v) {
  if (v === null || v === undefined || v === "") return [];
  return String(v).split(",").map(Number).filter(n => !isNaN(n));
}

function repeatControls(t = {}) {
  // 模式整合："" 一次性；"daily"/"workdays" 日常（每天/每工作日自动出现，不占安全线）；
  // "weekly"/"interval_weekly"/"monthly"/"monthly_week"/"monthly_workday" 重复实例（勾掉生成下一件，计入安全线）
  const REPEAT_MODES = ["weekly", "interval_weekly", "monthly", "monthly_week", "monthly_workday"];
  let mode = "";
  if (REPEAT_MODES.includes(t.repeat_type)) mode = t.repeat_type;
  else if (t.routine && t.workday_only) mode = "workdays";
  else if (t.routine) mode = "daily";
  const sel = el("select");
  sel.title = "重复模式";
  for (const [v, label] of [
    ["", "不重复（一次性）"],
    ["daily", "每天（日常）"],
    ["workdays", "每个工作日（日常）"],
    ["weekly", "每周…"],
    ["interval_weekly", "每N周的周几…"],
    ["monthly", "每月几号…"],
    ["monthly_week", "每月第N个周几…"],
    ["monthly_workday", "每月第N个工作日…"],
  ]) {
    const o = el("option", null, label);
    o.value = v;
    sel.append(o);
  }
  sel.value = mode;
  selPH(sel);
  // 每月第N个周几/工作日：序数（周几类型另有单选星期）
  const ordSel = el("select");
  for (const [v, label] of [[1, "第1个"], [2, "第2个"], [3, "第3个"], [4, "第4个"], [5, "第5个"], [-1, "最后一个"]]) {
    const o = el("option", null, label);
    o.value = v;
    ordSel.append(o);
  }
  ordSel.value = t.repeat_ordinal || 1;
  const wdSel2 = el("select");
  ["一", "二", "三", "四", "五", "六", "日"].forEach((label, i) => {
    const o = el("option", null, "周" + label);
    o.value = i;
    wdSel2.append(o);
  });
  wdSel2.value = parseDayList(t.repeat_weekday)[0] ?? 0;
  // 每N周：间隔周数
  const intL = el("label");
  intL.style.alignSelf = "center";
  intL.title = "每隔几周来一次：2 = 两周一次，以排期/due 所在周为起始周";
  const intI = el("input");
  intI.type = "number"; intI.min = "1"; intI.max = "52"; intI.step = "1";
  intI.value = t.repeat_interval || 2;
  intI.style.width = "56px";
  intL.append(document.createTextNode("每 "), intI, document.createTextNode(" 周"));
  // 每周：星期多选（可勾多天）
  const wdWrap = el("span", "wd-chips");
  const wdState = new Set(parseDayList(t.repeat_weekday));
  ["一", "二", "三", "四", "五", "六", "日"].forEach((label, i) => {
    const c = el("button", "wd-chip", label);
    c.type = "button";
    if (wdState.has(i)) c.classList.add("on");
    c.onclick = (e) => {
      e.preventDefault();
      if (wdState.has(i)) { wdState.delete(i); c.classList.remove("on"); }
      else { wdState.add(i); c.classList.add("on"); }
    };
    wdWrap.append(c);
  });
  // 每月：几号，逗号分隔可多选
  const mdInit = parseDayList(t.repeat_monthday);
  const mdInput = el("input");
  mdInput.type = "text";
  mdInput.placeholder = "几号,如 1,15";
  mdInput.value = mdInit.length ? mdInit.join(",") : "";
  mdInput.style.width = "110px";
  mdInput.title = "每月几号，可多选用逗号分隔，如 1,15";
  const skipL = el("label");
  skipL.style.alignSelf = "center";
  const skipC = el("input"); skipC.type = "checkbox"; skipC.checked = !!t.skip_holiday;
  skipL.append(skipC, document.createTextNode(" 跳过法定节假日"));
  // 提前几天开始：0 = 仅当天可做；留空 = 不限（一到 due 就全额摊进来）
  const leadL = el("label");
  leadL.style.alignSelf = "center";
  leadL.title = "提前几天进今日建议和安全线：0 = 仅当天可做，留空 = 不限";
  const leadI = el("input");
  leadI.type = "number"; leadI.min = "0"; leadI.step = "1";
  leadI.placeholder = "0=仅当天，空=不限";
  leadI.style.width = "150px";
  leadI.value = t.same_day ? "0" : (t.lead_days ?? "");
  leadL.append(document.createTextNode("提前"), leadI, document.createTextNode(" 天开始"));
  const isRepeat = () => REPEAT_MODES.includes(sel.value);
  const readLead = () => {
    const raw = leadI.value.trim();
    if (!isRepeat() || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  const syncUI = () => {
    const v = sel.value;
    wdWrap.classList.toggle("hidden", v !== "weekly" && v !== "interval_weekly");
    intL.classList.toggle("hidden", v !== "interval_weekly");
    mdInput.classList.toggle("hidden", v !== "monthly");
    ordSel.classList.toggle("hidden", v !== "monthly_week" && v !== "monthly_workday");
    wdSel2.classList.toggle("hidden", v !== "monthly_week");
    // 第N个工作日本身就是按工作日历算的，跳节假日勾选对它无意义
    skipL.classList.toggle("hidden", !isRepeat() || v === "monthly_workday");
    leadL.classList.toggle("hidden", !isRepeat());
  };
  sel.onchange = syncUI;
  const wrap = el("span", "form-row");
  wrap.append(sel, wdWrap, intL, mdInput, ordSel, wdSel2, skipL, leadL);
  syncUI();
  return {
    wrap,
    read: () => {
      const v = sel.value;
      return {
        routine: v === "daily" || v === "workdays",
        workday_only: v === "workdays",
        repeat_type: isRepeat() ? v : null,
        repeat_weekdays: v === "weekly" || v === "interval_weekly" ? [...wdState].sort((a, b) => a - b) : null,
        repeat_interval: v === "interval_weekly" ? Math.max(1, Math.floor(Number(intI.value) || 2)) : null,
        repeat_monthdays: v === "monthly"
          ? mdInput.value.split(/[,，\s]+/).map(Number).filter(n => n >= 1 && n <= 31) : null,
        repeat_weekday: v === "monthly_week" ? Number(wdSel2.value) : null,
        repeat_ordinal: v === "monthly_week" || v === "monthly_workday" ? Number(ordSel.value) : null,
        skip_holiday: isRepeat() && v !== "monthly_workday" && skipC.checked,
        lead_days: readLead(),
        same_day: readLead() === 0,
      };
    },
  };
}

function repeatLabel(t) {
  if (!t.repeat_type) return "";
  const wd = ["一", "二", "三", "四", "五", "六", "日"];
  const ORD = { "1": "第1个", "2": "第2个", "3": "第3个", "4": "第4个", "5": "第5个", "-1": "最后一个" };
  let s;
  if (t.repeat_type === "daily") s = "每天";
  else if (t.repeat_type === "weekly") {
    const l = parseDayList(t.repeat_weekday);
    s = "每周" + (l.length ? l.map(i => wd[i]).join("/") : "（完成日的星期）");
  } else if (t.repeat_type === "interval_weekly") {
    const l = parseDayList(t.repeat_weekday);
    s = `每${t.repeat_interval || 2}周` + (l.length ? l.map(i => wd[i]).join("/") : "");
  } else if (t.repeat_type === "monthly_week") {
    const ord = ORD[t.repeat_ordinal || 1];
    const w = parseDayList(t.repeat_weekday)[0] ?? 0;
    s = `每月${ord}周${wd[w]}`;
  } else if (t.repeat_type === "monthly_workday") {
    s = `每月${ORD[t.repeat_ordinal || 1]}工作日`;
  } else {
    const l = parseDayList(t.repeat_monthday);
    s = "每月" + (l.length ? l.join("/") + "号" : "（完成日的号数）");
  }
  return s + (t.skip_holiday ? "·跳节假日" : "");
}

// 预估分钟组件：数字框 + 「无预估」勾选。新建和编辑共用同一套语义——
// 留空 = 按 45 分钟，无预估只能靠勾选表达
function estimateField(t) {
  const wrap = el("span", "est-field");
  const iEst = el("input");
  iEst.type = "number"; iEst.min = "1";
  iEst.placeholder = "分钟，留空按 45";
  iEst.title = "留空按 45 分钟；勾「无预估」= 暂无预估（不占安全线）";
  const lab = el("label");
  const cb = el("input");
  cb.type = "checkbox";
  lab.append(cb, document.createTextNode(" 无预估"));
  const none = t ? t.estimate_min == null : false;
  cb.checked = none;
  iEst.value = none ? "" : ((t && t.estimate_min) || "");
  iEst.disabled = none;
  cb.onchange = () => {
    if (cb.checked) iEst.value = "";
    iEst.disabled = cb.checked;
  };
  wrap.append(iEst, lab);
  return {
    wrap,
    // 新建：勾选 = null；留空 = 不传该字段，后端按 45 兜底
    forCreate: () => (cb.checked ? null : (Number(iEst.value) || undefined)),
    // 编辑：后端「不传字段」= 不动原值，所以留空要显式提交 45
    forUpdate: () => (cb.checked ? null : (Number(iEst.value) || 45)),
    reset: () => { cb.checked = false; iEst.disabled = false; iEst.value = ""; },
  };
}

function taskEditForm(t) {
  const row = el("div", "form-row");
  row.style.padding = "8px 2px";
  const iTitle = el("input"); iTitle.type = "text"; iTitle.value = t.title;
  iTitle.title = "改名会重置该任务的校准记录（结算按「项目 + 标题」认同一件任务）";
  const est = estimateField(t);
  const iDue = el("input"); iDue.type = "date"; iDue.value = t.due_date || "";
  iDue.title = t.suspended
    ? "挂起中：due 已失效；在这里设新日期，恢复后按它生效"
    : "due date";
  const iPrio = el("select");
  iPrio.title = "优先级";
  for (const [v, label] of [[0, "无优先级"], [5, "🔴高"], [3, "🟡中"], [1, "⚪低"]]) {
    const o = el("option", null, label);
    o.value = v;
    iPrio.append(o);
  }
  iPrio.value = t.priority || 0;
  selPH(iPrio, 0);
  const iTags = el("input");
  iTags.type = "text";
  iTags.placeholder = "标签，用逗号隔开，如 qc, 检索";
  iTags.title = "标签：用来归类算均次耗时（逗号或空格分隔，多个标签都算）";
  iTags.value = tagList(t).join(", ");
  iTags.style.minWidth = "9em";
  const save = el("button", "btn-primary", "保存");
  const rep = repeatControls(t);
  // 详情：多行、整行宽、在字段行和按钮之间（手机上也是一整块，不会挤成一条）
  const iDetail = el("textarea", "detail-input");
  iDetail.rows = 3;
  iDetail.placeholder = "详情（可选）：背景 / 要求 / 链接 / 下一步，可多行";
  iDetail.title = "这件事本身的说明，会跟着任务走（复制、日常/重复的下一件都继承）；"
    + "和工时备注不是一回事，备注记的是某一次干了什么";
  iDetail.value = t.detail || "";
  const dWrap = el("div", "detail-edit");
  dWrap.append(iDetail);
  save.onclick = () => act(() => api(`/api/tasks/${t.id}`, "POST", {
    title: iTitle.value,
    detail: iDetail.value,
    estimate_min: est.forUpdate(),
    due_date: iDue.value,
    priority: Number(iPrio.value),
    tags: iTags.value, ...rep.read(),
  }));
  const cancel = el("button", null, "取消");
  cancel.onclick = () => render();
  row.append(iTitle, est.wrap, iDue, iPrio, iTags, dWrap, save, cancel);
  const outer = el("div");
  outer.append(row, rep.wrap);
  return outer;
}

function allTasks() {
  const out = [];
  for (const p of state.projects)
    for (const t of p.tasks) out.push({ ...t, project: p });
  return out;
}

// 挂起的是「等回复/暂时推不动」的事：留在项目卡里看得见，但不进今日排期、
// 逾期、日历、任务池，也不算件数——排了也做不到，只会让今天看起来永远做不完
function activeTasks() {
  return allTasks().filter(t => !t.suspended);
}

function isLoopTask(t) {
  return !!(t.routine || t.repeat_type);
}

// 挂了几天没跟进：按真实日算（跟 state.today、逾期判定同一口径）。
// 老数据可能只标了 suspended 没有 suspended_at，返回 null 让界面写「—」而不是崩
function suspendedDays(t) {
  if (!t.suspended_at) return null;
  const ms = Date.parse(state.today + "T00:00:00") - Date.parse(t.suspended_at + "T00:00:00");
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 86400000));
}

// 「已挂起 N 天」统一文案：项目卡的挂起区和今日页「等待回复」用同一口径
function suspendedAgo(t) {
  const d = suspendedDays(t);
  return d === null ? "已挂起 —" : `已挂起 ${d} 天`;
}

// 项目前缀开关开启时，任务名显示为「项目-任务」
function dispTitle(t, p) {
  return (state && state.show_project_prefix && p) ? `${p.name}-${t.title}` : t.title;
}

// 按 id 反查任务：今日建议只带 task_id，编辑和跳转都要拿原任务对象
function findTaskById(id) {
  for (const p of state.projects) {
    for (const t of p.tasks) if (t.id === id) return { t, p };
    for (const t of (p.done_tasks || [])) if (t.id === id) return { t, p };
  }
  return null;
}

/* ── 行尾操作（窄屏收起） ─────────────── */

// 行尾按钮：宽屏全部平铺（display:contents，外观跟以前一模一样）；窄屏只留
// 主操作 + ⋯，其余收进整行宽的竖排菜单——手机上行尾键多了会挤爆换行
// spec = { icon, label, title, cls, primary, onClick }
function rowActions(specs) {
  const wrap = el("span", "row-actions");
  const menu = el("span", "row-menu");
  const primaries = [];
  for (const s of specs) {
    if (s.primary) continue;
    const b = el("button", "btn-check row-menu-item");
    b.append(icon(s.icon), el("span", "lbl", s.label));
    b.title = s.title || s.label;
    b.setAttribute("aria-label", s.title || s.label);
    b.onclick = (e) => { e.stopPropagation(); closeRowMenus(); s.onClick(); };
    menu.append(b);
  }
  for (const s of specs) {
    if (!s.primary) continue;
    const b = el("button", s.cls || "btn-check");
    b.append(icon(s.icon));
    b.title = s.title || s.label;
    b.setAttribute("aria-label", s.title || s.label);
    b.onclick = (e) => { e.stopPropagation(); s.onClick(); };
    primaries.push(b);
  }
  // DOM 顺序 = 次要项、主操作、⋯：宽屏（菜单平铺、⋯ 隐藏）出来就是原来的
  // 「pencil copy trash pause play check」，窄屏隐藏次要项后正好剩「play check more」
  wrap.append(menu);
  for (const b of primaries) wrap.append(b);
  if (menu.children.length) {
    const more = el("button", "btn-more");
    more.append(icon("more"));
    more.title = "更多操作";
    more.setAttribute("aria-label", "更多操作");
    more.onclick = (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains("open");
      closeRowMenus(menu);
      menu.classList.toggle("open", open);
      more.classList.toggle("open", open);
    };
    wrap.append(more);
  }
  return wrap;
}

function closeRowMenus(keep) {
  document.querySelectorAll(".row-menu.open").forEach((m) => {
    if (m === keep) return;
    m.classList.remove("open");
    const more = m.parentElement && m.parentElement.querySelector(".btn-more");
    if (more) more.classList.remove("open");
  });
}

// 点别处收起行内菜单
document.addEventListener("click", (e) => {
  if (!e.target.closest(".row-actions")) closeRowMenus();
});

// 计时键：这件正在计时就变 ⏹（停止），否则 ▶（开始）
function timerAction(taskId) {
  const timing = state.active_timer && state.active_timer.task_id === taskId;
  return timing
    ? { icon: "stop", label: "停止计时", title: "停止计时（只记工时，不勾掉任务）",
        cls: "btn-check btn-timing", primary: true,
        onClick: () => act(() => api("/api/timer/stop", "POST")) }
    : { icon: "play", label: "开始计时", title: "开始计时", cls: "btn-play", primary: true,
        onClick: () => act(() => api("/api/timer/start", "POST", { task_id: taskId })) };
}

/* ── 复制任务 ──────────────────────── */

// 副本标题：同名会撞车，加「副本」后缀；已有副本再复制就往后编号
function copyTitle(t, p) {
  const base = (t.title || "").replace(/（副本\d*）$/, "");
  const taken = new Set(((p && p.tasks) || []).map(x => x.title));
  let title = `${base}（副本）`;
  for (let i = 2; taken.has(title); i++) title = `${base}（副本${i}）`;
  return title;
}

// 用新建任务接口复制：项目/预估/优先级/due/排期/重复配置全套带过去
function copyTask(t, p) {
  const body = {
    project_id: p.id,
    title: copyTitle(t, p),
    // 详情跟着副本走：多半就是同一件事换个周期再做一遍，说明还得看
    detail: t.detail || "",
    // 显式带上 null：没预估的副本还是没预估，别让后端按「没传」补成 45
    estimate_min: t.estimate_min ?? null,
    priority: t.priority || 0,
    due_date: t.due_date || "",
    scheduled_date: t.scheduled_date || "",
    routine: !!t.routine,
    workday_only: !!t.workday_only,
    tags: t.tags || "",
  };
  if (["weekly", "interval_weekly", "monthly", "monthly_week", "monthly_workday"].includes(t.repeat_type)) {
    body.repeat_type = t.repeat_type;
    body.repeat_weekdays = parseDayList(t.repeat_weekday);
    body.repeat_monthdays = parseDayList(t.repeat_monthday);
    body.repeat_weekday = t.repeat_weekday;
    body.repeat_ordinal = t.repeat_ordinal;
    body.repeat_interval = t.repeat_interval;
    body.skip_holiday = !!t.skip_holiday;
    body.lead_days = t.same_day ? 0 : (t.lead_days ?? null);
  }
  return api("/api/tasks", "POST", body);
}

function tagList(t) {
  const raw = t && t.tags;
  if (!raw) return [];
  return String(raw).split(",").map(x => x.trim()).filter(Boolean);
}

// 任务行尾的 #标签 小胶囊。没有标签就返回 null，调用方自己判空
function tagChips(t, cls = "tag-chip") {
  const tags = tagList(t);
  if (!tags.length) return null;
  const box = el("span", cls);
  for (const tg of tags) box.append(el("span", "tag-one", "#" + tg));
  return box;
}

/* ── 任务详情（多行） ────────────────── */

// 详情和工时备注是两回事：note 记「这一次干了什么」的流水，detail 是这件事本身
// 长期有效的说明（背景 / 要求 / 链接 / 下一步），会跟着任务走、复制和循环都继承。
// 有详情就在行首给一个 📄，点开在行下面就地铺开——手机上也点得到、读得清，
// 不靠 hover 提示（触屏没有 hover）。
function detailBlock(t, row) {
  const box = el("div", "task-detail");
  for (const line of String(t.detail || "").split("\n"))
    box.append(el("div", "task-detail-line", line || " "));
  const close = el("button", "link-btn task-detail-close", "收起");
  close.type = "button";
  close.onclick = (e) => { e.stopPropagation(); box.remove(); row.classList.remove("detail-open"); };
  box.append(close);
  return box;
}

function toggleDetail(row, t) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains("task-detail")) {
    next.remove();
    row.classList.remove("detail-open");
    return;
  }
  row.classList.add("detail-open");
  row.after(detailBlock(t, row));
}

function taskRow(t, p, { showProject = false, playable = true, deletable = false, editable = false, copyable = false, backable = false, estHint = null } = {}) {
  const row = el("div", "task-row");
  const dot = el("span", "dot");
  dot.style.background = p.color;
  row.append(dot);
  const title = el("span", "task-title");
  if (t.routine) title.append(icon("loop", "ic-routine"));
  title.append(document.createTextNode(dispTitle(t, p)));
  row.append(title);
  const metaBits = [];
  if (showProject && !state.show_project_prefix) metaBits.push(p.name);
  metaBits.push(fmtEst(t.estimate_min) + (estHint ? `（今天约 ${estHint}）` : ""));
  if (t.priority) metaBits.push({ 5: "🔴高", 3: "🟡中", 1: "⚪低" }[t.priority]);
  if (t.workday_only) metaBits.push("工作日");
  if (t.same_day) metaBits.push("仅当天");
  else if (t.lead_days > 0) metaBits.push("提前" + t.lead_days + "天");
  const rep = repeatLabel(t);
  if (rep) metaBits.push(rep);
  if (t.due_date) {
    const overdue = t.due_date < state.today;
    metaBits.push((overdue ? "逾期 " : "due ") + t.due_date.slice(5));
  }
  row.append(el("span", "task-meta", metaBits.join(" · ")));
  const chips = tagChips(t);
  if (chips) row.append(chips);
  const acts = [];
  if (t.detail) acts.push({ icon: "file", label: "详情", primary: true,
    title: "查看详情（背景 / 要求 / 链接 / 下一步）",
    onClick: () => toggleDetail(row, t) });
  if (editable) acts.push({ icon: "pencil", label: "编辑", title: "编辑任务",
    onClick: () => row.replaceWith(taskEditForm(t)) });
  if (copyable) acts.push({ icon: "copy", label: "复制任务", title: "复制任务（同项目、同预估/due/重复配置，标题加「副本」）",
    onClick: () => act(() => copyTask(t, p)) });
  if (deletable) acts.push({ icon: "trash", label: "删除", title: "删除任务",
    onClick: () => {
      if (confirm(`删除「${t.title}」？`))
        act(() => api(`/api/tasks/${t.id}/delete`, "POST"));
    } });
  if (!t.suspended && !isLoopTask(t)) acts.push({ icon: "pause", label: "挂起",
    title: "挂起：等回复/暂时不推进，移出今日建议和安全线（due 和排期会失效清空，恢复时重新设置）",
    onClick: () => act(() => api(`/api/tasks/${t.id}`, "POST", { suspended: true })) });
  if (backable) acts.push({ icon: "undo", label: "退回导入池", title: "退回导入池", primary: false,
    onClick: () => act(() => api(`/api/tasks/${t.id}`, "POST", { project_id: null })) });
  if (playable) acts.push(timerAction(t.id));
  acts.push({ icon: "check", label: "完成", title: "勾掉这件（日常/重复会自动长下一件）", primary: true,
    onClick: () => act(() => api(`/api/tasks/${t.id}/toggle`, "POST")) });
  row.append(rowActions(acts));
  return row;
}

// 挂起中的任务行：项目卡的「挂起中」区和今日页「等待回复」块共用这一套，
// 两处天数口径才不会各说各话。挂太久的（≥3 天）给浅橙提醒，扫一眼就知道该催谁
function suspendedRow(t, p, { showProject = false } = {}) {
  const row = el("div", "task-row suspended-row");
  const dot = el("span", "dot");
  dot.style.background = p.color;
  row.append(dot);
  const title = el("span", "task-title");
  if (t.routine) title.append(icon("loop", "ic-routine"));
  title.append(document.createTextNode(dispTitle(t, p)));
  row.append(title);
  const bits = [];
  if (showProject && !state.show_project_prefix) bits.push(p.name);
  bits.push(fmtEst(t.estimate_min));
  bits.push(suspendedAgo(t));
  // 挂起期间 due / 排期已失效（后端挂起时清空），这里不再展示，免得刷出没意义的「逾期」
  const meta = el("span", "task-meta", bits.join(" · "));
  const days = suspendedDays(t);
  if (days !== null && days >= 3) meta.classList.add("stale");
  row.append(meta);
  const chips = tagChips(t);
  if (chips) row.append(chips);
  row.append(rowActions([
    { icon: "pencil", label: "编辑", title: "编辑任务",
      onClick: () => row.replaceWith(taskEditForm(t)) },
    { icon: "undo", label: "恢复", title: "恢复：移回台面，重新进今日建议和安全线；due 已失效，记得重新设置", primary: true,
      onClick: () => act(() => api(`/api/tasks/${t.id}`, "POST", { suspended: false })) },
  ]));
  return row;
}

/* ── 今日 ───────────────────────────── */

function renderToday(root) {
  const total = state.total_safety_min;
  const invested = state.total_invested_min;
  const target = state.daily_target_min || 480;

  const tasks = activeTasks();
  const byPrio = (a, b) => (b.priority || 0) - (a.priority || 0);
  const pendingLoopIds = new Set((state.routine_pending || []).map(x => x.task_id));
  const dueOrOverdue = t => t.due_date && t.due_date <= state.today;
  const autoRoutineToday = t => t.routine && !t.scheduled_date
    && (!t.workday_only || state.today_is_workday);
  // 前两组与 hero 一样不含「不计工时」项目；那些任务收在其他今日任务里，不会消失。
  const mustToday = tasks.filter(t => !t.project.no_track && !isLoopTask(t) && dueOrOverdue(t))
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || byPrio(a, b));
  const repeatToday = tasks.filter(t => !t.project.no_track && isLoopTask(t)
    && (pendingLoopIds.has(t.id) || t.scheduled_date === state.today
      || dueOrOverdue(t) || autoRoutineToday(t))).sort(byPrio);
  const grouped = new Set([...mustToday, ...repeatToday]);
  const otherToday = tasks.filter(t => !grouped.has(t)
    && (pendingLoopIds.has(t.id) || t.scheduled_date === state.today
      || dueOrOverdue(t) || autoRoutineToday(t))).sort(byPrio);
  const hiddenWorkday = tasks.filter(t => t.routine && !t.scheduled_date && t.workday_only
    && !state.today_is_workday && !pendingLoopIds.has(t.id) && !dueOrOverdue(t)).length;

  const h = new Date().getHours();
  const greet = h < 6 ? "夜深了" : h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
  const gCard = el("div", "greeting");
  const n = mustToday.length + repeatToday.length + otherToday.length;
  gCard.append(el("div", "greet-main", `${greet} · 今天有 ${n} 件事，已完成 ${state.done_today_count} 件`));
  const challengeList = el("div", "challenges");
  challengeList.setAttribute("aria-label", "达标挑战");
  const addChallenge = (name, iconName, days, met, goal, neutral = false) => {
    const item = el("div", "challenge" + (met ? " is-met" : "") + (neutral ? " is-neutral" : ""));
    const remaining = Math.max(0, goal - invested);
    item.title = neutral
      ? `${name} ${fmt(goal)} · 今日无需求，连续天数不变`
      : `${name} ${fmt(goal)} · 今日已投入 ${fmt(invested)} · `
        + (met ? "今日已达标" : `还差 ${fmt(remaining)}`);
    item.append(icon(iconName), el("span", "challenge-label", `${name} · 连续`),
      el("strong", "challenge-days", `${days} 天`),
      el("span", "challenge-state", neutral ? "今日不计数" : met ? "已达标" : `还差 ${fmt(remaining)}`));
    challengeList.append(item);
  };
  addChallenge("日目标", "target", state.target_streak_days ?? state.streak_days ?? 0,
    state.target_met_today ?? invested >= target, target);
  addChallenge("安全线", "flag", state.safety_streak_days ?? 0,
    state.safety_met_today ?? invested >= total, total, state.safety_skipped_today ?? (total === 0));
  gCard.append(challengeList);
  root.append(gCard);

  const hero = el("div", "card hero");
  hero.append(el("div", "label", "今天至少投入"));
  hero.append(el("div", "big-number", fmt(total)));
  const routineMin = Math.max(0, state.total_routine_today_min || 0);
  // 今天投在日常/重复（loop）任务上的部分，剩下算项目推进
  const routineInv = Math.min(invested, Math.max(0, state.today_routine_invested_min || 0));
  if (routineMin > 0) {
    hero.append(el("div", "label",
      `含日常·重复 ${fmt(routineMin)} · 项目推进 ${fmt(Math.max(0, total - routineMin))}`));
  }
  // 刻度基准只认日目标和实际投入：横条的尽头永远是日目标，安全线只是条上的一根刻度。
  // 安全线超过日目标时不许把条撑长（条比日目标长一截看着焦虑），超出的量改用文字 +
  // 边缘刻度提示说；invested 超过日目标时条跟着 invested 走——那是「干得多」，不焦虑。
  const span = Math.max(target, invested, 1);
  const pct = (v) => Math.min(100, (v / span) * 100);
  // 计划段宽度：累计封顶 100%。不溢出时和 pct(len) 完全相等（口径没变），
  // 溢出时画到条尾为止
  const segW = (from, len) => Math.max(0, Math.min(pct(len), 100 - pct(from)));
  // 安全线（或日常刻度）超到条外：位置 clamp 在条尾，差值只能写出来
  const overrun = total > span;
  const clampNote = (v) => (v > span ? `（超出条尾 ${fmt(v - span)}，条按 ${fmt(span)} 封顶）` : "");
  // 安全线刻度：被 clamp 到右端时加 clamped（加粗换色 + 标签带 ▸），
  // 让人看出它是被截在边上的，不是正好落在边上
  const addSafetyMarker = (track, extraCls) => {
    if (total <= 0) return;
    const marker = el("div", "safety-marker" + (extraCls ? " " + extraCls : ""));
    marker.style.left = pct(total) + "%";
    marker.title = `安全线 ${fmt(total)}` + clampNote(total);
    if (overrun) marker.classList.add("clamped");
    track.append(marker);
  };
  // 轨道 = 今日目标构成：浅灰绿 [0, 日常·重复]，浅棕褐 [日常·重复, 安全线]，之后是默认轨道色
  const trackRoutine = total > 0 ? Math.min(routineMin, total) : routineMin;
  if (state.show_dual_track !== false) {
    // 双轨（默认）：计划一条、实际一条，上下分开不互相叠压；两条共用同一把尺子
    hero.append(el("div", "track-label", "计划"));
    const planTrack = el("div", "safety-track dual-plan");
    if (trackRoutine > 0) {
      const rseg = el("div", "safety-routine");
      rseg.style.width = segW(0, trackRoutine) + "%";
      rseg.title = `计划·日常·重复 ${fmt(routineMin)}` + clampNote(trackRoutine);
      planTrack.append(rseg);
    }
    if (total > trackRoutine) {
      const pseg = el("div", "safety-project");
      pseg.style.left = segW(0, trackRoutine) + "%";
      pseg.style.width = segW(trackRoutine, total - trackRoutine) + "%";
      pseg.title = `计划·项目推进 ${fmt(total - trackRoutine)}` + clampNote(total);
      planTrack.append(pseg);
    }
    addSafetyMarker(planTrack);
    const planEnd = el("div", "safety-end");
    planEnd.style.left = pct(target) + "%";
    planEnd.dataset.label = `日目标 ${fmt(target)}`;
    planEnd.title = `日目标 ${fmt(target)}`;
    if (pct(target) > 82) planEnd.classList.add("at-end");
    planTrack.append(planEnd);
    hero.append(planTrack);

    hero.append(el("div", "track-label", "实际"));
    const actTrack = el("div", "safety-track dual-actual");
    if (routineInv > 0) {
      const fillR = el("div", "safety-fill");
      fillR.style.width = pct(routineInv) + "%";
      fillR.title = `实际·日常·重复 ${fmt(routineInv)}`;
      if (invested > routineInv) {
        fillR.style.borderTopRightRadius = "0";
        fillR.style.borderBottomRightRadius = "0";
      }
      actTrack.append(fillR);
    }
    if (invested > routineInv) {
      const fillP = el("div", "safety-fill-project");
      fillP.style.left = pct(routineInv) + "%";
      fillP.style.width = pct(invested - routineInv) + "%";
      fillP.title = `实际·项目推进 ${fmt(invested - routineInv)}`;
      actTrack.append(fillP);
    }
    // 实际条上的刻度只画竖线（不重复标签），和计划条的安全线/日目标上下对齐
    addSafetyMarker(actTrack, "tick-only");
    const actEnd = el("div", "safety-end tick-only");
    actEnd.style.left = pct(target) + "%";
    actEnd.title = `日目标 ${fmt(target)}`;
    if (pct(target) > 82) actEnd.classList.add("at-end");
    actTrack.append(actEnd);
    hero.append(actTrack);

    const dLegend = el("div", "bar-legend legend-row");
    dLegend.append(
      legendChip("rgba(127, 155, 120, .55)", "计划·日常"),
      legendChip("rgba(201, 184, 148, .65)", "计划·项目"),
      legendChip("#7a9b76", "实际·日常"),
      legendChip("#b3a37e", "实际·项目"),
      el("span", "legend-note", "｜ 竖线：安全线 · 日目标"));
    hero.append(dLegend);
  } else {
    // 单条叠合的老样式：show_dual_track 关掉时原样保留
    const track = el("div", "safety-track");
    if (routineMin > 0) {
      const rseg = el("div", "safety-routine");
      rseg.style.width = segW(0, trackRoutine) + "%";
      rseg.title = `日常·重复 ${fmt(routineMin)}` + clampNote(trackRoutine);
      track.append(rseg);
    }
    if (total > trackRoutine) {
      const pseg = el("div", "safety-project");
      pseg.style.left = segW(0, trackRoutine) + "%";
      pseg.style.width = segW(trackRoutine, total - trackRoutine) + "%";
      pseg.title = `项目推进 ${fmt(total - trackRoutine)}` + clampNote(total);
      track.append(pseg);
    }
    // 实际投入压在两段构成上：绿=日常/重复任务，棕=其它任务；超出安全线也沿用各自段色
    const fillSplit = routineMin > 0;
    const fillR = el("div", "safety-fill");
    fillR.style.width = pct(fillSplit ? routineInv : invested) + "%";
    fillR.title = fillSplit ? `日常·重复已投入 ${fmt(routineInv)}` : `已投入 ${fmt(invested)}`;
    track.append(fillR);
    if (fillSplit && invested > routineInv) {
      fillR.style.borderTopRightRadius = "0";
      fillR.style.borderBottomRightRadius = "0";
      const fillP = el("div", "safety-fill-project");
      fillP.style.left = pct(routineInv) + "%";
      fillP.style.width = pct(invested - routineInv) + "%";
      fillP.title = `项目推进已投入 ${fmt(invested - routineInv)}`;
      track.append(fillP);
    }
    addSafetyMarker(track);
    if (routineMin > 0) {
      // 日常·重复刻度：标签在轨道下侧（安全线在上侧），挨太近或贴右端就只留竖线
      const rtick = el("div", "routine-marker");
      const rtLeft = pct(routineMin);
      rtick.style.left = rtLeft + "%";
      rtick.title = `日常·重复量 ${fmt(routineMin)}` + clampNote(routineMin);
      if ((total > 0 && Math.abs(pct(total) - rtLeft) < 8)
        || Math.abs(pct(target) - rtLeft) < 8 || rtLeft > 88)
        rtick.classList.add("tick-only");
      track.append(rtick);
    }
    // 日目标刻度：靠右端就右对齐标签，免得文字溢出卡片
    const endMark = el("div", "safety-end");
    endMark.style.left = pct(target) + "%";
    endMark.dataset.label = `日目标 ${fmt(target)}`;
    endMark.title = `日目标 ${fmt(target)}`;
    if (pct(target) > 82) endMark.classList.add("at-end");
    track.append(endMark);
    hero.append(track);
    if (routineMin > 0) {
      const legend = el("div", "bar-legend legend-row");
      legend.append(legendChip("#7f9b78", "日常·重复（loop）"),
        legendChip("#c9b894", "项目推进（其它任务）"),
        el("span", "legend-note", "｜ 竖线：日常·重复量 · 安全线 · 日目标"));
      hero.append(legend);
    }
  }
  // 超预估 / 无预估有实际：只加角标，绿区宽度不跟着变，也不动 streak。
  // 只在动态结算开着时显示——关掉时绿区走纯预估，角标说的结算差异就不成立了
  const dynOn = state.dynamic_routine_settlement !== false;
  const overEst = state.routine_over_est_min || 0;
  const noestAct = state.routine_noest_actual_min || 0;
  // 省预估：动态结算下勾得比预估快，结算后安全线比纯预估短的部分。跟「超预估」
  // 是一对，一红一绿（这里吃的是 --ok），该夸的时候要夸
  const saveEst = dynOn ? Math.max(0,
    (state.routine_plan_min || 0) - (state.routine_settled_min || 0)) : 0;
  const settleTags = dynOn && (overEst > 0 || noestAct > 0 || saveEst > 0);
  if (settleTags || overrun) {
    const tags = el("div", "hero-tags");
    if (overrun) {
      // 条被日目标封顶，安全线多出来的分钟只能写出来；和下面那行「安全线超出日目标…」
      // 一个意思，只是挂在条尾旁边，一眼看到条有多长是到哪儿
      const tg = el("span", "over-run-tag", `▸ 安全线 +${fmt(total - span)} 超出条尾`);
      tg.title = `横条按日目标 ${fmt(span)} 封顶、不跟着安全线撑长；`
        + `安全线 ${fmt(total)} 比条尾多 ${fmt(total - span)}`;
      tags.append(tg);
    }
    if (overEst > 0 && dynOn) {
      const tg = el("span", "over-est-tag", `+${fmt(overEst)} 超预估`);
      tg.title = "勾掉的日常实际工时超过预估：绿区按预估封顶、不跟着扩，超出部分单独记这儿";
      tags.append(tg);
    }
    if (saveEst > 0) {
      const tg = el("span", "under-est-tag", `-${fmt(saveEst)} 省预估`);
      tg.title = "勾掉的日常比预估快：安全线按实际结算已经降了，省下的部分记这儿";
      tags.append(tg);
    }
    if (noestAct > 0 && dynOn) {
      const tg = el("span", "noest-tag", `含无预估 ${fmt(noestAct)}`);
      tg.title = "无预估的日常已经投了工时，但它不占安全线，单独标出来";
      tags.append(tg);
    }
    hero.append(tags);
  }
  // 必做只算 due 今天或已逾期的一次性任务；日常和周期重复独立占一行。
  const restCount = state.routine_pending_count || 0;
  const restMin = state.routine_pending_est_min || 0;
  const restNoest = state.routine_pending_noest_count || 0;
  const noactual = state.routine_done_noactual_count || 0;
  const mustCount = state.must_do_count || 0;
  const mustMin = state.must_do_est_min || 0;
  const mustNoest = state.must_do_noest_count || 0;
  const mustOverdue = state.must_do_overdue_count || 0;
  const pt = el("div", "progress-text progress-main");
  // 强弱色不传死颜色了，给 class 吃 --danger/--ok，皮肤里才能翻色、加描边
  const pstrong = (txt, cls) => {
    const s = el("span", "progress-strong", txt);
    if (cls) s.classList.add(cls);
    return s;
  };
  if (mustCount > 0) {
    pt.append("今日必做 ", pstrong(`${mustCount} 件`, "danger"));
    const notes = [];
    if (mustOverdue > 0) notes.push(`${mustOverdue} 件逾期`);
    if (mustNoest > 0) notes.push(`${mustNoest} 件无预估`);
    if (notes.length) pt.append(`（${notes.join(" · ")}）`);
    pt.append(" · 预估 ", pstrong(fmt(mustMin)));
  } else {
    pt.append("今日必做 ", pstrong("已清空", "ok"));
  }
  hero.append(pt);
  const repeatLine = el("div", "progress-text repeat-status");
  if (restCount > 0) {
    repeatLine.append(`日常·重复还剩 ${restCount} 件`);
    if (restNoest > 0) repeatLine.append(`（含 ${restNoest} 件无预估）`);
    repeatLine.append(` · 预估 ${fmt(restMin)}`);
  } else {
    repeatLine.append("日常·重复已清空");
  }
  hero.append(repeatLine);
  // 两种挑战都只认实际投入，不和必做清空混在一起；连续天数统一在顶部问候区显示。
  const investedLine = el("div", "progress-text invested-line");
  investedLine.append(el("span", null,
    `今日已投入 ${fmt(invested)} / 日目标 ${fmt(target)} · 两种挑战都按实际投入算`));
  const quickLog = el("button", "quick-log-btn", "补记");
  quickLog.type = "button";
  quickLog.title = "跳到本页底部补记工时";
  quickLog.setAttribute("aria-label", "跳到手动补记");
  quickLog.onclick = () => {
    const targetForm = document.querySelector("#tab-today .manual-log-card");
    if (!targetForm) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    targetForm.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    const minutes = document.getElementById("manual-log-minutes");
    if (minutes) minutes.focus({ preventScroll: true });
  };
  investedLine.append(quickLog);
  hero.append(investedLine);
  const gap = target - total;
  const gapEl = el("div", "progress-text");
  if (gap > 0) {
    gapEl.textContent = `安全线之外还有 ${fmt(gap)} 余量，可从池子多捞几件`;
    gapEl.classList.add("gap-ok");
  } else if (gap < 0) {
    gapEl.textContent = `安全线超出日目标 ${fmt(-gap)}，考虑顺延一些任务的 due`;
    gapEl.classList.add("gap-over");
  }
  if (gap !== 0) hero.append(gapEl);
  // 结算预览（只读，不参与判定）：动态结算开着时上面的数字已经是结算值，这里给纯预估
  // 的算法做对比；关着时反过来，算一遍「如果按实际结算」会是多少。
  // 只留对比本身：尾部原来还挂着上面那行大字的同款时长，重复，删掉
  const planMin = state.routine_plan_min || 0;
  const settledMin = state.routine_settled_min || 0;
  const diff = planMin - settledMin;   // >0 = 省，<0 = 多花
  // 省/多花跟上面剩余件数一样上色：省了给绿色好报，超了才红
  const diffTxt = diff > 0 ? `省 ${fmt(diff)}` : diff < 0 ? `多花 ${fmt(-diff)}` : "无差异";
  const diffCls = diff > 0 ? "ok" : diff < 0 ? "danger" : null;
  const sp = el("div", "settle-preview");
  if (dynOn) sp.append(`按纯预估对比：安全线 ${fmt(total + diff)} · 按实际结算`, pstrong(diffTxt, diffCls));
  else sp.append(`若按实际结算：安全线 ${fmt(Math.max(0, total - diff))} · 比纯预估`, pstrong(diffTxt, diffCls));
  if (!dynOn && noactual > 0) sp.append(` · ${noactual} 件未计时按预估算`);
  hero.append(sp);
  root.append(hero);

  // 今日建议：未来 due 的任务按轻重缓急折算今天该投的时间。按项目分组塞进
  //「各项目今日线」对应的项目卡里；找不到对应项目的（项目已删）落「其他建议」
  // 主建议和小额建议分开：小额 = 份额小、任务本身也不小、又还不着急的那些，
  // 折进「另有 N 件小额」。后端已经切好两份（main_plan / small_plan），
  // 老后端没有这两个字段就按 small 标记自己分
  const planAll = state.today_plan || [];
  const mainPlan = state.main_plan || planAll.filter((s) => !s.small);
  const smallPlan = state.small_plan || planAll.filter((s) => s.small);
  const planByProj = new Map();
  for (const s of mainPlan) {
    if (!planByProj.has(s.project_id)) planByProj.set(s.project_id, []);
    planByProj.get(s.project_id).push(s);
  }
  const smallByProj = new Map();
  for (const s of smallPlan) {
    if (!smallByProj.has(s.project_id)) smallByProj.set(s.project_id, []);
    smallByProj.get(s.project_id).push(s);
  }
  // 全局序号：建议被按项目分组后，顺序只有靠这个序号看得出来（后端按
  // due / 优先级 / 份额排好，rank 从 1 连续编下来）；1-20 用圈码，再多就直接写数字
  const rankBadge = (n) => el("span", "rank-badge", String(n));
  const planRow = (s, cls) => {
    const r = el("div", "task-row" + (cls ? " " + cls : ""));
    if (s.rank) r.append(rankBadge(s.rank));
    const dot = el("span", "dot");
    dot.style.background = s.color;
    r.append(dot);
    const title = el("span", "task-title",
      state.show_project_prefix ? `${s.project}-${s.title}` : s.title);
    r.append(title);
    r.append(el("span", "task-meta",
      `${state.show_project_prefix ? "" : s.project + " · "}建议 ${fmt(s.minutes)} · ` +
      (s.overdue ? "已逾期" : "due " + s.due_date.slice(5)) +
      (s.priority ? " · " + { 5: "🔴", 3: "🟡", 1: "⚪" }[s.priority] : "")));
    // 建议行只带 task_id，编辑要反查原任务；查不到就只给排期/计时
    const hit = findTaskById(s.task_id);
    const chips = hit ? tagChips(hit.t) : null;
    if (chips) r.append(chips);
    const acts = [{ icon: "cal", label: "排到今天", title: "排到今天",
      onClick: () => act(() => api(`/api/tasks/${s.task_id}`, "POST", { scheduled_date: state.today })) }];
    if (hit && hit.t.detail) acts.push({ icon: "file", label: "详情", primary: true,
      title: "查看详情（背景 / 要求 / 链接 / 下一步）",
      onClick: () => toggleDetail(r, hit.t) });
    if (hit) acts.push({ icon: "pencil", label: "编辑", title: "编辑任务",
      onClick: () => r.replaceWith(taskEditForm(hit.t)) });
    acts.push(timerAction(s.task_id));
    // 推荐行直接勾掉，不用再回今日清单找同一件；日常/重复仍走后端原有完成事务。
    acts.push({ icon: "check", label: "完成", primary: true,
      title: "勾掉这件（日常/重复会自动长下一件）",
      onClick: () => act(() => api(`/api/tasks/${s.task_id}/toggle`, "POST")) });
    r.append(rowActions(acts));
    return r;
  };

  // hero 下「下一件推荐」：全局序号最靠前的几件。第一件正常字号 + 强调色，其余
  // 小一号灰字；行本身和项目卡里的是同一套，排期 📅 / 计时 ▶ 逻辑不用重写。
  // 标题旁常驻 ⚙：列几件 / 小额阈值 / 优先项目就地改，存完保持展开，不用跑设置页。
  const recN = state.next_suggest_count || 3;
  const rec = el("div", "card next-rec");
  const recHead = el("div", "next-rec-head");
  const recTitle = el("span", "next-rec-title");
  recTitle.append(icon("target"), document.createTextNode("下一件推荐"));
  recHead.append(recTitle);
  const gear = el("button", "gear-btn" + (recCfgOpen ? " on" : ""));
  gear.append(icon("gear"));
  gear.type = "button";
  gear.title = "推荐设置：列几件 / 小额阈值 / 优先项目";
  gear.setAttribute("aria-label", "推荐设置");
  gear.setAttribute("aria-expanded", recCfgOpen ? "true" : "false");
  recHead.append(gear);
  rec.append(recHead);

  // ── 推荐设置面板（就地展开，一次保存三个字段）──────────────────
  const cfg = el("div", "rec-cfg" + (recCfgOpen ? "" : " hidden"));
  const cfgLine = (label, ...ctrls) => {
    const row = el("div", "rec-cfg-row");
    row.append(el("div", "rec-cfg-label", label));
    const box = el("div", "rec-cfg-ctrl");
    box.append(...ctrls);
    row.append(box);
    return row;
  };
  const fMin = el("input");
  fMin.type = "number"; fMin.min = "0"; fMin.max = "480"; fMin.step = "5";
  fMin.className = "rec-min-input";
  fMin.value = state.recommend_min_minutes ?? 30;
  fMin.title = "份额低于这个分钟数的建议折进小额；0 = 不分档";
  // 列几件：跟原来设置页那套一样三个常用档，点一下只是选中，保存才提交
  let pickN = recN;
  const segBox = el("div", "seg-ctrl");
  const segBtns = [1, 3, 5].map((v) => {
    const b = el("button", "seg-btn" + (v === pickN ? " active" : ""), String(v));
    b.type = "button";
    b.setAttribute("aria-pressed", v === pickN ? "true" : "false");
    b.onclick = () => {
      pickN = v;
      segBtns.forEach((x, i) => {
        const on = [1, 3, 5][i] === v;
        x.classList.toggle("active", on);
        x.setAttribute("aria-pressed", on ? "true" : "false");
      });
    };
    segBox.append(b);
    return b;
  });
  // 优先项目：勾上的排前面，顺序就是优先级，↑↓ 在勾选内挪
  let order = (state.recommend_project_ids || []).slice();
  const projBox = el("div", "rec-proj-list");
  const projRow = (pid, idx, on) => {
    const p = state.projects.find((x) => x.id === pid);
    const row = el("div", "rec-proj" + (on ? " on" : ""));
    if (!p) { row.classList.add("hidden"); return row; }
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.setAttribute("aria-label", "优先 " + p.name);
    cb.onchange = () => {
      if (cb.checked) { if (!order.includes(pid)) order.push(pid); }
      else order = order.filter((x) => x !== pid);
      paintProj();
    };
    const dot = el("span", "rec-proj-dot");
    dot.style.background = p.color;
    row.append(cb, dot, el("span", "rec-proj-name", (on ? `${idx + 1}. ` : "") + p.name));
    if (on) {
      const up = el("button", "link-btn rec-move", "↑");
      up.type = "button"; up.title = "往前挪一位"; up.disabled = idx === 0;
      up.onclick = () => {
        [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
        paintProj();
      };
      const dn = el("button", "link-btn rec-move", "↓");
      dn.type = "button"; dn.title = "往后挪一位"; dn.disabled = idx === order.length - 1;
      dn.onclick = () => {
        [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
        paintProj();
      };
      row.append(up, dn);
    }
    return row;
  };
  function paintProj() {
    projBox.innerHTML = "";
    const rest = state.projects.filter((p) => !order.includes(p.id));
    order.forEach((pid, i) => projBox.append(projRow(pid, i, true)));
    for (const p of rest) projBox.append(projRow(p.id, -1, false));
    if (!state.projects.length) projBox.append(el("div", "empty", "还没有项目"));
  }
  paintProj();
  const saveCfg = el("button", "btn-primary rec-save", "保存");
  saveCfg.onclick = () => act(async () => {
    await api("/api/settings", "POST", {
      recommend_min_minutes: Number(fMin.value === "" ? 30 : fMin.value),
      next_suggest_count: pickN,
      recommend_project_ids: order,
    });
    recCfgOpen = true;   // 存完还开着，方便接着调别的项
  });
  cfg.append(
    cfgLine("列几件", segBox),
    cfgLine("小额阈值", fMin, el("span", "rec-cfg-unit", "分钟（0 = 不分档）")),
    cfgLine("优先项目", el("span", "rec-cfg-hint",
      "勾上的排前面，↑↓ 调顺序；没勾的保持原顺序")),
    projBox, saveCfg);
  rec.append(cfg);
  gear.onclick = () => {
    recCfgOpen = !recCfgOpen;
    cfg.classList.toggle("hidden", !recCfgOpen);
    gear.classList.toggle("on", recCfgOpen);
    gear.setAttribute("aria-expanded", recCfgOpen ? "true" : "false");
  };

  const recs = mainPlan.slice(0, recN);
  const smallMin = smallPlan.reduce((a, s) => a + s.minutes, 0);
  const noteBits = [`按 due → 优先级 → 项目顺序 排的前 ${recs.length} 件`];
  if (mainPlan.length > recs.length) noteBits.push(`共 ${mainPlan.length} 件主建议`);
  if (smallPlan.length) noteBits.push(`另有 ${smallPlan.length} 件小额`);
  rec.append(el("div", "next-rec-note", noteBits.join(" · ")));
  if (recs.length) {
    recs.forEach((s, i) =>
      rec.append(planRow(s, i === 0 ? "next-rec-row first" : "next-rec-row")));
  } else {
    rec.append(el("div", "empty",
      mainPlan.length ? "主建议都在上面今日排期里了" : "今天没有主建议（小额不算，见下）"));
  }
  // 小额建议：折起来只留一行汇总，点开才逐条列。任务本身很小（est < 阈值）或
  // 2 天内到期的不折进来，那些再小也得做
  if (smallPlan.length) {
    const d = el("details", "next-rec-small");
    d.open = foldGet("recsmall");
    d.ontoggle = () => foldSet("recsmall", d.open);
    d.append(el("summary", null, `另有 ${smallPlan.length} 件小额建议 · 共 ${fmt(smallMin)}`));
    d.append(el("div", "pool-hint",
      `这些的今日份额低于 ${state.recommend_min_minutes ?? 30}m，先折起来；`
      + "任务本身很小、或 2 天内到期的不会折进这里"));
    for (const s of smallPlan) d.append(planRow(s, "small-row"));
    rec.append(d);
  }
  root.append(rec);

  // ⏸ 等待回复/暂时搁置：等别人回一句才能往下走的、或暂时推不动的，得每天扫一眼。
  // 藏在各项目卡的折叠区里等于没提醒，所以这里单独立一块，默认折起来只留一条摘要。
  // 按挂了几天排，最久没跟进的顶在最上面（老数据没有 suspended_at 的当 0 天）
  const waiting = allTasks().filter(t => t.suspended)
    .sort((a, b) => (suspendedDays(b) ?? 0) - (suspendedDays(a) ?? 0));
  if (waiting.length) {
    const wDet = el("details", "card wait-reply");
    wDet.open = waitReplyOpen;
    wDet.ontoggle = () => { waitReplyOpen = wDet.open; };
    // 提示塞进 summary 里：折起来的时候也得看得见「有几件挂太久」，不然白提醒
    const wSum = el("summary");
    wSum.append(icon("pause"),
      document.createTextNode(`等待回复 / 暂时搁置 · ${waiting.length} 件`));
    const staleN = waiting.filter(t => (suspendedDays(t) ?? 0) >= 3).length;
    // 跟「挂了 3 天以上」二选一：已经点出具体几件该催了，就不必再教怎么用
    if (staleN) wSum.append(el("span", "wait-note",
      `其中 ${staleN} 件挂了 3 天以上，今天该催一句了`));
    else wSum.append(el("span", "wait-hint", "（点开看挂了多久，该催就催）"));
    wDet.append(wSum);
    for (const t of waiting) wDet.append(suspendedRow(t, t.project, { showProject: true }));
    root.append(wDet);
  }

  // 各项目今日线：折叠起来，点开才看。有建议（含小额）的项目即使没有今日线也要显示
  const visibleProjs = state.projects.filter(
    p => planByProj.has(p.id) || smallByProj.has(p.id)
      || !(p.safety_min === null || (!p.deadline && p.remaining_min === 0 && !p.routine_today_min)));
  if (visibleProjs.length) {
    const pDet = el("details", "card today-projs");
    pDet.open = todayProjOpen;
    pDet.ontoggle = () => { todayProjOpen = pDet.open; };
    const pSum = el("summary");
    pSum.append(icon("chart"),
      document.createTextNode(`各项目今日线 · ${visibleProjs.length} 个项目（点开看进度环）`));
    pDet.append(pSum);
    // 图例：颜色跟各项目自己的颜色走，竖线是该项目今日线（目标）
    const pLegend = el("div", "proj-legend");
    const swatch = el("span", "legend-swatch");
    swatch.style.background = `linear-gradient(90deg, ${visibleProjs.map(p => p.color).join(", ")})`;
    pLegend.append(swatch, el("span", null, "色条 = 各项目今日已投入（项目名前的圆点同色）"),
      el("span", "legend-tick"), el("span", null, "竖线 = 今日线目标"));
    pDet.append(pLegend);
    for (const p of visibleProjs) {
      const card = el("div", "proj-today-card");
      const head = el("div", "proj-head");
      const target = p.safety_min || 0;
      // 没有今日线（0）时进度环/刻度条没有分母，别硬凑成 100%
      const pct = target > 0 ? Math.min(100, Math.round((p.today_invested_min / target) * 100)) : 0;
      const ring = el("div", "ring");
      ring.style.background = `conic-gradient(${p.color} ${pct}%, var(--line) ${pct}%)`;
      ring.append(el("span", null, target > 0 ? pct + "%" : "—"));
      head.append(ring);
      const info = el("div", "proj-info");
      const nameRow = el("div", "proj-name");
      const pdot = el("span", "color-dot");
      pdot.style.background = p.color;
      nameRow.append(pdot, el("span", null, p.name));
      info.append(nameRow);
      const dl = p.days_left === null ? "持续型"
        : (p.days_left < 0 ? `已逾期 ${-p.days_left} 天` : `还剩 ${p.days_left} 天`);
      info.append(el("div", "proj-meta",
        `${dl} · 剩 ${fmt(p.remaining_min)} · 今日线 ${fmt(p.safety_min)}` +
        `${p.routine_today_min ? `（含日常·重复${fmt(p.routine_today_min)}）` : ""}${p.no_track ? " · 不计工时" : ""}`));
      head.append(info);
      card.append(head);
      // 已投入 / 今日线（目标）刻度条：填充用项目色，竖线标出目标位置
      if (target > 0) {
        const scale = Math.max(p.today_invested_min || 0, target, 1);
        const lineTrack = el("div", "proj-line");
        const lineFill = el("div", "proj-line-fill");
        lineFill.style.width = Math.min(100, (p.today_invested_min / scale) * 100) + "%";
        lineFill.style.background = p.color;
        lineTrack.append(lineFill);
        const mark = el("div", "proj-line-marker");
        mark.style.left = Math.min(100, (target / scale) * 100) + "%";
        mark.title = `今日线 ${fmt(target)}`;
        lineTrack.append(mark);
        card.append(lineTrack);
      }
      const lineText = el("div", "proj-line-text");
      if (target > 0) {
        lineText.append(el("span", null, `已投 ${fmt(p.today_invested_min)} / 目标 ${fmt(target)}`));
        const diff = target - p.today_invested_min;
        lineText.append(diff > 0
          ? el("span", "proj-line-gap", ` · 还差 ${fmt(diff)}`)
          : el("span", "proj-line-ok", " · 已达标"));
      } else {
        lineText.append(el("span", null, `已投 ${fmt(p.today_invested_min)} · 今日线 0m（暂无必需量）`));
      }
      card.append(lineText);
      if (p.slack_min > p.safety_min && p.remaining_min > 0) {
        card.append(el("div", "slack-hint",
          `再拖 1 天，每天要涨到 ${fmt(p.slack_min)}`));
      }
      if (p.deadline && p.remaining_min > 0) {
        const planBtn = el("button", null, "📐 自动排期到每天");
        planBtn.onclick = () => act(async () => {
          const r = await api(`/api/projects/${p.id}/autoplan`, "POST");
          alert(`已把 ${r.placed} 件任务按每天约 ${fmt(r.cap_min)} 分摊到日历` +
                (r.unplaced ? `；${r.unplaced} 件容量不够没排下` : ""));
        });
        card.append(planBtn);
      }
      // 今日建议按项目归位：持续型项目逐任务列份额（份额就是按每件任务摊出来的），
      // 有 deadline 的项目只给合计，逐条看项目页。
      // 主建议和小额建议同口径分开：项目内也能把小额展开看，不用回顶部
      const sug = planByProj.get(p.id);
      const smallSug = smallByProj.get(p.id) || [];
      if (sug || smallSug.length) {
        planByProj.delete(p.id);
        smallByProj.delete(p.id);
        const box = el("div", "proj-sug");
        if (sug) {
          const sugSum = sug.reduce((a, s) => a + s.minutes, 0);
          const sugHead = el("div", "proj-sug-head");
          sugHead.append(icon("clipboard"),
            document.createTextNode(`今日建议 ${sug.length} 件 · 合计 ${fmt(sugSum)}`));
          if (p.days_left !== null) {
            sugHead.title = sug.map(s => `${s.title} · ${fmt(s.minutes)}`).join("\n");
          }
          box.append(sugHead);
          if (p.days_left === null) {
            for (const s of sug.slice(0, 8)) box.append(planRow(s));
            if (sug.length > 8)
              box.append(el("div", "pool-hint", `还有 ${sug.length - 8} 件建议没列出（点项目名看全部）`));
          }
        }
        if (smallSug.length) {
          const sd = el("details", "proj-small");
          sd.append(el("summary", null,
            `另有 ${smallSug.length} 件小额 · 共 ${fmt(smallSug.reduce((a, s) => a + s.minutes, 0))}`));
          for (const s of smallSug) sd.append(planRow(s, "small-row"));
          box.append(sd);
        }
        card.append(box);
      }
      pDet.append(card);
    }
    root.append(pDet);
  }
  // 项目已经删掉、但建议还在的（理论上不会有）：兜底塞一个「其他建议」块
  // 小额的一并带出来——它们对应的项目同样已经不在，折在别处就彻底看不见了
  const leftoverPlan = [];
  for (const items of planByProj.values()) leftoverPlan.push(...items);
  for (const items of smallByProj.values()) leftoverPlan.push(...items);
  if (leftoverPlan.length) {
    const oc = el("details", "card today-projs");
    oc.open = foldGet("plan");
    oc.ontoggle = () => foldSet("plan", oc.open);
    const ocSum = el("summary");
  ocSum.append(icon("clipboard"),
    document.createTextNode(`其他建议 · ${leftoverPlan.length} 件（对应项目已不在，点开看）`));
  oc.append(ocSum);
    for (const s of leftoverPlan) oc.append(planRow(s));
    root.append(oc);
  }

  const listCard = el("details", "card today-projs today-groups");
  listCard.open = foldGet("sched");
  listCard.ontoggle = () => foldSet("sched", listCard.open);
  const schedSum = el("summary");
  schedSum.append(icon("check"), document.createTextNode(`今日任务 · ${n} 件（点开处理）`));
  listCard.append(schedSum);
  const pendById = new Map((state.routine_pending || []).map(x => [x.task_id, x]));
  const todayRow = (t) => {
    // 提前窗口亮出的重复实例：预估后括号给出今天建议摊的量（剩余 ÷ 剩余天数）
    const it = pendById.get(t.id);
    const estHint = it && it.window && it.suggest_min != null ? fmt(it.suggest_min) : null;
    return taskRow(t, t.project, { showProject: true, editable: true, estHint });
  };
  const appendGroup = (title, iconName, items, hint) => {
    if (!items.length) return;
    const group = el("section", "today-group");
    const head = el("div", "today-group-head");
    const label = el("span", "today-group-title");
    label.append(icon(iconName), document.createTextNode(title));
    if (hint) label.title = hint;
    head.append(label, el("span", "today-group-meta",
      `${items.length} 件 · ${fmt(items.reduce((sum, t) => sum + (t.estimate_min || 0), 0))}`));
    group.append(head);
    for (const t of items) group.append(todayRow(t));
    listCard.append(group);
  };
  appendGroup("今日必做", "target", mustToday, "due 今天或已逾期的一次性任务");
  appendGroup("日常·重复", "repeat", repeatToday, "今天该发生的日常和周期重复实例");
  appendGroup("其他今日任务", "cal", otherToday, "未到 due 的今日排期，以及不计工时项目的任务");
  if (!n) listCard.append(el("div", "empty", "今天没有任务，去「日历」从池子里拖几件过来"));
  if (hiddenWorkday > 0)
    listCard.append(el("div", "pool-hint", `今天是非工作日，已收起 ${hiddenWorkday} 件仅工作日的日常任务`));
  root.append(listCard);

  root.append(el("div", "section-title", "手动补记"));
  const form = el("div", "card manual-log-card");
  const row1 = el("div", "form-row");
  const sel = el("select");
  for (const p of state.projects) {
    const o = el("option", null, p.name);
    o.value = p.id;
    sel.append(o);
  }
  const taskSel = el("select");
  taskSel.title = "关联到哪件任务（可选）";
  const fillTasks = () => {
    taskSel.innerHTML = "";
    const ph = el("option", null, "（不关联具体任务）");
    ph.value = "";
    taskSel.append(ph);
    const p = state.projects.find(x => x.id === Number(sel.value));
    if (p) for (const t of p.tasks) {
      const o = el("option", null, t.title);
      o.value = t.id;
      taskSel.append(o);
    }
    taskSel.classList.add("sel-empty");
  };
  sel.onchange = fillTasks;
  fillTasks();
  selPH(taskSel);
  const minInput = el("input");
  minInput.type = "number"; minInput.min = "1"; minInput.placeholder = "分钟";
  minInput.id = "manual-log-minutes";
  minInput.setAttribute("aria-label", "补记分钟");
  const dateInput = el("input");
  dateInput.type = "date"; dateInput.value = state.logical_today || state.today;
  const tName = el("input");
  tName.type = "text"; tName.placeholder = "临时任务名（不关联时填）";
  tName.title = "不关联已有任务时，直接记个名字（如：临时会议）；关联了任务则忽略这里";
  row1.append(sel, taskSel, tName, minInput, dateInput);
  const row2 = el("div", "form-row");
  const note = el("input");
  note.type = "text"; note.placeholder = "备注（可选）";
  const submit = el("button", "btn-primary", "记下");
  submit.onclick = () => act(async () => {
    await api("/api/logs", "POST", {
      project_id: Number(sel.value),
      task_id: taskSel.value ? Number(taskSel.value) : null,
      task_name: taskSel.value ? null : tName.value.trim() || null,
      minutes: Number(minInput.value),
      date: dateInput.value,
      note: note.value,
    });
    minInput.value = ""; note.value = ""; tName.value = "";
  });
  row2.append(note, submit);
  form.append(row1, row2);
  root.append(form);
}

/* ── 日历 ───────────────────────────── */

function assignTask(taskId, dateStr) {
  return act(async () => {
    await api(`/api/tasks/${taskId}`, "POST", { scheduled_date: dateStr });
    selectedTask = null;
  });
}

/* ── 日历：某天的全部条目浮层 ─────────── */

function closeDayModal() {
  if (!dayModal) return;
  dayModal.remove();
  dayModal = null;
}

function openDayModal(dateStr, items, estSum, invested) {
  closeDayModal();
  const overlay = el("div", "day-overlay");
  // 点空白处关闭（点面板内部不算）
  overlay.onclick = (e) => { if (e.target === overlay) closeDayModal(); };
  const panel = el("div", "day-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", `${dateStr} 任务详情`);
  const head = el("div", "day-panel-head");
  head.append(el("div", "cal-title", dateStr));
  head.append(el("div", "task-meta",
    `共 ${items.length} 件 · 排${fmt(estSum)}` + (invested ? ` · 投${fmt(invested)}` : "")));
  const close = el("button", "btn-check");
  close.append(icon("x"));
  close.title = "关闭（Esc）";
  close.setAttribute("aria-label", "关闭");
  close.onclick = closeDayModal;
  head.append(close);
  panel.append(head);
  panel.append(el("div", "pool-hint",
    "这里只查看详情；已排期任务可点「取消排期」放回任务池。浅色循环条目只是日常/重复投影"));
  const backToPool = (id) => {
    closeDayModal();
    act(() => api(`/api/tasks/${id}`, "POST", { scheduled_date: "" }));
  };
  for (const it of items) {
    if (it.kind === "deadline") {
      const r = el("div", "day-row deadline");
      r.style.borderLeftColor = it.color;
      const dlTitle = el("span", "task-title");
      dlTitle.append(icon("flag"), document.createTextNode(it.title));
      r.append(dlTitle);
      r.append(el("span", "task-meta", "项目 deadline"));
      panel.append(r);
    } else if (it.kind === "occ") {
      const r = el("div", "day-row occ");
      r.style.borderLeftColor = it.o.color;
      const occTitle = el("span", "task-title");
      occTitle.append(icon(it.o.routine ? "loop" : "repeat", "ic-soft"));
      occTitle.append(document.createTextNode(it.title));
      r.append(occTitle);
      r.append(el("span", "task-meta", it.o.routine ? "日常投影" : "重复投影"));
      r.title = it.o.routine ? "日常，每天自动出现" : "重复规则，预计这天执行";
      panel.append(r);
    } else {
      const t = it.t;
      const r = el("div", "day-row" + (t.due_date && t.due_date < state.today ? " overdue" : ""));
      r.style.borderLeftColor = t.project.color;
      r.append(el("span", "task-title", it.title));
      const bits = [t.project.name,
        t.estimate_min == null ? "无预估" : "预估 " + fmt(t.estimate_min)];
      if (t.due_date) bits.push((t.due_date < state.today ? "逾期 " : "due ") + t.due_date.slice(5));
      r.append(el("span", "task-meta", bits.join(" · ")));
      if (t.scheduled_date) {
        const back = el("button", "btn-check btn-with-ic");
        back.append(icon("undo"), document.createTextNode("取消排期"));
        back.title = "取消这天的排期并放回任务池";
        back.setAttribute("aria-label", `取消排期：${it.title}`);
        back.onclick = (e) => { e.stopPropagation(); backToPool(t.id); };
        r.append(back);
      }
      panel.append(r);
    }
  }
  overlay.append(panel);
  document.body.append(overlay);
  dayModal = overlay;
  close.focus();
}

function renderCalendar(root) {
  if (!calCursor) {
    const d = new Date(state.today + "T00:00:00");
    calCursor = new Date(d.getFullYear(), d.getMonth(), 1);
  }
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  // 拉当月的日常/重复投影（🌀/🔁 浅色条）；拿到后重绘一次。
  // 注意：请求中只记时刻、不占位——拿空数组占位的话，一旦这次没回来（切走/断网被吞掉），
  // 这个月就永远不再重试，日历上从此看不到投影；记时刻还能让卡住的请求 8 秒后自愈
  const ym = `${y}-${String(m + 1).padStart(2, "0")}`;
  if (!(ym in calOcc) && !(Date.now() - (calLoading[ym] || 0) < 8000)) {
    calLoading[ym] = Date.now();
    api(`/api/calendar?month=${ym}`)
      .then(r => {
        calOcc[ym] = r.occ || [];
        delete calLoading[ym];
        if (currentTab === "calendar") render();
      })
      .catch(() => { delete calLoading[ym]; });
  }
  const occByDate = {};
  for (const o of calOcc[ym] || []) (occByDate[o.date] = occByDate[o.date] || []).push(o);

  const head = el("div", "cal-head");
  const title = el("div", "cal-title", `${y}年${m + 1}月`);
  const nav = el("div", "cal-nav");
  const prev = el("button", null, "‹");
  prev.onclick = () => { calCursor = new Date(y, m - 1, 1); render(); };
  const todayBtn = el("button", null, "今天");
  todayBtn.onclick = () => { const d = new Date(state.today + "T00:00:00"); calCursor = new Date(d.getFullYear(), d.getMonth(), 1); render(); };
  const next = el("button", null, "›");
  next.onclick = () => { calCursor = new Date(y, m + 1, 1); render(); };
  nav.append(prev, todayBtn, next);
  head.append(title, nav);
  root.append(head);

  const calCard = el("div", "card");
  const grid = el("div", "cal-grid");
  for (const w of ["一", "二", "三", "四", "五", "六", "日"]) grid.append(el("div", "cal-week", w));

  const firstOffset = (new Date(y, m, 1).getDay() + 6) % 7; // 周一开头
  for (let i = 0; i < firstOffset; i++) grid.append(el("div", "cal-blank"));
  const days = new Date(y, m + 1, 0).getDate();
  const tasks = activeTasks();
  const deadlineMap = {};
  for (const p of state.projects)
    if (p.deadline) (deadlineMap[p.deadline] = deadlineMap[p.deadline] || []).push(p);

  // 格子塞不下时折成「＋N 更多」：窄屏格子更矮，能放下的条数更少
  const maxChips = window.matchMedia("(max-width: 600px)").matches ? 2 : 3;

  // 单个条目：拖拽改期；单击只开详情，取消排期由浮层里的明确按钮执行。
  const dayChip = (it, dateStr, items, estSum, invested) => {
    if (it.kind === "deadline") {
      const flag = el("div", "cal-chip deadline-chip");
      flag.append(icon("flag"), document.createTextNode(it.title));
      flag.style.borderLeftColor = it.color;
      flag.title = `${it.title} deadline`;
      return flag;
    }
    if (it.kind === "occ") {
      const chip = el("div", "cal-chip occ-chip");
      chip.append(icon(it.o.routine ? "loop" : "repeat"),
        document.createTextNode(it.title));
      chip.style.borderLeftColor = it.o.color;
      chip.title = (it.o.routine ? "日常，每天自动出现" : "重复规则，预计这天执行") +
        (it.o.project ? ` · ${it.o.project}` : "");
      return chip;
    }
    const t = it.t;
    const chip = el("div",
      "cal-chip" + (t.due_date && t.due_date < state.today ? " overdue" : "") + (it.isDueOnly ? " due-only" : ""),
      it.title);
    chip.style.borderLeftColor = t.project.color;
    chip.draggable = true;
    chip.title = `${t.project.name} · ${fmtEst(t.estimate_min)}${t.due_date ? " · due " + t.due_date : ""}（单击查看详情；拖到别的格子改日期）`;
    chip.onclick = (e) => {
      e.stopPropagation();
      openDayModal(dateStr, items, estSum, invested);
    };
    chip.ondragstart = (e) => {
      e.stopPropagation();
      e.dataTransfer.setData("text/plain", t.id + (it.isDueOnly ? ":due" : ":cell"));
    };
    return chip;
  };

  for (let d = 1; d <= days; d++) {
    const dateStr = dstr(y, m, d);
    const cell = el("div", "cal-cell");
    if (dateStr === state.today) cell.classList.add("today");
    else if (dateStr < state.today) cell.classList.add("past");
    cell.append(el("div", "cal-daynum", String(d)));

    // 排期任务排在 scheduled_date；只有 due date 没排期的，显示在 due 那天
    const dayTasks = tasks.filter(t =>
      t.scheduled_date === dateStr || (!t.scheduled_date && t.due_date === dateStr));
    const estSum = dayTasks.reduce((s, t) => s + (t.estimate_min || 0), 0);
    const invested = (state.invested_by_date || {})[dateStr] || 0;

    // 一格里的全部条目：deadline → 排期任务 → 日常/重复投影
    const items = [];
    for (const p of deadlineMap[dateStr] || [])
      items.push({ kind: "deadline", title: p.name, color: p.color });
    for (const t of dayTasks)
      items.push({ kind: "task", t, isDueOnly: !t.scheduled_date, title: dispTitle(t, t.project) });
    for (const o of occByDate[dateStr] || [])
      items.push({
        kind: "occ", o,
        title: (state.show_project_prefix && o.project ? `${o.project}-${o.title}` : o.title),
      });

    const shown = items.length > maxChips ? items.slice(0, maxChips - 1) : items;
    for (const it of shown) cell.append(dayChip(it, dateStr, items, estSum, invested));
    if (items.length > shown.length) {
      const more = el("div", "cal-chip more-chip", `＋${items.length - shown.length} 更多`);
      more.title = `这天还有 ${items.length - shown.length} 件，点开看全天 ${items.length} 件`;
      more.onclick = (e) => {
        e.stopPropagation();
        openDayModal(dateStr, items, estSum, invested);
      };
      cell.append(more);
    }

    if (estSum || invested)
      cell.append(el("div", "cal-meta", `投${fmt(invested)} 排${fmt(estSum)}`));

    cell.onclick = () => { if (selectedTask) assignTask(selectedTask, dateStr); };
    cell.ondragover = (e) => { e.preventDefault(); cell.classList.add("drop-hint"); };
    cell.ondragleave = () => cell.classList.remove("drop-hint");
    cell.ondrop = (e) => {
      e.preventDefault();
      cell.classList.remove("drop-hint");
      const [idStr, origin] = (e.dataTransfer.getData("text/plain") || "").split(":");
      const t = tasks.find(x => x.id === Number(idStr));
      if (!t) return;
      act(async () => {
        const body = {};
        if (origin === "cell") { body.scheduled_date = dateStr; body.due_date = dateStr; }
        else if (origin === "due") { body.due_date = dateStr; }
        else { body.scheduled_date = dateStr; }
        await api(`/api/tasks/${t.id}`, "POST", body);
        selectedTask = null;
      });
    };
    grid.append(cell);
  }
  calCard.append(grid);
  root.append(calCard);

  // 任务池
  root.append(el("div", "section-title", "任务池"));
  const pool = el("div", "card");
  pool.append(el("div", "pool-hint", "点选任务再点日历格子即可排期；日历上的任务可拖动改期，单击只开详情，在详情里点「取消排期」才放回池子"));
  const poolTasks = tasks.filter(t => !t.scheduled_date);
  if (!poolTasks.length) pool.append(el("div", "empty", "池子空了"));
  for (const t of poolTasks) {
    const row = taskRow(t, t.project, { showProject: true, playable: false });
    row.draggable = true;
    if (selectedTask === t.id) row.classList.add("selected");
    row.onclick = () => {
      selectedTask = selectedTask === t.id ? null : t.id;
      render();
    };
    row.ondragstart = (e) => e.dataTransfer.setData("text/plain", t.id + ":pool");
    pool.append(row);
  }
  root.append(pool);
}

/* ── 项目 ───────────────────────────── */

let draggingProjectId = null;

function applyProjectFilter() {
  const term = projectFilter.toLowerCase();
  document.querySelectorAll("#tab-projects .proj-block").forEach(card => {
    const name = card.querySelector(".proj-name")?.textContent || "";
    card.classList.toggle("hidden", term && !name.toLowerCase().includes(term));
  });
}

function reorderRelative(projectId, dir) {
  const ids = state.projects.map(p => p.id);
  const i = ids.indexOf(projectId);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  act(() => api("/api/projects/reorder", "POST", { ids }));
}

function renderProjects(root) {
  // 导入池：未分配项目的任务
  if (state.inbox && state.inbox.length) {
    const inboxHead = el("div", "section-title");
    inboxHead.append(icon("inbox"),
      document.createTextNode(`导入池 · ${state.inbox.length} 件待分配`));
    root.append(inboxHead);
    const inboxCard = el("div", "card");
    for (const t of state.inbox) {
      const row = el("div", "task-row");
      const inbTitle = el("span", "task-title");
      if (t.routine) inbTitle.append(icon("loop", "ic-routine"));
      inbTitle.append(document.createTextNode(t.title));
      row.append(inbTitle);
      const metaBits = [fmtEst(t.estimate_min)];
      if (t.priority) metaBits.push({ 5: "🔴高", 3: "🟡中", 1: "⚪低" }[t.priority]);
      if (t.due_date) metaBits.push("due " + t.due_date.slice(5));
      row.append(el("span", "task-meta", metaBits.join(" · ")));
      const sel = el("select");
      const ph = el("option", null, "分到项目…");
      ph.value = "";
      sel.append(ph);
      for (const p of state.projects) {
        const o = el("option", null, p.name);
        o.value = p.id;
        sel.append(o);
      }
      selPH(sel);
      sel.onchange = () => {
        if (sel.value)
          act(() => api(`/api/tasks/${t.id}`, "POST", { project_id: Number(sel.value) }));
      };
      row.append(sel);
      const ed = el("button", "btn-check");
      ed.append(icon("pencil"));
      ed.title = "编辑任务";
      ed.setAttribute("aria-label", "编辑任务");
      ed.onclick = () => row.replaceWith(taskEditForm(t));
      row.append(ed);
      const del = el("button", "btn-check");
      del.append(icon("trash"));
      del.title = "删除";
      del.setAttribute("aria-label", del.title);
      del.onclick = () => {
        if (confirm(`删除「${t.title}」？`))
          act(() => api(`/api/tasks/${t.id}/delete`, "POST"));
      };
      row.append(del);
      inboxCard.append(row);
    }
    root.append(inboxCard);
  }

  const form = el("div", "card new-project-card");
  form.append(el("div", "section-title", "新建项目"));
  const row = el("div", "form-row");
  const name = el("input");
  name.type = "text"; name.placeholder = "项目名称，如：Q4 审计 / 年度体检";
  const dl = el("input");
  dl.type = "date"; dl.title = "项目 deadline（可选，安全线的计算基准）";
  const btn = el("button", "btn-primary", "创建");
  btn.onclick = () => act(async () => {
    const r = await api("/api/projects", "POST", { name: name.value, deadline: dl.value });
    openProjects.add(r.id);  // 新建的项目直接展开
    name.value = "";
  });
  row.append(name, dl, btn);
  form.append(row);
  root.append(form);

  const filterWrap = el("div", "card");
  const filterInput = el("input", "project-filter");
  filterInput.type = "text";
  filterInput.placeholder = "筛选项目名…";
  filterInput.value = projectFilter;
  filterInput.oninput = () => { projectFilter = filterInput.value.trim(); applyProjectFilter(); };
  filterWrap.append(filterInput);
  root.append(filterWrap);

  for (const p of state.projects) {
    const card = el("div", "card proj-block");
    card.dataset.id = p.id;
    card.style.borderLeftColor = p.color;
    const head = el("div", "proj-head");
    const chevron = el("span", "proj-chevron", openProjects.has(p.id) ? "▾" : "▸");
    const dragHandle = el("span", "drag-handle", "⋮⋮");
    dragHandle.title = "拖动排序";
    dragHandle.draggable = true;
    dragHandle.onclick = (e) => e.stopPropagation();
    dragHandle.ondragstart = (e) => {
      draggingProjectId = p.id;
      e.dataTransfer.setData("text/plain", "proj:" + p.id);
      e.dataTransfer.effectAllowed = "move";
    };
    dragHandle.ondragend = () => { draggingProjectId = null; };
    const dot = el("span", "color-dot");
    dot.style.background = p.color;
    const info = el("div", "proj-info");
    info.append(el("div", "proj-name", p.name));
    // 「N 项未做」和「剩 X」用同一口径：挂起的不算未做（剩 X 里也没它）
    const undone = p.tasks.filter(t => !t.suspended).length;
    const suspN = p.tasks.length - undone;
    info.append(el("div", "proj-meta",
      (p.deadline ? `deadline ${p.deadline} · ` : "")
      + `${undone} 项未做${suspN ? ` · 挂起 ${suspN}` : ""} · 剩 ${fmt(p.remaining_min)}`));
    head.append(chevron, dragHandle, dot, info);
    head.onclick = () => {
      if (openProjects.has(p.id)) openProjects.delete(p.id);
      else openProjects.add(p.id);
      render();
    };
    card.append(head);

    card.ondragover = (e) => {
      if (draggingProjectId && draggingProjectId !== p.id) {
        e.preventDefault();
        card.classList.add("drop-hint");
      }
    };
    card.ondragleave = () => card.classList.remove("drop-hint");
    card.ondrop = (e) => {
      e.preventDefault();
      card.classList.remove("drop-hint");
      const srcId = draggingProjectId;
      draggingProjectId = null;
      if (!srcId || srcId === p.id) return;
      const ids = state.projects.map(x => x.id);
      const from = ids.indexOf(srcId);
      const to = ids.indexOf(p.id);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to, 0, srcId);
      act(() => api("/api/projects/reorder", "POST", { ids }));
    };

    const body = el("div", "proj-body");
    if (!openProjects.has(p.id)) body.classList.add("hidden");
    card.append(body);

    const editDet = el("details", "proj-edit");
    const editSum = el("summary");
    editSum.append(icon("gear"),
      document.createTextNode("编辑项目信息（名称 / deadline / 颜色 / 仅工作日 / 不计工时 / 删除）"));
    editDet.append(editSum);

    const idx = state.projects.findIndex(x => x.id === p.id);
    const orderRow = el("div", "form-row order-row");
    const upBtn = el("button");
    upBtn.append(document.createTextNode("上移"), icon("up"));
    upBtn.type = "button";
    upBtn.disabled = idx <= 0;
    upBtn.onclick = (e) => { e.stopPropagation(); reorderRelative(p.id, -1); };
    const downBtn = el("button");
    downBtn.append(document.createTextNode("下移"), icon("down"));
    downBtn.type = "button";
    downBtn.disabled = idx >= state.projects.length - 1;
    downBtn.onclick = (e) => { e.stopPropagation(); reorderRelative(p.id, 1); };
    orderRow.append(upBtn, downBtn);
    editDet.append(orderRow);

    const editRow = el("div", "form-row");
    const eName = el("input");
    eName.type = "text"; eName.value = p.name;
    const eDl = el("input");
    eDl.type = "date"; eDl.value = p.deadline || "";
    const eColor = el("input");
    eColor.type = "color"; eColor.value = p.color || "#7a9b76";
    eColor.title = "项目颜色";
    // 仅工作日计算：今天不上班就不排必需量，deadline 的可用天数也只数工作日
    const eWork = el("label");
    eWork.style.alignSelf = "center";
    eWork.title = "周末/节假日不排必需量（加班照记），deadline 的剩余天数只数工作日";
    const wc = el("input"); wc.type = "checkbox"; wc.checked = !!p.workdays_only;
    eWork.append(wc, document.createTextNode(" 仅工作日计算"));
    const eSave = el("button", "btn-primary", "保存");
    eSave.onclick = () => act(() => api(`/api/projects/${p.id}`, "POST", {
      name: eName.value, deadline: eDl.value, color: eColor.value,
      no_track: tc.checked, workdays_only: wc.checked,
    }));
    const eTrack = el("label");
    const tc = el("input"); tc.type = "checkbox"; tc.checked = !!p.no_track;
    eTrack.append(tc, document.createTextNode(" 不计工时"));
    eTrack.style.alignSelf = "center";
    const eDel = el("button", "btn-check");
    eDel.append(icon("trash"));
    eDel.title = "删除项目到垃圾桶（任务一并删除，工时记录保留，可恢复）";
    eDel.setAttribute("aria-label", "删除项目");
    eDel.onclick = () => {
      const n = p.tasks.length + ((p.done_tasks && p.done_tasks.length) || 0);
      if (!confirm(`删除项目「${p.name}」？其 ${n} 件任务将一并删除，工时记录保留。`)) return;
      if (!confirm("再确认一次：删除后可在项目页底部的垃圾桶里恢复。")) return;
      act(async () => {
        await api(`/api/projects/${p.id}/delete`, "POST");
        openProjects.delete(p.id);
      });
    };
    editRow.append(eName, eDl, eColor, eTrack, eWork, eSave, eDel);
    editDet.append(editRow);
    body.append(editDet);

    for (const t of p.tasks) {
      if (t.suspended) continue;  // 挂起的进下面的「挂起中」折叠区，不在正常列表里占位
      body.append(taskRow(t, p, {
        deletable: true, editable: true, copyable: true, backable: true,
      }));
    }

    // 挂起中：等回复/暂时推不动的事。收在折叠区里灰显，due 过了标红提醒
    //「这事还在等」，但不进今日排期和日历，也不占安全线。行内容和今日页
    //「等待回复」是同一套（suspendedRow），天数口径一致
    const suspTasks = p.tasks.filter(t => t.suspended);
    if (suspTasks.length) {
      const det = el("details", "suspend-box");
      det.open = openSuspended.has(p.id);
      const suspSum = el("summary");
      suspSum.append(icon("pause"),
        document.createTextNode(`挂起中 · ${suspTasks.length} 件`));
      det.append(suspSum);
      det.addEventListener("toggle", () => {
        if (det.open) openSuspended.add(p.id);
        else openSuspended.delete(p.id);
      });
      const sorted = [...suspTasks].sort(
        (a, b) => (suspendedDays(b) ?? 0) - (suspendedDays(a) ?? 0));
      for (const t of sorted) det.append(suspendedRow(t, p));
      body.append(det);
    }

    if (p.done_tasks && p.done_tasks.length) {
      const det = el("details", "done-list");
      det.append(el("summary", null, `已完成 ${p.done_tasks.length} 件`));
      for (const t of p.done_tasks) {
        const tr = el("div", "task-row done-row");
        const doneTitle = el("span", "task-title");
        if (t.routine) doneTitle.append(icon("loop", "ic-routine"));
        doneTitle.append(document.createTextNode(t.title));
        tr.append(doneTitle);
        const doneDay = t.done_at ? t.done_at.slice(5, 10) : "";
        tr.append(el("span", "task-meta", `${doneDay} · ${fmtEst(t.estimate_min)}`));
        const un = el("button", "btn-check done");
        un.append(icon("check"));
        un.title = "取消完成";
        un.setAttribute("aria-label", "取消完成");
        un.onclick = () => act(() => api(`/api/tasks/${t.id}/toggle`, "POST"));
        tr.append(un);
        det.append(tr);
      }
      body.append(det);
    }

    const addWrap = el("div", "add-task");
    const addRow = el("div", "form-row");
    const tTitle = el("input");
    tTitle.type = "text"; tTitle.placeholder = "新任务标题";
    tTitle.title = "改名会重置该任务的校准记录（结算按「项目 + 标题」认同一件任务）";
    const tEst = estimateField();
    const tDue = el("input");
    tDue.type = "date"; tDue.title = "任务 due date（可选）";
    const tPrio = el("select");
    tPrio.title = "优先级";
    for (const [v, label] of [[0, "无优先级"], [5, "🔴高"], [3, "🟡中"], [1, "⚪低"]]) {
      const o = el("option", null, label);
      o.value = v;
      tPrio.append(o);
    }
    selPH(tPrio, 0);
    const tTags = el("input");
    tTags.type = "text";
    tTags.placeholder = "标签，用逗号隔开，如 qc, 检索";
    tTags.title = "标签：用来归类算均次耗时（逗号或空格分隔，多个标签都算）";
    tTags.style.minWidth = "9em";
    const tBtn = el("button", "btn-primary add-task-btn", "＋ 添加任务");
    const rep = repeatControls();
    // 详情默认收起来：加任务时多数只要一行标题，写长说明是少数。
    // 点「＋详情」展开一个多行框，收起时已填的内容不清空（免得误点丢字）
    const tDetail = el("textarea", "detail-input");
    tDetail.rows = 2;
    tDetail.placeholder = "详情（可选）：背景 / 要求 / 链接 / 下一步，可多行";
    const dWrap = el("div", "detail-edit hidden");
    dWrap.append(tDetail);
    const dToggle = el("button", "link-btn add-detail-btn", "＋详情");
    dToggle.type = "button";
    dToggle.title = "加一段多行说明（背景 / 要求 / 链接 / 下一步）";
    dToggle.onclick = () => {
      dWrap.classList.toggle("hidden");
      dToggle.textContent = dWrap.classList.contains("hidden") ? "＋详情" : "－收起详情";
    };
    tBtn.onclick = () => act(async () => {
      await api("/api/tasks", "POST", {
        project_id: p.id, title: tTitle.value,
        detail: tDetail.value,
        estimate_min: tEst.forCreate(),
        due_date: tDue.value || undefined,
        priority: Number(tPrio.value),
        tags: tTags.value,
        ...rep.read(),
      });
      tTitle.value = ""; tEst.reset(); tDue.value = "";
      tTags.value = "";
      tDetail.value = "";
      tPrio.value = 0;
      tPrio.classList.add("sel-empty");
    });
    addRow.append(tTitle, tEst.wrap, tDue, tPrio, tTags, dToggle);
    addWrap.append(addRow, dWrap, rep.wrap, tBtn);
    body.append(addWrap);
    root.append(card);
  }
  applyProjectFilter();

  // 🗑 垃圾桶：删掉的项目/任务先放这里，可恢复。展开时才拉列表，平时不多发请求。
  const trashDet = el("details", "card trash-box");
  const tSum = el("summary");
  tSum.append(icon("trash"), document.createTextNode("垃圾桶"));
  trashDet.append(tSum);
  const tBody = el("div", "trash-body");
  trashDet.append(tBody);
  trashDet.open = trashOpen;

  const fillTrash = (items) => {
    tBody.innerHTML = "";
    tSum.replaceChildren(icon("trash"), document.createTextNode(`垃圾桶（${items.length}）`));
    if (!items.length) {
      tBody.append(el("div", "trash-hint", "垃圾桶是空的。删掉的项目和任务会先放这里，可以恢复。"));
      return;
    }
    const emptyBtn = el("button", "btn-check trash-empty", `清空垃圾桶（${items.length} 项）`);
    emptyBtn.onclick = () => {
      if (!confirm(`清空垃圾桶？其中 ${items.length} 项将永久删除，无法恢复。`)) return;
      act(() => api("/api/trash/empty", "POST"));
    };
    tBody.append(emptyBtn);
    for (const it of items) {
      const row = el("div", "trash-row");
      const tn = el("span", "trash-name");
      tn.append(icon(it.kind === "project" ? "folder" : "file", "ic-soft"),
        document.createTextNode(it.kind === "project"
          ? `${it.name}（含 ${it.tasks} 件任务）` : it.name));
      row.append(tn);
      row.append(el("span", "task-meta", (it.deleted_at || "").replace("T", " ").slice(0, 16)));
      const rb = el("button", "btn-primary", "恢复");
      rb.onclick = () => act(async () => {
        const r = await api(`/api/trash/${it.id}/restore`, "POST");
        if (r.project_id) openProjects.add(r.project_id);  // 恢复的项目直接展开
      });
      const pb = el("button", "btn-check", "彻底删除");
      pb.title = "永久删除，无法恢复";
      pb.onclick = () => {
        if (!confirm(`彻底删除「${it.name}」？此操作无法恢复。`)) return;
        act(() => api(`/api/trash/${it.id}/purge`, "POST"));
      };
      row.append(rb, pb);
      tBody.append(row);
    }
  };

  const loadTrash = async () => {
    tBody.textContent = "加载中…";
    try {
      fillTrash((await api("/api/trash")).items);
    } catch (e) { tBody.textContent = e.message; }
  };
  if (trashOpen) loadTrash();
  trashDet.addEventListener("toggle", () => {
    trashOpen = trashDet.open;
    if (trashDet.open) loadTrash();
  });
  root.append(trashDet);
}

/* ── 统计 ───────────────────────────── */

// 一条工时记录的时间标签：手动补记的记录 start_at 是当天 00:00:00
function logSpan(l) {
  const hhmm = (ts) => (ts && ts.length >= 16) ? ts.slice(11, 16) : "";
  const a = hhmm(l.start_at), b = hhmm(l.end_at);
  if (!a || a === "00:00") return "补记";
  return a === b ? a : `${a}-${b}`;
}

// 明细里的一条原始工时：✏️ 就地改成另一份分钟/备注，🗑 直接删掉（不进垃圾桶）
function logRow(it) {
  const row = el("div", "log-row");
  row.append(el("span", "task-meta",
    `${logSpan(it)} · ${fmt(it.minutes)}` + (it.note ? ` · ${it.note}` : "")));
  const editBtn = el("button", "btn-check");
  editBtn.append(icon("pencil"));
  editBtn.title = "改这条记录";
  editBtn.setAttribute("aria-label", "改这条记录");
  editBtn.onclick = () => {
    const form = el("div", "log-edit");
    const minI = el("input");
    minI.type = "number"; minI.min = "1"; minI.value = it.minutes;
    minI.title = "分钟";
    const noteI = el("input");
    noteI.type = "text"; noteI.value = it.note || ""; noteI.placeholder = "备注";
    const ok = el("button", "btn-check", "保存");
    ok.onclick = () => act(async () => {
      await api(`/api/logs/${it.id}`, "POST",
        { minutes: parseInt(minI.value, 10) || 0, note: noteI.value });
    });
    const cancel = el("button", "btn-check", "取消");
    cancel.onclick = () => form.replaceWith(row);
    form.append(el("span", "task-meta", logSpan(it)), minI, noteI, ok, cancel);
    row.replaceWith(form);
  };
  const delBtn = el("button", "btn-check");
  delBtn.append(icon("trash"));
  delBtn.title = "删这条记录";
  delBtn.setAttribute("aria-label", "删这条记录");
  delBtn.onclick = () => {
    if (!confirm(`删除这条 ${fmt(it.minutes)} 的记录？`)) return;
    act(async () => { await api(`/api/logs/${it.id}/delete`, "POST"); });
  };
  row.append(editBtn, delBtn);
  return row;
}

// loop 任务的「预估 vs 实际」校准建议：进统计页拉一次，采用后清缓存重拉
function loadCalib() {
  if (calibData || calibLoading) return;
  calibLoading = true;
  api("/api/stats/loop-calib")
    .then((r) => {
      calibData = r.items || [];
      calibMinN = r.min_n || 3;
      calibMap = new Map(calibData.map((it) => [`${it.project_id}\u0000${it.title}`, it]));
      calibLoading = false;
      for (const f of calibFills) f();   // 已经展开的项目卡就地重画，不用整页重渲染
    })
    .catch(() => { calibLoading = false; });
}

function openBackupModal() {
  closeDayModal();
  const overlay = el("div", "day-overlay");
  overlay.onclick = (e) => { if (e.target === overlay) closeDayModal(); };
  const panel = el("div", "day-panel backup-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "恢复备份");
  const head = el("div", "day-panel-head");
  head.append(el("div", "cal-title", "恢复备份"));
  const close = el("button", "btn-check");
  close.append(icon("x"));
  close.title = "关闭（Esc）";
  close.setAttribute("aria-label", "关闭");
  close.onclick = closeDayModal;
  head.append(close);
  panel.append(head);
  panel.append(el("div", "pool-hint",
    "选中的备份会覆盖当前全部数据。原备份会保留，覆盖前还会自动生成一份重要回滚点。"));
  const list = el("div", "backup-list");
  list.setAttribute("aria-live", "polite");
  list.append(el("div", "empty", "正在读取备份…"));
  panel.append(list);
  overlay.append(panel);
  document.body.append(overlay);
  dayModal = overlay;
  close.focus();

  api("/api/backups").then(data => {
    list.innerHTML = "";
    if (!(data.items || []).length) {
      list.append(el("div", "empty", "还没有备份，先点「立即备份」吧"));
      return;
    }
    for (const item of data.items) {
      const row = el("div", "day-row backup-row");
      const text = el("div", "backup-row-text");
      text.append(el("div", "task-title",
        (item.important ? "重要回滚点 · " : "") + item.file));
      const bits = [];
      if (item.at) bits.push(item.at.replace("T", " "));
      if (item.size != null) bits.push(`${Math.max(1, Math.round(item.size / 1024))} KB`);
      if (item.counts) bits.push(`项目 ${item.counts.projects} · 任务 ${item.counts.tasks} · 工时 ${item.counts.work_logs}`);
      text.append(el("div", "task-meta", bits.join(" · ")));
      if (item.error) text.append(el("div", "task-meta", item.error));
      row.append(text);
      const restore = el("button", "btn-primary", "恢复这份");
      restore.disabled = !!item.error;
      restore.onclick = () => {
        if (!confirm(`确定用 ${item.file} 覆盖当前全部数据吗？\n原备份会保留，当前数据也会先另存为重要回滚点。`)) return;
        closeDayModal();
        act(async () => {
          const r = await api("/api/backup/restore", "POST", { file: item.file });
          alert(`已恢复备份：${r.file}\n恢复前的数据已保存为：${r.backup}\n如果选错了，可以再恢复这份回滚点。`);
        });
      };
      row.append(restore);
      list.append(row);
    }
  }).catch(e => {
    list.innerHTML = "";
    list.append(el("div", "empty", "读取备份失败：" + e.message));
  });
}

function renderStats(root) {
  const card = el("div", "card");
  card.append(el("div", "section-title", "最近 14 天投入"));
  // 这一页的横轴是工时账（work_logs.date），「今天」跟着逻辑日走，不跟排期翻页
  const acctToday = state.logical_today || state.today;
  const bars = el("div", "bars");
  const max = Math.max(1, ...state.recent_days.map(d => d.minutes));
  for (const d of state.recent_days) {
    const col = el("div", "bar-col");
    const bar = el("div", "bar" + (d.date === acctToday ? " today" : ""));
    bar.style.height = (d.minutes / max) * 100 + "%";
    const routine = d.routine || 0;
    // 日常/重复（loop）工时在柱底单独着色：不然每天都被它淹成一条平的柱子
    if (routine > 0 && d.minutes > 0) {
      const seg = el("div", "bar-routine");
      seg.style.height = (routine / d.minutes) * 100 + "%";
      bar.append(seg);
    }
    bar.title = routine > 0
      ? `${d.date}: ${fmt(d.minutes)}（含日常·重复 ${fmt(routine)}）`
      : `${d.date}: ${fmt(d.minutes)}`;
    col.append(bar);
    col.append(el("div", "bar-label", d.date.slice(5)));
    bars.append(col);
  }
  card.append(bars);
  const legend = el("div", "bar-legend legend-row");
  legend.append(legendChip("#7f9b78", "日常·重复（loop）工时"),
    legendChip("#c9b894", "其它任务（项目推进）"));
  card.append(legend);
  root.append(card);

  // 每天 × 各项目投入（堆叠柱，点柱子看当天明细）
  root.append(el("div", "section-title", "每天 · 各项目投入"));
  const dpCard = el("div", "card dp-card");
  const rangeRow = el("div", "form-row");
  const dpBody = el("div");
  let dpDays = 14;
  let dpRange = "";   // "month"/"year"：和 dpDays 二选一，非空时以它为准
  let lastDp = null;  // 最近一次"每天·各项目投入"的数据
  const dpBtns = [];  // [{b, on}] 供 renderDp 统一刷新选中态
  const rangeSubs = [];  // 区间变了要跟着重拉的下游块（标签统计）
  const dpLabel = () => dpRange === "month" ? "本月"
    : dpRange === "year" ? "今年" : `近${dpDays}天`;
  const renderDp = async () => {
    for (const it of dpBtns) it.b.classList.toggle("btn-primary", it.on());
    const data = await api(`/api/stats/daily?${dpRange ? `range=${dpRange}` : `days=${dpDays}`}`);
    lastDp = { daysArr: data.days, workdays: data.workdays || 0,
               loops: data.loops || {}, label: dpLabel() };
    dpBody.innerHTML = "";
    let daysArr = data.days;
    if (dpRange === "year") {
      // 年度按月聚合，不然一年三百多根柱子挤成一片
      const byMonth = new Map();
      for (const d of daysArr) {
        const key = d.date.slice(0, 7);
        let m = byMonth.get(key);
        if (!m) { m = { date: key, total: 0, parts: [], logs: [], done: [], pm: {} }; byMonth.set(key, m); }
        m.total += d.total;
        for (const pt of d.parts) {
          const cur = m.pm[pt.name] ||= { name: pt.name, color: pt.color, minutes: 0 };
          cur.minutes += pt.minutes;
        }
        m.logs.push(...d.logs);
        m.done.push(...d.done);
      }
      daysArr = [...byMonth.values()];
      for (const m of daysArr) { m.parts = Object.values(m.pm); delete m.pm; }
    }
    const max = Math.max(1, ...daysArr.map(d => d.total));
    const bars2 = el("div", "bars");
    const detail = el("div", "dp-detail");
    const showDetail = (d) => {
      detail.innerHTML = "";
      detail.append(el("div", "pool-hint", `${d.date} · 共投入 ${fmt(d.total)}`));
      // 按项目分组：折叠菜单，外层一眼看清各项目当天投入，点开看明细
      const colorOf = {};
      for (const pt of d.parts) colorOf[pt.name] = pt.color;
      const groups = {};
      const ensure = (name) => groups[name] ||=
        { name, color: colorOf[name] || "#b8ad9a", minutes: 0, logs: {}, done: [] };
      for (const pt of d.parts) ensure(pt.name).minutes = pt.minutes;
      for (const l of d.logs) {
        const g = ensure(l.project);
        const key = l.task || "（未关联任务）";
        const cur = g.logs[key] || { minutes: 0, notes: [], est: null, items: [] };
        cur.minutes += l.minutes;  // 同任务多次计时合并
        if (cur.est == null && l.estimate_min != null) cur.est = l.estimate_min;
        if (l.routine) cur.routine = 1;
        if (l.note && !cur.notes.includes(l.note)) cur.notes.push(l.note);
        cur.items.push(l);  // 合并行下面还要按条列出，供改/删
        g.logs[key] = cur;
      }
      for (const tsk of d.done) ensure(tsk.project).done.push(tsk);
      const names = Object.keys(groups).sort((a, b) => groups[b].minutes - groups[a].minutes);
      if (!names.length) { detail.append(el("div", "empty", "这天没有记录")); return; }
      for (const name of names) {
        const g = groups[name];
        const det = el("details", "dp-proj");
        const sum = el("summary");
        const dot = el("span", "color-dot");
        dot.style.background = g.color;
        sum.append(dot, el("span", "task-title", name), el("span", "task-meta", fmt(g.minutes)));
        det.append(sum);
        // 每个任务一行：✅ 当天完成 / ⏳ 还在持续 / 📝 未关联记录；预估 vs 实际
        const doneMap = {};
        for (const tsk of g.done) doneMap[tsk.title] = tsk;
        const keys = [...new Set([...Object.keys(g.logs), ...Object.keys(doneMap)])]
          .sort((a, b) => (g.logs[b]?.minutes || 0) - (g.logs[a]?.minutes || 0));
        if (!keys.length) det.append(el("div", "empty", "无明细"));
        for (const key of keys) {
          const lg = g.logs[key];
          const dn = doneMap[key];
          const est = dn ? dn.estimate_min : (lg ? lg.est : null);
          const actual = lg ? lg.minutes : null;
          const stIcon = dn ? icon("check", "ic-ok")
            : icon(key === "（未关联任务）" ? "file" : "clock", "ic-soft");
          const isLoop = (dn && dn.routine) || (lg && lg.routine);
          const r = el("div", "rank-row");
          const rkTitle = el("span", "task-title");
          rkTitle.append(stIcon);
          if (isLoop) rkTitle.append(icon("loop", "ic-routine"));
          rkTitle.append(document.createTextNode(
            key + (lg && lg.notes.length ? `（${lg.notes.join("；")}）` : "")));
          r.append(rkTitle);
          r.append(el("span", "task-meta",
            (est != null ? "预估 " + fmt(est) : "无预估") + " · " +
            (actual != null ? "实际 " + fmt(actual) : "无实际耗时")));
          det.append(r);
          // 合并行下面按条铺出原始记录：只有逐条才谈得上改哪一次、删哪一次
          for (const it of lg ? lg.items : []) det.append(logRow(it));
        }
        detail.append(det);
      }
    };
    for (const d of daysArr) {
      const col = el("div", "bar-col");
      const bar = el("div", "bar-stack");
      bar.style.height = (d.total / max) * 100 + "%";
      for (const pt of d.parts) {
        const seg = el("div", "bar-seg");
        seg.style.height = (pt.minutes / d.total) * 100 + "%";
        seg.style.background = pt.color;
        bar.append(seg);
      }
      bar.title = `${d.date}: ${fmt(d.total)}` +
        (d.parts.length ? "\n" + d.parts.map(pt => `${pt.name} ${fmt(pt.minutes)}`).join("\n") : "");
      col.append(bar);
      col.append(el("div", "bar-label",
        dpRange === "year" ? parseInt(d.date.slice(5), 10) + "月" : d.date.slice(8)));
      col.onclick = () => {
        bars2.querySelectorAll(".bar-stack").forEach(b => b.classList.remove("sel"));
        bar.classList.add("sel");
        showDetail(d);
      };
      if (d.date === acctToday ||
          (dpRange === "year" && d.date === acctToday.slice(0, 7))) bar.classList.add("sel");
      bars2.append(col);
    }
    dpBody.append(bars2, detail);
    showDetail(daysArr[daysArr.length - 1]);
  };
  for (const n of [7, 14, 30]) {
    const b = el("button", null, `近${n}天`);
    b.onclick = () => { dpDays = n; dpRange = "";
      renderDp().catch(e => alert(e.message));
      for (const f of rangeSubs) f(); };
    dpBtns.push({ b, on: () => !dpRange && dpDays === n });
    rangeRow.append(b);
  }
  for (const [val, txt] of [["month", "本月"], ["year", "今年"]]) {
    const b = el("button", null, txt);
    b.onclick = () => { dpRange = val;
      renderDp().catch(e => alert(e.message));
      for (const f of rangeSubs) f(); };
    dpBtns.push({ b, on: () => dpRange === val });
    rangeRow.append(b);
  }
  dpCard.append(rangeRow, dpBody);
  root.append(dpCard);
  renderDp().catch(e => alert(e.message));

  root.append(el("div", "section-title", "项目累计投入"));
  const rank = el("div", "card");
  const sorted = [...state.projects].sort((a, b) => b.total_invested_min - a.total_invested_min);
  if (!sorted.length) rank.append(el("div", "empty", "还没有记录"));
  calibFills = [];
  // loop 行后面那截「预估 vs 近几次均值 → 建议」，样本不够就说再攒几天。
  // 建议值后端已经四舍五入到 5 的倍数、也钳过 ±30%，这里只负责说人话
  const calibRow = (p, title) => {
    const it = calibMap && calibMap.get(`${p.id}\u0000${title}`);
    if (!it) return null;
    const row = el("div", "rank-row calib-row");
    const estTxt = it.est == null ? "无预估" : "预估 " + fmt(it.est);
    let txt;
    if (!it.samples) {
      txt = `${estTxt} · 还没计时样本`;
    } else if (!it.suggestion) {
      if (it.short_est) {
        txt = `${estTxt} · 近${it.samples}次均值 ${fmt(it.mean_actual)} · 预估太短，不校准`;
      } else if (it.samples < calibMinN) {
        txt = `${estTxt} · 近${it.samples}次均值 ${fmt(it.mean_actual)} · ` +
              `样本 ${it.samples}/${calibMinN}，再攒几天`;
      } else {
        txt = `${estTxt} · 近${it.samples}次均值 ${fmt(it.mean_actual)} · 差不多，先不动`;
      }
    } else {
      const sg = it.suggestion;
      txt = `${estTxt} · 近${it.samples}次均值 ${fmt(it.mean_actual)}` +
        (sg.delta_min ? `（${sg.direction} ${fmt(Math.abs(sg.delta_min))}）` : "") +
        (it.est == null ? " → 建议设为 " : " → 建议 ") + fmt(sg.est_new);
    }
    row.append(el("span", "task-meta", txt));
    if (it.suggestion && it.task_id) {
      const btn = el("button", "btn-check calib-adopt", "采用");
      btn.title = `把预估改成 ${fmt(it.suggestion.est_new)}`;
      btn.onclick = () => {
        const from = it.est == null ? "无预估" : fmt(it.est);
        // 偏差超过 est 一半时后端会带 warning：不拦着改，只提醒先看看记录
        const warn = it.suggestion.warning ? `\n\n注意：${it.suggestion.warning}` : "";
        if (!confirm(`把「${it.title}」的预估从 ${from} 改为 ${fmt(it.suggestion.est_new)}？` + warn)) return;
        calibData = null;   // 采完清缓存，下次进统计页重新算
        calibMap = null;
        act(async () => {
          await api(`/api/tasks/${it.task_id}`, "POST",
                    { estimate_min: it.suggestion.est_new });
        });
      };
      row.append(btn);
    }
    return row;
  };
  for (const p of sorted) {
    const det = el("details", "dp-proj");
    const sum = el("summary");
    const dot = el("span", "color-dot");
    dot.style.background = p.color;
    sum.append(dot, el("span", "task-title", p.name),
              el("span", "task-meta", fmt(p.total_invested_min)));
    det.append(sum);
    const body = el("div");
    det.append(body);
    // 展开时才填充：逐 loop 耗时和校准建议，跟随上面的天数区间
    const fill = () => {
      body.innerHTML = "";
      const metaRow = (text, indent) => {
        const r = el("div", "rank-row");
        const s = el("span", "task-meta", text);
        if (indent) s.style.paddingLeft = "14px";
        r.append(s);
        return r;
      };
      if (!lastDp) { body.append(metaRow("计算中…")); return; }
      const loops = lastDp.loops[p.name] || [];
      if (!loops.length) {
        body.append(metaRow(`loop 任务：${lastDp.label}暂无记录`));
      } else {
        body.append(metaRow(`loop 任务（${lastDp.label}）`));
        for (const l of loops) {
          body.append(metaRow(`${l.task} · ${fmt(l.minutes)}`, true));
          const cr = calibRow(p, l.task);
          if (cr) body.append(cr);
        }
      }
    };
    det.ontoggle = () => { if (det.open) { loadCalib(); fill(); } };
    calibFills.push(() => { if (det.open) fill(); });
    rank.append(det);
  }
  root.append(rank);

  // 🏷 按标签统计：同一类活（qc、检索…）的均次耗时。不定时不定量的重复活没法用
  // loop 那套管，就靠标签归堆算均值。折叠着，展开才拉数据；区间跟着上面那排按钮走
  root.append(el("div", "section-title", "按标签统计"));
  const tagDet = el("details", "card tag-stats");
  const tagSum = el("summary");
  const tagBody = el("div");
  const tagLabel = () => dpRange === "month" ? "本月"
    : dpRange === "year" ? "今年" : `近${dpDays}天`;
  // 摘要行随时能把区间说对：折起来时切区间也不会显旧标签
  const setTagSum = (n) => {
    tagSum.innerHTML = "";
    tagSum.append(el("span", null, `🏷 按标签算均次耗时 · ${tagLabel()}`));
    if (n != null) tagSum.append(el("span", "task-meta", `${n} 个标签`));
  };
  const fillTags = (items) => {
    setTagSum(items.length);
    tagBody.innerHTML = "";
    if (!items.length) {
      tagBody.append(el("div", "empty", "这段时间还没有带标签的完成记录"));
      return;
    }
    // 一行数据的文字部分：完成几件、一共多久、均次多少。汇总行和项目行共用，
    // 两层的算法在后端是同一套，所以这里的写法也必须一模一样
    const tagBits = (o) => {
      const bits = [`完成 ${o.done_count} 件`, `共 ${fmt(o.total_min)}`];
      if (o.mean_min != null) bits.push(`均次 ${fmt(o.mean_min)}`);
      return bits;
    };
    // 实际均次跟预估均值差出三成，抬眼就能看见：估得不准的那一类先修
    const tagEst = (o) => {
      if (o.mean_est == null) return null;
      if (o.mean_min != null && Math.abs(o.mean_est - o.mean_min) > o.mean_est * 0.3) {
        const d = o.mean_est - o.mean_min;
        return el("span", "tag-off",
          `预估均值 ${fmt(o.mean_est)}，估${d > 0 ? "高" : "低"} ${fmt(Math.abs(d))}`);
      }
      return el("span", "tag-fair", `预估均值 ${fmt(o.mean_est)}`);
    };
    const tagExtra = (o) => {
      const extra = [];
      if (o.untimed_done) extra.push(`${o.untimed_done} 件没计时（不计入均次）`);
      if (o.wip_min) extra.push(`进行中的已投 ${fmt(o.wip_min)}`);
      extra.push(`现存 ${o.task_count} 件`);
      return el("div", "tag-extra", extra.join(" · "));
    };
    for (const it of items) {
      const projs = it.projects || [];
      // 只在一个项目里出现的 tag 没有可拆的，直接把项目名写在那一行上；
      // 跨项目的才给展开，点开看各项目自己的件数和均次
      if (projs.length <= 1) {
        const row = el("div", "rank-row tag-row");
        row.append(el("span", "task-title", "#" + it.tag));
        const bits = tagBits(it);
        if (projs[0]) bits.unshift(projs[0].project_name);
        row.append(el("span", "task-meta", bits.join(" · ")));
        const est = tagEst(it);
        if (est) row.append(est);
        row.append(tagExtra(it));
        tagBody.append(row);
        continue;
      }
      const det = el("details", "tag-item");
      const sum = el("summary", "tag-sum-row");
      sum.append(el("span", "task-title", "#" + it.tag));
      sum.append(el("span", "task-meta", tagBits(it).join(" · ")));
      const est = tagEst(it);
      if (est) sum.append(est);
      sum.append(el("span", "tag-projs", `${projs.length} 个项目`));
      det.append(sum);
      for (const p of projs) {
        const sub = el("div", "tag-sub");
        sub.append(el("span", "tag-sub-name", p.project_name));
        sub.append(el("span", "task-meta", tagBits(p).join(" · ")));
        const pest = tagEst(p);
        if (pest) sub.append(pest);
        sub.append(tagExtra(p));
        det.append(sub);
      }
      tagBody.append(det);
    }
  };
  const loadTags = async () => {
    setTagSum(null);
    tagBody.innerHTML = "";
    tagBody.append(el("div", "empty", "计算中…"));
    try {
      const data = await api(
        `/api/stats/tag-stats?${dpRange ? `range=${dpRange}` : `days=${dpDays}`}`);
      fillTags(data.items || []);
    } catch (e) {
      // 旧后端还没有这个接口时就地写一句，不弹窗打断（重启服务就好）
      tagBody.innerHTML = "";
      tagBody.append(el("div", "empty", e.message));
    }
  };
  tagDet.append(tagSum, tagBody);
  tagDet.ontoggle = () => { if (tagDet.open) loadTags(); };
  // 区间按钮变了：开着才重拉；折着就只把摘要上的区间改对，别白发请求
  rangeSubs.push(() => {
    if (tagDet.open) loadTags();
    else setTagSum(null);
  });
  setTagSum(null);
  root.append(tagDet);

  root.append(el("div", "section-title", "设置"));
  const setCard = el("div", "card settings-card");

  // 一条设置：左「标题 + 一句说明」，右控件；说明写不下的部分折进 ⓘ（手机默认收起）
  const settingRow = (title, desc, ctrl, moreText) => {
    const row = el("div", "setting-row");
    const text = el("div", "setting-text");
    const head = el("div", "setting-title", title);
    text.append(head);
    if (desc) text.append(el("div", "setting-desc", desc));
    if (moreText) {
      const info = el("button", "hint-btn", "ⓘ");
      info.title = "展开详细说明";
      const more = el("div", "setting-more hidden", moreText);
      info.onclick = () => more.classList.toggle("hidden");
      head.append(info);
      text.append(more);
    }
    const box = el("div", "setting-ctrl");
    box.append(...(Array.isArray(ctrl) ? ctrl : [ctrl]));
    // 开关的可见文字在左边一行里，给 checkbox 补个无障碍名字
    box.querySelectorAll("input[type=checkbox]").forEach(i => {
      if (!i.getAttribute("aria-label")) i.setAttribute("aria-label", title);
    });
    row.append(text, box);
    return row;
  };
  const numCtrl = (value, attrs, onSave) => {
    const input = el("input");
    input.type = "number";
    for (const k in attrs) input[k] = attrs[k];
    input.value = value;
    const btn = el("button", "btn-primary", "保存");
    btn.onclick = () => act(() => onSave(input));
    return [input, btn];
  };
  // 布尔开关：label 里包一个真 checkbox（保留 checkbox 语义、键盘可达），
  // 滑轨和圆点由 CSS 画；onchange 逻辑跟原来的勾选框一样
  const checkCtrl = (checked, onChange) => {
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.onchange = () => act(() => onChange(cb.checked));
    const wrap = el("label", "switch");
    wrap.append(cb, el("span", "switch-track"));
    return wrap;
  };
  // 分段按钮：一个键几个固定取值，点一下即保存，当前值高亮
  const segCtrl = (options, current, onPick) => {
    const box = el("div", "seg-ctrl");
    for (const v of options) {
      const b = el("button", "seg-btn" + (v === current ? " active" : ""), String(v));
      b.setAttribute("aria-pressed", v === current ? "true" : "false");
      b.onclick = () => act(() => onPick(v));
      box.append(b);
    }
    return box;
  };

  setCard.append(el("div", "setting-group", "目标"));
  setCard.append(settingRow("每日工作目标", "每天计划投入的工时，用于日目标挑战",
    numCtrl((state.daily_target_min || 480) / 60, { min: 0.5, step: 0.5 },
      (input) => api("/api/settings", "POST",
        { daily_target_min: Math.round(Number(input.value) * 60) }))));
  setCard.append(settingRow("动态结算", "勾掉的日常按实际工时降安全线",
    checkCtrl(state.dynamic_routine_settlement !== false,
      (on) => api("/api/settings", "POST", { dynamic_routine_settlement: on })),
    "开：勾掉的日常实例按实际工时结算——干得比预估快，安全线就真的降（按 min(实际, 预估)）；"
    + "超预估不扩线，只给「+Xm 超预估」角标；没计时的仍按预估算，不会当成做完了。"
    + "关：回到纯预估口径，勾掉也不降线，hero 下方的预览行会告诉你按实际结算本来能省多少"));

  setCard.append(el("div", "setting-group", "记账"));
  setCard.append(settingRow("新一天起点", "几点开始算新一天（凌晨干活算前一天）",
    numCtrl(state.day_start_hour ?? 7, { min: 0, max: 23, step: 1 },
      (input) => api("/api/settings", "POST", { day_start_hour: Number(input.value) })),
    "安全线、已投入、统计按此切换；今日排期和日历投影仍 0 点翻页"));

  setCard.append(el("div", "setting-group", "显示"));
  // 皮肤：五套配色下拉即选即换。纯前端 localStorage，不走 /api/settings，
  // 名字跟预览页对齐（经典 · 纸面 / 机能 · FIELD OPS / …）
  const skinSel = el("select");
  for (const [v, label] of THEME_NAMES) {
    const o = el("option", null, label);
    o.value = v;
    skinSel.append(o);
  }
  skinSel.value = themeGet();
  skinSel.onchange = () => themeSet(skinSel.value);
  setCard.append(settingRow("界面皮肤", "换个配色风格，选择只保存在这台设备", skinSel));
  setCard.append(settingRow("每日鞭策", "每天第一次打开时提醒：今天不做完，明天会堆多少",
    checkCtrl(localStorage.getItem(NAG_ON_KEY) !== "0",
      (on) => localStorage.setItem(NAG_ON_KEY, on ? "1" : "0")),
    "只弹一次不纠缠，内容按今天剩余的日常、项目推进和明天已排任务现算；选择只保存在这台设备"));
  setCard.append(settingRow("项目前缀", "任务名显示为「项目-任务」",
    checkCtrl(!!state.show_project_prefix,
      (on) => api("/api/settings", "POST", { show_project_prefix: on }))));
  setCard.append(settingRow("双轨显示", "计划与实际分两条横条展示",
    checkCtrl(state.show_dual_track !== false,
      (on) => api("/api/settings", "POST", { show_dual_track: on })),
    "开：今日 hero 上面一条「计划」（日常·重复 + 项目推进的预估），下面一条「实际」（已投入的实色）；"
    + "关：回到原来一条横条，实际压在计划构成上"));
  // 「下一件推荐」的设置搬到今日页那张卡的 ⚙ 里了（列几件 / 小额阈值 / 优先项目
  // 都在那儿，就地改），这里不再留第二套入口

  setCard.append(el("div", "setting-group", "系统"));
  // 局域网：开关只改配置，真正生效要重新 bind 端口。所以这里分开说「配置」和
  // 「现在实际绑在哪」，待重启时给一个「立即重启」，不然用户会以为关掉了其实还开着
  const lanPending = !!state.lan_restart_pending;
  const lanRuntime = state.lan_runtime !== undefined ? state.lan_runtime : state.lan_access;
  const lanDesc = lanPending
    ? (state.lan_access === false
        ? "已保存、待重启。当前仍开放局域网：手机现在还能连"
        : "已保存、待重启。重启后手机才能连（现在只有本机能开）")
    : (lanRuntime ? "开着：手机连同一 Wi-Fi 就能访问" : "关着：只有这台电脑能打开页面");
  const lanRow = settingRow("局域网访问", lanDesc,
    checkCtrl(state.lan_access !== false,
      (on) => api("/api/settings", "POST", { lan_access: on })),
    "开：服务绑在所有网卡上，手机连同一个 Wi-Fi 打开页面顶部那行 📱 地址就能用（默认）。"
    + "关：只绑 127.0.0.1，只有这台电脑能打开页面。"
    + "改完不会立刻生效——绑定的地址是启动时定下的，必须重启服务才会换，"
    + "所以改完这里会显示「已保存、待重启」，点「立即重启」生效。");
  setCard.append(lanRow);
  if (lanPending) {
    const lanBox = el("div", "lan-pending");
    lanBox.append(el("div", "lan-pending-text",
      state.lan_access === false
        ? "注意：已保存「关闭」。重启之前，同一 Wi-Fi 下的手机仍然能打开这个页面"
        : "注意：已保存「开启」。重启之后，手机才能访问这个页面"));
    const rBtn = el("button", "btn-primary lan-restart", "立即重启");
    const rMsg = el("div", "lan-pending-hint");
    rBtn.onclick = async () => {
      rBtn.disabled = true;
      rBtn.textContent = "重启中…";
      rMsg.textContent = "正在重启，页面会自动恢复…";
      rMsg.className = "lan-pending-hint";
      try {
        await api("/api/restart", "POST", {});
        await waitServerBack();
        rMsg.textContent = "已重启，设置已生效";
        rMsg.className = "lan-pending-hint ok";
        await refresh();
      } catch (e) {
        rBtn.disabled = false;
        rBtn.textContent = "立即重启";
        rMsg.textContent = "重启失败：" + (e && e.message ? e.message : "服务没有回来")
          + "（可以手动关掉服务再启动一次）";
        rMsg.className = "lan-pending-hint err";
      }
    };
    lanBox.append(rBtn, rMsg);
    setCard.append(lanBox);
  }
  // 默认跳转页下载后即可用；自托管用户在这里改一次，设置随 SQLite 持久保存。
  const goUrlInput = el("input");
  goUrlInput.id = "pace-go-url-input";
  goUrlInput.type = "url";
  goUrlInput.value = state.pace_go_url || PACE_GO_URL;
  goUrlInput.placeholder = PACE_GO_URL;
  goUrlInput.maxLength = 500;
  goUrlInput.autocomplete = "off";
  goUrlInput.spellcheck = false;
  goUrlInput.setAttribute("aria-label", "跳转页地址");
  const goUrlSave = el("button", "btn-primary", "保存");
  goUrlSave.id = "pace-go-url-save";
  goUrlSave.onclick = () => act(() => api("/api/settings", "POST",
    { pace_go_url: goUrlInput.value }));
  const goUrlReset = el("button", null, "恢复默认");
  goUrlReset.id = "pace-go-url-reset";
  goUrlReset.onclick = () => act(() => api("/api/settings", "POST", { pace_go_url: "" }));
  const goUrlRow = settingRow("跳转页地址", "默认使用发布者的 GitHub Pages；自托管时可替换",
    [goUrlInput, goUrlSave, goUrlReset],
    "只下载代码、不自己部署时，保留默认地址就能用。设置保存在本机数据库，重启和升级都不会清空；"
    + "保存后，下次打开「手机访问」就会用新地址生成二维码。留空或点「恢复默认」回到发布者的跳转页。");
  goUrlRow.classList.add("go-url-row");
  setCard.append(goUrlRow);

  const bk = state.backup || {};
  const bkDesc = bk.error
    ? `上次失败：${bk.error}`
    : (bk.last ? `上次 ${bk.last}${bk.count ? ` · 共 ${bk.count} 份` : ""}`
               : "还没备份过");
  const bkBtn = el("button", null, "立即备份");
  const restoreBtn = el("button", null, "恢复备份");
  restoreBtn.onclick = openBackupModal;
  const bkRow = settingRow("数据备份", bkDesc, [bkBtn, restoreBtn],
    `启动时和每天第一次打开时各备份一次，存到 ${bk.dir || "data/backup/"}，`
    + `普通备份保留最近 ${bk.keep || 7} 份，同步/恢复前的重要回滚点另留 ${bk.important_keep || 3} 份。`
    + "备份方式是在线快照，服务正在写库时也不会备份出半个坏库。"
    + "点「恢复备份」可查看每份的数据条数并恢复，原备份不会被删掉。备份失败不影响使用，只会在这里和启动窗口里提示。");
  // 备份成功后立刻把「上次 xxx.db」换成新文件名，不用等下次刷新
  const bkDescEl = bkRow.querySelector(".setting-desc");
  bkBtn.onclick = async () => {
    bkBtn.disabled = true;
    bkBtn.textContent = "备份中…";
    try {
      const r = await api("/api/backup", "POST", {});
      bkBtn.textContent = "已备份";
      bkDescEl.textContent = `上次 ${r.file} · 共 ${r.count} 份`;
      alert(`已备份：${r.file}\n位置：${r.dir}\n普通备份保留最近 ${r.keep} 份，重要回滚点另留 ${bk.important_keep || 3} 份。\n`
            + "换电脑时把整个 backup 目录拷走就行。");
    } catch (e) {
      bkBtn.textContent = "备份失败";
      bkDescEl.textContent = "上次失败：" + e.message;
      alert("备份失败：" + e.message);
    } finally {
      setTimeout(() => { bkBtn.disabled = false; bkBtn.textContent = "立即备份"; }, 1500);
    }
  };
  setCard.append(bkRow);

  // 🔄 局域网同步：两台电脑互传整库，换机/多机用；方向错了会拦
  setCard.append(el("div", "setting-group", "局域网同步"));
  const syncDeviceInput = el("input");
  syncDeviceInput.type = "text";
  syncDeviceInput.placeholder = "家里的电脑";
  syncDeviceInput.value = state.sync_device || "";
  syncDeviceInput.onchange = () => api("/api/settings", "POST",
    { sync_device: syncDeviceInput.value });
  setCard.append(settingRow("本机设备名", "在对比时显示，方便认出哪台是哪台", syncDeviceInput));

  const syncPeerInput = el("input");
  syncPeerInput.type = "text";
  syncPeerInput.placeholder = "http://192.168.x.x:18630";
  syncPeerInput.value = state.sync_peer || "";
  syncPeerInput.onchange = () => api("/api/settings", "POST",
    { sync_peer: syncPeerInput.value });
  setCard.append(settingRow("对端地址", "另一台运行日拱一卒的电脑地址（含端口号）", syncPeerInput));

  const syncStatus = el("div", "sync-status hidden");
  const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleString() : "未知";
  const renderPeerInfo = (data) => {
    syncStatus.classList.remove("hidden");
    if (!data || !data.peer) {
      syncStatus.textContent = data.error || "没查到对端信息";
      syncStatus.className = "sync-status err";
      return;
    }
    const l = data.local, p = data.peer;
    syncStatus.className = "sync-status";
    syncStatus.innerHTML = `
      <div>本机：<b>${l.device}</b> · v${l.version} · ${fmtTime(l.db_mtime)} ·
        项目 ${l.counts.projects} / 任务 ${l.counts.tasks} / 工时 ${l.counts.work_logs}</div>
      <div>对端：<b>${p.device}</b> · v${p.version} · ${fmtTime(p.db_mtime)} ·
        项目 ${p.counts.projects} / 任务 ${p.counts.tasks} / 工时 ${p.counts.work_logs}</div>
    `;
  };

  const checkPeerBtn = el("button", null, "检查对端");
  checkPeerBtn.onclick = async () => {
    checkPeerBtn.disabled = true;
    checkPeerBtn.textContent = "检查中…";
    try {
      const peer = syncPeerInput.value.trim();
      if (!peer) { alert("先填对端地址"); return; }
      const r = await api(`/api/sync/peer_info?peer=${encodeURIComponent(peer)}`);
      renderPeerInfo(r);
    } catch (e) {
      alert("检查失败：" + e.message);
    } finally {
      checkPeerBtn.disabled = false;
      checkPeerBtn.textContent = "检查对端";
    }
  };

  const doPull = async (force) => {
    const peer = syncPeerInput.value.trim();
    if (!peer) { alert("先填对端地址"); return; }
    const r = await api("/api/sync/pull", "POST", { peer, force });
    if (r.conflict) {
      const localNewer = r.local.db_mtime >= r.peer.db_mtime;
      const mine = fmtTime(r.local.db_mtime);
      const theirs = fmtTime(r.peer.db_mtime);
      const msg = localNewer
        ? `本机的数据比对端新（本机 ${mine} / 对端 ${theirs}），继续拉取会用对端较旧的数据覆盖本机。确定要拉取吗？`
        : `对端的数据比本机新（对端 ${theirs} / 本机 ${mine}），继续拉取会用对端数据覆盖本机。确定要拉取吗？`;
      if (!confirm(msg)) return;
      return doPull(true);
    }
    alert("拉取成功：已自动备份为 " + r.backup);
    await refresh();
  };

  const doPush = async (force) => {
    const peer = syncPeerInput.value.trim();
    if (!peer) { alert("先填对端地址"); return; }
    const r = await api("/api/sync/push", "POST", { peer, force });
    if (r.conflict) {
      const peerNewer = r.peer.db_mtime >= r.local.db_mtime;
      const mine = fmtTime(r.local.db_mtime);
      const theirs = fmtTime(r.peer.db_mtime);
      const msg = peerNewer
        ? `对端的数据比本机新（对端 ${theirs} / 本机 ${mine}），继续推送会用本机较旧的数据覆盖对端。确定要推送吗？`
        : `本机的数据比对端新（本机 ${mine} / 对端 ${theirs}），继续推送会用本机数据覆盖对端。确定要推送吗？`;
      if (!confirm(msg)) return;
      return doPush(true);
    }
    alert("推送成功：对端已自动备份为 " + (r.backup || "（未知）"));
    await refresh();
  };

  const pullBtn = el("button", null, "从对端拉取");
  pullBtn.onclick = () => act(() => doPull(false));
  const pushBtn = el("button", null, "推送到对端");
  pushBtn.onclick = () => act(() => doPush(false));
  const syncHint = el("div", "sync-hint",
    "拉取 = 对端覆盖本机；推送 = 本机覆盖对端。换电脑前推一下，换电脑后拉一下；方向错了会拦。");
  const syncRow = el("div", "setting-row sync-row");
  const syncCtrl = el("div", "setting-ctrl");
  syncCtrl.append(checkPeerBtn, pullBtn, pushBtn, syncHint);
  syncRow.append(el("div", "setting-text"), syncCtrl);
  setCard.append(syncRow, syncStatus);

  // 🔄 自动更新：从 GitHub Pages 更新源拉新版，自动备份旧文件
  setCard.append(el("div", "setting-group", "自动更新"));
  const updateBox = el("div", "update-box");
  if (state.dev_no_update) {
    updateBox.append(el("div", "update-dev-hint",
      "这台是开发机，自动更新已禁用（BASE 下存在 DEV-NO-UPDATE 文件）。"));
    setCard.append(updateBox);
  } else {
    const updateUrlInput = el("input");
    updateUrlInput.type = "text";
    updateUrlInput.placeholder = UPDATE_BASE;
    updateUrlInput.value = state.update_url || "";
    updateUrlInput.onchange = () => api("/api/settings", "POST",
      { update_url: updateUrlInput.value });
    setCard.append(settingRow("更新源地址", "留空用默认 GitHub Pages，自部署可填自己的地址",
      updateUrlInput));

    const updateCheckBtn = el("button", null, "检查更新");
    const updateApplyBtn = el("button", "btn-primary", "立即更新");
    const updateRestartBtn = el("button", "btn-primary", "立即重启生效");
    const peerUpdateBtn = el("button", null, "从对端更新");
    const updateStatus = el("div", "update-status hidden");
    updateApplyBtn.classList.add("hidden");
    updateRestartBtn.classList.add("hidden");

    let lastCheck = null;       // 默认源 check 结果
    let peerCheck = null;       // 对端源 check 结果
    let pendingBase = null;     // updateApplyBtn 当前对应哪个 base

    const showCheckResult = (r, isPeer) => {
      updateStatus.classList.remove("hidden");
      const source = isPeer ? "对端" : "更新源";
      if (r.error) {
        updateStatus.textContent = `检查失败：${r.error}`;
        updateStatus.className = "update-status err";
        return false;
      }
      if (r.current === r.remote || r.changes.length === 0) {
        updateStatus.textContent = `已是最新：本机 v${r.current}，${source} v${r.remote || "未知"}`;
        updateStatus.className = "update-status ok";
        return false;
      }
      updateStatus.textContent = `有新版：本机 v${r.current} → ${source} v${r.remote}，共 ${r.changes.length} 个文件待更新`;
      updateStatus.className = "update-status";
      return true;
    };

    const doApply = async (base, isPeer) => {
      const source = isPeer ? "对端" : "更新源";
      updateApplyBtn.disabled = true;
      updateApplyBtn.textContent = "更新中…";
      try {
        const r = await api("/api/update/apply", "POST", base ? { base } : {});
        if (r.need_restart) {
          alert(`已从${source}更新 ${r.updated.length} 个文件，旧文件备份在 data/backup/${r.backup}\n重启后生效。`);
          updateApplyBtn.classList.add("hidden");
          peerUpdateBtn.classList.remove("hidden");
          updateRestartBtn.classList.remove("hidden");
          updateStatus.textContent = `已更新 ${r.updated.length} 个文件，待重启生效`;
        } else {
          alert(`已从${source}更新 ${r.updated.length} 个文件（无需重启）\n备份目录：data/backup/${r.backup}`);
          updateStatus.textContent = `已更新 ${r.updated.length} 个文件`;
        }
      } catch (e) {
        alert("更新失败：" + e.message);
      } finally {
        updateApplyBtn.disabled = false;
        updateApplyBtn.textContent = "立即更新";
      }
    };

    updateCheckBtn.onclick = async () => {
      updateCheckBtn.disabled = true;
      updateCheckBtn.textContent = "检查中…";
      updateApplyBtn.classList.add("hidden");
      updateRestartBtn.classList.add("hidden");
      peerUpdateBtn.classList.remove("hidden");
      try {
        const r = await api("/api/update/check");
        lastCheck = r;
        peerCheck = null;
        pendingBase = null;
        if (showCheckResult(r, false)) {
          updateApplyBtn.classList.remove("hidden");
        }
      } catch (e) {
        updateStatus.classList.remove("hidden");
        updateStatus.className = "update-status err";
        updateStatus.textContent = "检查失败：" + e.message;
      } finally {
        updateCheckBtn.disabled = false;
        updateCheckBtn.textContent = "检查更新";
      }
    };

    updateApplyBtn.onclick = () => doApply(pendingBase, !!peerCheck);

    peerUpdateBtn.onclick = async () => {
      const peer = (state.sync_peer || "").trim();
      if (!peer) {
        alert("先去「局域网同步」里填对端地址，才能从对端更新。");
        return;
      }
      peerUpdateBtn.disabled = true;
      peerUpdateBtn.textContent = "检查中…";
      updateApplyBtn.classList.add("hidden");
      updateRestartBtn.classList.add("hidden");
      try {
        const r = await api(`/api/update/check?base=${encodeURIComponent(peer + "/release")}`);
        peerCheck = r;
        lastCheck = null;
        pendingBase = peer + "/release";
        if (showCheckResult(r, true)) {
          if (confirm(`对端有新版 v${r.remote}，本机 v${r.current}。确定从对端更新吗？`)) {
            await doApply(pendingBase, true);
          }
        }
      } catch (e) {
        updateStatus.classList.remove("hidden");
        updateStatus.className = "update-status err";
        updateStatus.textContent = "检查失败：" + e.message;
      } finally {
        peerUpdateBtn.disabled = false;
        peerUpdateBtn.textContent = "从对端更新";
      }
    };

    updateRestartBtn.onclick = async () => {
      updateRestartBtn.disabled = true;
      updateRestartBtn.textContent = "重启中…";
      try {
        await api("/api/restart", "POST", {});
        await waitServerBack();
        updateStatus.textContent = "已重启，正在运行新版本";
        updateStatus.className = "update-status ok";
        await refresh();
      } catch (e) {
        updateStatus.textContent = "重启失败：" + e.message;
        updateStatus.className = "update-status err";
        updateRestartBtn.disabled = false;
        updateRestartBtn.textContent = "立即重启生效";
      }
    };

    const updateHint = el("div", "update-hint",
      "公司电脑建议开；家里这台是开发机别开。开启后点「检查更新」才会联网。"
      + "两台电脑同网络时可点「从对端更新」，不用连 GitHub。");
    const updateCtrl = el("div", "update-ctrl");
    updateCtrl.append(updateCheckBtn, updateApplyBtn, peerUpdateBtn, updateRestartBtn, updateHint);
    setCard.append(settingRow("自动检查更新",
      "允许从更新源下载新版 app.py、前端资源和说明文档",
      checkCtrl(!!state.update_enabled,
        (on) => api("/api/settings", "POST", { update_enabled: on }))));
    const updateRow = el("div", "setting-row update-row");
    const updateCtrlWrap = el("div", "setting-ctrl");
    updateCtrlWrap.append(updateCtrl);
    updateRow.append(el("div", "setting-text"), updateCtrlWrap);
    setCard.append(updateRow);
    setCard.append(updateStatus);
  }

  // 📤 历史数据导出：格式 / 项目范围 / 日期范围 / 三档脱敏，直接下载文件。
  // 日期范围只筛工时记录，任务和项目是全量上下文（说明里也写了这句）。
  const expDet = el("details", "export-box");
  const expSum = el("summary");
  expSum.append(icon("upload"), document.createTextNode("历史数据导出"));
  expDet.append(expSum);
  const expBody = el("div", "export-body");
  expDet.append(expBody);
  expDet.open = exportOpen;
  expDet.ontoggle = () => { exportOpen = expDet.open; };
  const expRow = (label, ...ctrls) => {
    const row = el("div", "export-row");
    row.append(el("div", "export-label", label));
    const ctrl = el("div", "export-ctrl");
    ctrl.append(...ctrls);
    row.append(ctrl);
    return row;
  };
  const expHint = el("div", "export-hint");

  // 格式：两个按钮自己管高亮，不往服务端存
  let expFmt = "xlsx";
  const fmtBtns = {};
  const fmtBox = el("div", "seg-ctrl");
  for (const [v, label] of [["xlsx", "Excel（.xlsx）"], ["json", "JSON"]]) {
    const b = el("button", "seg-btn" + (v === expFmt ? " active" : ""), label);
    b.type = "button";
    b.setAttribute("aria-pressed", v === expFmt ? "true" : "false");
    b.onclick = () => {
      expFmt = v;
      for (const k in fmtBtns) {
        fmtBtns[k].classList.toggle("active", k === v);
        fmtBtns[k].setAttribute("aria-pressed", k === v ? "true" : "false");
      }
    };
    fmtBtns[v] = b;
    fmtBox.append(b);
  }
  expBody.append(expRow("格式", fmtBox));

  // 项目多选：全勾 = 全部项目（此时不传 id 列表，连已删除项目的工时历史一起带上）
  const projChecks = [];
  const checkList = el("div", "export-check-list");
  for (const p of (state.projects || [])) {
    const lab = el("label", "export-check");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.value = String(p.id);
    const dot = el("span", "export-dot");
    dot.style.background = p.color || "#bbb";
    lab.append(cb, dot, el("span", null, p.name));
    checkList.append(lab);
    projChecks.push(cb);
  }
  const pickedIds = () => projChecks.filter(c => c.checked).map(c => Number(c.value));
  const allPicked = () => projChecks.length > 0 && projChecks.every(c => c.checked);
  const expCount = el("span", "export-count");
  const projTools = el("div", "export-tools");
  const allBtn = el("button", "link-btn", "全选");
  const noneBtn = el("button", "link-btn", "全不选");
  projTools.append(expCount, allBtn, noneBtn);
  const inboxLab = el("label", "export-check");
  const inboxCb = el("input");
  inboxCb.type = "checkbox";
  inboxCb.checked = true;
  inboxLab.append(inboxCb, el("span", null, "含未分配（导入池里还没归项目的活）"));
  const syncExpProj = () => {
    const all = allPicked();
    expCount.textContent = all ? `已选全部 ${projChecks.length} 个`
      : `已选 ${pickedIds().length}/${projChecks.length} 个`;
    // 全选时本来就已经包含未分配，勾选框就锁上，免得以为还差这一步
    inboxCb.disabled = all;
    inboxLab.classList.toggle("muted", all);
  };
  allBtn.onclick = () => { projChecks.forEach(c => { c.checked = true; }); syncExpProj(); };
  noneBtn.onclick = () => { projChecks.forEach(c => { c.checked = false; }); syncExpProj(); };
  projChecks.forEach(c => { c.onchange = syncExpProj; });
  const projBlock = el("div", "export-ctrl-block");
  projBlock.append(projTools, checkList, inboxLab);
  const projRow = el("div", "export-row");
  projRow.append(el("div", "export-label", "项目"), projBlock);
  expBody.append(projRow);
  syncExpProj();

  // 日期范围：只筛工时记录
  const dFrom = el("input");
  dFrom.type = "date";
  const dTo = el("input");
  dTo.type = "date";
  const dateWrap = el("div", "export-dates");
  dateWrap.append(dFrom, el("span", "export-dash", "至"), dTo);
  const dateRow = el("div", "export-row");
  dateRow.append(el("div", "export-label", "日期"), dateWrap);
  expBody.append(dateRow);
  expBody.append(el("div", "export-note",
    "日期范围筛工时；任务作为上下文保留（全量），方便按任务汇总。留空 = 全部日期。"));

  // 三档脱敏：命名固定，切换即生效，不发请求
  const maskSel = el("select");
  for (const [v, t] of [
    ["none", "不脱敏（保留项目名、任务名、备注）"],
    ["projects", "隐去项目名（换成「项目 1、项目 2…」）"],
    ["content", "隐去项目名和任务名（备注也清空）"],
  ]) {
    const o = el("option", null, t);
    o.value = v;
    maskSel.append(o);
  }
  maskSel.value = "none";
  expBody.append(expRow("脱敏", maskSel));
  expBody.append(el("div", "export-note",
    "脱敏只换名字，日期、工时、标签、完成状态都保留；不会导出还原对照表。"));

  const expBtn = el("button", "btn-primary", "导出");
  expBtn.type = "button";
  const foot = el("div", "export-foot");
  foot.append(expBtn, expHint);
  expBody.append(foot);

  const setExpHint = (txt, cls) => {
    expHint.textContent = txt;
    expHint.className = "export-hint" + (cls ? " " + cls : "");
  };
  const kbSize = (n) => n < 1024 ? `${n} B`
    : (n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  // 文件名从 Content-Disposition 里拿（服务端带日期时间），拿不到就本地凑一个
  const cdName = (res) => {
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="?([^";]+)"?/.exec(cd);
    return m ? m[1] : null;
  };
  const saveBlob = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  expBtn.onclick = async () => {
    const all = allPicked();
    const ids = pickedIds();
    if (!all && !ids.length && !inboxCb.checked) {
      setExpHint("没选任何项目：至少选一个项目，或勾上「未分配」", "err");
      return;
    }
    if (dFrom.value && dTo.value && dFrom.value > dTo.value) {
      setExpHint("起始日期不能晚于结束日期", "err");
      return;
    }
    const fmt = expFmt;
    expBtn.disabled = true;
    expBtn.textContent = "导出中…";
    setExpHint("", "");
    try {
      // 不走 api()：这里要的是文件流，不是 JSON
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: fmt,
          mask: maskSel.value,
          project_ids: all ? null : ids,
          include_inbox: all ? true : inboxCb.checked,
          date_from: dFrom.value || null,
          date_to: dTo.value || null,
        }),
      });
      if (!res.ok) {
        let msg = "导出失败";
        try {
          const j = await res.json();
          if (j && j.error) msg = j.error;
        } catch { /* 响应不是 JSON 就用手上这句 */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const name = cdName(res) || `pace-export-${Date.now()}.${fmt}`;
      saveBlob(blob, name);
      setExpHint(`已导出 ${name}（${kbSize(blob.size)}）`, "ok");
    } catch (e) {
      // 网络层报错是英文（Failed to fetch），换成中文，别让人对着英文发愣
      const m = (e && e.message === "Failed to fetch")
        ? "连不上本地服务，确认它还在运行" : ((e && e.message) || "未知错误");
      setExpHint("导出失败：" + m, "err");
    } finally {
      expBtn.disabled = false;
      expBtn.textContent = "导出";
    }
  };
  setCard.append(expDet);

  setCard.append(settingRow("开机自启", "登录 Windows 时自动启动",
    checkCtrl(!!state.autostart,
      (on) => api("/api/settings", "POST", { autostart: on }))));
  const shBtn = el("button", "btn-with-ic");
  shBtn.append(icon("stop"), document.createTextNode("关闭服务"));
  shBtn.onclick = async () => {
    if (!confirm("关闭后页面就访问不了了，需要重新双击启动。确定关闭？")) return;
    try {
      await api("/api/shutdown", "POST", {});
    } catch (e) {
      // 服务已断，收不到回包是正常的
    }
    alert("服务已关闭，可以关掉这个页面了");
  };
  setCard.append(settingRow("关闭服务", "停止本地服务，需重新启动", shBtn,
    "关闭后页面就打不开了；要重新用，双击桌面的「日拱一卒」快捷方式（目录里的 日拱一卒.lnk）。"
    + "设了开机自启的话，下次登录 Windows 会自动起来。"));
  root.append(setCard);
}

/* ── 骨架 ───────────────────────────── */

function render() {
  const roots = {
    today: $("#tab-today"), calendar: $("#tab-calendar"),
    projects: $("#tab-projects"), stats: $("#tab-stats"),
  };
  for (const k in roots) roots[k].innerHTML = "";
  renderToday(roots.today);
  renderCalendar(roots.calendar);
  renderProjects(roots.projects);
  renderStats(roots.stats);
}

let actPending = false;
async function act(fn) {
  if (actPending) return;
  actPending = true;
  const focused = document.activeElement;
  const button = focused instanceof HTMLButtonElement ? focused : null;
  document.body.setAttribute("aria-busy", "true");
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  try {
    await fn();
    await refresh();
  } catch (e) {
    alert(e.message);
  } finally {
    actPending = false;
    document.body.removeAttribute("aria-busy");
    // refresh 可能已经把按钮重画掉，只恢复仍挂在页面上的那个。
    if (button && button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.onclick = () => {
    closeDayModal();
    currentTab = btn.dataset.tab;
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach(s =>
      s.classList.toggle("hidden", s.id !== "tab-" + currentTab));
    if (currentTab === "stats") loadCalib();   // 进统计页才去拉校准数据
    // 投影是异步拉回来的，人在别的页签时只写缓存、不重画（切页签只改 hidden），
    // 所以切进日历要按最新缓存补画一次，否则看到的还是加载那一刻的空格子
    if (currentTab === "calendar") {
      const box = $("#tab-calendar");
      box.innerHTML = "";
      renderCalendar(box);
    }
  };
});

$("#timer-stop").onclick = () => act(() => api("/api/timer/stop", "POST"));
$("#timer-done").onclick = () => act(() => api("/api/timer/finish", "POST"));

/* ── 新手引导 ─────────────────────────── */
const TAB_LABEL = { today: "今日", calendar: "日历", projects: "项目", stats: "统计·设置" };

function buildGuideSteps() {
  // 一步只讲一件事：正文两三句、控制在 60 字以内，术语和功能细节（钳制、NULL 兜底这些）
  // 留给设置里的 ⓘ 和更新日志。顺序 = 完整教程的顺序，每页按导览按钮时只筛当前页的
  const intro = [
    { title: "这是什么", body: "这里按日期安排任务，也记录实际工时。每天看一眼还剩多少，做完打勾就行。" },
  ];
  const projects = [
    { title: "建一个项目", body: "项目是一件整体的事，比如「Q4 审计」。填了 deadline 就按剩余天数摊到每天。", tab: "projects", selector: "#tab-projects > .new-project-card" },
    { title: "往里加任务", body: "展开项目，在这一行写标题、预估分钟和 due。预估留空按 45 分钟算。", tab: "projects", selector: "#tab-projects .proj-block .add-task", expand: ".proj-block" },
    { title: "算不出用时的", body: "勾「无预估」先挂着，它不占安全线。行尾的复制键（两个方框）是整行复制，改个名就能用在下个周期。", tab: "projects", selector: "#tab-projects .proj-block .add-task span.form-row", fallback: "#tab-projects .proj-block .add-task" },
    { title: "每天重复的事", body: "「重复模式」管每天、每周、每月：到点自动出现在今天，勾掉一件自动长出下一件。", tab: "projects", selector: "#tab-projects .proj-block .add-task span.form-row", fallback: "#tab-projects .proj-block .add-task" },
    { title: "等别人回话", body: "点行尾的挂起键（双竖杠）：这件事会从今天和日历里消失，due 不动。恢复在项目卡底部的「挂起中」里。", tab: "projects", selector: "#tab-projects .proj-block", expand: ".proj-block", fallback: "#tab-projects > .new-project-card" },
    { title: "删错了去垃圾桶", body: "删掉的项目和任务先落到底部 🗑 垃圾桶，能一键恢复，工时记录不会丢。", tab: "projects", selector: "#tab-projects .trash-box" },
  ];
  const today = [
    { title: "两条横条", body: "「计划」是今天该投多少，「实际」是已经投了多少。两条共用一把尺子，对着看就知道还差多少。", tab: "today", selector: "#tab-today .hero" },
    { title: "竖线是什么", body: "浅绿是日常，浅棕是项目，两段加起来到竖线。竖线就是今天至少该投多少。", tab: "today", selector: "#tab-today .hero" },
    { title: "必做怎么算", body: "due 今天或已逾期的一次性任务才进必做。今日任务列表按必做、日常重复和其他排期分组。", tab: "today", selector: "#tab-today .today-groups", fallback: "#tab-today .progress-main" },
    { title: "两种达标挑战", body: "日目标和安全线各算各的连续天数，都只认实际投入。安全线 0 需求日跳过，不影响连续成绩。", tab: "today", selector: "#tab-today .challenges", fallback: "#tab-today .hero" },
    { title: "计时和勾掉", body: "点 ▶ 开始计时。方块键只记工时，对勾键记工时并勾掉。下一件推荐也能直接点对勾完成。", tab: "today", selector: "#tab-today .task-row .btn-play", fallback: "#tab-today .manual-log-card" },
    { title: "忘了计时", body: "点今日已投入这行末尾的「补记」，会直接跳到原表单并定位到分钟输入框。", tab: "today", selector: "#tab-today .manual-log-card" },
    { title: "挂着的事", body: "挂起的都收在「等待回复」这块，按挂了几天排。回话了点 ↩ 就按原日期归位。", tab: "today", selector: "#tab-today .wait-reply", fallback: "#tab-today .hero" },
    { title: "下一件做哪个", body: "「下一件推荐」按轻重缓急挑出几件，做完点行尾对勾即可，不用再回清单找。", tab: "today", selector: "#tab-today .next-rec", fallback: "#tab-today .hero" },
    { title: "手机上也能看", body: "手机连同一个 Wi-Fi，打开页面顶部这行 📱 地址就能用，不用装 App。", tab: "today", selector: "#lan-line", fallback: "#guide-btn" },
  ];
  const calendar = [
    { title: "拖进某天", body: "从任务池拖进某天就是排期。单击已有任务看详情，点详情里的「取消排期」才放回池子。", tab: "calendar", selector: "#tab-calendar .cal-grid" },
    { title: "格子挤不下", body: "挤不下会折成「+N 更多」，点开看全天。浅色带循环标记的是日常和重复的预告。", tab: "calendar", selector: "#tab-calendar .cal-grid" },
  ];
  const stats = [
    { title: "每天投了多少", body: "点柱子看那天的明细。上面能切近 7 天、近 14 天、本月或今年。", tab: "stats", selector: "#tab-stats .dp-card" },
    { title: "记错了能改", body: "每条工时后面有改和删两个键，改分钟、补备注、删掉。这里删的不进垃圾桶。", tab: "stats", selector: "#tab-stats .dp-detail", fallback: "#tab-stats .dp-card" },
    { title: "预估会自己校准", body: "下面按项目累计投入：展开能看到每个日常的预估和最近用时，差得多会给建议，点 [采用] 就改。预估 20 分钟以下不校准。", tab: "stats", selector: "#tab-stats .dp-proj", fallback: "#tab-stats .dp-card" },
    { title: "打标签算均次", body: "给任务写几个标签（如 qc、检索），折在这块里就能看到同类活完成几件、平均一件多久。", tab: "stats", selector: "#tab-stats .tag-stats", fallback: "#tab-stats .dp-card" },
    { title: "设置", body: "按目标、记账、显示、系统分组。点一下就是保存，行尾 ⓘ 有详细解释。", tab: "stats", selector: "#tab-stats .settings-card" },
  ];
  const steps = [...intro, ...projects, ...today, ...calendar, ...stats];
  return steps;
}

let tourState = null;

function switchTabGuide(name) {
  currentTab = name;
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach(s => s.classList.toggle("hidden", s.id !== "tab-" + name));
}

function openDetailsAncestors(el) {
  let node = el;
  while (node && node !== document.body) {
    if (node.tagName === "DETAILS" && !node.open) node.open = true;
    node = node.parentElement;
  }
}

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && el.offsetParent !== null;
}

function expandProjectCard(target, expandSelector) {
  const card = target.closest(expandSelector);
  if (!card) return;
  const body = card.querySelector(".proj-body");
  const chevron = card.querySelector(".proj-chevron");
  if (body && body.classList.contains("hidden")) {
    const p = state.projects.find(x => String(x.id) === card.dataset.id);
    if (p) openProjects.add(p.id);
    body.classList.remove("hidden");
    if (chevron) chevron.textContent = "▾";
  }
}

function ensureTarget(step) {
  if (!step.tab) return null;
  switchTabGuide(step.tab);
  let target = document.querySelector(step.selector);
  if (target && step.expand) expandProjectCard(target, step.expand);
  if (target) openDetailsAncestors(target);
  if (target && !isVisible(target)) target = document.querySelector(step.selector);
  if (!target || !isVisible(target)) {
    if (step.fallback) {
      target = document.querySelector(step.fallback);
      if (target) openDetailsAncestors(target);
      if (target && !isVisible(target)) target = document.querySelector(step.fallback);
    }
  }
  return target && isVisible(target) ? target : null;
}

function positionCard(card, target) {
  card.classList.remove("center");
  if (!target) {
    // 居中卡片：先把上一步留下的绝对定位清掉，否则 .center 的 left/top 会被行内样式盖住，
    // 卡片按旧坐标停在视口外（切到完整教程第一步时就踩过）
    card.style.top = "";
    card.style.left = "";
    card.classList.add("center");
    return;
  }
  target.scrollIntoView({ behavior: "instant", block: "center" });
  const rect = target.getBoundingClientRect();
  const pad = 12;
  const margin = 12;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  let top = rect.bottom + pad + window.scrollY;
  if (top + card.offsetHeight > window.scrollY + vh - margin) {
    top = rect.top - card.offsetHeight - pad + window.scrollY;
  }
  if (top < window.scrollY + margin) {
    top = window.scrollY + margin;
  } else if (top + card.offsetHeight > window.scrollY + vh - margin) {
    top = window.scrollY + vh - card.offsetHeight - margin;
  }
  let left = rect.left + rect.width / 2 - card.offsetWidth / 2 + window.scrollX;
  left = Math.max(margin, Math.min(left, window.scrollX + vw - card.offsetWidth - margin));
  card.style.top = top + "px";
  card.style.left = left + "px";
}

function renderTourStep() {
  if (!tourState) return;
  const steps = tourState.steps;
  const step = steps[tourState.index];
  document.querySelectorAll(".tour-highlight").forEach(e => e.classList.remove("tour-highlight"));
  const target = step.selector ? ensureTarget(step) : null;
  if (step.selector && !target) {
    tourState.index++;
    if (tourState.index >= steps.length) { closeGuide(); return; }
    renderTourStep();
    return;
  }
  if (target) target.classList.add("tour-highlight");
  let card = $(".tour-card");
  if (!card) { card = el("div", "tour-card"); document.body.appendChild(card); }
  card.innerHTML = "";
  const scope = tourState.scope ? TAB_LABEL[tourState.scope] + "页 · " : "";
  card.append(el("div", "tour-step", `${scope}${tourState.index + 1} / ${steps.length}`));
  card.append(el("div", "tour-title", step.title));
  card.append(el("div", "tour-body", step.body));
  const actions = el("div", "tour-actions");
  if (tourState.scope) {
    const full = el("button", null, "看完整教程");
    full.onclick = () => { tourState = { index: 0, steps: buildGuideSteps(), scope: null }; renderTourStep(); };
    actions.append(full);
  }
  if (tourState.index > 0) {
    const prev = el("button", null, "上一步");
    prev.onclick = () => { tourState.index--; renderTourStep(); };
    actions.append(prev);
  }
  const skip = el("button", null, tourState.scope ? "关闭" : "跳过");
  skip.onclick = closeGuide;
  actions.append(skip);
  if (tourState.index < steps.length - 1) {
    const next = el("button", "tour-primary", "下一步");
    next.onclick = () => { tourState.index++; renderTourStep(); };
    actions.append(next);
  } else {
    const done = el("button", "tour-primary", "完成");
    done.onclick = closeGuide;
    actions.append(done);
  }
  card.append(actions);
  requestAnimationFrame(() => positionCard(card, target));
}

// pageOnly：按当前 Tab 出这一页的步骤；false 走完整流程
function startGuide(pageOnly = false) {
  if (!$(".tour-overlay")) document.body.appendChild(el("div", "tour-overlay"));
  const all = buildGuideSteps();
  const mine = pageOnly ? all.filter(s => s.tab === currentTab) : [];
  tourState = { index: 0, steps: mine.length ? mine : all, scope: mine.length ? currentTab : null };
  renderTourStep();
}

function closeGuide() {
  if (tourState) localStorage.setItem("pace_guide_seen", "1");
  document.querySelectorAll(".tour-highlight").forEach(e => e.classList.remove("tour-highlight"));
  $(".tour-overlay")?.remove();
  $(".tour-card")?.remove();
  tourState = null;
  // 引导看完了，攒着的「新版本更新提示」接着弹（两个浮层不叠在一起）
  maybeShowWhatsNew();
}

/* ── 新版本更新提示 ─────────────────────
   只在「这版第一次打开」时弹一次：state.version 和 localStorage 里记的版本不一样就弹，
   关掉（知道啦 / × / 点遮罩）才把版本记下来。新用户先看新手引导，等引导关掉再补弹。 */

function closeWhatsNew() {
  if (!whatsNewModal) return;
  if (whatsNewVer) localStorage.setItem(WN_SEEN_KEY, whatsNewVer);
  whatsNewModal.remove();
  whatsNewModal = null;
  // 更新提示关掉了，攒着的每日鞭策接着弹（两个浮层不叠在一起）
  maybeShowNag();
}

function openWhatsNew(ver, items) {
  closeWhatsNew();
  whatsNewVer = ver;
  const overlay = el("div", "wn-overlay");
  // 点空白处关闭（点卡片内部不算）
  overlay.onclick = (e) => { if (e.target === overlay) closeWhatsNew(); };
  const card = el("div", "wn-card");
  const head = el("div", "wn-head");
  head.append(el("div", "wn-title", `更新到 v${ver}`));
  const close = el("button", "btn-check");
  close.append(icon("x"));
  close.title = "关闭（Esc）";
  close.setAttribute("aria-label", "关闭");
  close.onclick = closeWhatsNew;
  head.append(close);
  card.append(head);
  const list = el("ol", "wn-list");
  for (const t of items) list.append(el("li", null, t));
  card.append(list);
  const actions = el("div", "wn-actions");
  const ok = el("button", "wn-primary", "知道啦");
  ok.onclick = closeWhatsNew;
  actions.append(ok);
  card.append(actions);
  overlay.append(card);
  document.body.append(overlay);
  whatsNewModal = overlay;
}

function maybeShowWhatsNew() {
  if (!state || !state.version) return;
  const ver = state.version;
  if (localStorage.getItem(WN_SEEN_KEY) === ver) { maybeShowNag(); return; }
  const items = WHATS_NEW[ver] || [];
  if (!items.length) {
    // 这版没写文案也记一笔：以后补条目时别再拿旧版本乱弹
    localStorage.setItem(WN_SEEN_KEY, ver);
    maybeShowNag();
    return;
  }
  // 新手引导优先，等它关掉（closeGuide 会再叫回来）
  if (tourState || localStorage.getItem("pace_guide_seen") !== "1") return;
  openWhatsNew(ver, items);
}

/* ── 每日鞭策「今日不做，明日更多」─────────────
   每天第一次打开弹一次：今天账上还剩多少、明天已排多少，合起来压给明天看。
   排在引导和新版提示后面，浮层不叠；今天没有剩余日常就不弹。 */

let nagModal = null;

function closeNag() {
  if (!nagModal) return;
  if (state && state.today) localStorage.setItem(NAG_LAST_KEY, state.today);
  nagModal.remove();
  nagModal = null;
}

async function maybeShowNag() {
  if (!state || !state.today) return;
  if (localStorage.getItem(NAG_ON_KEY) === "0") return;
  if (localStorage.getItem(NAG_LAST_KEY) === state.today) return;
  if (tourState || whatsNewModal || nagModal) return;
  const restCount = state.routine_pending_count || 0;
  const restMin = state.routine_pending_est_min || 0;
  if (restCount <= 0) {
    // 没有剩余日常，今天不弹但也记上，免得晚点又跳出来
    localStorage.setItem(NAG_LAST_KEY, state.today);
    return;
  }
  // 明天的量：到期任务从 state 现算（日常/重复的不数，它们走日历投影）；
  // 日常/重复的明天投影问日历接口，只取条数，失败了就只说到期件数
  const d = new Date(state.today + "T00:00:00");
  d.setDate(d.getDate() + 1);
  const tmr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  let dueN = 0, dueMin = 0;
  for (const p of state.projects) {
    for (const t of p.tasks) {
      if (t.suspended || isLoopTask(t) || t.due_date !== tmr) continue;
      dueN++;
      dueMin += t.estimate_min || 0;
    }
  }
  let occN = 0;
  try {
    const r = await api(`/api/calendar?month=${tmr.slice(0, 7)}`);
    occN = (r.occ || []).filter(o => o.date === tmr).length;
  } catch (e) { /* 投影拿不到也照弹，明天那段只说到期 */ }
  // 等接口的功夫可能有人开了别的浮层，弹之前再确认一次
  if (tourState || whatsNewModal || nagModal) return;

  const overlay = el("div", "wn-overlay");
  overlay.onclick = (e) => { if (e.target === overlay) closeNag(); };
  const card = el("div", "wn-card");
  const head = el("div", "wn-head");
  head.append(el("div", "wn-title", "今日不做，明日更多"));
  const close = el("button", "btn-check");
  close.append(icon("x"));
  close.title = "关闭（Esc）";
  close.setAttribute("aria-label", "关闭");
  close.onclick = closeNag;
  head.append(close);
  card.append(head);
  // 项目推进口径跟 hero 一致：安全线总量减日常·重复
  const projRest = Math.max(0, (state.total_safety_min || 0) - Math.max(0, state.total_routine_today_min || 0));
  const body = el("div", "nag-body");
  body.append(el("div", null,
    `今天账上：日常 ${restCount} 件` + (restMin > 0 ? `（约 ${fmt(restMin)}）` : "（都没填预估）")
    + (projRest > 0 ? `，项目约 ${fmt(projRest)}` : "")));
  const tParts = [];
  if (dueN) tParts.push(`${dueN} 件到期` + (dueMin > 0 ? `（约 ${fmt(dueMin)}）` : ""));
  if (occN) tParts.push(`${occN} 件日常重复`);
  body.append(el("div", null, `明天预排：${tParts.length ? tParts.join("，") : "暂时没排新的"}`));
  // 明天的工时只算有数的：今天欠的 + 明天到期的；日常重复的预估投影里没带，所以说「至少」
  const tmrMin = restMin + projRest + dueMin;
  body.append(el("div", "nag-total",
    `今晚不结账，明早 ${restCount + dueN + occN} 件排队叫号` + (tmrMin > 0 ? `，工时至少 ${fmt(tmrMin)}` : "")));
  card.append(body);
  const actions = el("div", "wn-actions");
  const off = el("button", "nag-off", "不再提示");
  off.onclick = () => { localStorage.setItem(NAG_ON_KEY, "0"); closeNag(); };
  const ok = el("button", "wn-primary", "知道了");
  ok.onclick = closeNag;
  actions.append(off, ok);
  card.append(actions);
  overlay.append(card);
  document.body.append(overlay);
  nagModal = overlay;
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (tourState) closeGuide();
  else if (whatsNewModal) closeWhatsNew();
  else if (nagModal) closeNag();
  else closeDayModal();
});

$("#guide-btn").onclick = () => startGuide(true);

refresh().then(() => {
  if (localStorage.getItem("pace_guide_seen") !== "1") startGuide();
  else maybeShowWhatsNew();
}).catch(e => alert(e.message));

// PWA：注册最小 SW 让手机可以「添加到主屏幕」。SW 不缓存任何东西（见 sw.js）
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

/* ── 手机访问二维码（点击弹出，平时收起）───────────────────── */
// 跳转页地址：手机扫码后先落到这个固定页面登记本机地址，以后手机只需收藏跳转页，
// 它会自动挑能通的那台 pace。自己部署的话可以换成自己的跳转页
const PACE_GO_URL = "https://c3h18o2.github.io/daily-pace/go.html";
(function setupQrPop() {
  const btn = $("#qr-btn"), pop = $("#qr-pop");
  if (!btn || !pop || typeof QRCode === "undefined") return;
  const build = () => {
    const goUrl = (state && state.pace_go_url) || PACE_GO_URL;
    $("#qr-go-link").href = goUrl;
    // 和 lan-line 同一口径：运行态局域网地址优先，没有就用当前页面的来源
    const lanUrl = state && state.lan_url_runtime !== undefined ? state.lan_url_runtime : state && state.lan_url;
    const origin = lanUrl || location.origin;
    $("#qr-addr").textContent = origin;
    // 每次打开都重建，改完地址不必刷新整个页面；已有 query/hash 也交给 URL 正确拼接。
    const target = new URL(goUrl);
    target.searchParams.set("set", origin);
    const img = $("#qr-img");
    img.innerHTML = "";
    new QRCode(img, {
      text: target.toString(),
      width: 168, height: 168,
      colorDark: "#2b2620", colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    const opening = pop.classList.contains("hidden");
    pop.classList.toggle("hidden");
    if (opening) build();
  };
  pop.onclick = (e) => e.stopPropagation();
  document.addEventListener("click", () => pop.classList.add("hidden"));
})();
