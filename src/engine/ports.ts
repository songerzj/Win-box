// src/engine/ports.ts
// 宿主能力接口：引擎层从这里取依赖，禁止 import electron。
// T04 由主进程注入实现；T02 单测注入内存桩。
export type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  KVStore,
  Logger,
} from '../shared/types';

export interface EngineHost {
  http: import('../shared/types').HttpClient;
  kv: import('../shared/types').KVStore;
  logger: import('../shared/types').Logger;
  /** 本地代理对外 base，用于 lives 归一化（默认 127.0.0.1:9978） */
  proxyBase?: string;
  /** resources/js-lib 目录（cheerio/模板/gbk/cat 等本地库）；引擎层禁 import electron，目录由宿主传入 */
  jsLibDir?: string;
  /** 可选同步 HTTP（T03-B 沙箱 req() 同步语义的测试 mock 注入点；生产由沙箱内 spawnSync 兜底） */
  httpSync?: (req: import('../shared/types').HttpRequest) => import('../shared/types').HttpResponse;
  /**
   * JS 沙箱执行侧工厂。
   *   主进程注入 **worker 线程版**（worker/JsWorkerPool.ts）——JS 蜘蛛里的同步 `req()`
   *   原先用 spawnSync 实现，会把主进程冻住 0.4~1.5s/次，指向本机回环（`/pkg/…`）时
   *   还会与本地代理互等死锁（实测 11.6s）；搬进 worker 后阻塞只影响该 worker，
   *   超时直接 terminate 重建。缺省不注入 = 进程内 node:vm（单测与降级路径）。
   */
  jsSandboxFactory?: (init: {
    siteKey: string;
    api: string;
    ext: string;
    host: EngineHost;
    jsLibDir: string;
  }) => import('./js/JsSandbox').JsSandboxLike;
  /**
   * 网盘/资源站绑定凭据提供器（provider -> token，如 aliyun/quark/uc/baidu/pansou）。
   * 由宿主（SpiderHost）注入 DriveStore 快照；jar(dex) 蜘蛛 init(Context, ext) 前
   * 引擎会把这里返回的 token 并入 ext 顶层，使"先绑网盘 → 蜘蛛读 ext 调盘内资源"
   * 的流程成立（对齐 catvod 系：蜘蛛在 ext 中读取各自约定的 token 键）。
   * 纯内存、可缺省（未实现绑定的宿主不受影响）。
   */
  driveTokens?: () => Record<string, string>;
  /**
   * ★ 2026-10-13：**源侧请求重启应用**（加固壳网页配置中心恢复配置后自动重启）。
   *
   * 链路：wex 的 `x0.e.v0()` → `getLaunchIntentForPackage()` + `startActivity()` →
   * 桩把带标记的 Intent 转成 stderr 信令（`[winbox] app-restart-request`）→
   * 桥（JarSpiderBridge.noteBridgeLog）识别 → 调本回调 → 宿主做 Electron 重启。
   *
   * 引擎层禁 import electron → 由宿主（SpiderHost → 主进程入口）注入；
   * 缺省不注入 = 只记日志（单测/无 GUI 环境）。
   */
  requestAppRestart?: (reason: string) => void;
}
