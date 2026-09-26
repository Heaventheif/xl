import { EventEmitter } from "events";

export type Callback<T = unknown> = (error: Error | null, value?: T) => void;

export interface LoginData {
  appState?: unknown;
  Cookie?: string;
  email?: string;
  password?: string;
  [key: string]: unknown;
}

export interface LoginOptions {
  [key: string]: unknown;
}

export interface FcaApi {
  [method: string]: any;
  getAppState?: () => unknown;
  listenMqtt?: (...args: any[]) => any;
  sendMessage?: (...args: any[]) => any;
}

export interface Namespace {
  [method: string]: any;
}

export interface FcaClient {
  raw: FcaApi;
  messages: Namespace;
  threads: Namespace;
  users: Namespace;
  account: Namespace;
  realtime: Namespace;
  http: Namespace;
  scheduler: Namespace;
}

export interface MessengerBotOptions {
  commandPrefix?: string;
  enableComposer?: boolean;
  stopOnSignals?: boolean;
  maxEventListeners?: number;
}

export interface LaunchOptions {
  stopOnSignals?: boolean;
}

export type Middleware = (context: MessengerContext, next: () => Promise<void>) => unknown;
export type ErrorHandler = (error: unknown, context: MessengerContext) => unknown;

export class MessengerContext {
  constructor(bot: MessengerBot, event: any);
  bot: MessengerBot;
  event: any;
  readonly threadID: string | undefined;
  readonly senderID: string | undefined;
  readonly messageID: string | undefined;
  readonly body: string | undefined;
  readonly message: any;
  readonly text: string;
  reply(payload: any, callback?: Callback): any;
  replyAsync(payload: any): Promise<any>;
}

export class MessengerBot extends EventEmitter {
  constructor(api: FcaApi, options?: MessengerBotOptions);
  static connect(credentials: LoginData, options?: LoginOptions & MessengerBotOptions): Promise<MessengerBot>;
  readonly api: FcaApi;
  readonly client: FcaClient;
  commandPrefix: string;
  use(middleware: Middleware): this;
  command(name: string, handler: (context: MessengerContext) => unknown): this;
  hears(trigger: string | RegExp, handler: (context: MessengerContext) => unknown): this;
  catch(handler: ErrorHandler): this;
  startListening(): this;
  launch(options?: LaunchOptions): Promise<this>;
  stop(): Promise<void>;
}

export interface ThreadInfoSyncOptions {
  refreshParticipants?: boolean;
  invalidateOnUnknownEvent?: boolean;
  logger?: (...args: any[]) => void;
}

export function login(
  loginData: LoginData,
  options?: LoginOptions,
  callback?: Callback<FcaApi>
): Promise<FcaApi> | void;

export function createFcaClient(api: FcaApi): FcaClient;
export function createMessengerBot(
  credentials: LoginData,
  options?: LoginOptions & MessengerBotOptions
): Promise<MessengerBot>;
export function attachThreadInfoRealtimeSync(
  api: FcaApi,
  options?: ThreadInfoSyncOptions
): () => void;
export function applyThreadInfoRealtimeEvent(
  api: FcaApi,
  event: any,
  options?: ThreadInfoSyncOptions
): Promise<unknown>;

declare const exportedLogin: typeof login & {
  default: typeof login;
  login: typeof login;
  createFcaClient: typeof createFcaClient;
  MessengerBot: typeof MessengerBot;
  createMessengerBot: typeof createMessengerBot;
  MessengerContext: typeof MessengerContext;
  attachThreadInfoRealtimeSync: typeof attachThreadInfoRealtimeSync;
  applyThreadInfoRealtimeEvent: typeof applyThreadInfoRealtimeEvent;
};

export = exportedLogin;