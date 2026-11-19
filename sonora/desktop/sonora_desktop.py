"""Sonora de escritorio: ventana nativa (Qt WebEngine) con el servidor integrado.

El servidor solo escucha en este equipo (127.0.0.1): no se comunica con otros dispositivos.
Al cerrar la ventana se apaga todo.
"""

import os
import socket
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("SONORA_PORT", "8765"))
SINGLE_INSTANCE_KEY = "sonora-desktop"


HOST = "127.0.0.1"


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((HOST, port))
            return True
        except OSError:
            return False


# Si el puerto de siempre está ocupado por otro programa, se usa uno libre.
if not _port_free(PORT):
    with socket.socket() as s:
        s.bind((HOST, 0))
        PORT = s.getsockname()[1]

sys.path.insert(0, str(ROOT / "backend"))

from PySide6.QtCore import QByteArray, QSettings, QUrl  # noqa: E402
from PySide6.QtGui import QColor, QIcon, QKeySequence, QShortcut  # noqa: E402
from PySide6.QtNetwork import QLocalServer, QLocalSocket  # noqa: E402
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineSettings  # noqa: E402
from PySide6.QtWebEngineWidgets import QWebEngineView  # noqa: E402
from PySide6.QtWidgets import QApplication, QMainWindow  # noqa: E402


def app_data_dir() -> Path:
    """Datos propios de la app (no la música): ~/Library/Application Support en macOS, XDG en Linux."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Sonora"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "sonora"


def start_server():
    import uvicorn
    import main

    config = uvicorn.Config(main.app, host=HOST, port=PORT, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    return server, thread


class Window(QMainWindow):
    def __init__(self, profile: QWebEngineProfile):
        super().__init__()
        self.setWindowTitle("Sonora")
        self.setMinimumSize(420, 560)
        self.settings = QSettings("Sonora", "Sonora")

        self.view = QWebEngineView(self)
        page = QWebEnginePage(profile, self.view)
        page.setBackgroundColor(QColor("#0b0b10"))
        page.titleChanged.connect(lambda t: self.setWindowTitle(t or "Sonora"))
        self.view.setPage(page)
        self.setCentralWidget(self.view)

        geometry = self.settings.value("geometry")
        if isinstance(geometry, QByteArray):
            self.restoreGeometry(geometry)
        else:
            self.resize(1280, 820)

        self.view.load(QUrl(f"http://127.0.0.1:{PORT}/#/home"))
        for keys in ("F5", "Ctrl+R"):
            QShortcut(QKeySequence(keys), self, activated=self.view.reload)

    def bring_to_front(self):
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def closeEvent(self, event):
        self.settings.setValue("geometry", self.saveGeometry())
        super().closeEvent(event)


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("Sonora")
    if sys.platform.startswith("linux"):
        app.setDesktopFileName("sonora")  # vincula la ventana con su icono del menú de aplicaciones
    app.setWindowIcon(QIcon(str(ROOT / "frontend" / "icons" / "icon-512.png")))

    # Una sola instancia: si ya está abierta, se trae al frente y esta termina.
    probe = QLocalSocket()
    probe.connectToServer(SINGLE_INSTANCE_KEY)
    if probe.waitForConnected(300):
        probe.write(b"show")
        probe.waitForBytesWritten(300)
        return 0
    QLocalServer.removeServer(SINGLE_INSTANCE_KEY)
    instance = QLocalServer()
    instance.listen(SINGLE_INSTANCE_KEY)

    server, thread = start_server()

    # Perfil propio y persistente: conserva cola, volumen y caché sin conexión entre sesiones.
    data_dir = app_data_dir() / "webengine"
    profile = QWebEngineProfile("sonora", app)
    profile.setPersistentStoragePath(str(data_dir))
    profile.setCachePath(str(data_dir / "cache"))
    profile.settings().setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)

    window = Window(profile)
    instance.newConnection.connect(lambda: (instance.nextPendingConnection(), window.bring_to_front()))
    window.show()

    code = app.exec()
    server.should_exit = True
    thread.join(timeout=5)
    return code


if __name__ == "__main__":
    sys.exit(main())
