package dev.nischal.csreels;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

public class MainActivity extends BridgeActivity {

    // Ad / ad-tracking hosts (matched as suffixes).
    private static final String[] AD_HOSTS = {
        "doubleclick.net", "googlesyndication.com", "googleadservices.com",
        "adservice.google.com", "imasdk.googleapis.com", "google-analytics.com",
        "googletagservices.com", "googletagmanager.com"
    };
    // Ad endpoints on youtube.com itself.
    private static final String[] AD_PATHS = {
        "/pagead/", "/api/stats/ads", "/get_midroll_info", "/ptracking", "/youtubei/v1/log_event",
        "/api/stats/qoe"
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();

        // Reels should start playing with sound immediately, no tap needed.
        WebSettings s = webView.getSettings();
        s.setMediaPlaybackRequiresUserGesture(false);

        // 1) Strip ad slots from YouTube's player data inside the embedded player frames.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Set<String> origins = new HashSet<>();
            origins.add("https://www.youtube.com");
            origins.add("https://www.youtube-nocookie.com");
            WebViewCompat.addDocumentStartJavaScript(webView, readAsset("yt-adblock.js"), origins);
        }

        // 2) Block requests to ad servers.
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (isAd(request)) {
                    return new WebResourceResponse("text/plain", "utf-8", 204, "No Content", null,
                        new ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(view, request);
            }
        });
    }

    private static boolean isAd(WebResourceRequest request) {
        String host = request.getUrl().getHost();
        String path = request.getUrl().getPath();
        if (host == null) return false;
        for (String h : AD_HOSTS) {
            if (host.equals(h) || host.endsWith("." + h)) return true;
        }
        if (path != null && (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com"))) {
            for (String p : AD_PATHS) {
                if (path.startsWith(p)) return true;
            }
        }
        return false;
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            byte[] buf = new byte[in.available()];
            int n = in.read(buf);
            return new String(buf, 0, Math.max(n, 0), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }
}
