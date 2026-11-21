# macOS 构建 / 打包 / 签名 / 公证 操作手册

> 面向作者本人（0 代码基础，纯 Vibe coding）。**每一条命令都可以原样复制粘贴执行**，
> 尖括号 `<...>` 里的内容按自己的情况替换。
>
> 适用范围：Win-Box 的 macOS（Apple Silicon / Intel）版本。
> **Windows 构建流程完全没有变化**，照旧用 `pnpm dist`（等价于 `node scripts/build-release.mjs`）。

---

## 0. 先读这三句

1. **macOS 版的打包只能在一台 Mac 上做。** Windows 上跑 `pnpm dist:mac` 必然失败（electron-builder 在 Windows 上无法生成 dmg / 无法调用 `codesign`）。
2. **本仓库不自带任何第三方二进制**（mpv / ffmpeg / ffprobe / aria2c / java / python3，以及 `resources/jvm/` 下的
   `stubs` `libs` `d2j` `shell-shim` `jre` 全部被 `.gitignore` 排除）。它们要么你自己 `brew install`，
   要么自己下载后放进 `resources/` 指定目录，要么从主开发机搬（见 **§2.4**）。
   放与不放都不影响构建成功，只影响运行时功能是否可用。
   > 例外的只有一只：`resources/jvm/native-bridge/native-bridge.jar` 是**本项目自己的代码**，已随源码入库（见 **§2.3**）。
3. **没有 Apple Developer 账号也能打包、也能自己用**，只是别人双击打开时会被系统拦截 —— 走第 8 节的「右键 → 打开」。

---

## 1. 环境准备

### 1.1 Node 与 pnpm

```bash
node -v          # 需要 ≥ 20（项目用 Electron 33 + Vite 6）
pnpm -v          # 没有就先装：npm i -g pnpm
```

没有 Node：去 <https://nodejs.org> 下载 **LTS** 版 pkg 安装，一路下一步。

### 1.2 Xcode Command Line Tools（必须）

它提供 `sips`（生成图标）、`iconutil`（生成 icns）、`codesign`（签名）、`notarytool`（公证）、`stapler`（装订公证票据）。

```bash
xcode-select --install
```

弹出安装窗口 → 点「安装」→ 同意许可 → 等它装完（约几分钟，取决于网速）。

验证装好了：

```bash
xcode-select -p        # 应输出 /Library/Developer/CommandLineTools 或 /Applications/Xcode.app/Contents/Developer
which sips iconutil codesign notarytool
```

> ⚠️ 只装 Command Line Tools 就够，**不需要**装完整的 Xcode（20GB+）。
> 但如果你想用 Xcode 的图形界面排查签名问题，可以从 App Store 装完整 Xcode。

### 1.3 拉代码装依赖

```bash
git clone https://github.com/yagami-hue/Win-box.git
cd Win-box
pnpm install
```

---

## 2. 自备依赖二进制（重要！仓库里没有）

### 2.1 放哪儿、怎么拿

| 工具 | 放置路径（相对仓库根目录） | 获取方式（推荐） | 缺了会怎样 |
| --- | --- | --- | --- |
| `mpv` | `resources/mpv/mpv` | `brew install mpv` 后**推荐直接用本机那份、不要拷贝**；只有想固定版本时才 `cp $(which mpv) resources/mpv/mpv`（放了就会压过本机，见 §2.2 例外） | 播放器内核缺失，只能用 HTML5 内核 / 外部播放器 |
| `ffmpeg` | `resources/ffmpeg/ffmpeg` | `brew install ffmpeg` 后 `cp $(which ffmpeg) resources/ffmpeg/ffmpeg` | 部分流媒体转封装与兼容播放不可用 |
| `ffprobe` | `resources/ffmpeg/ffprobe` | 同上（与 ffmpeg 同源） | 探测时长/音轨失败 |
| `aria2c` | `resources/aria2/aria2c` | `brew install aria2` 后 `cp $(which aria2c) resources/aria2/aria2c` | **磁力 / BT 播放直接不可用** |
| `java` | `resources/jvm/jre/bin/java` | **在 mac 上用 Zulu 17.0.13 的 JDK 自建**：`node scripts/build-jre.mjs`（见 **§2.5**） | **所有 jar 蜘蛛不可用** |
| `python3` | **不用放** | `brew install python@3.11` | py 蜘蛛不可用 |

> 上表「放置路径」一列填的是**随包内置**的位置。注意它**不等于「一定会用到」**：
> 除 `mpv` 外，程序都是**本机装的优先、随包只做兜底**；`mpv` 反过来是内置优先。
> 具体差异见 **§2.2**，别跳过那一节。

> 一键复制版（Apple Silicon 机器，`brew` 已装）：
>
> ```bash
> # ① 装齐本机版本（ffmpeg / aria2c 之后会各拷一份进 resources/ 当兜底）
> brew install mpv ffmpeg aria2
>
> # ② 只拷贝「本机优先、所以拷了也不改变结果、但能在没装的机器上兜底」的三个
> mkdir -p resources/ffmpeg resources/aria2
> cp "$(which ffmpeg)"   resources/ffmpeg/ffmpeg
> cp "$(which ffprobe)"  resources/ffmpeg/ffprobe
> cp "$(which aria2c)"   resources/aria2/aria2c
>
> # ③ mpv 故意不拷：拷进去会压过 brew 那份（mpv 是「内置优先」的例外链）
> #    想让 mpv 用随包版本时再执行下面这行
> # mkdir -p resources/mpv && cp "$(which mpv)" resources/mpv/mpv
> ```
>
> Intel Mac 把上面的安装命令同样跑一遍即可（`brew` 会自动选 x64 版本）。
>
> **JRE 不在上表里手动下载** —— 它是平台相关的 jlink 产物，必须在 mac 上自建，见 **§2.5**。
> （本节早期版本曾建议下载 Temurin JRE 21 直接塞进 `resources/jvm/jre/`。那条路有两个隐患：
> 大版本与项目对齐的 17 不一致；且 17.0.14+ / 21 起 JCE 会校验 provider 的 jar 签名，
> 会拦掉 `AndroidKeyStore` 的注册 —— 属未验证的口子，故改为自建。）

### 2.2 ★ 探测顺序（到底用的是哪一个）

口径是 **「自动探测优先、内置兜底」**：本机装了就用本机那份，找不到才回退随包。

**通用链**（`src/main/util/toolProbe.ts`，除 `mpv` 外所有工具都走这条）：

```
① 用户在配置页手动填的路径（override）
     —— 填了但文件不存在会「继续往下探」，填错不至于把功能直接关死
② 本机探测（system）：你自己装的 Homebrew / /Applications 版本
     /opt/homebrew/bin → /usr/local/bin → /usr/bin → PATH
③ 随包内置（bundled）：resources/<tool>/<二进制>
     —— 本机确实找不到才回退到它
④ 都没有 → none（功能降级，并给一句人话安装指引，绝不崩溃）
```

**为什么 ② 在 ③ 前面**：用户自己装的那份能随手升级、编解码器更全，也不会被 Gatekeeper 因为「未签名的随包二进制」拦掉；随包二进制只在「这台机器上什么都没有」时兜底。

> ⚠️ **例外：`mpv` 走的是另一条链，而且顺序是「内置优先」**
>
> `mpv` 不由上面这条通用链解析，而是走 `src/main/player/mpvCore.ts` 的 `resolveMpvPath()`：
>
> ```
> ① override → ② bundled（resources/mpv/mpv）→ ③ system（mpv.app / Homebrew / PATH）→ ④ none
> ```
>
> 这是**刻意保留**的：Windows 上随包的 `mpv.exe` 与 `Program Files\mpv\mpv.exe` 可能同时存在，
> 一旦重排就会改变 Windows 既有的选择（违反零回归红线）。
>
> **macOS 上的实际含义**：只要你把文件放进了 `resources/mpv/mpv`，它就会**压过** brew 装的那一份 ——
> 想让 brew 版生效，就**不要**往 `resources/mpv/` 里放东西。

**实践建议（macOS 上照这个做最省心）：**

- **优先用 `brew` 装，不要随包放。** 理由：brew 版能随手升级、不会被 Gatekeeper 因为「未签名的随包二进制」拦、也少一步递归签名。
  - 对 `ffmpeg` / `ffprobe` / `aria2c` / `java` / `python3`：不放 `resources/` → 本机直接生效（通用链 ② 档）。
  - 对 `mpv`：不放 `resources/mpv/` → 回退到本机的 `mpv.app` / Homebrew（例外链 ③ 档）。
- **想固定用某个版本（比如 brew 的 mpv 太新有 bug）**：
  - `mpv` 可以靠「放进 `resources/mpv/mpv`」直接压过本机；
  - **其它工具做不到**（本机有就不看内置）—— 要么卸载本机那份，要么在配置页用「用户指定路径」钉住（override 永远是最高档）。
- **`aria2c` 建议随包**（Windows 版也是随包的）作为**兜底**：磁力功能是核心能力，若用户机器上没装 brew 的 aria2，随包那份就能顶上。

启动后怎么看最终用了哪个：日志里会有一行一个依赖（`<tool>=<source> <path>`，`source` 取值 `override` / `system` / `bundled` / `none`）：

```
依赖: ffmpeg=system /opt/homebrew/bin/ffmpeg
依赖: mpv=system /opt/homebrew/bin/mpv
依赖: aria2c=bundled /Applications/Win-Box.app/Contents/Resources/app.asar.unpacked/resources/aria2/aria2c
依赖: java=none（brew install openjdk 或下载 Temurin JRE 放到 resources/jvm/jre）
```

读法：
- `ffmpeg=system` → 用的是你 `brew` 装的那份（通用链第 ② 档，正常且推荐）；
- `mpv=system` → 注意 `resources/mpv/mpv` **不存在**才会出现这行（mpv 是内置优先的例外链）；若你放了随包 mpv，这里会显示 `mpv=bundled`；
- `aria2c=bundled` → 本机没装 aria2，程序回退用了随包那份（兜底生效，磁力照常可用）；
- `java=none` → 两处都没找到，jar 蜘蛛会走「不可用」的人话降级。

---

### 2.3 原生桥（ARM `.so`）—— 这只 jar **已随源码入库，mac 上不用做任何事**

加固壳源（摸鱼 / fty / 嗷呜 / wex…）的 jar 里塞了 **Android ARM 机器码**（`.so`）。
纯 Java 字节码能靠 dex2jar + 安卓桩搬到桌面 JVM 上跑，**机器码不行** —— 所以桌面版另有一条
「原生桥」：在进程内用 unidbg **模拟** AArch64/ARM32 指令，并把 jar 里声明的 native 方法改写成
转发实现。桥的 JVM 侧就是这一只 jar：

```
resources/jvm/native-bridge/native-bridge.jar     ← ★ 已入库（.gitignore 专门开了白名单）
```

**为什么把它入库**：它是**本项目自己的代码**（源码同目录 `com/winbox/nativebridge/*.java`），
与 `resources/jvm/libs/`、`shell-shim/` 那些「逆向自第三方 app、不接受开源分发」的产物性质不同。
而在入库之前，它的构建脚本只有 PowerShell 的 `build.ps1`（macOS 跑不了）、产物又不入库，于是：

> mac 上从零 clone 的仓库里**根本没有这只 jar** → `JarSpiderBridge.nativeNeeded()` 第一件事就是
> `existsSync(native-bridge.jar)`，见不到就**整条原生桥不启用**（连 unidbg 运行时不下载、日志一行不打）
> → 含 `.so` 的壳源只能按无原生桥加载 → `UnsatisfiedLinkError` → 界面上报
> **「该源依赖安卓原生库（.so），桌面版无法加载（架构限制，非移植缺陷）」**。

⚠ 那句话对 mac 场景是**误导**：真正的原因是「桥没装」，不是「架构限制」。
（unidbg 0.9.9 的运行时 jar 本身就带 macOS 二进制 —— `unicorn-1.0.15.jar` 内是
`natives/osx_64|osx_arm64/libunicorn_java.dylib`，dynarmic / capstone / keystone / JNA 同理；
桥的 Java 侧也是纯字节码、无平台分支。所以它从一开始就不是「物理不可能」，只是「没交付」。）

**怎么确认它在工作**（日志里搜 `native-bridge`）：

| 日志 | 含义 |
| --- | --- |
| `[native-bridge] 原生桥就绪：xxx.so (102440B, 64 位)，注册 native 8 个` | ✅ 正常 |
| `[native-bridge] 原生桥改写产物复用（同 jar/.so）…` | ✅ 正常（复用上次产物，更快） |
| `[native-bridge] 准备失败，按无原生桥降级: …` | ❌ 桥跑了但失败（看冒号后面的异常） |
| `native: 该源含原生库(.so)，但**原生桥实现缺失**…` | ❌ jar 不见了（见下方重建） |
| 全程没有 `native-bridge` 字样 | 该源不含 `.so`，本来就不需要桥 |

**只有在改了 `com/**/*.java` 之后才需要重建**（产物才是运行时真正加载的东西）：

```bash
pnpm build:native-bridge
# 等价于 node resources/jvm/native-bridge/build-native-bridge.mjs
#   可选：--jdk <JDK目录>  --lib <unidbg运行时目录>  --out <别的输出路径>
```

需要两样东西，缺了脚本会**明确报错并告诉你从哪拿**（不会静默产出坏 jar）：

- **JDK**（不是 JRE）—— `javac` / `jar` 只在 JDK 里：`brew install openjdk@17`
  （脚本固定传 `--release 17`，产物 class 版本 61，与随包 JRE 对齐；用 JDK 21 构建也安全）
- **unidbg 运行时 jar** —— 不入库，由应用按需下载。默认自动查找
  `~/Library/Application Support/Win-Box/winbox-cache/native/unidbg-0.9.9`；
  **先启动一次应用并导入任意含 `.so` 的加固壳源**就会出现，或用 `--lib` 指向别处的同名目录。

> 打包把关：`pnpm dist:mac` 会先检查这只 jar 在不在，缺了**直接报错**并给出重建命令
> （确需出一个「无原生桥」的降级包时才加 `--allow-no-bridge`）。
>
> 重建出来的 jar **字节上会和入库的那只不完全一样**（zip 内嵌时间戳；以及不同 javac 对
> 单参数字符串拼接是否插 `String.valueOf` 的差异）—— 属语义等价的正常现象，
> `git status` 里显示 jar 被改过**不是出错**。只有当类清单/方法签名变了才是真改动。

> ⚠ **仍未实现**：非阻塞 TCP/socket 就绪（`CONTINUE.md` 列为「未验收」）。
> `BridgeARM32Emulator.java` 里曾引用过一个**从未在任何提交里出现过**的 `SocketReadiness`，
> 导致该文件自 `0c6bd45` 起**编译不过**（jar 不入库 → 这个断裂长期无人发现）。
> 2026-10-14 已按**产物实测形态**还原（`javap` 逐类核对：37 个类清单一致、34 个字节码逐字节一致），
> 使源码重新可构建。要续做非阻塞就绪请**新写** `SocketReadiness` 并把分支加回来，
> 不要只补一个 `import` 了事。
>
> ⚠ **macOS 真机未验证**：unidbg 的 `.dylib` 能否被 `dlopen`（见 §10 的 **V9**）。
> 若报 `Library not loaded` / `code signature invalid`，那是 Hardened Runtime 拦了未签名 dylib ——
> 授权文件需要 `com.apple.security.cs.disable-library-validation`（见 §5）。

### 2.4 ★ JVM 私有资产（`stubs` `libs` `d2j` `shell-shim`）—— 必须在 Mac 上从主开发机搬一次

**这一节解决「Mac 上 jar 蜘蛛全废 / 加固壳源报 NPE」的绝大多数情况。先读它，再去翻源码。**

jar 蜘蛛想在桌面跑起来，靠的是 `resources/jvm/` 下的一整套宿主环境。里面**大部分不入库**
（`.gitignore` 明文排除），因为这些是逆向自第三方 app 的产物、版权属原作者、不接受开源分发：

| 资产 | 作用 | 入库？ |
| --- | --- | --- |
| `stubs/stubs.jar` | 安卓桩 + `Spider` 基类 + `SpiderRunner`（JVM 子进程入口）；301 条目 / 297 个 class | ✗ |
| `stubs/shell-shim.jar` | 影子 `DexNative`（加固壳的兜底入口）；整只 jar 只有 1 个 class | ✗ |
| `libs/*.jar` | okhttp / okio / gson / jsoup / org.json / sqlite-jdbc / bcprov / slf4j / python-runner | ✗ |
| `d2j/*.jar` | dex2jar 分发（把蜘蛛 jar 里的 `classes.dex` 转成 `.class`） | ✗ |
| `shell-shim/real/<壳名>.jar` | 加固壳的**真实实现**（当前内置 `foni-spider` / `ftyshinidie` / `wexshinidie`） | ✗ |
| `native-bridge/native-bridge.jar` | ARM `.so` 模拟桥（**本项目自己的代码**） | **✓ 已入库** |
| `jre/` | JVM 运行时 | ✗ **且平台相关**（见 §2.5） |
| `okhttp4-compat/` | okhttp4 参数序补丁 | ✗ 构建时现场生成 |

所以在 Mac 上**刚 clone 完的仓库跑不了任何 jar 蜘蛛**，必须先搬一次上表前五行。

#### 搬法：主开发机一条命令导出，Mac 一条命令导入

在**主开发机（Windows）**的仓库根目录：

```bash
node scripts/export-jvm-assets.mjs --export
# 产物：.tmp/jvm-assets/winbox-jvm-assets-<版本>-<时间>.tar.gz   约 45MB
#       同目录另有 .sha256，控制台也会打印 sha256 值
#（.tmp/ 已被 .gitignore 排除；想放别处：--export /path/to/dir）
```

把这个 `.tar.gz` 传到 Mac（AirDrop / U 盘 / scp 都行）。
**⚠ 不要上传到任何公开网盘，也不要提交进 git** —— 包里是第三方私有资产，只供作者本人机器间搬运。

在 **Mac 的仓库根目录**：

```bash
node scripts/export-jvm-assets.mjs --import ~/Downloads/winbox-jvm-assets-<版本>-<时间>.tar.gz
```

它会依次做三件事：

1. **逐个比 sha256**（包坏了/传了一半 → 直接拒绝，绝不会写半个进去）；
2. **落盘到 `resources/jvm/`**（已存在且内容一致的文件自动跳过 → 可重复执行；内容不同则默认拒绝覆盖，要覆盖加 `--force`）；
3. **自动跑一次体检**（见下）。

只想校验、不想写文件：加 `--dry-run`。

#### 随时体检：`--doctor`

```bash
node scripts/export-jvm-assets.mjs --doctor
```

输出分三段，并对每个 ✗ 给出**可以直接复制粘贴的修复命令**；有致命项时退出码为 1。

```
[1] 搬运包覆盖的资产（缺了 → 用 --export/--import 从主开发机搬）
  ✓ stubs/stubs.jar             329.8 KB  301 条目  class 61✓  安卓桩 + SpiderRunner
  ✓ libs/                        22.7 MB  10 个 jar（必需 10/10 齐）
  ✓ shell-shim/real/              5.2 MB  3 个：foni-spider, ftyshinidie, wexshinidie
[2] 平台自备 / 生成物（本包不含，必须在目标机器上准备）
  ✓ jre/  17.0.13  (Zulu17.54+21-CA)
      ✓ 血统符合（17.0.13）
      ✓ 模块：含 jdk.charsets + jdk.localedata（共 27 个模块）
  ✓ native-bridge/native-bridge.jar  80.2 KB
  · unidbg 运行时尚未下载（首次用含 .so 的壳源时自动下载，约 39MB）
[3] 其他工具（仅供参考；口径见 §2.1-2.2，不影响本脚本结论）
  ✓ ffmpeg    bundled=无   system=/opt/homebrew/bin/ffmpeg
```

**「Mac 上某个源跑不起来」时的建议顺序：先 `--doctor`，再去看日志。** 它比日志快，而且能区分
「资产没搬 → 源的问题」和「源真的坏了」。

### 2.5 随包 JRE（`resources/jvm/jre`）—— 必须在 Mac 上自建，且必须用 Zulu 17.0.13

`jre/` 是 **jlink 裁剪产物、平台相关**：Windows 那份里是 `java.exe`，拷到 mac 上跑不了，
所以它**不进搬运包**（§2.4），要在 Mac 上自己生成一次。

```bash
# ① 下 Zulu 17.0.13 的 **JDK**（不是 JRE —— jlink 与 jmods 只在 JDK 里）
#    Apple Silicon（M 系列）：
curl -LO https://cdn.azul.com/zulu/bin/zulu17.54.21-ca-jdk17.0.13-macosx_aarch64.tar.gz
#    Intel Mac 换成： zulu17.54.21-ca-jdk17.0.13-macosx_x64.tar.gz
mkdir -p ~/zulu-jdk17 && tar xzf zulu17.54.21-ca-jdk17.0.13-macosx_aarch64.tar.gz -C ~/zulu-jdk17

# ② 找到解压出来的 JDK home（里面有 bin/ 和 jmods/）
JDK="$(find ~/zulu-jdk17 -maxdepth 5 -type d -name Home -path '*Contents*' | head -1)"
"$JDK/bin/java" -version          # 应显示 17.0.13 且带 Zulu

# ③ 生成 resources/jvm/jre（先建到临时目录验证血统，通过后再落到正式目录）
node scripts/build-jre.mjs --jdk "$JDK" --out /tmp/jre-test
node scripts/build-jre.mjs --jdk "$JDK"          # ← 验证通过后再跑这一条

# ④ 校验现有 JRE（真的 Charset.forName 一遍 + 真的注册一次 JCE provider）
node scripts/build-jre.mjs --check
```

> ⚠ 第 ③ 步之所以先 `--out /tmp/jre-test`：`build-jre.mjs` 是**先删旧产物再 jlink**，
> 万一血统不对（脚本末尾的 `verifyCharsets()` / `verifyJce()` 会把关并 exit 1），
> 正式目录里那份能用的 JRE 已经被删掉了。先建到临时目录可避免这个来回。

**★★ 血统红线：必须 Zulu 17.0.13。** 同样的下法换成 17.0.14+ 会引入两个更严重的回归：

- `jdk.charsets` 缺失 → GB2312 / GBK / Big5 的站点（柠檬、天天…）在**静态初始化**阶段抛
  `UnsupportedCharsetException`，整个源（首页/搜索/详情）全废；
- JCE 拒绝注册 provider → 所有用 `AndroidKeyStore` 的源全灭。

机理、以及「已经试过并且失败的四条死路」，见 `docs/jvm-notes.md`。

> 想塞一个**现成** JRE 应急（不推荐）：把 macOS JDK/JRE 包里的 `Contents/Home` 那一层拷成
> `resources/jvm/jre/`（`jre/bin/java` 与 `jre/Contents/Home/bin/java` 两种布局都会被识别）。
> 但 17.0.14+ / 21 的血统问题未知 —— 拷完先跑 `node scripts/export-jvm-assets.mjs --doctor`，
> 它的「模块」一行会告诉你 `jdk.charsets` / `jdk.localedata` 在不在。

---

## 3. 生成图标（只需做一次）

macOS 用 `.icns`，这个文件**不入库**（`.gitignore` 已排除），在 Mac 上现生成：

```bash
node scripts/make-icon.mjs
```

它做两件事（都用 macOS 自带命令，零新增依赖）：

1. `sips` 把 `build/icon.png` 缩成 10 种尺寸（16px ~ 1024px），放进临时目录 `build/icon.iconset/`
2. `iconutil -c icns` 把它合成 `build/icon.icns`

看到 `[make-icon] done: .../build/icon.icns` 就成功了。

> 非 macOS 上执行会**明确报错**并给出替代方案（不会静默失败）。错误信息里会告诉你要么在 Mac 上生成后拷回来，要么用在线 png→icns 工具。
> 源图要求：正方形、越大越好（≥ 1024×1024 最佳）。

---

## 4. 构建

```bash
pnpm dist:mac
```

等价于 `node scripts/build-release.mjs --mac`，内部实际执行：

```
node scripts/build-main.mjs            # 主进程打包（esbuild）
vite build                             # 渲染层打包
（校验 native-bridge.jar 是否随包 / macOS 上校验 build/icon.icns）
node_modules/electron-builder/out/cli/cli.js --mac dmg zip --publish never
```

**产出（在 `release<版本号>/` 目录下）：**

| 文件 | 说明 |
| --- | --- |
| `Win-Box-<版本>-arm64.dmg` | Apple Silicon（M1/M2/M3/M4）安装包 |
| `Win-Box-<版本>-x64.dmg` | Intel Mac 安装包（Apple Silicon 上经 Rosetta 也能跑） |
| `Win-Box-<版本>-arm64.zip` | arm64 便携包（解压后直接拖进「应用程序」） |
| `Win-Box-<版本>-x64.zip` | x64 便携包 |

中间的 `.app` 在 `release<版本号>/` 的 `mac` / `mac-arm64` / `mac-x64` 子目录里，第 5 节签名要用到它：

```bash
find release<版本号> -maxdepth 3 -name "Win-Box.app"
```

**常见构建失败：**

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `Missing build/icon.icns — 先在 macOS 上执行...` | 没跑第 3 步 | `node scripts/make-icon.mjs` |
| `缺少 resources/jvm/native-bridge/native-bridge.jar ...` | 原生桥 jar 被误删（它在库里，正常不该缺） | `node resources/jvm/native-bridge/build-native-bridge.mjs`；确要出降级包加 `--allow-no-bridge` |

> ★ 2026-10-15（合并上游 1.21.5）：上游把「赞赏图 / 加群二维码」整条删除，本仓随之**不再需要任何私有素材** ——
> `--allow-placeholder`、`WINBOX_SUPPORT_IMAGE` / `WINBOX_GROUP_IMAGE` 与「产物含原图」的 SHA256 校验全部移除。

> **Windows 零回归**：`pnpm dist`（不带参数）走的是完全没动过的 `--win nsis` 分支，产物文件名与以前一致。

---

## 5. 签名（有 Apple Developer 账号才需要；没有就跳到第 8 节）

### 5.1 为什么必须递归签名

macOS 会对 **`.app` 内部每一个可执行文件 / 动态库单独校验**。本项目 `.app` 里塞了
`mpv`、`ffmpeg`、`ffprobe`、`aria2c`、`java`（JRE 里还有几十个 dylib 和可执行文件）、`python3` ——
只要有一个没签，`codesign --verify` 就失败，用户打开时表现为「已损坏」或直接被 SIGKILL。

`codesign --deep` 官方不推荐用于正式分发（它会对所有嵌套项套用同一份授权，且容易漏签），
**推荐做法是由内向外逐层签**：dylib → 嵌套可执行 → 主 `.app`。

### 5.2 先查证书名

```bash
security find-identity -v -p codesigning
```

找形如 `Developer ID Application: Your Name (TEAMID1234)` 的那一行，整串复制下来。

### 5.3 一步到位脚本（复制粘贴改三行即可）

```bash
cd /path/to/Win-box                      # ← 改成你的仓库路径
APP="$(find release* -maxdepth 3 -name 'Win-Box.app' | head -1)"
IDENT="Developer ID Application: Your Name (TEAMID1234)"   # ← 改成你的证书名
ENT="build/entitlements.mac.plist"
ENT_INH="build/entitlements.mac.inherit.plist"

echo "→ 目标：$APP"

# ⓪ 先清隔离属性（必须在签名前做；否则签名会被隔离标记污染）
xattr -cr "$APP"

# ① dylib / framework（最深的一层）
find "$APP/Contents" -type f \( -name '*.dylib' -o -name '*.so' \) -print0 \
  | xargs -0 -n1 -I{} codesign --force --timestamp --options runtime \
      --entitlements "$ENT_INH" --sign "$IDENT" "{}"

# ② 嵌套可执行文件（mpv / ffmpeg / ffprobe / aria2c / java / python3 …）
find "$APP/Contents" -type f -perm -u+x ! -name '*.dylib' ! -name '*.so' ! -name '*.jar' -print0 \
  | xargs -0 -n1 -I{} codesign --force --timestamp --options runtime \
      --entitlements "$ENT_INH" --sign "$IDENT" "{}"

# ③ 主应用本体（用主授权文件，注意不是 inherit 那份）
codesign --force --timestamp --options runtime \
  --entitlements "$ENT" --sign "$IDENT" "$APP"

# ④ 校验
codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -vvv -t exec "$APP"
```

看到 `satisfies its Designated Requirement` 且 `spctl` 输出 `accepted` 即签名通过。

> `--options runtime` = 开启 Hardened Runtime，**公证的硬性要求**，不能省。
> `--timestamp` = 打时间戳，证书过期后已签的包仍有效。
> 授权文件已在仓库里（`build/entitlements.mac.plist` / `build/entitlements.mac.inherit.plist`），
> 里面开了 `allow-jit`、`allow-unsigned-executable-memory`、`disable-library-validation`
> —— JVM 与 CPython 子进程的刚需，删掉会导致 java / py 蜘蛛启动即崩溃。

### 5.4 重新打包 dmg / zip

签名完 `.app` 后，原来的 dmg / zip 里还是未签名的副本，需要让 electron-builder 重打一次
（它会复用已签名的 `.app`，或直接重跑构建）：

```bash
pnpm dist:mac
```

> 更简单省事的顺序其实是：**第 4 步构建完 → 先签名 `.app` → 再让 electron-builder 重打 dmg**。
> 上面的脚本默认你已经在 `release*/` 里有 `.app` 了。

### 5.5 为什么不开 App Sandbox（别加沙盒 entitlement）

`build/entitlements.mac.plist` 里的 `com.apple.security.network.client`、
`com.apple.security.network.server`、`com.apple.security.files.user-selected.read-write`
都是 **App Sandbox 的授权项**。本仓**没有**打开沙盒总开关 `com.apple.security.app-sandbox`，
所以这些条目是**惰性、加了也不生效**的 —— 这正是本仓明确反对的「假开关」（见 `docs/design-principles.md`）：
开关必须真实改变行为且有测试证明，这里两者都没有。

真开沙盒会直接打破本仓的交付与使用方式：

- 随包的 mpv / ffmpeg / JRE / aria2c 子进程、以及 unidbg `.dylib` 的 `dlopen` 会被拦；
- `安装目录/data` 的持久化读写被禁；
- 外部播放器子进程的启动、DLNA 组播 / 局域网发现都会失效。

所以**不要**为了「看起来更安全」去给 `build/entitlements.mac.plist` 开沙盒。
真遇到 macOS 上「全源空白 / 什么都加载不出来」，按顺序查：签名与公证（§5、§7）、
Gatekeeper 隔离属性（§6）、随包二进制是否齐（§2.1–§2.5）、DNS / DoH 解析、
以及本地中继 9978 端口是否在监听 —— **不是** entitlement 的问题。

---

## 6. 去隔离属性（每台机器第一次打开前都该做）

从网上下载的 `.app` / `.dmg` 会被打上 `com.apple.quarantine` 扩展属性，
未公证的包因此被 Gatekeeper 拦下。清掉它：

```bash
xattr -cr /Applications/Win-Box.app
# 或直接对 dmg 做（挂载前）：
xattr -cr ~/Downloads/Win-Box-1.20.10-arm64.dmg
```

查看当前有哪些扩展属性：

```bash
xattr -l /Applications/Win-Box.app
```

---

## 7. 公证（Apple 服务器扫毒，让所有人双击就能打开）

### 7.1 存一次凭据（只需做一次）

去 <https://appleid.apple.com> → 「App 专用密码」生成一个专用密码，然后：

```bash
xcrun notarytool store-credentials "winbox-notary" \
  --apple-id "<你的 Apple ID 邮箱>" \
  --team-id "<TEAMID1234>" \
  --password "<刚生成的 App 专用密码>"
```

之后提交就不用再输密码了。

### 7.2 提交 `.app` 公证

```bash
APP="$(find release* -maxdepth 3 -name 'Win-Box.app' | head -1)"
ditto -c -k --keepParent "$APP" "Win-Box-notarize.zip"
xcrun notarytool submit "Win-Box-notarize.zip" \
  --keychain-profile "winbox-notary" --wait
```

成功输出 `status: Accepted`。失败会返回一个 Submission ID，用它看详细原因：

```bash
xcrun notarytool log <Submission-ID> --keychain-profile "winbox-notary"
```

### 7.3 装订票据（staple）

```bash
xcrun stapler staple "$APP"
```

### 7.4 重打 dmg 并公证 dmg 本体

```bash
pnpm dist:mac                                  # 重新生成 dmg / zip（内含已公证的 .app）
xcrun notarytool submit "release<版本号>/Win-Box-<版本>-arm64.dmg" \
  --keychain-profile "winbox-notary" --wait
xcrun stapler staple "release<版本号>/Win-Box-<版本>-arm64.dmg"
# x64 的同上再来一遍
```

### 7.5 最终验证（在一台干净的 Mac 上）

```bash
spctl -a -vvv -t open --no-cache "release<版本号>/Win-Box-<版本>-arm64.dmg"
```

输出含 `accepted` + `source=Notarized Developer ID` 即成功。

---

## 8. 没有 Apple Developer 账号怎么办（给用户看的操作步骤）

没有账号 → 无法签名 / 无法公证 → 别人下载后双击会被 Gatekeeper 拦。
**软件本身完全能跑**，只需要让用户手动放行一次。把下面这段原样发给用户（或放进 Release 说明里）：

> ### 首次打开被系统拦截的处理办法
>
> 1. 正常双击 `Win-Box-<版本>-arm64.dmg`，把 `Win-Box` 图标**拖进「应用程序」文件夹**。
> 2. **不要双击启动**。打开「访达」→「应用程序」，找到 `Win-Box`，
>    在图标上**点右键（或按住 Control 点一下）→ 选「打开」**。
> 3. 弹出对话框问「……来自身份不明的开发者，您确定要打开吗？」→ 点**「打开」**。
> 4. 如果弹窗里没有「打开」按钮，或已经双击被拦过一次：
>    打开 **系统设置 → 隐私与安全性 → 安全性** 那一栏，
>    会看到一行「已阻止使用“Win-Box”，因为来自身份不明的开发者」，
>    右边点**「仍要打开」**，再输一次开机密码确认。
> 5. 之后就能正常双击启动了，**只需做一次**。

补充命令版（给不怕终端的用户，等价于上面第 4 步）：

```bash
xattr -cr /Applications/Win-Box.app
```

> 开发者自己也可以做 **ad-hoc 自签**（`codesign --sign - --deep --force Win-Box.app`），
> 它能让本机 `codesign --verify` 通过，但**不能**让 Gatekeeper 放行（没有可信根），
> 所以仍需用户走上面的「右键 → 打开」。

---

## 9. 常见失败排查表

| 现象 | 最可能的原因 | 处理 |
| --- | --- | --- |
| 「“Win-Box”已损坏，无法打开，您应该将它移到废纸篓」 | ① 未去隔离属性 ② 嵌套二进制未签名 | `xattr -cr /Applications/Win-Box.app`；按 5.3 递归重签 |
| 「无法打开“Win-Box”，因为无法验证开发者」 | 没签名 / 没公证 | 走第 8 节「右键 → 打开」 |
| 启动后立刻闪退、控制台显示 `SIGKILL` / `Code Signature Invalid` | Hardened Runtime 下 JIT / 未签名库被拒 | 确认授权文件含 `allow-jit` + `disable-library-validation`，并用 `--options runtime` 重签 |
| java / py 蜘蛛起不来，报 `dyld: Library not loaded` | 嵌套 dylib 未签或路径失效 | 按 5.3 第 ① 步签所有 `.dylib` |
| `codesign` 报 `code object is not signed at all` | 有嵌套项漏签（通常是 JRE 里新出现的） | `find "$APP/Contents" -type f -perm -u+x` 逐个补签 |
| 公证被拒：`The executable does not have the hardened runtime enabled` | 少了 `--options runtime` | 重签并加该参数 |
| 公证被拒：`The binary is not signed with a valid Developer ID certificate` | 用的是 Apple Development 证书而非 **Developer ID Application** | 换证书重签 |
| 公证被拒：`invalid nested binary` / `bundle format unrecognized` | 有文件被塞进了不该放的位置（如 `__pycache__`、日志、`hs_err_pid*.log`） | 清掉 `.app` 内的运行时垃圾后重新打包（`package.json` 的 `files` 已排除，多半是你手动拷进去的） |
| `Missing build/icon.icns` | 没生成图标 | `node scripts/make-icon.mjs` |
| `pnpm dist:mac` 在 Windows 上报平台错误 | dmg 只能在 macOS 上打 | 换 Mac |
| 更新器提示「未找到安装包」 | Release 资产命名不符合约定 | dmg 必须叫 `Win-Box-<版本>-arm64.dmg` / `Win-Box-<版本>-x64.dmg`（`upload-release.mjs` 只认这三个名字 + dmg/zip） |
| 播放器黑屏 / 只有声音没有画面 | mpv `--wid` 嵌入在 macOS 上可能不生效（未真机验证项 V1） | 终端启动并设 `WINBOX_MAC_MPV_EMBED=0 /Applications/Win-Box.app/Contents/MacOS/Win-Box` 强制降级到 HTML5 / 外部播放器 |
| 全屏后控制条错位 / 窗口边界回不来 | 透明窗 + 原生全屏（未真机验证项 V2） | 已知待验证项，暂用「退出全屏再重进」规避 |
| 关掉所有窗口后 Dock 图标还在 / 代理还在跑 | macOS 设计如此（未真机验证项 V3） | 用 `Cmd+Q` 完全退出 |
| 配置 / 数据找不到了 | macOS 上数据在 `~/Library/Application Support/Win-Box`（**不在 `.app` 里**，也不在安装包目录） | 用「访达 → 前往文件夹」粘贴该路径 |
| 签名后一运行就报签名失效 | 程序往 `.app` 内部写了文件（破坏了密封） | 属于代码缺陷，请提 Issue；临时办法是重新签名 |
| Xcode CLT 报 `xcode-select: error: tool 'notarytool' requires Xcode` | Xcode 版本过老 | `sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install`；或装 Xcode 15+ |
| 某个加固壳源报「该源依赖安卓原生库（.so），桌面版无法加载（架构限制，非移植缺陷）」 | **多半不是架构问题**：原生桥没生效（jar 缺失 / unidbg 运行时未下载 / dylib 被 Hardened Runtime 拦） | 搜日志里的 `native-bridge`：有「准备失败」看冒号后的异常；有「原生桥实现缺失」说明 jar 不在（见 §2.3 重建）；报 `Library not loaded` 则是 §5 的签名/授权问题 |
| `pnpm dist:mac` 报 `缺少 resources/jvm/native-bridge/native-bridge.jar` | jar 被误删（它已入库） | `git checkout -- resources/jvm/native-bridge/native-bridge.jar`，或按 §2.3 重建；确要出降级包加 `--allow-no-bridge` |
| 加固壳源（BiliGuard / 摸鱼 / fty / wex…）报 `加固壳内部蜘蛛未就绪（原生解密未产出加载器）—— 已自动改用内置真实实现` | **那句话的后半句是无条件写死的**（`translateSpiderLog` 里的硬编码文案），**不代表兜底真的成功了**。常见真因：本机没有该壳的真实实现（`shell-shim/real/<壳名>.jar` 不在），或 `stubs/shell-shim.jar` 缺失 | ① `node scripts/export-jvm-assets.mjs --doctor`；② 日志搜 `检测到壳 jar（guard=…）`——后面那个名字就是它要找的 jar 名；③ 搜 `未找到 shell-shim.jar` |
| jar 蜘蛛**全部**「不可用」，或日志报 `wrong version 61.0` | `resources/jvm/{stubs,libs,d2j,shell-shim}` 没从主开发机搬，或 JRE 缺失 | 按 **§2.4** 搬资产、按 **§2.5** 建 JRE；`--doctor` 会逐项点名并给出命令 |
| 某些源报 `UnsupportedCharsetException: gb2312`（表现为「蜘蛛静态初始化失败」） | 随包 JRE 是 jlink 裁剪产物、且**没打 `jdk.charsets`** | `--doctor` 的「模块」一行会直接点出来；按 **§2.5** 用 Zulu 17.0.13 重建 |

---

## 10. 需要真机验证的项（本次代码已留正确分支，但没在真机上跑过）

打完包请**逐项实际点一遍**，有问题就提 Issue 或改代码：

| # | 验证项 | 怎么验 | 出问题怎么办 |
| --- | --- | --- | --- |
| **V1** | **mpv `--wid` 能否嵌入 Electron 窗口**（最高风险） | 播一个普通视频，看播放器窗口里有没有画面 | 黑屏/无画面 → 环境变量 `WINBOX_MAC_MPV_EMBED=0` 强制降级（仅 HTML5 + 外部播放器）；确认长期不行就把默认值改 false |
| **V2** | 透明播放器窗 + macOS 原生全屏 | 进全屏 / 退出全屏，看控制条与窗口边界 | 见排查表 |
| **V3** | Dock 行为 | 关掉所有窗口后点 Dock 图标是否恢复；`Cmd+Q` 后图标是否消失 | 见排查表 |
| **V4** | 标题栏 mac 变体（左置红黄绿三点） | 每个窗口看一眼，尤其播放器窗的「小窗口 / 置顶」按钮位置 | 记下截图提 Issue |
| **V5** | 字体栈（4 套主题：apple / bilibili / douban / netflix） | 在 Retina 屏上看中文是否过细/字形不一致 | 调 `src/renderer/styles/*.css` 的 font-family 顺序 |
| **V6** | JVM / Python 蜘蛛 | 先跑 `node scripts/export-jvm-assets.mjs --doctor` 确认资产齐了（§2.4），再导入一个 jar 蜘蛛和一个 py 蜘蛛，看能不能出搜索结果 | 不可用时应走「该源不可用」的人话降级，不应崩溃；资产缺失按 `--doctor` 的提示补 |
| **V7** | Gatekeeper / 公证 | 用一台**从未装过**的干净 Mac 双击 dmg | 见第 7、8 节 |
| **V8** | `Cmd+W` / `Cmd+Q` / `Cmd+,` 快捷键 | 逐个按一遍 | `Cmd+,` 应跳到配置页 |
| **V9** | **原生桥（unidbg）真的能在 mac 上跑起来** | 导入一个含 `.so` 的加固壳源（摸鱼 / fty / wex），搜日志里的 `native-bridge`：出现「原生桥就绪」= 通；出现「准备失败」= 看异常 | 若是 `Library not loaded` / `code signature invalid` → Hardened Runtime 拦了未签名 dylib，按 §5 的 `disable-library-validation` 重签；若报「原生桥实现缺失」→ 见 §2.3 |
| **V10** | **加固壳源的 shell-shim 兜底**（与 V9 是两条独立的路） | 导入一个加固壳源（如 BiliGuard），日志搜 `检测到壳 jar（guard=…）` | 后面若跟着 `但无内置真实实现: …` = Mac 上缺这只壳的真实实现，把主开发机的 `shell-shim/real/` 搬过来（§2.4）；报 `未找到 shell-shim.jar` = `stubs/shell-shim.jar` 缺失（同一个包里有） |

---

## 11. 发布流程（打完包之后）

1. 在 GitHub 上**手动创建** Release，tag 名 = `release<版本号>`（与 Windows 共用同一个 Release）。
2. 上传附件（脚本只挑 `.exe` 与 `.dmg`，不会上传 blockmap 或构建元数据）：

   ```bash
   pnpm run release:upload -- --dry-run   # 先预览会上传哪些文件
   pnpm run release:upload                # 真正上传
   ```

3. **资产命名必须严格一致**，否则更新器挑不到：

   ```
   Win-Box Setup <版本>.exe        ← Windows（NSIS）
   Win-Box-<版本>-arm64.dmg        ← macOS Apple Silicon
   Win-Box-<版本>-x64.dmg          ← macOS Intel
   ```

4. 更新器在 macOS 上的行为：检测到新版本 → 代理加速下载 dmg → **自动打开 dmg**
   → 提示「请在访达中将 Win-Box 拖入「应用程序」文件夹覆盖安装」。
   **不做静默替换**（未接入 Sparkle），用户仍需手动拖一次。

> 上传脚本默认走本机 `127.0.0.1:7897` 代理；用 `GH_UPLOAD_PROXY=direct` 可强制直连。
> 详见 `README.md` 的「发布附件」一节。

---

## 12. 附：环境变量速查

| 变量 | 作用 |
| --- | --- |
| `WINBOX_ALLOW_PLACEHOLDER_ART` | ~~自用包放行占位图~~ **已废弃**（2026-10-15 合并上游 1.21.5 后，赞赏图/加群二维码功能整条删除，不再需要私有素材） |
| `WINBOX_MAC_MPV_EMBED=0` | **macOS 上强制关闭 mpv 窗口嵌入**，降级到 HTML5 / 外部播放器 |
| `GH_UPLOAD_PROXY` | Release 上传走哪个代理；`direct` / `none` = 直连 |
