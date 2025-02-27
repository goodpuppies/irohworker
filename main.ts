// main.ts
import { IrohWebWorker } from "./IrohWorker.ts";

async function testNewIrohWebWorker() {
  console.log("\n=== Testing New IrohWebWorker ===");

  // Create worker
  const worker = new IrohWebWorker(new URL("./worker_script.ts", import.meta.url).href,
    { type: "module" }
  );
  
  // Test standard Worker API event listener
  worker.addEventListener('message', (evt) => {
    console.log("IrohWebWorker response (addEventListener):", evt.data);
  });

  // Test standard Worker API onmessage
  worker.onmessage = (evt) => {
    console.log("IrohWebWorker response (onmessage):", evt.data);
  };

  // Test error handling
  worker.onerror = (error) => {
    console.error("IrohWebWorker error:", error);
  };

  // Send test messages
  await worker.postMessage({ test: "web worker test 1" });
  await worker.postMessage({ test: "web worker test 2" });

  // Test with transferable (even though our worker doesn't use it)
  const arrayBuffer = new ArrayBuffer(8);
  await worker.postMessage({ test: "web worker with transferable" }, [arrayBuffer]);

  // Test with structured clone options
  await worker.postMessage({ test: "web worker with options" }, { transfer: [] });

  // Wait a bit to ensure all messages are processed
  await new Promise(resolve => setTimeout(resolve, 500));

  // Test terminate
  console.log("Terminating IrohWebWorker...");
  worker.terminate();
}

async function testNewIrohWebWorkerProxy() {
  console.log("\n=== sanjty test ===");
  // Create a local worker
  const worker = new IrohWebWorker(new URL("./worker_script.ts", import.meta.url).href,
    { type: "module" }
  );

  // Set up message handlers
  worker.onmessage = (evt) => {
    console.log("IrohWebWorker response (onmessage):", evt.data);
  };
  worker.addEventListener("message", (evt) => {
    console.log("IrohWebWorker response (addEventListener):", evt.data);
  });
  worker.addEventListener("error", (evt) => {
    console.log("IrohWebWorker error:", evt);
  });

  // Test basic messaging
  await worker.postMessage({ test: "web worker test 1" });
  await worker.postMessage({ test: "web worker test 2" });

  // Test with transferable
  await worker.postMessage({ test: "web worker with transferable" }, []);

  // Test with options
  await worker.postMessage({ test: "web worker with options" }, { transfer: [] });

  await new Promise(resolve => setTimeout(resolve, 5000));

  // Create a proxy worker using the node from the first worker
  console.log("\n=== Testing Proxy Worker ===");
  const node = await worker.getNode();
  if (!node) throw new Error("Failed to get worker node");
  
  console.log("creating proxy worker:", node);
  const proxyWorker = new IrohWebWorker({ node });
  proxyWorker.onmessage = (evt) => {
    console.log("ProxyWorker response:", evt.data);
  };
  proxyWorker.addEventListener("error", (evt) => {
    console.log("ProxyWorker error:", evt);
  });

  // Test proxy worker messaging
  await proxyWorker.postMessage({ test: "proxy worker test" });

  console.log("\nTerminating workers...");
  worker.terminate();
  proxyWorker.terminate();
}

async function testNewIrohWebWorkerFromNodeId() {
  console.log("\n=== Testing IrohWebWorker from Node ID ===");

  // First create a local worker - this should use direct communication
  console.log("\n--- Creating local worker (should use direct communication) ---");
  const sourceWorker = new IrohWebWorker(new URL("./worker_script.ts", import.meta.url).href,
    { type: "module" }
  );
  
  // Set up message handlers
  sourceWorker.onmessage = (evt) => {
    console.log("Local worker response (onmessage):", evt.data);
  };
  
  // Send a test message to the local worker - should use direct communication
  console.log("Sending test message to local worker (should use direct communication)...");
  await sourceWorker.postMessage({ test: "local worker test" });
  
  // Now get the node ID - this should create the Iroh node on-demand
  console.log("\n--- Getting node ID (should create Iroh node on-demand) ---");
  const { nodeId } = await sourceWorker.getIrohAddr();
  console.log("Source worker node ID:", nodeId);
  
  // Small delay to ensure the node is fully registered with discovery service
  console.log("Waiting for node to be fully registered...");
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Create a remote worker using the node ID
  console.log("\n--- Creating remote worker from node ID (will use Iroh network) ---");
  const remoteWorker = new IrohWebWorker({ nodeId });
  
  // Set up message handlers
  remoteWorker.onmessage = (evt) => {
    console.log("Remote worker response (onmessage):", evt.data);
  };
  
  remoteWorker.addEventListener("error", (evt) => {
    console.log("Remote worker error:", evt);
  });
  
  // Test messaging through the remote worker - should use Iroh network
  console.log("Sending test messages to remote worker (should use Iroh network)...");
  await remoteWorker.postMessage({ test: "remote worker test 1" });
  await remoteWorker.postMessage({ test: "remote worker test 2" });
  
  // Wait a bit for all messages to be processed
  await new Promise(resolve => setTimeout(resolve, 500));
  
  console.log("Terminating workers...");
  sourceWorker.terminate();
  remoteWorker.terminate();
}

async function main() {
  try {
    // Test both implementations
    //await testOriginalIrohWorker();
    //await testNewIrohWebWorker();
    //await testNewIrohWebWorkerProxy();
    await testNewIrohWebWorkerFromNodeId();
    
    // Wait a bit before exiting to see all output
    await new Promise(resolve => setTimeout(resolve, 1800));
    console.log("\nAll tests completed!");
  } catch (error) {
    console.error("Test failed:", error);
  }
}

main().catch(console.error);
