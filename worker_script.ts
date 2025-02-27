// worker_script.ts

const worker = self as unknown as Worker

worker.onmessage = (evt) => {
  console.log("[WorkerScript] Received message from main =>", JSON.stringify(evt.data));

  // Handle ping message (used for node initialization)
  if (evt.data && evt.data.ping === true) {
    console.log("[WorkerScript] Received ping message, responding with pong");
    worker.postMessage({ pong: true });
    return;
  }

  // Simulate some processing...
  const result = {
    echoed: evt.data,
    from: "worker_script",
    timestamp: new Date().toISOString()
  };

  // Send exactly one response
  console.log("[WorkerScript] Sending response =>", JSON.stringify(result));
  worker.postMessage(result);
};

console.log("[WorkerScript] Worker initialized and ready");
