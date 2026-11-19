package app.sonora.player;

import android.os.Build;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SonoraPlugin.class);
        super.onCreate(savedInstanceState);

        // La música la produce el WebView. Por defecto, al dejar de verse (otra app delante) su proceso pierde
        // prioridad y Android lo cierra para liberar memoria: la canción se cortaba y la interfaz se reiniciaba.
        if (Build.VERSION.SDK_INT >= 26) {
            getBridge().getWebView().setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        // Si aun así se cierra, se vuelve a abrir la interfaz en lugar de dejar que se caiga toda la app.
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                recreate();
                return true;
            }
        });
    }
}
