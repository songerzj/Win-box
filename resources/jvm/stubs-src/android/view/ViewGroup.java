package android.view;

import android.content.Context;
import android.util.AttributeSet;

/**
 * ViewGroup stub —— 视图容器 + 布局参数。
 *
 * 修复：新增 `MarginLayoutParams`（此前缺失导致
 *   `ClassNotFoundException: android.view.ViewGroup$MarginLayoutParams`）。
 *   MarginLayoutParams 是 LinearLayout/RelativeLayout 等的 LayoutParams 基类，
 *   混淆工具库会 Class.forName 它。
 */
public class ViewGroup extends View implements ViewParent {

    public static final int FOCUS_BEFORE_DESCENDANTS = 0x20000;
    public static final int FOCUS_AFTER_DESCENDANTS = 0x40000;
    public static final int FOCUS_BLOCK_DESCENDANTS = 0x60000;
    public static final int PERSISTENT_NO_CACHE = 0;
    public static final int PERSISTENT_ANIMATION_CACHE = 1;
    public static final int PERSISTENT_SCROLLING_CACHE = 2;
    public static final int PERSISTENT_ALL_CACHES = 3;

    public ViewGroup(Context context) {
        super(context);
    }

    public ViewGroup(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public ViewGroup(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
    }

    public void addView(View child) {
    }

    public void addView(View child, int index) {
    }

    public void addView(View child, int width, int height) {
    }

    public void addView(View child, LayoutParams params) {
    }

    public void addView(View child, int index, LayoutParams params) {
    }

    public void removeView(View view) {
    }

    public void removeViewAt(int index) {
    }

    public void removeAllViews() {
    }

    public void removeAllViewsInLayout() {
    }

    public void removeViews(int start, int count) {
    }

    public View getChildAt(int index) {
        return null;
    }

    public int getChildCount() {
        return 0;
    }

    public int indexOfChild(View child) {
        return -1;
    }

    public void removeViewInLayout(View view) {
    }

    public void setClipChildren(boolean clipChildren) {
    }

    public void setClipToPadding(boolean clipToPadding) {
    }

    public void setDescendantFocusability(int focusability) {
    }

    public void setOnHierarchyChangeListener(OnHierarchyChangeListener listener) {
    }

    public void setLayoutTransition(android.animation.LayoutTransition transition) {
    }

    @Override
    public ViewParent getParent() {
        return null;
    }

    public boolean isLayoutRequested() {
        return false;
    }

    public void requestDisallowInterceptTouchEvent(boolean disallowIntercept) {
    }

    public void invalidateChild(View child, android.graphics.Rect dirty) {
    }

    public ViewParent invalidateChildInParent(int[] location, android.graphics.Rect dirty) {
        return null;
    }

    public boolean getChildVisibleRect(View child, android.graphics.Rect r, android.graphics.Point offset) {
        return false;
    }

    public void bringChildToFront(View child) {
    }

    public boolean showContextMenuForChild(View originalView) {
        return false;
    }

    public void createContextMenu(ContextMenu menu) {
    }

    public void focusableViewAvailable(View v) {
    }

    public boolean canResolveLayoutDirection() {
        return false;
    }

    public void requestChildFocus(View child, View focused) {
    }

    public void clearChildFocus(View child) {
    }

    public View focusSearch(View v, int direction) {
        return null;
    }

    public void childHasTransientStateChanged(View child, boolean hasTransientState) {
    }

    public void measureChild(View child, int parentWidthMeasureSpec, int parentHeightMeasureSpec) {
    }

    public void measureChildren(int widthMeasureSpec, int heightMeasureSpec) {
    }

    public void setPadding(int left, int top, int right, int bottom) {
        super.setPadding(left, top, right, bottom);
    }

    /** 层级变更监听 */
    public interface OnHierarchyChangeListener {
        void onChildViewAdded(View parent, View child);

        void onChildViewRemoved(View parent, View child);
    }

    /**
     * ★★★ 2026-10-12 必须在本类里**显式声明** LayoutParams（血的教训，别删）★★★
     *
     * 原因：View 里也有一个嵌套类 LayoutParams。若 ViewGroup 自己不声明，Java 的限定名
     * 解析会把 `android.view.ViewGroup.LayoutParams`（哪怕是全限定名！）**静默解析成
     * 从 View 继承来的 `android.view.View$LayoutParams`**。后果是整条继承线全塌：
     *   - ViewGroup$MarginLayoutParams   extends View$LayoutParams   （应为 ViewGroup$LayoutParams）
     *   - LinearLayout$LayoutParams      extends View$LayoutParams   （应为 MarginLayoutParams）
     *   - WindowManager$LayoutParams     extends View$LayoutParams   （应为 ViewGroup$LayoutParams）
     *   - ScrollView.addView(View,int,…) 签名变成 View$LayoutParams  （应为 ViewGroup$LayoutParams）
     *
     * 而 dex2jar 出来的蜘蛛字节码是按**真 Android** 签名编的，于是：
     *   `invokevirtual android/view/ViewGroup$MarginLayoutParams.setMargins(IIII)V`
     * 的接收者其实不是 MarginLayoutParams 子类。JVM 校验本该拦下（javac 会直接
     * 「不兼容的类型」编译错误），但应用为了跑 dex2jar 产物强制 `-Xverify:none`
     * （见 run-spider.sh 与 JarSpiderBridge）→ 未校验的虚调用按错误 vtable 槽位派发
     * → **类型混淆 → EXCEPTION_ACCESS_VIOLATION，整个蜘蛛 JVM 硬崩**。
     * 实证：wex 配置中心 `PanConfig.w` bci=86（配置项弹窗构建），崩溃日志
     * `hs_err_pid42108.log`。修复前 javac 连 TestLp.java 都编不过。
     *
     * 继承 View.LayoutParams 是为了不丢 width/height/MATCH_PARENT/WRAP_CONTENT
     * （它们在 View$LayoutParams 里），与真 Android 语义一致。
     */
    public static class LayoutParams extends View.LayoutParams {

        public static final int FILL_PARENT = -1;
        public static final int MATCH_PARENT = -1;
        public static final int WRAP_CONTENT = -2;

        public LayoutParams(int width, int height) {
            super(width, height);
        }

        public LayoutParams(Context c, AttributeSet attrs) {
            super(c, attrs);
        }

        public LayoutParams(LayoutParams source) {
            super(source);
        }

        @Override
        public String toString() {
            return "LayoutParams{w=" + width + ", h=" + height + "}";
        }
    }

    /**
     * 带边距的布局参数 —— 此前缺失，是本次 ClassNotFoundException 的直接原因。
     */
    public static class MarginLayoutParams extends LayoutParams {

        public int leftMargin;
        public int topMargin;
        public int rightMargin;
        public int bottomMargin;

        private int startMargin = UNDEFINED_MARGIN;
        private int endMargin = UNDEFINED_MARGIN;

        private static final int UNDEFINED_MARGIN = Integer.MIN_VALUE;

        public MarginLayoutParams(Context c, AttributeSet attrs) {
            super(c, attrs);
        }

        public MarginLayoutParams(int width, int height) {
            super(width, height);
        }

        public MarginLayoutParams(MarginLayoutParams source) {
            super(source);
            if (source != null) {
                this.leftMargin = source.leftMargin;
                this.topMargin = source.topMargin;
                this.rightMargin = source.rightMargin;
                this.bottomMargin = source.bottomMargin;
            }
        }

        public MarginLayoutParams(LayoutParams source) {
            super(source);
        }

        public void setMargins(int left, int top, int right, int bottom) {
            this.leftMargin = left;
            this.topMargin = top;
            this.rightMargin = right;
            this.bottomMargin = bottom;
        }

        public void setMarginStart(int start) {
            this.startMargin = start;
        }

        public int getMarginStart() {
            return startMargin;
        }

        public void setMarginEnd(int end) {
            this.endMargin = end;
        }

        public int getMarginEnd() {
            return endMargin;
        }

        public boolean isMarginRelative() {
            return startMargin != UNDEFINED_MARGIN || endMargin != UNDEFINED_MARGIN;
        }

        public void resolveLayoutDirection(int layoutDirection) {
        }

        @Override
        public String toString() {
            return "MarginLayoutParams{w=" + width + ", h=" + height
                    + ", l=" + leftMargin + ", t=" + topMargin
                    + ", r=" + rightMargin + ", b=" + bottomMargin + "}";
        }
    }
}
