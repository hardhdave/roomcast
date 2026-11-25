import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import webbrowser
from contextlib import contextmanager
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATABASE = Path(os.environ.get("BOARD_DATABASE", ROOT / "data" / "board.sqlite3"))
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
PUBLIC_ORIGIN = os.environ.get("BOARD_PUBLIC_ORIGIN", "").rstrip("/")
ROOMS = (1, 2, 3)
MAX_IMAGE_BYTES = 10 * 1024 * 1024
HOSTED_IMAGE_BYTES = 4 * 1024 * 1024
SESSION_SECONDS = 7 * 24 * 60 * 60
EMPTY_NOTE = {"text": "", "images": []}
CHANGE = threading.Condition()
CHANGE_COUNT = 0
DUMMY_SALT = bytes(16)

SCHEMA = """
CREATE TABLE IF NOT EXISTS admins (
    username TEXT PRIMARY KEY, salt BLOB NOT NULL, password_hash BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash BLOB PRIMARY KEY, username TEXT NOT NULL REFERENCES admins(username),
    expires BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
    bucket TEXT PRIMARY KEY, window_start BIGINT NOT NULL, attempts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_window ON login_attempts(window_start);
CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'available'
);
CREATE TABLE IF NOT EXISTS revisions (
    room INTEGER NOT NULL REFERENCES rooms(id), number INTEGER NOT NULL,
    username TEXT NOT NULL REFERENCES admins(username), updated_at TEXT NOT NULL,
    note TEXT NOT NULL, PRIMARY KEY (room, number)
);
CREATE TABLE IF NOT EXISTS drafts (
    room INTEGER NOT NULL REFERENCES rooms(id), username TEXT NOT NULL REFERENCES admins(username),
    serial INTEGER NOT NULL, base INTEGER NOT NULL, note TEXT NOT NULL,
    PRIMARY KEY (room, username)
);
CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES admins(username),
    mime TEXT NOT NULL, bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS revision_images (
    room INTEGER NOT NULL, revision INTEGER NOT NULL, image TEXT NOT NULL REFERENCES images(id),
    PRIMARY KEY (room, revision, image),
    FOREIGN KEY (room, revision) REFERENCES revisions(room, number)
);
CREATE INDEX IF NOT EXISTS revision_images_by_image ON revision_images(image);
"""


class StorageError(Exception):
    pass


class SetupError(Exception):
    pass


class APIError(Exception):
    def __init__(self, status, message, **details):
        self.status = status
        self.body = {"message": message, **details}


class PostgresConnection:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, statement, parameters=()):
        return self.conn.execute(statement.replace("?", "%s"), parameters)

    def executemany(self, statement, parameters):
        with self.conn.cursor() as cursor:
            cursor.executemany(statement.replace("?", "%s"), parameters)

    def executescript(self, script):
        for statement in script.split(";"):
            if statement.strip():
                self.conn.execute(statement)


@contextmanager
def database(write=False):
    if DATABASE_URL:
        import psycopg
        from psycopg.rows import dict_row

        try:
            with psycopg.connect(
                DATABASE_URL, connect_timeout=8, row_factory=dict_row, prepare_threshold=None,
            ) as raw:
                conn = PostgresConnection(raw)
                if write:
                    # Serialize short write transactions, including revision checks across function instances.
                    conn.execute("SELECT pg_advisory_xact_lock(1380929357)")
                yield conn
        except psycopg.Error as exc:
            raise StorageError("PostgreSQL request failed.") from exc
        return

    conn = sqlite3.connect(DATABASE, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        if write:
            conn.execute("BEGIN IMMEDIATE")
        with conn:
            yield conn
    finally:
        conn.close()


def initialize():
    if DATABASE_URL:
        with database(write=True) as conn:
            conn.executescript(SCHEMA.replace(" BLOB", " BYTEA"))
            conn.executemany(
                "INSERT INTO rooms (id) VALUES (?) ON CONFLICT(id) DO NOTHING",
                [(room,) for room in ROOMS],
            )
            seed_hosted_accounts(conn)
        return

    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    with database() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        conn.executemany("INSERT OR IGNORE INTO rooms (id) VALUES (?)", [(room,) for room in ROOMS])


def seed_hosted_accounts(conn):
    if conn.execute("SELECT 1 FROM admins LIMIT 1").fetchone():
        return
    try:
        accounts = json.loads(os.environ.get("ROOMCAST_ADMIN_PASSWORDS", "{}"))
        if not isinstance(accounts, dict) or not accounts:
            raise ValueError("Missing hosted accounts.")
        records = account_records(accounts)
    except ValueError:
        raise SetupError("Set ROOMCAST_ADMIN_PASSWORDS to a JSON object of admin IDs and passwords.") from None
    conn.executemany("INSERT INTO admins VALUES (?, ?, ?)", records)


def hash_password(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)


def account_records(accounts):
    records = []
    for username, password in accounts.items():
        if not re.fullmatch(r"[a-z0-9_-]{2,32}", username) or not isinstance(password, str) or not 8 <= len(password) <= 128:
            raise ValueError("An admin ID or password has an invalid format.")
        salt = secrets.token_bytes(16)
        records.append((username, salt, hash_password(password, salt)))
    return records


def seed_accounts():
    accounts = json.loads(sys.stdin.readline())
    if not isinstance(accounts, dict) or not accounts:
        raise ValueError("Expected a JSON object with admin usernames and passwords.")
    with database(write=True) as conn:
        conn.executemany("INSERT INTO admins VALUES (?, ?, ?)", account_records(accounts))
    print(f"Initialized {len(accounts)} admin accounts.")


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def room_state(conn, room):
    row = conn.execute(
        """SELECT rooms.revision, rooms.status, revisions.updated_at, revisions.note
           FROM rooms LEFT JOIN revisions ON revisions.room = rooms.id AND revisions.number = rooms.revision
           WHERE rooms.id = ?""",
        (room,),
    ).fetchone()
    return {
        "id": room, "revision": row["revision"], "status": row["status"],
        "updatedAt": row["updated_at"], **(json.loads(row["note"]) if row["note"] else EMPTY_NOTE),
    }


def draft_state(conn, room, username):
    row = conn.execute(
        "SELECT serial, base, note FROM drafts WHERE room = ? AND username = ?", (room, username)
    ).fetchone()
    if row:
        return {"serial": row["serial"], "base": row["base"], **json.loads(row["note"])}
    # The initial draft must record the revision it was opened against, even before typing.
    return {"serial": 0, "base": room_state(conn, room)["revision"], **EMPTY_NOTE}


def write_draft(conn, room, username, serial, base, note):
    conn.execute(
        """INSERT INTO drafts VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(room, username) DO UPDATE SET
           serial = excluded.serial, base = excluded.base, note = excluded.note""",
        (room, username, serial, base, json_bytes(note).decode()),
    )
    return {"serial": serial, "base": base, **note}


def note_from(data, conn, username):
    body = data.get("text")
    images = data.get("images")
    if not isinstance(body, str) or len(body) > 12000 or not isinstance(images, list) or len(images) > 8:
        raise APIError(400, "Use up to 12,000 characters and eight images.")
    clean_images = []
    for item in images:
        if not isinstance(item, dict):
            raise APIError(400, "An image is invalid.")
        image_id, alt = item.get("id"), item.get("alt")
        if not isinstance(image_id, str) or not re.fullmatch(r"[a-f0-9]{32}", image_id) or not isinstance(alt, str) or len(alt) > 200:
            raise APIError(400, "An image or its description is invalid.")
        allowed = conn.execute(
            """SELECT 1 FROM images WHERE id = ? AND
               (username = ? OR EXISTS (SELECT 1 FROM revision_images WHERE image = images.id))""",
            (image_id, username),
        ).fetchone()
        if not allowed:
            raise APIError(400, "An image is unavailable. Add it again.")
        clean_images.append({"id": image_id, "alt": alt})
    return {"text": body, "images": clean_images}


def insert_revision(conn, room, username, current, note):
    number = current["revision"] + 1
    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    conn.execute(
        "INSERT INTO revisions VALUES (?, ?, ?, ?, ?)",
        (room, number, username, timestamp, json_bytes(note).decode()),
    )
    conn.executemany(
        "INSERT INTO revision_images VALUES (?, ?, ?)",
        [(room, number, image_id) for image_id in {item["id"] for item in note["images"]}],
    )
    conn.execute("UPDATE rooms SET revision = ? WHERE id = ?", (number, room))
    return room_state(conn, room)


def signal_change():
    global CHANGE_COUNT
    with CHANGE:
        CHANGE_COUNT += 1
        CHANGE.notify_all()


def detect_image(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    raise APIError(415, "Choose a PNG, JPEG, GIF or WebP image.")


class Handler(BaseHTTPRequestHandler):
    hosted = False
    scheme = "http"
    protocol_version = "HTTP/1.1"
    server_version = "Roomcast"

    def setup(self):
        self.request.settimeout(30)
        super().setup()

    def log_message(self, fmt, *args):
        # Request URLs and credentials stay out of application logs.
        pass

    def headers_for(self, content_type, length=None):
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; script-src 'self'; style-src 'self'; "
                         "img-src 'self'; connect-src 'self'; base-uri 'none'; "
                         "form-action 'self'; frame-ancestors 'none'")
        if length is not None:
            self.send_header("Content-Length", str(length))

    def send(self, status, content, content_type, cookie=None):
        self.send_response(status)
        self.headers_for(content_type, len(content))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if content:
            self.wfile.write(content)

    def send_json(self, content, status=200, cookie=None):
        self.send(status, json_bytes(content), "application/json; charset=utf-8", cookie)

    def read_body(self, maximum):
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise APIError(411, "Content length is required.")
        if not 0 <= length <= maximum:
            raise APIError(413, "This upload is too large.")
        data = self.rfile.read(length)
        if len(data) != length:
            raise APIError(400, "The request ended early. Try again.")
        return data

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise APIError(415, "The request must contain JSON.")
        try:
            payload = json.loads(self.read_body(90 * 1024))
        except (UnicodeDecodeError, ValueError):
            raise APIError(400, "The request could not be read.")
        if not isinstance(payload, dict):
            raise APIError(400, "The request could not be read.")
        return payload

    def token_hash(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        token = cookie.get("roomcast_session")
        if token and re.fullmatch(r"[-\w]{43}", token.value, flags=re.ASCII):
            return hashlib.sha256(token.value.encode()).digest()
        return None

    def session(self, required=False):
        token = self.token_hash()
        if token:
            with database() as conn:
                row = conn.execute(
                    "SELECT username FROM sessions WHERE token_hash = ? AND expires > ?",
                    (token, int(time.time())),
                ).fetchone()
            if row:
                return row["username"]
        if required:
            raise APIError(401, "Sign in to manage the rooms.")
        return None

    def cookie(self, token, max_age):
        secure = "; Secure" if self.scheme == "https" or PUBLIC_ORIGIN.startswith("https://") else ""
        return f"roomcast_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"

    def login(self):
        data = self.read_json()
        raw_id, password = data.get("username"), data.get("password")
        if not isinstance(raw_id, str) or not isinstance(password, str) or len(raw_id) > 64 or len(password) > 128:
            raise APIError(400, "Enter your admin ID and password.")
        username = raw_id.strip().lower()
        client = self.client_address[0]
        now = int(time.time())
        with database(write=True) as conn:
            admin = conn.execute("SELECT * FROM admins WHERE username = ?", (username,)).fetchone()
            source_bucket = hashlib.sha256(f"source:{client}".encode()).hexdigest()
            identity_bucket = hashlib.sha256(f"admin:{client}:{username}".encode()).hexdigest()
            limits = [(source_bucket, 30)]
            if admin:
                limits.append((identity_bucket, 8))
            conn.execute("DELETE FROM login_attempts WHERE window_start <= ?", (now - 900,))
            for bucket, limit in limits:
                row = conn.execute("SELECT attempts FROM login_attempts WHERE bucket = ?", (bucket,)).fetchone()
                if row and row["attempts"] >= limit:
                    raise APIError(429, "Too many attempts. Try again in 15 minutes.")
            conn.executemany(
                """INSERT INTO login_attempts VALUES (?, ?, 1)
                   ON CONFLICT(bucket) DO UPDATE SET attempts = login_attempts.attempts + 1""",
                [(bucket, now) for bucket, _ in limits],
            )

        actual = hash_password(password, admin["salt"] if admin else DUMMY_SALT)
        expected = admin["password_hash"] if admin else bytes(64)
        if not hmac.compare_digest(actual, expected) or not admin:
            raise APIError(401, "That admin ID or password is incorrect.")

        token = secrets.token_urlsafe(32)
        with database(write=True) as conn:
            conn.execute("DELETE FROM sessions WHERE expires <= ? OR token_hash = ?", (now, self.token_hash()))
            conn.execute(
                "INSERT INTO sessions VALUES (?, ?, ?)",
                (hashlib.sha256(token.encode()).digest(), username, now + SESSION_SECONDS),
            )
            conn.execute("DELETE FROM login_attempts WHERE bucket = ?", (identity_bucket,))
            conn.execute(
                "UPDATE login_attempts SET attempts = attempts - 1 WHERE bucket = ? AND attempts > 0",
                (source_bucket,),
            )
        self.send_json({"username": username}, cookie=self.cookie(token, SESSION_SECONDS))

    def get_rooms(self):
        with database() as conn:
            states = [room_state(conn, room) for room in ROOMS]
        return [{key: room[key] for key in ("id", "revision", "status", "updatedAt")} for room in states]

    def stream_rooms(self):
        self.send_response(200)
        self.headers_for("text/event-stream; charset=utf-8")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        last = None
        try:
            while True:
                with CHANGE:
                    change = CHANGE_COUNT
                encoded = json_bytes(self.get_rooms())
                packet = b"data: " + encoded + b"\n\n" if encoded != last else b"event: heartbeat\ndata: {}\n\n"
                self.wfile.write(packet)
                self.wfile.flush()
                last = encoded
                with CHANGE:
                    CHANGE.wait_for(lambda: CHANGE_COUNT != change, timeout=12)
        except (BrokenPipeError, ConnectionError, TimeoutError):
            pass

    def get_admin_room(self, room, username):
        with database(write=True) as conn:
            state = room_state(conn, room)
            draft = draft_state(conn, room, username)
            if draft["serial"] == 0:
                draft = write_draft(conn, room, username, 1, draft["base"], EMPTY_NOTE)
            history = conn.execute(
                """SELECT number, username, updated_at FROM revisions
                   WHERE room = ? AND number < ? ORDER BY number DESC LIMIT 12""",
                (room, state["revision"]),
            ).fetchall()
        self.send_json({"room": state, "draft": draft, "history": [dict(row) for row in history]})

    def update_room(self, room, action, username, data):
        with database(write=True) as conn:
            current = room_state(conn, room)
            if action == "status":
                status = data.get("status")
                if status not in ("available", "in-use"):
                    raise APIError(400, "Choose Available or In use.")
                conn.execute("UPDATE rooms SET status = ? WHERE id = ?", (status, room))
                result = room_state(conn, room)
            elif action == "restore":
                if data.get("base") != current["revision"]:
                    raise APIError(409, "A newer note was published. Review it before restoring.", room=current)
                revision = data.get("revision")
                if type(revision) is not int or not 1 <= revision < current["revision"]:
                    raise APIError(400, "Choose an earlier note to restore.")
                row = conn.execute(
                    "SELECT note FROM revisions WHERE room = ? AND number = ?", (room, revision)
                ).fetchone()
                if not row:
                    raise APIError(404, "That previous note is unavailable.")
                result = insert_revision(conn, room, username, current, json.loads(row["note"]))
            else:
                draft = draft_state(conn, room, username)
                if type(data.get("serial")) is not int or data["serial"] != draft["serial"]:
                    raise APIError(409, "This draft changed in another tab. Review the saved draft before continuing.", draft=draft, room=current)
                base = draft["base"]
                if action == "draft":
                    result = write_draft(conn, room, username, draft["serial"] + 1, base, note_from(data, conn, username))
                else:
                    if action == "rebase" and data.get("base") != current["revision"]:
                        raise APIError(409, "A newer note was published. Review it before continuing.", room=current)
                    if action == "publish" and base != current["revision"]:
                        raise APIError(409, "Another admin published here. Review the current screen before publishing your draft.", room=current)
                    if action == "rebase":
                        result = write_draft(conn, room, username, draft["serial"] + 1, current["revision"],
                                             {"text": draft["text"], "images": draft["images"]})
                    if action == "publish":
                        if not draft["text"].strip() and not draft["images"] and data.get("allowEmpty") is not True:
                            raise APIError(400, "Confirm that you want to put a blank note on this screen.")
                        state = insert_revision(conn, room, username, current,
                                                {"text": draft["text"], "images": draft["images"]})
                        next_draft = write_draft(conn, room, username, draft["serial"] + 1, state["revision"], EMPTY_NOTE)
                        result = {"room": state, "draft": next_draft}
        if action in ("publish", "status", "restore"):
            signal_change()
        self.send_json(result)

    def get_image(self, image_id):
        user = self.session()
        with database() as conn:
            row = conn.execute(
                """SELECT mime, bytes FROM images WHERE id = ? AND (username = ? OR EXISTS (
                    SELECT 1 FROM revision_images AS ri JOIN rooms ON rooms.id = ri.room
                    WHERE ri.image = images.id AND (CAST(? AS TEXT) IS NOT NULL OR rooms.revision = ri.revision)
                ))""",
                (image_id, user, user),
            ).fetchone()
        if not row:
            raise APIError(404, "Image not found.")
        self.send(200, row["bytes"], row["mime"])

    def post_image(self):
        username = self.session(required=True)
        data = self.read_body(HOSTED_IMAGE_BYTES if self.hosted else MAX_IMAGE_BYTES)
        mime = detect_image(data)
        image_id = secrets.token_hex(16)
        with database(write=True) as conn:
            conn.execute("INSERT INTO images VALUES (?, ?, ?, ?)", (image_id, username, mime, data))
        self.send_json({"id": image_id}, 201)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def dispatch(self, method):
        # Close finite requests so unread bodies on error cannot become a new request.
        self.close_connection = True
        try:
            path = urlsplit(self.path).path
            if method != "GET":
                origin = self.headers.get("Origin")
                expected = PUBLIC_ORIGIN or f"{self.scheme}://" + self.headers.get("Host", "")
                if origin and origin != expected:
                    raise APIError(403, "Open the admin panel on this site to make changes.")
            self.route(method, path)
        except APIError as exc:
            self.send_json(exc.body, exc.status)
        except (BrokenPipeError, ConnectionError, TimeoutError):
            pass
        except (OSError, sqlite3.Error, StorageError) as exc:
            print(f"Roomcast request failed ({type(exc).__name__}).", file=sys.stderr)
            self.send_json({"message": "The server could not finish the request. Try again."}, 500)

    def route(self, method, path):
        if method == "GET":
            if path == "/api/rooms":
                return self.send_json(self.get_rooms())
            if path == "/api/events":
                if self.hosted:
                    raise APIError(404, "Hosted screens use periodic updates.")
                return self.stream_rooms()
            if path == "/api/session":
                return self.send_json({
                    "username": self.session(),
                    "maxImageBytes": HOSTED_IMAGE_BYTES if self.hosted else MAX_IMAGE_BYTES,
                })
            room = re.fullmatch(r"/api/rooms/([1-3])", path)
            if room:
                with database() as conn:
                    state = room_state(conn, int(room[1]))
                return self.send_json({**state, "liveMode": "poll" if self.hosted else "events"})
            admin = re.fullmatch(r"/api/admin/rooms/([1-3])", path)
            if admin:
                return self.get_admin_room(int(admin[1]), self.session(required=True))
            image = re.fullmatch(r"/api/images/([a-f0-9]{32})", path)
            if image:
                return self.get_image(image[1])
            files = {"/app.js": ("app.js", "text/javascript; charset=utf-8"),
                     "/styles.css": ("styles.css", "text/css; charset=utf-8")}
            if re.fullmatch(r"/(?:admin(?:/[1-3])?/?|rooms/[1-3]/?)?", path):
                files[path] = ("index.html", "text/html; charset=utf-8")
            if path in files:
                name, mime = files[path]
                return self.send(200, (PUBLIC / name).read_bytes(), mime)
        if method == "POST":
            if path == "/api/login":
                return self.login()
            if path == "/api/logout":
                self.read_json()
                with database(write=True) as conn:
                    conn.execute("DELETE FROM sessions WHERE token_hash = ?", (self.token_hash(),))
                return self.send_json({"username": None}, cookie=self.cookie("", 0))
            if path == "/api/images":
                return self.post_image()
        update = re.fullmatch(r"/api/admin/rooms/([1-3])/(draft|publish|rebase|status|restore)", path)
        if update and method == ("PUT" if update[2] == "draft" else "POST"):
            username = self.session(required=True)
            return self.update_room(int(update[1]), update[2], username, self.read_json())
        raise APIError(404, "Page not found.")


def main():
    parser = argparse.ArgumentParser(description="Roomcast broadcast boards")
    parser.add_argument("--host", default="127.0.0.1", help="Address on which to listen")
    parser.add_argument("--port", default=8000, type=int)
    parser.add_argument("--accounts-from-stdin", action="store_true", help="Initialize admin accounts from a JSON object on stdin")
    parser.add_argument("--open-browser", action="store_true", help="Open the room overview in your browser")
    args = parser.parse_args()
    initialize()
    if args.accounts_from_stdin:
        try:
            seed_accounts()
        except (ValueError, sqlite3.IntegrityError) as exc:
            raise SystemExit("Account initialization failed. Check the input and ensure the IDs are unique.") from None
        return
    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        url = f"http://{args.host}:{server.server_port}/"
        print(f"Roomcast is ready at {url}", flush=True)
        if args.open_browser:
            threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
