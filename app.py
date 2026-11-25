from email.message import Message
from io import BytesIO
from ipaddress import ip_address
import os
from threading import Lock

from flask import Flask, Response, jsonify, request

import server

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = server.HOSTED_IMAGE_BYTES
startup_lock = Lock()
database_ready = False


def initialize_database():
    global database_ready
    if database_ready:
        return
    with startup_lock:
        if not database_ready:
            if not server.DATABASE_URL:
                raise server.SetupError("Connect a PostgreSQL database to this Vercel project.")
            server.initialize()
            database_ready = True


class FunctionRequest(server.Handler):
    """Run the shared Roomcast HTTP routes without opening a local socket."""

    hosted = True

    def __init__(self, incoming):
        self.path = incoming.path
        self.command = incoming.method
        self.headers = Message()
        for key, value in incoming.headers.items():
            self.headers[key] = value

        self.scheme = incoming.scheme
        source = incoming.remote_addr
        if os.environ.get("VERCEL") == "1":
            if self.headers.get("X-Forwarded-Proto") == "https":
                self.scheme = "https"
            source = self.headers.get("X-Vercel-Forwarded-For") or source
        try:
            address = str(ip_address(source))
        except ValueError:
            address = "unknown"
        self.client_address = (address, 0)
        self.rfile = incoming.stream
        self.wfile = BytesIO()
        self.status = 500
        self.response_headers = []

    def send_response(self, code, message=None):
        self.status = code

    def send_header(self, keyword, value):
        if keyword.lower() != "connection":
            self.response_headers.append((keyword, value))

    def end_headers(self):
        pass


@app.route("/", defaults={"path": ""}, methods=["GET", "POST", "PUT"])
@app.route("/<path:path>", methods=["GET", "POST", "PUT"])
def route(path):
    if path.startswith("api/"):
        try:
            initialize_database()
        except server.SetupError as error:
            return jsonify(message=str(error)), 503, {"Cache-Control": "no-store"}
        except server.StorageError:
            app.logger.error("Roomcast could not initialize PostgreSQL.")
            return jsonify(message="Roomcast could not connect to its database."), 503, {"Cache-Control": "no-store"}

    handler = FunctionRequest(request)
    handler.dispatch("GET" if request.method == "HEAD" else request.method)
    return Response(handler.wfile.getvalue(), status=handler.status, headers=handler.response_headers)


@app.errorhandler(413)
def upload_too_large(_):
    return jsonify(message="The hosted board accepts up to 4 MB per image."), 413
