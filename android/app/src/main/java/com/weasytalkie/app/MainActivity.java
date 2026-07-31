package com.weasytalkie.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Los plugins propios hay que registrarlos antes de que arranque el puente.
        registerPlugin(BackgroundModePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
