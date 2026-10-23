package android.content.pm;

import android.content.Intent;

/**
 * PackageManager stub —— 包信息查询入口。
 *
 * 桌面移植版无真实包管理：所有查询返回空信息对象（非 null），
 * 权限检查一律 GRANTED（桌面版无沙箱权限模型）。
 *
 * 修复：补 PERMISSION_GRANTED/DENIED 常量与更多 flag，
 *   避免混淆工具库/蜘蛛在权限检查处抛 NoSuchFieldError。
 */
public class PackageManager {

    public static final int GET_ACTIVITIES = 0x00000001;
    public static final int GET_META_DATA = 0x00000080;
    public static final int GET_SIGNATURES = 0x00000040;
    public static final int GET_CONFIGURATIONS = 0x00004000;
    public static final int GET_RECEIVERS = 0x00000002;
    public static final int GET_SERVICES = 0x00000004;
    public static final int GET_PROVIDERS = 0x00000008;
    public static final int GET_DISABLED_COMPONENTS = 0x00000200;
    public static final int GET_DISABLED_UNTIL_USED_COMPONENTS = 0x00008000;
    public static final int GET_UNINSTALLED_PACKAGES = 0x00002000;

    public static final int PERMISSION_GRANTED = 0;
    public static final int PERMISSION_DENIED = -1;

    public static final String FEATURE_TELEVISION = "android.hardware.type.television";
    public static final String FEATURE_LEANBACK = "android.software.leanback";
    public static final String FEATURE_TOUCHSCREEN = "android.hardware.touchscreen";

    public static class NameNotFoundException extends Exception {
        public NameNotFoundException() { super(); }
        public NameNotFoundException(String name) { super(name); }
    }

    public PackageInfo getPackageInfo(String packageName, int flags) throws NameNotFoundException {
        return new PackageInfo();
    }

    public ApplicationInfo getApplicationInfo(String packageName, int flags) throws NameNotFoundException {
        ApplicationInfo info = new ApplicationInfo();
        info.packageName = packageName;
        return info;
    }

    public String getInstallerPackageName(String packageName) { return null; }

    /**
     * 通解：某壳类源 / 某第三方源系 jar（sun.json 等）在 `Init.init(Context)` 里做宿主身份自校验——
     *   `b(Context)` 用内置（加密的）App 名白名单做 `,<label>,` 包含判定；返回空名会被判「疑似二次打包」并
     *   **提前 return**，连带 `saveConfig()`（写默认 `某壳类源/config.json`，豆瓣首页依赖它）一起被跳过 →
     *   表现为「豆瓣显示没法加载 / 该族功能整体降级」。
     *   名单（解密实测）含 `TVBox`（与本桩包名 com.github.tvbox.osc 配套），返回它即可放行整套初始化。
     */
    public CharSequence getApplicationLabel(ApplicationInfo info) { return "TVBox"; }

    /**
     * ★★ 2026-10-13：「重启 app」链路修复 —— 桌面端专用的 Intent action 标记 ★★
     *
     * <p>加固壳（wex）恢复配置后用三步重启 app（反编译 `x0.e.v0()` 实证）：
     * <pre>
     *   Intent i = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
     *   i.addFlags(335577088);          // NEW_TASK | CLEAR_TASK | CLEAR_TOP
     *   ctx.startActivity(i);           // 拉起主界面
     *   ctx.finish();                   // 关掉当前页
     *   Process.killProcess(Process.myPid()); System.exit(0);
     * </pre>
     * 桌面端没有 Activity 栈，本桩改为「发信令」：本方法返回的 Intent 打上该 action，
     * {@code Context.startActivity} 见到它就往 stderr 吐一条宿主可识别的重启请求
     * （见 {@code Context.WINBOX_RESTART_MARK}），由宿主转成真正的 Electron 重启。
     */
    public static final String WINBOX_LAUNCH_ACTION = "com.winbox.action.LAUNCH_APP";

    /**
     * ★★ 2026-10-13 修复（两处桌面缺陷，缺一都会「说重启却不重启」）★★
     *
     * <ol>
     *   <li><b>返回类型写错 → NoSuchMethodError</b>：此前签名是
     *       {@code ComponentName getLaunchIntentForPackage(String)}，而 AOSP 与 wex 字节码
     *       要的都是 {@code (Ljava/lang/String;)Landroid/content/Intent;} ——
     *       JVM 方法解析按「名字 + 描述符」，描述符不符即抛 {@code NoSuchMethodError}
     *       （且被 wex 自己的 try/catch 吞掉，用户侧只看到「什么都没发生」）。
     *       已全量扫描本机所有已转换 jar：**只有 wex 的 `x0.e` 调用本方法**，改签名无回归风险。</li>
     *   <li><b>返回 null → 调用方提前 return</b>：wex 是
     *       {@code if (app == null || (i = pm.getLaunchIntentForPackage(...)) == null) return;}
     *       ——null 会让它静默返回，连 startActivity 都到不了。现在返回带标记的非 null Intent。</li>
     * </ol>
     */
    public Intent getLaunchIntentForPackage(String packageName) {
        Intent i = new Intent(WINBOX_LAUNCH_ACTION);
        i.setPackage(packageName == null ? "com.github.tvbox.osc" : packageName);
        return i;
    }

    public int checkPermission(String permName, String pkgName) { return PERMISSION_GRANTED; }

    public boolean hasSystemFeature(String name) { return false; }

    public String[] getPackagesForUid(int uid) { return new String[0]; }

    /**
     * ★ 2026-10-13：wex 用到（内容提供者解析，`Owner 扫描`实测 1 处）。
     * 桌面端没有 ContentProvider 体系 → 恒 null（调用方按「无此 provider」处理）。
     */
    public ProviderInfo resolveContentProvider(String name, int flags) {
        return null;
    }
}
