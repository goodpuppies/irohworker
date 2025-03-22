import { Iroh } from 'npm:@number0/iroh'
import { Buffer } from "node:buffer"
import process from "node:process";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { setImmediate } from "node:timers";

/**
 * Tests the maximum data throughput of Iroh using optimized settings with worker threads
 */
async function testIrohThroughput() {
  // Make test duration configurable
  const TEST_DURATION_SECONDS = 5;
  // Extended time to wait for receiving all data
  const RECEIVER_EXTRA_TIME_SECONDS = 10;

  console.log(`Starting Iroh throughput test (${TEST_DURATION_SECONDS}-second measurement)...`)
  console.log(`Will wait ${RECEIVER_EXTRA_TIME_SECONDS} additional seconds for full data reception`)

  const alpn = Buffer.from('iroh-throughput/test/0')

  // Optimize buffer sizes for JS
  const ONE_MB = 1024 * 1024
  const chunkSize = 512 * 1024  // Use larger chunks for better throughput
  const testData = Buffer.alloc(chunkSize, 'A')

  let totalBytesSent = 0
  let totalBytesReceived = 0
  let isRunning = true
  let node1, node2; // Declare variables for cleanup

  // Track precise interval data
  let testBytesSent = 0
  let testBytesReceived = 0
  let testStartTimestamp = 0

  // Additional tracking for "eventually received" data
  let eventuallyReceived = 0
  let receivingComplete = false

  // Add a global timeout with longer duration to match the test + extended receive time
  const globalTimeout = setTimeout(() => {
    console.log("Global timeout reached - forcing test completion");
    receivingComplete = true;
    reportResultsAndExit();
  }, TEST_DURATION_SECONDS * 1000 + RECEIVER_EXTRA_TIME_SECONDS * 1000 + 5000); // Extra safety margin

  // Function to report results and exit
  function reportResultsAndExit() {
    try {
      // Calculate accurate throughput
      const sentMB = testBytesSent / ONE_MB;
      const receivedMB = testBytesReceived / ONE_MB;
      const eventuallyReceivedMB = eventuallyReceived / ONE_MB;

      console.log(`\n--- Iroh ${TEST_DURATION_SECONDS}-Second Throughput Results ---`);
      console.log(`Data sent in ${TEST_DURATION_SECONDS} seconds: ${sentMB.toFixed(2)} MB`);
      console.log(`Data received during test: ${receivedMB.toFixed(2)} MB`);
      console.log(`Data received eventually: ${eventuallyReceivedMB.toFixed(2)} MB`);
      console.log(`Send throughput: ${(sentMB / TEST_DURATION_SECONDS).toFixed(2)} MB/s`);
      console.log(`Receive throughput: ${(receivedMB / TEST_DURATION_SECONDS).toFixed(2)} MB/s`);

      if (eventuallyReceived > 0) {
        const dataRatio = (eventuallyReceivedMB / sentMB * 100).toFixed(2);
        console.log(`\nEventually received ${dataRatio}% of sent data`);

        if (Math.abs(eventuallyReceived - testBytesSent) < chunkSize) {
          console.log("All data was successfully received - no data loss detected");
        } else {
          console.log(`Data difference: ${((testBytesSent - eventuallyReceived) / ONE_MB).toFixed(2)} MB`);
        }
      }

      // Clean up
      console.log("\nShutting down nodes silently...");
      // Force exit after cleanup attempt
      setTimeout(() => {
        process.exit(0);
      }, 1000);

      if (node2) node2.node.shutdown().catch(() => { });
      if (node1) node1.node.shutdown().catch(() => { });

      // Clear the timeout
      clearTimeout(globalTimeout);
    } catch (e) {
      process.exit(1);
    }
  }

  const protocols = {
    [alpn]: (err, ep) => ({
      accept: async (err, connecting) => {
        if (err) return;

        const conn = await connecting.connect()
        console.log("Server: Connection established")
        const bi = await conn.acceptBi()
        console.log("Server: Stream accepted")

        // Receive data until the test stops
        try {
          console.log("Server: Starting to receive data")

          // Create a receiver worker to handle receiving data
          const receiverWorker = new Worker(new URL(import.meta.url), {
            workerData: { mode: 'receiver' }
          });

          // Use a pre-allocated buffer for reading
          const readBuffer = new Uint8Array(chunkSize);

          // Set up communication with the worker
          receiverWorker.on('message', (msg) => {
            if (msg.type === 'bytesReceived') {
              const now = Date.now();
              totalBytesReceived += msg.bytes;
              eventuallyReceived += msg.bytes; // Track total bytes eventually received

              // Track data received within the test window
              if (now - testStartTimestamp <= TEST_DURATION_SECONDS * 1000) {
                testBytesReceived += msg.bytes;
              }
            } else if (msg.type === 'complete') {
              console.log(`Server: Total received: ${(msg.totalReceived / ONE_MB).toFixed(2)} MB`);
              receivingComplete = true;

              // Now that we have all the data, trigger the final report
              if (!isRunning) {
                reportResultsAndExit();
              }
            }
          });

          // Handle receiving in the main thread but offload processing
          while (isRunning || !receivingComplete) {
            try {
              const bytesRead = await bi.recv.read(readBuffer);

              if (!bytesRead || bytesRead <= 0n) {
                console.log("Server: End of stream reached");
                break;
              }

              // Track if we're in the extended receiving period
              if (!isRunning) {
                console.log("Receiving data in extended period...");
              }

              // Send the byte count to the worker (instead of copying buffer)
              const bytesReadNum = Number(bytesRead);
              receiverWorker.postMessage({ type: 'received', bytes: bytesReadNum });

            } catch (readError) {
              if (readError.message.includes('closed') || (readError.message.includes('reset') && !isRunning)) {
                console.log("Server: Stream closed or reset");
                break;
              }
              console.error("Server read error:", readError.message);
              break;
            }
          }

          receiverWorker.postMessage({ type: 'complete' });
          console.log("Server: Finished receiving data");

          // Clean up worker 
          setTimeout(() => {
            receiverWorker.terminate();
          }, 1000);

        } catch (e) {
          console.error("Server error:", e.message);
        }
      },
      shutdown: (err) => {
        // Suppress shutdown errors
      }
    })
  }

  try {
    // Create server node
    node1 = await Iroh.memory({ protocols })
    const nodeAddr = await node1.net.nodeAddr()
    console.log(`Server node ready`)

    // Create client node
    node2 = await Iroh.memory()
    const endpoint = node2.node.endpoint()
    console.log(`Client node ready`)

    // Connect to server
    console.log("Connecting to server...")
    const conn = await endpoint.connect(nodeAddr, alpn)
    console.log("Client: Connection established")
    const bi = await conn.openBi()
    console.log("Client: Stream opened")

    // Create a sender worker
    const senderWorker = new Worker(new URL(import.meta.url), {
      workerData: {
        mode: 'sender',
        chunkSize,
        timeout: TEST_DURATION_SECONDS * 1000  // Send for configured seconds
      }
    });

    console.log(`\n--- Starting ${TEST_DURATION_SECONDS}-second throughput measurement ---`);
    testStartTimestamp = Date.now(); // Timestamp the exact start

    // Set up communication with the sender worker
    senderWorker.on('message', async (msg) => {
      if (msg.type === 'sendChunk') {
        // Send the chunk (worker can't access the stream directly)
        try {
          await bi.send.write(testData);

          const now = Date.now();
          totalBytesSent += testData.length;

          // Only count data sent within the test window
          if (now - testStartTimestamp <= TEST_DURATION_SECONDS * 1000) {
            testBytesSent += testData.length;
          }

          senderWorker.postMessage({ type: 'chunkSent', bytes: testData.length });
        } catch (error) {
          // Suppress error spam
        }
      } else if (msg.type === 'complete') {
        console.log(`\nTest duration complete (${TEST_DURATION_SECONDS} seconds of sending)`);
        console.log(`Sent ${(totalBytesSent / ONE_MB).toFixed(2)} MB during test`);
        isRunning = false;

        // Finish sending
        try {
          await bi.send.finish();
          console.log("Client: Stream finished - all data sent");
        } catch (e) {
          console.error("Error finishing stream:", e.message);
        }

        // Clean up worker
        senderWorker.terminate();

        // Wait for extended period to receive all data
        console.log(`\nWaiting additional ${RECEIVER_EXTRA_TIME_SECONDS} seconds for complete reception...`);

        // Only report if receiving is already complete (which is unlikely at this point)
        if (receivingComplete) {
          reportResultsAndExit();
        }
      }
    });

    // Start the sending process
    senderWorker.postMessage({ type: 'start' });

  } catch (error) {
    console.error("Test failed to start:", error);
    process.exit(1);
  }
}

// Worker thread code
if (!isMainThread) {
  const { mode } = workerData;

  if (mode === 'sender') {
    // This is the sender worker
    const { chunkSize, timeout } = workerData;
    let totalBytesSent = 0;
    const startTime = Date.now();

    parentPort.on('message', (msg) => {
      if (msg.type === 'start') {
        // Start sending requests to the main thread
        const sendNextChunk = () => {
          if (Date.now() - startTime < timeout) {
            parentPort.postMessage({ type: 'sendChunk' });
            // Using setImmediate for better throughput than setTimeout
            setImmediate(sendNextChunk);
          } else {
            // We're done sending
            parentPort.postMessage({ type: 'complete', totalSent: totalBytesSent });
          }
        };

        sendNextChunk();
      } else if (msg.type === 'chunkSent') {
        totalBytesSent += msg.bytes;
      }
    });
  } else if (mode === 'receiver') {
    // This is the receiver worker
    let totalBytesReceived = 0;

    parentPort.on('message', (msg) => {
      if (msg.type === 'received') {
        totalBytesReceived += msg.bytes;
        parentPort.postMessage({ type: 'bytesReceived', bytes: msg.bytes });
      } else if (msg.type === 'complete') {
        parentPort.postMessage({ type: 'complete', totalReceived: totalBytesReceived });
      }
    });
  }
} else {
  // Hide process unhandled rejection warnings
  process.on('unhandledRejection', () => { });

  // Run the throughput test in the main thread
  testIrohThroughput().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}