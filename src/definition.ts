/** `WorldDefinition`：id、默认配置、自描述、工厂。形状照抄 cortico-world-notescheck 0.1.0。 */
import { describeTools, type WorldContext, type WorldDefinition } from 'cortico/world.ts';
import { VIDEO_DEFAULTS, VIDEO_ID, type VideoConfigSection } from './config.ts';
import { VIDEO_TOOL_SPECS, VideoWorld } from './world.ts';

export const VIDEO: WorldDefinition<VideoConfigSection> = {
  id: VIDEO_ID,
  label: '陪你看一切',
  describe: {
    tools: describeTools(VIDEO_TOOL_SPECS, {
      video_info: { zh: '读视频信息', en: 'Read a video\u2019s container info' },
      video_storyboard: { zh: '把视频拼成宫格图', en: 'Turn a video into a contact sheet' },
      live_snap: { zh: '抓一段直播画面', en: 'Grab a stretch of a live stream' },
      screen_snap: { zh: '截一段屏幕', en: 'Grab a stretch of the screen' },
      watch_start: { zh: '开始持续看', en: 'Start watching continuously' },
      watch_stop: { zh: '停止持续看', en: 'Stop watching' },
    }),
    events: [
      {
        type: 'video.watch',
        description: {
          zh: '常驻截屏每攒够一批，带着那几张宫格图推过来一次。',
          en: 'A batch of screen contact sheets arrives while continuous watching is on.',
        },
      },
    ],
  },
  // 每次返回全新对象：别共享引用。
  defaults: () => ({ ...VIDEO_DEFAULTS }),
  create: (ctx: WorldContext<VideoConfigSection>) => new VideoWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir || ctx.repoRoot,
  }),
};
