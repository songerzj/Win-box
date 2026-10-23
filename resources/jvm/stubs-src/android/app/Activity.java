package android.app;

import android.content.ComponentName;
import android.view.Window;

/**
 * Activity stub —— 前台活动。
 *
 * 桌面 TVBox 无真实 Activity，但 某第三方源系蜘蛛的弹幕初始化（ProxyOrigin.getan）会先
 * InitOrigin.getActivity() 拿 Activity，再 Activity.getWindow().getDecorView() 查找视图。
 * 若 getWindow() 返回 null（历史实现），则 getDecorView() 直接 NPE。
 * 这里返回一个非 null 空 Window，让视图遍历安全地走到"无结果"分支。
 */
public class Activity extends android.content.Context {

    private final Window window = new Window();
    private final Application application = new Application();

    public Application getApplication() {
        return application;
    }

    public Activity() {
        super();
    }

    public void runOnUiThread(Runnable action) {
    }

    public void finish() {
    }

    public Window getWindow() {
        return window;
    }

    /**
     * InitOrigin.getActivity() 会调用 {@code activity.getComponentName().getClassName()}
     * 打日志。需返回非 null ComponentName（否则 .getClassName() NPE）。
     */
    public ComponentName getComponentName() {
        return new ComponentName("com.github.tvbox.osc", "com.github.tvbox.osc.Main");
    }

    /**
     * 
     * 盘搜/网盘族蜘蛛（实测 小米订阅 `csp_MiSou`）在 detailContent 的**类初始化**里调用
     * `Activity.requestPermissions(String[], int)`（写外部存储前向系统申请权限，API 23+）；
     * 桩里缺这个方法 → `NoSuchMethodError` → `ExceptionInInitializerError` → 详情整体失败
     * （现象：搜索结果能出来、点进去详情空/自动跳全源搜索）。
     * 桌面版无运行时权限模型（也不是 Activity）→ 空实现即可（等价于"已授权"）。
     */
    public void requestPermissions(String[] permissions, int requestCode) {
    }

    /**
     * ★★ 2026-10-13：「恢复配置后自动重启」链路修复（**链条上最靠前的断点**）★★
     *
     * <p>实证（wex 字节码 owner 扫描 + 运行期复现）：`InitOrigin.activity()` 第一行就是
     * <pre>
     *   Activity a = InitOrigin.get().d;
     *   if (a != null &amp;&amp; !a.isFinishing()) return a;   // ← 桩里没有 isFinishing()
     * </pre>
     * 缺它 → {@code NoSuchMethodError: 'boolean android.app.Activity.isFinishing()'} →
     * `InitOrigin.activity()` 直接抛；而 `x0.e.v0()`（重启 app）第二行就调它 →
     * <b>整条重启链在第一步就断了</b>（比 PackageManager 那两处更早）。
     * 现象：网页写着「恢复后 app 会自动重启」，实际连 startActivity 都到不了。
     *
     * <p>语义选择：桌面没有 Activity 栈，恒「未结束 / 未销毁」（false = 仍然可用）。
     * 若返回 true，`InitOrigin` 会判定当前 Activity 失效而去反射 `ActivityThread.mActivities`
     * 找新的 —— 桌面那个 Map 是空的 → 反而拿到 null，把 v0() 推进提前 return 分支。
     *
     * <p>同一批补齐的还有 {@link #isDestroyed()} 与 {@link #findViewById(int)}：
     * wex 分别引用 2 次 / 1 次（见 `tools` 扫描结论），属同一条 UI 适配链，
     * 缺任何一个都会以 NoSuchMethodError 的形式在恢复流程里炸掉。
     */
    public boolean isFinishing() {
        return false;
    }

    /** 桌面无 Activity 栈 → 永远「未销毁」。语义理由同 {@link #isFinishing()}。 */
    public boolean isDestroyed() {
        return false;
    }

    /** AOSP：找不到返回 null（调用方按 null 处理）。桌面无视图树 → 恒 null。 */
    public android.view.View findViewById(int id) {
        return null;
    }
}
