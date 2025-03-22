// large_message_test.ts
import { IrohWebWorker } from "./IrohWorker.ts";

/**
 * Test sending large messages through the IrohWebWorker proxy system
 * This test verifies that the 10MB buffer size works correctly
 */
async function testLargeMessageTransfer() {
  console.log("\n=== Testing Large Message Transfer with IrohWebWorker ===");

  // Create worker
  const worker = new IrohWebWorker(new URL("./large_message_worker.ts", import.meta.url).href,
    { type: "module" }
  );
  
  // Set up message handlers
  worker.addEventListener('message', (evt) => {
    if (evt.data && evt.data.type === 'stats') {
      console.log(`Received stats: ${evt.data.receivedSize} bytes, hash: ${evt.data.hash}`);
    } else {
      console.log("IrohWebWorker response:", evt.data);
    }
  });

  // Test error handling
  worker.onerror = (error) => {
    console.error("IrohWebWorker error:", error);
  };

  // Create test data of various sizes
  console.log("Creating test data...");
  
  // Test with different message sizes
  const testSizes = [
    1024,                // 1KB
    1024 * 1024,         // 1MB
    5 * 1024 * 1024,     // 5MB
    9 * 1024 * 1024      // 9MB (just under our 10MB limit)
  ];
  
  for (const size of testSizes) {
    // Create a buffer with deterministic pattern data instead of random data
    const buffer = new Uint8Array(size);
    fillBufferWithPattern(buffer);
    
    // Calculate a simple hash of the data for verification
    const hash = await calculateHash(buffer);
    
    console.log(`Sending message of size: ${size} bytes, hash: ${hash}`);
    
    // Send the large message
    await worker.postMessage({
      type: 'largeData',
      size: size,
      data: buffer,
      hash: hash
    });
    
    // Wait a bit to ensure message is processed
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Test with a message that's too large (should trigger an error)
  try {
    console.log("Testing with oversized message (should trigger an error)...");
    const oversizedBuffer = new Uint8Array(11 * 1024 * 1024); // 11MB (exceeds our 10MB limit)
    fillBufferWithPattern(oversizedBuffer);
    
    await worker.postMessage({
      type: 'largeData',
      size: oversizedBuffer.length,
      data: oversizedBuffer
    });
  } catch (error) {
    console.log("Expected error with oversized message:", error.message);
  }

  // Wait a bit to ensure all messages are processed
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Test terminate
  console.log("Terminating IrohWebWorker...");
  worker.terminate();
}

/**
 * Test sending large messages through the IrohWebWorker proxy system using node ID
 * This tests the remote worker scenario
 */
async function testLargeMessageTransferWithProxy() {
  console.log("\n=== Testing Large Message Transfer with IrohWebWorker Proxy ===");

  // First create a local worker
  console.log("Creating local worker...");
  const sourceWorker = new IrohWebWorker(new URL("./large_message_worker.ts", import.meta.url).href,
    { type: "module" }
  );
  
  // Set up message handlers
  sourceWorker.onmessage = (evt) => {
    if (evt.data && evt.data.type === 'stats') {
      console.log(`Local worker received: ${evt.data.receivedSize} bytes, hash: ${evt.data.hash}`);
    } else {
      console.log("Local worker response:", evt.data);
    }
  };
  
  // Get the node ID
  console.log("Getting node ID...");
  const { nodeId } = await sourceWorker.getIrohAddr();
  console.log("Source worker node ID:", nodeId);
  
  // Small delay to ensure the node is fully registered
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Create a remote worker using the node ID
  console.log("Creating remote worker from node ID...");
  const remoteWorker = new IrohWebWorker({ nodeId });
  
  // Set up message handlers
  remoteWorker.onmessage = (evt) => {
    if (evt.data && evt.data.type === 'stats') {
      console.log(`Remote worker received: ${evt.data.receivedSize} bytes, hash: ${evt.data.hash}`);
      if (evt.data.error) {
        console.error(`Remote worker error: ${evt.data.error}`);
      }
    } else {
      console.log("Remote worker response:", evt.data);
    }
  };
  
  remoteWorker.addEventListener("error", (evt) => {
    console.log("Remote worker error:", evt);
  });
  
  // Create test data
  console.log("Creating test data for remote worker...");
  
  // Test with different message sizes for proxy - using smaller sizes for the proxy test
  const testSizes = [
    1024,                // 1KB
    10 * 1024,           // 10KB
    100 * 1024           // 100KB
  ];
  
  for (const size of testSizes) {
    // Create a buffer with deterministic pattern data
    const buffer = new Uint8Array(size);
    fillBufferWithPattern(buffer);
    
    // Calculate a simple hash of the data for verification
    const hash = await calculateHash(buffer);
    
    // Convert binary data to base64 string for reliable transmission through JSON
    const base64Data = uint8ArrayToBase64(buffer);
    
    console.log(`Sending message to remote worker, size: ${size} bytes, hash: ${hash}`);
    console.log(`Base64 encoded size: ${base64Data.length} characters`);
    
    // Send the large message with base64 encoded data
    await remoteWorker.postMessage({
      type: 'largeData',
      size: size,
      dataFormat: 'base64',
      data: base64Data,
      hash: hash
    });
    
    // Wait a bit to ensure message is processed
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  
  // Wait for all messages to be processed
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log("Terminating workers...");
  sourceWorker.terminate();
  remoteWorker.terminate();
}

/**
 * Calculate a simple hash of the data for verification
 */
async function calculateHash(data: Uint8Array): Promise<string> {
  // Use a simple hash function for verification
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fill a buffer with a deterministic pattern
 */
function fillBufferWithPattern(buffer: Uint8Array): void {
  // Fill the buffer with a repeating pattern
  // This is much faster than using crypto.getRandomValues for large buffers
  const pattern = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = pattern[i % pattern.length];
  }
  
  // Add some uniqueness to the beginning and end of the buffer
  if (buffer.length > 20) {
    // Add timestamp to beginning
    const timestamp = Date.now();
    const timestampBytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      timestampBytes[i] = (timestamp >> (i * 8)) & 0xFF;
    }
    buffer.set(timestampBytes, 0);
    
    // Add some unique bytes at the end
    for (let i = 0; i < 8; i++) {
      buffer[buffer.length - 8 + i] = i * 33;
    }
  }
}

/**
 * Convert Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

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

async function main() {
  try {
    await testLargeMessageTransfer();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await testLargeMessageTransferWithProxy();
    
    // Wait a bit before exiting to see all output
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log("\nAll tests completed!");
  } catch (error) {
    console.error("Test failed:", error);
  }
}

main().catch(console.error);
