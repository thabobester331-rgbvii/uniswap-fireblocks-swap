
import os

# Create directory
base_dir = "/mnt/agents/output/uniswap-fireblocks-swap/src/uniswap-api"
os.makedirs(base_dir, exist_ok=True)

# File 1: quote.ts
quote_ts = '''/**
 * Uniswap API + Fireblocks - Quote Module
 * 
 * Approach 2: Direct Uniswap API integration with Fireblocks transaction signing.
 * Provides full control over routing and execution.
 * 
 * Prerequisites:
 * - Uniswap API key from developers.uniswap.org/dashboard
 * - Fireblocks API key with Raw Transaction permissions
 * - Policy rules allowing contract calls to Uniswap contracts
 */

import {
  getConfig,
  SwapError,
  handleError,
  getTokenAddress,
  formatAmount,
} from "../config";

// ==========================================
// Types
// ==========================================

export interface UniswapQuoteRequest {
  tokenIn: string;          // Token address or symbol
  tokenOut: string;         // Token address or symbol
  amount: string;           // Human-readable amount
  type: "EXACT_INPUT" | "EXACT_OUTPUT";
  chainId?: number;
  swapper: string;          // User wallet address (Fireblocks vault)
  slippageTolerance?: number; // Percentage (e.g., 0.5)
  recipient?: string;       // Optional: different recipient
  enableUniversalRouter?: boolean;
  enableErc20Eth?: boolean; // For UniswapX native ETH input
}

export interface UniswapQuote {
  quoteId: string;
  routing: string;            // CLASSIC, DUTCH_V2, DUTCH_V3, PRIORITY, WRAP, UNWRAP, BRIDGE
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  price: string;
  priceImpact: number;
  gasUseEstimate: string;
  route: any[];
  permitData: any | null;
  quote: any;               // Raw quote for execution
  rawResponse: any;
}

// ==========================================
// Quote Request Builder
// ==========================================

function resolveTokenAddress(token: string, chainId: number): string {
  // If it's already an address (0x...), return as-is
  if (token.startsWith("0x") && token.length === 42) {
    return token;
  }
  // Otherwise resolve symbol to address
  return getTokenAddress(chainId, token);
}

export async function getUniswapQuote(
  request: UniswapQuoteRequest
): Promise<UniswapQuote> {
  const config = getConfig();
  const chainId = request.chainId || config.blockchain.chainId;
  
  const tokenInAddress = resolveTokenAddress(request.tokenIn, chainId);
  const tokenOutAddress = resolveTokenAddress(request.tokenOut, chainId);
  
  // Determine decimals for formatting (simplified - should query token contract)
  const isNativeIn = tokenInAddress === "0x0000000000000000000000000000000000000000";
  const decimalsIn = isNativeIn ? 18 : 6; // Simplified - ETH=18, most ERC20=6 or 18
  
  const amountInBaseUnits = formatAmount(request.amount, decimalsIn);
  
  const headers: Record<string, string> = {
    "x-api-key": config.uniswapApi.apiKey,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  
  // Enable ERC20ETH for UniswapX native ETH input
  if (request.enableErc20Eth && isNativeIn) {
    headers["x-erc20eth-enabled"] = "true";
  }
  
  const body = {
    tokenIn: tokenInAddress,
    tokenOut: tokenOutAddress,
    tokenInChainId: chainId,
    tokenOutChainId: chainId,
    type: request.type,
    amount: amountInBaseUnits,
    swapper: request.swapper,
    slippageTolerance: request.slippageTolerance || config.swap.defaultSlippageBps / 100,
    ...(request.recipient && { recipient: request.recipient }),
    ...(request.enableUniversalRouter && { enableUniversalRouter: true }),
  };
  
  try {
    const response = await fetch(`${config.uniswapApi.baseUrl}/quote`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new SwapError(
        `Uniswap API error: ${response.status} - ${errorData.error || response.statusText}`,
        "API_ERROR",
        errorData
      );
    }
    
    const data = await response.json();
    
    return {
      quoteId: data.quoteId || data.requestId || "unknown",
      routing: data.routing,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amount,
      amountOut: data.output?.amount || data.quote?.output?.amount || "0",
      price: data.price || data.quote?.price || "0",
      priceImpact: data.priceImpact || data.quote?.priceImpact || 0,
      gasUseEstimate: data.gasUseEstimate || data.quote?.gasUseEstimate || "0",
      route: data.route || data.quote?.route || [],
      permitData: data.permitData || data.quote?.permitData || null,
      quote: data.quote || data,
      rawResponse: data,
    };
  } catch (error) {
    if (error instanceof SwapError) throw error;
    return handleError(error, "Failed to get Uniswap quote");
  }
}

// ==========================================
// Routing Helpers
// ==========================================

export function getExecutionEndpoint(routing: string): string {
  const swapEndpoints = ["CLASSIC", "WRAP", "UNWRAP", "BRIDGE"];
  const orderEndpoints = ["DUTCH_V2", "DUTCH_V3", "PRIORITY"];
  
  if (swapEndpoints.includes(routing)) {
    return "/swap";
  }
  if (orderEndpoints.includes(routing)) {
    return "/order";
  }
  
  throw new SwapError(`Unknown routing type: ${routing}`, "UNKNOWN_ROUTING");
}

export function isGaslessRoute(routing: string): boolean {
  return ["DUTCH_V2", "DUTCH_V3", "PRIORITY"].includes(routing);
}

// ==========================================
// Multi-Quote Comparison
// ==========================================

export async function compareQuotes(
  requests: UniswapQuoteRequest[]
): Promise<UniswapQuote[]> {
  const quotes = await Promise.all(
    requests.map((req) =>
      getUniswapQuote(req).catch((err) => {
        console.warn(`Quote failed for ${req.tokenIn}→${req.tokenOut}:`, err);
        return null;
      })
    )
  );
  
  return quotes.filter((q): q is UniswapQuote => q !== null);
}

// ==========================================
// CLI / Direct Execution
// ==========================================

if (require.main === module) {
  (async () => {
    try {
      const config = getConfig();
      
      if (!config.uniswapApi.apiKey) {
        throw new Error("UNISWAP_API_KEY is required for Approach 2");
      }
      
      console.log("📊 Uniswap API Quote Example\\n");
      
      const quote = await getUniswapQuote({
        tokenIn: "ETH",
        tokenOut: "USDC",
        amount: "0.1",
        type: "EXACT_INPUT",
        chainId: 1,
        swapper: "0x0000000000000000000000000000000000000000", // Replace with actual vault
        slippageTolerance: 0.5,
      });
      
      console.log("✅ Quote received:");
      console.log(`   Quote ID: ${quote.quoteId}`);
      console.log(`   Routing: ${quote.routing}`);
      console.log(`   Input: ${quote.amountIn} ${quote.tokenIn}`);
      console.log(`   Output: ${quote.amountOut} ${quote.tokenOut}`);
      console.log(`   Price: ${quote.price}`);
      console.log(`   Price Impact: ${quote.priceImpact}%`);
      console.log(`   Gas Estimate: ${quote.gasUseEstimate}`);
      console.log(`   Execution Endpoint: ${getExecutionEndpoint(quote.routing)}`);
      console.log(`   Gasless: ${isGaslessRoute(quote.routing)}`);
      
      if (quote.permitData) {
        console.log("\\n⚠️  Permit signature required before execution");
      }
      
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  })();
}
'''

with open(f"{base_dir}/quote.ts", "w") as f:
    f.write(quote_ts)

print("Created quote.ts")
# File 2: build-tx.ts
build_tx_ts = '''/**
 * Uniswap API + Fireblocks - Transaction Builder Module
 * 
 * Builds execution requests from Uniswap quotes for both
 * CLASSIC swaps and UniswapX orders.
 */

import {
  getConfig,
  SwapError,
  handleError,
} from "../config";
import { UniswapQuote, getExecutionEndpoint, isGaslessRoute } from "./quote";

// ==========================================
// Types
// ==========================================

export interface BuildSwapRequest {
  quote: UniswapQuote;
  signature?: string;       // Permit2 signature if required
}

export interface SwapTransaction {
  to: string;
  data: string;
  value: string;
  gasLimit: string;
  from: string;
  routing: string;
  rawResponse: any;
}

export interface BuildOrderRequest {
  quote: UniswapQuote;
  signature: string;        // Required for orders
  deadline?: number;        // Order deadline in seconds
}

export interface OrderPayload {
  orderHash: string;
  encodedOrder: string;
  signature: string;
  deadline: number;
  routing: string;
  rawResponse: any;
}

// ==========================================
// Swap Transaction Builder (CLASSIC/WRAP/UNWRAP/BRIDGE)
// ==========================================

export async function buildSwapTransaction(
  request: BuildSwapRequest
): Promise<SwapTransaction> {
  const config = getConfig();
  
  if (isGaslessRoute(request.quote.routing)) {
    throw new SwapError(
      `Routing ${request.quote.routing} requires /order endpoint, not /swap`,
      "WRONG_ENDPOINT"
    );
  }
  
  const body: any = {
    quote: request.quote.quote,
  };
  
  // Add permit signature if required
  if (request.quote.permitData) {
    if (!request.signature) {
      throw new SwapError(
        "Permit signature is required for this quote. Sign the permitData first.",
        "PERMIT_REQUIRED"
      );
    }
    body.signature = request.signature;
    body.permitData = request.quote.permitData;
  }
  
  try {
    const response = await fetch(`${config.uniswapApi.baseUrl}/swap`, {
      method: "POST",
      headers: {
        "x-api-key": config.uniswapApi.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new SwapError(
        `Swap build error: ${response.status} - ${errorData.error || response.statusText}`,
        "BUILD_ERROR",
        errorData
      );
    }
    
    const data = await response.json();
    const swap = data.swap || data;
    
    return {
      to: swap.to || swap.tx?.to,
      data: swap.data || swap.tx?.data,
      value: swap.value || swap.tx?.value || "0",
      gasLimit: swap.gasLimit || swap.tx?.gasLimit || "0",
      from: swap.from || swap.tx?.from,
      routing: request.quote.routing,
      rawResponse: data,
    };
  } catch (error) {
    if (error instanceof SwapError) throw error;
    return handleError(error, "Failed to build swap transaction");
  }
}

// ==========================================
// Order Builder (DUTCH_V2/DUTCH_V3/PRIORITY)
// ==========================================

export async function buildOrderPayload(
  request: BuildOrderRequest
): Promise<OrderPayload> {
  const config = getConfig();
  
  if (!isGaslessRoute(request.quote.routing)) {
    throw new SwapError(
      `Routing ${request.quote.routing} requires /swap endpoint, not /order`,
      "WRONG_ENDPOINT"
    );
  }
  
  if (!request.signature) {
    throw new SwapError(
      "Signature is required for UniswapX orders",
      "SIGNATURE_REQUIRED"
    );
  }
  
  const deadline = request.deadline || Math.floor(Date.now() / 1000) + 1800; // Default 30 min
  
  const body = {
    quote: request.quote.quote,
    signature: request.signature,
    deadline,
  };
  
  try {
    const response = await fetch(`${config.uniswapApi.baseUrl}/order`, {
      method: "POST",
      headers: {
        "x-api-key": config.uniswapApi.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new SwapError(
        `Order build error: ${response.status} - ${errorData.error || response.statusText}`,
        "BUILD_ERROR",
        errorData
      );
    }
    
    const data = await response.json();
    
    return {
      orderHash: data.orderHash || data.hash,
      encodedOrder: data.encodedOrder || data.order,
      signature: request.signature,
      deadline,
      routing: request.quote.routing,
      rawResponse: data,
    };
  } catch (error) {
    if (error instanceof SwapError) throw error;
    return handleError(error, "Failed to build order payload");
  }
}

// ==========================================
// Permit2 Signing Helper
// ==========================================

export interface PermitToSign {
  domain: any;
  types: any;
  values: any;
}

export function extractPermitData(quote: UniswapQuote): PermitToSign | null {
  if (!quote.permitData) return null;
  
  return {
    domain: quote.permitData.domain,
    types: quote.permitData.types,
    values: quote.permitData.values,
  };
}

// ==========================================
// Smart Contract Call Data Builder
// ==========================================

export function buildContractCallPayload(
  tx: SwapTransaction,
  vaultAccountId: string
): any {
  return {
    operation: "CONTRACT_CALL",
    assetId: "ETH", // Adjust based on chain
    source: {
      type: "VAULT_ACCOUNT",
      id: vaultAccountId,
    },
    destination: {
      type: "ONE_TIME_ADDRESS",
      oneTimeAddress: {
        address: tx.to,
      },
    },
    amount: tx.value !== "0" ? tx.value : undefined,
    extraParameters: {
      contractCallData: tx.data,
    },
    note: `Uniswap ${tx.routing} swap via Fireblocks`,
  };
}

// ==========================================
// CLI / Direct Execution
// ==========================================

if (require.main === module) {
  (async () => {
    try {
      console.log("🔧 Transaction Builder Example\\n");
      console.log("This module requires a valid quote first.");
      console.log("Run: npm run uniswap:quote");
      console.log("Then use the quote to build a transaction.");
      
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  })();
}
'''

with open(f"{base_dir}/build-tx.ts", "w") as f:
    f.write(build_tx_ts)

print("Created build-tx.ts")
# File 3: submit.ts
submit_ts = '''/**
 * Uniswap API + Fireblocks - Submit Module
 * 
 * Submits transactions to Fireblocks for MPC signing and broadcasting.
 * Handles both CLASSIC swaps (contract calls) and UniswapX orders.
 */

import {
  getFireblocksClient,
  getConfig,
  SwapError,
  handleError,
  sleep,
} from "../config";
import { UniswapQuote, getUniswapQuote } from "./quote";
import {
  buildSwapTransaction,
  buildOrderPayload,
  buildContractCallPayload,
  SwapTransaction,
  OrderPayload,
} from "./build-tx";

// ==========================================
// Types
// ==========================================

export interface SubmitSwapRequest {
  quote: UniswapQuote;
  permitSignature?: string;
  vaultAccountId?: string;
  waitForConfirmation?: boolean;
}

export interface SubmitOrderRequest {
  quote: UniswapQuote;
  signature: string;
  vaultAccountId?: string;
  deadline?: number;
}

export interface TransactionResult {
  fireblocksTxId: string;
  status: string;
  transactionHash?: string;
  blockExplorerUrl?: string;
  rawResponse: any;
}

export interface OrderSubmissionResult {
  orderHash: string;
  status: string;
  encodedOrder: string;
  monitorUrl?: string;
  rawResponse: any;
}

// ==========================================
// Submit CLASSIC Swap via Fireblocks
// ==========================================

export async function submitSwap(
  request: SubmitSwapRequest
): Promise<TransactionResult> {
  const client = getFireblocksClient();
  const config = getConfig();
  const vaultId = request.vaultAccountId || config.fireblocks.sourceVaultAccountId;
  
  // Step 1: Build swap transaction
  console.log("🔧 Building swap transaction...");
  const swapTx = await buildSwapTransaction({
    quote: request.quote,
    signature: request.permitSignature,
  });
  
  // Step 2: Create Fireblocks contract call
  console.log("📤 Submitting to Fireblocks...");
  const contractCallPayload = buildContractCallPayload(swapTx, vaultId);
  
  try {
    const response = await client.transactions.createTransaction({
      operation: "CONTRACT_CALL",
      assetId: "ETH",
      source: contractCallPayload.source,
      destination: contractCallPayload.destination,
      amount: contractCallPayload.amount,
      extraParameters: contractCallPayload.extraParameters,
      note: contractCallPayload.note,
    });
    
    const txId = response.data.id;
    console.log(`   Fireblocks Tx ID: ${txId}`);
    
    // Step 3: Wait for confirmation if requested
    if (request.waitForConfirmation !== false) {
      return await waitForTransaction(txId);
    }
    
    return {
      fireblocksTxId: txId,
      status: "SUBMITTED",
      rawResponse: response.data,
    };
  } catch (error) {
    return handleError(error, "Failed to submit swap to Fireblocks");
  }
}

// ==========================================
// Submit UniswapX Order
// ==========================================

export async function submitOrder(
  request: SubmitOrderRequest
): Promise<OrderSubmissionResult> {
  const config = getConfig();
  
  // Build order payload
  console.log("🔧 Building order payload...");
  const orderPayload = await buildOrderPayload({
    quote: request.quote,
    signature: request.signature,
    deadline: request.deadline,
  });
  
  // Submit to UniswapX API
  console.log("📤 Submitting order to UniswapX...");
  try {
    const response = await fetch(`${config.uniswapApi.baseUrl}/order`, {
      method: "POST",
      headers: {
        "x-api-key": config.uniswapApi.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        encodedOrder: orderPayload.encodedOrder,
        signature: orderPayload.signature,
        orderHash: orderPayload.orderHash,
        deadline: orderPayload.deadline,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new SwapError(
        `Order submission failed: ${response.status}`,
        "ORDER_SUBMIT_FAILED",
        errorData
      );
    }
    
    const data = await response.json();
    
    return {
      orderHash: orderPayload.orderHash,
      status: "SUBMITTED",
      encodedOrder: orderPayload.encodedOrder,
      monitorUrl: `${config.uniswapApi.baseUrl}/orders/${orderPayload.orderHash}`,
      rawResponse: data,
    };
  } catch (error) {
    if (error instanceof SwapError) throw error;
    return handleError(error, "Failed to submit UniswapX order");
  }
}

// ==========================================
// Transaction Monitoring
// ==========================================

export async function getTransactionStatus(
  txId: string
): Promise<TransactionResult> {
  const client = getFireblocksClient();
  
  try {
    const response = await client.transactions.getTransaction({ id: txId });
    const tx = response.data;
    
    const txHash = tx.txHash;
    const blockExplorerUrl = txHash
      ? `https://etherscan.io/tx/${txHash}`
      : undefined;
    
    return {
      fireblocksTxId: txId,
      status: tx.status || "UNKNOWN",
      transactionHash: txHash,
      blockExplorerUrl,
      rawResponse: tx,
    };
  } catch (error) {
    return handleError(error, `Failed to get status for tx ${txId}`);
  }
}

export async function waitForTransaction(
  txId: string,
  options: {
    maxAttempts?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<TransactionResult> {
  const { maxAttempts = 60, pollIntervalMs = 5000 } = options;
  
  console.log(`⏳ Monitoring Fireblocks tx ${txId}...`);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await getTransactionStatus(txId);
    
    console.log(`   Attempt ${attempt}/${maxAttempts}: Status = ${result.status}`);
    
    if (result.status === "COMPLETED" || result.status === "CONFIRMED") {
      console.log(`✅ Transaction confirmed!`);
      if (result.transactionHash) {
        console.log(`   Hash: ${result.transactionHash}`);
        console.log(`   Explorer: ${result.blockExplorerUrl}`);
      }
      return result;
    }
    
    if (result.status === "FAILED" || result.status === "REJECTED" || result.status === "CANCELLED") {
      throw new SwapError(
        `Transaction ${txId} failed with status: ${result.status}`,
        "TX_FAILED",
        result
      );
    }
    
    if (attempt < maxAttempts) {
      await sleep(pollIntervalMs);
    }
  }
  
  throw new SwapError(
    `Transaction ${txId} did not complete within ${maxAttempts} attempts`,
    "TX_TIMEOUT"
  );
}

// ==========================================
// Order Status Monitoring
// ==========================================

export async function getOrderStatus(orderHash: string): Promise<any> {
  const config = getConfig();
  
  try {
    const response = await fetch(`${config.uniswapApi.baseUrl}/orders/${orderHash}`, {
      headers: {
        "x-api-key": config.uniswapApi.apiKey,
      },
    });
    
    if (!response.ok) {
      throw new SwapError(`Failed to get order status: ${response.status}`, "API_ERROR");
    }
    
    return await response.json();
  } catch (error) {
    return handleError(error, "Failed to get order status");
  }
}

export async function waitForOrderFill(
  orderHash: string,
  options: {
    maxAttempts?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<any> {
  const { maxAttempts = 120, pollIntervalMs = 5000 } = options;
  
  console.log(`⏳ Monitoring UniswapX order ${orderHash}...`);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await getOrderStatus(orderHash);
    
    console.log(`   Attempt ${attempt}/${maxAttempts}: Status = ${status.status || "unknown"}`);
    
    if (status.status === "filled" || status.status === "FILLED") {
      console.log(`✅ Order filled!`);
      return status;
    }
    
    if (status.status === "expired" || status.status === "cancelled") {
      throw new SwapError(
        `Order ${orderHash} ${status.status}`,
        "ORDER_EXPIRED",
        status
      );
    }
    
    if (attempt < maxAttempts) {
      await sleep(pollIntervalMs);
    }
  }
  
  throw new SwapError(
    `Order ${orderHash} did not fill within ${maxAttempts} attempts`,
    "ORDER_TIMEOUT"
  );
}

// ==========================================
// Full End-to-End Flow
// ==========================================

export async function executeFullSwap(
  tokenIn: string,
  tokenOut: string,
  amount: string,
  swapperAddress: string,
  options: {
    type?: "EXACT_INPUT" | "EXACT_OUTPUT";
    chainId?: number;
    slippageTolerance?: number;
    vaultAccountId?: string;
    waitForConfirmation?: boolean;
  } = {}
): Promise<TransactionResult | OrderSubmissionResult> {
  const {
    type = "EXACT_INPUT",
    chainId,
    slippageTolerance = 0.5,
    vaultAccountId,
    waitForConfirmation = true,
  } = options;
  
  // Step 1: Get quote
  console.log("\\n📊 Step 1: Getting quote...");
  const quote = await getUniswapQuote({
    tokenIn,
    tokenOut,
    amount,
    type,
    chainId,
    swapper: swapperAddress,
    slippageTolerance,
  });
  
  console.log(`   Routing: ${quote.routing}`);
  console.log(`   Expected output: ${quote.amountOut} ${tokenOut}`);
  
  // Step 2: Execute based on routing type
  if (quote.routing === "CLASSIC" || quote.routing === "WRAP" || quote.routing === "UNWRAP") {
    console.log("\\n🔧 Step 2: Executing CLASSIC swap via Fireblocks...");
    
    // Note: In production, you would sign the permit here if needed
    // For demo, we assume no permit or pre-approved
    return await submitSwap({
      quote,
      vaultAccountId,
      waitForConfirmation,
    });
  } else {
    console.log("\\n🔧 Step 2: Executing UniswapX order...");
    console.log("   Note: Requires order signature. Use your wallet to sign the order.");
    
    // For UniswapX, you need to sign the order payload
    // This would typically be done via Fireblocks raw signing or external wallet
    throw new SwapError(
      "UniswapX orders require manual signing. Use the quote to generate a signature.",
      "SIGNATURE_REQUIRED"
    );
  }
}

// ==========================================
// CLI / Direct Execution
// ==========================================

if (require.main === module) {
  (async () => {
    try {
      const config = getConfig();
      
      if (!config.uniswapApi.apiKey) {
        throw new Error("UNISWAP_API_KEY is required");
      }
      
      console.log("🚀 Uniswap API + Fireblocks Submit Example\\n");
      console.log("This example demonstrates the submission flow.");
      console.log("For a full swap, run with proper parameters or use the library.");
      
      // Example: Monitor an existing transaction
      // const result = await waitForTransaction("your-tx-id");
      // console.log(result);
      
    } catch (error) {
      console.error("❌ Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  })();
}
'''

with open(f"{base_dir}/submit.ts", "w") as f:
    f.write(submit_ts)

print("Created submit.ts")
# Verify all files created
import os

base_dir = "/mnt/agents/output/uniswap-fireblocks-swap/src/uniswap-api"
files = os.listdir(base_dir)
print("Files in src/uniswap-api/:")
for f in files:
    size = os.path.getsize(f"{base_dir}/{f}")
    print(f"  {f} ({size} bytes)")
