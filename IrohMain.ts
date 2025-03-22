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
        console.log("IrohMain: Starting initialization of main node"); 
        const WORKER_BRIDGE = Buffer.from("worker-bridge");
        const protocols = {
          [WORKER_BRIDGE.toString("utf8")]: (_err: unknown, _ep: unknown, _client: any) => ({
            accept: async (err: unknown, connecting: any) => {
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