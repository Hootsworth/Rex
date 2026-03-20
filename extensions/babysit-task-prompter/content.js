(() => {
  if (window.__rexBabysitPrompterLoaded) return;
  window.__rexBabysitPrompterLoaded = true;

  const ROOT_ID = "rex-babysit-prompt-root";
  const STYLE_ID = "rex-babysit-prompt-style";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        right: 18px;
        top: 16px;
        width: min(340px, 90vw);
        z-index: 2147483647;
        font-family: "Segoe UI", Tahoma, sans-serif;
        color: #0f172a;
      }
      #${ROOT_ID} .rex-card {
        background: rgba(255, 255, 255, 0.94);
        border: 1px solid rgba(17, 24, 39, 0.08);
        border-radius: 12px;
        box-shadow: 0 12px 28px rgba(2, 6, 23, 0.12);
        backdrop-filter: blur(8px);
        padding: 10px 10px 9px 10px;
      }
      #${ROOT_ID} .rex-title {
        margin: 0;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .08em;
        text-transform: uppercase;
        color: #64748b;
      }
      #${ROOT_ID} .rex-task {
        margin: 6px 0 4px 0;
        font-size: 14px;
        line-height: 1.32;
        font-weight: 600;
      }
      #${ROOT_ID} .rex-note {
        margin: 0 0 8px 0;
        font-size: 12px;
        color: #475569;
      }
      #${ROOT_ID} .rex-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
      #${ROOT_ID} button {
        border: 1px solid rgba(15,23,42,.12);
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        background: #f8fafc;
        color: #0f172a;
      }
      #${ROOT_ID} .rex-which { background: #0f172a; color: #f8fafc; border-color: #0f172a; }
      #${ROOT_ID} .rex-yes { background: #ecfeff; color: #155e75; border-color: #67e8f9; }
      #${ROOT_ID} .rex-no { background: #fff1f2; color: #9f1239; border-color: #fecdd3; }
      #${ROOT_ID} .rex-foot {
        margin-top: 6px;
        font-size: 11px;
        color: #6b7280;
      }
      #${ROOT_ID} .rex-swoosh {
        display: inline-block;
        opacity: 0;
        transform: translateX(16px) skewX(-8deg);
        filter: blur(1px);
        animation: rexSwoosh .42s cubic-bezier(.19,.84,.31,1) forwards;
      }
      #${ROOT_ID} .rex-note.rex-swoosh { animation-delay: .06s; }
      @keyframes rexSwoosh {
        from { opacity: 0; transform: translateX(16px) skewX(-8deg); filter: blur(1px); }
        to { opacity: 1; transform: translateX(0) skewX(0); filter: blur(0); }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function emitResult(payload) {
    try {
      chrome.runtime.sendMessage({
        type: "babysit:promptResult",
        ...payload
      });
    } catch {
      // Non-fatal.
    }
  }

  function removePrompt() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.remove();
  }

  function showPrompt(payload = {}) {
    ensureStyle();
    removePrompt();

    const taskId = String(payload.taskId || payload.id || "task");
    const task = String(payload.task || payload.message || "Please complete this step.");
    const note = String(payload.note || "Confirm when done, or ask for a repeat.");

    const root = document.createElement("div");
    root.id = ROOT_ID;

    const card = document.createElement("div");
    card.className = "rex-card";

    const title = document.createElement("h4");
    title.className = "rex-title";
    title.textContent = "Rex Babysit Request";

    const taskText = document.createElement("p");
    taskText.className = "rex-task rex-swoosh";
    taskText.textContent = task;

    const noteText = document.createElement("p");
    noteText.className = "rex-note rex-swoosh";
    noteText.textContent = note;

    const actions = document.createElement("div");
    actions.className = "rex-actions";

    const whichBtn = document.createElement("button");
    whichBtn.className = "rex-which";
    whichBtn.textContent = "which move?";
    whichBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("rex-babysit-replay-move", {
        detail: { taskId }
      }));
      emitResult({ result: "which-move", taskId, note: "User asked to replay the move." });
    });

    const yesBtn = document.createElement("button");
    yesBtn.className = "rex-yes";
    yesBtn.textContent = "yes";
    yesBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("rex-babysit-feedback", {
        detail: {
          taskId,
          verdict: "yes",
          note: "Marked as useful/important move"
        }
      }));
      emitResult({ result: "yes", taskId, note: "User marked move as useful." });
      removePrompt();
    });

    const noBtn = document.createElement("button");
    noBtn.className = "rex-no";
    noBtn.textContent = "no";
    noBtn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("rex-babysit-feedback", {
        detail: {
          taskId,
          verdict: "no",
          note: "Marked as not useful"
        }
      }));
      emitResult({ result: "no", taskId, note: "User marked move as not useful." });
      removePrompt();
    });

    const foot = document.createElement("div");
    foot.className = "rex-foot";
    foot.textContent = `Task ID: ${taskId}`;

    actions.appendChild(whichBtn);
    actions.appendChild(yesBtn);
    actions.appendChild(noBtn);

    card.appendChild(title);
    card.appendChild(taskText);
    card.appendChild(noteText);
    card.appendChild(actions);
    card.appendChild(foot);
    root.appendChild(card);
    document.documentElement.appendChild(root);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "babysit:showPrompt") {
      showPrompt(message.payload || {});
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  window.addEventListener("rex-babysit-prompt", (event) => {
    showPrompt(event?.detail || {});
  });
})();
