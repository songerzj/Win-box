# Win-box JVM 注意事项手册

> 面向作者本人（0 代码基础，纯 Vibe coding）。**命令尽量写成可直接复制执行**；
> 带 `<...>` 的是**占位符**（需替换成你的实际路径），带 ⚠ 的**请先读它前面的前提**。
>
> 适用范围：Win-box 里「让 Android 蜘蛛 jar 在桌面 JVM 上跑起来」的那整套东西 ——
> **随包 JRE**（`resources/jvm/jre`）与 **JVM 桩**（`resources/jvm/stubs-src` → `stubs.jar`）。
>
> 一句话结论：**源整个失灵时，先看日志里的「原始异常」，它几乎总能告诉你是 JRE 出问题还是桩出问题。**
>
> 相关文档（定位边界）：平台化改造看 `docs/architecture-macos.md`；JarRewriter 用法看
> `resources/jvm/tools/README.md`。**本手册只讲「注意事项 + 排查」，不重复它们的内容。**

---

## 0. 先读这五句

1. **随包 JRE 和 `stubs.jar` 都是「构建产物」，都不在 git 里**（`.gitignore` 排除）。
   仓库里只有「造它们的脚本」。**改了脚本/桩源码，不重建 = 没改。**
2. **JRE 的血统不能换**：必须是 **Zulu 17.0.13** 的 jmods。换成 Oracle 17.0.14+，所有用
   `AndroidKeyStore` 的源会**整体失效**（症状见 §1.4）。
3. **桩别「凭空」抛异常**：要么**照 Android SDK 语义**正常抛（真实现型桩，如 SQLite 系列），
   要么**静默降级**（返回 `null`/`false`）。无理由地抛会让蜘蛛整个崩 —— 详见 §2.3。
4. **出问题先区分「整个源全失灵」还是「只有某一个功能不正常」**——前者多半是 JRE，后者多半是缺桩。
   区分方法见 §4 排查清单。
5. **只改了桩源码、测试却跑的是旧 jar**：这是一个真实踩过的坑，务必看 §2.2。

---

## 1. 随包 JRE（`resources/jvm/jre`）

### 1.1 它是什么、从哪来

- 它是 **`jlink` 裁剪**出来的一个精简 Java 运行时，专门给蜘蛛 jar 用。
- **不进 git**（`.gitignore` 排除了 `resources/jvm/jre/`）。仓库里除构建脚本外**没有别的出处** ——
  也就是说，别人 clone 仓库后跑构建脚本才能得到它。
- 唯一的构建脚本：`scripts/build-jre.mjs`。**该文件开头约 60 行注释是本文档 A 部分的权威出处**，
  改 JRE 相关逻辑前请先完整读它。

### 1.2 ★ gb2312 事故（最容易误判成「源坏了」）

**症状**（真机日志，看起来像源的问题，其实是 JRE 的问题）：

```
jvm-bridge com.github.catvod.spider.Nmvod.homeContent 失败原因:
  蜘蛛静态初始化失败（内部依赖在桌面版缺失，请反馈此源）
  ｜原始: java.lang.ExceptionInInitializerError
          → java.nio.charset.UnsupportedCharsetException: gb2312
```

**根因**：早期手工 `jlink` 生成的 JRE **漏了 `jdk.charsets` 模块**。
蜘蛛在**静态初始化**阶段调用 `Charset.forName("gb2312")` 就炸了 →
整个类初始化失败 → **该源的所有方法**（首页 / 搜索 / 详情）**全部不可用**。

**为什么危险**：表现完全像「这个源挂了」，很容易被误判成源站问题。
影响面是一整批国内源（凡是站点用 GBK/GB2312 的，如「柠檬」「天天」等）。

**实测对照（同一台机）**：

| | gb2312 | big5 | gbk / gb18030 |
|---|---|---|---|
| 缺 `jdk.charsets` 的随包 JRE | ✗ | ✗ | 侥幸可用 |
| 系统 JDK 17 | ✓ | ✓ | ✓ |

**排查动作**：看到「静态初始化失败」，**别急着换源**，先跑一次字符集校验（见 §5 `--check`）。

### 1.3 字符集与区域数据的归属（为什么必须显式列出）

- `java.base` **只带标准字符集**：UTF-8 / ISO-8859-1 / US-ASCII / UTF-16 等。
- **GB2312 / GBK / GB18030 / Big5 在 `jdk.charsets` 模块里**，而它**不在 `java.se` 的传递依赖里**
  —— 所以 `jlink` 时**必须显式写进模块清单**，漏一个都不行。
- 还有 **`jdk.localedata`**：缺了它，`Locale` 只剩 **5 个**（打上它 **1017 个**），
  中文日期会退化成 `2026 Oct 13, Tue`。**源若按中文日期解析会直接失败**。
- **体积（2026-10-15 实测，别再引用早期那句「+22MB / +2MB」，那是错的）**：
  随包 JRE **46MB → 96MB（+50MB）**。试过 `jlink --include-locales=zh,en`，只降到 **76MB**
  （省 20MB），但 locale 数从 1017 掉到 124，且会让 `build-jre.mjs` 里 `verifyCharsets()` 的
  `MIN_LOCALES`（=500）守卫失去意义 ⇒ **决定不裁剪**。哪天真要压包体，两者必须一起改。
- ★ **2026-10-15 之前，随包那份 JRE 一直是漏的**：它的 `release` 里 `MODULES` 只有 25 个、既无
  `jdk.charsets` 也无 `jdk.localedata` —— 即「脚本早就写对了模块清单，但**没人按它重建过**」。
  这正是上面 §1.2 那个 gb2312 症状的现存原因。当天已用 Zulu 17.0.13 的 JDK 重建并校验通过
  （gb2312 / gbk / gb18030 / big5 ✓、Locale 1017 ✓、JCE provider ✓）。

> 记住这条因果链：**字符集只能在 `jlink` 阶段补齐**。运行时再想办法都补不上（见 §1.5）。

### 1.4 ★★ JCE 血统红线：必须用 Zulu 17.0.13 的 jmods

**不要用 Oracle 17.0.14+ 重建 JRE。** 这不是迷信，是一整轮对照实验换来的结论。

**症状**：

```
java.security.NoSuchProviderException: JCE cannot authenticate the provider AndroidKeyStore
Caused by: java.security.SecurityException: Cannot verify jar:file:/…/classes/!/
```

**机理**：17.0.14 起，JCE 会校验 provider 的 jar 签名。而桌面的 `AndroidKeyStore`
（`android.security.keystore.DesktopKeyStoreProvider`）是 **classpath 上的普通 class**，
**不在签名 jar 里** → 注册即失败 → **所有用到 `AndroidKeyStore` 的源全部失效**。

> ⚠ 本机 `PATH` 上的 `java` 目前正是 **17.0.14**。也就是说，**随手拿系统默认 JDK 去重建 JRE
> 就会踩这个坑** —— 必须显式指定 Zulu 17.0.13 的 jmods。

**给 provider 自己签名也没用**：JCE 要的是**信任链**，自签证书不在 JRE 的 `cacerts` 里，
报 `not signed by a trusted signer`。

**护栏**：脚本末尾的 `verifyJce()` 就是守这条红线的 —— 它会注册桌面 `AndroidKeyStore`
并**真的取一次 `KeyGenerator`**。换了血统它立刻报错，不会把坏 JRE 悄悄交付出去。

### 1.5 四条已验证死路（别再试一遍）

下面四条都被试过、都**不通**，记在这里省得重复踩：

| 做法 | 为什么不行 |
|---|---|
| classpath 上放 `META-INF/services/java.nio.spi.CharsetProvider` | JDK **不从 classpath 加载 `java.base` 的核心 SPI**。（同样写法对**自定义 SPI 有效**，对 `CharsetProvider` 无效） |
| `--patch-module java.base` | 无法给**已存在**的模块追加 `provides` 声明，SPI 依旧发现不到 |
| 运行时 `--module-path` 补 `jdk.charsets` | 撞 `Hash of jdk.charsets … differs to expected hash recorded in java.base` —— `jlink` 把模块哈希写死在 `java.base` 里，**只能在 `jlink` 阶段加** |
| 自签 provider jar | `not signed by a trusted signer`（见 §1.4） |

**结论**：字符集只能在 `jlink` 阶段补齐，且 JRE 血统必须保持 **Zulu 17.0.13**。

### 1.6 怎么用它（`scripts/build-jre.mjs`）

```bash
node scripts/build-jre.mjs                       # ★ 自动找 JDK 17 —— 见下方警告，别直接用来重建
node scripts/build-jre.mjs --jdk "<你的 Zulu 17.0.13 路径>"   # 显式指定（推荐）
node scripts/build-jre.mjs --out "<临时目录>"     # 先构建到别处验证，不动正式目录
node scripts/build-jre.mjs --check               # 只校验现有 JRE，不重建
```

> ⚠⚠ **「自动找 JDK 17」在本机是陷阱**：`pickJdk()` 会在 `C:/Program Files/Java` 里命中
> `jdk-17`，而本机那个目录是 **Oracle 17.0.14**（实测
> `"C:/Program Files/Java/jdk-17/bin/java" -version` = `17.0.14`）—— **正是 §1.4 明令禁止的血统**。
> 所以：
> - **重建** JRE 时必须**显式 `--jdk <Zulu 17.0.13 路径>`**，不要靠自动找；
> - ⚠ `--jdk` 若指向**不存在的目录**，脚本会**静默回退到自动找** → 又落到 17.0.14。
>   **务必先确认那个目录真的存在**；
> - `--check` **只校验、不重建**，可以放心跑。

硬性要求：

- **要的是 JDK，不是 JRE** —— `jlink` 与 `jmods` 只在 JDK 里。
- **大版本必须是 17**：`stubs.jar` 与 JRE 的 class 文件版本都是 **61**（Java 17），
  换别的版本会 `class file has wrong version`。
- `--check` 只做校验（字符集齐全 + Locale 数量 + JCE 可用），**不重建**。

---

## 2. JVM 桩（`resources/jvm/stubs-src/` → `resources/jvm/stubs/stubs.jar`）

### 2.1 桩是什么

桩 = **「Android SDK 的最小替身」**。蜘蛛 jar 是 Android-only 的，里面到处 `import android.*`；
桌面 JVM 没有这些类，于是我们写一批同名桩类，让 jar 能编译通过、加载起来、跑下去。

- 源码在 `resources/jvm/stubs-src/`（约 175 个文件，其中 173 个 `.java`）。
- 构建产物是 `resources/jvm/stubs/stubs.jar`（**不进 git**，`.gitignore` 排除）。
- 构建脚本：`resources/jvm/build-stubs.py`（为什么是 Python 版见 §2.6）。

### 2.2 ★ 改了桩源码，**必须重建才生效**

`stubs.jar` 是**构建产物**，被 `.gitignore` 排除。改了 `stubs-src/` 下的 `.java`，**不重建 = 没改**。

```bash
python resources/jvm/build-stubs.py resources/jvm
```

> ⚠⚠ **这个坑实际踩过**：**测试跑的是构建产物 `resources/jvm/stubs/stubs.jar`，
> 不是 `stubs-src`。** 改了源码却没重建，测试照样用旧 jar —— 于是「明明改了却还是老结果」。
> 改桩后**先重建，再跑测试**。
>
> ⚠ 另外：跑在 dev 里的应用，改完桩**记得重启应用**（进程已把旧 jar 加载进内存了）。

### 2.3 桩怎么处理失败：**不是**「永不抛异常」

先破除一个容易被传歪的说法：**「桩永远不抛异常」只对一部分桩成立，不是全部。**
`resources/jvm/stubs-src/android/` 下有 **66 处 `throw new`**（最典型是
`resources/jvm/stubs-src/android/database/sqlite/SQLiteDatabase.java` 等抛 `SQLiteException`）。桩其实分两类：

| 桩的类型 | 失败时怎么办 | 典型 |
|---|---|---|
| **容错 / 空壳型** | **静默降级**：返回 `null` / `false` / 空集合，让调用方自己降级 | `resources/jvm/stubs-src/android/graphics/Bitmap.java`、`resources/jvm/stubs-src/android/graphics/Paint.java`、`resources/jvm/stubs-src/android/content/SharedPreferences.java` |
| **真实现型**（功能真的要能用） | **照 Android SDK 语义正常抛** —— 抛异常 ≠ 桩写错了 | `resources/jvm/stubs-src/android/database/sqlite/SQLiteDatabase.java`、`resources/jvm/stubs-src/android/database/sqlite/SQLiteOpenHelper.java` |

> 「永不抛异常」**不是某个类独有的习惯，而是被作者显式声明为全局原则的共同取向**：
> `resources/jvm/stubs-src/android/content/SharedPreferences.java:76-77` 原文就写着
> 「**设计原则（与全部桩一致）** · **永不抛异常**：读不到/写不了只降级为『内存态』，
> 绝不能中断业务链」。同类表述还见于下面这些类（路径相对仓库根，行号为写作时现读核对）：
>
> - `resources/jvm/stubs-src/android/graphics/Bitmap.java:27`（「**任何情况下都不抛异常**」；另见 `:76`、`:203`）
> - `resources/jvm/stubs-src/android/graphics/Canvas.java:12`（「与 Bitmap/Paint 的『宽容降级』一致……**不能抛异常**」）
> - `resources/jvm/stubs-src/android/graphics/Paint.java:7`、`resources/jvm/stubs-src/android/graphics/drawable/StateListDrawable.java:7`
> - `resources/jvm/stubs-src/android/os/Parcel.java:14`、`resources/jvm/stubs-src/android/os/Binder.java:5`、`resources/jvm/stubs-src/android/view/Display.java:11`
> - `resources/jvm/stubs-src/android/widget/ArrayAdapter.java:11`、`resources/jvm/stubs-src/android/app/AlarmManager.java:6`
> - `resources/jvm/stubs-src/android/content/ContentResolver.java:8`（「不会抛异常打断蜘蛛主流程」）
> - `resources/jvm/stubs-src/android/net/http/SslError.java:9`、`resources/jvm/stubs-src/android/webkit/ConsoleMessage.java:8`、`resources/jvm/stubs-src/android/webkit/WebResourceError.java:8`（均「getter 不抛」）
> - `resources/jvm/stubs-src/com/github/catvod/crawler/SpiderApi.java:31`（「宁可返回空串也绝不抛异常」）
>
> **但它是「多数容错型桩的共同取向」，不是「全员绝对律」** —— SQLite 等真实现型桩照
> Android 语义抛。⚠ 两种误读都要避免：
> **说成「所有桩都不抛」** 会掩盖 SQLite 那类正确实现；
> **说成「只有 Bitmap 不抛」** 又会让读者漏掉上面这一批容错型桩。正确说法是「**多数容错型桩**」。

真正普适的规矩只有一条：**桩不要「凭空 / 无出处」地抛异常** ——
要么照 Android SDK 语义抛，要么静默降级。无理由的异常会让蜘蛛整个崩。

★★ **第二条铁律：产物会被拿去用的 API 必须「真实现」**，`RectF` / `Matrix` 这类数据类
**必须有真字段**。空壳（所有方法都 `return null`）会让调用方拿到零值，
出「看着没报错但结果诡异」的问题 —— 这比崩溃更难查。
（`Bitmap` 因为空壳踩过两次；`Color` 也是「空壳会让颜色恒为 0（黑）」。）

### 2.4 `NoSuchMethodError` 比 `ClassNotFoundException` 更隐蔽

- `ClassNotFoundException`：**整个桩类都不存在** —— 相对好定位。
- `NoSuchMethodError`：**类在、但方法签名对不上**（参数类型或返回类型不匹配）就抛，
  **编译期不报错**、运行到那一步才炸，非常隐蔽。

**规矩**：补桩时**必须照 Android SDK 对齐签名**，不能「差不多就行」。
类里注释反复出现的 `NoSuchFieldError` / `NoSuchMethodError` 都是在说这件事。

### 2.5 怎么查缺哪个桩：**扫常量池，不靠猜**

仓库里有两个脚本，**分工不同**：

| 脚本 | 干什么 |
|---|---|
| `resources/jvm/scan-stubs.py` | 扫描某个 jar 里引用到的 `android/*`、`androidx/*` 类，与 `stubs.jar` 里已有的类**对照**，标出 `MISSING`。**回答「缺哪个类」** |
| `resources/jvm/scan-calls.py` | 从 class 常量池里提取「**类.方法名 + 描述符**」。**回答「缺哪个方法签名」** |

用法（示例；`<某个jar>` 是**占位符**，换成你要扫的目标 jar —— 例如本仓库的 `resources/jvm/stubs/stubs.jar`）：

```bash
python resources/jvm/scan-stubs.py <某个jar>            # 默认只看 androidx
python resources/jvm/scan-stubs.py <某个jar> android    # 只看 android/*
python resources/jvm/scan-calls.py <某个jar> android/graphics/Canvas
```

> ✅ **`scan-stubs.py` 的路径问题已修复（2026-10-14）**：脚本改为**按自身位置推导**
> `stubs.jar`（`Path(__file__).resolve().parent / 'stubs' / 'stubs.jar'`），**不再写死任何
> 机器路径**，可直接跑。若你手上是**旧版本**（顶部 `STUBS` 硬编码成 `E:\...`）并报
> `FileNotFoundError`，把该常量改成 `<本仓库>/resources/jvm/stubs/stubs.jar` 即可。
> `scan-calls.py` 本就用命令行参数（`sys.argv`）、**无硬编码**，可直接跑。

> ⚠ **反射调用扫不到**：这两个脚本靠扫常量池/字符串段，而**反射是运行时按字符串找方法**，
> 扫不出来。如果常量池里没有、运行时却报缺方法，需要**单独反编译**确认。

### 2.6 构建脚本为什么是 Python 版

历史原因：早期的 **shell 版** `build-stubs.sh` 用 `find | while read; cygpath` **逐文件 fork**，
每个文件起一个 `cygpath` 子进程 → **本机跑不完就被超时杀掉**。
Python 版**全程在进程内完成**，只在最后调一次 `javac`。

> `stubs-src/build-stubs.sh` 与 `build-stubs.ps1` **仍在仓库里**（作为历史的/等价实现保留），
> 但**日常重建请用 `build-stubs.py`**（`jvmAssets.spec.ts` 会用到 `.ps1` 做重建保留性验证）。

### 2.7 打包机制（哪些东西进 jar）

- 源码：`stubs-src/` 下的全部 `.java` + `SpiderRunner.java`（+ 满足条件时的 `PythonRunner.java`）。
  **`stubs-src/shell-shim/` 子目录会被跳过**（由构建时另行处理）。
- 资源：`stubs-src/META-INF/**` 下的文件（**若存在**）会**一并打进 jar**。
  目的：让 SPI 声明（典型是 `META-INF/services/...`）在**仓库里有源码出处** ——
  因为 jar 被 gitignore，只改 jar 的话换台机器重建就丢了出处。
  > 现状说明：**当前 `stubs-src/` 下并没有 `META-INF/` 目录**，所以现在没有额外资源被打进去；
  > 这只是一条「给以后留口子」的机制。`build-stubs.sh` / `.ps1` 两个脚本**故意不打进 jar**。
- 基线保留：构建会**先解出现有 `stubs.jar` 的旧内容**再合并新编译的 class，
  所以历史类（如 `com.github.catvod.*`）不会丢；基线里的 `DexNative.class` 会被**剔除**。
  > ⚠ 注意：`stubs.jar` **不含** `DexNative.class` —— 它被编译进**另一个独立的 jar**：
  > `resources/jvm/stubs/shell-shim.jar`。出处：`resources/jvm/stubs-src/build-stubs.ps1:46`
  > 注释「it builds into shell-shim.jar separately」；佐证：`tests/jvmAssets.spec.ts` 断言
  > `stubs.jar` 的条目里**不含** `com/github/catvod/spider/DexNative.class`。

### 2.8 `-noverify` 与 JarRewriter 的取舍

蜘蛛 JVM 启动时带 `-noverify`（关掉**整个**字节码校验）。原因是 `dex2jar` 转换后的
`StackMapTable` 帧常不完整，桌面 HotSpot 会抛 `VerifyError: Expecting a stackmap frame at branch target N`。

| | `-noverify`（当前默认） | `JarRewriter`（备用工具） |
|---|---|---|
| 原理 | 让 JVM **不做校验** | 用 ASM **重算栈映射帧**，产物自洽 |
| 校验状态 | 全部关闭 | **正常开启** |
| 副作用 | JDK13+ 弃用警告（由代码里的 `stripJvmNoise` 过滤） | 无 |
| 能修的问题面 | 只覆盖「帧缺失」 | 还覆盖操作数栈类型不一致等 |

> 结论：`-noverify` 是**兜底**；真撞到校验错误、又不想关整个校验时，才用 `JarRewriter`
> （用法见 `resources/jvm/tools/README.md`，本手册不重写）。
> 补充：当前 `dex2jar` 版本对实测样本**已不产坏帧**，所以 JarRewriter 属**备用手段**。

### 2.9 字节码陷阱：`interface` / `class` 写错 **≠** 继承链断裂

桩写成 `interface` 还是 `class`，**由调用方字节码的调用指令决定**：

- 调用方用 **`invokeinterface`** → 桩必须是 **`interface`**
- 调用方用 **`invokevirtual`** → 桩必须是 **`class`**

⚠ **但两种「写错」的后果不同，别混为一谈：**

| 错误 | 后果 | 出处（源码注释） |
|---|---|---|
| `interface` / `class` **选错**（与调用指令不符） | **JVM 硬崩**：`-noverify` 下会按**错误的 vtable 槽位**派发。**注意：不是 `VerifyError`** | `resources/jvm/stubs-src/com/thegrizzlylabs/sardineandroid/Sardine.java:37-40` 注释（并记了「同类教训见 `ViewGroup$LayoutParams` 那次 JVM 硬崩」） |
| **继承 / 类型链断裂**（该继承的父类/父接口没继承） | **`VerifyError`** | `resources/jvm/stubs-src/android/widget/Button.java:14-16`（必须继承 `TextView`）、`resources/jvm/stubs-src/android/view/animation/Interpolator.java:11`（少父接口）、`resources/jvm/stubs-src/android/view/ViewManager.java:12`（向上转型） |

> 关键限定：**`VerifyError` 是字节码校验错误，只在「校验开启」时才会出现**。
> 运行器默认带 `-noverify`（§2.8）**恰恰是为了规避** dex2jar 产物的 `VerifyError`
> —— 换句话说，蜘蛛 jar 报 `VerifyError` 是「**没带 `-noverify`**」时的症状。因此：
> - **选错 `interface` / `class`**：报的**不是** `VerifyError`，而是 `-noverify` 下**按错误
>   vtable 槽位派发导致的 JVM 硬崩**（源码原文如此）；
> - **继承 / 类型链断裂**：报 `VerifyError` —— 但**得在校验开启的环境**里才看得到。
>
> 「校验开启」在仓库里的真实场景：**探针 / 单测**（`tests/jvmAtomicFile.spec.ts`、
> `tests/jvmKeyStore.spec.ts`、`tests/jvmAssets.spec.ts` 等）都是**直接 `java -cp …`（不带
> `-noverify`）**跑的，那才是 `VerifyError` 可能冒出来的地方。`resources/jvm/tools/README.md`
> 也把「逐类 `Class.forName`、**不加 `-noverify`**」的 `ProbeVerify` 列为探测 `VerifyError`
> 的标准手法（该脚本当前不在仓库里）。

### 2.10 临时验证手法（手工复现单个蜘蛛）

- 编译带中文注释的 Java：`javac` **必须带 `-encoding UTF-8`**。
- 跑 wex：需要 **`-noverify`**（与 `run-spider.sh`、`JarSpiderBridge` 一致，见 §2.8）。
  > ⚠「结尾调用 `Runtime.halt(n)`，否则进程挂住不退出」是**手工经验，未在仓库留档**；
  > `run-spider.sh` 里并没有这一句。仓库里唯一的 `Runtime.halt` 出现在
  > `scripts/build-jre.mjs` 的 JCE / 字符集探针里，用途与「跑 wex」无关。
- `-cp` 路径在 **MSYS / Git Bash** 下要当心**路径被改写**。这一点
  `resources/jvm/stubs-src/build-stubs.sh:9-13` 有明确记载：「MSYS 会把 `/c/...` 转成 `C:\...`，但会把 `@/tmp/files.txt` 里的
  POSIX 路径原样传过去导致『找不到文件』」；`run-spider.sh` 的做法是
  **统一用 `cygpath -w` 转成 Windows 风格路径**。
  ⇒ 手工拼 `-cp` 时，**照 `run-spider.sh` 用 `cygpath -w`**（或直接写 `C:/...` 形式）。
- 现成脚本：`resources/jvm/run-spider.sh <jar> <类名> <方法> [参数...]`
  —— 用与 `JarSpiderBridge` 一致的 classpath/参数复现调用，快速定位
  `NoSuchMethodError` / `NoSuchFieldError` / `ClassNotFoundException`。

---

## 3. 平台差异（JVM 相关）

> 只列 JVM 链路特有的差异。完整平台化设计在 `docs/architecture-macos.md`，此处不重复。

### 3.1 java 可执行文件候选

`src/main/util/paths.ts` 的 `javaCandidates()` / `src/engine/spider/JarSpiderBridge.ts` 的
`javaExeCandidates()` 按平台给候选（顺序 = 优先级）：

- **win32**：`jvm/jre/bin/java.exe`（单个候选）
- **darwin**：`jvm/jre/bin/java` **和** `jvm/jre/Contents/Home/bin/java`
  （macOS 的 JRE / `jlink` 镜像两种布局都有，都要认）

### 3.2 classpath 分隔符（★ 别改错）

- **真正传给 JVM 的 classpath**（`-cp` 等）用 `joinClasspath()`：**win32 `;` / 其余 `:`**。
  走的是 `JarSpiderBridge` 的 `cpJoin()`。
- **缓存 key / 配置键等「自造分隔符」一律保持 `;`**（代码里注释写着「缓存键，非 classpath，勿改」）。
  走的是 `JarSpiderBridge` 的 `keyJoin()`。
  **改成平台分隔符会让所有缓存 key 漂移**，且跨平台本来就没有意义。

### 3.3 日志文案

启动日志里那一行已从 `java.exe: OK/缺失` 改为 **`java: OK/缺失`**
（`src/main/index.ts`，用 `javaExeName()` 拼）。

---

## 4. 排查清单（★ 按症状索引，本手册最有价值的一节）

先看**日志里的「原始异常」**（`jvm-bridge … 失败原因: … ｜原始: …`），再对号入座：

| 症状 | 先看什么（根因） | 下一步动作 |
|---|---|---|
| **某个源的所有功能失效**，日志出现「蜘蛛静态初始化失败」 | stderr 原始异常的类型 | `UnsupportedCharsetException: gb2312` → JRE 缺字符集，跑 `node scripts/build-jre.mjs --check` 校验；`NoSuchProviderException … AndroidKeyStore` → **JRE 血统被换掉了**（见 §1.4），用 Zulu 17.0.13 重建 |
| **只有某一个方法报错**，其它功能正常 | 是不是缺桩方法（`NoSuchMethodError`） | 用 `scan-calls.py` 扫常量池补签名（见 §2.5） |
| `VerifyError` / `stackmap frame` | `dex2jar` 产物帧不完整，**或桩的继承/类型链断裂**（见 §2.9）。★ **仅在校验开启时出现**（即手工复现时**没带 `-noverify`**） | 运行时保持 `-noverify`（正是用它规避）；必要时用 `JarRewriter` 重算帧（见 §2.8） |
| `ClassNotFoundException` | 桩类**整体缺失**；手工复现时也可能是 `-cp` 在 MSYS 下被改写 | `scan-stubs.py` 查是否 `MISSING`（见 §2.5）；手工复现照 `run-spider.sh` 用 `cygpath -w`（见 §2.10） |
| **改了桩没反应** | 没重建 `stubs.jar`（或 dev 没重启） | `python resources/jvm/build-stubs.py resources/jvm` → 重启应用（见 §2.2） |
| 中文日期 / 月份变成英文（如 `2026 Oct 13, Tue`） | 缺 `jdk.localedata` | 重建 JRE 时确认模块清单含它（见 §1.3） |
| 某个源在别处好、在这里整个不可用 | 该源用到的 Android API 在桌面缺失 | 看原始异常是「类缺失」还是「方法缺失」，分别走 `scan-stubs.py` / `scan-calls.py` |

---

## 5. 常用命令速查表

```bash
# ① 重建 JVM 桩（★ 会覆盖构建产物 resources/jvm/stubs/stubs.jar；改了 stubs-src 后必做）
python resources/jvm/build-stubs.py resources/jvm

# ② 校验现有随包 JRE（字符集 + Locale + JCE）—— 只读、不重建，可放心跑
node scripts/build-jre.mjs --check

# ③ 重建随包 JRE（★ 必须显式指向 Zulu 17.0.13；写不存在的路径会静默回退 → 踩血统红线，见 §1.4/§1.6）
node scripts/build-jre.mjs --jdk "<你的 Zulu 17.0.13 路径>"

# ④ 扫「缺哪个桩类」（第二参数缺省只看 androidx；填 android 看 android/*）
python resources/jvm/scan-stubs.py resources/jvm/stubs/stubs.jar
python resources/jvm/scan-stubs.py resources/jvm/stubs/stubs.jar android

# ⑤ 扫「缺哪个桩方法」（类.方法名 + 描述符）
python resources/jvm/scan-calls.py resources/jvm/stubs/stubs.jar android/graphics/Canvas

# ⑥ 手工复现单个蜘蛛方法（定位 NoSuchMethod/Field/ClassNotFound）
bash resources/jvm/run-spider.sh <jar路径> <类名> <方法> [参数...]

# ⑦ 跑 JVM 相关单测（★ JAVA_HOME 指向任意 JDK 17 即可）
JAVA_HOME="C:/Program Files/Java/jdk-17" npx vitest run tests/jvmSpawnArgs.spec.ts
```

> 口径统一：`<...>` 是**占位符**（换成你的实际路径）。
> **②④⑤⑦ 直接可跑**（④⑤ 已用本仓库的 `resources/jvm/stubs/stubs.jar` 作实参）；
> **①** 可跑，但会**覆盖构建产物** `stubs.jar`；**③⑥** 需先填占位符（③ 见 §1.4 / §1.6 的红线警告）。

> ⚠⚠ **单测的 `JAVA_HOME` 必须是 JDK 17**。本机默认的 `JAVA_HOME` 指向 **jdk1.8**，
> 而 `stubs.jar` 的 class 文件版本是 **61**（Java 17）→ 会报 **`wrong version 61.0`**，
> 表现为 **4~5 个 `jvm*` 测试失败**。
> **这是环境问题，不是代码回归** —— 先确认 `JAVA_HOME` 再怀疑代码。
> （跑**测试**用任意 JDK 17 都行，包括本机的 `C:/Program Files/Java/jdk-17`（17.0.14）；
> §1.4 的血统红线**只针对「重建 JRE」**，与跑测试无关。）

---

## 6. 相关文件索引（都在仓库里，可直接打开）

| 路径 | 是什么 |
|---|---|
| `scripts/build-jre.mjs` | 重建随包 JRE；**文件头注释是 JRE 部分的权威出处** |
| `resources/jvm/build-stubs.py` | 重建 `stubs.jar` |
| `resources/jvm/stubs-src/` | 桩源码（改这里 → 必须重建） |
| `resources/jvm/stubs/stubs.jar` | 桩构建产物（**gitignore，测试跑的是它**） |
| `resources/jvm/stubs/shell-shim.jar` | 另一个构建产物：装被剔除的 `DexNative.class`（见 §2.7） |
| `resources/jvm/stubs-src/build-stubs.sh` / `build-stubs.ps1` | 历史的 / 等价构建脚本（保留在仓库） |
| `resources/jvm/scan-stubs.py` | 扫缺失的 `android/*` / `androidx/*` 类 |
| `resources/jvm/scan-calls.py` | 扫缺失的「类.方法名 + 描述符」 |
| `resources/jvm/run-spider.sh` | 手工复现单个蜘蛛方法 |
| `resources/jvm/tools/README.md` | JarRewriter 用法（重算栈帧、修 `VerifyError`） |
| `src/engine/spider/JarSpiderBridge.ts` | 桌面桥：classpath、`-noverify`、`javaExeCandidates()` |
| `src/main/util/paths.ts` | `javaCandidates()`（随包 JRE 的 java 候选） |
| `src/shared/platform.ts` | `javaExeName()` / `joinClasspath()` 等平台真源 |

---

## 7. 与上游合并时的固定取舍（★ 自 1.21.4 起）

> 上游 `yagami-hue/Win-box` 与本仓对**同一个问题**各自有解法。合并时按下面裁定，不必逐次重新纠结。

### 7.1 「wex 族读不到 SharedPreferences 里的 cookie」→ **本仓用自己的桩实现，不启用上游的影子 jar**

| | 上游（1.21.4 起） | 本仓 |
|---|---|---|
| 手法 | Node 现场生成替换类 `android/content/SharedPreferences$Mem`（`src/engine/spider/prefsShim.ts` + `scripts/gen-prefs-shim.mjs`），排在 `-cp` **最前**影子掉原桩 | 把 `resources/jvm/stubs-src/android/content/SharedPreferences.java` 写成**真实实现**（XML 落盘 + `shared_prefs/winbox-host-prefs.properties` 宿主默认值 + 按 mtime 裁定谁新），重建 `stubs.jar` |
| 数据来源 | `<沙箱>/shared_prefs/seed.txt`（`表名 \t 键 \t 值` 三段式） | 同一批键，写进 `winbox-host-prefs.properties`（`key=value` 每行） |
| 上游动因 | **上游机器没有 JDK** → 无法重建 `stubs.jar` | 本仓有 JDK（见 §5 ①） |
| 持久化 | 无（纯内存，读完种子就结束） | 有（**任意**表的 XML 都能落盘） |

**裁定 = 不把 `prefs-shim/winbox-prefs-shim.jar` 加进 classpath**（见 `JarSpiderBridge.classpathJars()`）。
原因：影子 jar 影子的是**整个 `$Mem` 类** ⇒ 一旦启用，**所有** SharedPreferences 表都会掉回纯内存，
本仓已有的落盘能力全丢（不只是 wex 那一张表）。

- jar 仍由 `scripts/build-main.mjs` 现场生成（无害，便于对照 / 将来切换），**只是不参与加载**。
- 上游的 `syncWexPrefsSeed()` **照旧写** `seed.txt`，与 properties 通道并存 → 将来要切到影子 jar 无需改业务代码。
- ⚠ 因此**新增的 wex 相关 prefs 键必须同时进两条通道**：`WEX_PREF_ENV` / `UCTV_PREF_KEYS` 在
  `driveCookieFiles.ts` 里已同时被两处使用（`syncWexHostPrefs` 与 `syncWexPrefsSeed`）。

### 7.2 「蜘蛛沙箱盘」（`subst` 建盘符 + 子进程 `cwd`）→ **已随上游删除，不要再加回来**

- 旧实现：`src/engine/util/jailDrive.ts`（用 `subst` 建 `V:\` → 数据目录），`JarSpiderBridge` 给 JVM
  子进程传 `cwd = 沙箱盘根`，目的是让第三方 jar 写的安卓绝对路径 `/data/…` 不落到盘根。
- 删除理由（上游 1.21.4，用户指令）：**不允许给用户系统建盘符**（资源管理器里凭空多一个盘符）。
  现在 `/data/…` 按 Windows 原语义解析到「当前盘根」；不碰系统的收容手段只剩
  `-Dtvbox.spiderCacheDir=<沙箱目录>`（把 `getCacheDir` / `getFilesDir` 收进数据目录）。
- 对应回归断言：`tests/jvmSpawnArgs.spec.ts` →「不再覆盖子进程 cwd（JVM 与 Python 均无 cwd 参数）」。

### 7.3 「赞赏图 / 加群二维码」→ **已随上游 1.21.5 整条删除，本仓的 `--allow-placeholder` 一并移除**

- 上游 1.21.5 删的是**一整条链**：`src/build/supportImage.ts`、`src/renderer/assets.d.ts`、
  两个占位 SVG、`tests/supportImage.spec.ts`、`vite.config.ts` 里的 `@author-support-image` /
  `@group-join-image` 别名、关于页的两个 `<dialog>` 弹窗；换成了新的
  「八、二次修改与再分发」（`src/renderer/lib/disclaimerText.ts` 的 `MODIFIED_BUILD_DISCLAIMER`）。
- **裁定 = 跟随上游删除**。理由：本仓为此加的 `--allow-placeholder` /
  `WINBOX_ALLOW_PLACEHOLDER_ART` / `WINBOX_SUPPORT_IMAGE` / `WINBOX_GROUP_IMAGE` 与
  「产物里含原图」的 SHA256 校验，全都只为一个**已不复存在的 UI** 服务；留着等于永久维护
  一套私有素材流水线。删掉后 **打包不再需要任何私有素材**，从零 clone 可直接出包。
- 连带处置：`scripts/build-release.mjs` 去掉 `pickImage`/`verifyPackaged`（保留 `--mac/--win`、
  `--dry-run`、`--allow-no-bridge`、原生桥校验、icns 校验、`LICENSE.txt` 兜底）；
  `docs/macos-build.md` 的两张表与 `README.md` 里的私有素材段落同步改掉 / 标注已废弃。
- ⚠ 与 7.2 不同的是：这条裁定**会改变用户可见行为**（关于页少两个按钮）。若将来上游又加回来，
  按本节反向恢复即可（占位图与校验逻辑在 git 历史 `c1d77d6` 里）。

### 7.4 合并 1.21.5 时两处**手工合成**（不是简单取一边）

1. **`src/renderer/components/VideoPlayer.tsx`**：上游整段重写（+1029/−665），本仓只改了
   6 处 mpv 可用性判定，但**全文件已归一成 LF**（上游那份是 100% CRLF）⇒ 直接合并必炸成全文件假 diff。
   做法 = **取上游内容 → 整文件转 LF → 重新贴回本仓那 6 处**（`mpvInfo?.available` → `mpvUsable`
   = `available && embeddable`，macOS 上 mpv 装得上但嵌不进窗口时必须退回 HTML5，见
   `src/shared/player.ts` 的 `MpvStatus.embeddable`）。
2. **`src/renderer/pages/DetailPage.tsx`**：分支顺序定为
   `有剧集 → 配置项(cfgHint) → 无资源`。上游把「无剧集 1.2s 后自动跳全源搜索」改成了
   **用户点「进入聚合搜索」**，故本仓原先挂在那个自动跳转上的守卫（`configCenterHintOf` 提前 return）
   与模块级 `AUTO_AGG_DONE` / `autoAggRef` 随之删除 —— 配置项现在走独立分支，压根到不了「无资源」那一支。
   收藏按钮（上游）在「有剧集」与「无资源」两支都渲染。

> ⚠ **合并 1.21.5 起，`docs/macos-build.md` 里已无「打包需要私有素材」这一步** ——
> 看到旧笔记提到 `--allow-placeholder` 一律按本节作废处理。

### 7.5 合并 1.21.8（插件系统 / 超分 / 选集抽屉）时的取舍

1. **`src/renderer/components/VideoPlayer.tsx` —— 同一套手法，第二次遇到（§7.4-1 的复现）**：
   上游该文件仍是 **100% CRLF**，本仓是纯 LF ⇒ 整文件冲突。做法一字不变 =
   **取上游内容 → 整文件转 LF → 重新贴回本仓补丁**。补丁内容仍是 **7 处 `mpvUsable`**
   （1 处定义 + 1 处 `setKernel` 入参 + 1 处依赖数组 + 1 处 `mpvAvailRef` + 3 处 `allowMpv &&` 判定）。
   ⚠️ **上游自己不会带 `mpvUsable`**（它没有 macOS 那个 `embeddable` 顾虑），所以「上游版里裸用
   `mpvInfo?.available` 的处数」就是需要替换的处数 —— 用 `grep -c` 对一下再动手，别凭记忆。
   ★ 脚本化时注意：替换函数必须作用在**累积的缓冲区**上（`buf[0] = buf[0].replace(...)`），
   若内部误引用原始文本，前面的替换会被静默重置（本次已踩，靠 assert 拦住）。
2. **`src/main/index.ts`**：import 区冲突 ⇒ **两侧 import 全部并存**（上游 `PluginHost` /
   `pluginsDir` / `builtinPluginsDir` / `clearWinboxCache` / `updateCacheReset` 与本地 macOS 的
   `installApplicationMenu` / `appRestart` / `platform`）。注意 `registerIpc(...)` 上游新增了
   第 6 个参数 `plugins: PluginHost`，必须跟着带上。
3. **`tests/mpvCore.spec.ts`**：import 区冲突 ⇒ 两侧并存（本地 `mpvVideoArgs`/`mpvWidArgs` +
   上游 `mpvShadersCmd`），按字母序插好即可。

#### ⚠️ 上游自带的测试缺陷（**别误判成本次合并的回归**）

`tests/pluginContract.spec.ts`（1.21.8 新增）里有一条「skill 示例 ↔ 宿主契约交叉校验」，
读 `../../.trae/skills/winbox-plugin/assets/example-super-resolution.plugin.json`。但：

- `git ls-tree -r upstream/main | grep '^\.trae/'` = **0 条** —— 上游 tree 里根本没有 `.trae/`；
- 上游自己的 `.gitignore` 里**就有 `.trae/`**（本仓同规则，来自初始提交 `953c8ac`）；
- 该测试**没有** `existsSync` / `skipIf` 守卫。

⇒ 结论：作者本地有 `.trae/`（Trae IDE 的 skill 目录）所以他不失败，但**任何纯净克隆跑全量测试
都必挂这一条**。这是上游缺陷，与本仓合并无关。**不要为了让它变绿去改上游测试**（会引入永久
本地分歧）；要处理就作为独立议题（给测试加缺失跳过守卫 / 把资产 `git add -f` 入库）另行决定。

#### ★ 合并后「本地改动零丢失」的正确校验手法

顺手记一条本次学到的：**不能拿 `git diff -w upstream/main -- <file>` 与
`git diff -w <merge-base> <ours> -- <file>` 比 md5** —— 上游若在同一区域有改动，auto-merge 后
本地那几行的**落点会平移**，hunk 头一变 md5 就不等（本次 11 个文件全部 md5 不等，但实际零丢失）。

✅ 正确做法 = 比 **「新增行集合」**：两侧各取 `git diff -w ... | grep '^+' | grep -v '^+++' | sort`
再比 md5 与行数。本次 11 个文件全部逐行一致（如 `ipc/index.ts` 74/74、`SpiderHost.ts` 96/96）。

### 7.6 合并 1.21.9（界面缩放 / 播放诊断 / 全屏修复）时的取舍

只有 **2 处冲突**，但两处都是「老朋友」：

1. **`src/renderer/components/VideoPlayer.tsx` —— 同一套手法，第三次（§7.4-1 / §7.5-1 的复现）**：
   上游该文件历史上是 CRLF、本仓纯 LF ⇒ 整文件冲突。做法一字不变 =
   **取上游内容 → 整文件转 LF → 重新贴回本仓补丁**。
   ⚠ **本轮（1.22.0）勘误**：上游在 1.21.9 就把该文件转成了纯 LF（见 §7.7-1 的 `cat-file` 实测），
   所以「CRLF 导致全文冲突」从 1.21.9 起不再成立；保留本节原文只为记录当时的判断。
   ⚠️ **补丁处数会随上游重构而变化**：1.21.8 时上游裸用 `mpvInfo?.available` 是 **7 行**，
   1.21.9 把 `toggleFull` 重构成窗口级全屏后降到 **5 行**。**动手前必须先 `grep -c` 对处数**
   （本次 5 行 = 2 处 `!!mpvInfo?.available` + 3 处裸用）。贴完应为 **7 处 `mpvUsable`**
   （定义 1 + 使用 5 + 依赖数组 1），裸 `mpvInfo?.available` 只剩**定义内部那 1 处**。
   ⚠️ 上游这次还改了 effect 依赖数组：`[allowMpv, mpvInfo, kernelPref, url]` → 必须改回
   `[allowMpv, mpvUsable, kernelPref, url]`（否则变成依赖整个 mpvInfo 对象）。
2. **`src/main/ipc/index.ts` —— import 区冲突，两侧并存**（本地 `restartApp` +
   上游 `noteMediaState` / `setUiScalePref, uiScaleState`）。同 §7.5-2 的 `index.ts` 同类冲突，
   「import 区两侧并存」已是稳定裁定；本次自动合并部分（`registerIpc` 内新增的
   `IPC.MEDIA_STATE` 监听与 `UI_GET_SCALE` / `UI_SET_SCALE` handler）无需人工干预。

#### 1.21.9 带来的三处**用户可见**变化（不是纯跟版本）

- **界面缩放**（新增 `src/shared/uiScale.ts` + `src/main/ui/uiScale.ts`）：按主显示器**工作区（DIP）**
  推倍率，用 `webContents.setZoomFactor` 整体放大（不用 CSS `zoom`，因为全项目尺寸是 px、
  且根元素缩放会让 `html{height:100%}` 的百分比高度算错）。
  ★ 四个 UI 窗口都要登记：`main/index.ts`、`PlayerWindow.ts`、`DetailWindow.ts`、`SearchWindow.ts`
  各一组 `registerUiWindow(...)` + `applyUiScale()`；`WebHomeWindow` 加载外部网页，**故意不登记**。
  ★ 本机实测：工作区 2560×1392 → auto 档 **125%**，主窗口 1280×800 → **1600×1000**。
  ★ 单测注意：`uiScale.ts` 惰性建 `JsonStore`，**不在模块导入期**碰 `app.getPath` ——
  否则任何 import 它的 spec 都得先补全 electron 的 `app` 桩（上游自己踩过）。
- **播放诊断**（新增 `src/main/util/mediaDiag.ts`）：渲染层上报 play/pause/waiting/stalled/emptied/
  `frame-stall`/`hls-fatal`/visibility，主进程缓存「最后一次播放状态」，在 `child-process-gone`
  （尤其 GPU 进程崩溃 = 用户症状「画面消失只剩声音」）时落盘带出「崩溃前在放哪一集、停在哪一帧」。
  ★ 换集时**必须**清掉 `requestVideoFrameCallback` + 定时器 + 监听，否则会对旧 `<video>` 继续误报
  （上游在 cleanup 里已处理）。
- **全屏改为窗口级**：播放器窗口（`allowMpv=true`）的 **HTML5 全屏** 从浏览器元素全屏
  （`requestFullscreen`）改成**主进程原生窗口全屏**，修「全屏自动换集后掉回小窗」
  （元素全屏在换集时组件被卸载 → 浏览器强制退出全屏）。
  ★ 与 §7.4 的 `mpvUsable` 补丁**互不相干，但同处一个文件**：替换时别把新引入的
  `nativeFs` / `lastPlayerFullstate` / `fullRef` 误伤（只有 `allowMpv` 参与 `nativeFs`，与 `mpvUsable` 无关）。

#### 平台维度（本次上游新增行）

**零命中**：`join(';')` / 写死 `.exe` / `process.platform` / `'darwin'` / `'win32'` 全无。
三个新文件都是平台无关的：`shared/uiScale.ts` 纯函数零依赖；`main/ui/uiScale.ts` 只用了
`screen.getPrimaryDisplay().workAreaSize` + `path.join`；`mediaDiag.ts` 不 import electron
（依赖方向只有 `main/ipc` → `mediaDiag`）。

#### 验证基线（1.21.9 合并后）

- `node scripts/build-main.mjs` ✅；`npx tsc --noEmit` **0 error**
- 全量测试：**181 文件 / 2244 用例 → 2238 passed / 5 skipped / 1 failed**
  （比 1.21.8 基线 +1 文件 / +14 passed，全部来自上游新增 `tests/uiScale.spec.ts`；
  那 1 failed 仍是 §7.5 记录的 `pluginContract.spec.ts` 上游缺陷）
- 实机冒烟：主进程 `ui-scale: 偏好=auto 工作区=2560x1392 → 125%（已应用 1 个窗口）`，
  外观页出现「界面缩放」档位，renderer 零 error。

### 7.7 合并 1.22.0（主题令牌化 / 插件 v2 / MPV 内核专属 UI / 内存优化）时的取舍

92 文件 / +16272 −3797，**6 处冲突**（本轮最多）。按处理成本排序：

1. **`VideoPlayer.tsx` —— 第四次复现同一手法（§7.4-1 / §7.5-1 / §7.6-1），但补丁形状变了**。
   本仓仍按「上游内容 + 本仓 `mpvUsable` 补丁」合成。
   ★★ **勘误（本轮实测，推翻 §7.4/§7.5/§7.6 的说法）**：「上游该文件 100% CRLF」**只在 1.21.8 及更早成立**。
   `git cat-file blob <rev>:src/renderer/components/VideoPlayer.tsx` 实测 CRLF 数：
   `fa34237`(1.21.8) = **3422** → `f0675ee`(1.21.9) = **0** → `6ac50a6`(1.22.0) = **0**。
   即上游在 1.21.9 就把该文件转成纯 LF 了。⇒ **1.22.0 的全文冲突不是行尾造成的，而是内容近乎重写**
   （`+708 / −93`，插件内核 + 能力面 + 引擎选择都在这一个文件里）。
   ⇒ 「取上游 → 转 LF」这步现在**仍可照做（幂等，无副作用）**，但**别再把 CRLF 当成冲突原因写进结论**。
   ★★ **本次的关键变化：上游把 `resolveKernel` 的第 3 参从布尔改成了对象**
   `resolveKernel(kernelPref, url, { mpvAvailable, engines: usableEngines })`，
   并且内核列表项也改成 `...(mpvInfo?.available ? [mpv 项] : [])` 的条件渲染。
   ⇒ **不能机械照抄上轮的新旧字符串**，必须按「处数 + 语义」逐处改写：
   - 裸 `mpvInfo?.available` 仍是 **6 处**（上轮 5 处），但其中 2 处要分别写成
     `mpvUsable`（内核列表项）与 `mpvAvailable: mpvUsable`（`resolveKernel` 调用）；
   - 贴完 `mpvUsable` 总数 = **7**（定义 1 + 使用 6），裸 `mpvInfo?.available` **只剩定义内 1 处**。
   - ⚠️ **写注释时别把 `mpvInfo?.available` 这四个字写进注释**，否则 `grep -c` 校验会多出 1 处
     （本轮踩过：注释里写「不要再裸用 `mpvInfo?.available`」→ 计数变 2）。
2. **`src/renderer/styles/netflix.css` —— 上游把 638 行结构样式搬进 global.css 令牌层**。
   上游新方案：皮肤文件只声明**令牌 + layout**，结构样式按宿主属性 `data-shell`
   （`topbar` / `dualbar` / `sidebar` / `pillbar`）在 `global.css` 里统一实现。
   本仓在 netflix.css 上唯一的本地改动是**字体栈加 `"PingFang SC"`**（macOS 中文字体，
   见 §7.4）—— 该行已不存在 ⇒ **等价迁移**到
   `global.css` 的 `:root[data-shell='topbar'] { --font-ui: ... }`（netflix = 单行顶栏 = topbar）。
   ★ 迁移后 topbar 与 dualbar / sidebar 的字体栈口径一致（后两者上游本来就带 PingFang SC）。
3. **`src/main/player/mpvCore.ts` —— 上游内联 `--wid` / `--input-ipc-server`，本仓必须留平台门控**。
   上游 1.22.0 顺手给 demuxer 缓存封顶（内存优化 A3）：
   `--demuxer-max-bytes=64MiB` + `--demuxer-max-back-bytes=16MiB`，插在
   `--msg-level=all=error` 之后、`--wid` 之前。
   本仓同一区域用的是 `...mpvWidArgs(o.wid, p, o.env)` / `...mpvIpcArgs(o.pipe, p)`
   （macOS 上 `embeddable=false` 时**不传 `--wid`**，退化为独立窗口而不是启动失败）。
   ⇒ 裁定 = **两个缓存参数保留 + 两个 spread 保留**；**绝不能回退成内联 `` `--wid=${o.wid}` ``**。
4. **`src/engine/spider/JarSpiderBridge.ts` —— 两侧并存**。本地是 macOS Python 适配
   （`pyExeCandidates` / `pyExePath` / `pySitePackages` / `pyEnvExtra` / `wheelVariant`，316 行本地增量），
   上游新增 `armPoolShrink()`（播放期收缩常驻池）。
   ★ 上游顺带把 `pyRuntimeReady` 的 doc 注释改成「**嵌入式** Python 运行时是否已落盘」——
   注释是上游新版，函数体保留本仓的 `pySitePackages` / `pyExeReady` 版本（代码零丢失）。
5. **`src/main/index.ts` —— import 区冲突，取上游（超集）**：只是给 `./util/paths`
   多解构一个 `distDir`（插件沙箱 worker 路径用）。`import { IPC }` 那行本仓与上游**已一致**。
6. **`tests/mpvCore.spec.ts` —— import 区两侧并存**（本地 `mpvVideoArgs` / `mpvWidArgs` / `withPlatform`
   + 上游 `mpvSubtitleTracks` / `mpvVideoParams` / `mpvDisplayStandard` / `normalizeSpdif` / `spdifLabel` / `SPDIF_OPTIONS`）。

#### ★★ 本轮新教训：本仓的「win32 零回归」快照测试，每次上游加参数都会红

`tests/mpvCore.spec.ts` 里那条 `buildMpvArgs 与改动前逐项逐序完全相同` 是**本仓自写**的红线断言
（防平台化重构改变 win32 输出），但它把参数数组**逐个字面量钉死** ——
上游只要新增一个参数就必失败（本轮红在新增的两个 demuxer 缓存参数）。
**这不是源码 bug，也不是断言写错**：红线是「本仓的平台化重构不改 win32 输出」，
不是「上游永远不许加功能」。⇒ 处理方式 = **把上游新增项按实现顺序补进期望数组**并注明来源，
**不要删掉这条断言**（它防的是另一类事故：有人调换 d3d11 三参顺序 / 把 `--hwdec` 挪到 `--vo` 之后）。

#### 平台维度（本次上游新增行）

按老规矩扫 `join(';')` / 写死 `.exe` / `process.platform` / `'darwin'` / `'win32'` / `APPDATA`：
**真实命中 0**，但有 3 处**看了才知道无害**的命中，记下来免得下次重复排查：

- `src/renderer/lib/theme.ts` 的 `.join(';')` = **CSS 内联声明拼接**，与 classpath 无关。
- `src/main/util/memProbe.ts` = **Windows 专属**实现（`wmic process ... /format:list`，缺失时回落
  PowerShell `Get-CimInstance Win32_Process`），且 `HELPER_NAMES` 写死 `wmic.exe/powershell.exe/...`。
  ★ 但 `sampleMemory()` 是 **永不抛**设计（每步 `withDeadline` 4s/6s + `try/catch`）⇒ macOS 上
  `wmic`/`powershell` 都不存在 ⇒ `children=[]`，只记 Electron 自身内存，**不会崩、也不会卡**。
  代价：macOS 上日志里 `children=0MB(0)`，**别据此判断「没有子进程」**（是采不到，不是没有）。
- 新的插件播放引擎链（`PlayerEngineController.ts` / `engineLines.ts`）**平台中立**：
  `spawn(exe, args, { windowsHide: true })`（`windowsHide` 在 darwin 是 no-op）、`proc.kill()` 跨平台。

#### 验证基线（1.22.0 合并后）

- `node scripts/build-main.mjs` ✅；`npx tsc --noEmit` **0 error**
- 全量测试：**193 文件 / 2524 用例 → 2514 passed / 5 skipped / 5 failed**
  （比 1.21.9 基线 +12 文件 = 上游新增的 12 个插件/danmaku 测试文件）
- ★ **5 条失败全部是 §7.5 记录的 `.trae/` 上游缺陷，且从 1 条涨到 5 条**：
  上游 `6260157` 把 skill 与规范加进主仓、`87d4b58` 又 revert 掉，但
  `pluginContract.spec.ts` 里读 `../../.trae/skills/winbox-plugin/assets/*` 的用例留了下来
  （而且新增了 4 条）。上游 `.gitignore` 忽略 `.trae/` ⇒ **任何纯净克隆必挂 5 条**。
  本仓裁定仍**不改**（改就引入永久分叉）⇒ **后续合并看到这 5 条失败属正常，不要去找回归**。
