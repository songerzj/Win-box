package android.widget;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ViewGroup;

/**
 * LinearLayout stub —— 消除 某第三方源后台线程加载 android.widget.LinearLayout 的
 * NoClassDefFoundError 噪声。继承既有 ViewGroup stub；方法默认返回。
 */
public class LinearLayout extends ViewGroup {

    public static final int HORIZONTAL = 0;
    public static final int VERTICAL = 1;

    public LinearLayout(Context context) { super(context); }
    public LinearLayout(Context context, AttributeSet attrs) { super(context, attrs); }

    public void setOrientation(int orientation) { }
    public int getOrientation() { return VERTICAL; }
    public void setGravity(int gravity) { }
    public int getGravity() { return 0; }
    public void setBaselineAligned(boolean baselineAligned) { }
    public boolean isBaselineAligned() { return true; }
    public void setWeightSum(float weightSum) { }
    public float getWeightSum() { return 0f; }
    public void setDividerSoundsEnabled(boolean enabled) { }

    /**
     * LayoutParams stub：与 Android SDK 契约一致。
     *
     * ★★★ 父类必须是 **ViewGroup$MarginLayoutParams**（不是 ViewGroup$LayoutParams）★★★
     * 真 Android 即如此。写错会让 `invokevirtual MarginLayoutParams.setMargins(...)`
     * 在 -Xverify:none 下按错误 vtable 槽位派发 → JVM 硬崩，详见
     * stubs-src/android/view/ViewGroup.java 里 LayoutParams 的注释。
     */
    public static class LayoutParams extends android.view.ViewGroup.MarginLayoutParams {
        public static final int WRAP_CONTENT = -2;
        public static final int MATCH_PARENT = -1;
        public float weight;
        public int gravity;

        public LayoutParams(int width, int height) { super(width, height); }
        public LayoutParams(int width, int height, float weight) { super(width, height); this.weight = weight; }
        public LayoutParams(android.content.Context c, android.util.AttributeSet attrs) { super(c, attrs); }
        public LayoutParams(android.view.ViewGroup.LayoutParams p) { super(p); }
        public LayoutParams(android.view.ViewGroup.MarginLayoutParams p) { super(p); }
    }
}