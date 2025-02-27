import { Iroh } from "npm:@number0/iroh";
import { Buffer } from "node:buffer";

/**
 * IrohMain is a singleton providing exactly one Iroh node
 * in the main thread. This node is used to connect to any
 * workers or remote peers. We do a one-time init.
 */
export class IrohMain {
  private static _initialized = false;
  private static _mainNode: any;

  static async init() {
    if (!IrohMain._initialized) {
      const WORKER_BRIDGE = Buffer.from("worker-bridge");
      const protocols = {
        [WORKER_BRIDGE.toString("utf8")]: (_err: unknown, _ep: unknown, _client: any) => ({
          accept: async (err: unknown, connecting: any) => {
            // This is if the worker wants to initiate a connection to us.
            if (err) {
              console.error("MainNode: inbound connection error", err);
              return;
            }
            const conn = await connecting.connect();
            console.log("MainNode: accepted inbound connection from a worker");
            // We'll read the message in a readToEnd manner if we want
            // (The example below is symmetrical, so let's keep it minimal.)
          },
        }),
      };

      IrohMain._mainNode = await Iroh.memory({ protocols });
      IrohMain._initialized = true;
      const addr = await IrohMain._mainNode.net.nodeAddr();
      console.log("IrohMain: Main node created. Node ID:", addr.nodeId);
    }
    return IrohMain._mainNode;
  }

  static get node() {
    if (!IrohMain._initialized) {
      throw new Error("IrohMain not initialized. Call IrohMain.init() first.");
    }
    return IrohMain._mainNode;
  }
}



/**
 * IrohWebWorker:
 * Extends Worker to use Iroh for communication.
 */
export class IrohWebWorker implements Worker {
  private _workerNode: IrohNode | null = null;
  private _initialized: boolean = false;
  private _initPromise: Promise<void>;
  private _messageQueue: { msg: any; transfer?: Transferable[]; options?: StructuredSerializeOptions }[] = [];
  private _eventListeners: Map<string, Set<EventListenerOrEventListenerObject>> = new Map();
  private _terminated: boolean = false;
  private _worker: Worker | null = null;
  private _remoteNodeId: string | null = null;

  // Worker interface properties
  onmessage: ((this: Worker, e: MessageEvent) => any) = () => {};
  onmessageerror: ((this: Worker, e: MessageEvent) => any) = () => {};
  onerror: ((this: AbstractWorker, e: ErrorEvent) => any) = () => {};

  constructor(urlOrNodeAddr: string | URL | { nodeId: string } | { node: IrohNode }, options?: WorkerOptions) {
    if (typeof urlOrNodeAddr === 'object' && 'node' in urlOrNodeAddr) {
      // Direct node mode
      this._workerNode = urlOrNodeAddr.node;
      this._initialized = true;
    } else if (typeof urlOrNodeAddr === 'object' && 'nodeId' in urlOrNodeAddr) {
      // Remote worker mode
      this._remoteNodeId = urlOrNodeAddr.nodeId;
    } else {
      // Local worker mode
      this._worker = new Worker(urlOrNodeAddr, options);
    }
    this._initPromise = this._initializeWorkerNode();
  }

  private async _initializeWorkerNode() {
    if (this._terminated) return;

    try {
      // Only initialize Iroh for remote workers or when explicitly requested
      if (this._remoteNodeId) {
        // Remote worker mode - need Iroh
        console.log("[Init] Initializing for remote worker mode");
        await IrohMain.init(); // ensure main node exists
        this._workerNode = await this._createWorkerNode();
      } else if (this._worker) {
        // Local worker mode - only create Iroh node if needed for sharing
        console.log("[Init] Initializing for local worker mode");
        // Set up message handler for local worker
        this._worker.onmessage = (event: MessageEvent) => {
          console.log("[LocalWorker] Received message from worker:");
          // Dispatch the message to all listeners
          const messageEvent = new MessageEvent('message', { data: event.data });
          this._dispatchToListeners('message', messageEvent);
        };
      }
      
      this._initialized = true;

      // Process any queued messages
      const queueCopy = [...this._messageQueue];
      this._messageQueue = [];
      for (const item of queueCopy) {
        if (this._terminated) break;
        await this.postMessage(item.msg, 
          'transfer' in item ? item.transfer : item.options);
      }
    } catch (error) {
      console.error("IrohWebWorker: Failed to initialize:", error);
      const errorEvent = new ErrorEvent('error', { error });
      this._dispatchToListeners('error', errorEvent);
    }
  }

  private async _createWorkerNode(): Promise<IrohNode> {
    // "worker-bridge" protocol for one-message-per-stream
    const WORKER_BRIDGE = Buffer.from("worker-bridge");
    const protocols: IrohMemoryOptions['protocols'] = {
      [WORKER_BRIDGE.toString("utf8")]: (_err: unknown, _ep: unknown, _client: unknown) => ({
        accept: async (err: unknown, connecting: any) => {
          if (err) {
            console.error("WorkerNode: inbound connection error", err);
            return;
          }
          if (this._terminated) return;

          // Only handle inbound connections if we're a local worker
          if (!this._remoteNodeId) {
            console.log("[IrohProtocol] Accepting inbound connection");
            // Each connection = 1 message from main -> worker
            const conn = await connecting.connect();
            console.log("[IrohProtocol] Connected");
            const bi = await conn.acceptBi();
            console.log("[IrohProtocol] Bidirectional stream accepted");

            try {
              // 1) read the entire request from main
              console.log("[IrohProtocol] Reading request from main");
              const requestBytes = await bi.recv.readToEnd(65536);
              let requestObj: unknown;
              if (requestBytes && requestBytes.length > 0) {
                const requestText = new TextDecoder().decode(requestBytes);
                console.log(`[IrohProtocol] Received request: ${requestText.substring(0, 100)}${requestText.length > 100 ? '...' : ''}`);
                requestObj = JSON.parse(requestText);
              } else {
                console.log("[IrohProtocol] Empty request received");
              }

              // 2) forward the message to the Worker via the original Worker API
              console.log("[IrohProtocol] Forwarding message to Worker");
              const responsePromise = new Promise<unknown>(resolve => {
                const listener = (evt: MessageEvent) => {
                  console.log(`[IrohProtocol] Worker responded with data: ${JSON.stringify(evt.data).substring(0, 100)}...`);
                  resolve(evt.data);
                  this._worker?.removeEventListener("message", listener);
                };
                this._worker?.addEventListener("message", listener, { once: true });
                
                // Post it to the worker script using the original Worker API
                this._worker?.postMessage(requestObj);
                console.log("[IrohProtocol] Message posted to Worker");
              });

              // Wait for response with a timeout
              console.log("[IrohProtocol] Waiting for Worker response");
              const responseObj = await Promise.race([
                responsePromise,
                new Promise<never>((_, reject) => 
                  setTimeout(() => {
                    console.log("[IrohProtocol] Response timeout");
                    reject(new Error("Response timeout"));
                  }, 1000)
                )
              ]);

              // 3) send the single response back
              if (responseObj != null && !this._terminated) {
                const respText = JSON.stringify(responseObj);
                console.log(`[IrohProtocol] Sending response: ${respText.substring(0, 100)}${respText.length > 100 ? '...' : ''}`);
                await bi.send.writeAll(new TextEncoder().encode(respText));
                console.log("[IrohProtocol] Response sent successfully");
              } else {
                console.log("[IrohProtocol] No response to send or worker terminated");
              }
            } catch (e) {
              console.error("WorkerNode: Error processing message:", e);
              throw e;
            } finally {
              await bi.send.finish();
              await bi.send.stopped();
              console.log("[IrohProtocol] Stream finished and stopped");
            }
          }
        },
      }),
    };

    // Create the worker’s Iroh node
    let iroh: IrohNode;
    
    if (this._remoteNodeId) {
      // For remote node ID, we don't need to create a new node, 
      // we just need to create a proxy object that has the remote node ID
      console.log(`IrohWebWorker: Using remote node ID: ${this._remoteNodeId}`);
      
      // Create a minimal proxy object that has the required node ID
      iroh = {
        net: {
          nodeId: this._remoteNodeId,
          nodeAddr: async () => ({ nodeId: this._remoteNodeId })
        },
        node: IrohMain.node.node, // Use the main node's node interface for connections
        authors: {},
        blobs: {},
        docs: {},
        gossip: {}
      } as unknown as IrohNode;
    } else {
      // Create a new local node
      iroh = await Iroh.memory({ 
        protocols,
      }) as unknown as IrohNode;
      const addr = await iroh.net.nodeAddr();
      console.log(`IrohWebWorker: Local node created. Node ID: ${addr.nodeId}`);
    }

    return iroh;
  }

  async getNode(): Promise<IrohNode> {
    if (!this._workerNode) {
      // Create the Iroh node on-demand for local workers
      if (this._worker && !this._remoteNodeId) {
        console.log("[GetNode] Creating Iroh node on-demand for local worker");
        await IrohMain.init(); // ensure main node exists
        this._workerNode = await this._createWorkerNode();
        
        // Ensure the node is fully initialized and discoverable
        console.log("[GetNode] Ensuring node is discoverable...");
        
        // Connect from main node to worker node to establish connection
        const mainNode = IrohMain.node;
        const WORKER_BRIDGE = Buffer.from("worker-bridge");
        const workerAddr = await this._workerNode.net.nodeAddr();
        
        try {
          // Make a test connection to ensure the node is discoverable
          console.log("[GetNode] Making test connection to ensure node is discoverable");
          const conn = await mainNode.node.endpoint().connect(workerAddr, WORKER_BRIDGE);
          const bi = await conn.openBi();
          
          // Send a small ping message
          await bi.send.writeAll(new TextEncoder().encode(JSON.stringify({ ping: true })));
          await bi.send.finish();
          
          // Read response (we don't care about the content)
          await bi.recv.readToEnd(1024);
          
          console.log("[GetNode] Node is now discoverable");
          
          // Wait a bit more to ensure discovery propagation
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (e) {
          console.error("[GetNode] Failed to ensure node is discoverable:", e);
          throw new Error("Failed to initialize worker node for discovery");
        }
      } else {
        throw new Error("Worker node not initialized");
      }
    }
    return this._workerNode;
  }

  async getIrohAddr(): Promise<{ nodeId: string }> {
    const node = await this.getNode();
    return node.net.nodeAddr();
  }

  async postMessage(message: any, transferOrOptions?: Transferable[] | StructuredSerializeOptions): Promise<void> {
    if (this._terminated) {
      throw new Error("Worker has been terminated");
    }

    await this._initPromise;
    if (!this._initialized) {
      // Queue the message if worker node isn't ready
      this._messageQueue.push({ 
        msg: message, 
        ...(Array.isArray(transferOrOptions) 
          ? { transfer: transferOrOptions } 
          : { options: transferOrOptions })
      });
      return;
    }

    try {
      // Use direct Worker API for local workers, Iroh network only for remote workers
      if (this._worker && !this._remoteNodeId) {
        // Local worker mode - use direct Worker API
        //console.log("[LocalWorker] Using direct Worker API for local worker");
        
        // Send the message directly to the worker
        if (Array.isArray(transferOrOptions)) {
          this._worker.postMessage(message, transferOrOptions);
        } else if (transferOrOptions) {
          this._worker.postMessage(message, transferOrOptions);
        } else {
          this._worker.postMessage(message);
        }
        console.log("[LocalWorker] Message sent directly to worker");
        
        // In local mode, we don't need to wait for a response here
        // The worker's responses will be handled by the event listeners
        // that were set up during initialization
      } else {
        // Remote worker mode or proxy mode - use Iroh network
        console.log("[RemoteWorker] Using Iroh network for remote/proxy worker");
        await this._postMessageViaIroh(message);
      }
    } catch (error) {
      const errorEvent = new ErrorEvent('error', { error });
      this._dispatchToListeners('error', errorEvent);
      throw error;
    }
  }

  private async _postMessageViaIroh(msg: unknown) {
    if (!this._workerNode || this._terminated) return;

    const mainNode = IrohMain.node;
    const WORKER_BRIDGE = Buffer.from("worker-bridge");
    
    try {
      let conn;
      if (this._remoteNodeId) {
        // Remote mode: Connect via node ID
        console.log(`[IrohNetwork] Connecting to remote node ID: ${this._remoteNodeId}`);
        conn = await mainNode.node.endpoint().connect({ nodeId: this._remoteNodeId }, WORKER_BRIDGE);
        console.log(`[IrohNetwork] Connected to remote node ID: ${this._remoteNodeId}`);
      } else {
        // Local mode: Connect directly to our worker node
        const workerAddr = await this._workerNode.net.nodeAddr();
        console.log(`[IrohNetwork] Connecting to local worker node: ${workerAddr.nodeId}`);
        conn = await mainNode.node.endpoint().connect(workerAddr, WORKER_BRIDGE);
        console.log(`[IrohNetwork] Connected to local worker node: ${workerAddr.nodeId}`);
      }
      const bi = await conn.openBi();
      console.log(`[IrohNetwork] Opened bidirectional stream`);

      // Write the message
      const text = JSON.stringify(msg);
      console.log(`[IrohNetwork] Sending message: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
      await bi.send.writeAll(new TextEncoder().encode(text));
      await bi.send.finish();
      console.log(`[IrohNetwork] Message sent successfully`);

      // Read the response
      console.log(`[IrohNetwork] Waiting for response...`);
      const responseBytes = await bi.recv.readToEnd(65536);
      if (responseBytes && responseBytes.length > 0 && !this._terminated) {
        const responseText = new TextDecoder().decode(responseBytes);
        console.log(`[IrohNetwork] Received response: ${responseText.substring(0, 100)}${responseText.length > 100 ? '...' : ''}`);
        const responseObj = JSON.parse(responseText);
        const messageEvent = new MessageEvent('message', { data: responseObj });
        this._dispatchToListeners('message', messageEvent);
        console.log(`[IrohNetwork] Response dispatched to listeners`);
      } else {
        console.log(`[IrohNetwork] No response received or worker terminated`);
      }
    } catch (e) {
      console.error("[IrohNetwork] Failed to process message:", e);
      const errorEvent = new ErrorEvent('error', { error: e });
      this._dispatchToListeners('error', errorEvent);
      throw e;
    }
  }

  private _dispatchToListeners<K extends keyof WorkerEventMap>(type: K, event: WorkerEventMap[K]): void {
    // Handle onX properties
    const handler = this[`on${type}`] as ((evt: WorkerEventMap[K]) => void);
    if (handler) {
      handler.call(this, event);
    }

    // Handle addEventListener listeners
    const listeners = this._eventListeners.get(type);
    if (listeners) {
      for (const listener of listeners) {
        if (typeof listener === 'function') {
          listener.call(this, event);
        } else {
          listener.handleEvent.call(this, event);
        }
      }
    }
  }

  dispatchEvent(event: Event): boolean {
    try {
      this._dispatchToListeners(event.type as keyof WorkerEventMap, event as any);
      return !event.defaultPrevented;
    } catch (e) {
      console.error("Error dispatching event:", e);
      return false;
    }
  }

  addEventListener<K extends keyof WorkerEventMap>(
    type: K,
    listener: (this: Worker, ev: WorkerEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (this._terminated) return;

    if (!this._eventListeners.has(type)) {
      this._eventListeners.set(type, new Set());
    }
    this._eventListeners.get(type)!.add(listener);
  }

  removeEventListener<K extends keyof WorkerEventMap>(
    type: K,
    listener: (this: Worker, ev: WorkerEventMap[K]) => any,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    const listeners = this._eventListeners.get(type);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this._eventListeners.delete(type);
      }
    }
  }

  terminate(): void {
    this._terminated = true;
    if (this._workerNode) {
      this._workerNode = null;
    }
    this._initialized = false;
    this._messageQueue = [];
    this._eventListeners.clear();
    this._worker?.terminate();
  }
}

/**
 * Type definitions for better type safety
 */
interface Net {
  nodeAddr(): Promise<{ nodeId: string }>;
}

interface Node {
  endpoint(): {
    connect(addr: { nodeId: string }, protocol: Buffer): Promise<{
      openBi(): Promise<{
        send: {
          writeAll(data: Uint8Array): Promise<void>;
          finish(): Promise<void>;
          stopped(): Promise<void>;
        };
        recv: {
          readToEnd(size: number): Promise<Uint8Array>;
        };
      }>;
    }>;
  };
}

interface IrohNode {
  net: Net;
  node: Node;
  authors: unknown; // We don't use these but they're part of the API
  blobs: unknown;
  docs: unknown;
  gossip: unknown;
}

interface IrohMemoryOptions {
  protocols: {
    [key: string]: (err: unknown, ep: unknown, client: unknown) => {
      accept(err: unknown, connecting: unknown): Promise<void>;
    };
  };
}