package com.weasytalkie.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Servicio en primer plano.
 *
 * Sin esto, Android suspende la aplicacion a los pocos minutos de minimizarla y
 * se dejan de recibir mensajes. Un servicio en primer plano con notificacion
 * permanente es la unica forma admitida de seguir escuchando de forma indefinida.
 *
 * El tipo declarado es "microphone" porque la aplicacion sigue capturando y
 * reproduciendo voz mientras esta en segundo plano; a partir de Android 14 el
 * sistema exige declararlo y tener concedido el permiso de microfono.
 */
public class WalkieForegroundService extends Service {

    public static final String ACCION_INICIAR = "com.weasytalkie.app.INICIAR";
    public static final String ACCION_DETENER = "com.weasytalkie.app.DETENER";

    private static final String CANAL_ID = "weasytalkie_escuchando";
    private static final int NOTIFICACION_ID = 4721;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String accion = intent != null ? intent.getAction() : null;

        if (ACCION_DETENER.equals(accion)) {
            detener();
            return START_NOT_STICKY;
        }

        crearCanal();
        arrancarEnPrimerPlano();

        // Si el sistema mata el proceso por falta de memoria, que lo reinicie.
        return START_STICKY;
    }

    private void arrancarEnPrimerPlano() {
        Notification notificacion = construirNotificacion();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ obliga a indicar para que se usa el servicio.
            startForeground(NOTIFICACION_ID, notificacion,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICACION_ID, notificacion);
        }
    }

    private Notification construirNotificacion() {
        // Al tocar la notificacion se vuelve a la aplicacion.
        Intent abrir = new Intent(this, MainActivity.class);
        abrir.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent alTocar = PendingIntent.getActivity(this, 0, abrir, flags);

        return new NotificationCompat.Builder(this, CANAL_ID)
                .setContentTitle("WeasyTalkie está escuchando")
                .setContentText("Puedes recibir mensajes aunque la aplicación esté cerrada.")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(alTocar)
                .setOngoing(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    private void crearCanal() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationChannel canal = new NotificationChannel(
                CANAL_ID,
                "Escucha en segundo plano",
                // Importancia baja: notificacion permanente pero sin sonido ni aviso.
                NotificationManager.IMPORTANCE_LOW);
        canal.setDescription("Mantiene la aplicación activa para recibir mensajes de voz.");
        canal.setShowBadge(false);

        NotificationManager gestor = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (gestor != null) gestor.createNotificationChannel(canal);
    }

    private void detener() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;   // no hace falta enlazarse con el servicio
    }
}
