/** `worlds.video` 的配置段与设置面板。 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { WorldSection } from 'cortico/world.ts';

export const VIDEO_ID = 'watch';

export interface VideoConfigSection extends WorldSection {
  /** Python 解释器；留空就自动找（PATH 里的 python / python3，再看几个常见安装位置）。 */
  pythonPath: string;
  /** 单次抽帧的超时。长片子慢慢扫会久，给足。 */
  timeoutSeconds: number;
  /** 不传 maxFrames 时抽几格。 */
  defaultFrames: number;
  /** 每格宽度（像素），越大越清楚也越费 token。 */
  cellWidth: number;
  /** 宫格图存哪儿；留空 = <dataDir>\video\<时间戳>\。 */
  outputDir: string;
  /** 要不要转写台词（faster-whisper，本机跑）。 */
  asr: boolean;
  /** whisper 模型：tiny / base / small / medium。 */
  asrModel: string;
  /** yt-dlp 的路径；留空就自己找（PATH → Python 的 Scripts → python -m yt_dlp）。 */
  ytDlpPath: string;
}

export const VIDEO_DEFAULTS: VideoConfigSection = {
  enabled: false,
  pythonPath: '',
  timeoutSeconds: 300,
  defaultFrames: 24,
  cellWidth: 320,
  outputDir: '',
  asr: true,
  asrModel: 'small',
  ytDlpPath: '',
};

const K = `worlds.${VIDEO_ID}`;

export const VIDEO_CONFIG_GROUP: ConfigGroup = {
  id: `world:${VIDEO_ID}`,
  owner: `world:${VIDEO_ID}`,
  schema: {
    type: 'object',
    title: '看片',
    description: '视频文件、视频链接、直播地址和屏幕，出一张带时间码的宫格图（图片随回执进上下文）。台词用本机 faster-whisper 转写，可以在设置里关。',
    properties: {
      [`${K}.pythonPath`]: {
        type: 'string', title: 'Python 解释器', 'x-hot': true,
        description: '留空自动找：先 PATH 里的 python，再看几个常见安装位置。需要装了 av（PyAV）和 Pillow；要听台词再装 faster-whisper。',
      },
      [`${K}.defaultFrames`]: {
        type: 'integer', title: '默认格数', minimum: 4, maximum: 64, 'x-hot': true,
        description: '调用时没给 maxFrames 就用这个。格子越多越细，token 也越多。',
      },
      [`${K}.cellWidth`]: {
        type: 'integer', title: '每格宽度', minimum: 160, maximum: 640, 'x-suffix': '像素', 'x-hot': true,
        description: '默认 320，按 16:9 算就是一格 320×180。图越大越费 token。',
      },
      [`${K}.timeoutSeconds`]: {
        type: 'integer', title: '抽帧超时', minimum: 30, maximum: 1800, 'x-suffix': '秒', 'x-hot': true,
        description: '超时就把 Python 进程杀掉，回失败。',
      },
      [`${K}.outputDir`]: {
        type: 'string', title: '宫格图存放目录', 'x-hot': true,
        description: '留空放 <dataDir>\\video\\<时间戳>\\；用完可以随手删。',
      },
      [`${K}.asr`]: {
        type: 'boolean', title: '转写台词', 'x-hot': true,
        description: '开着就用 faster-whisper 在本机把音轨转成带时间码的台词，一并发回来。慢一些（约片长的 20%）。',
      },
      [`${K}.asrModel`]: {
        type: 'string', title: 'whisper 模型', 'x-hot': true,
        description: 'tiny / base / small / medium。base 够用，small 准一些也慢三倍。第一次用会下模型（base 约 140MB）。',
      },
      [`${K}.ytDlpPath`]: {
        type: 'string', title: 'yt-dlp 路径',
        description: '留空就自己找（PATH → Python 的 Scripts 目录 → python -m yt_dlp）。给 video_storyboard 一条网址时用它下载。',
      },
    },
  },
};
