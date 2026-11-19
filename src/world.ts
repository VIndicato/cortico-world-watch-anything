/**
 * 看片：把一段本地视频压成一张带时间码的宫格图，图片随工具回执进上下文。
 *
 * - 抽帧与拼图全交给 `scripts/storyboard.py`（PyAV + PIL），**不依赖 ffmpeg，也不拉 cv2 / numpy**。
 * - 六颗工具：`video_info`（只读信息，不花图片 token）、`video_storyboard`、`live_snap`、`screen_snap`、`watch_start`/`watch_stop`。
 * - 只看得见图，听不见声音：没有 ASR，问「说了什么」要如实说没配。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, ToolOutcome, ToolSpec, World, WorldHost } from 'cortico/core/types.ts';
import { VIDEO_CONFIG_GROUP, VIDEO_DEFAULTS, type VideoConfigSection } from './config.ts';

const PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/storyboard.py', import.meta.url));
// 直播抓帧与截屏拼图：两个脚本都在包里的 scripts/ 下（2026-11-15 从工作区搬进来，别人装了才找得到）。
const STREAM_SHOT = fileURLToPath(new URL('../scripts/stream-shot.py', import.meta.url));
const LIVE_TILE = fileURLToPath(new URL('../scripts/live-tile.ps1', import.meta.url));

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.flv', '.avi', '.m4v', '.ts', '.wmv', '.mpg', '.mpeg']);

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const mmss = (sec: number): string => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
};

const stamp = (d: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

export const VIDEO_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'video_info',
    description: '读一段本地视频的容器信息：时长、分辨率、帧率、大小。不花图片 token，第一次碰一部片子先调它。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '视频文件的完整路径' } },
      required: ['path'],
    },
    tags: ['read'],
  },
  {
    name: 'video_storyboard',
    description:
      '把一段视频压成一张宫格图（一格＝一个换镜头的地方，格子左下角标着它在片里的时间码），'
      + '另附每格的起止秒数和那一格里听到的台词（本机 whisper 转写，可用 asr:false 关掉）。'
      + '**path 可以是本地文件，也可以是一条网址**（B 站/YouTube 都行，会先用 yt-dlp 下下来）。'
      + '**图片会随回执进入上下文**，所以这是「看画面」，不是读字幕。'
      + '长片子一段一段看：startSeconds 是起点、maxSeconds 是终点（都是绝对秒），格数用 maxFrames 调。'
      + '**要一次看一分钟，就 startSeconds/maxSeconds 圈出一分钟、pages 5、cols 2——五张图一起进上下文。**',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '视频文件的完整路径，或一条视频链接（http/https）' },
        maxFrames: { type: 'integer', minimum: 4, maximum: 64, description: '最多拼几格，默认取设置里的 24' },
        maxSeconds: { type: 'number', minimum: 1, description: '看到第 N 秒为止（绝对秒）；不传就是整段' },
        startSeconds: { type: 'number', minimum: 0, description: '从第 N 秒开始取（绝对秒，默认 0）。配合 maxSeconds 一段一段往后看：12~24 秒就是 startSeconds 12、maxSeconds 24' },
        pages: { type: 'integer', minimum: 1, maximum: 10, description: '一次出几张宫格（默认 1）；给 5 就把 start~end 平分成 5 段、5 张图一起进上下文' },
        cols: { type: 'integer', minimum: 0, maximum: 6, description: '宫格列数，0=按格数自动；6 格的宫格用 2（2 列 3 行）' },
        step: { type: 'number', minimum: 0.1, maximum: 5, description: '粗采样间隔（秒），默认 0.5' },
        asr: { type: 'boolean', description: '要不要转写台词；不传就按设置（默认开）。关了只出画面，快很多' },
      },
      required: ['path'],
    },
    tags: ['read'],
  },
  {
    name: 'live_snap',
    description:
      '贴一条直播地址，取「最近这一段」的画面拼成宫格，图片随回执进上下文。'
      + '默认一分钟：5 张 × 6 格 × 2 秒一格，跟看片一个规格。直播页地址会过期，脚本每次现取；只有画面，没有台词。'
      + '想接着看就再调一次——每次取的都是调用那一刻往后的一段。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '直播页地址（B 站直播间这类），或一条 m3u8/flv 直链' },
        seconds: { type: 'number', minimum: 6, maximum: 300, description: '取多长，默认 60 秒' },
        step: { type: 'number', minimum: 0.5, maximum: 10, description: '每隔几秒一格，默认 2' },
        cols: { type: 'integer', minimum: 1, maximum: 6, description: '每张几列，默认 2' },
        pages: { type: 'integer', minimum: 1, maximum: 10, description: '一次出几张，默认 5' },
        cell: { type: 'integer', minimum: 160, maximum: 1280, description: '每格宽度（像素），默认 640' },
      },
      required: ['url'],
    },
    tags: ['read'],
  },
  {
    name: 'screen_snap',
    description:
      '直接截这台电脑的屏幕，取「最近这一段」拼成宫格，图片随回执进上下文。'
      + '默认一分钟：5 张 × 6 格 × 每 2 秒一屏。格子里的小字是本机时钟，不是游戏时间。'
      + '要它在后台一直截、每批自动推过来，用 watch_start。',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', minimum: 6, maximum: 300, description: '这一段多长，默认 60 秒' },
        frames: { type: 'integer', minimum: 2, maximum: 12, description: '每张几格，默认 6' },
        cols: { type: 'integer', minimum: 1, maximum: 6, description: '每张几列，默认 2' },
        pages: { type: 'integer', minimum: 1, maximum: 10, description: '一次出几张，默认 5' },
      },
      required: [],
    },
    tags: ['read'],
  },
  {
    name: 'watch_start',
    description:
      '开关的「开」：让它自己持续看。source=screen 是截屏幕（每 2 秒一屏，一分钟五张自动推到对话里）；'
      + 'source=url 要给直播地址。同时只开一个，重复开会先停掉旧的。要停用 watch_stop。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['screen', 'url'], description: '看哪儿：screen=这台电脑的屏幕，url=一条直播地址' },
        url: { type: 'string', description: 'source=url 时的直播地址' },
        seconds: { type: 'number', minimum: 20, maximum: 300, description: '一批多长，默认 60 秒' },
        cols: { type: 'integer', minimum: 1, maximum: 6, description: '每张几列，默认 2' },
        pages: { type: 'integer', minimum: 1, maximum: 10, description: '一批几张，默认 5' },
      },
      required: ['source'],
    },
    tags: ['write'],
  },
  {
    name: 'watch_stop',
    description: '开关的「关」：停掉 watch_start 起的后台（截屏幕那个常驻进程）。',
    parameters: { type: 'object', properties: {}, required: [] },
    tags: ['write'],
  },
];

interface RunResult {
  ok: boolean;
  out: string;
  err: string;
  code: number | null;
}

interface RunnerOptions {
  cfg: VideoConfigSection;
  dataDir: string;
}

export class VideoWorld implements World {
  readonly id = 'watch';

  private host: WorldHost | null = null;

  private readonly cfg: VideoConfigSection;

  private readonly dataDir: string;

  private python = '';

  private last: { at: Date; file: string; cells: number; kind: 'probe' | 'sheet' } | null = null;

  private spoolTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RunnerOptions) {
    this.cfg = opts.cfg;
    this.dataDir = opts.dataDir;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.python = this.pickPython();
  }

  async stop(): Promise<void> {
    this.stopSpoolPoll();
    // 常驻截屏是 WMI 起的独立进程，不会跟着 World 或程序一起走：停 World、退程序都得当场掐掉，
    // 否则它一直截屏（2026-11-20 扩展市场的 bug 报告指出，核过属实）。
    this.stopWatchQuiet();
    this.host = null;
  }

  tools(): ToolDef[] {
    const byName = new Map(VIDEO_TOOL_SPECS.map((s) => [s.name, s]));
    const spec = (n: string): ToolSpec => byName.get(n) as ToolSpec;
    return [
      { ...spec('video_info'), handler: async (args) => this.probe(args) },
      { ...spec('video_storyboard'), handler: async (args) => this.sheet(args) },
      { ...spec('live_snap'), handler: async (args) => this.liveSnap(args) },
      { ...spec('screen_snap'), handler: async (args) => this.screenSnap(args) },
      { ...spec('watch_start'), handler: async (args) => this.watchStart(args) },
      { ...spec('watch_stop'), handler: async () => this.watchStop() },
    ];
  }

  async envPromptVars(): Promise<Record<string, string>> {
    const py = this.python || this.pickPython();
    const state = !py
      ? '没找到能用的 Python（要装 av 和 Pillow），两颗工具跑不起来。'
      : this.last
        ? `就绪 · Python ${basename(py)} · 最近一次：${this.last.file}（${this.last.cells} 格）`
        : `就绪 · Python ${basename(py)} · 还没跑过片子。画面＋台词（whisper 本机转）。`;
    return { 'video.state': state };
  }

  webUi(language?: Language): Record<string, unknown> {
    const en = language !== undefined && !String(language).startsWith('zh');
    return {
      label: en ? 'Watch It All With You' : '陪你看一切',
      config: [VIDEO_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.video.envPrompt',
        title: en ? 'Video · Environment prompt' : '看片 · 环境提示词',
        description: en ? 'Two tools and the state of the Python side.' : '两颗工具，以及抽帧那一侧的可用状态。',
        path: PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'video.state', description: en ? 'Python ready, or what is missing.' : 'Python 找没找到、最近跑了哪部片子。' },
        ],
      }],
    };
  }

  // —— 工具实现 ——

  private async probe(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const path = this.checkPath(args.path);
    if (typeof path !== 'string') return path;
    const r = await this.run([SCRIPT, '--input', path, '--probe']);
    const data = this.parse(r);
    if (!data) return this.failTail(r, '读信息没成');
    const p = (data.probe ?? data) as Record<string, unknown>;
    if (!p || p.ok !== true) return { text: `读不出这段视频：${String(p?.error ?? '原因不明')}`, failed: true };
    this.last = { at: new Date(), file: basename(path), cells: 0, kind: 'probe' };
    return [
      basename(path),
      `时长 ${mmss(Number(p.duration) || 0)} · ${p.width}×${p.height} · ${p.fps} fps · ${p.frames} 帧 · ${p.sizeMB} MB`,
      `路径 ${path}`,
      '',
      '要画面就调 video_storyboard；要台词得另配转写，这台机器上没有。',
    ].join('\n');
  }

  private async sheet(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const path = this.checkPath(args.path, true);
    if (typeof path !== 'string') return path;
    const isUrl = /^https?:\/\//i.test(path);

    const frames = Math.round(num(args.maxFrames, num(this.cfg.defaultFrames, VIDEO_DEFAULTS.defaultFrames)));
    const maxSeconds = args.maxSeconds === undefined || args.maxSeconds === null ? null : Number(args.maxSeconds);
    const step = num(args.step, 0.5);
    const cell = num(this.cfg.cellWidth, VIDEO_DEFAULTS.cellWidth);

    const outDir = str(this.cfg.outputDir, '') || join(this.dataDir, 'video', stamp(new Date()));
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (e) {
      return { text: `建不出输出目录：${outDir}\n${String(e)}`, failed: true };
    }

    const cli = [SCRIPT, '--input', path, '--out', outDir, '--max-frames', String(frames), '--cell', String(cell), '--step', String(step)];
    const startSeconds = args.startSeconds === undefined || args.startSeconds === null ? null : Number(args.startSeconds);
    if (startSeconds && Number.isFinite(startSeconds) && startSeconds > 0) cli.push('--start-seconds', String(startSeconds));
    if (maxSeconds && Number.isFinite(maxSeconds)) cli.push('--max-seconds', String(maxSeconds));
    const ytDlp = str(this.cfg.ytDlpPath, '');
    if (ytDlp) cli.push('--yt-dlp', ytDlp);
    const pages = Math.max(1, Math.min(10, Math.round(num(args.pages, 1))));
    if (pages > 1) cli.push('--pages', String(pages));
    const cols = Math.max(0, Math.round(num(args.cols, 0)));
    if (cols > 0) cli.push('--cols', String(cols));
    const asrOn = args.asr === undefined || args.asr === null ? this.cfg.asr !== false : args.asr !== false;
    cli.push('--asr', asrOn ? 'auto' : 'off', '--asr-model', str(this.cfg.asrModel, VIDEO_DEFAULTS.asrModel));

    const r = await this.run(cli);
    const data = this.parse(r);
    if (!data) return this.failTail(r, '抽帧没成');
    if (data.ok !== true) return { text: `没抽出画面：${String(data.error ?? '原因不明')}`, failed: true };

    const probe = (data.probe ?? {}) as Record<string, unknown>;
    const asr = (data.asr ?? {}) as { ok?: boolean; n?: number; note?: string; model?: string };
    const source = (data.source ?? {}) as { url?: string; title?: string; uploader?: string; note?: string };
    const title = str(source.title, '') || basename(path);

    const grids = (Array.isArray(data.grids) ? data.grids : [data.grid]) as Array<{ path?: string; width?: number; height?: number; cols?: number; rows?: number }>;
    const pageCells = (Array.isArray(data.pageCells) ? data.pageCells : [data.cells]) as Array<Array<Record<string, unknown>>>;

    const blobs: Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }> = [];
    for (let i = 0; i < grids.length; i++) {
      const g = grids[i];
      if (!g?.path || !existsSync(g.path)) continue;
      try {
        blobs.push({
          bytes: new Uint8Array(await readFile(g.path)),
          mime: g.path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
          name: basename(g.path),
          fallbackText: `宫格图：${title} 第 ${i + 1} 张（${g.cols}×${g.rows}）`,
        });
      } catch {
        // 某一张读不出来就跳过，不影响其它页
      }
    }
    if (!blobs.length) return { text: '抽完了，但宫格图没落到盘上。', failed: true };

    const totalCells = pageCells.reduce((n, p) => n + (Array.isArray(p) ? p.length : 0), 0);
    const asrLine = !asrOn
      ? '台词：这次没转（asr:false）。'
      : asr.ok
        ? `台词：本机 whisper（${asr.model ?? 'base'}）转了 ${asr.n ?? 0} 段，挂在各自那一格上。`
        : `台词没转成：${String(asr.note ?? '原因不明')}（画面照样看得到）。`;
    const endAt = maxSeconds ?? (Number(probe.duration) || 0);
    const span = startSeconds && startSeconds > 0 ? ` · 只看了 ${mmss(startSeconds)}–${mmss(endAt)}` : '';
    const size = `${mmss(Number(probe.duration) || 0)} · ${probe.width}×${probe.height} · ${blobs.length} 张图 / ${totalCells} 格${span}`;
    const lines = [
      isUrl
        ? `《${str(source.title, '') || '没标题'}》${str(source.uploader, '') ? ` · ${str(source.uploader, '')}` : ''} · ${size}`
        : `${basename(path)} · ${size}`,
      ...(source.note ? [`下载时：${source.note}`] : []),
      asrLine,
      '',
    ];
    grids.forEach((g, i) => {
      const cs = pageCells[i] ?? [];
      if (!cs.length) return;
      const first = String(cs[0].start ?? '');
      const last = String(cs[cs.length - 1].end ?? '');
      lines.push(`第 ${i + 1} 张 ${g.cols}×${g.rows}｜${first}–${last}｜${cs.length} 格`);
    });
    lines.push('', '画面是真的；台词是 whisper 听的，个别字听错很正常。');

    this.last = { at: new Date(), file: title, cells: totalCells, kind: 'sheet' };
    return { text: lines.join('\n'), blobs };
  }

  // —— 直播与屏幕 ——

  private outputDir(): string {
    const dir = str(this.cfg.outputDir, '') || join(this.dataDir, 'video', stamp(new Date()));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 常驻截屏的家：pid、帧、日志、spool 都在这一层。 */
  private liveDir(): string {
    const dir = join(this.dataDir, 'video', 'live');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 按 stream-shot / live-tile 的命名规则把这一批的图找出来（多页是 name-1.png…）。 */
  private pageFiles(out: string, pages: number): string[] {
    if (pages <= 1) return existsSync(out) ? [out] : [];
    const ext = extname(out);
    const base = out.slice(0, out.length - ext.length);
    const list: string[] = [];
    for (let i = 1; i <= pages; i++) {
      const p = `${base}-${i}${ext}`;
      if (existsSync(p)) list.push(p);
    }
    return list;
  }

  private async loadBlobs(files: string[], label: string): Promise<Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }>> {
    const blobs = [];
    for (let i = 0; i < files.length; i++) {
      try {
        blobs.push({
          bytes: new Uint8Array(await readFile(files[i])),
          mime: files[i].toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
          name: basename(files[i]),
          fallbackText: `${label} 第 ${i + 1} 张`,
        });
      } catch {
        // 读不出来就跳过
      }
    }
    return blobs;
  }

  private async liveSnap(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const url = str(args.url, '');
    if (!/^https?:\/\//i.test(url)) return { text: '得给一条直播地址（http/https 开头）。', failed: true };
    const seconds = clamp(num(args.seconds, 60), 6, 300);
    const step = clamp(num(args.step, 2), 0.5, 10);
    const cols = Math.round(clamp(num(args.cols, 2), 1, 6));
    const pages = Math.round(clamp(num(args.pages, 5), 1, 10));
    const cell = Math.round(clamp(num(args.cell, 640), 160, 1280));
    let out = '';
    try {
      out = join(this.outputDir(), `live-${stamp(new Date())}.png`);
    } catch (e) {
      return { text: `建不出输出目录：${String(e)}`, failed: true };
    }
    const r = await this.run([STREAM_SHOT, url, '--seconds', String(seconds), '--step', String(step),
      '--cols', String(cols), '--pages', String(pages), '--cell', String(cell), '--out', out]);
    const files = this.pageFiles(out, pages);
    if (!files.length) {
      const tail = `${r.out}\n${r.err}`.trim().slice(-700);
      return { text: `没取到画面（退出码 ${r.code ?? '—'}）：\n${tail || '没有输出'}`, failed: true };
    }
    const blobs = await this.loadBlobs(files, '直播宫格');
    this.last = { at: new Date(), file: url, cells: files.length * (pages > 1 ? 6 : 0), kind: 'sheet' };
    return {
      text: [
        `直播 · ${url}`,
        `取了 ${seconds} 秒 · 每 ${step} 秒一格 · ${blobs.length} 张图 / 每张 ${cols} 列`,
        '',
        '只有画面（直播这条路不转台词）。要接着看就再调一次，取的是那之后的又一段。',
      ].join('\n'),
      blobs,
    };
  }

  private async screenSnap(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const seconds = clamp(num(args.seconds, 60), 6, 300);
    const frames = Math.round(clamp(num(args.frames, 6), 2, 12));
    const cols = Math.round(clamp(num(args.cols, 2), 1, 6));
    const pages = Math.round(clamp(num(args.pages, 5), 1, 10));
    let out = '';
    try {
      out = join(this.outputDir(), `screen-${stamp(new Date())}.png`);
    } catch (e) {
      return { text: `建不出输出目录：${String(e)}`, failed: true };
    }
    const r = await this.runPsFile(LIVE_TILE, ['-Seconds', String(seconds), '-Frames', String(frames),
      '-Pages', String(pages), '-Columns', String(cols), '-Cell', '640', '-LiveDir', this.liveDir(), '-Out', out]);
    const files = this.pageFiles(out, pages);
    if (!files.length) {
      const tail = `${r.out}\n${r.err}`.trim().slice(-700);
      return { text: `没截到（退出码 ${r.code ?? '—'}）：\n${tail || '没有输出'}`, failed: true };
    }
    const blobs = await this.loadBlobs(files, '屏幕宫格');
    this.last = { at: new Date(), file: '屏幕', cells: files.length * frames, kind: 'sheet' };
    return {
      text: [
        `屏幕 · 这一段 ${seconds} 秒 · 每张 ${frames} 格 × ${cols} 列 · ${blobs.length} 张`,
        '',
        '格子里的小字是本机时钟。要它自己在后台一直截，用 watch_start。',
      ].join('\n'),
      blobs,
    };
  }

  private async watchStart(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const source = str(args.source, 'screen');
    const seconds = clamp(num(args.seconds, 60), 20, 300);
    const cols = Math.round(clamp(num(args.cols, 2), 1, 6));
    const pages = Math.round(clamp(num(args.pages, 5), 1, 10));
    if (source === 'url') {
      return {
        text: '直播那条先不做常驻：把地址发我，我一批一批调 live_snap（一次一分钟）。屏幕这条可以常驻——watch_start source=screen。',
        failed: true,
      };
    }
    this.stopWatchQuiet();
    const out = join(this.liveDir(), 'live-latest.png');
    const argList = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', LIVE_TILE,
      '-Loop', '-Notify', '-Seconds', String(seconds), '-Frames', '6', '-Pages', String(pages),
      '-Columns', String(cols), '-Cell', '640', '-LiveDir', this.liveDir(), '-Out', out,
      '-OwnerPid', String(process.pid)];
    // 用 WMI 起：execFile 起的 Start-Process 活不过那个 powershell，进程随之没了（2026-11-15 实测）。
    const line = ['powershell', ...argList.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(' ');
    const cmd = `$c = '${line.replace(/'/g, "''")}'; `
      + '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $c }; '
      + 'if ($r.ReturnValue -ne 0) { Write-Error ("WMI 起不来，ReturnValue=" + $r.ReturnValue) } else { $r.ProcessId }';
    const r = await this.runPsCmd(cmd);
    const pid = Number((r.out || '').trim());
    if (!r.ok || !Number.isFinite(pid) || pid <= 0) {
      return { text: `没起起来：\n${(r.err || r.out).slice(-400) || '没有输出'}`, failed: true };
    }
    try {
      writeFileSync(join(this.liveDir(), 'live.pid'), String(pid), 'utf8');
    } catch {
      // ps1 自己也会写一份
    }
    this.startSpoolPoll();
    const gap = Math.max(1, Math.round(seconds / (6 * pages)));
    return `开着了：每 ${gap} 秒截一屏，${seconds} 秒一批（${pages} 张 × 6 格），攒够就自动推过来。要停说一声，我调 watch_stop。`;
  }

  private async watchStop(): Promise<string | ToolOutcome> {
    this.stopSpoolPoll();
    const pid = this.readPid();
    if (!pid) return '现在没有在跑的后台。';
    this.stopWatchQuiet();
    return `停了（pid ${pid}）。`;
  }

  private readPid(): number | null {
    const file = join(this.liveDir(), 'live.pid');
    if (!existsSync(file)) return null;
    try {
      const n = Number(readFileSync(file, 'utf8').trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  /** 掐掉常驻截屏。不起新 powershell：退程序那一刻未必等得到它，直接按 pid 杀最稳。 */
  private stopWatchQuiet(): void {
    const pid = this.readPid();
    if (!pid) return;
    try {
      process.kill(pid);
    } catch {
      // 已经没了
    }
    try {
      rmSync(join(this.liveDir(), 'live.pid'), { force: true });
    } catch {
      // 删不掉就下次再说
    }
  }

  // —— 常驻截屏的推送 ——
  // ps1 每出一批就往 live/spool 丢一张纸条（哪几张图、几点到几点）；这边四秒看一次，
  // 有就带着图推一条事件进会话。以前靠工作区的 live-push.mjs，别人装了没有那个脚本。

  private startSpoolPoll(): void {
    this.stopSpoolPoll();
    this.spoolTimer = setInterval(() => void this.drainSpool(), 4000);
  }

  private stopSpoolPoll(): void {
    if (this.spoolTimer) clearTimeout(this.spoolTimer as unknown as ReturnType<typeof setTimeout>);
    this.spoolTimer = null;
  }

  private async drainSpool(): Promise<void> {
    const dir = join(this.liveDir(), 'spool');
    if (!existsSync(dir)) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(dir, name);
      let item: { from?: string; to?: string; files?: string[] } | null = null;
      try {
        item = JSON.parse(readFileSync(file, 'utf8')) as typeof item;
      } catch {
        item = null;
      }
      try {
        rmSync(file, { force: true });
      } catch {
        // 删不掉就下一轮再说
      }
      const files = (item?.files ?? []).filter((f) => existsSync(f));
      if (!files.length) continue;
      const blobs = await this.loadBlobs(files, '屏幕宫格');
      const host = this.host;
      if (!host) continue;
      try {
        await host.pushEvent({
          type: 'video.watch',
          ts: new Date().toISOString(),
          source: this.id,
          text: `[屏幕] ${item?.from ?? ''} → ${item?.to ?? ''} 这一批（${files.length} 张）`,
          senderKey: 'screen',
          meta: {},
          blobs,
        });
      } catch {
        // 推不进就算了，图还在磁盘上
      }
    }
  }

  // —— 内部 ——

  private checkPath(v: unknown, allowUrl = false): string | ToolOutcome {
    const p = str(v, '');
    if (!p) return { text: '得给一个视频文件的路径，或者一条视频链接。', failed: true };
    if (/^https?:\/\//i.test(p)) {
      if (allowUrl) return p;
      return {
        text: '这是个网址——网址交给 video_storyboard，它会自己下（video_info 只认本地文件）。',
        failed: true,
      };
    }
    if (!existsSync(p)) return { text: `没有这个文件：${p}`, failed: true };
    if (!VIDEO_EXTS.has(extname(p).toLowerCase())) {
      return { text: `这后缀不像视频：${extname(p) || '（没有后缀）'}。认得的是 ${[...VIDEO_EXTS].join(' ')}`, failed: true };
    }
    return p;
  }

  /** 脚本的 stdout 最后一行是 JSON；别的（警告、Python 报错）走 stderr。 */
  private parse(r: RunResult): Record<string, unknown> | null {
    const line = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private failTail(r: RunResult, what: string): ToolOutcome {
    const tail = `${r.out}\n${r.err}`.trim().slice(-800);
    return { text: `${what}（退出码 ${r.code ?? '—'}）：\n${tail || '没有输出'}`, failed: true };
  }

  private pickPython(): string {
    const configured = str(this.cfg.pythonPath, '');
    if (configured && existsSync(configured)) return configured;
    const candidates = ['C:\\Python312\\python.exe', 'C:\\Python311\\python.exe', 'C:\\Program Files\\Python312\\python.exe'];
    for (const c of candidates) if (existsSync(c)) return c;
    return 'python';
  }

  private run(args: string[]): Promise<RunResult> {
    const timeout = num(this.cfg.timeoutSeconds, VIDEO_DEFAULTS.timeoutSeconds) * 1000;
    return new Promise((resolve) => {
      execFile(
        this.python || this.pickPython(),
        args,
        { cwd: join(this.dataDir, '..'), timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? null : 0;
          resolve({ ok: !err, out: `${stdout ?? ''}`, err: `${stderr ?? ''}`, code });
        },
      );
    });
  }

  /** 跑一段 PowerShell。截屏那条脚本要 STA，所以走 -File。 */
  private runPsFile(script: string, args: string[]): Promise<RunResult> {
    const timeout = num(this.cfg.timeoutSeconds, VIDEO_DEFAULTS.timeoutSeconds) * 1000;
    return new Promise((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script, ...args],
        { cwd: join(this.dataDir, '..'), timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? null : 0;
          resolve({ ok: !err, out: `${stdout ?? ''}`, err: `${stderr ?? ''}`, code });
        },
      );
    });
  }

  private runPsCmd(cmd: string): Promise<RunResult> {
    return new Promise((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? null : 0;
          resolve({ ok: !err, out: `${stdout ?? ''}`, err: `${stderr ?? ''}`, code });
        },
      );
    });
  }
}
