package io.akvapark.game;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Скачивает новую версию игры с сервера.
 *
 * Порядок жёсткий, чтобы не оставить игрока с битым файлом:
 *   1. читаем маленький version.json;
 *   2. если номер сборки не больше нашего — выходим, трафик не тратим;
 *   3. качаем index.html во временный файл;
 *   4. проверяем: html целый, номер сборки внутри совпадает с обещанным;
 *   5. только теперь переименовываем во что грузит приложение.
 * Оборвалась сеть на шаге 3-4 — временный файл выбрасывается, игра остаётся прежней.
 */
class Updater {

    interface Ready { void onReady(String version, int build); }

    private static final int TIMEOUT = 15000;
    private static final int MAX_HTML = 24 * 1024 * 1024;

    private final Context ctx;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private volatile boolean busy = false;

    Updater(Context c) { this.ctx = c.getApplicationContext(); }

    void check(final Ready cb) {
        if (busy) return;
        busy = true;
        pool.execute(() -> {
            try { run(cb); }
            catch (Throwable ignored) { /* нет сети — просто играем дальше */ }
            finally { busy = false; }
        });
    }

    private void run(Ready cb) throws Exception {
        SharedPreferences p = ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        int have = Math.max(BuildConfig.GAME_BUILD, p.getInt(MainActivity.KEY_LIVE_BUILD, 0));

        String meta = get(BuildConfig.UPDATE_BASE + "version.json?ts=" + System.currentTimeMillis());
        if (meta == null) return;

        int build = intField(meta, "build");
        String version = strField(meta, "version");
        if (build <= have) return;

        File dir = new File(ctx.getFilesDir(), "live");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File tmp = new File(dir, "index.html.part");
        File dst = new File(dir, "index.html");

        if (!download(BuildConfig.UPDATE_BASE + "index.html?ts=" + System.currentTimeMillis(), tmp)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return;
        }

        String head = readTail(tmp);
        int inFile = buildInHtml(tmp);
        if (tmp.length() < 50000 || !head.contains("</html>") || inFile != build) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return;                       // сервер отдал не то — молча остаёмся на старой
        }

        //noinspection ResultOfMethodCallIgnored
        dst.delete();
        if (!tmp.renameTo(dst)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return;
        }

        // version.json рядом — чтобы страница внутри приложения видела свою же версию
        write(new File(dir, "version.json"), meta);

        p.edit().putInt(MainActivity.KEY_LIVE_BUILD, build).apply();
        if (cb != null) cb.onReady(version == null ? String.valueOf(build) : version, build);
    }

    /* ---------- сеть ---------- */

    private HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(TIMEOUT);
        c.setReadTimeout(TIMEOUT);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("Accept-Encoding", "gzip");
        c.setRequestProperty("User-Agent", "AkvaparkApp/" + BuildConfig.GAME_BUILD);
        return c;
    }

    private String get(String url) {
        HttpURLConnection c = null;
        try {
            c = open(url);
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = stream(c)) {
                byte[] buf = new byte[8192];
                StringBuilder sb = new StringBuilder();
                int n, total = 0;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > 262144) return null;
                    sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                }
                return sb.toString();
            }
        } catch (Throwable t) {
            return null;
        } finally { if (c != null) c.disconnect(); }
    }

    private boolean download(String url, File to) {
        HttpURLConnection c = null;
        try {
            c = open(url);
            if (c.getResponseCode() != 200) return false;
            try (InputStream in = stream(c); FileOutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[32768];
                int n; long total = 0;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > MAX_HTML) return false;
                    out.write(buf, 0, n);
                }
                out.getFD().sync();
            }
            return true;
        } catch (Throwable t) {
            return false;
        } finally { if (c != null) c.disconnect(); }
    }

    private InputStream stream(HttpURLConnection c) throws Exception {
        InputStream in = c.getInputStream();
        String enc = c.getContentEncoding();
        return (enc != null && enc.toLowerCase().contains("gzip"))
                ? new java.util.zip.GZIPInputStream(in) : in;
    }

    /* ---------- мелочи ---------- */

    private void write(File f, String text) {
        try (FileOutputStream o = new FileOutputStream(f)) {
            o.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable ignored) {}
    }

    /** последние 4 КБ — там закрывающий тег */
    private String readTail(File f) {
        try (java.io.RandomAccessFile r = new java.io.RandomAccessFile(f, "r")) {
            long len = r.length();
            int take = (int) Math.min(4096, len);
            r.seek(len - take);
            byte[] b = new byte[take];
            r.readFully(b);
            return new String(b, StandardCharsets.UTF_8);
        } catch (Throwable t) { return ""; }
    }

    /** номер сборки, зашитый в саму страницу */
    private int buildInHtml(File f) {
        try (java.io.RandomAccessFile r = new java.io.RandomAccessFile(f, "r")) {
            long len = r.length();
            int take = (int) Math.min(65536, len);
            r.seek(len - take);
            byte[] b = new byte[take];
            r.readFully(b);
            Matcher m = Pattern.compile("const AKVA_BUILD = (\\d+);")
                    .matcher(new String(b, StandardCharsets.UTF_8));
            return m.find() ? Integer.parseInt(m.group(1)) : -1;
        } catch (Throwable t) { return -1; }
    }

    private int intField(String json, String key) {
        Matcher m = Pattern.compile("\"" + key + "\"\\s*:\\s*(\\d+)").matcher(json);
        return m.find() ? Integer.parseInt(m.group(1)) : -1;
    }

    private String strField(String json, String key) {
        Matcher m = Pattern.compile("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
        return m.find() ? m.group(1) : null;
    }
}
