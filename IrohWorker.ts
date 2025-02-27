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
  private static _initPromise: Promise<any> | null = null;

  static async init() {
    // If already initialized, return the existing node
    if (IrohMain._initialized) {
      return IrohMain._mainNode;
    }
    
    // If initialization is in progress, wait for it to complete
    if (IrohMain._initPromise) {
      return IrohMain._initPromise;
    }
    
    // Start initialization
    IrohMain._initPromise = (async () => {
      try {
        //////console.log("IrohMain: Starting initialization of main node");
        const WORKER_BRIDGE = Buffer.from("worker-bridge");
        const protocols = {
          [WORKER_BRIDGE.toString("utf8")]: (_err: unknown, _ep: unknown, _client: any) => ({
            accept: async (err: unknown, connecting: any) => {
              if (err) {
                console.error("MainNode: inbound connection error", err);
                return;
              }
              const conn = await connecting.connect();
              //////console.log("MainNode: accepted inbound connection from a worker");
              // We'll read the message in a readToEnd manner if we want
              // (The example below is symmetrical, so let's keep it minimal.)
            },
          }),
        };

        IrohMain._mainNode = await Iroh.memory({ protocols });
        IrohMain._initialized = true;
        const addr = await IrohMain._mainNode.net.nodeAddr();
        //////console.log("IrohMain: Main node created. Node ID:", addr.nodeId);
        return IrohMain._mainNode;
      } catch (error) {
        console.error("IrohMain: Error initializing main node:", error);
        // Reset initialization state on error
        IrohMain._initialized = false;
        IrohMain._initPromise = null;
        throw error;
      }
    })();
    
    return IrohMain._initPromise;
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
  private _workerNodeMessageListeners: ((evt: MessageEvent) => void)[] = [];

  // Worker interface properties
  onmessage: ((this: Worker, e: MessageEvent) => any) = () => {};
  onmessageerror: ((this: Worker, e: MessageEvent) => any) = () => {};
  onerror: ((this: Worker, e: ErrorEvent) => any) = () => {};

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
        //////console.log("[Init] Initializing for remote worker mode");
        await IrohMain.init(); // ensure main node exists
        this._workerNode = await this._createWorkerNode();
      } else if (this._worker) {
        // Local worker mode - only create Iroh node if needed for sharing
        ////////console.log("[Init] Initializing for local worker mode");
        // Set up message handler for local worker
        this._worker.onmessage = (event: MessageEvent) => {
          ////////console.log("[LocalWorker] Received message from worker:");
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
        try {
          await this.postMessage(item.msg, 
            'transfer' in item ? item.transfer : item.options);
        } catch (error) {
          console.error("IrohWebWorker: Failed to process queued message:", error);
          const errorEvent = new ErrorEvent('error', { error });
          this._dispatchToListeners('error', errorEvent);
        }
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
            //////console.log("[IrohProtocol] Accepting inbound connection");
            // Each connection = 1 message from main -> worker
            const conn = await connecting.connect();
            //////console.log("[IrohProtocol] Connected");
            const bi = await conn.acceptBi();
            //////console.log("[IrohProtocol] Bidirectional stream accepted");

            try {
              // 1) read the entire request from main
              //////console.log("[IrohProtocol] Reading request from main");
              const MAX_REQUEST_SIZE = 65000; // Setting slightly below the 65536 limit
              const requestBytes = await bi.recv.readToEnd(MAX_REQUEST_SIZE);
              let requestObj: unknown;
              if (requestBytes && requestBytes.length > 0) {
                const requestText = new TextDecoder().decode(requestBytes);
                //////console.log(`[IrohProtocol] Received request: ${requestText.substring(0, 100)}${requestText.length > 100 ? '...' : ''}`);
                requestObj = JSON.parse(requestText);
              } else {
                //////console.log("[IrohProtocol] Empty request received");
              }

              // 2) forward the message to the Worker via the original Worker API
              ////console.log("[IrohProtocol] Forwarding message to Worker");
              
              // Set up a message listener that will forward responses back
              const messageListener = (evt: MessageEvent) => {
                if (this._terminated) return;
                
                try {
                  // Send the response back
                  const respText = this._serializeWithBigInt(evt.data);
                  const respBytes = new TextEncoder().encode(respText);
                  const respSize = respBytes.length;
                  
                  // Check if response is too large
                  const MAX_RESPONSE_SIZE = 65000; // Setting slightly below the 65536 limit
                  if (respSize > MAX_RESPONSE_SIZE) {
                    console.error(`[IrohProtocol] Response too large (${respSize} bytes). Maximum size is ${MAX_RESPONSE_SIZE} bytes.`);
                    
                    // Send an error message instead
                    const errorResp = this._serializeWithBigInt({
                      error: `Response too large (${respSize} bytes). Maximum size is ${MAX_RESPONSE_SIZE} bytes.`
                    });
                    
                    // Forward the error response asynchronously
                    (async () => {
                      try {
                        if (!bi.send.closed) {
                          await bi.send.writeAll(new TextEncoder().encode(errorResp));
                          console.log(`[IrohProtocol] Error response forwarded through Iroh`);
                        }
                      } catch (error) {
                        console.error(`[IrohProtocol] Failed to forward error response:`, error);
                      }
                    })();
                    
                    return;
                  }
                  
                  //console.log(`[IrohProtocol] Worker responded: size=${respSize} bytes, preview=${respText.substring(0, 50)}${respText.length > 50 ? '...' : ''}`);
                  
                  // Forward the response asynchronously
                  (async () => {
                    try {
                      if (!bi.send.closed) {
                        await bi.send.writeAll(respBytes);
                        //console.log(`[IrohProtocol] Response forwarded through Iroh: size=${respSize} bytes`);
                      } else {
                        console.warn(`[IrohProtocol] Cannot forward response: stream already closed`);
                      }
                    } catch (error) {
                      console.error(`[IrohProtocol] Failed to forward response: size=${respSize} bytes, error:`, error);
                      
                      // Clean up the listener since we failed to send the response
                      this._worker?.removeEventListener("message", messageListener);
                      const index = this._workerNodeMessageListeners.indexOf(messageListener);
                      if (index > -1) {
                        this._workerNodeMessageListeners.splice(index, 1);
                      }
                      
                      throw new Error("Failed to forward response through Iroh stream");
                    }
                  })();
                } catch (error) {
                  console.error(`[IrohProtocol] Error handling worker response:`, error);
                }
              };
              
              // Add the listener for all messages
              this._worker?.addEventListener("message", messageListener);
              
              // Store this listener so we can remove it when terminated
              this._workerNodeMessageListeners.push(messageListener);
              
              // Post the message to the worker script without waiting for a response
              this._worker?.postMessage(requestObj);
              //console.log("[IrohProtocol] Message posted to Worker");
            } catch (e) {
              console.error("WorkerNode: Error processing message:", e);
              throw e;
            } finally {
              // Make sure to properly close the stream
              try {
                if (!bi.recv.closed) {
                  await bi.recv.stopped();
                }
              } catch (closeError) {
                // Silently handle stream closing errors
              }
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
      //////console.log(`IrohWebWorker: Using remote node ID: ${this._remoteNodeId}`);
      
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
      //////console.log(`IrohWebWorker: Local node created. Node ID: ${addr.nodeId}`);
    }

    return iroh;
  }

  async getNode(): Promise<IrohNode> {
    if (!this._workerNode) {
      // Create the Iroh node on-demand for local workers
      if (this._worker && !this._remoteNodeId) {
        //////console.log("[GetNode] Creating Iroh node on-demand for local worker");
        await IrohMain.init(); // ensure main node exists
        this._workerNode = await this._createWorkerNode();
        
        // Log the node ID for debugging
        const workerAddr = await this._workerNode.net.nodeAddr();
        ////////console.log("[GetNode] Worker node created with ID:", workerAddr.nodeId);
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
        ////////console.log("[LocalWorker] Using direct Worker API for local worker");
        
        // Send the message directly to the worker
        if (Array.isArray(transferOrOptions)) {
          this._worker.postMessage(message, transferOrOptions);
        } else if (transferOrOptions) {
          this._worker.postMessage(message, transferOrOptions);
        } else {
          this._worker.postMessage(message);
        }
        ////////console.log("[LocalWorker] Message sent directly to worker");
        
        // In local mode, we don't need to wait for a response here
        // The worker's responses will be handled by the event listeners
        // that were set up during initialization
      } else {
        // Remote worker mode or proxy mode - use Iroh network
        //////console.log("[RemoteWorker] Using Iroh network for remote/proxy worker");
        await this._postMessageViaIroh(message);
      }
    } catch (error) {
      const errorEvent = new ErrorEvent('error', { error });
      this._dispatchToListeners('error', errorEvent);
      throw error;
    }
  }

  private async _postMessageViaIroh(msg: unknown, retryCount = 0, maxRetries = 3, delayMs = 1000) {
    if (!this._workerNode || this._terminated) return;

    const mainNode = IrohMain.node;
    const WORKER_BRIDGE = Buffer.from("worker-bridge");
    
    try {
      let conn;
      if (this._remoteNodeId) {
        // Remote mode: Connect via node ID
        //console.log(`[IrohNetwork] Connecting to remote node ID: ${this._remoteNodeId} (attempt ${retryCount + 1}/${maxRetries + 1})`);
        conn = await mainNode.node.endpoint().connect({ nodeId: this._remoteNodeId }, WORKER_BRIDGE);
        //console.log(`[IrohNetwork] Connected to remote node ID: ${this._remoteNodeId}`);
      } else {
        // Local mode: Connect directly to our worker node
        const workerAddr = await this._workerNode.net.nodeAddr();
        //console.log(`[IrohNetwork] Connecting to local worker node: ${workerAddr.nodeId} (attempt ${retryCount + 1}/${maxRetries + 1})`);
        conn = await mainNode.node.endpoint().connect(workerAddr, WORKER_BRIDGE);
        //console.log(`[IrohNetwork] Connected to local worker node: ${workerAddr.nodeId}`);
      }
      const bi = await conn.openBi();
      //console.log(`[IrohNetwork] Opened bidirectional stream`);

      // Write the message
      // Serialize the message with proper BigInt handling
      const text = this._serializeWithBigInt(msg);
      const textBytes = new TextEncoder().encode(text);
      
      // Check if message is too large (65KB is the limit based on the error)
      const MAX_MESSAGE_SIZE = 65000; // Setting slightly below the 65536 limit
      if (textBytes.length > MAX_MESSAGE_SIZE) {
        throw new Error(`Message too large (${textBytes.length} bytes). Maximum size is ${MAX_MESSAGE_SIZE} bytes.`);
      }
      
      //console.log(`[IrohNetwork] Sending message: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
      await bi.send.writeAll(textBytes);
      await bi.send.finish();
      //console.log(`[IrohNetwork] Message sent successfully`);

      // Don't wait for a response - just set up a listener for any future responses
      // This makes it behave more like a regular WebWorker
      this._listenForResponses(bi);
    } catch (e) {
      console.error(`[IrohNetwork] Failed to process message (attempt ${retryCount + 1}/${maxRetries + 1}):`, e);
      
      // Retry logic
      if (retryCount < maxRetries) {
        //console.log(`[IrohNetwork] Retrying in ${delayMs}ms... (${retryCount + 1}/${maxRetries})`);
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delayMs));
        
        // Exponential backoff for delay
        const nextDelayMs = delayMs * 2;
        
        // Retry with incremented counter
        return this._postMessageViaIroh(msg, retryCount + 1, maxRetries, nextDelayMs);
      }
      
      // If we've exhausted all retries, propagate the error
      console.error(`[IrohNetwork] All ${maxRetries + 1} attempts failed, giving up`);
      const errorEvent = new ErrorEvent('error', { error: e });
      this._dispatchToListeners('error', errorEvent);
      throw e;
    }
  }

  /**
   * Helper method to serialize objects containing BigInt values
   * Converts BigInt to string representation with a special marker
   */
  private _serializeWithBigInt(value: unknown): string {
    return JSON.stringify(value, (_, v) => {
      // If the value is a BigInt, convert it to a specially marked string
      if (typeof v === 'bigint') {
        return { __bigint__: v.toString() };
      }
      return v;
    });
  }

  /**
   * Helper method to deserialize objects with BigInt values
   */
  private _deserializeWithBigInt(text: string): any {
    return JSON.parse(text, (_, v) => {
      // Check for our special BigInt marker
      if (v && typeof v === 'object' && '__bigint__' in v) {
        return BigInt(v.__bigint__);
      }
      return v;
    });
  }

  /**
   * Set up a listener for responses on a bidirectional stream
   * This is done asynchronously to not block the message sending
   */
  private _listenForResponses(bi: any): void {
    // Start a separate async task to listen for responses
    (async () => {
      try {
        if (this._terminated) return;
        
        // Set a maximum size for response reading to prevent "stream too long" errors
        const MAX_RESPONSE_SIZE = 65000; // Setting slightly below the 65536 limit
        
        try {
          const responseBytes = await bi.recv.readToEnd(MAX_RESPONSE_SIZE);
          if (responseBytes && responseBytes.length > 0 && !this._terminated) {
            const responseText = new TextDecoder().decode(responseBytes);
            //console.log(`[IrohNetwork] Received response: ${responseText.substring(0, 100)}${responseText.length > 100 ? '...' : ''}`);
            
            try {
              // Parse the response using our BigInt-aware deserializer
              const responseObj = this._deserializeWithBigInt(responseText);
              const messageEvent = new MessageEvent('message', { data: responseObj });
              this._dispatchToListeners('message', messageEvent);
              //console.log(`[IrohNetwork] Response dispatched to listeners`);
            } catch (parseError) {
              console.error(`[IrohNetwork] Failed to parse response:`, parseError);
            }
          }
        } catch (streamError: any) {
          if (streamError?.message?.includes('stream too long')) {
            console.error(`[IrohNetwork] Response exceeded maximum size limit of ${MAX_RESPONSE_SIZE} bytes`);
            const errorEvent = new ErrorEvent('error', { 
              error: new Error(`Response too large. Maximum size is ${MAX_RESPONSE_SIZE} bytes.`) 
            });
            this._dispatchToListeners('error', errorEvent);
          } else {
            throw streamError; // Re-throw other stream errors
          }
        }
      } catch (error) {
        console.error(`[IrohNetwork] Error while listening for responses:`, error);
        // Don't propagate this error since it's in a background task
      } finally {
        // Make sure to properly close the stream
        try {
          if (!bi.recv.closed) {
            await bi.recv.stopped();
          }
        } catch (closeError) {
          // Silently handle stream closing errors
        }
      }
    })();
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
    for (const listener of this._workerNodeMessageListeners) {
      this._worker?.removeEventListener("message", listener);
    }
    this._workerNodeMessageListeners = [];
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