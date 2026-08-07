"use client";

import {
  type DeviceLinkEnvelope,
  type DeviceLinkState,
  DeviceLink,
  invitationFromLocation,
  pairingCodeFromLocation,
} from "@/lib/device-link";
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Link2,
  LockKeyhole,
  Share2,
  Tablet,
  X,
} from "lucide-react";

export interface DeviceLinkPanelProps {
  /** Pass a shared instance when the canvas also needs to call link.send(...). */
  deviceLink?: DeviceLink;
  className?: string;
  initialMode?: "host" | "join";
  onLinkReady?: (link: DeviceLink) => void;
  onMessage?: (message: DeviceLinkEnvelope) => void;
  onStateChange?: (state: DeviceLinkState) => void;
  onClose?: () => void;
}

type PanelMode = "choose" | "host" | "join";

const EMPTY_STATE: DeviceLinkState = {
  role: null,
  phase: "idle",
  transport: null,
  pairingCode: null,
  sessionId: null,
  joinUrl: null,
  inviteToken: null,
  answerToken: null,
  peerLabel: null,
  statusMessage: null,
  error: null,
};

function copyFallback(value: string): boolean {
  if (typeof document === "undefined") return false;
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (!copyFallback(value)) throw new Error("Copy is unavailable. Select the text and copy it manually.");
}

export function DeviceLinkPanel({
  deviceLink,
  className = "",
  initialMode,
  onLinkReady,
  onMessage,
  onStateChange,
  onClose,
}: DeviceLinkPanelProps) {
  const [ownedLink] = useState(() => new DeviceLink({ deviceLabel: "iPad companion" }));
  const link = deviceLink ?? ownedLink;

  const subscribe = useCallback((listener: () => void) => link.subscribe(listener), [link]);
  const getSnapshot = useCallback(() => link.getState(), [link]);
  const state = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_STATE);

  const [mode, setMode] = useState<PanelMode>(initialMode ?? "choose");
  const [joinInput, setJoinInput] = useState("");
  const [answerInput, setAnswerInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    onLinkReady?.(link);
  }, [link, onLinkReady]);

  useEffect(() => {
    return () => {
      if (!deviceLink) link.close();
    };
  }, [deviceLink, link]);

  useEffect(() => {
    if (initialMode) return;
    const timer = window.setTimeout(() => {
      const invite = invitationFromLocation();
      const code = pairingCodeFromLocation();
      if (invite || code) {
        setJoinInput(invite ?? code ?? "");
        setMode("join");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialMode]);

  useEffect(() => {
    if (!onMessage) return;
    return link.onMessage(onMessage);
  }, [link, onMessage]);

  useEffect(() => {
    onStateChange?.(state);
  }, [onStateChange, state]);

  const perform = async (action: () => Promise<void> | void) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The device action did not complete.");
    } finally {
      setBusy(false);
    }
  };

  const markCopied = async (key: string, value: string) => {
    try {
      await copyText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1_800);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Copy failed.");
    }
  };

  const share = async (title: string, text: string, url?: string) => {
    if (navigator.share) {
      try {
        await navigator.share({ title, text, ...(url ? { url } : {}) });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await markCopied("shared", url ?? text);
  };

  const startHost = () =>
    perform(async () => {
      setMode("host");
      await link.createHostInvite();
    });

  const join = () =>
    perform(async () => {
      const value = joinInput.trim();
      if (!value) throw new Error("Paste an invitation link or enter a pairing code.");
      if (value.includes("device-link=") || value.length > 64) {
        await link.acceptInvite(value);
      } else {
        link.joinWithCode(value);
      }
    });

  const acceptAnswer = () =>
    perform(async () => {
      await link.acceptAnswer(answerInput);
      setAnswerInput("");
    });

  const reset = () => {
    link.disconnect();
    setMode("choose");
    setJoinInput("");
    setAnswerInput("");
    setActionError(null);
  };

  const connected = state.phase === "connected";
  const visibleError = actionError ?? state.error;

  return (
    <section className={`device-link-panel ${className}`} aria-label="Connect an iPad">
      <style>{PANEL_STYLES}</style>
      <header className="device-link-header">
        <span className="device-link-header-icon"><Link2 aria-hidden="true" /></span>
        <span>
          <strong>Connect a device</strong>
          <small>Use an iPad as your drawing surface</small>
        </span>
        {onClose ? (
          <button className="device-link-close" type="button" onClick={onClose} aria-label="Close">
            <X aria-hidden="true" />
          </button>
        ) : null}
      </header>

      {connected ? (
        <div className="device-link-connected" aria-live="polite">
          <span className="device-link-success"><Check aria-hidden="true" /></span>
          <div>
            <strong>Device connected</strong>
            <p>{state.statusMessage}</p>
            <span className="device-link-chip">
              <i /> {state.transport === "webrtc" ? "Peer-to-peer" : "Local tab"}
            </span>
          </div>
          <button className="device-link-secondary danger" type="button" onClick={reset}>
            Disconnect
          </button>
        </div>
      ) : null}

      {!connected && mode === "choose" ? (
        <div className="device-link-body">
          <p className="device-link-intro">
            Pair without an account. Pencil strokes travel directly between your devices whenever WebRTC can connect.
          </p>
          <button className="device-link-choice primary-choice" type="button" onClick={startHost} disabled={busy}>
            <span className="device-link-choice-icon"><Tablet aria-hidden="true" /></span>
            <span><strong>Connect my iPad</strong><small>Create a private invitation</small></span>
            <ArrowRight className="device-link-arrow" aria-hidden="true" />
          </button>
          <button className="device-link-choice" type="button" onClick={() => setMode("join")} disabled={busy}>
            <span className="device-link-choice-icon"><Link2 aria-hidden="true" /></span>
            <span><strong>Join a whiteboard</strong><small>Use an invite link or local code</small></span>
            <ArrowRight className="device-link-arrow" aria-hidden="true" />
          </button>
          <p className="device-link-privacy"><LockKeyhole aria-hidden="true" /> No camera, microphone, Bluetooth, or account permission is needed.</p>
        </div>
      ) : null}

      {!connected && mode === "host" ? (
        <div className="device-link-body" aria-busy={busy}>
          {state.phase === "creating" || busy && !state.pairingCode ? (
            <div className="device-link-loading"><span /> Preparing the secure link…</div>
          ) : null}

          {state.pairingCode ? (
            <>
              <div className="device-link-step">
                <span>1</span>
                <div><strong>Open this invitation on the iPad</strong><small>AirDrop, Messages, or copy the link.</small></div>
              </div>
              <div className="device-link-code" aria-label={`Pairing code ${state.pairingCode}`}>
                {state.pairingCode.split("").map((character, index) => <b key={`${character}-${index}`}>{character}</b>)}
              </div>
              {state.joinUrl ? (
                <div className="device-link-actions">
                  <button type="button" onClick={() => markCopied("invite", state.joinUrl!)}>
                    {copied === "invite" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    {copied === "invite" ? "Copied" : "Copy link"}
                  </button>
                  <button type="button" onClick={() => share("Whiteboard iPad invitation", "Open this invitation to connect to my whiteboard.", state.joinUrl!)}>
                    <Share2 aria-hidden="true" /> Share
                  </button>
                </div>
              ) : null}

              {state.inviteToken ? (
                <>
                  <div className="device-link-divider"><span>then</span></div>
                  <div className="device-link-step">
                    <span>2</span>
                    <div><strong>Paste the answer from the iPad</strong><small>This completes the encrypted WebRTC handshake.</small></div>
                  </div>
                  <textarea
                    className="device-link-textarea"
                    rows={3}
                    value={answerInput}
                    onChange={(event) => setAnswerInput(event.target.value)}
                    placeholder="Paste the iPad answer code"
                    spellCheck={false}
                    aria-label="iPad answer code"
                  />
                  <button className="device-link-primary" type="button" onClick={acceptAnswer} disabled={busy || !answerInput.trim()}>
                    {busy ? "Connecting…" : "Finish connection"}
                  </button>
                </>
              ) : null}
            </>
          ) : null}

          {state.statusMessage ? <p className="device-link-note">{state.statusMessage}</p> : null}
          <button className="device-link-back" type="button" onClick={reset}><ArrowLeft aria-hidden="true" /> Back</button>
        </div>
      ) : null}

      {!connected && mode === "join" ? (
        <div className="device-link-body" aria-busy={busy}>
          {!state.answerToken ? (
            <>
              <label className="device-link-label" htmlFor="device-link-invite">Invitation link or pairing code</label>
              <textarea
                id="device-link-invite"
                className="device-link-textarea"
                rows={joinInput.length > 64 ? 4 : 2}
                value={joinInput}
                onChange={(event) => setJoinInput(event.target.value)}
                placeholder="Paste the host link, or enter its short code"
                spellCheck={false}
                autoCapitalize="characters"
              />
              <p className="device-link-help">
                A short code finds tabs in this browser. Different devices need the full invitation link.
              </p>
              <button className="device-link-primary" type="button" onClick={join} disabled={busy || !joinInput.trim()}>
                {busy ? "Preparing…" : "Join whiteboard"}
              </button>
            </>
          ) : (
            <>
              <span className="device-link-answer-ready"><Check aria-hidden="true" /></span>
              <h3 className="device-link-answer-title">One last step</h3>
              <p className="device-link-answer-copy">Send this answer back to the host. Keep this page open while they accept it.</p>
              <textarea className="device-link-textarea mono" rows={4} readOnly value={state.answerToken} aria-label="Answer code" />
              <div className="device-link-actions wide">
                <button type="button" onClick={() => markCopied("answer", state.answerToken!)}>
                  {copied === "answer" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied === "answer" ? "Copied" : "Copy answer"}
                </button>
                <button type="button" onClick={() => share("Whiteboard connection answer", state.answerToken!)}>
                  <Share2 aria-hidden="true" /> Send answer
                </button>
              </div>
            </>
          )}
          {state.statusMessage ? <p className="device-link-note">{state.statusMessage}</p> : null}
          <button className="device-link-back" type="button" onClick={reset}><ArrowLeft aria-hidden="true" /> Back</button>
        </div>
      ) : null}

      {visibleError ? <div className="device-link-error" role="alert">{visibleError}</div> : null}
    </section>
  );
}

const PANEL_STYLES = `
.device-link-panel{width:min(100%,430px);overflow:hidden;border:1px solid rgba(21,35,28,.12);border-radius:22px;background:#fff;color:#17211c;box-shadow:0 20px 60px rgba(25,45,35,.16);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.device-link-panel *{box-sizing:border-box}.device-link-panel button,.device-link-panel textarea{font:inherit}
.device-link-header{display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid #e9eeeb;background:#fbfcfb}.device-link-header>span:nth-child(2){display:flex;flex:1;flex-direction:column;gap:2px}.device-link-header strong{font-size:15px;letter-spacing:-.01em}.device-link-header small{color:#718078;font-size:12px}
.device-link-header-icon,.device-link-choice-icon{display:grid;place-items:center;width:36px;height:36px;flex:0 0 auto;border-radius:11px;background:#e6f5ec;color:#167448}.device-link-header-icon svg,.device-link-choice-icon svg{width:19px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.device-link-close{display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:#738078;cursor:pointer}.device-link-close svg{width:18px}.device-link-close:hover{background:#eef3f0;color:#17211c}
.device-link-body{padding:20px}.device-link-intro{margin:0 0 17px;color:#596860;font-size:13px;line-height:1.55}
.device-link-choice{display:flex;align-items:center;gap:13px;width:100%;margin-top:10px;padding:13px 14px;border:1px solid #dfe7e2;border-radius:14px;background:#fff;color:#1c2a23;text-align:left;cursor:pointer;transition:.16s ease}.device-link-choice:hover{border-color:#a9c7b7;transform:translateY(-1px);box-shadow:0 7px 20px rgba(31,63,46,.08)}.device-link-choice.primary-choice{border-color:#b8dfca;background:#f4fbf7}.device-link-choice>span:nth-child(2){display:flex;flex:1;flex-direction:column;gap:2px}.device-link-choice strong{font-size:13px}.device-link-choice small{color:#718078;font-size:11px}.device-link-arrow{width:17px;color:#839188}.device-link-choice:disabled{cursor:wait;opacity:.6}
.device-link-privacy{display:flex;align-items:flex-start;gap:7px;margin:17px 0 0;color:#87938d;font-size:10px;line-height:1.5}.device-link-privacy svg{width:12px;height:12px;flex:0 0 auto;margin-top:1px;color:#76a58c}
.device-link-step{display:flex;align-items:center;gap:10px;margin:0 0 13px}.device-link-step>span{display:grid;place-items:center;width:23px;height:23px;border-radius:50%;background:#172b21;color:#fff;font-size:11px;font-weight:700}.device-link-step>div{display:flex;flex-direction:column;gap:1px}.device-link-step strong{font-size:12px}.device-link-step small{font-size:10px;color:#7b8881}
.device-link-code{display:flex;justify-content:center;gap:6px;margin:12px 0 14px}.device-link-code b{display:grid;place-items:center;width:39px;height:47px;border:1px solid #dce6e0;border-radius:10px;background:#f5f8f6;color:#15231c;font-size:22px;letter-spacing:0;box-shadow:inset 0 1px 0 #fff}
.device-link-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}.device-link-actions button{display:flex;align-items:center;justify-content:center;gap:7px;padding:10px;border:1px solid #d8e3dc;border-radius:10px;background:#fff;color:#31433a;font-size:11px;font-weight:650;cursor:pointer}.device-link-actions button:hover{background:#f3f8f5}.device-link-actions svg,.device-link-primary svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.device-link-actions.wide{margin-top:9px}
.device-link-divider{display:flex;align-items:center;gap:8px;margin:19px 0}.device-link-divider:before,.device-link-divider:after{content:"";height:1px;flex:1;background:#e8eeea}.device-link-divider span{color:#9aa49f;font-size:9px;text-transform:uppercase;letter-spacing:.12em}
.device-link-textarea{display:block;width:100%;resize:vertical;border:1px solid #d8e2dc;border-radius:11px;background:#fbfcfb;color:#233129;padding:10px 11px;font-size:11px;line-height:1.45;outline:none}.device-link-textarea:focus{border-color:#65a883;box-shadow:0 0 0 3px rgba(70,155,110,.12)}.device-link-textarea.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;word-break:break-all}
.device-link-primary{width:100%;margin-top:10px;padding:11px 14px;border:0;border-radius:11px;background:#193d2b;color:#fff;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 7px 18px rgba(21,66,43,.18)}.device-link-primary:hover{background:#0f5231}.device-link-primary:disabled{cursor:not-allowed;opacity:.48;box-shadow:none}
.device-link-secondary{border:1px solid #d5dfda;border-radius:9px;background:#fff;padding:8px 10px;font-size:10px;font-weight:650;cursor:pointer}.device-link-secondary.danger{color:#a44444}.device-link-back{display:inline-flex;align-items:center;gap:4px;margin-top:14px;border:0;background:transparent;color:#6e7d75;font-size:10px;cursor:pointer}.device-link-back svg{width:12px}.device-link-back:hover{color:#183c2a}
.device-link-label{display:block;margin-bottom:7px;font-size:11px;font-weight:700}.device-link-help{margin:7px 2px 0;color:#829087;font-size:9.5px;line-height:1.45}.device-link-note{margin:13px 0 0;padding:9px 10px;border-radius:9px;background:#f3f7f4;color:#68766f;font-size:9.5px;line-height:1.5}
.device-link-error{margin:0 20px 18px;padding:10px 11px;border:1px solid #f1ceca;border-radius:10px;background:#fff5f3;color:#a13e36;font-size:10px;line-height:1.45}
.device-link-loading{display:flex;align-items:center;gap:9px;color:#65736b;font-size:11px}.device-link-loading span{width:14px;height:14px;border:2px solid #cbd9d1;border-top-color:#287c50;border-radius:50%;animation:device-link-spin .8s linear infinite}@keyframes device-link-spin{to{transform:rotate(360deg)}}
.device-link-connected{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;padding:20px}.device-link-connected p{margin:3px 0 8px;color:#6c7a72;font-size:10px}.device-link-success,.device-link-answer-ready{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;background:#dcf5e6;color:#137d46}.device-link-success svg,.device-link-answer-ready svg{width:21px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}.device-link-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border-radius:12px;background:#edf8f1;color:#26744a;font-size:9px;font-weight:650}.device-link-chip i{width:5px;height:5px;border-radius:50%;background:#2ba766;box-shadow:0 0 0 3px rgba(43,167,102,.13)}
.device-link-answer-ready{margin:0 auto 9px}.device-link-answer-title{margin:0;text-align:center;font-size:15px}.device-link-answer-copy{margin:5px auto 13px;max-width:280px;text-align:center;color:#718078;font-size:10px;line-height:1.45}
@media(max-width:480px){.device-link-panel{width:100%;border-radius:18px}.device-link-code{gap:4px}.device-link-code b{width:35px;height:43px}.device-link-connected{grid-template-columns:auto 1fr}.device-link-connected button{grid-column:1/-1}}
@media(prefers-reduced-motion:reduce){.device-link-choice{transition:none}.device-link-loading span{animation-duration:1.6s}}
`;

export default DeviceLinkPanel;
