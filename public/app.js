// The board's page. Keeping the board consistent is LiveRoom's job
// (live/room.js); this file renders room.view() and turns input into changes.
import { applyOp, BOARD_SIZE, COLORS, truncate } from "./board.js";
import { Bot, KINDS, MAX_BOTS, SPEEDS } from "./bots.js";
import { LiveRoom } from "./live/room.js";

const $ = (id) => document.getElementById(id);

const local = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private windows and blocked storage: the name just won't be remembered.
    }
  },
};

const ANIMALS = ["Otter", "Heron", "Lynx", "Gecko", "Puffin", "Ibex", "Koala", "Marten", "Newt", "Quokka"];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// The server only takes ids like this, so anything else gets the demo board.
const requested = (new URLSearchParams(location.search).get("board") ?? "").toLowerCase();
const boardId = /^[\w-]{1,40}$/.test(requested) ? requested : "demo";
const me = local.get("live-board:me") ?? { name: `${pick(ANIMALS)} ${Math.floor(Math.random() * 90 + 10)}`, color: pick(COLORS) };

local.set("live-board:me", me);

// Other clients' presence comes from the network, so only known colors reach
// the page's styles.
const safeColor = (color) => (COLORS.includes(color) ? color : COLORS[0]);

const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`;
const room = new LiveRoom({
  url,
  room: boardId,
  author: me.name,
  apply: applyOp,
});

let peers = [];
const activity = [];

// ---------------------------------------------------------------- rendering

const board = $("board");
const noteElements = new Map();
let dragging = null;

const render = () => {
  const view = room.view();

  if (!view) {
    return;
  }

  const unconfirmed = new Set(room.pending.map(({ op }) => op.id));

  for (const [id, element] of noteElements) {
    if (!view.notes[id]) {
      element.classList.add("gone");
      setTimeout(() => element.remove(), 300);
      noteElements.delete(id);
    }
  }

  for (const [id, note] of Object.entries(view.notes)) {
    const element = noteElements.get(id) ?? createNote(id);
    const text = element.querySelector(".text");

    if (dragging?.id !== id) {
      element.style.left = `${note.x}px`;
      element.style.top = `${note.y}px`;
    }
    element.style.background = note.color;
    element.classList.toggle("pending", unconfirmed.has(id));

    // Don't overwrite what someone is typing.
    if (document.activeElement !== text && text.textContent !== note.text) {
      text.textContent = note.text;
    }
  }

  $("version").textContent = room.confirmed.version ?? "–";
  $("pending").textContent = room.pending.length;
  $("pending-chip").toggleAttribute("data-some", room.pending.length > 0);
};

const createNote = (id) => {
  const element = document.createElement("div");
  const text = document.createElement("div");
  const remove = document.createElement("button");

  element.className = "note";
  // Each note leans a little, up to 4° either way, the same in every tab, so
  // notes piled in one spot still show as a pile.
  element.style.setProperty("--tilt", `${((hash(id) % 81) - 40) / 10}deg`);
  text.className = "text";
  text.contentEditable = "plaintext-only";
  remove.className = "delete";
  remove.textContent = "×";
  remove.title = "Delete";
  element.append(remove, text);

  remove.addEventListener("click", () => room.change({ kind: "delete", id }));
  // Only what the person typed is sent: while the note has focus, render()
  // leaves its text alone, so it can be behind someone else's edit.
  let before;

  text.addEventListener("focus", () => (before = text.textContent));
  text.addEventListener("blur", () => {
    // Cut to the board's limit here too: a long paste would otherwise make a
    // message over the server's 64 KB limit, which closes the connection.
    if (text.textContent !== before && room.view()?.notes[id]) {
      room.change({ kind: "edit", id, text: truncate(text.textContent) });
    }
    render();
  });

  element.addEventListener("pointerdown", (event) => {
    if (event.target === element) {
      dragging = { id, dx: event.offsetX, dy: event.offsetY };
      element.classList.add("dragging");
      element.setPointerCapture(event.pointerId);
    }
  });
  element.addEventListener("pointermove", (event) => {
    if (dragging?.id === id) {
      const point = boardPoint(event);

      element.style.left = `${point.x - dragging.dx}px`;
      element.style.top = `${point.y - dragging.dy}px`;
    }
  });
  element.addEventListener("pointerup", () => {
    if (dragging?.id === id) {
      dragging = null;
      element.classList.remove("dragging");
      room.change({ kind: "move", id, x: parseFloat(element.style.left), y: parseFloat(element.style.top) });
    }
  });

  board.append(element);
  noteElements.set(id, element);

  return element;
};

const renderPeers = () => {
  const people = [{ data: { name: `${me.name} (you)`, color: me.color }, instance: room.ready ? room.server.instance : "–" }, ...peers];

  $("people").replaceChildren(
    ...people.map(({ data, instance }) => {
      const item = document.createElement("li");

      item.innerHTML = `<span class="swatch"></span><span></span> <small></small>`;
      item.children[0].style.background = safeColor(data.color);
      item.children[1].textContent = data.bot === true ? `${data.name} (bot)` : data.name;
      item.children[2].textContent = `on ${instance}`;

      return item;
    }),
  );
};

const VERBS = { add: "added a note", move: "moved a note", edit: "edited a note", delete: "deleted a note" };

const log = (text, detail = "") => {
  const item = document.createElement("li");
  const small = document.createElement("small");

  item.textContent = text;
  small.textContent = detail;
  item.append(small);
  $("activity").prepend(item);
  activity.push(item);
  if (activity.length > 40) {
    activity.shift().remove();
  }
};

// A note someone else changed lights up in their color for a moment.
const flash = (id, author) => {
  const element = noteElements.get(id);
  const peer = peers.find(({ data }) => data.name === author);

  if (element) {
    element.style.setProperty("--by", peer ? safeColor(peer.data.color) : hue(author));
    element.classList.remove("flash");
    void element.offsetWidth; // restarts the animation
    element.classList.add("flash");
  }
};

const hash = (text) => {
  let result = 0;

  for (const char of text) {
    result = (result * 31 + char.charCodeAt(0)) >>> 0;
  }

  return result;
};

const hue = (text) => `hsl(${hash(text) % 360} 70% 50%)`;

let toastTimer;

const toast = (text) => {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3_000);
};

// ---------------------------------------------------------------- the room

const STATUS = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", offline: "Offline" };

room
  .on("change", render)
  .on("status", ({ status, detail }) => {
    $("status").dataset.state = status;
    $("status").querySelector("b").textContent = STATUS[status];
    $("status").title = detail;
    renderPeers();
  })
  .on("server", (server) => {
    if (server.instance !== $("instance").textContent) {
      log(`Connected to instance ${server.instance}`);
    }
    $("instance").textContent = server.instance;
    $("deploy").textContent = server.deploy.slice(0, 8);
    $("instance-dot").style.background = hue(server.instance);
    $("deploy-dot").style.background = hue(server.deploy);
  })
  .on("event", ({ seq, author, instance, op }) => {
    log(`${author} ${VERBS[op.kind] ?? op.kind}`, ` v${seq} via ${instance}`);
    if (author !== me.name) {
      // After the render that follows, so a new note has its element.
      queueMicrotask(() => flash(op.id, author));
    }
  })
  .on("reject", ({ reason }) => toast(reason))
  .on("presence", (list) => {
    peers = list;
    renderPeers();
  });

// ---------------------------------------------------------------- input

const boardPoint = (event) => {
  const rect = board.getBoundingClientRect();

  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};

const addNote = (x, y) => room.change({ kind: "add", id: crypto.randomUUID().slice(0, 8), x, y, text: "", color: pick(COLORS) });

board.addEventListener("dblclick", (event) => {
  if (event.target === board) {
    const point = boardPoint(event);

    addNote(point.x - 90, point.y - 20);
  }
});

$("add").addEventListener("click", () => {
  const viewport = $("viewport");

  addNote(
    Math.min(viewport.scrollLeft + viewport.clientWidth / 2 - 90 + Math.random() * 60, BOARD_SIZE.width - 200),
    Math.min(viewport.scrollTop + viewport.clientHeight / 2 - 60 + Math.random() * 60, BOARD_SIZE.height - 140),
  );
});

$("offline").addEventListener("click", () => {
  const offline = !room.offline;

  room.setOffline(offline);
  $("offline").setAttribute("aria-pressed", String(offline));
  $("offline").textContent = offline ? "Go online" : "Go offline";
});

// Over the socket rather than a fetch, so it reaches the instance this tab is
// connected to, which after a deploy isn't the one new requests go to.
$("crash").addEventListener("click", () => {
  if ($("crash").getAttribute("aria-disabled") === "true") {
    toast("Crashing is turned off on this site");
    return;
  }
  toast(room.send({ type: "crash" }) ? `Crashing instance ${room.server.instance}` : "Not connected to an instance");
});

// The button stays off unless the server says crashing is allowed.
fetch("/api/config")
  .then((response) => response.json())
  .then(({ allowCrash }) => {
    if (allowCrash) {
      $("crash").setAttribute("aria-disabled", "false");
      $("crash-tip").textContent = "Exits the instance this tab is connected to, with no graceful shutdown";
    }
  })
  .catch(() => {});

// ---------------------------------------------------------------- simulated users

const bots = new Map();
let speed = "busy";

const botRow = (bot) => {
  const item = document.createElement("li");
  const toggle = document.createElement("button");
  const remove = document.createElement("button");

  item.className = "bot";
  item.innerHTML = `<div><span class="swatch"></span><b></b> <i class="state"></i> <small class="where"></small></div><small class="counts"></small>`;
  item.querySelector(".swatch").style.background = bot.color;
  item.querySelector("b").textContent = `${KINDS[bot.kind].icon} ${bot.name}`;
  toggle.className = "toggle";
  toggle.addEventListener("click", () => bot.room.setOffline(!bot.room.offline));
  remove.textContent = "×";
  remove.title = "Remove";
  remove.addEventListener("click", () => removeBot(bot));
  item.firstChild.append(toggle, remove);
  $("bots").append(item);

  return item;
};

const renderBots = () => {
  for (const [bot, item] of bots) {
    const { room } = bot;

    item.querySelector(".state").dataset.state = room.status;
    item.querySelector(".state").title = room.status;
    item.querySelector(".where").textContent = room.ready ? `on ${room.server.instance}` : room.status;
    item.querySelector(".counts").textContent = `${room.pending.length} unsent · ${bot.committed} committed · ${bot.rejected} rejected`;
    // Shows where the user is now; clicking switches it.
    const toggle = item.querySelector(".toggle");

    toggle.textContent = room.offline ? "Offline" : "Online";
    toggle.dataset.on = String(!room.offline);
    toggle.title = room.offline ? "Click to bring this user back online" : "Click to take this user offline";
  }
  for (const button of $("invite").children) {
    button.disabled = bots.size >= MAX_BOTS;
  }
};

const removeBot = (bot) => {
  bot.remove();
  bots.get(bot).remove();
  bots.delete(bot);
  renderBots();
};

for (const [kind, { label, icon, about }] of Object.entries(KINDS)) {
  const button = document.createElement("button");

  button.textContent = `+ ${icon} ${label}`;
  button.title = `Add a ${label} user. ${about}.`;
  button.addEventListener("click", () => {
    const bot = new Bot({ url, room: boardId, kind, speed });

    bot.onleave = () => {
      toast(`${bot.name} left (simulated users leave after 10 minutes)`);
      removeBot(bot);
    };
    bots.set(bot, botRow(bot));
    renderBots();
  });
  $("invite").append(button);
}

for (const name of Object.keys(SPEEDS)) {
  const button = document.createElement("button");

  button.textContent = name[0].toUpperCase() + name.slice(1);
  button.setAttribute("aria-pressed", String(name === speed));
  button.addEventListener("click", () => {
    speed = name;
    bots.forEach((_, bot) => (bot.speed = name));
    for (const other of $("speed").querySelectorAll("button")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
  });
  $("speed").append(button);
}

setInterval(renderBots, 250);

$("board-name").textContent = boardId;
room.setPresence(me);
room.open();
