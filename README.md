# 陪你看一切 · 视频 / 直播 / 屏幕

给 Coopanion 桌宠的「看」扩展。视频文件、视频链接、直播地址、桌面屏幕，都能变成带时间码的宫格图，图片随工具回执进模型上下文——模型是真的看过画面，不是只读字幕。

**一分钟 30 格画面（2 秒一格、5 张宫格 × 6 格），一次调用看完一分钟**——本地视频、视频链接、直播地址、桌面屏幕都行；看一小时实时直播约一块钱。

## 六颗工具

| 工具 | 看什么 | 一次回来 |
|---|---|---|
| `video_info` | 本地视频的时长、分辨率、帧率、大小 | 一行数字，不花图片 token |
| `video_storyboard` | 本地视频、或任意 yt-dlp 支持的视频链接 | 宫格图 + 每格起止秒 + 转写台词 |
| `live_snap` | 直播地址（B 站直播间、m3u8/flv 直链） | 取「最近这一段」拼成宫格，只有画面 |
| `screen_snap` | 这台电脑的屏幕 | 截一段拼成宫格，格子里是本机时钟 |
| `watch_start` | 持续看屏幕 | 每批自动推过来，不占一轮对话 |
| `watch_stop` | 停掉上面那个后台 | — |

默认规格是「一分钟一批」：`pages 5`、`cols 2`、`maxFrames 6`、`step 2`，五张图 × 六格 = 三十格，正好覆盖六十秒。

```
video_storyboard(path, pages: 5, cols: 2, step: 2, maxFrames: 6,
                 startSeconds: 0, maxSeconds: 60, asr: false)
```

长片子一段一段往后看：下一批把 `startSeconds` / `maxSeconds` 各加 60。

## 要装什么

1. **Python 3.10 以上**（3.12 验证过）。
2. `pip install av pillow` —— 解码用 PyAV，拼图和写字用 Pillow。**不需要 ffmpeg，也不需要 opencv / numpy。**
3. 想听台词再 `pip install faster-whisper`（第一次用会下模型，`small` 约 460MB，`base` 约 140MB）。
4. 要贴网址（B 站、YouTube 这类）再装 `yt-dlp`：`pip install yt-dlp`，或者放进 PATH。
5. 插件设置里填 Python 解释器的路径；留空就按 PATH 里的 `python` → `python3` → 几个常见安装位置（`C:\Python312`、`C:\Program Files\Python312`）依次找。

装完在 Coopanion 的扩展页启用「看片」，重启程序生效。

## 平台

- **Windows**：全部功能可用。
- **macOS / Linux**：`video_info`、`video_storyboard`、`live_snap` 可用；`screen_snap` 和 `watch_start` 依赖 Windows 的 `System.Drawing` 截屏，用不了。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `pythonPath` | 空 | 留空自动找 |
| `defaultFrames` | 24 | 调用时没给 `maxFrames` 就用这个 |
| `cellWidth` | 320 | 每格宽度，按 16:9 算高。越大越清楚也越费 token |
| `timeoutSeconds` | 300 | 单次抽帧超时，超了就杀掉 Python 进程 |
| `outputDir` | 空 | 留空放 `<dataDir>\video\<时间戳>\`，用完可以随手删 |
| `asr` | 开 | 要不要转写台词 |
| `asrModel` | `small` | `tiny` / `base` / `small` / `medium` |
| `ytDlpPath` | 空 | 留空自动找 |

## 花多少

一次调用的图片量是固定的（一分钟五张、三十格），贵的是每轮重发的上下文，不是图：按 DeepSeek 的价、缓存命中九成以上算，一分钟一批约 0.004 美元，**一小时实时直播三十来批、一块钱上下**。批次数才是乘数——一分钟五张和一分钟六十张，价格差得不多。

## 自己调：看更清楚 / 更省钱

两件事分开：**清不清楚**看每格多少像素（`cellWidth`），**花多少**看图的总张数和总像素。调之前先记住一句：一次回多少格是自己选的，贵的从来是「一批又一批」。

| 旋钮 | 在哪调 | 默认 | 往哪边拧 |
|---|---|---|---|
| `cellWidth` | 插件设置 | 320 | 640＝字看得清；160～200＝最省 |
| `maxFrames` | 调用时给 | 24 | 格数少＝每格大（清楚），格数多＝时间跨度长（省张数） |
| `pages` / `cols` | 调用时给 | 1 / 自动 | 一次要几张图；张数是花费的主要乘数 |
| `step` | 调用时给 | 0.5 | 2 秒一格＝看得见动作；4～6 秒一格＝省格数但漏细节 |
| `startSeconds` / `maxSeconds` | 调用时给 | 全片 | 只截你要的那一段，别整片硬扫 |
| `asr` | 插件设置 / 调用时 | 开 | 关掉省时间，不省图片 token |
| `asrModel` | 插件设置 | `small` | `base` 快三倍，`tiny` 更快更糊 |

四套现成配方：

- **先探路，不花图**：`video_info` 看时长帧率，再 `video_storyboard(path, maxFrames:4, asr:false)` —— 四格看个大概，成本几乎为零。
- **看清画面上的字**：设置里把 `cellWidth` 调到 640，调用 `pages:2, cols:2, maxFrames:4, step:1` —— 每格大、每 1 秒一格，字幕和菜单都读得出来。
- **最省地看一段**：`cellWidth` 160，`pages:1, cols:3, maxFrames:9, step:4` —— 一张图看 36 秒，够判断「这段在干什么」。
- **只听台词**：`maxFrames:4, step:10, asr:true` —— 画面稀一点没关系，台词才是你要的。

直播和屏幕同理：`live_snap(seconds, step, pages, cols, cell)`、`screen_snap(seconds, frames, pages, cols)`（屏幕那条每格固定 640 宽，省在图张数和格数上）。

## 说清楚的边界

- **画面是真的，台词是听来的**：whisper 在本机转写，个别字听错很正常，别当原文引用。
- **直播没有台词**：`live_snap` 只出画面。想听直播说什么，目前得另配转写。
- **直播地址会过期**：脚本每次现取，所以每次调都是「调用那一刻往后的一段」，有二十来秒延迟。
- **格子里的小字是本机时钟**，不是游戏内时间。
- **B 站的分离音视频**用 PyAV 直接 stream copy 合轨，不需要 ffmpeg；这条路对 DRM 保护的流无效。
- `watch_start` 只支持截屏幕；直播那边按批调 `live_snap`。

## 授权

MIT
