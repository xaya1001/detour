# Detour Agent Guide

Chrome MV3 扩展，按域名列表把流量路由到用户设置的 SOCKS5 或 HTTP 代理（默认 SOCKS5 `127.0.0.1:12345`），公开开源（MIT）。需求见 `docs/requirements.md`，安装与使用见 `README.md`（中文版 `README.zh-CN.md`），工作区通用规则见 `/home/ubuntu/AGENTS.md`。

## 命令

扩展本身无运行时依赖、无构建步骤；开发依赖只有 Playwright（端到端测试）。

| 命令 | 作用 | 重型 |
| --- | --- | --- |
| `npm ci` | bootstrap，按 lockfile 安装 Playwright（不下载浏览器） | 否 |
| `npm test` | `test/` 纯逻辑测试，快速门禁（秒级） | 否 |
| `npm run test:e2e` | `e2e/` 在 Playwright Chromium（英文界面）中加载扩展的端到端测试（约 15 秒） | 是 |
| `npm run check` | `npm test` + `npm run test:e2e`，唯一完整门禁 | 是 |
| `npm run package` | 生成 `dist/detour-<manifest 版本>.zip`（`extension/` 内容和 `LICENSE` 位于 zip 根） | 否 |
| `npm run update-psl` | 从 publicsuffix.org 重新生成 `extension/lib/psl-data.js`，需联网；更新后跑 `npm test` | 否 |

Node 22+（服务器与 CI 为 Node 24）。端到端测试使用 `~/.cache/ms-playwright` 中与 lockfile 内 Playwright 版本匹配的 Chromium（`channel: 'chromium'`，新版 headless 支持扩展）；升级 Playwright 时先确认对应 Chromium 已安装。

## 代码地图

```text
extension/
  manifest.json      MV3 清单；权限 proxy、privacy、storage、webRequest，host_permissions <all_urls>；default_locale en
  _locales/          en 与 zh_CN 的 messages.json（键集合必须一致，单元测试校验）
  lib/psl-data.js    生成的公共后缀规则（只由 scripts/update-psl.js 写入）
  lib/rules.js       纯逻辑（无 Chrome API）：域名规范化、主域名、列表匹配、代理校验、PAC 生成、各模式 proxy 配置、全局 bypass、状态校验
  lib/i18n.js        chrome.i18n 封装：t()、formatTime()、localizePage() 填充 data-i18n* 属性
  background.js      Service worker：读 storage → chrome.proxy.settings.set；角标；onProxyError / webRequest 非阻塞监听维护失败标记和本页域名
  popup.html/js      弹窗：模式切换、当前网站状态与加入/移出、本页域名、打开管理页、错误与"被其他扩展控制"提示
  manage.html/js     管理页（options_ui，新标签页打开）：排序、搜索、添加、删除与撤销、导入导出、代理服务器设置、WebRTC 开关
  ui.css             弹窗与管理页共用样式
  icons/             16/48/128 PNG
scripts/package.js   零依赖 zip 写入器（deflate）
scripts/update-psl.js 下载并转换 Public Suffix List
test/rules.test.js   针对 lib/rules.js 的契约测试
e2e/                 端到端测试：本地 HTTP 站点 + 127.0.0.1:12345 SOCKS5 桩 + HTTP 代理桩 + host-resolver-rules，全程离线
.github/workflows/ci.yml  push/PR 跑 npm run check；v* tag 校验与 manifest 版本一致后打包并发布 GitHub Release
docs/images/         README 截图
```

依赖方向：`background.js`、`popup.js`、`manage.js` → `lib/i18n.js`、`lib/rules.js` → `lib/psl-data.js`。界面文案只放在 `_locales`，页面和脚本不写死任何语言的文案；`badgeFor` 通过注入的 `msg` 函数取文案。

事实 owner：模式、域名列表、代理、最近失败时间保存在 `chrome.storage.local`（键见 `rules.js` 的 `STATE_KEYS`：`mode`、`domains`、`proxy`、`lastProxyError`、`blockWebRtc`；`proxy` 为 `{scheme: 'socks5'|'http', host, port}`，缺失或无效时用 `DEFAULT_PROXY`）。弹窗和管理页只写 storage，service worker 监听 `storage.onChanged` 后重新应用代理并刷新角标，因此修改立即生效且不依赖页面存活。本页域名由 service worker 写入 `chrome.storage.session`（键 `page:<tabId>`，值 `{host: {proxied, failed}}`，记录全部 host），新的主框架请求时清空（同一请求的重定向不清空，并经 `onBeforeRedirect` 记录途经 host），标签页关闭时删除。

角标由 `rules.js` 的 `badgeFor` 计算：全局角标按模式；有本页数据的标签页另设标签页角标（自动模式下为未覆盖主域名个数）。Chrome 在标签页加载新文档时会清除标签页角标，因此 `tabs.onUpdated` 加载状态变化时重新设置；非 http(s) 页面加载时清空该标签页的本页数据。

Service worker 中的代理、WebRTC 策略（`blockWebRtc` 为真时 `webRTCIPHandlingPolicy` 设为 `disable_non_proxied_udp`，否则 `clear` 恢复默认）与角标更新经同一队列串行执行，每次读取最新 storage，不缓存状态；并发事件下旧状态不会覆盖新状态。

## 测试门禁

- `npm test` 覆盖：normalize/mainDomain 契约、子域名匹配（含 `notgoogle.com` 不匹配）、去重添加、代理校验（类型、地址、端口）与无效存储回退默认、PAC 在 `node:vm` 中返回 `SOCKS5 host:port` / `PROXY host:port` / `DIRECT`、PAC 不引用任何会触发 DNS 的函数、三种模式的 proxy 配置与全局 bypass 判断、连接失败识别与本页域名归组、导入合并与导出格式、角标优先级与漏网计数、中英语言文件键与占位符一致。
- `npm run test:e2e` 覆盖：三种模式的实际分流、本页域名（走代理、直连、被拦截、失败、重定向途经）、漏网个数角标（颜色、加入后减少、换模式、换页面、非网页清零）、代理失败角标与恢复、管理页（单标签、添加、撤销删除、导入导出）、弹窗与管理页无缺失文案、代理设置表单（无效端口拒绝、改为 HTTP 代理后自动与全局模式经 HTTP 代理）、WebRTC 开关。
- 修改 `rules.js` 先跑 `npm test`；修改 `background.js`、页面或 manifest 跑 `npm run test:e2e`；交付前跑一次 `npm run check` 和 `npm run package` 并核对 zip 文件列表。
- 新测试只为需求或不变量而写，优先扩展 `test/rules.test.js`。

## 项目特有风险

- **端到端测试占用固定端口**：默认代理为 `127.0.0.1:12345`，`test:e2e` 必须在该端口启动 SOCKS5 桩；端口被占用时测试直接失败，不能并行运行两份。
- **不回退直连**：PAC 只返回 `SOCKS5 host:port` 或 `PROXY host:port`，不得追加 `; DIRECT`；全局模式用 `fixed_servers` + `singleProxy`。这是需求（失败可见）而非缺陷。
- **PAC 不做 DNS**：PAC 只允许对 `host` 做字符串操作，禁止 `dnsResolve`、`isResolvable`、`isInNet`、`myIpAddress` 等；被代理域名由代理端解析。
- **导航不依赖 service worker**：代理设置通过 `chrome.proxy.settings` 由 Chrome 持久化。不得加入阻塞式 `webRequest` 监听或 `chrome.proxy.onRequest`；service worker 只被动监听并在 install/startup/状态变化时重新应用。
- **代理控制权**：Chrome 只允许一个扩展控制代理。`levelOfControl` 为 `controlled_by_other_extensions` 时本扩展的设置无效，弹窗负责提示。
- **公共后缀列表**：主域名由 `extension/lib/psl-data.js`（`npm run update-psl` 从 publicsuffix.org 生成，含 ICANN 与 PRIVATE 段，规则已转为 punycode）计算。不得退回"取最后两段"，否则 `google.com.hk` 会变成 `com.hk`，加入后代理整个后缀。生成文件只由脚本更新，不手改。
- **失败标记**：由 `chrome.proxy.onProxyError` 与 `webRequest.onErrorOccurred` 中的 `net::ERR_PROXY_*` / `ERR_SOCKS_*` / `ERR_TUNNEL_CONNECTION_FAILED` 置位，由命中当前规则且走代理、非缓存的请求 `onCompleted` 清除。HTTP 代理不可达同样报 `ERR_PROXY_CONNECTION_FAILED`。
- **发布**：版本号只在 `extension/manifest.json` 与 `package.json` 维护且保持一致；发布 = 提交版本号后推送 `v<版本>` tag，由 CI 生成 Release，不手动上传 zip。仓库公开，提交作者使用 GitHub noreply 邮箱（仓库本地 git config）。
