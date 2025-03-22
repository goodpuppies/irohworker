// large_message_worker.ts

const worker = self as unknown as Worker;

// Track statistics for verification
let totalMessagesReceived = 0;
let totalBytesReceived = 0;

worker.onmessage = async (evt) => {
  console.log("[LargeMessageWorker] Received message from main");

  // Handle ping message (used for node initialization)
  if (evt.data && evt.data.ping === true) {
    console.log("[LargeMessageWorker] Received ping message, responding with pong");
    worker.postMessage({ pong: true });
    return;
  }

  // Handle large data message
  if (evt.data && evt.data.type === 'largeData') {
    const { size, data, dataFormat, hash } = evt.data;
    
    // Log detailed information about the received data
    console.log(`[LargeMessageWorker] Received message with type: ${evt.data.type}`);
    console.log(`[LargeMessageWorker] Expected size: ${size}`);
    console.log(`[LargeMessageWorker] Data format: ${dataFormat || 'binary'}`);
    console.log(`[LargeMessageWorker] Data type: ${data ? typeof data : 'undefined'}`);
    
    // Process the data based on format
    let processedData: Uint8Array;
    
    if (dataFormat === 'base64' && typeof data === 'string') {
      // Handle base64 encoded data
      console.log(`[LargeMessageWorker] Decoding base64 data of length: ${data.length}`);
      try {
        processedData = base64ToUint8Array(data);
        console.log(`[LargeMessageWorker] Successfully decoded base64 data to ${processedData.length} bytes`);
      } catch (error) {
        console.error(`[LargeMessageWorker] Error decoding base64 data: ${error.message}`);
        worker.postMessage({
          type: 'stats',
          error: `Base64 decoding error: ${error.message}`,
          timestamp: new Date().toISOString()
        });
        return;
      }
    } else if (data instanceof Uint8Array) {
      // Handle binary data directly
      processedData = data;
      console.log(`[LargeMessageWorker] Using binary data directly: ${data.length} bytes`);
    } else {
      // Invalid data format
      console.error("[LargeMessageWorker] Invalid data received, cannot process");
      worker.postMessage({
        type: 'stats',
        error: 'Invalid data received',
        expectedSize: size,
        actualData: data ? typeof data : 'undefined',
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    // Verify the received data
    totalMessagesReceived++;
    totalBytesReceived += processedData.length;
    
    console.log(`[LargeMessageWorker] Processed data message: ${processedData.length} bytes`);
    
    // Calculate hash for verification
    let receivedHash;
    try {
      const hashBuffer = await crypto.subtle.digest('SHA-256', processedData);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      receivedHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (error) {
      console.error("[LargeMessageWorker] Error calculating hash:", error);
      worker.postMessage({
        type: 'stats',
        error: `Hash calculation error: ${error.message}`,
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    // Send statistics back to main thread
    const result = {
      type: 'stats',
      messageNumber: totalMessagesReceived,
      receivedSize: processedData.length,
      expectedSize: size,
      hash: receivedHash,
      hashMatch: hash === receivedHash,
      timestamp: new Date().toISOString()
    };
    
    // Send response
    console.log("[LargeMessageWorker] Sending stats response");
    worker.postMessage(result);
    return;
  }

  // Handle other messages
  const result = {
    echoed: evt.data,
    from: "large_message_worker",
    timestamp: new Date().toISOString()
  };

  // Send response
  console.log("[LargeMessageWorker] Sending response");
  worker.postMessage(result);
};

console.log("[LargeMessageWorker] Worker initialized and ready");

/**
 * Convert base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
