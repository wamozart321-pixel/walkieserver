package com.weasytalkie.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Puente entre la web y el servicio en primer plano.
 *
 * Desde JavaScript:
 *     Capacitor.Plugins.BackgroundMode.start()
 *     Capacitor.Plugins.BackgroundMode.stop()
 */
@CapacitorPlugin(
    name = "BackgroundMode",
    permissions = {
        @Permission(alias = "notificaciones", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class BackgroundModePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // Android 13+ no muestra la notificacion del servicio sin este permiso,
        // y sin notificacion visible el sistema termina matando el servicio.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !tieneNotificaciones()) {
            requestPermissionForAlias("notificaciones", call, "trasPermisoNotificaciones");
            return;
        }

        arrancarServicio(call);
    }

    @PermissionCallback
    private void trasPermisoNotificaciones(PluginCall call) {
        // Aunque el usuario deniegue las notificaciones se intenta arrancar:
        // en versiones anteriores a Android 13 el servicio funciona igual.
        arrancarServicio(call);
    }

    private void arrancarServicio(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), WalkieForegroundService.class);
            intent.setAction(WalkieForegroundService.ACCION_INICIAR);
            ContextCompat.startForegroundService(getContext(), intent);

            JSObject resultado = new JSObject();
            resultado.put("activo", true);
            resultado.put("notificaciones", tieneNotificaciones());
            call.resolve(resultado);
        } catch (Exception e) {
            call.reject("No se pudo iniciar el servicio en segundo plano: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), WalkieForegroundService.class);
            intent.setAction(WalkieForegroundService.ACCION_DETENER);
            getContext().startService(intent);

            JSObject resultado = new JSObject();
            resultado.put("activo", false);
            call.resolve(resultado);
        } catch (Exception e) {
            call.reject("No se pudo detener el servicio: " + e.getMessage());
        }
    }

    private boolean tieneNotificaciones() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }
}
