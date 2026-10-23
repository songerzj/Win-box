package android.content;

import android.app.ActivityManager;
import android.app.AlarmManager;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.content.res.Resources;
import android.os.Looper;

import java.io.File;

/**
 * Context stub —— Android 应用上下文。
 *
 * 修复（二次）
 *   1) 此前 `getSystemService(String)` 直接 `return null`，混淆工具库拿到 null 后
 *      做 Kotlin 风格非空转换（`null cannot be cast to non-null type ...`）而崩溃。
 *      现在按名称返回**真实的桩实例**（ActivityManager/AlarmManager/...），
 *      未知服务也返回非 null 占位对象 ——「绝不返回 null」是本类的硬约束。
 *   2) 补齐目录/包信息/SharedPreferences 等常用入口。
 *
 * 设计原则：Context 是能力入口而非纯数据。凡"返回能力对象"的方法
 * （getSystemService / getPackageManager / getResources）都必须给非 null 对象。
 */
public class Context {

    // ---- 系统服务名常量（getSystemService 的参数） ----
    public static final String ACTIVITY_SERVICE = "activity";
    public static final String ALARM_SERVICE = "alarm";
    public static final String WINDOW_SERVICE = "window";
    public static final String LAYOUT_INFLATER_SERVICE = "layout_inflater";
    public static final String CONNECTIVITY_SERVICE = "connectivity";
    public static final String CLIPBOARD_SERVICE = "clipboard";
    public static final String NOTIFICATION_SERVICE = "notification";
    public static final String KEYGUARD_SERVICE = "keyguard";
    public static final String DOWNLOAD_SERVICE = "download";
    public static final String POWER_SERVICE = "power";
    public static final String TELEPHONY_SERVICE = "phone";
    public static final String AUDIO_SERVICE = "audio";
    public static final String STORAGE_SERVICE = "storage";
    public static final String WIFI_SERVICE = "wifi";

    public static final int MODE_PRIVATE = 0;
    public static final int MODE_WORLD_READABLE = 1;
    public static final int MODE_WORLD_WRITEABLE = 2;
    public static final int MODE_APPEND = 32768;
    public static final int MODE_MULTI_PROCESS = 4;

    /** 数据根目录 —— 桌面移植版无 Android 沙箱，用 tmpdir/tvbox-win */
    private static File BASE = new File(System.getProperty("java.io.tmpdir"), "tvbox-win");

    private static final PackageManager PM = new PackageManager();
    private static final ActivityManager AM = new ActivityManager();
    private static final AlarmManager ALARM = new AlarmManager();
    private static final ClipboardManager CLIPBOARD = new ClipboardManager();
    private static final Resources RES = new Resources();
    private static final ApplicationInfo APP_INFO = new ApplicationInfo();
    /** 网络族服务桩（调用方带 checkcast，必须是真实类型；见 getSystemService） */
    private static final android.net.wifi.WifiManager WIFI = new android.net.wifi.WifiManager();
    private static final android.net.ConnectivityManager CONNECTIVITY = new android.net.ConnectivityManager();
    /** Assets 句柄（壳通解）：壳 native 拿它做 AAssetManager_fromJava */
    private static final AssetManager ASSETS = new AssetManager();

    public Context() {
    }

    /** 当前蜘蛛/壳真实实现的加载器；不能固定返回运行时桩的应用加载器。 */
    private volatile ClassLoader classLoader;

    public void setClassLoader(ClassLoader loader) {
        this.classLoader = loader;
    }

    public Context getApplicationContext() {
        return this;
    }

    public Context getBaseContext() {
        return this;
    }

    public String getPackageName() {
        return "com.github.tvbox.osc";
    }

    public String getOpPackageName() {
        return getPackageName();
    }

    // ---------------- 目录 ----------------

    public File getFilesDir() {
        return ensure(new File(BASE, "files"));
    }

    public File getCacheDir() {
        return ensure(new File(BASE, "cache"));
    }

    public File getNoBackupFilesDir() {
        return ensure(new File(BASE, "no_backup"));
    }

    public File getCodeCacheDir() {
        return ensure(new File(BASE, "code_cache"));
    }

    public File getExternalFilesDir(String type) {
        return ensure(type == null ? new File(BASE, "external") : new File(new File(BASE, "external"), type));
    }

    public File getExternalCacheDir() {
        return ensure(new File(BASE, "external_cache"));
    }

    public File getDir(String name, int mode) {
        return ensure(new File(BASE, name == null ? "app" : name));
    }

    public File getDatabasePath(String name) {
        return new File(ensure(new File(BASE, "databases")), name);
    }

    public File getObbDir() {
        return ensure(new File(BASE, "obb"));
    }

    // ---------------- 资源 / 包 ----------------

    public Resources getResources() {
        return RES;
    }

    public AssetManager getAssets() {
        return ASSETS;
    }

    public PackageManager getPackageManager() {
        return PM;
    }

    public ApplicationInfo getApplicationInfo() {
        return APP_INFO;
    }

    public PackageInfo getPackageInfo(String packageName, int flags) {
        return new PackageInfo();
    }

    public ClassLoader getClassLoader() {
        ClassLoader loader = classLoader;
        if (loader == null) loader = Thread.currentThread().getContextClassLoader();
        return loader != null ? loader : Context.class.getClassLoader();
    }

    public String getString(int resId) {
        return "";
    }

    public String getString(int resId, Object... formatArgs) {
        return "";
    }

    public CharSequence getText(int resId) {
        return "";
    }

    public int checkCallingOrSelfPermission(String permission) {
        return PackageManager.PERMISSION_GRANTED;
    }

    public int checkPermission(String permission, int pid, int uid) {
        return PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 新增（壳类实测）：加固壳/混淆库会反射探测
     *   `Context.checkSelfPermission(String)int`（API 23+）来判断存储/网络权限；
     *   缺失时反射链拿不到 Method，部分实现会退化为「无权限」分支（表现为壳内准备失败）。
     *   桌面版无沙箱权限模型 → 一律 GRANTED（与 checkCallingOrSelfPermission 同口径）。
     */
    public int checkSelfPermission(String permission) {
        return PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 关键修复：按名称返回**非 null** 的服务桩实例。
     * 此前返回 null → 调用方做非空转换即崩（`null cannot be cast to non-null type`）。
     */
    public Object getSystemService(String name) {
        if (name == null) {
            return null;
        }
        switch (name) {
            case ACTIVITY_SERVICE:
                return AM;
            case ALARM_SERVICE:
                return ALARM;
            case CLIPBOARD_SERVICE:
                return CLIPBOARD;
            // 这两族必须返回**真实类型**的桩 —— 调用方普遍带 checkcast
            //   （实测 某第三方源仓的指纹/DNS 助手：`(WifiManager) getSystemService("wifi")`、
            //   `(ConnectivityManager) getSystemService("connectivity")`），返 Object 占位会 ClassCastException。
            case WIFI_SERVICE:
                return WIFI;
            case CONNECTIVITY_SERVICE:
                return CONNECTIVITY;
            default:
                // 未知服务：返回通用占位对象（绝不返回 null，避免调用方空转换崩溃）
                return new Object();
        }
    }

    public String getSystemServiceName(Class<?> serviceClass) {
        return null;
    }

    public SharedPreferences getSharedPreferences(String name, int mode) {
        return SharedPreferences.Mem.get(name == null ? "default" : name);
    }

    /**
     * 修复：瓜子（Appgz）等蜘蛛在 init 阶段调用 getContentResolver()
     *   做账号/数据库探测。缺失 → NoSuchMethodError 导致整源不可用。返回非 null 桩。
     */
    public ContentResolver getContentResolver() {
        return new ContentResolver();
    }

    public Looper getMainLooper() {
        return Looper.getMainLooper();
    }

    // ---------------- 组件启动（桌面版空实现） ----------------

    /**
     * ★ 2026-10-13 新增：源侧「重启 app」信令前缀。
     * 宿主 `JarSpiderBridge.extractBridgeNotes` 认得它 → 转成 Electron 的 app.relaunch()+quit()。
     * 格式固定为「前缀 + 空格 + 原因」，宿主按前缀匹配，不要改动前缀本身。
     */
    public static final String WINBOX_RESTART_MARK = "[winbox] app-restart-request";

    /**
     * ★★ 2026-10-13：「恢复配置后自动重启」在桌面端真正生效 ★★
     *
     * <p>桌面端没有 Activity 栈，绝大多数 {@code startActivity}（打开网页、拨号、跳应用）
     * 本就该被无声丢弃。**唯一例外是「重启 app」**：加固壳（wex）用
     * {@code getLaunchIntentForPackage()} + {@code startActivity()} + {@code killProcess()} 三步重启，
     * 而桌面端前两步此前分别是「签名不符抛 NoSuchMethodError」与「空实现」——
     * 用户侧现象就是「网页上写着『恢复后 app 会自动重启』，实际一动不动」。
     *
     * <p>现在：带 {@link PackageManager#WINBOX_LAUNCH_ACTION} 标记的 Intent 不再被丢弃，
     * 而是转成一条 **stderr 信令**交给宿主（stderr 是宿主逐行实时消费的既有通道，
     * 与 {@code [native-bridge]} / {@code [SpiderRunner]} 同款约定）。
     * 其余 startActivity 保持空实现。
     */
    public void startActivity(Intent intent) {
        if (intent != null && PackageManager.WINBOX_LAUNCH_ACTION.equals(intent.getAction())) {
            System.err.println(WINBOX_RESTART_MARK + " (源侧恢复配置后请求重启应用)");
        }
    }

    public void startActivity(Intent intent, android.os.Bundle options) {
    }

    public void startActivities(Intent[] intents) {
    }

    public void startService(Intent service) {
    }

    public boolean stopService(Intent service) {
        return false;
    }

    public boolean bindService(Intent service, ServiceConnection conn, int flags) {
        return false;
    }

    public void unbindService(ServiceConnection conn) {
    }

    public void sendBroadcast(Intent intent) {
    }

    public void sendBroadcast(Intent intent, String receiverPermission) {
    }

    public void sendOrderedBroadcast(Intent intent, String receiverPermission) {
    }

    public Intent registerReceiver(Object receiver, android.content.IntentFilter filter) {
        return null;
    }

    public void unregisterReceiver(Object receiver) {
    }

    public boolean isRestricted() {
        return false;
    }

    public void enforceCallingOrSelfPermission(String permission, String message) {
    }

    // ---------------- 内部 ----------------

    private static File ensure(File f) {
        if (f != null && !f.exists()) {
            //noinspection ResultOfMethodCallIgnored
            f.mkdirs();
        }
        return f;
    }

    /** 供宿主（SpiderRunner）设置数据根目录 */
    public static void setBaseDir(File dir) {
        if (dir != null) {
            BASE = dir;
        }
    }

    public static File getBaseDir() {
        return BASE;
    }
}
