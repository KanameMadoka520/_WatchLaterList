# Windows 扫描 Bilibili 稍后再看

## 最简单的方式

双击项目根目录中的：

```text
scan-watchlater.cmd
```

启动窗口和后续提示均为中文。启动器会切换到 UTF-8，并显式以 UTF-8 读取 PowerShell 脚本，因此可以在 Windows PowerShell 5.1 或 PowerShell 7 下正常显示中文。

也可以在 PowerShell 中运行：

```powershell
.\scan-watchlater.cmd
```

如果 Bilibili 已经在 Codex 内置浏览器或其他浏览器中登录，可以只复制脚本、不再打开 Windows 默认浏览器：

```powershell
.\scan-watchlater.cmd -NoOpen
```

然后直接切换到现有的 Bilibili 稍后再看标签页继续操作。

启动脚本会完成两件事：

1. 把 `tools/bilibili-watchlater-console.js` 复制到 Windows 剪贴板。
2. 使用默认浏览器打开 Bilibili 稍后再看页面。

Windows 脚本不会读取、复制或保存 Bilibili Cookie。真正的采集代码在已经登录的 Bilibili 页面中运行，因此直接使用该浏览器标签现有的账号状态。

## 浏览器里只需完成三步

1. 确认打开的 Bilibili 稍后再看页面已经登录正确账号。
2. 按 `F12` 或 `Ctrl+Shift+I`，选择 `Console`。
3. 按 `Ctrl+V` 粘贴采集脚本，再按 `Enter`。

如果浏览器第一次阻止向控制台粘贴，并明确要求输入 `allow pasting`，按照浏览器控制台的提示手动输入一次，然后重新粘贴。

脚本会自动向下滚动虚拟列表，并在控制台持续显示：

```text
已采集 24
已采集 51
已采集 83
```

不要刷新或关闭这个标签页。接近 1000 条记录时需要等待几分钟；列表元数据采集完成后，浏览器会下载：

```text
bilibili-watchlater-export.json
```

## 导入本地资料库

1. 打开 `http://localhost:4173/`。
2. 选择顶部的“本地文件”模式。
3. 点击“导入”，选择 `bilibili-watchlater-export.json`。
4. 等待导入和封面本地化完成。
5. 如果仍有“封面待修复”，点击“补全封面”再次尝试。

导入后，页面会显示独立的“封面本地化”任务面板，包括完成数、成功数、失败数、剩余数、百分比和当前 BV 号。任务可以暂停、继续或停止；停止前已经成功下载的图片和索引仍会保存。封面任务运行期间，页面会暂时禁用导入、编辑、归档和删除，避免浏览器中的旧数据覆盖后台任务结果。

导入后的文件位置：

```text
data/watchlater.json
data/covers/<BV号前4位>/<完整BV号>.<扩展名>
```

本地服务会按 BV 号去重。新版采集脚本会把原站 CDN 地址同时写入 `cover` 和 `coverOriginal`，但不会尝试在 Bilibili 页面中跨域下载近千张图片。导入后，本地服务会优先从 `coverOriginal` 下载封面；列表页确实没有提供封面时，只要记录中存在 BV 号，本地服务就会尝试从 Bilibili 视频元数据接口补查。

新版导出使用 `bili-library/v2` 契约，并预留 `note`、`category`、`topics` 和 `collections` 字段。采集器不会生成 AI 标签；导入 Watchlater Atlas 后，可以通过页面顶部的“AI 标签”按批处理。

同一个视频在 Bilibili 页面里可能同时存在封面链接和标题链接。旧版采集脚本可能让后出现、没有图片的标题链接覆盖已经取得的 CDN 地址；新版只读取包含图片的链接，并在按 BV 号合并时保留非空封面字段。正常采集过程中，控制台会同时显示“已采集 N 条”和“已获取封面地址 N 条”，两个数字应当基本一致。

## 为什么还需要在控制台按一次回车

Windows 程序不能在不获得浏览器调试权限的情况下，静默向一个已经登录的网站页面注入并执行代码。这是浏览器的安全边界。`scan-watchlater.cmd` 已经自动完成复制脚本和打开页面，剩下的“打开控制台、粘贴、回车”必须由用户明确执行。

## 常见问题

### 扫描数量明显少于 Bilibili 显示的数量

回到列表顶部，刷新页面，再执行一次脚本。导入时会按照 BV 号去重，不会因为重复扫描而产生重复视频。

### 没有下载 JSON

检查浏览器是否阻止了该页面的下载，并确认控制台最后出现了“完成，共 N 条”的消息。

### JSON 中的封面地址是空的

确认执行的是项目当前的 `tools/bilibili-watchlater-console.js`，不要重复使用浏览器历史记录中保存的旧脚本。重新运行 `scan-watchlater.cmd -NoOpen` 可以把最新版脚本复制到剪贴板。即使个别视频仍然没有地址，只要 BV 号有效，本地封面任务也会尝试从公开视频元数据接口补查。

### 本地页面无法打开

在项目目录运行：

```powershell
npm run start
```

该命令会同时启动 `4173` 前端和 `4175` 本地数据服务。
