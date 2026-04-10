from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas


OUT_FILE = "Presentacion_WeasyTalkie_Rubrica.pdf"


def draw_header(c, title, subtitle=None):
    width, height = landscape(A4)
    c.setFont("Helvetica-Bold", 24)
    c.drawString(1.5 * cm, height - 2.0 * cm, title)
    if subtitle:
        c.setFont("Helvetica", 13)
        c.drawString(1.5 * cm, height - 2.9 * cm, subtitle)
    c.line(1.5 * cm, height - 3.2 * cm, width - 1.5 * cm, height - 3.2 * cm)


def draw_bullets(c, items, start_y=None, line_gap=1.0):
    width, height = landscape(A4)
    y = start_y if start_y is not None else height - 4.3 * cm
    c.setFont("Helvetica", 14)
    for item in items:
        c.drawString(2.0 * cm, y, f"- {item}")
        y -= line_gap * cm


def draw_architecture_diagram(c):
    width, height = landscape(A4)
    # Boxes
    c.setFont("Helvetica-Bold", 12)
    c.rect(2 * cm, height - 11 * cm, 6 * cm, 3 * cm)
    c.drawString(2.3 * cm, height - 9.3 * cm, "Cliente Web / Movil")
    c.setFont("Helvetica", 11)
    c.drawString(2.3 * cm, height - 9.9 * cm, "PTT + UI + WebRTC")

    c.setFont("Helvetica-Bold", 12)
    c.rect(10 * cm, height - 11 * cm, 8 * cm, 3 * cm)
    c.drawString(10.3 * cm, height - 9.3 * cm, "Servidor Node.js + Socket.IO")
    c.setFont("Helvetica", 11)
    c.drawString(10.3 * cm, height - 9.9 * cm, "Auth, canales, señalizacion")

    c.setFont("Helvetica-Bold", 12)
    c.rect(20 * cm, height - 11 * cm, 7 * cm, 3 * cm)
    c.drawString(20.3 * cm, height - 9.3 * cm, "Persistencia local")
    c.setFont("Helvetica", 11)
    c.drawString(20.3 * cm, height - 9.9 * cm, "data/app-users.json")

    # Arrows
    c.setFont("Helvetica", 10)
    c.line(8 * cm, height - 9.5 * cm, 10 * cm, height - 9.5 * cm)
    c.drawString(8.2 * cm, height - 9.0 * cm, "WS")
    c.line(18 * cm, height - 9.5 * cm, 20 * cm, height - 9.5 * cm)
    c.drawString(18.2 * cm, height - 9.0 * cm, "JSON")

    c.setFont("Helvetica-Bold", 11)
    c.drawString(2.0 * cm, height - 12.3 * cm, "Audio en tiempo real: WebRTC P2P entre clientes")
    c.line(5.5 * cm, height - 13.2 * cm, 20.5 * cm, height - 13.2 * cm)
    c.drawString(11.0 * cm, height - 12.9 * cm, "RTP/Opus")


def add_slide(c, title, subtitle, bullets):
    draw_header(c, title, subtitle)
    draw_bullets(c, bullets)
    c.showPage()


def main():
    c = canvas.Canvas(OUT_FILE, pagesize=landscape(A4))

    add_slide(
        c,
        "WeasyTalkie - Presentacion del Proyecto",
        "Rubrica: Exposicion de Proyecto de Software",
        [
            "Problema: comunicacion de voz instantanea en equipos pequenos",
            "Solucion: app tipo walkie-talkie multi-plataforma",
            "Plataformas: Web, Android (Capacitor) y Desktop (Electron)",
            "Tecnologias: Node.js, Express, Socket.IO y WebRTC",
            "Objetivo de la demo: mostrar flujo completo sin cortes ni caidas",
        ],
    )

    add_slide(
        c,
        "1) Problema y Propuesta de Valor",
        "Innovacion e Impacto (10%)",
        [
            "Necesidad: coordinarse en tiempo real sin llamadas largas",
            "Usuario objetivo: equipos operativos, soporte y grupos comunitarios",
            "Valor: presionar-hablar-soltar, simple y de baja friccion",
            "Diferencial: canales + contacto selectivo + historial de voz",
            "Comparacion: mas liviano que videollamada para tareas rapidas",
        ],
    )

    # Architecture slide with custom diagram
    draw_header(c, "2) Arquitectura del Sistema", "Diseno y Arquitectura Tecnica (40%)")
    draw_bullets(
        c,
        [
            "Patron por capas: cliente, servidor de senalizacion y persistencia",
            "Responsabilidades separadas: UI, auth/canales, transporte de audio",
            "Socket.IO: eventos de negocio y senalizacion WebRTC",
            "WebRTC P2P: transporte de audio en vivo con baja latencia",
        ],
        start_y=landscape(A4)[1] - 4.3 * cm,
    )
    draw_architecture_diagram(c)
    c.showPage()

    add_slide(
        c,
        "3) Calidad de Codigo",
        "Calidad del codigo (10 pts)",
        [
            "Eventos de Socket.IO claramente nombrados por responsabilidad",
            "Funciones de validacion separadas en servidor",
            "Manejo de estado en Maps: usuarios, canales y autenticacion",
            "Separacion cliente/servidor y scripts de build por plataforma",
            "Mejora pendiente: extraer modulos y agregar linting formal en CI",
        ],
    )

    add_slide(
        c,
        "4) Modelo de Datos",
        "Modelo de datos (8 pts)",
        [
            "Persistencia actual: data/app-users.json (usuario -> clave)",
            "Estados en memoria: users, channels y authenticatedSockets",
            "Relacion clave: usuario pertenece a un canal activo",
            "Sin redundancia critica para alcance MVP",
            "Escalabilidad futura: migrar a Redis/PostgreSQL",
        ],
    )

    add_slide(
        c,
        "5) Seguridad y Manejo de Errores",
        "Seguridad y errores (7 pts)",
        [
            "Doble capa de acceso: admin y usuarios de app",
            "Validacion server-side de userId y password",
            "Mensajes de error controlados en auth y registro",
            "Fallback HTTPS -> HTTP segun certificados disponibles",
            "Mejora prioritaria: hash de claves + JWT + rate limiting",
        ],
    )

    add_slide(
        c,
        "6) Flujo Principal Operativo (Demo)",
        "Funcionalidad y Demo en Vivo (20%)",
        [
            "1. Login / registro de usuario y seleccion de canal",
            "2. Seleccion de contacto y preconexion WebRTC",
            "3. PTT: presionar habla en tiempo real, soltar finaliza",
            "4. Historial de audio para reproducir mensajes previos",
            "5. Manejo de desconexion/reconexion y estado en interfaz",
        ],
    )

    add_slide(
        c,
        "7) Rendimiento Observable",
        "Rendimiento y casos borde (10 pts)",
        [
            "Audio en vivo movido a WebRTC para evitar cortes por chunking",
            "RTT visible en cliente para monitorear red en demo",
            "Canal de senalizacion por WebSocket (sin polling)",
            "Casos borde: desconexion, credenciales invalidas, usuario duplicado",
            "Mejora pendiente: pruebas de carga y metricas automatizadas",
        ],
    )

    add_slide(
        c,
        "8) Pruebas y Estrategia de Testing",
        "Pruebas (5 pts)",
        [
            "Pruebas manuales funcionales en Web, Android y Desktop",
            "Evidencia: iteraciones de audio y estabilizacion WebRTC",
            "Pendiente: unit tests en validaciones y flujo de eventos",
            "Pendiente: integracion para auth + join-channel + audio",
            "Pendiente: reporte de cobertura en pipeline CI",
        ],
    )

    add_slide(
        c,
        "9) Proceso y Metodologia",
        "Proceso y metodologia (10%)",
        [
            "Control de versiones con commits incrementales en Git",
            "Historial coherente: auth, UI, audio en vivo, multiplataforma",
            "Sprints cortos orientados a resolver bloqueos tecnicos",
            "Documentacion recomendada: README tecnico + roadmap",
            "Siguiente paso: tablero de backlog visible (Kanban)",
        ],
    )

    add_slide(
        c,
        "10) Tecnologias Modernas Usadas",
        "Innovacion e Impacto (10%)",
        [
            "WebRTC: audio en tiempo real de baja latencia",
            "Socket.IO: senalizacion y mensajeria de control",
            "Capacitor: empaquetado Android desde base web",
            "Electron: empaquetado desktop para Windows",
            "Ventaja: una base de codigo para tres plataformas",
        ],
    )

    add_slide(
        c,
        "11) Limitaciones Actuales y Mejoras Futuras",
        "Escalabilidad y roadmap tecnico",
        [
            "Persistencia local de usuarios debe migrar a DB robusta",
            "Seguridad: incorporar JWT, hash de claves y auditoria",
            "Escalado: Redis para estado distribuido de canales",
            "Observabilidad: logs estructurados y dashboard de metricas",
            "QA: suite automatizada + pruebas de red degradada",
        ],
    )

    add_slide(
        c,
        "12) Guion Sugerido para Exposicion",
        "Presentacion y comunicacion (20%)",
        [
            "0-1 min: problema, publico objetivo y propuesta de valor",
            "1-3 min: arquitectura y decisiones clave",
            "3-6 min: demo del flujo completo en vivo",
            "6-7 min: limitaciones, mejoras y lecciones aprendidas",
            "Cierre: impacto esperado y plan de evolucion",
        ],
    )

    add_slide(
        c,
        "13) Checklist de Rubrica (Antes de Exponer)",
        "Control rapido de cumplimiento",
        [
            "Mostrar diagrama de arquitectura y flujo principal",
            "Hacer demo sin leer diapositivas (lenguaje tecnico claro)",
            "Mostrar commits y explicar 2 decisiones tecnicas fuertes",
            "Reconocer limites actuales con plan concreto de mejora",
            "Cerrar con impacto y ventajas frente a alternativas",
        ],
    )

    c.save()
    print(f"PDF generado: {OUT_FILE}")


if __name__ == "__main__":
    main()
