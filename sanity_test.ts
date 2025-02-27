// sanity_test.ts - Basic test for Iroh gossip discovery
import { Iroh } from "npm:@number0/iroh";
import { Buffer } from "node:buffer";

async function testGossipDiscovery() {
  console.log("=== Testing Basic Iroh Gossip Discovery ===");

  // Create two memory nodes
  console.log("Creating two Iroh memory nodes...");
  const node0 = await Iroh.memory();
  const node1 = await Iroh.memory();

  // Create a topic (32 bytes, filled with zeros)
  console.log("Creating a topic...");
  const rawTopic = new Uint8Array(32);
  rawTopic.fill(0, 1, 32);
  const topic = Array.from(rawTopic);

  // Get node IDs and addresses
  const node1Id = await node1.net.nodeId();
  const node1Addr = await node1.net.nodeAddr();
  console.log("Node 1 ID:", node1Id);

  // Add node1's address to node0's network
  console.log("Adding node1's address to node0's network...");
  await node0.net.addNodeAddr(node1Addr);

  // Create promises to track events
  console.log("Setting up promises for discovery and message receipt...");
  let resolve0, reject0;
  const promise0 = new Promise((resolve, reject) => {
    resolve0 = resolve;
    reject0 = reject;
  });

  let resolve1, reject1;
  const promise1 = new Promise((resolve, reject) => {
    resolve1 = resolve;
    reject1 = reject;
  });

  // Subscribe node0 to the topic, looking for node1
  console.log("Subscribing node0 to the topic, looking for node1...");
  const sink0 = await node0.gossip.subscribe(topic, [node1Id], (error, event) => {
    if (error != null) {
      console.error("Node 0 gossip error:", error);
      return reject0(error);
    }

    if (event.joined != null) {
      console.log("Node 0 discovered a node:", event.joined.nodeId);
      resolve0(event);
    }
  });

  // Get node0's ID and address
  const node0Id = await node0.net.nodeId();
  const node0Addr = await node0.net.nodeAddr();
  console.log("Node 0 ID:", node0Id);

  // Add node0's address to node1's network
  console.log("Adding node0's address to node1's network...");
  await node1.net.addNodeAddr(node0Addr);

  // Subscribe node1 to the topic, looking for messages
  console.log("Subscribing node1 to the topic, looking for messages...");
  const sink1 = await node1.gossip.subscribe(topic, [node0Id], (error, event) => {
    if (error != null) {
      console.error("Node 1 gossip error:", error);
      return reject1(error);
    }

    if (event.received != null) {
      console.log("Node 1 received a message:", Buffer.from(event.received.content).toString());
      resolve1(event.received);
    }
  });

  // Wait for node0 to discover node1
  console.log("Waiting for node0 to discover node1...");
  try {
    const discoveryEvent = await promise0;
    console.log("Discovery successful! Event:", discoveryEvent);

    // Send a message from node0 to node1
    console.log("Sending message from node0 to node1...");
    const message = "Hello from node0 to node1 via gossip!";
    const messageBytes = Array.from(Buffer.from(message, 'utf8'));
    await sink0.broadcast(messageBytes);

    // Wait for node1 to receive the message
    console.log("Waiting for node1 to receive the message...");
    const receivedMessage = await promise1;
    console.log("Message received by node1!");
    console.log("Message content:", Buffer.from(receivedMessage.content).toString());
    console.log("Message was from:", receivedMessage.deliveredFrom);
  } catch (error) {
    console.error("Test failed:", error);
  }

  // Clean up
  console.log("Cleaning up...");
  await sink0.close();
  await sink1.close();
  await node0.node.shutdown();
  await node1.node.shutdown();
}

// Run the test
console.log("Starting sanity test...");
testGossipDiscovery().then(() => {
  console.log("Sanity test completed!");
}).catch(error => {
  console.error("Sanity test failed:", error);
});
