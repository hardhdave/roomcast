"use strict";

const app = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const roomNumbers = [1, 2, 3];
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const emptyNote = {text: "", images: []};
const roomIcons = ["◫", "▤", "▥"];
const roomNames = ["Room 01", "Room 02", "Room 03"];
const roomName = id => roomNames[id - 1];
const roomIcon = id => roomIcons[id - 1];
const roomUrl = id => "/rooms/" + id;
const adminUrl = id => "/admin/" + id;
const endpoint = (room, action) => "/api/admin/rooms/" + room + (action ? "/" + action : "");
let toastTimer;

class RequestError extends Error {
  constructor(status, data) {
    super(data.message || "The request could not be completed.");
    this.status = status;
    this.data = data;
  }
}

async function request(url, {method = "GET", json, body, timeout = 10000, headers} = {}) {
  const options = {method, cache: "no-store", signal: AbortSignal.timeout(timeout), headers};
  if (json !== undefined) {
    options.headers = {"Content-Type": "application/json"};
    options.body = JSON.stringify(json);
  } else if (body) {
    options.body = body;
  }
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new RequestError(response.status, data);
  return data;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showToast(text, error = false) {
  const toast = document.querySelector("#notification");
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.classList.toggle("is-error", error);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 8500 : 4500);
}

function report(error) {
  showToast(error instanceof RequestError ? error.message : "Couldn’t reach the board. Please try again.", true);
}

function ask(title, message, confirm, fill) {
  dialog.querySelector("#dialog-title").textContent = title;
  dialog.querySelector("#dialog-message").textContent = message;
  dialog.querySelector("#dialog-confirm").textContent = confirm;
  const content = dialog.querySelector("#dialog-content");
  content.replaceChildren();
  content.hidden = !fill;
  if (fill) fill(content);
  dialog.returnValue = "cancel";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {once: true});
    dialog.showModal();
  });
}

function stamp(value) {
  if (!value) return "No broadcast yet";
  const difference = Math.max(0, Date.now() - Date.parse(value));
  const units = [[86400000, "day"], [3600000, "hour"], [60000, "minute"]];
  for (const [duration, label] of units) {
    if (difference >= duration) {
      const amount = Math.floor(difference / duration);
      return `Updated ${amount} ${label}${amount === 1 ? "" : "s"} ago`;
    }
  }
  return "Updated just now";
}

function timeText(value) {
  return value ? new Date(value).toLocaleString() : "";
}

function paintTime(element, timestamp) {
  element.textContent = stamp(timestamp);
  element.dateTime = timestamp || "";
  element.title = timeText(timestamp);
}

function paintStatus(element, status) {
  element.textContent = status === "in-use" ? "In use" : "Available";
  element.classList.toggle("in-use", status === "in-use");
}

function header(active) {
  return `<header class="topbar">
    <div class="bar-inner">
      <a class="brand" href="/" aria-label="Roomcast home"><span class="brand-mark" aria-hidden="true"></span>Roomcast</a>
      <nav class="main-nav" aria-label="Main navigation">
        <a href="/" ${active === "home" ? 'aria-current="page"' : ""}>Rooms</a>
        <a href="/admin" ${active === "admin" ? 'aria-current="page"' : ""}><span aria-hidden="true" class="nav-lock"></span>Admin panel</a>
      </nav>
    </div>
  </header>`;
}

function footer() {
  return `<footer class="site-footer"><span>Roomcast</span><span>Room broadcasts</span></footer>`;
}

function roomCard(id, admin) {
  return `<article class="room-card room-${id}" data-room="${id}">
    <div class="card-top">
      <span class="room-symbol" aria-hidden="true">${roomIcon(id)}</span>
      <span class="status" hidden></span>
    </div>
    <h3>${roomName(id)}</h3>
    <time class="muted">Loading room…</time>
    <a class="button button-light room-link" href="${admin ? adminUrl(id) : roomUrl(id)}">
       ${admin ? "Edit room" : "Open screen"}
    </a>
  </article>`;
}

function watchRooms(onData, onError = () => {}) {
  let busy = false;
  async function check() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      onData(await request("/api/rooms"));
    } catch {
      onError();
    } finally {
      busy = false;
    }
  }
  check();
  setInterval(check, 3500);
  window.addEventListener("online", check);
  document.addEventListener("visibilitychange", check);
}

function overview(admin = false, username = "") {
  document.title = admin ? "Admin panel · Roomcast" : "Rooms · Roomcast";
  app.innerHTML = header(admin ? "admin" : "home") + (admin ? `
    <main id="main" class="shell">
      <div class="admin-intro">
        <div><p class="section-label">Admin panel</p><h1>Choose a room</h1><p class="subtitle">Draft and publish a broadcast to any room.</p></div>
        <div class="identity"><span id="identity-name"></span><button class="button button-light" id="logout">Sign out</button></div>
      </div>` : `
    <main id="main" class="shell">
      <section class="hero">
        <div class="hero-copy">
          <p class="section-label"><span class="broadcast-icon" aria-hidden="true"></span> Broadcast board</p>
          <h1>Room displays</h1>
          <p>Open a room’s screen to see its latest broadcast.</p>
        </div>
        <div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>
          <div class="orbit orbit-three"></div><div class="illustration"><span class="illustration-top"></span><div class="illustration-screen">
          <span></span><i></i><i></i></div><div class="illustration-stand"></div></div></div>
      </section>`) + `
    <section class="room-section" aria-labelledby="room-list-title">
      <div class="section-heading">
        <h2 id="room-list-title">Room overview</h2><span id="overview-connection" class="muted" role="status"></span>
      </div>
      <div class="room-grid">${roomNumbers.map(id => roomCard(id, admin)).join("")}</div>
    </section>
    </main>` + footer();
  if (admin) {
    app.querySelector("#identity-name").textContent = username;
    app.querySelector("#logout").addEventListener("click", signOut);
  }
  let rooms = [];
  const indicator = app.querySelector("#overview-connection");
  function paint() {
    for (const room of rooms) {
      const card = app.querySelector('[data-room="' + room.id + '"]');
      const badge = card.querySelector(".status");
      badge.hidden = false;
      paintStatus(badge, room.status);
      paintTime(card.querySelector("time"), room.updatedAt);
    }
  }
  watchRooms(data => {
    rooms = data;
    indicator.textContent = "";
    paint();
  }, () => { indicator.textContent = "Connection interrupted"; });
  setInterval(paint, 10000);
}

function renderInline(parent, text) {
  for (const part of text.split(/(\*\*[^*\n]+\*\*|_[^_\n]+_)/g)) {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      parent.append(node("strong", "", part.slice(2, -2)));
    } else if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
      parent.append(node("em", "", part.slice(1, -1)));
    } else {
      parent.append(document.createTextNode(part));
    }
  }
}

function renderNote(container, note, emptyTitle, emptyDescription) {
  container.replaceChildren();
  const text = note.text.trim();
  const lines = text ? text.split(/\r?\n/) : [];
  const imageCount = note.images.length;
  const lineBudget = imageCount ? 32 : 58;
  const visualLines = lines.reduce((count, line) => count + Math.max(1, Math.ceil(line.length / lineBudget)), 0);
  container.dataset.layout = lines.length ? (imageCount ? "mixed" : "text") : (imageCount ? "media" : "empty");
  container.dataset.density = visualLines > 12 ? "long" : visualLines > 7 ? "medium" : "short";
  if (!lines.length && !imageCount) {
    const box = node("div", "empty");
    box.append(node("span", "empty-mark"), node("strong", "", emptyTitle));
    if (emptyDescription) box.append(node("p", "", emptyDescription));
    container.append(box);
    return;
  }
  if (lines.length) {
    const copy = node("div", "note-text");
    let list = null;
    for (const line of lines) {
      if (line.startsWith("- ")) {
        if (!list) {
          list = node("ul");
          copy.append(list);
        }
        const item = node("li");
        renderInline(item, line.slice(2));
        list.append(item);
        continue;
      }
      list = null;
      if (!line.trim()) {
        copy.append(node("div", "paragraph-gap"));
        continue;
      }
      const heading = line.startsWith("# ");
      const lineElement = node(heading ? "h2" : "p");
      renderInline(lineElement, heading ? line.slice(2) : line);
      copy.append(lineElement);
    }
    container.append(copy);
  }
  if (imageCount) {
    const gallery = node("div", "gallery");
    gallery.dataset.count = imageCount;
    for (const image of note.images) {
      const picture = node("img");
      picture.alt = image.alt;
      picture.src = "/api/images/" + image.id;
      gallery.append(picture);
    }
    container.append(gallery);
  }
}

function screenBoard(id, {preview = false} = {}) {
  const title = preview ? `<strong>${roomName(id)}</strong>` : `<h1 id="display-title">${roomName(id)}</h1>`;
  const name = preview ? 'aria-label="TV preview"' : 'aria-labelledby="display-title"';
  const footer = preview
    ? '<span class="connection online">Preview</span>'
    : '<span id="display-connection" class="connection" role="status">Connecting</span><time id="display-time"></time>';
  return `<section class="screen-board ${preview ? "tv-preview" : "display-board"}" ${name}>
    <header class="screen-header">
      <div class="screen-identity"><span class="room-symbol" aria-hidden="true">${roomIcon(id)}</span>${title}</div>
      <span class="status" ${preview ? "" : "hidden"}></span>
    </header>
    <div id="${preview ? "draft-preview" : "display-note"}" class="screen-content note-content"
      data-layout="empty" tabindex="0" role="region" aria-label="${preview ? "Preview content" : "Broadcast content"}">
      ${preview ? "" : '<div class="empty"><span class="empty-mark"></span><strong>Connecting to the room…</strong></div>'}
    </div>
    <footer class="screen-footer">${footer}</footer>
  </section>`;
}

function showViewer(id) {
  document.title = roomName(id) + " screen · Roomcast";
  document.body.classList.add("display-page");
  app.innerHTML = `<main id="main" class="display-shell room-${id}">
    <div class="display-top">
      <a class="button button-light" href="/">All rooms</a>
      <button class="button button-light" id="fullscreen" hidden>Full screen</button>
    </div>
    ${screenBoard(id)}
  </main>`;

  const badge = app.querySelector(".status");
  const time = app.querySelector("#display-time");
  const note = app.querySelector("#display-note");
  const connection = app.querySelector("#display-connection");
  const fullscreen = app.querySelector("#fullscreen");
  let current;
  let loading;
  let stream;
  let lastCheck = 0;
  let motion = 0;
  let lastEvent = 0;
  let latestMetadata;

  if (document.fullscreenEnabled) {
    fullscreen.hidden = false;
    fullscreen.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else {
          await document.documentElement.requestFullscreen();
          note.focus({preventScroll: true});
        }
      } catch {
        showToast("Full screen isn’t available on this device.", true);
      }
    });
    document.addEventListener("fullscreenchange", () => {
      fullscreen.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
    });
  }

  function setConnection(online) {
    connection.textContent = online ? "Live" : "Offline · reconnecting";
    connection.classList.toggle("online", online);
  }

  function applyRoom(next) {
    if (current && next.revision < current.revision) return;
    if (!current || next.revision !== current.revision) {
      note.scrollTop = 0;
      renderNote(note, next, next.revision ? "This screen is clear" : "Nothing on screen yet",
        next.revision ? "The room is ready for the next broadcast." : "The first broadcast will appear here.");
    }
    current = next;
    badge.hidden = false;
    paintStatus(badge, next.status);
    paintTime(time, next.updatedAt);
  }

  function refresh() {
    if (loading) return loading;
    const lastMovement = motion;
    lastCheck = Date.now();
    loading = request("/api/rooms/" + id).then(next => {
      if (motion !== lastMovement && latestMetadata?.revision === next.revision) {
        next.status = latestMetadata.status;
      }
      applyRoom(next);
      setConnection(true);
      if (!stream && next.liveMode !== "poll" && typeof EventSource !== "undefined") startLiveEvents();
    }).catch(() => {
      if (lastMovement === motion) setConnection(false);
    }).finally(() => { loading = null; });
    return loading;
  }

  function startLiveEvents() {
    stream = new EventSource("/api/events");
    stream.addEventListener("message", async event => {
      const metadata = JSON.parse(event.data).find(room => room.id === id);
      lastEvent = Date.now();
      latestMetadata = metadata;
      motion += 1;
      setConnection(true);
      if (!current || metadata.revision > current.revision) {
        await refresh();
        if (!current || metadata.revision > current.revision) await refresh();
      } else if (metadata.revision === current.revision) {
        applyRoom({...current, status: metadata.status});
      }
    });
    stream.addEventListener("heartbeat", () => {
      lastEvent = Date.now();
      setConnection(true);
    });
    stream.addEventListener("error", () => { lastEvent = 0; setConnection(false); });
  }

  window.addEventListener("offline", () => { lastEvent = 0; setConnection(false); });
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  setInterval(() => {
    if (current) paintTime(time, current.updatedAt);
    if (!stream) {
      if (!document.hidden && Date.now() - lastCheck >= 9000) refresh();
      return;
    }
    if (Date.now() - lastEvent > 20000 || (latestMetadata && (!current || current.revision < latestMetadata.revision))) refresh();
  }, 5000);
  refresh();
}

async function signOut() {
  try {
    await request("/api/logout", {method: "POST", json: {}});
    location.assign("/admin");
  } catch (error) {
    report(error);
  }
}

function showLogin(id) {
  document.title = "Admin sign-in · Roomcast";
  app.innerHTML = header("admin") + `<main id="main" class="shell login-wrap">
    <div class="login-card">
      <span class="login-mark" aria-hidden="true"><span class="nav-lock"></span></span>
      <h1>Admin sign-in</h1>
      <p class="subtitle">Use your assigned ID to manage all three rooms.</p>
      <form id="login-form">
        <label for="username">Admin ID</label>
        <input id="username" name="username" required autocomplete="username" autocapitalize="none" spellcheck="false">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password">
        <p id="login-error" class="form-error" role="alert" hidden></p>
        <button class="button button-primary" type="submit">Sign in</button>
      </form>
    </div>
  </main>` + footer();
  const form = app.querySelector("form");
  const errorBox = form.querySelector("#login-error");
  const submit = form.querySelector("button");
  form.addEventListener("submit", async event => {
    event.preventDefault();
    errorBox.hidden = true;
    submit.disabled = true;
    submit.textContent = "Signing in…";
    try {
      await request("/api/login", {method: "POST", json: {
        username: form.elements.username.value.trim(), password: form.elements.password.value,
      }});
      location.replace(id ? adminUrl(id) : "/admin");
    } catch (error) {
      errorBox.textContent = error instanceof RequestError ? error.message : "Couldn’t reach Roomcast. Try again.";
      errorBox.hidden = false;
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  });
}



async function prepareImage(file, uploadLimit) {
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new RequestError(413, {message: file.name + " exceeds 10 MB."});
  }
  if (file.size <= uploadLimit) return file;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new RequestError(413, {message: "Hosted GIFs and other images that can’t be resized must be under 4 MB."});
  }

  const picture = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const mime = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    for (const [maxDimension, quality] of [[2400, .86], [1800, .8], [1280, .72]]) {
      const scale = Math.min(1, maxDimension / Math.max(picture.width, picture.height));
      canvas.width = Math.max(1, Math.round(picture.width * scale));
      canvas.height = Math.max(1, Math.round(picture.height * scale));
      context.drawImage(picture, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, quality));
      if (blob && blob.size <= uploadLimit) return blob;
    }
  } finally {
    picture.close();
  }

  throw new RequestError(413, {message: "This image still exceeds 4 MB after resizing. Try a smaller version."});
}

function editorPage(id, username, initial, uploadLimit) {
  document.title = roomName(id) + " editor · Roomcast";
  document.body.classList.add("editor-page");
  app.innerHTML = header("admin") + `
    <main id="main" class="shell editor-shell room-${id}" data-mobile-mode="write">
      <nav class="room-nav" aria-label="Edit rooms">
        <a class="rooms-back" href="/admin">All rooms</a>
        ${roomNumbers.map(room => `<a href="${adminUrl(room)}" ${room === id ? 'aria-current="page"' : ""}>${roomName(room)}</a>`).join("")}
      </nav>
      <div class="admin-intro editor-intro">
        <div><p class="section-label">Admin panel</p><h1>${roomName(id)}</h1></div>
        <div class="identity"><span id="identity-name"></span><button class="button button-light" id="logout">Sign out</button></div>
      </div>
      <div class="mobile-editor-actions" aria-label="Draft actions">
        <button class="button button-light" id="toggle-preview" type="button" aria-controls="tv-preview-panel" aria-expanded="false">TV preview</button>
        <button class="button button-primary" type="button" data-publish>Publish</button>
      </div>
      <div id="conflict" class="conflict" hidden role="status"><span></span><button class="button button-light" type="button">Review</button></div>
      <div class="editor-grid">
        <section class="panel draft-panel" aria-labelledby="draft-title">
          <div class="panel-heading">
            <div><h2 id="draft-title" tabindex="-1">Your draft</h2><p id="save-state" class="muted" role="status">Draft saved</p></div>
            <button class="button button-primary" type="button" data-publish>Publish</button>
          </div>
          <div class="writing">
            <div class="toolbar" aria-label="Text formatting">
              <button type="button" class="format-bold" data-format="bold" aria-label="Bold" title="Bold">B</button>
              <button type="button" class="format-italic" data-format="italic" aria-label="Italic" title="Italic">I</button>
              <button type="button" data-format="heading" aria-label="Heading" title="Heading">H</button>
              <button type="button" data-format="list" aria-label="Bulleted list" title="Bulleted list">≡</button>
              <button type="button" class="use-live" id="use-live">Copy live note</button>
            </div>
            <label class="visually-hidden" for="draft-text">Broadcast text</label>
            <textarea id="draft-text" maxlength="12000" placeholder="Write your broadcast here…" spellcheck="true"></textarea>
          </div>
          <div class="attachments">
            <button class="drop-area" id="drop-area" type="button">
              <span class="upload-icon" aria-hidden="true">＋</span>
              <span><strong>Add images</strong><span class="muted upload-hint"><span class="drop-hint">Drop files here or browse. </span><span class="upload-limit">Up to 10 MB each.</span></span></span>
            </button>
            <input type="file" id="pick-files" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
            <ul id="image-list" class="image-list" aria-label="Attached images"></ul>
          </div>
        </section>
        <section class="panel preview-panel" id="tv-preview-panel" aria-labelledby="preview-title">
          <div class="panel-heading">
            <div><h2 id="preview-title" tabindex="-1">TV preview</h2><p class="muted">See how your draft fits a 16:9 screen.</p></div>
          </div>
          ${screenBoard(id, {preview: true})}
          <p id="preview-fit" class="fit-hint" hidden>Some content takes more than one screen. Shorten the draft to show it all at once.</p>
        </section>
      </div>
      <section class="panel room-controls" aria-labelledby="live-title">
        <div>
          <h2 id="live-title">Live screen</h2>
          <time id="last-published" class="muted"></time>
        </div>
        <div class="screen-actions">
          <label for="room-status">Room status</label>
          <select id="room-status">
            <option value="available">Available</option>
            <option value="in-use">In use</option>
          </select>
          <a class="button button-light" href="${roomUrl(id)}" target="_blank" rel="noopener">Open screen<span class="visually-hidden"> in a new tab</span></a>
        </div>
      </section>
      <details class="panel history">
        <summary>Publish history</summary>
        <div id="revision-list"></div>
      </details>
    </main>` + footer();

  const textArea = app.querySelector("#draft-text");
  const imageList = app.querySelector("#image-list");
  const preview = app.querySelector("#draft-preview");
  const status = app.querySelector("#room-status");
  const publishButtons = app.querySelectorAll("[data-publish]");
  const mobileMode = app.querySelector(".editor-shell");
  const togglePreview = app.querySelector("#toggle-preview");
  const previewTitle = app.querySelector("#preview-title");
  const fitHint = app.querySelector("#preview-fit");
  const autosave = app.querySelector("#save-state");
  const conflict = app.querySelector("#conflict");
  const historyList = app.querySelector("#revision-list");
  const lastPublished = app.querySelector("#last-published");
  const copyPublished = app.querySelector("#use-live");
  const dropArea = app.querySelector("#drop-area");
  const filePicker = app.querySelector("#pick-files");
  if (uploadLimit < MAX_SOURCE_IMAGE_BYTES) {
    app.querySelector(".upload-limit").textContent = "Photos up to 10 MB resize as needed.";
  }
  let current = initial.room;
  let draft = initial.draft;
  let images = draft.images.map(image => ({...image}));
  let history = initial.history;
  let edits = 0;
  let saved = 0;
  let pendingTimer;
  let saving;
  let draftConflict;
  let retry = false;
  let busy = false;
  let uploading = false;

  app.querySelector("#identity-name").textContent = username;
  textArea.value = draft.text;

  function localNote() {
    return {text: textArea.value, images: images.map(image => ({...image}))};
  }

  function paintButtons() {
    for (const button of publishButtons) {
      button.disabled = busy || uploading;
      button.textContent = textArea.readOnly ? "Publishing…" : "Publish";
    }
    copyPublished.hidden = !current.revision;
    copyPublished.disabled = busy || uploading;
    status.disabled = busy;
    filePicker.disabled = uploading || busy;
    for (const field of imageList.querySelectorAll("input, button")) field.disabled = busy;
    dropArea.disabled = filePicker.disabled;
  }

  function paintConflict() {
    const crossTab = Boolean(draftConflict);
    conflict.hidden = !crossTab && current.revision <= draft.base;
    conflict.querySelector("span").textContent = crossTab
      ? "Your draft changed in another tab."
      : "Another broadcast is live. Review it before publishing this draft.";
  }

  function checkPreviewFit() {
    fitHint.hidden = !preview.clientHeight || preview.scrollHeight <= preview.clientHeight + 2;
  }

  function paintPreview() {
    renderNote(preview, localNote(), "Your draft is empty", "Text and images will appear here.");
    checkPreviewFit();
  }

  function switchMobileMode() {
    const showPreview = mobileMode.dataset.mobileMode === "write";
    mobileMode.dataset.mobileMode = showPreview ? "preview" : "write";
    togglePreview.setAttribute("aria-expanded", showPreview);
    togglePreview.textContent = showPreview ? "Back to draft" : "TV preview";
    const heading = showPreview ? previewTitle : app.querySelector("#draft-title");
    heading.focus({preventScroll: true});
    heading.scrollIntoView({block: "start"});
    checkPreviewFit();
  }

  function paintRoom() {
    paintTime(lastPublished, current.updatedAt);
    paintStatus(app.querySelector(".screen-header .status"), current.status);
    status.value = current.status;
    paintConflict();
    paintButtons();
  }

  function paintHistory() {
    historyList.replaceChildren();
    if (!history.length) {
      historyList.append(node("p", "muted", "Earlier broadcasts will appear here."));
      return;
    }
    for (const revision of history) {
      const item = node("div", "history-row");
      const stamp = node("time", "", timeText(revision.updated_at));
      stamp.dateTime = revision.updated_at;
      const description = node("div", "history-description");
      description.append(stamp, node("span", "muted", "Published by " + revision.username));
      const restore = node("button", "button button-light", "Restore");
      restore.type = "button";
      restore.addEventListener("click", () => restoreRevision(revision.number));
      item.append(description, restore);
      historyList.append(item);
    }
  }

  function paintAttachments() {
    imageList.replaceChildren();
    images.forEach((image, index) => {
      const item = node("li", "image-row");
      const thumbnail = node("img");
      thumbnail.alt = "";
      thumbnail.src = "/api/images/" + image.id;
      const label = node("label", "visually-hidden", "Description for image " + (index + 1));
      const field = node("input");
      field.type = "text";
      field.id = "image-description-" + index;
      label.htmlFor = field.id;
      field.placeholder = "Image description";
      field.maxLength = 200;
      field.value = image.alt;
      field.addEventListener("input", () => {
        image.alt = field.value;
        changed();
      });
      const remove = node("button", "remove-image", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove image " + (index + 1));
      remove.addEventListener("click", () => {
        images.splice(index, 1);
        paintAttachments();
        changed();
      });
      item.append(thumbnail, label, field, remove);
      imageList.append(item);
    });
  }

  function changed() {
    edits += 1;
    retry = false;
    autosave.textContent = "Unsaved changes";
    paintPreview();
    clearTimeout(pendingTimer);
    if (!draftConflict) pendingTimer = setTimeout(() => { flush(); }, 650);
  }

  function updateCurrent(next) {
    if (next && next.revision >= current.revision) {
      current = next;
      paintRoom();
    }
  }

  function markConflict(error) {
    if (!(error instanceof RequestError && error.status === 409)) return false;
    if (error.data.draft) draftConflict = error.data.draft;
    updateCurrent(error.data.room);
    paintConflict();
    return true;
  }

  async function flush() {
    clearTimeout(pendingTimer);
    if (saving) {
      if (!await saving) return false;
      return flush();
    }
    if (draftConflict) return false;
    if (saved === edits) return true;
    const target = edits;
    autosave.textContent = "Saving draft…";
    saving = (async () => {
      try {
        draft = await request(endpoint(id, "draft"), {
          method: "PUT", json: {...localNote(), serial: draft.serial},
        });
        saved = target;
        autosave.textContent = saved === edits ? "Draft saved" : "Unsaved changes";
        paintConflict();
        return true;
      } catch (error) {
        const conflictFound = markConflict(error);
        retry = !conflictFound;
        autosave.textContent = conflictFound ? "Draft needs review" : "Draft not saved · retrying";
        if (error instanceof RequestError && error.status === 401) {
          retry = false;
          autosave.textContent = "Session expired · sign in in another tab to save";
          report(error);
        } else if (error instanceof RequestError && error.status >= 400 && error.status < 500 && !conflictFound) {
          retry = false;
          autosave.textContent = "Draft not saved";
          report(error);
        }
        return false;
      }
    })();
    let finished;
    try {
      finished = await saving;
    } finally {
      saving = null;
    }
    return finished && (edits === saved || await flush());
  }

  function readOnlyNote(target, note) {
    const box = node("div", "dialog-note note-content");
    renderNote(box, note, "The note is empty", "");
    target.append(box);
  }

  async function refreshEditor() {
    if (busy || document.hidden) return;
    try {
      const response = await request(endpoint(id));
      if (busy || response.room.revision < current.revision) return;
      updateCurrent(response.room);
      history = response.history;
      paintHistory();
    } catch {
      // Leave the latest known room visible during connection trouble.
    }
  }

  async function review() {
    if (busy || dialog.open) return;
    if (draftConflict) {
      const previous = draftConflict;
      const accepted = await ask("Review the saved draft", "This is the version saved in your other tab. Keep the text and images in this tab to replace that draft.",
        "Keep this tab’s draft", target => readOnlyNote(target, previous));
      if (accepted) {
        draft = previous;
        draftConflict = null;
        paintConflict();
        if (saved === edits) edits += 1;
        await flush();
      }
      return;
    }
    if (!await flush()) return;
    const reviewed = current;
    if (!await ask("Review the live screen", "Another broadcast is on this screen. Review it before keeping your draft for a new publish.",
      "Keep my draft", target => readOnlyNote(target, reviewed))) return;
    try {
      draft = await request(endpoint(id, "rebase"), {
        method: "POST", json: {base: reviewed.revision, serial: draft.serial},
      });
      paintConflict();
      showToast("Draft ready. Click Publish when you want it on screen.");
    } catch (error) {
      markConflict(error);
      report(error);
    }
  }

  async function publishDraft() {
    if (busy || uploading || dialog.open) return;
    if (!await flush()) {
      if (draftConflict) await review();
      return;
    }
    if (busy || uploading) return;
    if (current.revision > draft.base) {
      await review();
      return;
    }
    const allowEmpty = !textArea.value.trim() && !images.length;
    if (allowEmpty && !await ask("Clear the screen?", "This publishes a blank note to " + roomName(id) + ".", "Clear screen")) return;
    if (busy || uploading || edits !== saved) return;
    busy = true;
    textArea.readOnly = true;
    paintButtons();
    try {
      const result = await request(endpoint(id, "publish"), {
        method: "POST", json: {serial: draft.serial, allowEmpty},
      });
      draft = result.draft;
      textArea.value = draft.text;
      images = draft.images;
      edits = saved = 0;
      autosave.textContent = "Draft saved";
      paintAttachments();
      paintPreview();
      updateCurrent(result.room);
      showToast("Broadcast published to " + roomName(id) + ".");
    } catch (error) {
      markConflict(error);
      report(error);
    } finally {
      busy = false;
      textArea.readOnly = false;
      paintButtons();
      refreshEditor();
    }
  }

  async function restoreRevision(number) {
    if (busy || dialog.open) return;
    const reviewed = current.revision;
    if (!await ask("Restore this broadcast?", "The selected broadcast will replace what’s on " + roomName(id) + ".", "Restore broadcast")) return;
    busy = true;
    paintButtons();
    try {
      const restored = await request(endpoint(id, "restore"), {
        method: "POST", json: {revision: number, base: reviewed},
      });
      updateCurrent(restored);
      showToast("Previous broadcast restored.");
    } catch (error) {
      markConflict(error);
      report(error);
    } finally {
      busy = false;
      paintButtons();
      refreshEditor();
    }
  }

  async function addImages(files) {
    if (busy || uploading || !files.length) return;
    const space = 8 - images.length;
    if (files.length > space) showToast("A note can contain up to eight images.", true);
    if (!space) return;
    uploading = true;
    paintButtons();
    let added = 0;
    const failures = [];
    autosave.textContent = "Uploading images…";
    for (const file of Array.from(files).slice(0, space)) {
      try {
        const upload = await prepareImage(file, uploadLimit);
        const uploaded = await request("/api/images", {
          method: "POST", headers: {"Content-Type": "application/octet-stream"}, body: upload, timeout: 30000,
        });
        images.push({id: uploaded.id, alt: file.name.replace(/\.[^.]+$/, "").slice(0, 200)});
        added += 1;
      } catch (error) {
        failures.push(error instanceof RequestError ? error.message : "An image couldn’t upload. Try again.");
      }
    }
    uploading = false;
    filePicker.value = "";
    paintButtons();
    if (added) {
      paintAttachments();
      changed();
      await flush();
    } else {
      autosave.textContent = draftConflict ? "Draft needs review" : saved === edits ? "Draft saved" : "Unsaved changes";
    }
    if (failures.length) showToast(failures[0], true);
  }

  async function navigate(done) {
    if (busy || uploading) {
      showToast("Wait for the current update to finish.", true);
      return;
    }
    if (await flush()) {
      done();
    } else if (!dialog.open && await ask("Leave this page?", "The newest changes in this tab are still unsaved.", "Leave page")) {
      edits = saved;
      retry = false;
      done();
    }
  }

  textArea.addEventListener("input", changed);
  textArea.addEventListener("paste", event => {
    const files = event.clipboardData.files;
    if (!files.length) return;
    event.preventDefault();
    addImages(files);
  });

  for (const button of app.querySelectorAll("[data-format]")) {
    button.addEventListener("click", () => {
      if (busy) return;
      const start = textArea.selectionStart;
      const end = textArea.selectionEnd;
      const selected = textArea.value.slice(start, end);
      const format = button.dataset.format;
      let replaced = false;
      if (format === "bold" || format === "italic") {
        const marker = format === "bold" ? "**" : "_";
        if (textArea.value.length + marker.length * 2 <= textArea.maxLength) {
          textArea.setRangeText(marker + selected + marker, start, end);
          textArea.setSelectionRange(start + marker.length, end + marker.length);
          replaced = true;
        }
      } else {
        const line = textArea.value.lastIndexOf("\n", start - 1) + 1;
        const marker = format === "heading" ? "# " : "- ";
        const replacement = marker + textArea.value.slice(line, end).replaceAll("\n", "\n" + marker);
        if (textArea.value.length - (end - line) + replacement.length <= textArea.maxLength) {
          textArea.setRangeText(replacement, line, end, "end");
          replaced = true;
        }
      }
      if (replaced) changed();
      textArea.focus();
    });
  }

  for (const event of ["dragenter", "dragover"]) {
    dropArea.addEventListener(event, drag => {
      drag.preventDefault();
      if (!busy && !uploading) dropArea.classList.add("dragging");
    });
  }
  dropArea.addEventListener("dragleave", event => {
    if (!dropArea.contains(event.relatedTarget)) dropArea.classList.remove("dragging");
  });
  dropArea.addEventListener("drop", event => {
    event.preventDefault();
    dropArea.classList.remove("dragging");
    addImages(event.dataTransfer.files);
  });
  document.addEventListener("dragover", event => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", event => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  dropArea.addEventListener("click", () => filePicker.click());
  filePicker.addEventListener("change", () => addImages(filePicker.files));

  copyPublished.addEventListener("click", async () => {
    const live = current;
    if ((textArea.value || images.length) && !await ask("Replace your draft?", "This copies the live broadcast into your draft.", "Copy published note")) return;
    textArea.value = live.text;
    images = live.images.map(image => ({...image}));
    paintAttachments();
    changed();
  });
  status.addEventListener("change", async () => {
    const desired = status.value;
    status.disabled = true;
    try {
      updateCurrent(await request(endpoint(id, "status"), {method: "POST", json: {status: desired}}));
      showToast(roomName(id) + " is marked " + (desired === "available" ? "available." : "in use."));
    } catch (error) {
      status.value = current.status;
      report(error);
    } finally {
      paintButtons();
    }
  });

  for (const button of publishButtons) button.addEventListener("click", publishDraft);
  togglePreview.addEventListener("click", switchMobileMode);
  new ResizeObserver(checkPreviewFit).observe(preview);
  conflict.querySelector("button").addEventListener("click", review);
  app.querySelector("#logout").addEventListener("click", () => navigate(signOut));
  app.addEventListener("click", event => {
    const link = event.target.closest("a[href]");
    if (!link || link.target === "_blank" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (edits !== saved || uploading || busy) {
      event.preventDefault();
      navigate(() => location.assign(link.href));
    }
  });
  window.addEventListener("beforeunload", event => {
    if (edits !== saved || uploading || busy) event.preventDefault();
  });
  window.addEventListener("online", () => { refreshEditor(); if (retry) flush(); });
  setInterval(() => {
    refreshEditor();
    if (retry) flush();
    paintTime(lastPublished, current.updatedAt);
  }, 5000);
  paintRoom();
  paintAttachments();
  paintPreview();
  paintHistory();
}

async function start() {
  const path = location.pathname.replace(/\/$/, "");
  const viewer = path.match(/^\/rooms\/([1-3])$/);
  if (viewer) return showViewer(Number(viewer[1]));
  if (!path.startsWith("/admin")) return overview();
  const roomMatch = path.match(/^\/admin\/([1-3])$/);
  const id = roomMatch ? Number(roomMatch[1]) : null;
  app.innerHTML = header("admin") + '<main id="main" class="shell route-message"><p>Loading the admin panel…</p></main>' + footer();
  try {
    const {username, maxImageBytes = MAX_SOURCE_IMAGE_BYTES} = await request("/api/session");
    if (!username) return showLogin(id);
    if (id) return editorPage(id, username, await request(endpoint(id)), maxImageBytes);
    overview(true, username);
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) return showLogin(id);
    app.querySelector("main").innerHTML = '<h1>Admin panel unavailable</h1><p>Couldn’t connect to the board.</p><button class="button button-primary">Try again</button>';
    app.querySelector("main button").addEventListener("click", () => location.reload());
  }
}

start();
