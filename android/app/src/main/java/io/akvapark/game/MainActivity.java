package io.akvapark.game;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;

/**
 * Оболочка игры для Android.
 *
 * Игра — один html-файл. Приложение держит две его копии:
 *   assets/game/index.html  — та, что зашита в apk (первый запуск, всегда работает);
 *   files/live/index.html   — та, что скачана с сервера (свежая).
 * Показываем ту, у которой номер сборки больше. Скачиванием занимается Updater,
 * и подменяет он файл целиком и только после проверки — поэтому «половины
 * обновления» и белого экрана не бывает.
 */
public class MainActivity extends AppCompatActivity {

    public static final String PREFS = "akva";
    public static final String KEY_LIVE_BUILD = "live_build";
    private static final String DOMAIN = "appassets.androidplatform.net";

    private WebView web;
    private Updater updater;
    private long lastCheck = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideBars();

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.setBackgroundColor(0xFF04121C);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        final File liveDir = new File(getFilesDir(), "live");
        //noinspection ResultOfMethodCallIgnored
        liveDir.mkdirs();

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(DOMAIN)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/live/", new WebViewAssetLoader.InternalStoragePathHandler(this, liveDir))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                return true; // журнал игры наружу не тащим
            }
        });

        web.addJavascriptInterface(new Bridge(), "AkvaNative");

        updater = new Updater(this);
        web.loadUrl(currentGameUrl());
        checkForUpdate(1200);
    }

    /** Свежая скачанная копия, если она новее зашитой в apk. */
    private String currentGameUrl() {
        SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int live = p.getInt(KEY_LIVE_BUILD, 0);
        File f = new File(new File(getFilesDir(), "live"), "index.html");
        if (live > BuildConfig.GAME_BUILD && f.exists() && f.length() > 50000) {
            return "https://" + DOMAIN + "/live/index.html";
        }
        return "https://" + DOMAIN + "/assets/game/index.html";
    }

    private void checkForUpdate(long delayMs) {
        long now = System.currentTimeMillis();
        if (now - lastCheck < 30000) return;
        lastCheck = now;
        web.postDelayed(() -> updater.check(this::onUpdateReady), delayMs);
    }

    /** Обновление скачано и проверено — предлагаем игроку перезапуск. */
    private void onUpdateReady(final String version, final int build) {
        runOnUiThread(() -> {
            String js = "(function(){try{if(window.AkvaApp&&AkvaApp.nativeUpdateReady)"
                    + "AkvaApp.nativeUpdateReady(" + build + ",'" + version.replace("'", "") + "');}catch(e){}})()";
            web.evaluateJavascript(js, null);
        });
    }

    /** Мост «страница -> приложение». */
    private class Bridge {
        @JavascriptInterface
        public void restart() {
            runOnUiThread(() -> {
                web.clearCache(false);
                web.loadUrl(currentGameUrl());
            });
        }

        @JavascriptInterface
        public void checkUpdate() {
            lastCheck = 0;
            runOnUiThread(() -> checkForUpdate(0));
        }

        @JavascriptInterface
        public int installedBuild() {
            return Math.max(BuildConfig.GAME_BUILD,
                    getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_LIVE_BUILD, 0));
        }

        @JavascriptInterface
        public boolean isNative() { return true; }
    }

    private void hideBars() {
        WindowInsetsControllerCompat c =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    @Override
    public void onWindowFocusChanged(boolean has) {
        super.onWindowFocusChanged(has);
        if (has) hideBars();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideBars();
        if (web != null) { web.onResume(); web.resumeTimers(); }
        checkForUpdate(2500);
    }

    @Override
    protected void onPause() {
        if (web != null) { web.onPause(); web.pauseTimers(); }
        super.onPause();
    }

    /** «Назад» — это пауза в игре, а не выход из приложения. */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent e) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            web.evaluateJavascript(
                    "(function(){try{if(typeof G!=='undefined'&&G.mode==='play'){"
                  + "var b=document.getElementById('bMenu');"
                  + "if(b){b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));"
                  + "b.dispatchEvent(new MouseEvent('click',{bubbles:true}));}return 'paused';}}catch(e){}return 'exit';})()",
                    value -> {
                        if (value != null && value.contains("exit")) finish();
                    });
            return true;
        }
        return super.onKeyDown(keyCode, e);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
