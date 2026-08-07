/**
 * Browser-only, dependency-free device linking for the whiteboard.
 *
 * A BroadcastChannel provides a zero-setup path between tabs on the same
 * origin. Cross-device connections use a manually exchanged, non-trickle
 * WebRTC offer/answer. The latter keeps board data peer-to-peer and avoids
 * implying that a short code can provide internet rendezvous without a
 * signaling service.
 *
 * Integration:
 *
 *   const link = createDeviceLink({ deviceLabel: "Studio iMac" });
 *   const stop = link.onMessage(({ payload }) => applyRemoteAction(payload));
 *   link.send({ type: "board:request-snapshot" });
 *
 * Pass that same `link` to <DeviceLinkPanel deviceLink={link} />. Strokes may
 * use stroke:begin / stroke:points / stroke:end; complete board state travels
 * as board:snapshot and is automatically chunked on WebRTC data channels.
 * Call stop() and link.close() when the owning board is disposed.
 */

export type DeviceLinkRole = "host" | "peer";
export type DeviceLinkPhase =
  | "idle"
  | "creating"
  | "waiting"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "closed";
export type DeviceLinkTransport = "webrtc" | "broadcast" | null;

export interface DeviceLinkStrokePoint {
  x: number;
  y: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  time?: number;
}

export type DeviceLinkPayload =
  | {
      type: "stroke:begin";
      strokeId: string;
      point: DeviceLinkStrokePoint;
      tool?: string;
      color?: string;
      width?: number;
    }
  | {
      type: "stroke:points";
      strokeId: string;
      points: DeviceLinkStrokePoint[];
      sequence: number;
    }
  | {
      type: "stroke:end";
      strokeId: string;
      point?: DeviceLinkStrokePoint;
      sequence?: number;
    }
  | { type: "stroke:cancel"; strokeId: string }
  | { type: "board:request-snapshot"; knownRevision?: number }
  | { type: "board:snapshot"; revision: number; snapshot: unknown }
  | {
      type: "viewport";
      x: number;
      y: number;
      zoom: number;
      rotation?: number;
    }
  | {
      type: "cursor";
      x: number;
      y: number;
      visible: boolean;
      pointerType?: "pen" | "touch" | "mouse";
    }
  | { type: "presence"; name?: string; device?: string }
  | { type: "command"; command: string; data?: unknown }
  | { type: `app:${string}`; data?: unknown };

export interface DeviceLinkEnvelope<TPayload extends DeviceLinkPayload = DeviceLinkPayload> {
  version: 1;
  messageId: string;
  sessionId: string;
  senderId: string;
  sequence: number;
  sentAt: number;
  payload: TPayload;
}

export interface DeviceLinkState {
  role: DeviceLinkRole | null;
  phase: DeviceLinkPhase;
  transport: DeviceLinkTransport;
  pairingCode: string | null;
  sessionId: string | null;
  joinUrl: string | null;
  inviteToken: string | null;
  answerToken: string | null;
  peerLabel: string | null;
  statusMessage: string | null;
  error: string | null;
}

export interface DeviceLinkInvite {
  pairingCode: string;
  sessionId: string;
  joinUrl: string;
  inviteToken: string | null;
  requiresManualAnswer: boolean;
}

export interface DeviceLinkAnswer {
  pairingCode: string;
  sessionId: string;
  answerToken: string;
}

export interface DeviceLinkOptions {
  /** Label shown to the other tab when BroadcastChannel is used. */
  deviceLabel?: string;
  /** Override the default public STUN configuration or provide TURN. */
  rtcConfiguration?: RTCConfiguration;
  /** How long to wait for ICE gathering before packaging an offer/answer. */
  iceGatheringTimeoutMs?: number;
}

type StateListener = (state: DeviceLinkState) => void;
type MessageListener = (message: DeviceLinkEnvelope) => void;

interface SignalToken {
  version: 1;
  kind: "offer" | "answer";
  pairingCode: string;
  sessionId: string;
  createdAt: number;
  description: RTCSessionDescriptionInit;
}

interface ChannelChunk {
  namespace: "whiteboard-device-link";
  kind: "chunk";
  messageId: string;
  index: number;
  total: number;
  data: string;
}

type BroadcastFrame =
  | {
      namespace: "whiteboard-device-link";
      kind: "hello" | "heartbeat";
      code: string;
      senderId: string;
      role: DeviceLinkRole;
      sessionId: string | null;
      label: string;
    }
  | {
      namespace: "whiteboard-device-link";
      kind: "welcome";
      code: string;
      senderId: string;
      targetId: string;
      sessionId: string;
      label: string;
    }
  | {
      namespace: "whiteboard-device-link";
      kind: "payload";
      code: string;
      senderId: string;
      envelope: DeviceLinkEnvelope;
    }
  | {
      namespace: "whiteboard-device-link";
      kind: "goodbye";
      code: string;
      senderId: string;
    };

const DEFAULT_RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  iceCandidatePoolSize: 2,
};

const INITIAL_STATE: DeviceLinkState = {
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

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const BROADCAST_PREFIX = "whiteboard-device-link-v1:";
const INVITE_FRAGMENT_KEY = "device-link";
const CODE_QUERY_KEY = "deviceLinkCode";
const CHANNEL_CHUNK_SIZE = 12_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_COUNT = 2_000;

function browserCrypto(): Crypto {
  if (typeof crypto === "undefined") {
    throw new Error("Secure random values are unavailable in this browser.");
  }
  return crypto;
}

function randomId(): string {
  const source = browserCrypto();
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createPairingCode(length = 6): string {
  const source = browserCrypto();
  const bytes = new Uint8Array(length);
  source.getRandomValues(bytes);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function encodeBase64Url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url<T>(encoded: string): T {
  const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function signalFromInput(value: string): SignalToken {
  const trimmed = value.trim();
  if (trimmed.length > 250_000) {
    throw new Error("That connection code is too large to be a valid invitation.");
  }
  let encoded = trimmed;

  try {
    const url = new URL(trimmed);
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    encoded = fragment.get(INVITE_FRAGMENT_KEY) ?? trimmed;
  } catch {
    if (trimmed.startsWith(`${INVITE_FRAGMENT_KEY}=`)) {
      encoded = trimmed.slice(INVITE_FRAGMENT_KEY.length + 1);
    }
  }

  let token: SignalToken;
  try {
    token = decodeBase64Url<SignalToken>(encoded);
  } catch {
    throw new Error("That connection code is incomplete or invalid.");
  }

  if (
    token.version !== 1 ||
    (token.kind !== "offer" && token.kind !== "answer") ||
    !token.sessionId ||
    !token.pairingCode ||
    !token.description ||
    typeof token.description.sdp !== "string"
  ) {
    throw new Error("That connection code is not a supported device-link invitation.");
  }

  return token;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isEnvelope(value: unknown): value is DeviceLinkEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DeviceLinkEnvelope>;
  return (
    candidate.version === 1 &&
    typeof candidate.messageId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.senderId === "string" &&
    typeof candidate.sequence === "number" &&
    !!candidate.payload &&
    typeof candidate.payload === "object" &&
    typeof (candidate.payload as { type?: unknown }).type === "string"
  );
}

function isBroadcastFrame(value: unknown): value is BroadcastFrame {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BroadcastFrame>;
  return (
    candidate.namespace === "whiteboard-device-link" &&
    typeof candidate.kind === "string" &&
    typeof candidate.code === "string" &&
    typeof candidate.senderId === "string"
  );
}

function waitForIceGathering(peer: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      peer.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timeout);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timeout = setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

function inviteFromCurrentLocation(token: string | null, code: string): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  url.searchParams.set(CODE_QUERY_KEY, code);
  url.hash = token ? new URLSearchParams({ [INVITE_FRAGMENT_KEY]: token }).toString() : "";
  return url.toString();
}

export function invitationFromLocation(href?: string): string | null {
  const source = href ?? (typeof window !== "undefined" ? window.location.href : "");
  if (!source) return null;
  try {
    const url = new URL(source);
    return new URLSearchParams(url.hash.replace(/^#/, "")).get(INVITE_FRAGMENT_KEY);
  } catch {
    return null;
  }
}

export function pairingCodeFromLocation(href?: string): string | null {
  const source = href ?? (typeof window !== "undefined" ? window.location.href : "");
  if (!source) return null;
  try {
    const code = normalizePairingCode(new URL(source).searchParams.get(CODE_QUERY_KEY) ?? "");
    return code || null;
  } catch {
    return null;
  }
}

export class DeviceLink {
  private readonly options: Required<Pick<DeviceLinkOptions, "iceGatheringTimeoutMs">> &
    Omit<DeviceLinkOptions, "iceGatheringTimeoutMs">;
  private state: DeviceLinkState = { ...INITIAL_STATE };
  private readonly stateListeners = new Set<StateListener>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly senderId = randomId();
  private messageSequence = 0;
  private peer: RTCPeerConnection | null = null;
  private reliableChannel: RTCDataChannel | null = null;
  private inkChannel: RTCDataChannel | null = null;
  private broadcast: BroadcastChannel | null = null;
  private broadcastPeerAvailable = false;
  private lastBroadcastPeerAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly receivedMessageIds = new Set<string>();
  private readonly pendingChunks = new Map<
    string,
    { chunks: string[]; received: number; timeout: ReturnType<typeof setTimeout> }
  >();

  constructor(options: DeviceLinkOptions = {}) {
    this.options = {
      ...options,
      iceGatheringTimeoutMs: options.iceGatheringTimeoutMs ?? 8_000,
    };
  }

  getState(): DeviceLinkState {
    // State objects are replaced, never mutated. A stable reference is
    // required by React's useSyncExternalStore integration.
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  async createHostInvite(): Promise<DeviceLinkInvite> {
    this.resetTransport();
    const pairingCode = createPairingCode();
    const sessionId = randomId();
    this.setState({
      ...INITIAL_STATE,
      role: "host",
      phase: "creating",
      pairingCode,
      sessionId,
      statusMessage: "Preparing a private invitation…",
    });
    this.openBroadcastChannel(pairingCode);

    let inviteToken: string | null = null;
    let nonFatalMessage: string | null = null;

    if (typeof RTCPeerConnection === "undefined") {
      nonFatalMessage =
        "WebRTC is unavailable here. The short code can still connect another tab on this device.";
    } else {
      try {
        const peer = this.createPeerConnection();
        this.attachChannel(peer.createDataChannel("whiteboard-control", { ordered: true }));
        this.attachChannel(
          peer.createDataChannel("whiteboard-ink", {
            ordered: false,
            maxRetransmits: 1,
          }),
        );
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIceGathering(peer, this.options.iceGatheringTimeoutMs);
        if (!peer.localDescription) throw new Error("The browser did not create an offer.");
        inviteToken = encodeBase64Url({
          version: 1,
          kind: "offer",
          pairingCode,
          sessionId,
          createdAt: Date.now(),
          description: peer.localDescription.toJSON(),
        } satisfies SignalToken);
      } catch (error) {
        this.closePeerConnection();
        nonFatalMessage = `WebRTC invitation could not be created: ${this.errorMessage(error)} Same-device pairing remains available.`;
      }
    }

    const joinUrl = inviteFromCurrentLocation(inviteToken, pairingCode);
    this.setState({
      phase: "waiting",
      joinUrl,
      inviteToken,
      statusMessage:
        nonFatalMessage ??
        "Open the invitation on the iPad, then return its answer code here to finish the encrypted connection.",
    });

    return {
      pairingCode,
      sessionId,
      joinUrl,
      inviteToken,
      requiresManualAnswer: inviteToken !== null,
    };
  }

  /** Alias for integrations that use a shorter host action name. */
  createHost(): Promise<DeviceLinkInvite> {
    return this.createHostInvite();
  }

  joinWithCode(input: string): void {
    const pairingCode = normalizePairingCode(input);
    if (pairingCode.length < 4) {
      throw new Error("Enter at least four characters from the pairing code.");
    }
    this.resetTransport();
    this.setState({
      ...INITIAL_STATE,
      role: "peer",
      phase: "waiting",
      pairingCode,
      statusMessage:
        "Looking for a host in another tab. For an iPad or another computer, use the host’s full invitation link instead.",
    });
    this.openBroadcastChannel(pairingCode);
    this.postBroadcast("hello");
  }

  async acceptInvite(input: string): Promise<DeviceLinkAnswer> {
    const token = signalFromInput(input);
    if (token.kind !== "offer") throw new Error("Paste a host invitation, not an answer code.");
    if (Date.now() - token.createdAt > 24 * 60 * 60 * 1_000) {
      throw new Error("This invitation is more than 24 hours old. Ask the host to create a new one.");
    }
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("This browser does not support WebRTC device connections.");
    }

    this.resetTransport();
    this.setState({
      ...INITIAL_STATE,
      role: "peer",
      phase: "connecting",
      pairingCode: normalizePairingCode(token.pairingCode),
      sessionId: token.sessionId,
      statusMessage: "Creating the encrypted reply…",
    });
    this.openBroadcastChannel(token.pairingCode);

    try {
      const peer = this.createPeerConnection();
      await peer.setRemoteDescription(token.description);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await waitForIceGathering(peer, this.options.iceGatheringTimeoutMs);
      if (!peer.localDescription) throw new Error("The browser did not create an answer.");
      const answerToken = encodeBase64Url({
        version: 1,
        kind: "answer",
        pairingCode: token.pairingCode,
        sessionId: token.sessionId,
        createdAt: Date.now(),
        description: peer.localDescription.toJSON(),
      } satisfies SignalToken);
      this.setState({
        answerToken,
        phase: "connecting",
        statusMessage:
          "Send this answer code back to the host. The connection opens as soon as the host accepts it.",
      });
      this.postBroadcast("hello");
      return {
        pairingCode: token.pairingCode,
        sessionId: token.sessionId,
        answerToken,
      };
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async acceptAnswer(input: string): Promise<void> {
    const token = signalFromInput(input);
    if (token.kind !== "answer") throw new Error("Paste the answer code created on the iPad.");
    if (!this.peer || this.state.role !== "host" || !this.state.sessionId) {
      throw new Error("Create a host invitation before accepting an answer.");
    }
    if (
      token.sessionId !== this.state.sessionId ||
      normalizePairingCode(token.pairingCode) !== this.state.pairingCode
    ) {
      throw new Error("This answer belongs to a different invitation.");
    }

    try {
      this.setState({
        phase: "connecting",
        statusMessage: "Answer accepted. Establishing the encrypted connection…",
        error: null,
      });
      await this.peer.setRemoteDescription(token.description);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  send<TPayload extends DeviceLinkPayload>(payload: TPayload): boolean {
    if (!this.state.sessionId) return false;
    const envelope: DeviceLinkEnvelope<TPayload> = {
      version: 1,
      messageId: randomId(),
      sessionId: this.state.sessionId,
      senderId: this.senderId,
      sequence: ++this.messageSequence,
      sentAt: Date.now(),
      payload,
    };
    const preferred = payload.type === "stroke:points" ? this.inkChannel : this.reliableChannel;
    if (preferred?.readyState === "open") {
      return this.sendOnChannel(preferred, envelope);
    }
    if (this.reliableChannel?.readyState === "open") {
      return this.sendOnChannel(this.reliableChannel, envelope);
    }
    if (this.broadcast && this.broadcastPeerAvailable && this.state.pairingCode) {
      this.broadcast.postMessage({
        namespace: "whiteboard-device-link",
        kind: "payload",
        code: this.state.pairingCode,
        senderId: this.senderId,
        envelope,
      } satisfies BroadcastFrame);
      return true;
    }
    return false;
  }

  disconnect(): void {
    if (this.broadcast && this.state.pairingCode) {
      this.broadcast.postMessage({
        namespace: "whiteboard-device-link",
        kind: "goodbye",
        code: this.state.pairingCode,
        senderId: this.senderId,
      } satisfies BroadcastFrame);
    }
    this.resetTransport();
    this.setState({ ...INITIAL_STATE, phase: "closed" });
  }

  close(): void {
    this.stateListeners.clear();
    this.messageListeners.clear();
    this.disconnect();
  }

  private setState(patch: Partial<DeviceLinkState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    this.stateListeners.forEach((listener) => listener(snapshot));
  }

  private createPeerConnection(): RTCPeerConnection {
    this.closePeerConnection();
    const peer = new RTCPeerConnection(this.options.rtcConfiguration ?? DEFAULT_RTC_CONFIGURATION);
    this.peer = peer;

    peer.addEventListener("datachannel", (event) => this.attachChannel(event.channel));
    peer.addEventListener("connectionstatechange", () => {
      if (peer !== this.peer) return;
      switch (peer.connectionState) {
        case "connected":
          this.setConnected("webrtc", "iPad / peer device");
          break;
        case "disconnected":
          this.setState({
            phase: "reconnecting",
            statusMessage: "The peer connection was interrupted. Trying to reconnect…",
          });
          break;
        case "failed":
          this.setState({
            phase: "error",
            transport: null,
            error:
              "The peer-to-peer route failed. This network may require a TURN relay; create a fresh invitation or try the same Wi-Fi network.",
            statusMessage: null,
          });
          break;
        case "closed":
          if (this.state.phase !== "closed") {
            this.setState({ phase: "waiting", transport: null, peerLabel: null });
          }
          break;
        default:
          break;
      }
    });
    return peer;
  }

  private attachChannel(channel: RTCDataChannel): void {
    if (channel.label === "whiteboard-ink") this.inkChannel = channel;
    else this.reliableChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => this.setConnected("webrtc", "iPad / peer device"));
    channel.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const value = safeJsonParse(event.data);
      if (isEnvelope(value)) {
        this.receiveEnvelope(value);
        return;
      }
      if (
        value &&
        typeof value === "object" &&
        (value as Partial<ChannelChunk>).namespace === "whiteboard-device-link" &&
        (value as Partial<ChannelChunk>).kind === "chunk"
      ) {
        this.receiveChunk(value as ChannelChunk);
      }
    });
    channel.addEventListener("error", () => {
      this.setState({
        error: "A device data channel reported an error. Finalized strokes may be retried over the control channel.",
      });
    });
  }

  private setConnected(transport: Exclude<DeviceLinkTransport, null>, peerLabel: string): void {
    this.setState({
      phase: "connected",
      transport,
      peerLabel,
      error: null,
      statusMessage:
        transport === "webrtc"
          ? "Encrypted peer-to-peer connection active."
          : "Connected through a same-browser channel.",
    });
  }

  private receiveEnvelope(envelope: DeviceLinkEnvelope): void {
    if (envelope.senderId === this.senderId) return;
    if (this.state.sessionId && envelope.sessionId !== this.state.sessionId) return;
    if (this.receivedMessageIds.has(envelope.messageId)) return;
    this.receivedMessageIds.add(envelope.messageId);
    if (this.receivedMessageIds.size > 1_000) {
      const oldest = this.receivedMessageIds.values().next().value as string | undefined;
      if (oldest) this.receivedMessageIds.delete(oldest);
    }
    this.messageListeners.forEach((listener) => listener(envelope));
  }

  private sendOnChannel(channel: RTCDataChannel, envelope: DeviceLinkEnvelope): boolean {
    try {
      if (channel.bufferedAmount > MAX_BUFFERED_BYTES) return false;
      const serialized = JSON.stringify(envelope);
      if (serialized.length <= CHANNEL_CHUNK_SIZE) {
        channel.send(serialized);
        return true;
      }

      // Encode once so every packet contains ASCII and stays well below the
      // conservative 16 KiB data-channel message size used by older WebRTC
      // implementations. Ordered control channels reassemble large snapshots.
      const encoded = encodeBase64Url(envelope);
      const total = Math.ceil(encoded.length / CHANNEL_CHUNK_SIZE);
      if (total > MAX_CHUNK_COUNT) {
        this.setState({ error: "That board snapshot is too large for a direct device transfer." });
        return false;
      }
      for (let index = 0; index < total; index += 1) {
        const packet: ChannelChunk = {
          namespace: "whiteboard-device-link",
          kind: "chunk",
          messageId: envelope.messageId,
          index,
          total,
          data: encoded.slice(index * CHANNEL_CHUNK_SIZE, (index + 1) * CHANNEL_CHUNK_SIZE),
        };
        channel.send(JSON.stringify(packet));
      }
      return true;
    } catch (error) {
      this.setState({ error: `The message could not be sent: ${this.errorMessage(error)}` });
      return false;
    }
  }

  private receiveChunk(packet: ChannelChunk): void {
    if (
      !packet.messageId ||
      !Number.isInteger(packet.index) ||
      !Number.isInteger(packet.total) ||
      packet.index < 0 ||
      packet.total < 1 ||
      packet.total > MAX_CHUNK_COUNT ||
      packet.index >= packet.total ||
      typeof packet.data !== "string"
    ) {
      return;
    }

    let pending = this.pendingChunks.get(packet.messageId);
    if (!pending) {
      const timeout = setTimeout(() => this.pendingChunks.delete(packet.messageId), 30_000);
      pending = { chunks: new Array<string>(packet.total), received: 0, timeout };
      this.pendingChunks.set(packet.messageId, pending);
    }
    if (pending.chunks.length !== packet.total || pending.chunks[packet.index] !== undefined) return;
    pending.chunks[packet.index] = packet.data;
    pending.received += 1;
    if (pending.received !== packet.total) return;

    clearTimeout(pending.timeout);
    this.pendingChunks.delete(packet.messageId);
    try {
      const envelope = decodeBase64Url<unknown>(pending.chunks.join(""));
      if (isEnvelope(envelope)) this.receiveEnvelope(envelope);
    } catch {
      this.setState({ error: "A board snapshot arrived incomplete and was discarded." });
    }
  }

  private openBroadcastChannel(pairingCode: string): void {
    if (typeof BroadcastChannel === "undefined") return;
    const code = normalizePairingCode(pairingCode);
    this.broadcast = new BroadcastChannel(`${BROADCAST_PREFIX}${code}`);
    this.broadcast.addEventListener("message", (event: MessageEvent<unknown>) => {
      const frame = event.data;
      if (!isBroadcastFrame(frame) || frame.senderId === this.senderId || frame.code !== code) return;
      this.lastBroadcastPeerAt = Date.now();

      if (frame.kind === "hello" || frame.kind === "heartbeat") {
        if (this.state.role === "host" && frame.role === "peer" && this.state.sessionId) {
          this.broadcastPeerAvailable = true;
          this.broadcast?.postMessage({
            namespace: "whiteboard-device-link",
            kind: "welcome",
            code,
            senderId: this.senderId,
            targetId: frame.senderId,
            sessionId: this.state.sessionId,
            label: this.options.deviceLabel ?? "Whiteboard host",
          } satisfies BroadcastFrame);
          if (this.state.transport !== "webrtc") this.setConnected("broadcast", frame.label);
        }
        return;
      }

      if (frame.kind === "welcome" && frame.targetId === this.senderId && this.state.role === "peer") {
        this.broadcastPeerAvailable = true;
        this.setState({ sessionId: frame.sessionId });
        if (this.state.transport !== "webrtc") this.setConnected("broadcast", frame.label);
        return;
      }

      if (frame.kind === "payload") {
        this.broadcastPeerAvailable = true;
        this.receiveEnvelope(frame.envelope);
        return;
      }

      if (frame.kind === "goodbye") {
        this.broadcastPeerAvailable = false;
        if (this.state.transport === "broadcast") {
          this.setState({
            phase: "waiting",
            transport: null,
            peerLabel: null,
            statusMessage: "The other tab disconnected. Waiting for it to return…",
          });
        }
      }
    });

    this.heartbeatTimer = setInterval(() => {
      this.postBroadcast("heartbeat");
      if (
        this.broadcastPeerAvailable &&
        this.lastBroadcastPeerAt > 0 &&
        Date.now() - this.lastBroadcastPeerAt > 16_000
      ) {
        this.broadcastPeerAvailable = false;
        if (this.state.transport === "broadcast") {
          this.setState({
            phase: "waiting",
            transport: null,
            peerLabel: null,
            statusMessage: "The local peer stopped responding. Waiting for it to return…",
          });
        }
      }
    }, 5_000);
  }

  private postBroadcast(kind: "hello" | "heartbeat"): void {
    if (!this.broadcast || !this.state.pairingCode || !this.state.role) return;
    this.broadcast.postMessage({
      namespace: "whiteboard-device-link",
      kind,
      code: this.state.pairingCode,
      senderId: this.senderId,
      role: this.state.role,
      sessionId: this.state.sessionId,
      label: this.options.deviceLabel ?? (this.state.role === "host" ? "Whiteboard host" : "Companion tab"),
    } satisfies BroadcastFrame);
  }

  private closePeerConnection(): void {
    if (this.inkChannel) {
      this.inkChannel.close();
      this.inkChannel = null;
    }
    if (this.reliableChannel) {
      this.reliableChannel.close();
      this.reliableChannel = null;
    }
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
  }

  private resetTransport(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.closePeerConnection();
    if (this.broadcast) {
      this.broadcast.close();
      this.broadcast = null;
    }
    this.broadcastPeerAvailable = false;
    this.lastBroadcastPeerAt = 0;
    this.messageSequence = 0;
    this.receivedMessageIds.clear();
    this.pendingChunks.forEach((pending) => clearTimeout(pending.timeout));
    this.pendingChunks.clear();
  }

  private fail(error: unknown): void {
    this.setState({
      phase: "error",
      transport: null,
      statusMessage: null,
      error: this.errorMessage(error),
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "An unexpected device connection error occurred.";
  }
}

export function createDeviceLink(options?: DeviceLinkOptions): DeviceLink {
  return new DeviceLink(options);
}
