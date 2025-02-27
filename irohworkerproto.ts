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
 * IrohWebworker:
 * Creates a local Worker + worker node. The main node
 * connects to it, but we only open a stream on demand
 * for each .postMessage().
 */
export class IrohWorker {
  /** The underlying Worker instance. */
  private readonly _worker: Worker;
  /** The node belonging to the worker. */
  private readonly _workerNode: any;
  /** The local onmessage callback. */
  onmessage?: (evt: MessageEvent) => void;

  private constructor(worker: Worker, workerNode: any) {
    this._worker = worker;
    this._workerNode = workerNode;
  }

  /**
   * Create a new IrohWebworker. Under the hood:
   *  1) Ensure main node is initialized
   *  2) Spawn a worker node + actual Worker
   *  3) We'll do "one-message-per-stream" for .postMessage
   */
  static async create(scriptURL: string | URL, options?: WorkerOptions): Promise<IrohWorker> {
    await IrohMain.init(); // ensure main node
    const { worker, iroh } = await IrohWorker._createWorkerNode(scriptURL, options);

    const instance = new IrohWorker(worker, iroh);
    return instance;
  }

  /**
   * Emulate the Worker API's "postMessage":
   *  1) Open a new stream from the main node to the worker node
   *  2) Write the message (JSON)
   *  3) Read the worker's response (single message)
   *  4) Fire instance.onmessage(...)
   */
  async postMessage(msg: unknown) {
    // 1) Connect from main node -> worker node
    const mainNode = IrohMain.node;
    const workerAddr = await this._workerNode.net.nodeAddr();
    const WORKER_BRIDGE = Buffer.from("worker-bridge");
    const conn = await mainNode.node.endpoint().connect(workerAddr, WORKER_BRIDGE);
    const bi = await conn.openBi();

    // 2) Write the message
    const text = JSON.stringify(msg);
    await bi.send.writeAll(new TextEncoder().encode(text));
    await bi.send.finish();

    // 3) Read the worker's single response
    const responseBytes = await bi.recv.readToEnd(65536);
    if (this.onmessage && responseBytes && responseBytes.length > 0) {
      try {
        const responseObj = JSON.parse(new TextDecoder().decode(responseBytes));
        // Fire the local onmessage callback with { data: ... }
        this.onmessage({ data: responseObj } as MessageEvent);
      } catch (e) {
        console.error("IrohWebworker: failed to parse worker response", e);
      }
    }
  }

  /**
   * Internal function to create a Worker node that "owns" the Worker.
   * It sets up a "worker-bridge" protocol so that each inbound stream
   * is a single message from main -> worker, and the response is a
   * single message from worker -> main.
   */
  private static async _createWorkerNode(
    scriptURL: string | URL,
    options?: WorkerOptions
  ): Promise<{ worker: Worker; iroh: any }> {
    let workerScript = typeof scriptURL === "string" ? scriptURL : scriptURL.toString();
    if (
      !workerScript.startsWith("http://") &&
      !workerScript.startsWith("https://") &&
      !workerScript.startsWith("file://")
    ) {
      workerScript = new URL(workerScript, import.meta.url).href;
    }

    // Create the Worker
    const worker = new Worker(workerScript, options);
    console.log("IrohWebworker: Worker created from", workerScript);

    // "worker-bridge" protocol for one-message-per-stream
    const WORKER_BRIDGE = Buffer.from("worker-bridge");
    const protocols = {
      [WORKER_BRIDGE.toString("utf8")]: (_err: unknown, _ep: unknown, _client: any) => ({
        accept: async (err: unknown, connecting: any) => {
          if (err) {
            console.error("WorkerNode: inbound connection error", err);
            return;
          }
          // Each connection = 1 message from main -> worker
          const conn = await connecting.connect();
          const bi = await conn.acceptBi();

          // 1) read the entire request from main
          const requestBytes = await bi.recv.readToEnd(65536);
          let requestObj: any;
          if (requestBytes && requestBytes.length > 0) {
            try {
              requestObj = JSON.parse(new TextDecoder().decode(requestBytes));
            } catch (e) {
              console.error("WorkerNode: failed to parse inbound message", e);
            }
          }

          // 2) forward the message to the Worker, get a single response
          // Because a Worker can in principle do multiple `self.postMessage(...)`,
          // we’ll do a quick hack: we assume it sends exactly one reply for each inbound message.
          // That means we’ll add a one-time event listener.
          let responseObj: any = null;
          const listener = (evt: MessageEvent) => {
            responseObj = evt.data;
          };
          worker.addEventListener("message", listener);

          // Post it to the worker script
          worker.postMessage(requestObj);

          // Wait a short time for a response, or in a real system we’d do a more robust approach:
          await new Promise((resolve) => setTimeout(resolve, 10));

          worker.removeEventListener("message", listener);

          // 3) send the single response back
          if (responseObj != null) {
            const respText = JSON.stringify(responseObj);
            await bi.send.writeAll(new TextEncoder().encode(respText));
          }
          await bi.send.finish();
          await bi.send.stopped();
        },
      }),
    };

    // Create the worker’s Iroh node
    const iroh = await Iroh.memory({ protocols });
    const addr = await iroh.net.nodeAddr();
    console.log("WorkerNode: Iroh node created for worker. Node ID:", addr.nodeId);

    return { worker, iroh };
  }
}